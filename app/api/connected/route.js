import { NextResponse } from 'next/server'

import { query } from '@/lib/db'
import { maskForDisplay } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

// The browser only ever holds a handful of these, so a generous ceiling costs
// nothing and bounds the query's parameter array.
const MAX_IDS = 50

/**
 * Resolve the connected state of specific numbers.
 *
 * Body: { publicIds: ["...", "..."] }
 *
 * ── Why this takes publicIds and not phone numbers ───────────────────────────
 *
 * Taking a list of numbers would make this an enumeration oracle: anyone could
 * post a range of numbers and learn which of them are customers. That is exactly
 * the leak the rest of the design works to avoid.
 *
 * A public_id is 24 random base64url characters, so a caller can only ask about
 * numbers it already holds a reference for — the ones this browser linked. The
 * response is therefore limited to what the caller already had a right to see.
 *
 * ── What "connected" means ───────────────────────────────────────────────────
 *
 * A device_credentials row existing for the number. That table is written only
 * after a device genuinely links, and the worker removes the row when a device
 * is deleted — so it is a real register of what is currently connected, not a
 * guess from request history.
 *
 * It does NOT know about a device unlinked directly inside WhatsApp. Nothing on
 * this side can see that, because the session folders live on the bot's host.
 */
export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'bad_request', message: 'Expected a JSON body.' },
      { status: 400, headers: NO_STORE }
    )
  }

  const raw = Array.isArray(body?.publicIds) ? body.publicIds : []
  const publicIds = [
    ...new Set(
      raw.filter(
        (v) => typeof v === 'string' && v.length >= 16 && v.length <= 128
      )
    ),
  ].slice(0, MAX_IDS)

  if (publicIds.length === 0) {
    return NextResponse.json({ ok: true, devices: [] }, { headers: NO_STORE })
  }

  try {
    // DISTINCT ON keeps one row per phone — the newest request for it — so a
    // number linked several times over the months appears once, not N times.
    const { rows } = await query(
      `
      SELECT DISTINCT ON (r.phone)
             r.public_id,
             r.phone,
             r.action,
             r.status,
             r.created_at,
             r.linked_at,
             (c.phone IS NOT NULL) AS has_credential,
             c.created_at          AS credential_since
        FROM device_requests r
        LEFT JOIN device_credentials c ON c.phone = r.phone
       WHERE r.public_id = ANY($1::text[])
       ORDER BY r.phone, r.created_at DESC
      `,
      [publicIds]
    )

    const devices = rows
      .map((row) => ({
        publicId: row.public_id,
        action: row.action,
        status: row.status,
        // Only the masked form leaves the server. The browser that linked a
        // number never needs the full digits again — removal is authorised by
        // the password, not by holding the number.
        maskedPhone: maskForDisplay(row.phone),
        connected: Boolean(row.has_credential),
        linkedAt: row.linked_at,
        connectedSince: row.credential_since,
      }))
      // Connected first, newest link first, so the list reads as a live register.
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1
        return new Date(b.connectedSince || b.linkedAt || 0) - new Date(a.connectedSince || a.linkedAt || 0)
      })

    return NextResponse.json({ ok: true, devices }, { headers: NO_STORE })
  } catch (err) {
    console.error('[link][connected] lookup failed:', err.message)
    return NextResponse.json(
      { ok: false, error: 'unavailable', message: 'Could not load your numbers.' },
      { status: 503, headers: NO_STORE }
    )
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed', message: 'Use POST with a list of references.' },
    { status: 405, headers: { ...NO_STORE, Allow: 'POST' } }
  )
}
