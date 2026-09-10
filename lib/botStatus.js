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

// Below this, we treat the heartbeat as stale rather than believing `online`.
// The bot reports its own connection state, but if the row itself has not been
// touched in hours, that report is history, not status. quartzxd reads the
// boolean alone; this is the "more perfect" half — a dead bot whose last write
// said "online" should not look alive on the page.
const STALE_AFTER_MS = 5 * 60 * 1000

export async function readBotStatus(botId = null) {
  // With a bot named, read that one. Without, take the freshest heartbeat there
  // is — which on a single-bot deployment is that bot, so the behaviour before
  // bots were selectable is unchanged.
  const { rows } = botId
    ? await query(
        `
        SELECT online, version, uptime_seconds, session_numbers, ip_address,
               devices_meta, last_seen_at
          FROM bot_status
         WHERE bot_id = $1
         ORDER BY last_seen_at DESC
         LIMIT 1
        `,
        [botId]
      )
    : await query(
        `
        SELECT online, version, uptime_seconds, session_numbers, ip_address,
               devices_meta, last_seen_at
          FROM bot_status
         ORDER BY last_seen_at DESC
         LIMIT 1
        `
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

/**
 * Every bot that has ever written a heartbeat, with a live online flag.
 *
 * Used to label the selector: a configured bot with no row here has simply never
 * run, which is worth showing rather than pretending it is available.
 */
export async function listBotStatuses() {
  const { rows } = await query(
    `
    SELECT bot_id, online, session_numbers, last_seen_at
      FROM bot_status
     ORDER BY bot_id ASC
    `
  )

  const now = Date.now()
  return rows.map((row) => {
    const seen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null
    const stale = seen == null ? false : now - seen > STALE_AFTER_MS
    return {
      id: row.bot_id,
      online: row.online === true && !stale,
      deviceCount: parseStringArray(row.session_numbers).length,
      lastSeenAt: row.last_seen_at || null,
    }
  })
}

/**
 * Just the online flag, for the pairing path.
 *
 * Takes the bot, because "is a bot up" and "is THE BOT I PICKED up" are
 * different questions. Checking the wrong one would queue a pairing for a bot
 * that is down while a different one is healthy.
 */
export async function isBotOnline(botId = null) {
  const status = await readBotStatus(botId)
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
 *
 * Deliberately reads EVERY heartbeat row rather than one. With bots selectable,
 * "the freshest row" is whichever bot last beat, so a number held by the other
 * one would be reported as never linked — and a device the bot really holds
 * would be refused its legacy password and its removal. The question is "does
 * any of our bots hold this number", so it is asked of all of them.
 */
export async function isKnownSession(phone) {
  const { rows } = await query(`SELECT session_numbers FROM bot_status`)
  const wanted = String(phone ?? '').replace(/\D/g, '')
  if (!wanted) return false
  return rows.some((row) => parseStringArray(row.session_numbers).includes(wanted))
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
