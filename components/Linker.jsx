'use client'

import { useCallback, useEffect, useState } from 'react'

import { COUNTRIES, DEFAULT_COUNTRY_ISO } from '@/lib/countries'

/**
 * The whole linking flow lives here.
 *
 * Phases:
 *   input / submitting → number entry
 *   waiting            → request queued, bot is producing a code
 *   ready              → code on screen, user types it into WhatsApp
 *   linked             → bot confirmed the device connected
 *   expired / error / blocked → recoverable dead ends
 */

const POLL_WAITING_MS = 2000
// Once the code is on screen we are only watching for the device to connect,
// so we can back right off and stop hammering the endpoint.
const POLL_READY_MS = 4000

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}:${String(r).padStart(2, '0')}`
}

const CHIP = {
  input: { text: 'Idle', tone: 'neutral' },
  submitting: { text: 'Sending', tone: 'active' },
  waiting: { text: 'Working', tone: 'active' },
  ready: { text: 'Action needed', tone: 'active' },
  linked: { text: 'Linked', tone: 'good' },
  expired: { text: 'Expired', tone: 'bad' },
  error: { text: 'Failed', tone: 'bad' },
  blocked: { text: 'Throttled', tone: 'bad' },
}

function StatusChip({ phase }) {
  const chip = CHIP[phase] || CHIP.input
  const toneClass =
    chip.tone === 'active'
      ? 'text-amber border-amber/40'
      : chip.tone === 'good'
        ? 'text-amber border-amber/40'
        : chip.tone === 'bad'
          ? 'text-rust border-rust/40'
          : 'text-paper-faint border-[color:var(--hairline-strong)]'

  return (
    <span
      className={`inline-flex items-center gap-2 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-label ${toneClass}`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          chip.tone === 'active'
            ? 'bg-amber animate-pulse-soft'
            : chip.tone === 'good'
              ? 'bg-amber'
              : chip.tone === 'bad'
                ? 'bg-rust'
                : 'bg-paper-faint'
        }`}
        aria-hidden="true"
      />
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
        <p className={`font-mono text-[10px] uppercase tracking-label ${
          done || active ? 'text-paper' : 'text-paper-faint'
        }`}>
          {n} — {title}
        </p>
        {detail ? (
          <p className="mt-1.5 text-[13px] leading-relaxed text-paper-muted">{detail}</p>
        ) : null}
      </div>
    </li>
  )
}

export default function Linker() {
  const [phase, setPhase] = useState('input')
  const [countryIso, setCountryIso] = useState(DEFAULT_COUNTRY_ISO)
  const [national, setNational] = useState('')

  const [request, setRequest] = useState(null)
  const [botStatus, setBotStatus] = useState(null)
  const [code, setCode] = useState(null)
  const [error, setError] = useState(null)
  const [copyState, setCopyState] = useState('idle')

  // Drives the countdown. Ticking locally avoids a poll per second.
  const [now, setNow] = useState(() => Date.now())

  const country = COUNTRIES.find((c) => c.iso === countryIso) ?? COUNTRIES[0]
  const publicId = request?.publicId || null
  const busy = phase === 'submitting'

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
        const res = await fetch(`/api/link/${encodeURIComponent(publicId)}`, {
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
          case 'failed':
            setError({
              message: data.message || 'The pairing could not be completed.',
            })
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

  // ── Actions ───────────────────────────────────────────────────────────────
  const onSubmit = useCallback(
    async (event) => {
      event.preventDefault()
      if (busy) return

      setError(null)
      setCode(null)
      setCopyState('idle')
      setBotStatus(null)
      setPhase('submitting')

      try {
        const res = await fetch('/api/link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dialCode: country.dial, national }),
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
    [busy, country.dial, national]
  )

  const reset = useCallback(() => {
    setPhase('input')
    setRequest(null)
    setBotStatus(null)
    setCode(null)
    setError(null)
    setCopyState('idle')
    setNational('')
  }, [])

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

  // ── Render helpers ────────────────────────────────────────────────────────
  const showForm = phase === 'input' || phase === 'submitting'

  return (
    <div className="border bg-ink-900/60 hairline">
      {/* Card header — state chip, so the user always knows where they are. */}
      <div className="flex items-center justify-between gap-3 border-b px-5 py-3.5 hairline">
        <span className="label">Pairing</span>
        <StatusChip phase={phase} />
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
              Enter the number as it appears on that phone. A leading zero is fine —
              we drop it and use the country code for you.
            </p>

            {error ? (
              <p className="mt-5 border-l-2 border-rust pl-3 text-[13px] leading-relaxed text-paper-muted">
                {error.message}
              </p>
            ) : null}

            <button
              type="submit"
              className="btn-primary mt-6"
              disabled={busy || !national.trim()}
            >
              {busy ? 'Requesting code' : 'Link device'}
            </button>
          </form>
        ) : null}

        {phase === 'waiting' ? (
          <div className="animate-rise">
            <p className="label-amber">In progress</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Preparing your pairing code
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              Keep this page open. WhatsApp is issuing a code for{' '}
              <span className="font-mono text-[13px] text-paper">{request?.phone}</span>.
            </p>

            <ol className="mt-7">
              <Step
                n="01"
                title="Request received"
                detail="Your number is queued and waiting for the bot."
                state="done"
              />
              <Step
                n="02"
                title="Generating pairing code"
                detail={
                  botStatus === 'processing'
                    ? 'The bot has your request and is asking WhatsApp for a code.'
                    : 'Waiting for the bot to pick up your request.'
                }
                state={botStatus === 'processing' ? 'active' : 'todo'}
              />
              <Step
                n="03"
                title="Enter the code on WhatsApp"
                detail="The code will appear here."
                state="todo"
              />
            </ol>

            <div className="flex items-center justify-between border-t pt-4 hairline">
              <span className="label">Expires in</span>
              <span className="font-mono text-[12px] text-paper-muted">
                {formatDuration(secondsLeft)}
              </span>
            </div>

            <button type="button" onClick={reset} className="btn-ghost mt-4 w-full">
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
            </p>

            <button type="button" onClick={reset} className="btn-ghost mt-4 w-full">
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
              linked to the bot. You can close this page — the connection keeps
              running in the background.
            </p>
            <p className="mt-4 text-[12.5px] leading-relaxed text-paper-faint">
              To disconnect later, remove the device from Linked devices inside
              WhatsApp itself.
            </p>
            <button type="button" onClick={reset} className="btn-ghost mt-6 w-full">
              Link another number
            </button>
          </div>
        ) : null}

        {phase === 'expired' ? (
          <div className="animate-rise">
            <p className="label text-rust">Expired</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              That code timed out
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              Nothing was linked. Codes only stay valid for a few minutes, and the
              bot may not have reached your number in time.
            </p>
            <button type="button" onClick={reset} className="btn-primary mt-6">
              Try again
            </button>
          </div>
        ) : null}

        {phase === 'blocked' ? (
          <div className="animate-rise">
            <p className="label text-rust">Too many requests</p>
            <h2 className="mt-3 font-display text-[19px] font-medium text-paper">
              Slow down for a moment
            </h2>
            <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
              {error?.message || 'Please wait a little before requesting another code.'}
            </p>
            <button type="button" onClick={reset} className="btn-ghost mt-6 w-full">
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
            <button type="button" onClick={reset} className="btn-primary mt-6">
              Try again
            </button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
