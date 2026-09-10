import { createHash } from 'node:crypto'

/**
 * A stable opaque key for a phone number.
 *
 * Two jobs, both of which need the same value computed the same way in two
 * different routes:
 *
 *  1. A React list key. Two different numbers can mask to the SAME string — the
 *     hidden digits are exactly the ones that differ, so 254741999986 and
 *     254741888886 both render as 254741****86. The masked form therefore cannot
 *     identify a row.
 *  2. Telling the page "the number you just paired is now connected". The status
 *     route and the device list each compute this key independently, and the
 *     page matches them up — without either of them ever holding the number.
 *
 * The salt is a fixed constant rather than a secret, deliberately: this is not a
 * privacy control. A masked number sits beside it in the same response, so
 * reversing it would reveal nothing that was not already printed. Anyone reading
 * this file should not mistake it for one.
 */
export function deviceKey(msisdn) {
  return createHash('sha256')
    .update(`mzazi.link.device:${String(msisdn || '')}`)
    .digest('hex')
    .slice(0, 12)
}
