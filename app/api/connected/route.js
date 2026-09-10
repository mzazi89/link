import { NextResponse } from 'next/server'

import { readBotStatus } from '@/lib/botStatus'
import { listBots } from '@/lib/bots'
import { unavailable } from '@/lib/db'
import { deviceKey } from '@/lib/deviceKey'
import { maskForDisplay } from '@/lib/phone'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Every number the bots are connected to, with telemetry.
 *
 *   GET /api/connected           every bot, merged
 *   GET /api/connected?bot=xmd   only that bot
 *
 * Read from the heartbeat each bot writes into `bot_status`, so this cannot
 * drift from what the bots actually hold. Two deliberate departures from
 * quartzxd, both requested: numbers are masked, and a stale heartbeat is not
 * reported as online.
 *
 * Merging by default matters once there is more than one bot. Reading a single
 * "latest" row would show whichever bot happened to write last and silently hide
 * the other one's devices — the list would look complete and be wrong.
 */
export async function GET(request) {
  try {
    const requested = new URL(request.url).searchParams.get('bot') || null

    const bots = await listBots()
    const wanted = requested ? bots.filter((b) => b.id === requested) : bots

    const devices = []
    let anyOnline = false
    let anyKnown = false
    let ip = null
    let version = null
    let uptimeSeconds = null
    let lastSeenAt = null
    let stale = false

    for (const bot of wanted) {
      // eslint-disable-next-line no-await-in-loop
      const status = await readBotStatus(bot.id)

      if (status.known) anyKnown = true
      if (status.botOnline) anyOnline = true
      stale = stale || Boolean(status.stale)

      // With one bot selected, its details are the interesting ones. Merged,
      // keep the freshest of whatever was found.
      if (status.ip && !ip) ip = status.ip
      if (status.version && !version) version = status.version
      if (uptimeSeconds == null && status.uptimeSeconds != null) {
        uptimeSeconds = status.uptimeSeconds
      }
      if (status.lastSeenAt && !lastSeenAt) lastSeenAt = status.lastSeenAt

      for (const d of status.devices) {
        devices.push({
          // Stable opaque identity, so the page can match "the number I just
          // paired" against this list without either side holding the number.
          id: deviceKey(d.phone),
          bot: bot.id,
          botName: bot.name,
          maskedPhone: maskForDisplay(d.phone),
          connected: true,
          online: d.online,
          // null when the Baileys build does not report them, which renders as a
          // dash rather than as a zero.
          battery: d.battery,
          plugged: d.plugged,
          lastSeen: d.lastSeen,
        })
      }
    }

    return NextResponse.json(
      {
        ok: true,
        bot: requested,
        botKnown: anyKnown,
        botOnline: anyOnline,
        stale,
        ip,
        version,
        uptimeSeconds,
        lastSeenAt,
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
