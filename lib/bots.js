import { query } from './db'

/**
 * Which bots this site can offer.
 *
 * Read from the SAME `settings` row the bot reads — `bot_profiles` — rather than
 * from a list kept here. Two lists would drift, and the morning they disagree
 * the site would either offer a bot that cannot serve the request or hide one
 * that can. One source of truth, read from both sides.
 *
 * The parsing mirrors lib/profiles.js on the bot exactly, including the
 * fallback, so both sides always agree on what the primary bot is called.
 */

const SETTINGS_KEY = 'bot_profiles'
const NAME_KEY = 'bot_name'

// Matches the bot's own staticConfig default for botName. If the site and the
// bot ever disagreed about the single-bot fallback, the selector would show a
// bot the bot does not think exists.
const FALLBACK_NAME = 'MZAZI TECH QUARTZ BOT'
const FALLBACK_ID = 'main'

function parseProfiles(raw) {
  if (!raw) return []

  let parsed = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      console.warn('[link][bots] bot_profiles is not valid JSON — treating it as unset')
      return []
    }
  }
  if (!Array.isArray(parsed)) return []

  const cleaned = parsed
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      id: String(p.id ?? '').trim(),
      name: String(p.name ?? '').trim(),
    }))
    .filter((p) => p.id && p.name)

  // Duplicate ids would make two bots indistinguishable and let a pairing land
  // somewhere the user did not choose. Keep the first of each.
  const seen = new Set()
  return cleaned.filter((p) => (seen.has(p.id) ? false : seen.add(p.id)))
}

/**
 * The selectable bots, always at least one.
 *
 * Never throws: the `settings` table belongs to the bot, and if it is missing or
 * unreadable this site still has to work — it simply cannot know about a second
 * bot, which is exactly the single-bot behaviour.
 */
export async function listBots() {
  const settings = {}

  try {
    const { rows } = await query(
      `SELECT key, value FROM settings WHERE key = ANY($1::text[])`,
      [[SETTINGS_KEY, NAME_KEY]]
    )
    for (const row of rows) settings[row.key] = row.value || ''
  } catch (err) {
    console.warn('[link][bots] could not read the settings table:', err.message)
  }

  const configured = parseProfiles(settings[SETTINGS_KEY])
  if (configured.length) return configured

  return [{ id: FALLBACK_ID, name: settings[NAME_KEY] || FALLBACK_NAME }]
}

/** Is this a bot we are allowed to accept pairings for? */
export async function isKnownBot(id) {
  if (!id) return true // no target means "any bot", which is always allowed
  const bots = await listBots()
  return bots.some((b) => b.id === id)
}

/** The bot a request should default to when the caller names none. */
export async function primaryBotId() {
  const bots = await listBots()
  return bots[0].id
}
