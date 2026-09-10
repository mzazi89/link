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

let derivedSalt = null

function salt() {
  const configured = process.env.IP_HASH_SALT
  if (configured) return configured

  // No salt configured, so derive a stable one from DATABASE_URL — already
  // required and already secret.
  //
  // This matters more than it looks. The throttle counts rows by `ip_hash`, so
  // if every serverless instance hashed with its own random salt, an instance
  // would not see the rows another had written, and the per-IP limit would
  // quietly become "per IP, per instance" — a limit that scales away with
  // traffic precisely when you need it most. Deriving from an existing secret
  // keeps it correct with no extra configuration, which is what lets
  // DATABASE_URL be the only variable you set.
  if (!derivedSalt) {
    const seed = process.env.DATABASE_URL || randomBytes(16).toString('hex')
    derivedSalt = createHash('sha256')
      .update(`mzazi.ip-link:${seed}`)
      .digest('hex')
      .slice(0, 32)
  }
  return derivedSalt
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
    FROM request_log
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

/**
 * Record an accepted request, so the windows above have something to count.
 *
 * Written for every request we act on, not only successful ones — a request that
 * fails later in the handler still consumed the caller's budget, and a counter
 * that only sees successes is trivial to stay under.
 *
 * Never throws. Failing the user's request because a bookkeeping insert broke
 * would be the wrong trade; the throttle degrades to slightly permissive for one
 * call instead.
 */
export async function recordRequest({ action, phone, ipHash }) {
  try {
    await query(
      `INSERT INTO request_log (action, phone, ip_hash) VALUES ($1, $2, $3)`,
      [action, phone, ipHash]
    )
  } catch (err) {
    console.warn('[link][ratelimit] could not record request:', err.message)
  }
}

// ── Password verification ────────────────────────────────────────────────────
//
// A separate budget from the request throttle above, because this is a
// different kind of abuse: not someone flooding the queue, but someone guessing
// a password. Both are needed — the credential lockout in lib/credentials.js
// caps guesses against ONE number, while the per-IP window here caps someone
// spraying a few guesses across MANY numbers, which the per-credential counter
// would never notice.

export function verificationConfig() {
  return {
    ipMax: intEnv('VERIFY_IP_MAX', 12),
    ipWindowMin: intEnv('VERIFY_IP_WINDOW_MIN', 15),
    lockoutAfter: intEnv('VERIFY_LOCKOUT_AFTER', 5),
    lockoutMinutes: intEnv('VERIFY_LOCKOUT_MINUTES', 15),
    retentionDays: intEnv('VERIFY_LOG_RETENTION_DAYS', 7),
  }
}

/**
 * Count recent FAILED verifications from this caller.
 *
 * Only failures count, so a user who mistypes once and then gets it right is
 * not pushed toward a lockout by their own successful attempts.
 */
export async function checkVerificationLimits({ ipHash }) {
  const { ipMax, ipWindowMin } = verificationConfig()
  if (!ipHash) return { allowed: true }

  const { rows } = await query(
    `
    SELECT count(*)::int AS hits,
           max(created_at) AS last
      FROM password_attempts
     WHERE ip_hash = $1
       AND success = false
       AND created_at > now() - make_interval(mins => $2::int)
    `,
    [ipHash, ipWindowMin]
  )

  const hits = Number(rows[0]?.hits || 0)
  if (hits < ipMax) return { allowed: true }

  const last = rows[0]?.last
  const elapsed = last ? (Date.now() - new Date(last).getTime()) / 1000 : 0
  return {
    allowed: false,
    scope: 'ip',
    retryAfterSeconds: Math.max(0, Math.ceil(ipWindowMin * 60 - elapsed)),
  }
}

/** Append to the verification audit trail. Never throws into the caller. */
export async function recordPasswordAttempt({ phone, ipHash, success }) {
  try {
    await query(
      `INSERT INTO password_attempts (phone, ip_hash, success) VALUES ($1, $2, $3)`,
      [phone, ipHash, Boolean(success)]
    )
  } catch (err) {
    console.warn('[link][ratelimit] could not record attempt:', err.message)
  }
}

/**
 * Trim the audit table.
 *
 * Called probabilistically (about 1 request in 25) rather than on a schedule,
 * because the site is serverless and has no cron of its own. Without this the
 * table grows forever; with it, growth is bounded by traffic and retention.
 */
export async function maybePruneAttempts(probability = 0.04) {
  if (Math.random() >= probability) return
  const { retentionDays } = verificationConfig()
  try {
    const { rowCount } = await query(
      `DELETE FROM password_attempts
        WHERE created_at < now() - make_interval(days => $1::int)`,
      [retentionDays]
    )
    if (rowCount > 0) {
      console.log(`[link][ratelimit] pruned ${rowCount} stale verification attempt(s)`)
    }
  } catch (err) {
    console.warn('[link][ratelimit] prune failed:', err.message)
  }
}
