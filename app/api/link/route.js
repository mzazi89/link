import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

import { query } from '@/lib/db'
import { hashPassword, validatePasswordStrength } from '@/lib/password'
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
 * Body: { dialCode: "254", national: "712345678", password: "hunter2hunter" }
 *
 * Returns a publicId the browser polls with. The row lands in `pending` and the
 * quartz bot picks it up from there.
 *
 * ── The password ─────────────────────────────────────────────────────────────
 *
 * The user chooses it here, and it is what authorises deleting this number
 * later. We store only a scrypt hash, and we store it ON THE REQUEST rather than
 * in device_credentials — the bot promotes it only once the device has actually
 * connected.
 *
 * That indirection is the security-relevant part. If we wrote the credential on
 * submission, anyone could claim a stranger's number by queueing a request with
 * their own password and permanently lock out the real owner. A promotion
 * happens only after a pairing code has been typed into the target phone, so
 * whoever holds the password is provably holding the phone.
 *
 * ── What we deliberately do NOT do ───────────────────────────────────────────
 *
 * We never report whether the number is already linked to the bot. This endpoint
 * is unauthenticated, so a "that number is already in use" reply would turn it
 * into a free oracle for testing whether any given phone number uses the
 * service. Requests are queued regardless and the bot decides — it can see its
 * own session folders.
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
      { ok: false, error: parsed.reason, message: describeReason(parsed.reason) },
      { status: 400, headers: NO_STORE }
    )
  }

  const { msisdn, dialCode } = parsed

  // Validate the password before anything expensive. Cheap shape checks first,
  // then throttling, and only then scrypt — so a flood of requests cannot make
  // us burn 16 MiB of memory per call before the limiter has had a say.
  const strength = validatePasswordStrength(body?.password, msisdn)
  if (!strength.ok) {
    return NextResponse.json(
      { ok: false, error: strength.reason, message: strength.message },
      { status: 400, headers: NO_STORE }
    )
  }

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
      {
        status: 429,
        headers: { ...NO_STORE, 'Retry-After': String(limit.retryAfterSeconds || 60) },
      }
    )
  }

  // 18 random bytes → 24 base64url chars. Not derivable from the row id, so the
  // endpoint cannot be walked to read other people's pairing codes.
  const publicId = randomBytes(18).toString('base64url')
  const ttlMinutes = Number.parseInt(process.env.LINK_TTL_MINUTES ?? '', 10) || 10

  let passwordHash
  try {
    passwordHash = await hashPassword(body.password)
  } catch (err) {
    console.error('[link][api] hashing failed:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: 'Could not prepare your request. Please try again shortly.',
      },
      { status: 503, headers: NO_STORE }
    )
  }

  try {
    const { rows } = await query(
      `
      INSERT INTO device_requests
        (public_id, action, phone, dial_code, password_hash, ip_hash, user_agent, expires_at)
      VALUES
        ($1, 'link', $2, $3, $4, $5, $6, now() + make_interval(mins => $7::int))
      RETURNING public_id, status, created_at, expires_at
      `,
      [
        publicId,
        msisdn,
        dialCode,
        passwordHash,
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
        action: 'link',
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
