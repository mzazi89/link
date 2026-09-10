import { NextResponse } from 'next/server'

import { unavailable } from '@/lib/db'
import { maskForDisplay } from '@/lib/phone'
import { listActiveSessions, sessionKey } from '@/lib/sessions'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * The numbers the bot is currently connected to.
 *
 * This list is derived from the bot's session folders, published into
 * `bot_sessions` by the worker's sync job — the site itself is serverless and
 * cannot read that directory. Whatever the bot fails to report does not appear.
 *
 * ── This is a PUBLIC list ────────────────────────────────────────────────────
 *
 * There is no login and this takes no parameters, so anyone who opens the page
 * sees every connected number. The only protection is the masking: the middle
 * digits are never sent, so a visitor sees `254741****86` and not the number
 * itself.
 *
 * That is a real exposure and worth being explicit about. A visitor can see how
 * many customers there are, watch the number grow, and — because the mask keeps
 * six leading and two trailing digits — narrow any specific entry substantially.
 * If that is not acceptable, this endpoint is the one to gate.
 *
 * `has_password` from the register is deliberately NOT included. Publishing
 * which numbers still rely on the primary password would be publishing a list of
 * exactly which devices can be removed with a well-known default.
 */
export async function GET() {
  try {
    const rows = await listActiveSessions()

    const devices = rows.map((row) => ({
      id: sessionKey(row.phone),
      maskedPhone: maskForDisplay(row.phone),
      connected: true,
      connectedSince: row.first_seen_at,
    }))

    return NextResponse.json(
      { ok: true, count: devices.length, devices },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('[link][connected] lookup failed:', err.message)
    return NextResponse.json(unavailable(err, 'Could not load connected numbers.'), {
      status: 503,
      headers: NO_STORE,
    })
  }
}

export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: 'method_not_allowed',
      message: 'Use GET. This list takes no parameters.',
    },
    { status: 405, headers: { ...NO_STORE, Allow: 'GET' } }
  )
}
