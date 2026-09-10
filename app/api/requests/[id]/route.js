import { NextResponse } from 'next/server'

import {
  clearStagedHash,
  extractCode,
  extractError,
  promoteCredential,
  readRequest,
} from '@/lib/botControl'
import { isKnownSession } from '@/lib/botStatus'
import { unavailable } from '@/lib/db'
import { deviceKey } from '@/lib/deviceKey'
import { formatPairingCode } from '@/lib/pairingCode'
import { maskForDisplay } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const json = (payload, status = 200) =>
  NextResponse.json(payload, { status, headers: NO_STORE })

/**
 * Poll a request.
 *
 * The id is the `bot_control` row id. Status vocabulary the page understands:
 *
 *   queued   the bot has not looked at it yet
 *   working  claimed, the bot is talking to WhatsApp
 *   ready    a code came back — show it
 *   linked   the number is now a session on the bot
 *   removed  the number is no longer a session
 *   done     removal finished but the number is still listed; the bot is
 *            probably mid-cleanup, so this is not yet a success
 *   failed   the bot reported an error
 *
 * `linked` and `removed` are not bot_control statuses. They are answered by
 * asking the bot's own session list, which is the only honest source for "is
 * this number connected" — a bot_control row saying 'done' means the bot did its
 * part, not that WhatsApp accepted it.
 */
export async function GET(_request, { params }) {
  const id = Number(params?.id)
  if (!Number.isInteger(id) || id <= 0) {
    return json({ ok: false, error: 'bad_request', message: 'Invalid request id.' }, 400)
  }

  try {
    const row = await readRequest(id)
    if (!row) return json({ ok: false, error: 'not_found' }, 404)

    const phone = row.number
    const base = {
      ok: true,
      requestId: row.id,
      action: row.action,
      createdAt: row.created_at,
      doneAt: row.done_at,
      // Only ever the masked form. The payload carrying the password hash is
      // read on this side and never echoed.
      maskedPhone: phone ? maskForDisplay(phone) : null,
      deviceKey: phone ? deviceKey(phone) : null,
    }

    if (row.status === 'pending') return json({ ...base, status: 'queued' })
    if (row.status === 'claimed') return json({ ...base, status: 'working' })

    if (row.status === 'failed') {
      return json({
        ...base,
        status: 'failed',
        message: extractError(row.result) || 'The bot could not complete that request.',
      })
    }

    if (row.status === 'done') {
      if (row.action === 'pair' && phone) {
        // The pairing really happened, so the password chosen when it was
        // requested becomes the credential for this number. Also done lazily on
        // the removal path, so closing the page early does not lose it.
        try {
          const promoted = await promoteCredential(phone)
          if (promoted) await clearStagedHash(row.id)
        } catch (err) {
          console.warn('[link][status] could not promote credential:', err.message)
        }
      }

      const known = phone ? await isKnownSession(phone) : false

      if (row.action === 'unpair') {
        return json({ ...base, status: known ? 'done' : 'removed' })
      }

      if (known) return json({ ...base, status: 'linked' })

      const code = extractCode(row.result)
      if (!code) {
        return json({
          ...base,
          status: 'failed',
          message:
            extractError(row.result) ||
            'The bot finished without returning a code. Try again.',
        })
      }

      return json({ ...base, status: 'ready', code: formatPairingCode(code) })
    }

    // Anything unrecognised: treat as still queued rather than as failure, so a
    // new bot status does not make the page lie about a request that is fine.
    return json({ ...base, status: 'queued' })
  } catch (err) {
    console.error('[link][status] lookup failed:', err.message)
    return json(unavailable(err, 'Could not read that request.'), 503)
  }
}
