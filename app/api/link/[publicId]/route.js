import { NextResponse } from 'next/server'

import { query } from '@/lib/db'
import { formatE164 } from '@/lib/phone'
import { formatPairingCode } from '@/lib/pairingCode'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

// Terminal states — once a row reaches one of these, polling can stop.
const TERMINAL = new Set(['linked', 'failed', 'expired'])

/**
 * Poll a link request.
 *
 * This is what the browser hits every couple of seconds while the user waits.
 * It returns only the fields the UI needs, and only returns the pairing code
 * once the bot has actually produced one.
 */
export async function GET(_request, { params }) {
  const publicId = String(params?.publicId || '')

  // Reject absurdly long ids before they reach the database. The column is TEXT
  // and indexed, so an oversized value is a cheap index probe we do not need to
  // pay for on a public endpoint.
  if (!publicId || publicId.length < 16 || publicId.length > 128) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404, headers: NO_STORE }
    )
  }

  let row
  try {
    const result = await query(
      `
      SELECT public_id, phone, dial_code, status, pairing_code, error,
             created_at, expires_at, code_ready_at, linked_at
      FROM link_requests
      WHERE public_id = $1
      `,
      [publicId]
    )
    row = result.rows[0]
  } catch (err) {
    console.error('[link][status] lookup failed:', err.message)
    return NextResponse.json(
      { ok: false, error: 'unavailable' },
      { status: 503, headers: NO_STORE }
    )
  }

  if (!row) {
    return NextResponse.json(
      { ok: false, error: 'not_found' },
      { status: 404, headers: NO_STORE }
    )
  }

  let status = row.status
  const expired = new Date(row.expires_at).getTime() <= Date.now()

  // The bot is responsible for expiring its own work, but a queued row nobody
  // ever claimed would otherwise sit at 'pending' forever and the user would
  // watch a spinner until they gave up. A row still in 'pending' has provably
  // not been touched by a worker, so it is safe to close out here.
  //
  // Rows in 'processing' or 'ready' are deliberately left alone — a worker may
  // be mid-flight, and racing it would produce a row whose status disagrees
  // with what the bot is actually doing.
  if (expired && status === 'pending') {
    try {
      await query(
        `UPDATE link_requests
            SET status = 'expired', updated_at = now()
          WHERE public_id = $1 AND status = 'pending'`,
        [publicId]
      )
      status = 'expired'
    } catch (err) {
      // Non-fatal: report expiry to the client even if the write lost a race.
      console.warn('[link][status] lazy expiry write failed:', err.message)
      status = 'expired'
    }
  } else if (expired && (status === 'processing' || status === 'ready')) {
    status = 'expired'
  }

  const payload = {
    ok: true,
    publicId: row.public_id,
    status,
    terminal: TERMINAL.has(status),
    phone: formatE164(row.phone),
    dialCode: row.dial_code,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    linkedAt: row.linked_at,
  }

  if (status === 'ready' || status === 'linked') {
    payload.pairingCode = formatPairingCode(row.pairing_code)
    payload.codeReadyAt = row.code_ready_at
  }

  // Only surface a failure reason the bot explicitly recorded. Internal errors
  // are logged server-side, never forwarded.
  if (status === 'failed') {
    payload.message = row.error || 'The pairing could not be completed. Please try again.'
  }

  return NextResponse.json(payload, { headers: NO_STORE })
}
