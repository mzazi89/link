import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import { digitsOnly } from './phone'

/**
 * Per-number passwords.
 *
 * A user sets one when they first link a number, and it is the only thing that
 * can authorise deleting that number later. There is no account to reset it
 * from, so this module has one job: make the stored secret as useless to an
 * attacker who steals the database as possible.
 *
 * ── Why scrypt from node:crypto ──────────────────────────────────────────────
 *
 * No dependency. `bcrypt` needs a native build that is a recurring source of
 * failures on Vercel and Pterodactyl panels — the same class of problem the
 * quartz repo works around by blocking the `sharp` peer. Node ships scrypt in
 * the standard library, so there is nothing to compile, and it is memory-hard
 * unlike a plain SHA.
 */

const scryptAsync = promisify(scrypt)

// 128 * N * r = 16 MiB of memory per hash. OWASP's headline scrypt figure is
// higher (N=2^17), but that costs 128 MiB per concurrent request, which is not
// a reasonable thing to ask of a serverless function. 16 MiB is a deliberate
// trade: still expensive enough to make offline cracking impractical, cheap
// enough to survive a burst. Because N is stored inside each hash, it can be
// raised later without invalidating anything already saved.
const PARAMS = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 32
const SALT_LENGTH = 16
// scrypt needs roughly 128*N*r bytes plus working overhead; the Node default of
// 32 MiB is right at the edge, so give it explicit headroom.
const MAX_MEM = 64 * 1024 * 1024

// Ceiling applied to parameters read back out of the database. Without this, a
// tampered or corrupted row could specify an enormous N and turn a single login
// attempt into a memory-exhaustion attack on the process.
const MAX_N = 1 << 20
const MAX_R = 32
const MAX_P = 16

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 128

// ── Hashing ──────────────────────────────────────────────────────────────────

/**
 * Unicode-normalise before hashing.
 *
 * Without this, the same password typed on a phone keyboard and a desktop
 * keyboard can produce different byte sequences (composed vs decomposed
 * accents), and a correct password would be rejected. Normalising at both ends
 * makes the comparison consistent.
 */
function prepare(password) {
  return String(password ?? '').normalize('NFKC')
}

/** → "scrypt$N$r$p$base64salt$base64hash" */
export async function hashPassword(password) {
  const salt = randomBytes(SALT_LENGTH)
  const derived = await scryptAsync(prepare(password), salt, KEY_LENGTH, {
    ...PARAMS,
    maxmem: MAX_MEM,
  })
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$')
}

/**
 * Constant-time verification.
 *
 * Returns false rather than throwing on anything malformed, so a corrupt row
 * can never crash a request or leak a stack trace into a response.
 */
export async function verifyPassword(password, stored) {
  const parsed = parseHash(stored)
  if (!parsed) return false

  try {
    const derived = await scryptAsync(prepare(password), parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    })
    // Both buffers are the same length by construction, which timingSafeEqual
    // requires. Comparing with === would leak how many leading bytes matched.
    return timingSafeEqual(derived, parsed.hash)
  } catch {
    return false
  }
}

function parseHash(stored) {
  if (typeof stored !== 'string') return null

  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null

  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])

  if (!isPowerOfTwo(N) || N < 1024 || N > MAX_N) return null
  if (!Number.isInteger(r) || r < 1 || r > MAX_R) return null
  if (!Number.isInteger(p) || p < 1 || p > MAX_P) return null

  let salt
  let hash
  try {
    salt = Buffer.from(parts[4], 'base64')
    hash = Buffer.from(parts[5], 'base64')
  } catch {
    return null
  }
  if (salt.length < 8 || hash.length < 16) return null

  return { N, r, p, salt, hash }
}

function isPowerOfTwo(n) {
  return Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0
}

/**
 * Spend roughly the same time as a real verification.
 *
 * The unlink endpoint must not answer faster for a number that has no
 * credential than for one that does — otherwise the response time itself
 * becomes an oracle for "does this number use the service", which is exactly
 * what the rest of the design works to hide.
 */
const EQ_SALT = Buffer.alloc(SALT_LENGTH, 7)
export async function burnVerificationTime() {
  try {
    await scryptAsync('timing-equaliser', EQ_SALT, KEY_LENGTH, {
      ...PARAMS,
      maxmem: MAX_MEM,
    })
  } catch {
    // Never let a timing defence become a failure path.
  }
}

// ── Policy ───────────────────────────────────────────────────────────────────

/**
 * @param {string} password
 * @param {string} [msisdn] normalised number, to reject the password literally
 *                          being the phone number
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
export function validatePasswordStrength(password, msisdn) {
  const value = prepare(password)

  if (!value) {
    return {
      ok: false,
      reason: 'password_empty',
      message: 'Choose a password. You will need it to remove this device later.',
    }
  }
  if (value.length < MIN_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'password_too_short',
      message: `Use at least ${MIN_PASSWORD_LENGTH} characters.`,
    }
  }
  // Cap the length so an attacker cannot force us to run scrypt over megabytes
  // of input on every attempt.
  if (value.length > MAX_PASSWORD_LENGTH) {
    return {
      ok: false,
      reason: 'password_too_long',
      message: `Keep it under ${MAX_PASSWORD_LENGTH} characters.`,
    }
  }
  // Checked before the character-class rules on purpose. Someone who typed
  // their own number has made a specific mistake, and "do not use your phone
  // number" is a far more useful thing to hear than "include a letter" — even
  // though a bare number would trip both.
  const digits = digitsOnly(value)
  const number = digitsOnly(msisdn)
  if (number && containsSubscriberNumber(digits, number)) {
    return {
      ok: false,
      reason: 'password_is_phone',
      message: 'Do not use the phone number itself as the password.',
    }
  }

  if (new Set(value).size === 1) {
    return {
      ok: false,
      reason: 'password_too_weak',
      message: 'That is a single repeated character. Choose something less guessable.',
    }
  }
  if (!/[A-Za-z]/.test(value) || !/[0-9]/.test(value)) {
    return {
      ok: false,
      reason: 'password_too_weak',
      message: 'Include at least one letter and one number.',
    }
  }

  return { ok: true }
}

/**
 * Does this password embed the number it is meant to protect?
 *
 * People write their own number three ways — international (254712…), national
 * with the trunk zero (0712…), and bare subscriber (712…). A naive comparison
 * against the stored MSISDN only catches the first, so "abc0712345678" would
 * sail through while "abc254712345678" was refused. Each form is reduced to its
 * subscriber digits and then checked as a suffix, which is the only shape that
 * makes all three equivalent.
 */
function containsSubscriberNumber(passwordDigits, msisdnDigits) {
  const MIN_SUBSCRIBER = 7
  const candidates = new Set()

  const add = (value) => {
    if (value && value.length >= MIN_SUBSCRIBER) candidates.add(value)
  }

  add(passwordDigits)
  // National form: drop the trunk zeros.
  add(passwordDigits.replace(/^0+/, ''))
  // International form: drop a leading country code, assuming 1-3 digits.
  for (let dial = 1; dial <= 3; dial += 1) {
    if (passwordDigits.length > dial + MIN_SUBSCRIBER) {
      add(passwordDigits.slice(dial))
    }
  }

  for (const candidate of candidates) {
    if (msisdnDigits.endsWith(candidate)) return true
  }
  return false
}
