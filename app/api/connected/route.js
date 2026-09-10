import { NextResponse } from 'next/server'

import { readBotStatus } from '@/lib/botStatus'
import { unavailable } from '@/lib/db'
import { deviceKey } from '@/lib/deviceKey'
import { maskForDisplay } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Every number the bot is currently connected to, with telemetry.
 *
 * Read straight from the bot's heartbeat (`bot_status`), which quartz already
 * maintains — the same source quartzxd uses. No syncing, no second register, and
 * no way for this list to drift from what the bot actually holds.
 *
 * Two deliberate departures from quartzxd:
 *
 *   Numbers are masked. quartzxd prints them in full; the author of this site
 *   asked for the middle digits hidden, and this endpoint is public with no
 *   parameters, so a full number here is a full number for anyone who loads the
 *   page.
 *
 *   A stale heartbeat is not reported as online. If the row has not been written
 *   for five minutes, the boolean inside it is history rather than status.
 */
export async function GET() {
  try {
    const status = await readBotStatus()

    const devices = status.devices.map((d) => ({
      // Stable opaque identity, so the page can match "the number I just paired"
      // against this list without either side holding the number.
      id: deviceKey(d.phone),
      maskedPhone: maskForDisplay(d.phone),
      connected: true,
      online: d.online,
      // battery/plugged are null when the Baileys build does not report them.
      // quartzxd's README notes the current build does not, so these render as a
      // dash — the pipeline is what matters, and it lights up on its own.
      battery: d.battery,
      plugged: d.plugged,
      lastSeen: d.lastSeen,
    }))

    return NextResponse.json(
      {
        ok: true,
        botKnown: status.known,
        botOnline: status.botOnline,
        stale: status.stale,
        ip: status.ip,
        version: status.version,
        uptimeSeconds: status.uptimeSeconds,
        lastSeenAt: status.lastSeenAt,
        count: devices.length,
        devices,
      },
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
    { ok: false, error: 'method_not_allowed' },
    { status: 405, headers: NO_STORE }
  )
}
