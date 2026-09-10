import { query } from './db'
import { hashPassword } from './password'
import { verificationConfig } from './rateLimit'

/**
 * The credential store: one password per number.
 *
 * Kept separate from lib/rateLimit.js because these are two different jobs —
 * that module decides whether a caller may try, this one owns the secret and
 * the per-number lockout that follows from trying too often.
 */

export async function loadCredential(phone) {
  const { rows } = await query(
    `
    SELECT phone, password_hash, created_at, updated_at,
           last_verified_at, failed_attempts, locked_until
      FROM device_credentials
     WHERE phone = $1
    `,
    [phone]
  )
  return rows[0] || null
}

/**
 * Write (or replace) the password for a number.
 *
 * Callers MUST have established the right to do this first: either no
 * credential exists yet, or the caller proved knowledge of the existing
 * password. Left unguarded, this is the hijack primitive — overwrite someone's
 * password, then delete their session.
 */
export async function setCredential(phone, password) {
  const hash = await hashPassword(password)
  const { rows } = await query(
    `
    INSERT INTO device_credentials (phone, password_hash)
    VALUES ($1, $2)
    ON CONFLICT (phone) DO UPDATE
       SET password_hash   = EXCLUDED.password_hash,
           failed_attempts = 0,
           locked_until    = NULL,
           updated_at      = now()
    RETURNING phone, created_at, updated_at
    `,
    [phone, hash]
  )
  return rows[0]
}

/** Seconds left on the lockout, 0 when the credential is usable. */
export function lockoutRemainingSeconds(credential) {
  if (!credential?.locked_until) return 0
  const remaining = new Date(credential.locked_until).getTime() - Date.now()
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0
}

/**
 * Record a wrong password and start or extend the lockout once the running
 * count crosses the threshold.
 */
export async function registerFailedAttempt(phone) {
  const { lockoutAfter, lockoutMinutes } = verificationConfig()
  const { rows } = await query(
    `
    UPDATE device_credentials
       SET failed_attempts = failed_attempts + 1,
           locked_until = CASE
             WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3::int)
             ELSE locked_until
           END,
           updated_at = now()
     WHERE phone = $1
    RETURNING failed_attempts, locked_until
    `,
    [phone, lockoutAfter, lockoutMinutes]
  )
  return rows[0] || null
}

/** A correct password clears the counter and stamps the successful check. */
export async function clearFailedAttempts(phone) {
  await query(
    `
    UPDATE device_credentials
       SET failed_attempts  = 0,
           locked_until     = NULL,
           last_verified_at = now(),
           updated_at       = now()
     WHERE phone = $1
    `,
    [phone]
  )
}
