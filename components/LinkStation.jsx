'use client'

import { useCallback, useEffect, useState } from 'react'

import DeviceList from '@/components/DeviceList'
import Linker from '@/components/Linker'

/**
 * The page: header, hero, the pairing card, the devices card, footer.
 *
 * Owns the two pieces of state that more than one child needs — the bot's
 * online state (header pill and pairing form both depend on it) and the device
 * list (the devices card and the removal flow both refresh it) — so they cannot
 * drift apart.
 */

// quartzxd refreshes on this interval; the same cadence is right here. The list
// only changes when a device connects or is removed, and this is a public page.
const DEVICES_REFRESH_MS = 15000

export default function LinkStation() {
  const [mode, setMode] = useState('link')
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // null means "not asked yet" — distinct from false, which means "asked, and
  // the bot is down". The pill renders differently for each.
  const [botOnline, setBotOnline] = useState(null)
  const [ip, setIp] = useState(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/connected', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'unavailable')
      setDevices(Array.isArray(data.devices) ? data.devices : [])
      setBotOnline(Boolean(data.botOnline))
      setIp(data.ip || null)
      setError(null)
    } catch {
      setError('Could not load connected numbers.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const timer = setInterval(load, DEVICES_REFRESH_MS)
    return () => clearInterval(timer)
  }, [load])

  const pillClass = botOnline === null ? '' : botOnline ? 'online' : 'offline'
  const pillLabel =
    botOnline === null ? 'BOT —' : botOnline ? 'BOT ONLINE' : 'BOT OFFLINE'

  return (
    <div className="ambient">
      <div className="wrap">
        <header className="site">
          <a className="brand" href="/">
            <span className="brand-mark">M</span>
            <span>
              <span className="brand-name">
                MZAZI <em>LINK</em>
              </span>
              <span className="brand-sub">pairing station</span>
            </span>
          </a>
          <span className="pill">
            <span className={`dot ${pillClass}`} />
            {pillLabel}
          </span>
        </header>

        <section className="hero">
          <p className="kicker">WhatsApp · Multi-device · No login</p>
          <h1>
            Link your number
            <br />
            <span className="gold">in seconds</span>
          </h1>
          <p>
            Get an 8-character pairing code, type it into WhatsApp, and see the
            device go live. Set a password while you link and that is what removes
            the device again later — no account, no sign-up.
          </p>
        </section>

        <Linker mode={mode} onModeChange={setMode} botOnline={botOnline} onChanged={load} />

        <DeviceList
          devices={devices}
          loading={loading}
          error={error}
          ip={ip}
          onRefresh={load}
          onRemove={() => {
            setMode('remove')
            if (typeof window !== 'undefined') {
              window.scrollTo({ top: 0, behavior: 'smooth' })
            }
          }}
        />

        <footer className="site">
          <span>MZAZI LINK — pairing station · part of the MZAZI TECH ecosystem</span>
          <span>
            <a href="https://mzazi.shop" target="_blank" rel="noreferrer">
              mzazi.shop
            </a>
          </span>
        </footer>
      </div>
    </div>
  )
}
