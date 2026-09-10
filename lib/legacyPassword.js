import { hashPassword, verifyPassword } from './password'

/**
 * The primary password for numbers that were paired before this site existed.
 *
 * Those sessions have no credential of their own — the user was never asked for
 * one — so without a fallback they would be permanently un-deletable through
 * this page. A shared default is the pragmatic answer.
 *
 * ── What this costs you ──────────────────────────────────────────────────────
 *
 * Understand the trade before relying on it: a shared default is a public
 * master key. Anyone who knows it can delete any session that has no real
 * password. It is not a secret in any meaningful sense once it is written into
 * a repository and used by a no-login page.
 *
 * The mitigation is to close the window: relink a number, set a real password,
 * and it stops accepting the default. To list the numbers still relying on it,
 * compare the bot's session list against device_credentials — the query is in
 * the comment on the operator view in lib/schema.sql. Setting
 * LEGACY_DEFAULT_PASSWORDS to an empty string disables the fallback entirely,
 * which is the correct end state.
 */

const FALLBACK_DEFAULT = '1234,0000'

/** Empty string → fallback disabled. Unset → the defaults below. */
export function legacyPasswords() {
  const raw = process.env.LEGACY_DEFAULT_PASSWORDS
  const source = raw === undefined ? FALLBACK_DEFAULT : raw
  return source
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean)
}

export function legacyFallbackEnabled() {
  return legacyPasswords().length > 0
}

// Hashed once per process rather than compared in the clear, so the check goes
// through the same constant-time path as a real credential and costs the same.
// Cached because hashing on every attempt would add ~55ms per candidate.
let hashesPromise = null

function defaultHashes() {
  if (!hashesPromise) {
    hashesPromise = Promise.all(legacyPasswords().map((p) => hashPassword(p)))
  }
  return hashesPromise
}

/** True if `password` is one of the configured primary passwords. */
export async function verifyLegacyPassword(password) {
  if (!legacyFallbackEnabled()) return false

  let hashes
  try {
    hashes = await defaultHashes()
  } catch (err) {
    console.error('[link][legacy] could not prepare primary password:', err.message)
    return false
  }

  // Every candidate is checked even after a match, so the time taken does not
  // reveal which one hit.
  let matched = false
  for (const hash of hashes) {
    if (await verifyPassword(password, hash)) matched = true
  }
  return matched
}
