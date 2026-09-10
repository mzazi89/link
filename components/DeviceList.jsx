'use client'

/**
 * The bot's connected numbers, as cards.
 *
 * Structurally quartzxd's device grid, with two deliberate differences:
 *
 *   Numbers are masked. The full number is never sent to the browser — the API
 *   masks them — so there is nothing here to leak.
 *
 *   Removal is not a button on the card. Removing a device requires the password
 *   set when it was linked, and this component does not have the number to send.
 *   The card offers to start a removal, which switches to the removal form.
 */

function formatLastSeen(iso) {
  if (!iso) return 'never'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const s = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return d.toLocaleDateString()
}

function DeviceCard({ device, onRemove }) {
  const { maskedPhone, online, battery, plugged, lastSeen } = device

  return (
    <div className="device">
      <div className="device-top">
        <span className="device-number">{maskedPhone}</span>
        <span className={`badge ${online ? 'online' : 'offline'}`}>
          <span className={`dot ${online ? 'online' : 'offline'}`} />
          {online ? 'Online' : 'Offline'}
        </span>
      </div>

      <div className="metrics">
        <div className="metric">
          <span className="k">Battery</span>
          <span className={`v ${battery == null ? 'dim-v' : 'gold-v'}`}>
            {battery == null ? '—' : `${battery}%`}
          </span>
        </div>
        <div className="metric">
          <span className="k">Charging</span>
          <span className={`v ${plugged == null ? 'dim-v' : plugged ? 'green-v' : ''}`}>
            {plugged == null ? '—' : plugged ? 'Yes' : 'No'}
          </span>
        </div>
        <div className="metric">
          <span className="k">Last seen</span>
          <span className="v muted-v" style={{ fontSize: 12.5 }}>
            {formatLastSeen(lastSeen)}
          </span>
        </div>
      </div>

      <div className="device-footer">
        <span className="last-seen">password set</span>
        <button type="button" className="btn danger small" onClick={() => onRemove()}>
          Remove
        </button>
      </div>
    </div>
  )
}

export default function DeviceList({ devices, loading, error, ip, onRefresh, onRemove }) {
  const count = devices.length

  return (
    <section className="card mt-22">
      <div className="card-title">
        <h2>Connected numbers</h2>
        <span className="mono">
          {ip ? `bot ip ${ip}` : 'bot ip —'} · {count} device{count === 1 ? '' : 's'}
        </span>
      </div>

      {error ? (
        <div className="error-box">
          {error}{' '}
          <button
            type="button"
            onClick={onRefresh}
            style={{
              background: 'none',
              border: 'none',
              color: 'inherit',
              textDecoration: 'underline',
              cursor: 'pointer',
              font: 'inherit',
              padding: 0,
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading && count === 0 ? (
        <div className="empty">
          <span className="spinner" /> Loading devices…
        </div>
      ) : count === 0 ? (
        <div className="empty">
          No numbers are connected yet. Generate a code above to link the first
          one.
        </div>
      ) : (
        <div className="device-grid">
          {devices.map((d) => (
            <DeviceCard key={d.id} device={d} onRemove={onRemove} />
          ))}
        </div>
      )}

      <p className="hint">
        Middle digits are hidden, so a full number is never shown on this page.
        Battery and charging read “—” until the bot reports them.
      </p>
    </section>
  )
}
