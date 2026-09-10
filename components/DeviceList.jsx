'use client'

/**
 * The bot's connected numbers, as cards.
 *
 * Numbers arrive already masked from the API — the full number is never sent to
 * the browser, so there is nothing here to leak.
 *
 * Removal is not a button on the card. Removing a device requires the password
 * set when it was linked, and this component does not have the number to send, so
 * the card offers to start a removal and switches to the removal form.
 */

/** Relative time, or null when there is nothing to show. */
function formatLastSeen(iso) {
  if (!iso) return null
  const then = new Date(iso)
  if (Number.isNaN(then.getTime())) return null

  const seconds = Math.max(0, Math.floor((Date.now() - then.getTime()) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function DeviceCard({ device, onRemove, showBot }) {
  const { maskedPhone, botName, online, battery, plugged, lastSeen } = device

  // Only the telemetry that exists. The current Baileys build does not report
  // battery or charging, and a row of three metrics where two read "—" makes the
  // card look broken rather than brief. As soon as the bot starts reporting them
  // they appear on their own.
  const stats = []
  if (battery != null) stats.push(['Battery', `${battery}%`])
  if (plugged != null) stats.push(['Charging', plugged ? 'Yes' : 'No'])
  const seen = formatLastSeen(lastSeen)
  if (seen) stats.push(['Seen', seen])

  return (
    <div className="device">
      <div className="device-top">
        <span className="device-number">{maskedPhone}</span>
        <span className={`badge ${online ? 'online' : 'offline'}`}>
          <span className={`dot ${online ? 'online' : 'offline'}`} />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>

      {/* Which bot holds this number. Only worth a row when there is more than
          one to tell apart. */}
      {showBot && botName ? (
        <div className="device-bot">
          <span className="k">Bot</span>
          <span className="v">{botName}</span>
        </div>
      ) : null}

      {stats.length > 0 ? (
        <div className={`metrics cols-${Math.min(stats.length, 3)}`}>
          {stats.map(([key, value]) => (
            <div className="metric" key={key}>
              <span className="k">{key}</span>
              <span className="v">{value}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div className="device-footer">
        <button type="button" className="btn danger small" onClick={() => onRemove()}>
          Remove
        </button>
      </div>
    </div>
  )
}

export default function DeviceList({
  devices,
  loading,
  error,
  bots = [],
  bot,
  onBotChange,
  onRefresh,
  onRemove,
}) {
  const count = devices.length
  const multipleBots = bots.length > 1

  return (
    <section className="card">
      <div className="card-title">
        <h2>Connected</h2>
        <span className="mono">
          {count} device{count === 1 ? '' : 's'}
        </span>
      </div>

      {/* Same choice as the pairing form, over the list instead. "All bots" is
          the default so the view is complete rather than showing whichever bot
          happened to write its heartbeat last. */}
      {multipleBots ? (
        <div className="mode-switch bot-switch" role="tablist" aria-label="Filter by bot">
          <button
            type="button"
            role="tab"
            className="mode-tab"
            aria-selected={!bot}
            onClick={() => onBotChange(null)}
          >
            All bots
          </button>
          {bots.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              className="mode-tab"
              aria-selected={bot === b.id}
              onClick={() => onBotChange(b.id)}
            >
              {b.name}
              <span
                className={`dot ${b.online ? 'online' : 'offline'}`}
                style={{ marginLeft: 8 }}
              />
            </button>
          ))}
        </div>
      ) : null}

      {error ? (
        <div>
          <div className="error-box">{error}</div>
          <div className="btn-row">
            <button type="button" className="btn small" onClick={onRefresh}>
              Retry
            </button>
          </div>
        </div>
      ) : loading && count === 0 ? (
        <div className="empty">
          <span className="spinner" /> Loading…
        </div>
      ) : count === 0 ? (
        <div className="empty">No numbers connected yet.</div>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              showBot={multipleBots}
              onRemove={() => onRemove(device)}
            />
          ))}
        </div>
      )}

      <p className="hint">Middle digits are hidden.</p>
    </section>
  )
}
