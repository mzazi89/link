/**
 * WhatsApp pairing codes.
 *
 * WhatsApp issues an 8-character code and displays it to the user grouped in
 * two blocks of four ("ABCD-EFGH"). Users type it into their phone, and typing
 * it back the way WhatsApp showed it is the least error-prone path — so that
 * grouped form is what we render.
 *
 * We store exactly what the bot reported, and normalize only for display. The
 * code is single-use and rotates, so nothing here should ever be trusted as an
 * identifier for the request — that is what public_id is for.
 */

/** Strip spacing and hyphens, uppercase. */
export function normalizePairingCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

/** "abcdefgh" → "ABCD-EFGH". Non-8-char values pass through normalized. */
export function formatPairingCode(code) {
  const value = normalizePairingCode(code)
  if (!value) return null
  if (value.length === 8) return `${value.slice(0, 4)}-${value.slice(4)}`
  return value
}

/** Cheap sanity check before we show a code to the user. */
export function looksLikePairingCode(code) {
  return normalizePairingCode(code).length === 8
}
