'use client'

import { useCallback, useEffect, useState } from 'react'

import { COUNTRIES, DEFAULT_COUNTRY_ISO } from '@/lib/countries'

/**
 * Both halves of the device flow: linking a number and removing one.
 *
 * Requests now go into `bot_control`, the table quartz already consumes, so the
 * page is waiting on the bot's own poll — quartzxd documents that as roughly 15
 * seconds. `queued` for a long time therefore means the bot is not running,
 * which is worth saying rather than leaving someone to guess.
 */

const POLL_MS = 2000

// How long a request may sit untouched before we say so. Comfortably longer than
// the bot's ~15s poll, so this does not cry wolf on a healthy system.
const STALLED_AFTER_S = 25

const COPY = {
  link: {
    endpoint: '/api/link',
    submit: 'Generate code',
    submitBusy: 'Requesting…',
    title: 'Generate pairing code',
    route: 'POST /api/link',
    hint:
      'Open WhatsApp → Linked devices → Link a device, then choose "Link with phone number instead" and type the code.',
  },
  remove: {
    endpoint: '/api/unlink',
    submit: 'Remove device',
    submitBusy: 'Removing…',
    title: 'Remove a device',
    route: 'POST /api/unlink',
    hint:
      'This logs the device out of WhatsApp and wipes its session on the bot. Enter the password you set when you linked it.',
  },
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function PasswordField({ id, label, value, onChange, disabled, autoComplete, help }) {
  const [show, setShow] = useState(false)
  return (
    <div className="field-block">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <label className="field-label" htmlFor={id} style={{ marginBottom: 0 }}>
          {label}
        </label>
        <button
          type="button"
          className="pw-toggle"
          style={{ position: 'static', transform: 'none' }}
          onClick={() => setShow((s) => !s)}
          aria-pressed={show}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
      <div className="pw-wrap" style={{ marginTop: 7 }}>
        <input
          id={id}
          className="field"
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete={autoComplete}
          spellCheck={false}
          style={{ paddingRight: 16 }}
        />
      </div>
      {help ? (
        <p className="hint" style={{ marginTop: 7 }}>
          {help}
        </p>
      ) : null}
    </div>
  )
}

export default function Linker({ mode, onModeChange, botOnline, onChanged }) {
  const copy = COPY[mode]

  const [countryIso, setCountryIso] = useState(DEFAULT_COUNTRY_ISO)
  const [national, setNational] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)

  const [phase, setPhase] = useState('input')
  const [request, setRequest] = useState(null)
  const [backendStatus, setBackendStatus] = useState(null)
  const [code, setCode] = useState(null)
  const [error, setError] = useState(null)
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  const country = COUNTRIES.find((c) => c.iso === countryIso) ?? COUNTRIES[0]
  const busy = phase === 'submitting'
  const inFlight = phase === 'submitting' || phase === 'waiting' || phase === 'ready'
  const polling = phase === 'waiting' || phase === 'ready'

  // Clock for the countdown. Local tick, so no request per second.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  const reset = useCallback(
    (nextMode) => {
      onModeChange(nextMode ?? mode)
      setPhase('input')
      setRequest(null)
      setBackendStatus(null)
      setCode(null)
      setError(null)
      setCopied(false)
      setNational('')
      setPassword('')
      setConfirm('')
      setAcknowledged(false)
    },
    [mode, onModeChange]
  )

  const refresh = useCallback(() => {
    if (typeof onChanged === 'function') onChanged()
  }, [onChanged])

  // Poll the request. Kept running past `ready` so the transition to `linked`
  // is caught, and stopped on any terminal state.
  useEffect(() => {
    if (!polling || !request?.requestId) return undefined

    let cancelled = false

    const tick = async () => {
      try {
        const res = await fetch(`/api/requests/${request.requestId}`, { cache: 'no-store' })
        const data = await res.json().catch(() => null)
        if (cancelled || !data?.ok) return

        setBackendStatus(data.status)

        if (data.status === 'ready') {
          setCode(data.code)
          setPhase('ready')
        } else if (data.status === 'linked') {
          setPhase('linked')
          refresh()
        } else if (data.status === 'removed') {
          setPhase('removed')
          refresh()
        } else if (data.status === 'failed') {
          setError({ message: data.message || 'The bot could not complete that request.' })
          setPhase('error')
        }
        // queued | working | done → still in progress, keep polling
      } catch {
        // Transient; the next tick retries.
      }
    }

    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [polling, request?.requestId, refresh])

  // Auto-expire the display once the code's guidance window has passed. Nothing
  // server-side expires: WhatsApp rotates codes on its own schedule.
  const expiresAtMs = request?.expiresAt ? new Date(request.expiresAt).getTime() : null
  const secondsLeft = expiresAtMs ? Math.ceil((expiresAtMs - now) / 1000) : null
  const waitedSeconds = request?.createdAt
    ? Math.max(0, Math.floor((now - new Date(request.createdAt).getTime()) / 1000))
    : 0
  const stalled =
    phase === 'waiting' && backendStatus === 'queued' && waitedSeconds >= STALLED_AFTER_S

  const rules = [
    { id: 'len', label: '8+ characters', ok: password.length >= 8 },
    { id: 'letter', label: 'a letter', ok: /[A-Za-z]/.test(password) },
    { id: 'digit', label: 'a number', ok: /[0-9]/.test(password) },
  ]
  const rulesMet = rules.every((r) => r.ok)
  const confirmOk = confirm.length > 0 && confirm === password

  const blocked = botOnline === false
  const canSubmit =
    !busy &&
    !inFlight &&
    !blocked &&
    national.trim().length > 0 &&
    (mode === 'link' ? rulesMet && confirmOk : password.length > 0 && acknowledged)

  const onSubmit = async (event) => {
    event.preventDefault()
    if (!canSubmit) return

    setError(null)
    setCopied(false)
    setCode(null)
    setPhase('submitting')

    try {
      const res = await fetch(copy.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dialCode: country.dial, national, password }),
      })
      const data = await res.json().catch(() => null)

      if (!res.ok || !data?.ok) {
        setError({
          message: data?.message || 'Something went wrong. Please try again.',
        })
        setPhase(res.status === 429 ? 'blocked' : 'error')
        return
      }

      setRequest({
        requestId: data.requestId,
        maskedPhone: data.maskedPhone,
        expiresAt: data.expiresAt || null,
        createdAt: data.createdAt || new Date().toISOString(),
      })
      setBackendStatus('queued')
      setNow(Date.now())
      setPhase('waiting')
    } catch {
      setError({ message: 'Could not reach the server. Check your connection and try again.' })
      setPhase('error')
    }
  }

  const copyCode = async () => {
    if (!code) return
    try {
      await navigator.clipboard.writeText(String(code).replace(/[^A-Za-z0-9]/g, ''))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setCopied(false)
    }
  }

  const chip = {
    input: ['is-idle', 'Idle'],
    submitting: ['is-work', 'Sending'],
    waiting: ['is-work', 'Working'],
    ready: ['is-want', 'Action needed'],
    linked: ['is-good', 'Linked'],
    removed: ['is-good', 'Removed'],
    error: ['is-bad', 'Failed'],
    blocked: ['is-bad', 'Throttled'],
  }[phase] || ['is-idle', 'Idle']

  const steps =
    mode === 'link'
      ? [
          {
            n: '01',
            t: 'Request received',
            d: request
              ? `Queued for ${request.maskedPhone}.`
              : 'Your request is queued and waiting for the bot.',
            state: request ? 'is-done' : 'is-active',
          },
          {
            n: '02',
            t: 'Generating pairing code',
            d:
              backendStatus === 'working'
                ? 'The bot is asking WhatsApp for a code.'
                : 'Waiting for the bot to pick up your request.',
            state: backendStatus === 'working' ? 'is-active' : request ? 'is-active' : '',
          },
          {
            n: '03',
            t: 'Enter the code on WhatsApp',
            d: code ? 'The code is shown below.' : 'The code will appear here.',
            state: code ? 'is-done' : '',
          },
        ]
      : [
          {
            n: '01',
            t: 'Password accepted',
            d: 'The password matched the one set for this number.',
            state: request ? 'is-done' : 'is-active',
          },
          {
            n: '02',
            t: 'Removing the device',
            d:
              backendStatus === 'working'
                ? 'The bot is logging the device out and wiping its session.'
                : 'Waiting for the bot to pick up the request.',
            state: backendStatus === 'working' ? 'is-active' : request ? 'is-active' : '',
          },
        ]

  return (
    <section className="card">
      <div className="card-title">
        <h2>{copy.title}</h2>
        <span className={`chip ${chip[0]}`}>{chip[1]}</span>
      </div>

      <div className="mode-switch" role="tablist" aria-label="Choose an action">
        {['link', 'remove'].map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            className="mode-tab"
            aria-selected={mode === m}
            disabled={inFlight}
            onClick={() => (mode === m ? null : reset(m))}
          >
            {m === 'link' ? 'Link a device' : 'Remove a device'}
          </button>
        ))}
      </div>

      {phase === 'input' || phase === 'submitting' ? (
        <form onSubmit={onSubmit}>
          <div className="field-block">
            <label className="field-label" htmlFor="dial">
              Number to {mode === 'link' ? 'link' : 'remove'}
            </label>
            <div className="form-grid">
              <select
                id="dial"
                className="field"
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
              <input
                id="phone"
                className="field"
                type="tel"
                inputMode="numeric"
                autoComplete="tel"
                placeholder="712 345 678"
                value={national}
                onChange={(e) => setNational(e.target.value)}
                disabled={busy}
                aria-label="Phone number"
              />
            </div>
            <p className="hint">
              Use the number actually on that phone. A leading zero is dropped for
              you; pasting the full international number works too.
            </p>
          </div>

          {mode === 'link' ? (
            <>
              <PasswordField
                id="password"
                label="Password for removal"
                value={password}
                onChange={setPassword}
                disabled={busy}
                autoComplete="new-password"
                help="This is not an account password and is never typed on the phone. It is what authorises removing this device later."
              />
              <ul className="req-list" aria-label="Password requirements">
                {rules.map((r) => (
                  <li key={r.id} className={r.ok ? 'is-met' : ''}>
                    {r.label}
                  </li>
                ))}
              </ul>

              <div className="mt-14">
                <PasswordField
                  id="confirm"
                  label="Confirm password"
                  value={confirm}
                  onChange={setConfirm}
                  disabled={busy}
                  autoComplete="new-password"
                />
              </div>

              {confirm.length > 0 && !confirmOk ? (
                <p className="notice is-bad">Those two do not match.</p>
              ) : (
                <p className="notice is-warn">
                  <strong>Write this password down.</strong> There is no reset —
                  we have no account to send one to. You can always set a new one
                  by linking the number again from the phone.
                </p>
              )}
            </>
          ) : (
            <>
              <PasswordField
                id="password"
                label="Password set when it was linked"
                value={password}
                onChange={setPassword}
                disabled={busy}
                autoComplete="current-password"
              />
              <label className="ack">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(e) => setAcknowledged(e.target.checked)}
                  disabled={busy}
                />
                <span>
                  I understand this logs the device out of WhatsApp and wipes its
                  session on the bot.
                </span>
              </label>
            </>
          )}

          {blocked ? (
            <p className="notice is-bad mt-14">
              The bot is offline, so it cannot {mode === 'link' ? 'generate a code' : 'act on this'} right
              now. Nothing is wrong with the page — try again once it is back.
            </p>
          ) : null}

          {error && (phase === 'error' || phase === 'blocked') ? (
            <div className="error-box">{error.message}</div>
          ) : null}

          <div className="btn-row">
            <button type="submit" className="btn primary" disabled={!canSubmit}>
              {busy ? (
                <>
                  <span className="spinner" /> {copy.submitBusy}
                </>
              ) : (
                copy.submit
              )}
            </button>
          </div>

          <p className="hint">{copy.hint}</p>
        </form>
      ) : null}

      {phase === 'waiting' ? (
        <div>
          <ol className="steps">
            {steps.map((s) => (
              <li key={s.n} className={`step-i ${s.state}`}>
                <span className="mark">{s.n}</span>
                <span className="body">
                  <span className="t">{s.t}</span>
                  <span className="d">{s.d}</span>
                </span>
              </li>
            ))}
          </ol>

          {stalled ? (
            <p className="notice is-warn mt-14">
              The bot has not picked this up yet. Your request is queued correctly,
              so the likely cause is that the bot is not running — it collects these
              on its own poll. This page keeps checking, so it will continue on its
              own if the bot comes back.
            </p>
          ) : null}

          <div className="summary-row">
            <span className="k">{stalled ? 'Queued for' : 'Code in about'}</span>
            <span className="v">{formatDuration(waitedSeconds)}</span>
          </div>

          <div className="btn-row">
            <button type="button" className="btn" onClick={() => reset()}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'ready' ? (
        <div>
          <p className="notice is-want" style={{ borderLeftColor: 'var(--amber)' }}>
            Enter this in WhatsApp — the bot has issued it and it is waiting.
          </p>

          <div className="code-box">
            <div className="code">{code}</div>
            <div className="code-steps">
              <span className="step">1 · Open WhatsApp</span>
              <span className="step">2 · Linked devices</span>
              <span className="step">3 · Link with phone number</span>
            </div>
            <div className="btn-row" style={{ justifyContent: 'center' }}>
              <button type="button" className="btn" onClick={copyCode}>
                {copied ? 'Copied' : 'Copy code'}
              </button>
            </div>
            <p className="hint">
              For {request?.maskedPhone} — this page will flip to connected on its
              own once WhatsApp accepts it.
            </p>
          </div>

          <div className="summary-row">
            <span className="k">Shown for</span>
            <span className="v">{formatDuration(secondsLeft > 0 ? secondsLeft : 0)}</span>
          </div>

          <div className="btn-row">
            <button type="button" className="btn" onClick={() => reset()}>
              Start over
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'linked' ? (
        <div>
          <p className="notice" style={{ borderLeftColor: 'var(--green)' }}>
            <strong>Connected.</strong> The bot now holds a session for{' '}
            {request?.maskedPhone}. You will need the password you set to remove it.
          </p>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => reset('link')}>
              Link another number
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'removed' ? (
        <div>
          <p className="notice" style={{ borderLeftColor: 'var(--green)' }}>
            <strong>Removed.</strong> The device was logged out and its session
            wiped. It no longer appears in the list below.
          </p>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => reset('link')}>
              Link a number
            </button>
          </div>
        </div>
      ) : null}

      {phase === 'error' || phase === 'blocked' ? (
        <div>
          <div className="error-box">{error?.message || 'Something went wrong.'}</div>
          <div className="btn-row">
            <button type="button" className="btn primary" onClick={() => reset()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
