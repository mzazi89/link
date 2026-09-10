'use client'

/**
 * The numbers this browser has linked, shown masked.
 *
 * Numbers are masked by the server (see maskForDisplay), so nothing here ever
 * holds or renders a full phone number. This component is presentational — it
 * receives already-masked values.
 */
export default function DeviceList({ devices, loading, error, onRemove, onRefresh }) {
  // Nothing linked yet: stay out of the way rather than showing an empty shell.
  if (!loading && !error && devices.length === 0) return null

  const connected = devices.filter((d) => d.connected).length

  return (
    // Sits inside the Linker card, separated by a hairline rather than given its
    // own border — one panel, two regions.
    <section className="border-t hairline" aria-labelledby="connected-heading">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 hairline">
        <span className="label" id="connected-heading">
          Your numbers
        </span>
        <span className="label">
          {loading ? 'Checking' : `${connected} connected`}
        </span>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <p className="text-[12.5px] leading-relaxed text-paper-muted">{error}</p>
          <button type="button" onClick={onRefresh} className="btn-ghost shrink-0">
            Retry
          </button>
        </div>
      ) : null}

      {!error && devices.length > 0 ? (
        <ul>
          {devices.map((device) => (
            <li
              key={device.publicId}
              className="flex items-center justify-between gap-4 border-b px-5 py-4 last:border-b-0 hairline"
            >
              <div className="min-w-0">
                <p
                  className={`truncate font-mono text-[14px] tracking-wide ${
                    device.connected ? 'text-paper' : 'text-paper-faint'
                  }`}
                >
                  {device.maskedPhone || '—'}
                </p>
                <p className="mt-1 font-mono text-[10px] uppercase tracking-label text-paper-faint">
                  {device.connected ? 'Connected' : 'Not connected'}
                </p>
              </div>

              {device.connected ? (
                <button
                  type="button"
                  onClick={() => onRemove(device.publicId)}
                  className="btn-ghost shrink-0"
                >
                  Remove
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="border-t px-5 py-3 hairline">
        <p className="text-[11.5px] leading-relaxed text-paper-faint">
          Only the numbers linked from this browser are listed, and they are shown
          with the middle digits hidden. Another browser, or another person, sees
          nothing here.
        </p>
      </div>
    </section>
  )
}
