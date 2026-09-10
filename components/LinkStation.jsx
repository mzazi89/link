'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import DeviceList from '@/components/DeviceList'
import Linker from '@/components/Linker'

/**
 * The page: header, hero, the pairing card, the devices card, footer.
 *
 * Owns the state that more than one child needs — the bot list and which one is
 * selected, the devices, and whether a bot is up — so they cannot drift apart.
 */

const DEVICES_REFRESH_MS = 15000
const BOTS_REFRESH_MS = 60000

export default function LinkStation() {
  const [mode, setMode] = useState('link')
  const [devices, setDevices] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [bots, setBots] = useState([])
  // null means "everything": on a single-bot deployment there is nothing to
  // choose, and this keeps the request identical to before bots existed.
  const [bot, setBot] = useState(null)

  // Read inside callbacks without making them depend on it, so changing the
  // selection does not tear down and rebuild every timer.
  const botRef = useRef(null)
  botRef.current = bot

  const loadBots = useCallback(async () => {
    try {
      const res = await fetch('/api/bots', { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) return
      setBots(Array.isArray(data.bots) ? data.bots : [])
    } catch {
      // The bot list is decoration around the real work. A failure here must not
      // stop someone pairing, so it stays quiet.
    }
  }, [])

  const loadDevices = useCallback(async () => {
    try {
      const selected = botRef.current
      const query = selected ? `?bot=${encodeURIComponent(selected)}` : ''
      const res = await fetch(`/api/connected${query}`, { cache: 'no-store' })
      const data = await res.json().catch(() => null)
      if (!res.ok || !data?.ok) throw new Error(data?.message || 'unavailable')

      setDevices(Array.isArray(data.devices) ? data.devices : [])
      setError(null)
    } catch {
      setError('Could not load connected numbers.')
    } finally {
      setLoading(false)
    }
  }, [])

  const refreshAll = useCallback(async () => {
    await Promise.all([loadBots(), loadDevices()])
  }, [loadBots, loadDevices])

  useEffect(() => {
    refreshAll()
    const devices = setInterval(loadDevices, DEVICES_REFRESH_MS)
    const botList = setInterval(loadBots, BOTS_REFRESH_MS)
    return () => {
      clearInterval(devices)
      clearInterval(botList)
    }
  }, [refreshAll, loadDevices, loadBots])

  // Re-read the devices when the selection changes — same source, narrower view.
  useEffect(() => {
    loadDevices()
  }, [bot, loadDevices])

  const selected = bots.find((b) => b.id === bot) || null
  const pillOnline = bot ? selected?.online === true : bots.some((b) => b.online)
  const pillLabel =
    bots.length === 0
      ? 'BOT —'
      : bot
        ? `${selected?.name || 'BOT'} ${selected?.online ? 'ONLINE' : 'OFFLINE'}`
        : bots.filter((b) => b.online).length + '/' + bots.length + ' ONLINE'

  return (
    <>
      {/* Background layer — and deliberately NOT a wrapper.
          .ambient is position:fixed with inset:0, so it is pinned to the viewport
          and taken out of the document flow. Anything nested inside it therefore
          contributes no height to <body>, the document never grows past one
          screen, and there is nothing to scroll to. */}
      <div className="ambient" aria-hidden="true" />
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
            <span className={`dot ${bots.length === 0 ? '' : pillOnline ? 'online' : 'offline'}`} />
            {pillLabel}
          </span>
        </header>

        {/* Three lines, not three paragraphs. */}
        <section className="hero">
          <p className="kicker">no login · no account</p>
          <h1>
            Link a WhatsApp <span className="gold">number</span>
          </h1>
          <p>
            Pick a bot, get a code, type it into WhatsApp. The password you choose
            is what removes the device again later.
          </p>
        </section>

        <div className="station">
          <Linker
            mode={mode}
            onModeChange={setMode}
            bots={bots}
            bot={bot}
            onBotChange={setBot}
            onChanged={refreshAll}
          />

          <DeviceList
            devices={devices}
            loading={loading}
            error={error}
            bots={bots}
            bot={bot}
            onBotChange={setBot}
            onRefresh={refreshAll}
            onRemove={(device) => {
              // Carry the bot across so the removal is aimed at the same one the
              // card was listed under.
              if (device && device.bot && device.bot !== bot) setBot(device.bot)
              setMode('remove')
              if (typeof window !== 'undefined') {
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }
            }}
          />
        </div>

        <footer className="site">
          <span>MZAZI LINK — pairing station · part of the MZAZI TECH ecosystem</span>
          <span>
            <a href="https://mzazi.shop" target="_blank" rel="noreferrer">
              mzazi.shop
            </a>
          </span>
        </footer>
      </div>
    </>
  )
}
