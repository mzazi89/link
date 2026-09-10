import { createHash, randomBytes } from 'node:crypto'
import { query } from './db'

/**
 * Abuse controls.
 *
 * There is no login on this site, so throttling is the only thing between a
 * stranger and unlimited WhatsApp sessions on your bot. The counters live in the
 * shared database rather than in memory because Vercel runs many short-lived
 * instances — an in-process Map would reset on every cold start and let a
 * determined caller through with trivial effort.
 *
 * Note the counter deliberately includes EVERY row, not just successful ones.
 * Failed and expired attempts are exactly the signature of someone probing.
 */

function intEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? '', 10)
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

export function rateLimitConfig() {
  return {
    ipMax: intEnv('RATE_LIMIT_IP_MAX', 5),
    ipWindowMin: intEnv('RATE_LIMIT_IP_WINDOW_MIN', 15),
    phoneMax: intEnv('RATE_LIMIT_PHONE_MAX', 3),
    phoneWindowMin: intEnv('RATE_LIMIT_PHONE_WINDOW_MIN', 60),
  }
}

// ── Caller identity ──────────────────────────────────────────────────────────

let ephemeralSalt = null

function salt() {
  if (process.env.IP_HASH_SALT) return process.env.IP_HASH_SALT
  // No salt configured: fall back to a per-process random value. Throttling
  // still works within one instance, but hashes are not comparable across
  // restarts or instances, so cross-instance forensics degrade to nothing.
  if (!ephemeralSalt) ephemeralSalt = randomBytes(16).toString('hex')
  return ephemeralSalt
}

/**
 * Hash the caller IP before it ever reaches the database. We want to count
 * repeats without accumulating a log of who visited a site about WhatsApp
 * accounts — that list is a liability we have no reason to hold.
 */
export function hashIp(ip) {
  const value = String(ip ?? '').trim()
  if (!value) return null
  return createHash('sha256').update(`${salt()}:${value}`).digest('hex')
}

/**
 * Best-effort client IP behind Vercel's proxy chain.
 * `x-forwarded-for` is a comma-separated list; the left-most entry is the
 * original client as reported by the first trusted hop.
 */
export function clientIpFrom(headers) {
  const forwarded = headers.get('x-forwarded-for')
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim()
    if (first) return first
  }
  return (
    headers.get('x-real-ip') ||
    headers.get('cf-connecting-ip') ||
    headers.get('x-vercel-forwarded-for') ||
    ''
  )
}

// ── The check ────────────────────────────────────────────────────────────────

/**
 * Single round trip that evaluates both windows and reports the longest wait.
 *
 * @returns {Promise<{allowed: boolean, scope?: 'ip'|'phone', retryAfterSeconds?: number}>}
 */
export async function checkRateLimits({ ipHash, phone }) {
  const { ipMax, ipWindowMin, phoneMax, phoneWindowMin } = rateLimitConfig()

  const { rows } = await query(
    `
    SELECT
      count(*) FILTER (
        WHERE ip_hash = $1 AND created_at > now() - make_interval(mins => $2::int)
      ) AS ip_hits,
      count(*) FILTER (
        WHERE phone = $3 AND created_at > now() - make_interval(mins => $4::int)
      ) AS phone_hits,
      max(created_at) FILTER (
        WHERE ip_hash = $1 AND created_at > now() - make_interval(mins => $2::int)
      ) AS ip_last,
      max(created_at) FILTER (
        WHERE phone = $3 AND created_at > now() - make_interval(mins => $4::int)
      ) AS phone_last
    FROM link_requests
    WHERE created_at > now() - make_interval(mins => GREATEST($2::int, $4::int))
    `,
    [ipHash, ipWindowMin, phone, phoneWindowMin]
  )

  const row = rows[0] || {}
  // count(*) is bigint, which node-postgres hands back as a string.
  const ipHits = Number(row.ip_hits || 0)
  const phoneHits = Number(row.phone_hits || 0)

  const ipBlocked = ipHits >= ipMax
  const phoneBlocked = phoneHits >= phoneMax

  if (!ipBlocked && !phoneBlocked) return { allowed: true }

  const now = Date.now()
  const secondsUntil = (last, windowMin) => {
    if (!last) return 0
    const elapsed = (now - new Date(last).getTime()) / 1000
    return Math.max(0, Math.ceil(windowMin * 60 - elapsed))
  }

  // When both windows are closed, the user is waiting on whichever opens last.
  const ipWait = ipBlocked ? secondsUntil(row.ip_last, ipWindowMin) : 0
  const phoneWait = phoneBlocked ? secondsUntil(row.phone_last, phoneWindowMin) : 0

  const usePhone = phoneWait > ipWait
  return {
    allowed: false,
    scope: usePhone ? 'phone' : 'ip',
    retryAfterSeconds: usePhone ? phoneWait : ipWait,
  }
}

export function describeRetry(seconds) {
  if (!seconds || seconds <= 0) return 'Please try again in a moment.'
  const mins = Math.ceil(seconds / 60)
  if (mins <= 1) return 'Please try again in about a minute.'
  return `Please try again in about ${mins} minutes.`
}
