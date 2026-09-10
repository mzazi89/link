import { createHash } from 'node:crypto'

import { query } from './db'

/**
 * Reading the session register.
 *
 * `bot_sessions` is written by the bot's sync job from its `database/sessions/`
 * folders — see `syncSessions` in bot/linkQueue.js. This module only reads.
 */

// A public page renders this list, so bound it. If the bot ever somehow reports
// more sessions than this, a truncated list is a far better failure than a
// response nobody can render.
const MAX_ACTIVE = 500

/**
 * Every number the bot currently holds a session for, newest first.
 *
 * `has_password` distinguishes numbers paired through this site (which have a
 * real credential) from ones paired before it existed (which fall back to the
 * primary password). It is deliberately NOT exposed on the public endpoint —
 * it is here for the operator view and for internal callers.
 */
export async function listActiveSessions() {
  const { rows } = await query(
    `
    SELECT s.phone,
           s.first_seen_at,
           s.last_seen_at,
           (c.phone IS NOT NULL) AS has_password
      FROM bot_sessions s
      LEFT JOIN device_credentials c ON c.phone = s.phone
     WHERE s.removed_at IS NULL
     -- phone breaks first_seen_at ties. The sync inserts a whole scan in one
     -- statement, so every row in a batch shares a timestamp; without a
     -- tiebreaker the list would shuffle between refreshes for no reason.
     ORDER BY s.first_seen_at DESC, s.phone ASC
     LIMIT $1
    `,
    [MAX_ACTIVE]
  )
  return rows
}

/**
 * A stable opaque key for a number, used as a React list key.
 *
 * Two different numbers can mask to the SAME string — the hidden digits are
 * exactly the ones that differ — so the masked form cannot be used as an
 * identity. This gives the client something stable to key rows on without
 * exposing the number.
 *
 * The salt is a fixed constant rather than a secret, and deliberately so: this
 * is not a privacy control. The masked number sits next to it in the same
 * response, so reversing this identifier reveals nothing the row does not
 * already show.
 */
export function sessionKey(phone) {
  return createHash('sha256').update(`mzazi.session:${phone}`).digest('hex').slice(0, 12)
}

/** Is this number a session the bot currently holds? */
export async function findActiveSession(phone) {
  const { rows } = await query(
    `SELECT phone, first_seen_at, last_seen_at
       FROM bot_sessions
      WHERE phone = $1 AND removed_at IS NULL`,
    [phone]
  )
  return rows[0] || null
}
