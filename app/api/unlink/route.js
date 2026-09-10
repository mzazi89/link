import { NextResponse } from 'next/server'

import { createUnpairRequest, findInFlight, promoteCredential } from '@/lib/botControl'
import { isKnownSession } from '@/lib/botStatus'
import {
  clearFailedAttempts,
  loadCredential,
  lockoutRemainingSeconds,
  registerFailedAttempt,
} from '@/lib/credentials'
import { notifyRequest, unavailable } from '@/lib/db'
import { legacyFallbackEnabled, verifyLegacyPassword } from '@/lib/legacyPassword'
import { burnVerificationTime, verifyPassword } from '@/lib/password'
import { describeReason, maskForDisplay, normalizePhone } from '@/lib/phone'
import {
  checkVerificationLimits,
  clientIpFrom,
  describeRetry,
  hashIp,
  maybePruneAttempts,
  recordPasswordAttempt,
  recordRequest,
} from '@/lib/rateLimit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const json = (payload, status = 200) =>
  NextResponse.json(payload, { status, headers: NO_STORE })

// One message for every rejection. A wrong password, a number that was never
// linked, and a number with no password at all must be indistinguishable, or
// this endpoint becomes a way to test whether any given phone uses the service.
const GENERIC_FAILURE = 'Those details do not match a linked device.'

/**
 * Queue a removal, gated on the password set when the number was linked.
 */
export async function POST(request) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ ok: false, error: 'bad_request', message: 'Expected a JSON body.' }, 400)
  }

  const normalized = normalizePhone(body?.dialCode, body?.national)
  if (!normalized.ok) {
    return json(
      { ok: false, error: normalized.reason, message: describeReason(normalized.reason) },
      400
    )
  }
  const phone = normalized.msisdn

  const password = typeof body?.password === 'string' ? body.password : ''
  if (!password) {
    return json({ ok: false, error: 'password_required', message: 'Enter your password.' }, 400)
  }

  const ipHash = hashIp(clientIpFrom(request.headers))

  try {
    const limit = await checkVerificationLimits({ ipHash })
    if (!limit.allowed) {
      return json(
        {
          ok: false,
          error: 'rate_limited',
          retryAfterSeconds: limit.retryAfterSeconds,
          message: describeRetry(limit.retryAfterSeconds),
        },
        429
      )
    }
  } catch (err) {
    console.error('[link][unlink] throttle check failed:', err.message)
    return json(
      unavailable(err, 'Removal is temporarily unavailable. Please try again shortly.'),
      503
    )
  }

  try {
    // Repair, before reading: if a pairing completed while the browser was
    // closed, the password is still staged on its request row. Promoting here
    // means the user is not locked out of a number they legitimately own.
    try {
      await promoteCredential(phone)
    } catch (err) {
      console.warn('[link][unlink] credential repair failed:', err.message)
    }

    const credential = await loadCredential(phone)
    let authorised = false
    let usedLegacyPassword = false

    if (credential) {
      const lockedFor = lockoutRemainingSeconds(credential)
      if (lockedFor > 0) {
        // Reported with scope 'ip' rather than a number-specific message, so a
        // lockout cannot be told apart from the IP throttle.
        return json(
          {
            ok: false,
            error: 'rate_limited',
            scope: 'ip',
            retryAfterSeconds: lockedFor,
            message: describeRetry(lockedFor),
          },
          429
        )
      }

      authorised = await verifyPassword(password, credential.password_hash)
      if (!authorised) {
        try {
          await registerFailedAttempt(phone)
        } catch (err) {
          console.warn('[link][unlink] could not record failed attempt:', err.message)
        }
      }
    } else {
      // No credential. That is either a number that was never linked, or one
      // paired before this site existed. Only the bot's session list can tell
      // them apart.
      const known = await isKnownSession(phone)
      if (!known) {
        await burnVerificationTime()
      } else if (legacyFallbackEnabled()) {
        authorised = await verifyLegacyPassword(password)
        usedLegacyPassword = authorised
      } else {
        await burnVerificationTime()
      }
    }

    if (!authorised) {
      await recordPasswordAttempt({ phone, ipHash, success: false })
      maybePruneAttempts()
      return json({ ok: false, error: 'not_authorised', message: GENERIC_FAILURE }, 401)
    }

    await recordPasswordAttempt({ phone, ipHash, success: true })
    if (credential) {
      try {
        await clearFailedAttempts(phone)
      } catch (err) {
        console.warn('[link][unlink] could not clear failed attempts:', err.message)
      }
    } else if (usedLegacyPassword) {
      console.warn(
        `[link][unlink] removal authorised by a primary password for +${phone.slice(0, 3)}…`
      )
    }

    if (await findInFlight(phone, 'unpair')) {
      return json(
        {
          ok: false,
          error: 'already_pending',
          message: 'A removal for this number is already in progress. Give it a moment.',
        },
        409
      )
    }

    await recordRequest({ action: 'unpair', phone, ipHash })
    const created = await createUnpairRequest(phone)

    // Same optional speed path as pairing — see the note in /api/link.
    notifyRequest(String(created.id))

    return json({
      ok: true,
      requestId: created.id,
      action: 'delete',
      maskedPhone: maskForDisplay(phone),
      createdAt: created.created_at,
    })
  } catch (err) {
    console.error('[link][unlink] could not queue removal:', err.message)
    return json(unavailable(err, 'Could not queue the removal. Please try again shortly.'), 503)
  }
}

export async function GET() {
  return json({ ok: false, error: 'method_not_allowed' }, 405)
}
