'use client'

/**
 * The numbers the bot is currently connected to.
 *
 * Every value here is masked by the server (`maskForDisplay`), so this component
 * never holds or renders a full phone number — it only lays out what it is
 * given.
 */
export default function DeviceList({ devices, loading, error, onRefresh }) {
  const count = devices.length

  return (
    // Sits inside the Linker card, separated by a hairline rather than given its
    // own border — one panel, two regions.
    <section className="border-t hairline" aria-labelledby="connected-heading">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 hairline">
        <span className="label" id="connected-heading">
          Connected numbers
        </span>
        <div className="flex items-center gap-3">
          <span className="label">
            {loading ? 'Checking' : `${count} ${count === 1 ? 'number' : 'numbers'}`}
          </span>
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="font-mono text-[10px] uppercase tracking-label text-paper-faint hover:text-amber disabled:opacity-40"
          >
            Refresh
          </button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <p className="text-[12.5px] leading-relaxed text-paper-muted">{error}</p>
          <button type="button" onClick={onRefresh} className="btn-ghost shrink-0">
            Retry
          </button>
        </div>
      ) : null}

      {!error && count > 0 ? (
        <ul>
          {devices.map((device) => (
            <li
              key={device.id}
              className="flex items-center justify-between gap-4 border-b px-5 py-3.5 last:border-b-0 hairline"
            >
              <p className="truncate font-mono text-[14px] tracking-wide text-paper">
                {device.maskedPhone}
              </p>
              <span className="flex shrink-0 items-center gap-2">
                <span
                  className="h-1.5 w-1.5 rounded-full bg-amber"
                  aria-hidden="true"
                />
                <span className="font-mono text-[10px] uppercase tracking-label text-paper-faint">
                  Live
                </span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {!error && !loading && count === 0 ? (
        <p className="px-5 py-4 text-[12.5px] leading-relaxed text-paper-muted">
          No numbers are connected to the bot right now.
        </p>
      ) : null}

      <div className="border-t px-5 py-3 hairline">
        <p className="text-[11.5px] leading-relaxed text-paper-faint">
          Numbers currently paired with the bot, with the middle digits hidden.
          Removing one requires the password set when it was linked.
        </p>
      </div>
    </section>
  )
}
