import { NextResponse } from 'next/server'

import { listBotStatuses } from '@/lib/botStatus'
import { listBots } from '@/lib/bots'
import { unavailable } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * The bots this site can pair to.
 *
 * The list comes from the shared `settings` table, so it is the same list the
 * bot itself is configured with — see lib/bots.js for why that matters.
 *
 * `multiple` is the flag the UI keys off: with one bot there is nothing to
 * choose and the selector is not rendered at all, which keeps a single-bot
 * deployment looking exactly as it did before.
 */
export async function GET() {
  try {
    const configured = await listBots()

    let statuses = []
    try {
      statuses = await listBotStatuses()
    } catch (err) {
      // bot_status is written by the bot. If it is missing, the list still has
      // to render — every bot simply shows as not-yet-seen.
      console.warn('[link][bots] could not read bot_status:', err.message)
    }

    const byId = new Map(statuses.map((s) => [s.id, s]))

    const bots = configured.map((bot) => {
      const status = byId.get(bot.id)
      return {
        id: bot.id,
        name: bot.name,
        // A configured bot with no heartbeat row has never run. Reporting it as
        // offline is honest; hiding it would leave someone wondering why their
        // newly added second bot is not offered.
        known: Boolean(status),
        online: status ? status.online === true : false,
        deviceCount: status ? status.deviceCount : 0,
      }
    })

    return NextResponse.json(
      { ok: true, count: bots.length, multiple: bots.length > 1, bots },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('[link][bots] lookup failed:', err.message)
    return NextResponse.json(unavailable(err, 'Could not load the bot list.'), {
      status: 503,
      headers: NO_STORE,
    })
  }
}
