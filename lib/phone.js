import { COUNTRIES, DEFAULT_DIAL_CODE } from './countries'

/**
 * Phone number normalization.
 *
 * Everything downstream — the queue table, the bot, the WhatsApp JID — speaks
 * one dialect: MSISDN, digits only, country code first, no '+' and no trunk
 * zero. e.g. 254712345678
 *
 * The input, however, arrives in whatever shape the user's thumb produced:
 * "+254 712 345 678", "0712 345 678", "712345678", "00254712345678". This
 * module's whole job is collapsing those into one canonical string, or failing
 * with a reason the UI can explain.
 *
 * Deliberately does NOT attempt carrier-level validation (prefix tables). Those
 * go stale, and a false rejection is far worse for a linking site than letting
 * the bot discover an unreachable number.
 */

// ITU-T E.164 ceiling is 15 digits; the practical floor for a real subscriber
// number is around 8.
export const MSISDN_MIN = 8
export const MSISDN_MAX = 15

// Digits required AFTER the country code. The shortest national significant
// numbers in real use are six digits, so anything less cannot be a subscriber
// number no matter how long the whole string is.
export const SUBSCRIBER_MIN = 6

export function digitsOnly(value) {
  return String(value ?? '').replace(/\D+/g, '')
}

/**
 * @param {string} dialCode   e.g. "254" (already chosen in the selector)
 * @param {string} national   whatever the user typed in the number field
 * @returns {{ok: true, msisdn: string, dialCode: string} | {ok: false, reason: string}}
 */
export function normalizePhone(dialCode, national) {
  const rawDial = digitsOnly(dialCode) || DEFAULT_DIAL_CODE
  const typed = String(national ?? '').trim()

  if (!typed) return { ok: false, reason: 'empty' }

  // ── Case 1: the user pasted a fully-qualified international number ─────────
  // People paste "+254 712 345 678" into whichever box is closest to their
  // thumb. When the number carries its own country code, trust it and ignore
  // the selector rather than producing a doubled-up mess like 254254712345678.
  const pasted = typed.replace(/[^\d+]/g, '')
  if (pasted.startsWith('+')) {
    return finalize(digitsOnly(pasted), '', true)
  }
  // International access prefix: 00 254 712… → 254712…
  if (pasted.startsWith('00')) {
    return finalize(digitsOnly(pasted.slice(2)), '', true)
  }

  let n = digitsOnly(typed)
  if (!n) return { ok: false, reason: 'invalid' }

  // ── Case 2: national format with a trunk prefix ────────────────────────────
  // In Kenya — and most of the +2xx / +4xx world — the trunk digit is 0, so the
  // local 0712345678 is internationally 254712345678.
  if (n.startsWith('0')) {
    n = n.replace(/^0+/, '')
    if (!n) return { ok: false, reason: 'invalid' }
  }

  // ── Case 3: already carries the selected dial code ─────────────────────────
  // 254712345678 typed while +254 is selected must not become 254254712345678.
  if (rawDial && n.startsWith(rawDial) && n.length > rawDial.length + 5) {
    return finalize(n, rawDial)
  }

  return finalize(rawDial + n, rawDial)
}

// Distinct dial codes, longest first. Ordering matters: with '+1' ahead of a
// longer code, a North American number would be matched before a 3-digit
// country code that also happens to share the prefix.
const DIAL_CODES_LONGEST_FIRST = [...new Set(COUNTRIES.map((c) => c.dial))].sort(
  (a, b) => b.length - a.length
)

/**
 * Recover the dial code from a fully-qualified number by matching it against
 * the known set. Used only for pasted international numbers, where the selector
 * may bear no relation to what the user actually typed — echoing the selector's
 * country back at them would be an obvious lie on screen.
 *
 * Returns null when nothing matches, rather than guessing. A number from a
 * country missing from our list is still a number worth queueing; we simply
 * cannot say which country it is.
 */
export function inferDialCode(msisdn) {
  const value = digitsOnly(msisdn)
  for (const dial of DIAL_CODES_LONGEST_FIRST) {
    // The remainder must still look like a subscriber number, so a bare "+254"
    // never gets accepted as Kenya.
    if (value.startsWith(dial) && value.length - dial.length >= SUBSCRIBER_MIN) {
      return dial
    }
  }
  return null
}

function finalize(msisdn, dialCode, selfQualified = false) {
  const value = digitsOnly(msisdn)

  if (value.length < MSISDN_MIN) return { ok: false, reason: 'too_short' }
  if (value.length > MSISDN_MAX) return { ok: false, reason: 'too_long' }
  if (/^0+$/.test(value)) return { ok: false, reason: 'invalid' }

  const dial = selfQualified ? inferDialCode(value) : dialCode || inferDialCode(value)

  // When we know the country, the digits left over after the dial code must
  // still be a plausible subscriber number. This is what catches "12345" typed
  // with +254 selected: eight digits long, so it clears the bare length floor,
  // but 254 + 5 digits is not a Kenyan number and never will be.
  if (dial && value.length - dial.length < SUBSCRIBER_MIN) {
    return { ok: false, reason: 'too_short' }
  }

  return { ok: true, msisdn: value, dialCode: dial }
}

/** "+254712345678" — for display and for the bot's logs. */
export function formatE164(msisdn) {
  const value = digitsOnly(msisdn)
  return value ? `+${value}` : ''
}

/**
 * "••••••5678" — never log or echo more of a stranger's number than needed.
 * Keeps the last 4 so support can still confirm they found the right row.
 */
export function maskMsisdn(msisdn) {
  const value = digitsOnly(msisdn)
  if (value.length <= 4) return '•'.repeat(value.length)
  return '•'.repeat(Math.max(0, value.length - 4)) + value.slice(-4)
}

/**
 * The format shown to the user on the page: leading digits, stars, trailing
 * digits. 254741388986 → 254741****86
 *
 * Tiers exist because a fixed "first six" is fine on a 12-digit Kenyan number
 * and far too generous on a short one — revealing 6 of 8 digits would defeat the
 * point. Each tier reveals less as the number gets shorter, and every result
 * always hides at least one digit.
 */
const DISPLAY_MASK_TIERS = [
  { minLength: 11, keepStart: 6, keepEnd: 2 },
  { minLength: 9, keepStart: 4, keepEnd: 2 },
  { minLength: 7, keepStart: 3, keepEnd: 2 },
  { minLength: 0, keepStart: 1, keepEnd: 1 },
]

export function maskForDisplay(msisdn) {
  const value = digitsOnly(msisdn)
  if (!value) return ''
  // Too short for any of this to mean anything — hide the lot.
  if (value.length <= 4) return '*'.repeat(value.length)

  const tier = DISPLAY_MASK_TIERS.find((t) => value.length >= t.minLength)
  const keepStart = Math.min(tier.keepStart, value.length)
  const keepEnd = Math.min(tier.keepEnd, Math.max(0, value.length - keepStart - 1))
  const hidden = Math.max(1, value.length - keepStart - keepEnd)
  const tail = keepEnd > 0 ? value.slice(value.length - keepEnd) : ''

  return value.slice(0, keepStart) + '*'.repeat(hidden) + tail
}

/** Split for pretty display: +254 712345678 → { dial: '254', rest: '712345678' } */
export function splitForDisplay(dialCode, msisdn) {
  const dial = digitsOnly(dialCode)
  const value = digitsOnly(msisdn)
  if (dial && value.startsWith(dial)) {
    return { dial, rest: value.slice(dial.length) }
  }
  return { dial, rest: value }
}

export function describeReason(reason) {
  switch (reason) {
    case 'empty':
      return 'Enter your WhatsApp number to continue.'
    case 'too_short':
      return 'That number looks too short. Include the country code and the full subscriber number.'
    case 'too_long':
      return 'That number looks too long. Check that you have not included a trunk zero as well as the country code.'
    default:
      return 'That does not look like a valid phone number. Check the digits and try again.'
  }
}
