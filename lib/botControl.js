import { query } from './db'

/**
 * The bot_control contract.
 *
 * This is the interface quartz ALREADY implements — the same one
 * mzazi333-creator/quartzxd uses. Talking to it means this site needs no
 * bot-side changes at all: the bot is already polling this table and acting on
 * it. That is the difference that matters, because the previous design asked
 * quartz to run a worker that was never wired up, which is why pairing sat at
 * 'pending' forever.
 *
 * Shape, verified against quartzxd's own routes:
 *
 *   pair    action 'pair'   payload {"number": "<digits>"}                → result.code
 *   unpair  action 'unpair' payload {"number": "<digits>", "mode":"delete"}
 *
 * status is one of pending | claimed | done | failed. `result` holds a JSON
 * payload whose key varies (code | pairingCode | pairing_code) — the extractor
 * below accepts any of them, because it is the bot's field and not ours to
 * dictate.
 *
 * We add one key of our own to a pair payload: password_hash. The bot ignores
 * unknown keys, and it gives us somewhere to park the deletion password until
 * the pairing genuinely completes — see promoteCredential.
 */

export const ACTION_PAIR = 'pair'
export const ACTION_UNPAIR = 'unpair'

// Statuses that mean the bot has the request but has not finished it. Used to
// refuse a duplicate before it is queued.
const IN_FLIGHT = ['pending', 'claimed']

/**
 * Is there already an unfinished request of this kind for this number?
 *
 * Matches quartzxd's behaviour deliberately: a second request while one is in
 * flight is a conflict, not a queue entry, because two pairing codes for the
 * same number would race and only one can be used.
 */
export async function findInFlight(phone, action) {
  const { rows } = await query(
    `
    SELECT id, status
      FROM bot_control
     WHERE action = $1
       AND status = ANY($2::text[])
       AND payload->>'number' = $3
     ORDER BY id DESC
     LIMIT 1
    `,
    [action, IN_FLIGHT, phone]
  )
  return rows[0] || null
}

/**
 * Ask the bot to generate a pairing code. Returns the request row we poll.
 *
 * `botId` names which bot this is for. The bot filters its claim on it, so a
 * request aimed at a bot that is not running stays pending rather than being
 * picked up and paired by the other one — which for WhatsApp is not a mistake
 * anyone can quietly undo.
 */
export async function createPairRequest(phone, passwordHash, botId = '') {
  const { rows } = await query(
    `
    INSERT INTO bot_control (action, bot_id, payload, status)
    VALUES ($1, $2, $3::jsonb, 'pending')
    RETURNING id, created_at
    `,
    [
      ACTION_PAIR,
      botId || '',
      JSON.stringify({ number: phone, password_hash: passwordHash, source: 'link' }),
    ]
  )
  return rows[0]
}

/**
 * Ask the bot to log the device out and wipe its session.
 *
 * `mode: 'delete'` is not decoration — it is what quartzxd sends, and the bot
 * distinguishes a full wipe from a plain logout by it.
 */
export async function createUnpairRequest(phone, botId = '') {
  const { rows } = await query(
    `
    INSERT INTO bot_control (action, bot_id, payload, status)
    VALUES ($1, $2, $3::jsonb, 'pending')
    RETURNING id, created_at
    `,
    [
      ACTION_UNPAIR,
      botId || '',
      JSON.stringify({ number: phone, mode: 'delete', source: 'link' }),
    ]
  )
  return rows[0]
}

/**
 * Read one request row. Returns null when the id is unknown.
 *
 * `payload` is selected because the status route needs the number to check
 * whether the device has since connected, and to promote the staged password.
 * It must never be echoed to the browser — it carries the password hash.
 */
export async function readRequest(id) {
  const { rows } = await query(
    `
    SELECT id, action, status, payload, result, created_at, done_at
      FROM bot_control
     WHERE id = $1
    `,
    [id]
  )
  const row = rows[0]
  if (!row) return null

  return { ...row, number: readPayloadNumber(row.payload) }
}

/** The MSISDN on a request payload, or null if it is missing or malformed. */
export function readPayloadNumber(payload) {
  let p = payload
  if (typeof p === 'string') {
    try {
      p = JSON.parse(p)
    } catch {
      return null
    }
  }
  if (!p || typeof p !== 'object') return null
  const number = String(p.number ?? '').replace(/\D/g, '')
  return number.length >= 8 && number.length <= 15 ? number : null
}

/**
 * Pull the pairing code out of a `result` column.
 *
 * The column has held both a JSON string and text over time, and the key name
 * has three spellings in the wild. Accept all of them rather than picking one
 * and being wrong.
 */
export function extractCode(result) {
  const parsed = parseResult(result)
  if (!parsed || typeof parsed !== 'object') return null

  const candidate =
    parsed.code || parsed.pairingCode || parsed.pairing_code || parsed.pairingcode

  if (typeof candidate === 'string' || typeof candidate === 'number') {
    const value = String(candidate).trim()
    return value || null
  }
  return null
}

/** Error text for a failed request, if the bot recorded one. */
export function extractError(result) {
  const parsed = parseResult(result)
  if (!parsed) return null
  if (typeof parsed === 'string') return parsed
  const value = parsed.error || parsed.message || parsed.reason
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function parseResult(result) {
  if (result == null) return null
  if (typeof result === 'object') return result
  try {
    return JSON.parse(result)
  } catch {
    // Not JSON — a bare string is still worth surfacing as an error message.
    return String(result)
  }
}

/**
 * Turn a staged password into a real one.
 *
 * The password is chosen when a pairing is *requested*, but it must only become
 * the credential for a number once a pairing actually *succeeded*. Promoting on
 * request would let anyone claim a stranger's number with their own password and
 * then delete it — the code can only be entered on the phone that owns the
 * number, so requiring 'done' means the person who set the password is the
 * person who held the phone.
 *
 * Two guards, both load-bearing:
 *
 *   ORDER BY id ASC     — the earliest completed request wins. If a second
 *                         request for the same number also reaches 'done', the
 *                         first one's password is the one that sticks.
 *   ON CONFLICT DO NOTHING — never overwrite an existing credential. A later
 *                         success cannot take a number away from the person who
 *                         already linked it.
 *
 * Called both when the browser sees 'done' and lazily on the removal path, so a
 * user who closed the page before confirmation is not left without a password.
 */
export async function promoteCredential(phone) {
  const { rows } = await query(
    `
    INSERT INTO device_credentials (phone, password_hash)
    SELECT payload->>'number', payload->>'password_hash'
      FROM bot_control
     WHERE action = $1
       AND status = 'done'
       AND payload->>'number' = $2
       AND payload ? 'password_hash'
     ORDER BY id ASC
     LIMIT 1
    ON CONFLICT (phone) DO NOTHING
    RETURNING phone, created_at
    `,
    [ACTION_PAIR, phone]
  )
  return rows[0] || null
}

/**
 * Forget the staged password once it has been promoted.
 *
 * Optional hygiene rather than a requirement: leaving it costs nothing but keeps
 * a password hash sitting in an operational table that other tooling reads.
 */
export async function clearStagedHash(requestId) {
  await query(
    `
    UPDATE bot_control
       SET payload = payload - 'password_hash'
     WHERE id = $1
       AND payload ? 'password_hash'
    `,
    [requestId]
  )
}
