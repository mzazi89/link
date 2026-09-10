'use client'

import { useCallback, useEffect, useState } from 'react'

import DeviceList from '@/components/DeviceList'
import { COUNTRIES, DEFAULT_COUNTRY_ISO } from '@/lib/countries'

/**
 * The whole device flow lives here: linking and removing.
 *
 * Phases:
 *   input / submitting → number (and password) entry
 *   waiting            → job queued, the bot is working on it
 *   ready              → pairing code on screen, user types it into WhatsApp
 *   linked             → bot confirmed the device connected   (link)
 *   completed          → bot wiped the session                (remove)
 *   expired / error / blocked → recoverable dead ends
 */

const POLL_WAITING_MS = 2000
// Once the code is on screen we are only watching for the device to connect,
// so we can back right off and stop hammering the endpoint.
const POLL_READY_MS = 4000

const MIN_PASSWORD_LENGTH = 8

const CHIP = {
  input: { text: 'Idle', tone: 'neutral' },
  submitting: { text: 'Sending', tone: 'active' },
  waiting: { text: 'Working', tone: 'active' },
  ready: { text: 'Action needed', tone: 'active' },
  linked: { text: 'Linked', tone: 'good' },
  completed: { text: 'Removed', tone: 'good' },
  expired: { text: 'Expired', tone: 'bad' },
  error: { text: 'Failed', tone: 'bad' },
  blocked: { text: 'Throttled', tone: 'bad' },
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

function StatusChip({ phase }) {
  const chip = CHIP[phase] || CHIP.input
  const toneClass =
    chip.tone === 'active' || chip.tone === 'good'
      ? 'text-amber border-amber/40'
      : chip.tone === 'bad'
        ? 'text-rust border-rust/40'
        : 'text-paper-faint border-[color:var(--hairline-strong)]'

  const dotClass =
    chip.tone === 'active'
      ? 'bg-amber animate-pulse-soft'
      : chip.tone === 'good'
        ? 'bg-amber'
        : chip.tone === 'bad'
          ? 'bg-rust'
          : 'bg-paper-faint'

  return (
    <span
      className={`inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-label ${toneClass}`}
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotClass}`} aria-hidden="true" />
      {chip.text}
    </span>
  )
}

/** A dot + connector used down the left edge of the progress list. */
function Step({ n, title, detail, state }) {
  const done = state === 'done'
  const active = state === 'active'

  return (
    <li className="grid grid-cols-[1.75rem_1fr] gap-x-3">
      <div className="flex flex-col items-center">
        {done ? (
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className="mt-0.5">
            <circle cx="7" cy="7" r="6.5" fill="#DFA457" />
            <path
              d="M4 7.2 L6.1 9.3 L10 5.2"
              fill="none"
              stroke="#0D0C0B"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          <span
            className={`mt-1 h-2.5 w-2.5 rounded-full border ${
              active
                ? 'border-amber bg-amber animate-pulse-soft'
                : 'border-[color:var(--hairline-strong)] bg-transparent'
            }`}
            aria-hidden="true"
          />
        )}
      </div>
      <div className="pb-5">
        <p
          className={`font-mono text-[10px] uppercase tracking-label ${
            done || active ? 'text-paper' : 'text-paper-faint'
          }`}
        >
          {n} — {title}
        </p>
        {detail ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-paper-muted">{detail}</p>
        ) : null}
      </div>
    </li>
  )
}

function PasswordField({ id, label, value, onChange, disabled, autoComplete, help }) {
  const [show, setShow] = useState(false)
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <label htmlFor={id} className="label">
          {label}
        </label>
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="font-mono text-[10px] uppercase tracking-label text-paper-faint hover:text-amber"
          aria-pressed={show}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      <input
        id={id}
        name={id}
        type={show ? 'text' : 'password'}
        className="field mt-2"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        autoComplete={autoComplete}
        spellCheck={false}
        autoCapitalize="off"
        aria-describedby={help ? `${id}-help` : undefined}
      />
      {help ? (
        <p id={`${id}-help`} className="mt-2 text-[12px] leading-relaxed text-paper-faint">
          {help}
        </p>
      ) : null}
    </div>
  )
}

/** Live requirement list — cheaper for the user than a rejection after submit. */
function PasswordRules({ password }) {
  const rules = [
    { label: `${MIN_PASSWORD_LENGTH}+ characters`, met: password.length >= MIN_PASSWORD_LENGTH },
    { label: 'A letter', met: /[A-Za-z]/.test(password) },
    { label: 'A number', met: /[0-9]/.test(password) },
  ]
  return (
    <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5">
      {rules.map((r) => (
        <li
          key={r.label}
          className={`font-mono text-[10px] uppercase tracking-label ${
            r.met ? 'text-amber' : 'text-paper-faint'
          }`}
        >
          {r.met ? '•' : '·'} {r.label}
        </li>
      ))}
    </ul>
  )
}

export default function Linker() {
  const [mode, setMode] = useState('link')
  const [phase, setPhase] = useState('input')
  const [countryIso, setCountryIso] = useState(DEFAULT_COUNTRY_ISO)
  const [national, setNational] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const [request, setRequest] = useState(null)
  const [botStatus, setBotStatus] = useState(null)
  const [code, setCode] = useState(null)
  const [error, setError] = useState(null)
  const [copyState, setCopyState] = useState('idle')

  // Drives the countdown. Ticking locally avoids a poll per second.
  const [now, setNow] = useState(() => Date.now())

  // The numbers this browser has linked, resolved through the server so the
  // masked form and the connected state both come from the truth rather than
  // from anything this component remembers.
  const [devices, setDevices] = useState([])
  const [devicesLoading, setDevicesLoading] = useState(true)
  const [devicesError, setDevicesError] = useState(null)

  const country = COUNTRIES.find((c) => c.iso === countryIso) ?? COUNTRIES[0]
  const publicId = request?.publicId || null
  const busy = phase === 'submitting'
  const isRemove = mode === 'remove'
  const action = request?.action || mode

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  const secondsLeft = request?.expiresAt
    ? Math.ceil((new Date(request.expiresAt).getTime() - now) / 1000)
    : null

  // A queued request whose window closed should not leave the user watching a
  // spinner. The API closes unclaimed rows out too; this is just the UI keeping
  // pace so the clock and the message never disagree.
  useEffect(() => {
    if (phase === 'waiting' && secondsLeft !== null && secondsLeft <= 0) {
      setPhase('expired')
    }
  }, [phase, secondsLeft])

  const reset = useCallback((nextMode) => {
    setMode(nextMode ?? mode)
    setPhase('input')
    setRequest(null)
    setBotStatus(null)
    setCode(null)
    setError(null)
    setCopyState('idle')
    setNational('')
    setPassword('')
    setConfirm('')
    setAcknowledged(false)
  }, [mode])

  // ── Connected numbers ─────────────────────────────────────────────────────
  // A plain read of what the bot has published. The list is global — every
  // number the bot holds a session for — and every value comes back already
  // masked, so full numbers never reach the browser.
  const refreshDevices = useCallback(async () => {
    setDevicesLoading(true)
    try {
      const res = await fetch('/api/connected', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'unavailable')

      setDevices(data.devices)
      setDevicesError(null)
    } catch {
      setDevicesError('Could not load connected numbers.')
    } finally {
      setDevicesLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshDevices()
  }, [refreshDevices])

  // The bot re-scans its session folders on an interval, so the published list
  // lags the moment a link or removal completes by up to one scan. Re-reading
  // here means the user sees it as soon as the next scan has landed.
  useEffect(() => {
    if (phase === 'linked' || phase === 'completed') refreshDevices()
  }, [phase, refreshDevices])

  // ── Polling ───────────────────────────────────────────────────────────────
  // Stays alive through 'ready' as well, because the transition we actually care
  // about — the bot seeing the device connect — happens after the code is shown.
  useEffect(() => {
    const shouldPoll = (phase === 'waiting' || phase === 'ready') && publicId
    if (!shouldPoll) return

    let cancelled = false
    let timer = null

    const poll = async () => {
      try {
        const res = await fetch(`/api/requests/${encodeURIComponent(publicId)}`, {
          cache: 'no-store',
        })
        const data = await res.json().catch(() => null)
        if (cancelled || !data?.ok) return

        setBotStatus(data.status)

        switch (data.status) {
          case 'ready':
            if (data.pairingCode) setCode(data.pairingCode)
            setPhase('ready')
            break
          case 'linked':
            if (data.pairingCode) setCode(data.pairingCode)
            setPhase('linked')
            break
          case 'completed':
            setPhase('completed')
            break
          case 'failed':
            setError({ message: data.message || 'The request could not be completed.' })
            setPhase('error')
            break
          case 'expired':
            setPhase('expired')
            break
          default:
            // Still pending or processing — nothing to do but wait.
            break
        }
      } catch {
        // Mobile networks drop requests constantly. The next tick retries; a
        // transient failure is not worth interrupting the user over.
      }
    }

    poll()
    timer = setInterval(poll, phase === 'ready' ? POLL_READY_MS : POLL_WAITING_MS)

    return () => {
      cancelled = true
      if (timer) clearInterval(timer)
    }
  }, [phase, publicId])

  // ── Submit ────────────────────────────────────────────────────────────────
  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault()
      if (busy) return

      // Confirm locally before spending a request. The server never sees the
      // confirmation field — it exists purely so a typo cannot silently lock
      // someone out of their own device.
      if (!isRemove && password !== confirm) {
        setError({ message: 'The two passwords do not match.' })
        setPhase('error')
        return
      }

      setError(null)
      setCode(null)
      setCopyState('idle')
      setBotStatus(null)
      setPhase('submitting')

      const endpoint = isRemove ? '/api/unlink' : '/api/link'
      const body = isRemove
        ? { dialCode: country.dial, national, password }
        : { dialCode: country.dial, national, password }

      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        const data = await res.json().catch(() => null)

        if (!res.ok || !data?.ok) {
          setError({
            message: data?.message || 'Something went wrong. Please try again.',
            retryAfterSeconds: data?.retryAfterSeconds ?? null,
          })
          setPhase(res.status === 429 ? 'blocked' : 'error')
          return
        }

        setRequest(data)
        setBotStatus(data.status)
        setNow(Date.now())
        setPhase('waiting')
      } catch {
        setError({
          message: 'Could not reach the server. Check your connection and try again.',
        })
        setPhase('error')
      }
    },
    [busy, confirm, country.dial, isRemove, national, password]
  )

  const copyCode = useCallback(async () => {
    if (!code) return
    // Copy the bare 8 characters: WhatsApp's field takes the code itself, not
    // the hyphenated grouping it prints on screen.
    const value = code.replace(/[^A-Za-z0-9]/g, '')
    try {
      await navigator.clipboard.writeText(value)
      setCopyState('copied')
    } catch {
      setCopyState('failed')
    }
  }, [code])

  useEffect(() => {
    if (copyState !== 'copied') return
    const id = setTimeout(() => setCopyState('idle'), 2200)
    return () => clearTimeout(id)
  }, [copyState])

  // ── Render ────────────────────────────────────────────────────────────────
  const showForm = phase === 'input' || phase === 'submitting'
  const canSubmit = isRemove
    ? Boolean(national.trim() && password) && acknowledged && !busy
    : Boolean(national.trim() && password && confirm) && !busy

  return (
    <div className="border bg-ink-900/60 hairline">
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 hairline">
        <span className="label">{isRemove ? 'Removal' : 'Pairing'}</span>
        <StatusChip phase={phase} />
      </div>

      {/* Mode switcher. Locked while a job is in flight so a half-finished
          request can never be orphaned in the UI. */}
      <div
        className="grid grid-cols-2 border-b hairline"
        role="tablist"
        aria-label="Device action"
      >
        {[
          { id: 'link', label: 'Link a device' },
          { id: 'remove', label: 'Remove a device' },
        ].map((tab) => {
          const selected = mode === tab.id
          const locked = !showForm
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={selected}
              disabled={locked}
              onClick={() => reset(tab.id)}
              className={`px-4 py-3 font-mono text-[11px] uppercase tracking-label transition-colors ${
                selected ? 'text-amber' : 'text-paper-faint hover:text-paper'
              } ${locked ? 'cursor-not-allowed opacity-50' : ''} ${
                tab.id === 'link' ? 'border-r hairline' : ''
              }`}
            >
              {tab.label}
            </button>
          )
        })}
      </div>

      {/* Announce status transitions to assistive tech without stealing focus. */}
      <div aria-live="polite" className="p-5 sm:p-7">
        {showForm ? (
          <form onSubmit={onSubmit} className="animate-rise">
            <div className="grid gap-3 sm:grid-cols-[1.15fr_1fr]">
              <div>
                <label htmlFor="country" className="label">
                  Country
                </label>
                <select
                  id="country"
                  name="country"
                  className="field mt-2 cursor-pointer"
                  value={countryIso}
                  onChange={(e) => setCountryIso(e.target.value)}
                  disabled={busy}
                >
                  {COUNTRIES.map((c) => (
                    <option key={c.iso} value={c.iso}>
                      {c.name} (+{c.dial})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label htmlFor="phone" className="label">
                  WhatsApp number
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  inputMode="numeric"
                  autoComplete="tel"
                  autoFocus
                  placeholder="712 345 678"
                  className="field mt-2"
                  value={national}
                  onChange={(e) => setNational(e.target.value)}
                  disabled={busy}
                  aria-describedby="phone-help"
                />
              </div>
            </div>

            <p id="phone-help" className="mt-2.5 text-[12px] leading-relaxed text-paper-faint">
              {isRemove
                ? 'The number you linked to the bot. A leading zero is fine — we drop it for you.'
                : 'Enter the number as it appears on that phone. A leading zero is fine — we drop it and use the country code for you.'}
            </p>

            <div className="mt-6">
              <PasswordField
                id="password"
                label={isRemove ? 'Your password' : 'Set a password'}
                value={password}
                onChange={setPassword}
                disabled={busy}
                autoComplete={isRemove ? 'current-password' : 'new-password'}
                help={
                  isRemove
                    ? 'The password you chose when you linked this device. It is the only way to authorise removal.'
                    : undefined
                }
              />
              {!isRemove ? <PasswordRules password={password} /> : null}
            </div>

            {!isRemove ? (
              <>
                <div className="mt-5">
                  <PasswordField
                    id="confirm"
                    label="Confirm password"
                    value={confirm}
                    onChange={setConfirm}
                    disabled={busy}
                    autoComplete="new-password"
                  />
                </div>

                <p className="mt-5 border-l-2 border-amber pl-3 text-[12.5px] leading-relaxed text-paper-muted">
                  Write this password down. Removing this device later will ask for
                  it, and there is no reset link — we have no account to email one
                  to. If you lose it you can still set a new one by linking the
                  number again from the phone itself.
                </p>
              </>
            ) : (
              <label className="mt-5 flex cursor-pointer items-start gap-3 border-l-2 border-rust pl-3">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  disabled={busy}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[#C9603F]"
                />
                <span className="text-[12.5px] leading-relaxed text-paper-muted">
                  I understand this disconnects the bot from this number and removes
                  its saved session.
                </span>
              </label>
            )}

            {error ? (
              <p className="mt-5 border-l-2 border-rust pl-3 text-[13px] leading-relaxed text-paper-muted">
                {error.message}
              </p>
            ) : null}

            <button type="submit" className="btn-primary mt-6" disabled={!canSubmit}>
              {busy
                ? isRemove
                  ? 'Authorising'
                  : 'Requesting code'
                : isRemove
                  ? 'Remove device'
                  : 'Link device'}
            </button>

            {isRemove && !password ? (
              <p className="mt-3 text-[12px] leading-relaxed text-paper-faint">
                Enter the password you set when you linked this number to continue.
              </p>
            ) : null}
          </form>
        ) : null}

        {phase === 'waiting' ? (
          <div className="animate-rise">
            <p className="label-amber">In progress</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              {action === 'delete' ? 'Removing the device' : 'Preparing your pairing code'}
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              {action === 'delete' ? (
                <>
                  Authorised. The bot is disconnecting{' '}
                  <span className="font-mono text-[13px] text-paper">{request?.phone}</span> now.
                </>
              ) : (
                <>
                  Keep this page open. WhatsApp is issuing a code for{' '}
                  <span className="font-mono text-[13px] text-paper">{request?.phone}</span>.
                </>
              )}
            </p>

            <ol className="mt-7">
              <Step
                n="01"
                title="Request received"
                detail="Your authorisation is queued and waiting for the bot."
                state="done"
              />
              <Step
                n="02"
                title={action === 'delete' ? 'Removing the device' : 'Generating pairing code'}
                detail={
                  botStatus === 'processing'
                    ? action === 'delete'
                      ? 'The bot has your request and is disconnecting the device.'
                      : 'The bot has your request and is asking WhatsApp for a code.'
                    : 'Waiting for the bot to pick up your request.'
                }
                state={botStatus === 'processing' ? 'active' : 'todo'}
              />
              <Step
                n="03"
                title={action === 'delete' ? 'Finished' : 'Enter the code on WhatsApp'}
                detail={action === 'delete' ? 'This page updates when it is done.' : 'The code will appear here.'}
                state="todo"
              />
            </ol>

            <div className="flex items-center justify-between border-t pt-4 hairline">
              <span className="label">Expires in</span>
              <span className="font-mono text-[12px] text-paper-muted">
                {formatDuration(secondsLeft)}
              </span>
            </div>

            <button type="button" onClick={() => reset()} className="btn-ghost mt-4 w-full">
              Cancel
            </button>
          </div>
        ) : null}

        {phase === 'ready' ? (
          <div className="animate-rise">
            <p className="label-amber">Code ready</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Enter this code in WhatsApp
            </h2>

            <div
              className="mt-5 border bg-ink-850 px-4 py-7 text-center"
              style={{ borderColor: 'var(--hairline-strong)' }}
            >
              <div className="font-mono text-[32px] leading-none tracking-[0.2em] text-amber sm:text-[40px]">
                {code || '—'}
              </div>
            </div>

            <button type="button" onClick={copyCode} className="btn-ghost mt-3 w-full">
              {copyState === 'copied'
                ? 'Copied to clipboard'
                : copyState === 'failed'
                  ? 'Select the code above'
                  : 'Copy code'}
            </button>

            <ol className="mt-8 space-y-4">
              {[
                [
                  '01',
                  `Open WhatsApp on ${request?.phone || 'that phone'}`,
                  'Use the device that owns the number, not a different one.',
                ],
                [
                  '02',
                  'Go to Linked devices',
                  'iPhone: Settings → Linked devices. Android: the menu (three dots) → Linked devices.',
                ],
                [
                  '03',
                  'Tap "Link a device", then "Link with phone number instead"',
                  'That is what surfaces the field for this code.',
                ],
                ['04', 'Type the code shown above', 'Exactly as it appears, including every character.'],
              ].map(([n, title, detail]) => (
                <li key={n} className="grid grid-cols-[1.75rem_1fr] gap-x-3">
                  <span className="index-num pt-0.5">{n}</span>
                  <div>
                    <p className="text-[13.5px] font-medium leading-snug text-paper">{title}</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-paper-faint">{detail}</p>
                  </div>
                </li>
              ))}
            </ol>

            <div className="mt-7 flex items-center justify-between border-t pt-4 hairline">
              <span className="label">
                {secondsLeft > 0 ? 'Code expires in' : 'Code may have expired'}
              </span>
              <span className="font-mono text-[12px] text-paper-muted">
                {formatDuration(secondsLeft)}
              </span>
            </div>

            <p className="mt-3 text-[12px] leading-relaxed text-paper-faint">
              This page confirms automatically once WhatsApp connects the device.
              Your password takes effect at that moment.
            </p>

            <button type="button" onClick={() => reset()} className="btn-ghost mt-4 w-full">
              Start over
            </button>
          </div>
        ) : null}

        {phase === 'linked' ? (
          <div className="animate-rise">
            <p className="label-amber">Linked</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Your device is connected
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              <span className="font-mono text-[13px] text-paper">{request?.phone}</span> is now
              linked to the bot, and the password you chose now authorises its
              removal. You can close this page — the connection keeps running.
            </p>
            <p className="mt-4 text-[12.5px] leading-relaxed text-paper-faint">
              To disconnect later, come back to this page and use Remove a device.
            </p>
            <button type="button" onClick={() => reset()} className="btn-ghost mt-6 w-full">
              Link another number
            </button>
          </div>
        ) : null}

        {phase === 'completed' ? (
          <div className="animate-rise">
            <p className="label-amber">Removed</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Device disconnected
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              The bot has disconnected from{' '}
              <span className="font-mono text-[13px] text-paper">{request?.phone}</span> and
              removed its saved session.
            </p>
            <p className="mt-4 text-[12.5px] leading-relaxed text-paper-faint">
              If the device still appears in WhatsApp under Linked devices, remove
              it there as well — that list is WhatsApp's, not ours.
            </p>
            <button type="button" onClick={() => reset()} className="btn-ghost mt-6 w-full">
              Done
            </button>
          </div>
        ) : null}

        {phase === 'expired' ? (
          <div className="animate-rise">
            <p className="label text-rust">Expired</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              {action === 'delete' ? 'That request timed out' : 'That code timed out'}
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              {action === 'delete'
                ? 'The bot did not pick up the removal in time, so nothing was changed. You can authorise it again.'
                : 'Nothing was linked. Codes only stay valid for a few minutes, and the bot may not have reached your number in time.'}
            </p>
            <button type="button" onClick={() => reset()} className="btn-primary mt-6">
              Try again
            </button>
          </div>
        ) : null}

        {phase === 'blocked' ? (
          <div className="animate-rise">
            <p className="label text-rust">Too many attempts</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Slow down for a moment
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              {error?.message || 'Please wait a little before trying again.'}
            </p>
            <button type="button" onClick={() => reset()} className="btn-ghost mt-6 w-full">
              Back
            </button>
          </div>
        ) : null}

        {phase === 'error' ? (
          <div className="animate-rise">
            <p className="label text-rust">Not completed</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              We could not finish that
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              {error?.message || 'Something went wrong. Please try again.'}
            </p>
            <button type="button" onClick={() => reset()} className="btn-primary mt-6">
              Try again
            </button>
          </div>
        ) : null}
      </div>

      <DeviceList
        devices={devices}
        loading={devicesLoading}
        error={devicesError}
        onRefresh={refreshDevices}
      />
    </div>
  )
}
