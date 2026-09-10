import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

import { query } from '@/lib/db'
import { describeReason, formatE164, maskMsisdn, normalizePhone } from '@/lib/phone'
import {
  checkRateLimits,
  clientIpFrom,
  describeRetry,
  hashIp,
} from '@/lib/rateLimit'

// node-postgres is not Edge-compatible, and the queue needs a real TCP socket.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Create a link request.
 *
 * Body: { dialCode: "254", national: "712345678" }
 *
 * Returns a publicId the browser polls with. The row lands in `pending` and the
 * quartz bot picks it up from there.
 *
 * Two deliberate design choices:
 *
 *  1. We do NOT check whether the number is already paired with the bot. This
 *     endpoint is unauthenticated, so a "that number is already linked" reply
 *     would turn it into a free oracle for testing whether any given phone
 *     number uses the service. The request is queued regardless and the bot —
 *     which can see its own session folders — decides what to do.
 *
 *  2. We do NOT echo whether the number is valid beyond basic shape checks, for
 *     the same reason.
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

  const parsed = normalizePhone(body?.dialCode, body?.national)
  if (!parsed.ok) {
    return NextResponse.json(
      {
        ok: false,
        error: parsed.reason,
        message: describeReason(parsed.reason),
      },
      { status: 400, headers: NO_STORE }
    )
  }

  const { msisdn, dialCode } = parsed

  const ip = clientIpFrom(request.headers)
  const ipHash = hashIp(ip)

  let limit
  try {
    limit = await checkRateLimits({ ipHash, phone: msisdn })
  } catch (err) {
    // Fail closed. If we cannot prove the caller is under the limit, we do not
    // queue work for the bot — an outage must not become an open door.
    console.error('[link][api] rate limit check failed:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: 'Linking is temporarily unavailable. Please try again shortly.',
      },
      { status: 503, headers: NO_STORE }
    )
  }

  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        error: 'rate_limited',
        scope: limit.scope,
        retryAfterSeconds: limit.retryAfterSeconds,
        message: describeRetry(limit.retryAfterSeconds),
      },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(limit.retryAfterSeconds || 60) } }
    )
  }

  // 18 random bytes → 24 base64url chars. Not derivable from the row id, so the
  // endpoint cannot be walked to read other people's pairing codes.
  const publicId = randomBytes(18).toString('base64url')
  const ttlMinutes = Number.parseInt(process.env.LINK_TTL_MINUTES ?? '', 10) || 10

  try {
    const { rows } = await query(
      `
      INSERT INTO link_requests (public_id, phone, dial_code, ip_hash, user_agent, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + make_interval(mins => $6::int))
      RETURNING public_id, status, created_at, expires_at
      `,
      [
        publicId,
        msisdn,
        dialCode,
        ipHash,
        (request.headers.get('user-agent') || '').slice(0, 300),
        ttlMinutes,
      ]
    )

    const row = rows[0]
    return NextResponse.json(
      {
        ok: true,
        publicId: row.public_id,
        status: row.status,
        phone: formatE164(msisdn),
        maskedPhone: maskMsisdn(msisdn),
        dialCode,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      },
      { status: 201, headers: NO_STORE }
    )
  } catch (err) {
    console.error('[link][api] insert failed:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: 'Could not queue your request. Please try again shortly.',
      },
      { status: 503, headers: NO_STORE }
    )
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed', message: 'Use POST to create a link request.' },
    { status: 405, headers: { ...NO_STORE, Allow: 'POST' } }
  )
}
