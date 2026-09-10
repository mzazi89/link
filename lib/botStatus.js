import { query } from './db'

/**
 * The bot_status contract — the bot's heartbeat.
 *
 * Written by quartz (its lib/botTelemetry.js adds ip_address and devices_meta
 * on its own with ADD COLUMN IF NOT EXISTS), read here and by quartzxd. One row
 * per bot, keyed by bot_id.
 *
 * Columns we depend on:
 *   online           boolean — is the bot connected right now
 *   session_numbers  JSON array of MSISDNs — the bot's real session folders
 *   devices_meta     JSON object keyed by MSISDN → { online, battery, plugged, lastSeen }
 *   ip_address       the bot host's public IP
 *
 * Everything here is written by someone else, so nothing is trusted: a
 * malformed blob degrades to "no telemetry" rather than throwing. A site that
 * 500s because a heartbeat wrote bad JSON would be worse than one that shows
 * dashes.
 */

const BOT_ID = 'main'

// Below this, we treat the heartbeat as stale rather than believing `online`.
// The bot reports its own connection state, but if the row itself has not been
// touched in hours, that report is history, not status. quartzxd reads the
// boolean alone; this is the "more perfect" half — a dead bot whose last write
// said "online" should not look alive on the page.
const STALE_AFTER_MS = 5 * 60 * 1000

export async function readBotStatus() {
  const { rows } = await query(
    `
    SELECT online, version, uptime_seconds, session_numbers, ip_address,
           devices_meta, last_seen_at
      FROM bot_status
     WHERE bot_id = $1
     ORDER BY last_seen_at DESC
     LIMIT 1
    `,
    [BOT_ID]
  )

  const row = rows[0]
  if (!row) {
    return {
      known: false,
      botOnline: false,
      stale: false,
      ip: null,
      version: null,
      uptimeSeconds: null,
      lastSeenAt: null,
      devices: [],
    }
  }

  const lastSeenAt = row.last_seen_at ? new Date(row.last_seen_at) : null
  const ageMs = lastSeenAt ? Date.now() - lastSeenAt.getTime() : null
  const stale = ageMs == null ? false : ageMs > STALE_AFTER_MS

  const numbers = parseStringArray(row.session_numbers)
  const meta = parseObject(row.devices_meta)

  const devices = numbers.map((phone) => {
    const m = meta[phone] && typeof meta[phone] === 'object' ? meta[phone] : {}
    return {
      phone,
      online: m.online === true,
      battery: typeof m.battery === 'number' ? m.battery : null,
      plugged: typeof m.plugged === 'boolean' ? m.plugged : null,
      lastSeen: typeof m.lastSeen === 'string' ? m.lastSeen : null,
    }
  })

  return {
    known: true,
    botOnline: row.online === true && !stale,
    reportedOnline: row.online === true,
    stale,
    ip: row.ip_address || null,
    version: row.version || null,
    uptimeSeconds: row.uptime_seconds == null ? null : Number(row.uptime_seconds),
    lastSeenAt: row.last_seen_at || null,
    devices,
  }
}

/** Just the online flag, for the pairing path. */
export async function isBotOnline() {
  const status = await readBotStatus()
  return status.botOnline
}

/**
 * Does the bot hold a session for this number?
 *
 * This is the authoritative "is it connected" question, and it is why the
 * connected-numbers list can be honest: it comes from the bot's real session
 * folders rather than from anything this site recorded. It is also what decides
 * whether a number is eligible for the legacy default password — a number with
 * no credential and no session is not a device at all.
 */
export async function isKnownSession(phone) {
  const status = await readBotStatus()
  return status.devices.some((d) => d.phone === phone)
}

/**
 * The JSON columns arrive as text from some clients and as parsed values from
 * others, depending on the column type and driver. Accept both.
 */
function parseStringArray(value) {
  const parsed = coerceJson(value)
  if (!Array.isArray(parsed)) return []
  return parsed
    .map((n) => String(n ?? '').replace(/\D/g, ''))
    .filter((n) => n.length >= 8 && n.length <= 15)
}

function parseObject(value) {
  const parsed = coerceJson(value)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  return parsed
}

function coerceJson(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
