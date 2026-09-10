'use client'

/**
 * Which numbers has THIS browser linked?
 *
 * The page has no login, so there is no server-side notion of "your devices".
 * The only honest answer is local: remember the references this browser created
 * and show those, which keeps one visitor's numbers off another visitor's screen
 * without introducing accounts.
 *
 * Deliberately stores ONLY the opaque public_id and a timestamp. The masked
 * number shown on screen comes back from the server, so a raw phone number never
 * lands in localStorage — worth caring about on a shared or borrowed device, and
 * it means clearing site data loses nothing but the list itself.
 */

const KEY = 'mzazi.link.devices.v1'

function available() {
  try {
    return typeof window !== 'undefined' && Boolean(window.localStorage)
  } catch {
    // Safari in private mode, or storage disabled by policy.
    return false
  }
}

/** @returns {Array<{publicId: string, addedAt: number}>} newest first */
export function loadDevices() {
  if (!available()) return []
  try {
    const raw = window.localStorage.getItem(KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((d) => d && typeof d.publicId === 'string' && d.publicId.length >= 16)
      .map((d) => ({ publicId: d.publicId, addedAt: Number(d.addedAt) || 0 }))
      .sort((a, b) => b.addedAt - a.addedAt)
  } catch {
    // Corrupt entry — start clean rather than throwing on every page load.
    return []
  }
}

function save(devices) {
  if (!available()) return
  try {
    window.localStorage.setItem(
      KEY,
      JSON.stringify(devices.slice(0, 50).map((d) => ({ publicId: d.publicId, addedAt: d.addedAt })))
    )
  } catch {
    // Quota or private mode. The list is a convenience, never load-bearing.
  }
}

/** Remember a reference. Idempotent — re-linking the same request must not duplicate it. */
export function addDevice(publicId) {
  if (!publicId) return
  const existing = loadDevices()
  if (existing.some((d) => d.publicId === publicId)) return
  save([{ publicId, addedAt: Date.now() }, ...existing])
}

export function forgetDevice(publicId) {
  save(loadDevices().filter((d) => d.publicId !== publicId))
}

/**
 * Drop everything not in `keep`.
 *
 * Used after a status refresh to sweep out references that never linked or whose
 * device has since been removed, so the list does not accumulate dead entries
 * forever.
 */
export function pruneDevices(keep) {
  const keepSet = new Set(keep)
  const next = loadDevices().filter((d) => keepSet.has(d.publicId))
  save(next)
  return next
}

export function clearDevices() {
  if (!available()) return
  try {
    window.localStorage.removeItem(KEY)
  } catch {
    // Nothing useful to do.
  }
}
