import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'

import {
  clearFailedAttempts,
  loadCredential,
  lockoutRemainingSeconds,
  registerFailedAttempt,
} from '@/lib/credentials'
import { query } from '@/lib/db'
import { burnVerificationTime, verifyPassword } from '@/lib/password'
import { describeReason, formatE164, maskMsisdn, normalizePhone } from '@/lib/phone'
import {
  checkVerificationLimits,
  clientIpFrom,
  describeRetry,
  hashIp,
  maybePruneAttempts,
  recordPasswordAttempt,
} from '@/lib/rateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * One message for every rejection.
 *
 * A wrong password and a number that was never linked must be indistinguishable,
 * or this endpoint becomes a way to test whether a given phone number uses the
 * service. Same wording, and the same amount of work spent on both paths.
 */
const GENERIC_FAILURE = 'Those details do not match a linked device.'

/**
 * Authorise and queue a device deletion.
 *
 * Body: { dialCode: "254", national: "712345678", password: "..." }
 *
 * The password set at link time is checked here; on success we queue an
 * action='delete' row and the bot wipes the session. The site never deletes
 * anything itself — it has no access to the session folders, and giving a
 * public-facing web app the ability to destroy bot state directly would be a
 * worse shape for the system than a queue the bot drains on its own terms.
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
  const password = String(body?.password ?? '')

  if (!password) {
    return NextResponse.json(
      { ok: false, error: 'password_empty', message: 'Enter the password you set when you linked this device.' },
      { status: 400, headers: NO_STORE }
    )
  }

  const ip = clientIpFrom(request.headers)
  const ipHash = hashIp(ip)

  // Throttle before verifying — scrypt is expensive on purpose, and that cost is
  // exactly what would make an unthrottled endpoint worth attacking.
  try {
    const limit = await checkVerificationLimits({ ipHash })
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
          headers: {
            ...NO_STORE,
            'Retry-After': String(limit.retryAfterSeconds || 60),
          },
        }
      )
    }
  } catch (err) {
    console.error('[link][unlink] throttle check failed:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: 'Removal is temporarily unavailable. Please try again shortly.',
      },
      { status: 503, headers: NO_STORE }
    )
  }

  let credential
  try {
    credential = await loadCredential(msisdn)
  } catch (err) {
    console.error('[link][unlink] credential lookup failed:', err.message)
    return NextResponse.json(
      { ok: false, error: 'unavailable', message: 'Removal is temporarily unavailable.' },
      { status: 503, headers: NO_STORE }
    )
  }

  if (!credential) {
    // No credential means this number was never linked. Do the same amount of
    // cryptographic work as a real check would, then answer identically.
    await burnVerificationTime()
    await recordPasswordAttempt({ phone: msisdn, ipHash, success: false })
    void maybePruneAttempts()
    return NextResponse.json(
      { ok: false, error: 'no_match', message: GENERIC_FAILURE },
      { status: 401, headers: NO_STORE }
    )
  }

  // Per-number lockout, reported with the same generic wording and status as an
  // IP throttle so the two cannot be told apart from outside.
  const lockedFor = lockoutRemainingSeconds(credential)
  if (lockedFor > 0) {
    return NextResponse.json(
      {
        ok: false,
        error: 'rate_limited',
        scope: 'ip',
        retryAfterSeconds: lockedFor,
        message: describeRetry(lockedFor),
      },
      { status: 429, headers: { ...NO_STORE, 'Retry-After': String(lockedFor) } }
    )
  }

  let valid = false
  try {
    valid = await verifyPassword(password, credential.password_hash)
  } catch (err) {
    console.error('[link][unlink] verification error:', err.message)
  }

  if (!valid) {
    try {
      const state = await registerFailedAttempt(msisdn)
      if (state && new Date(state.locked_until).getTime() > Date.now()) {
        console.warn(`[link][unlink] locked ${maskMsisdn(msisdn)} after repeated failures`)
      }
    } catch (err) {
      console.error('[link][unlink] could not register failed attempt:', err.message)
    }
    await recordPasswordAttempt({ phone: msisdn, ipHash, success: false })
    void maybePruneAttempts()
    return NextResponse.json(
      { ok: false, error: 'no_match', message: GENERIC_FAILURE },
      { status: 401, headers: NO_STORE }
    )
  }

  // Authorised. Clear the counter, log the success, and queue the wipe.
  try {
    await clearFailedAttempts(msisdn)
  } catch (err) {
    console.warn('[link][unlink] could not clear failed attempts:', err.message)
  }
  await recordPasswordAttempt({ phone: msisdn, ipHash, success: true })
  void maybePruneAttempts()

  const publicId = randomBytes(18).toString('base64url')
  const ttlMinutes = Number.parseInt(process.env.LINK_TTL_MINUTES ?? '', 10) || 10

  try {
    const { rows } = await query(
      `
      INSERT INTO device_requests
        (public_id, action, phone, dial_code, ip_hash, user_agent, expires_at)
      VALUES
        ($1, 'delete', $2, $3, $4, $5, now() + make_interval(mins => $6::int))
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
        action: 'delete',
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
    console.error('[link][unlink] insert failed:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: 'Could not queue the removal. Please try again shortly.',
      },
      { status: 503, headers: NO_STORE }
    )
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed', message: 'Use POST to remove a device.' },
    { status: 405, headers: { ...NO_STORE, Allow: 'POST' } }
  )
}
