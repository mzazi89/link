import { NextResponse } from 'next/server'

import { createPairRequest, findInFlight } from '@/lib/botControl'
import { isBotOnline } from '@/lib/botStatus'
import { listBots } from '@/lib/bots'
import { notifyRequest, unavailable } from '@/lib/db'
import { hashPassword, validatePasswordStrength } from '@/lib/password'
import { describeReason, formatE164, maskForDisplay, normalizePhone } from '@/lib/phone'
import {
  checkRateLimits,
  clientIpFrom,
  describeRetry,
  hashIp,
  recordRequest,
} from '@/lib/rateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

// How long the page tells the user their code is good for. WhatsApp rotates
// pairing codes on its own schedule, so this is guidance to the user, not a
// server-enforced deadline — nothing here expires the request.
const CODE_TTL_MINUTES = Number(process.env.CODE_TTL_MINUTES || 3)

/**
 * Queue a pairing request.
 *
 * Writes one `bot_control` row and returns its id. The bot is already polling
 * that table, so this needs nothing from quartz — which is the whole point of
 * moving off the previous design.
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

  const normalized = normalizePhone(body?.dialCode, body?.national)
  if (!normalized.ok) {
    return NextResponse.json(
      { ok: false, error: normalized.reason, message: describeReason(normalized.reason) },
      { status: 400, headers: NO_STORE }
    )
  }
  const phone = normalized.msisdn

  // Policy before hashing: rejecting a weak password is free, hashing it is not.
  const strength = validatePasswordStrength(body?.password, phone)
  if (!strength.ok) {
    return NextResponse.json(
      { ok: false, error: strength.reason, message: strength.message },
      { status: 400, headers: NO_STORE }
    )
  }

  const ipHash = hashIp(clientIpFrom(request.headers))

  try {
    const limit = await checkRateLimits({ ipHash, phone })
    if (!limit.allowed) {
      return NextResponse.json(
        {
          ok: false,
          error: 'rate_limited',
          scope: limit.scope,
          retryAfterSeconds: limit.retryAfterSeconds,
          message: describeRetry(limit.retryAfterSeconds),
        },
        { status: 429, headers: NO_STORE }
      )
    }
  } catch (err) {
    // Fail closed: if we cannot prove the caller is under the limit, we do not
    // queue work for the bot.
    console.error('[link][api] rate limit check failed:', err.message)
    return NextResponse.json(
      unavailable(err, 'Linking is temporarily unavailable. Please try again shortly.'),
      { status: 503, headers: NO_STORE }
    )
  }

  try {
    // Which bot this is for. An unknown name is refused rather than quietly
    // falling back to the primary one, because a pairing that lands on the wrong
    // bot looks successful and cannot be undone from the website.
    const bots = await listBots()
    const requested = typeof body?.bot === 'string' ? body.bot.trim() : ''
    const bot = requested ? bots.find((b) => b.id === requested) : bots[0]

    if (!bot) {
      return NextResponse.json(
        { ok: false, error: 'unknown_bot', message: 'That bot is not available.' },
        { status: 400, headers: NO_STORE }
      )
    }

    // A code is produced by the chosen bot. Queueing one while THAT bot is
    // offline parks the user in front of a spinner for nothing — checking some
    // other bot's health would be worse than not checking at all.
    if (!(await isBotOnline(bot.id))) {
      return NextResponse.json(
        {
          ok: false,
          error: 'bot_offline',
          message: `${bot.name} is offline, so it cannot generate a pairing code right now. Try again shortly.`,
        },
        { status: 503, headers: NO_STORE }
      )
    }

    // Two codes for one number would race, and only one can be entered.
    if (await findInFlight(phone, 'pair')) {
      return NextResponse.json(
        {
          ok: false,
          error: 'already_pending',
          message:
            'A pairing request for this number is already in progress. Give it a moment.',
        },
        { status: 409, headers: NO_STORE }
      )
    }

    await recordRequest({ action: 'pair', phone, ipHash })

    // Last, because it is the only expensive step and every check above is cheap.
    const passwordHash = await hashPassword(body.password)
    const created = await createPairRequest(phone, passwordHash, bot.id)

    // OPTIONAL SPEED PATH. The bot finds this on its own poll (quartzxd's README
    // puts that at ~15s), so this notification does nothing on its own — quartz
    // does not LISTEN on the channel. It is here so that adding a LISTEN to the
    // bot's bot_control consumer turns a 15s wait into an instant one, with no
    // change on this side. Harmless until then, and async so it never delays the
    // response.
    notifyRequest(String(created.id))

    const expiresAt = new Date(
      new Date(created.created_at).getTime() + CODE_TTL_MINUTES * 60_000
    ).toISOString()

    return NextResponse.json(
      {
        ok: true,
        requestId: created.id,
        action: 'pair',
        bot: bot.id,
        botName: bot.name,
        phone: formatE164(phone),
        maskedPhone: maskForDisplay(phone),
        createdAt: created.created_at,
        expiresAt,
      },
      { headers: NO_STORE }
    )
  } catch (err) {
    console.error('[link][api] could not queue pairing:', err.message)
    return NextResponse.json(
      unavailable(err, 'Could not queue your request. Please try again shortly.'),
      { status: 503, headers: NO_STORE }
    )
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed' },
    { status: 405, headers: NO_STORE }
  )
}
