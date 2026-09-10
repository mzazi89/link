'use strict'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * linkQueue — the quartz side of the linking contract.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The public site never talks to the bot directly. It writes a row into
 * `link_requests` in the shared Neon database; this module picks that row up,
 * asks WhatsApp for a pairing code, writes the code back, and later confirms the
 * device connected.
 *
 * Drop this file into the quartz repo (e.g. `lib/linkQueue.js`) and start it
 * from `index.js` once the bots are up:
 *
 *   const { Pool } = require('pg')
 *   const { createLinkQueue } = require('./lib/linkQueue')
 *
 *   const linkPool = new Pool({ connectionString: process.env.DATABASE_URL })
 *   const linkQueue = createLinkQueue({
 *     pool: linkPool,
 *     generatePairingCode: async (msisdn) => {
 *       // Build a fresh, unpaired socket for this number and call the fork's
 *       // pairing method. Must resolve with the code WhatsApp issued.
 *       const sock = await createPairingSocket(msisdn)
 *       return await sock.requestPairingCode(msisdn)
 *     },
 *     isLinked: async (msisdn) => sessionExists(msisdn) && isConnected(msisdn),
 *   })
 *
 *   await linkQueue.start()
 *
 * ── Why the two hooks instead of a direct Baileys call ───────────────────────
 *
 * `generatePairingCode` and `isLinked` are injected because only quartz knows
 * how its socket layer is wired — `whatsapp.js` builds sockets differently for
 * Telegram-sourced and WhatsApp-sourced sessions, and the MZAZIBOT fork adds its
 * own connection hooks. Guessing that here would be a guess baked into two
 * repos. The queue mechanics below are the part that must be exactly right, so
 * that is what this module owns.
 */

const os = require('node:os')
const { randomUUID } = require('node:crypto')

const DEFAULTS = {
  // How often to look for new work. Three seconds keeps the user's spinner
  // honest without hammering Neon.
  pollMs: 3000,
  // Rows claimed per tick. Pairing is stateful (each number needs its own
  // unpaired socket), so serialising is the safe default — raise this only if
  // your pairing path is genuinely concurrent.
  batchSize: 1,
  // Total attempts before a row is written off as failed.
  maxAttempts: 2,
  // How often to look for expired rows.
  sweepMs: 30_000,
  // Runs `isLinked` against every 'ready' row this often.
  linkCheckMs: 5000,
  // Abandon a pairing attempt that produces no code within this long.
  codeTimeoutMs: 45_000,
}

function makeLogger(logger) {
  if (logger) return logger
  return {
    info: (...a) => console.log('[linkQueue]', ...a),
    warn: (...a) => console.warn('[linkQueue]', ...a),
    error: (...a) => console.error('[linkQueue]', ...a),
  }
}

function normalizeCode(code) {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
}

function mask(msisdn) {
  const v = String(msisdn ?? '')
  if (v.length <= 4) return '•'.repeat(v.length)
  return '•'.repeat(v.length - 4) + v.slice(-4)
}

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * @param {object}   options
 * @param {import('pg').Pool} options.pool
 *   A pg Pool pointed at the shared Neon database.
 * @param {(msisdn: string) => Promise<string>} options.generatePairingCode
 *   Must return the code WhatsApp issued for that number. The queue handles
 *   normalisation, so `"ABCD-EFGH"` and `"abcdefgh"` are both fine.
 * @param {(msisdn: string) => Promise<boolean>} [options.isLinked]
 *   Optional. Returns true once the device has actually connected. Without it
 *   the queue stops at 'ready' and the UI never shows the success state, so
 *   supply it if you can.
 * @param {(msisdn: string) => Promise<void>} [options.onLinked]
 *   Optional side effect when a device connects — record the session row,
 *   credit a referrer, notify the user, etc.
 * @param {object}   [options.logger]
 * @param {object}   [options.options]  Override any DEFAULTS key.
 */
function createLinkQueue({
  pool,
  generatePairingCode,
  isLinked,
  onLinked,
  logger,
  options,
} = {}) {
  if (!pool) throw new Error('linkQueue: `pool` is required')
  if (typeof generatePairingCode !== 'function') {
    throw new Error('linkQueue: `generatePairingCode` is required')
  }

  const config = { ...DEFAULTS, ...(options || {}) }
  const log = makeLogger(logger)
  const workerId = `${os.hostname()}-${process.pid}`

  let running = false
  let stopped = true
  let pollTimer = null
  let sweepTimer = null
  let linkTimer = null

  // Rows this worker is actively pairing. The sweeper must not expire these —
  // doing so would race the pairing attempt and produce a row whose status
  // contradicts what the socket is doing.
  const inFlight = new Set()

  // ── Claim ────────────────────────────────────────────────────────────────
  // The classic Postgres job-queue idiom: the inner SELECT takes a row lock and
  // SKIP LOCKED makes concurrent workers step over rows another worker holds,
  // so two bot instances never pair the same number.
  async function claimNext() {
    const { rows } = await pool.query(
      `
      UPDATE link_requests
         SET status      = 'processing',
             attempts    = attempts + 1,
             claimed_at  = now(),
             claimed_by  = $1,
             updated_at  = now()
       WHERE id = (
         SELECT id
           FROM link_requests
          WHERE status = 'pending'
            AND expires_at > now()
            AND attempts < $2
          ORDER BY created_at
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING id, public_id, phone, dial_code, attempts, expires_at
      `,
      [workerId, config.maxAttempts]
    )
    return rows[0] || null
  }

  async function markReady(row, code) {
    await pool.query(
      `
      UPDATE link_requests
         SET status        = 'ready',
             pairing_code  = $2,
             code_ready_at = now(),
             error         = NULL,
             updated_at    = now()
       WHERE id = $1 AND status = 'processing'
      `,
      [row.id, code]
    )
  }

  async function markLinked(id) {
    const { rowCount } = await pool.query(
      `
      UPDATE link_requests
         SET status     = 'linked',
             linked_at  = now(),
             error      = NULL,
             updated_at = now()
       WHERE id = $1 AND status IN ('ready', 'processing')
      `,
      [id]
    )
    return rowCount > 0
  }

  /**
   * A failed attempt either goes back to 'pending' for one more try, or is
   * written off. pairing_code is explicitly cleared so the status constraint
   * (no code on a 'pending' row) can never be violated on the retry path.
   */
  async function markFailed(row, message) {
    const willRetry = row.attempts < config.maxAttempts
    await pool.query(
      `
      UPDATE link_requests
         SET status       = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
             error        = $2,
             pairing_code = NULL,
             claimed_at   = NULL,
             claimed_by   = NULL,
             updated_at   = now()
       WHERE id = $1 AND status = 'processing'
      `,
      [row.id, String(message || 'Pairing failed').slice(0, 500), config.maxAttempts]
    )
    return !willRetry
  }

  // ── Work ─────────────────────────────────────────────────────────────────
  async function processRow(row) {
    inFlight.add(row.id)
    log.info(`claim ${row.public_id} → +${mask(row.phone)} (attempt ${row.attempts})`)

    try {
      const raw = await withTimeout(
        generatePairingCode(row.phone),
        config.codeTimeoutMs,
        'generatePairingCode'
      )

      const code = normalizeCode(raw)
      if (code.length !== 8) {
        throw new Error(`unexpected pairing code shape (${code.length} chars)`)
      }

      await markReady(row, code)
      log.info(`ready ${row.public_id} → ${code.slice(0, 2)}••••`)
    } catch (err) {
      const final = await markFailed(row, err.message)
      if (final) {
        log.warn(`failed ${row.public_id}: ${err.message}`)
      } else {
        log.warn(`retry ${row.public_id}: ${err.message}`)
      }
    } finally {
      inFlight.delete(row.id)
    }
  }

  async function drain() {
    if (!running) return
    for (let i = 0; i < config.batchSize; i += 1) {
      let row
      try {
        row = await claimNext()
      } catch (err) {
        log.error('claim failed:', err.message)
        return
      }
      if (!row) return
      // Serialised on purpose: each claim needs its own pairing socket, and
      // opening several at once is the fastest way to get rate-limited by
      // WhatsApp.
      await processRow(row)
    }
  }

  // ── Link confirmation ────────────────────────────────────────────────────
  // Query-driven rather than held in memory, so a bot restart mid-flight still
  // finds the rows it was waiting on.
  async function checkLinks() {
    if (!running || typeof isLinked !== 'function') return

    let rows
    try {
      const result = await pool.query(
        `
        SELECT id, public_id, phone
          FROM link_requests
         WHERE status = 'ready'
           AND claimed_by = $1
           AND expires_at > now()
        `,
        [workerId]
      )
      rows = result.rows
    } catch (err) {
      log.error('link check query failed:', err.message)
      return
    }

    for (const row of rows) {
      // Skip anything mid-pairing; it has no code yet in practice.
      if (inFlight.has(row.id)) continue
      try {
        if (await isLinked(row.phone)) {
          const changed = await markLinked(row.id)
          if (changed) {
            log.info(`linked ${row.public_id} → +${mask(row.phone)}`)
            if (typeof onLinked === 'function') {
              try {
                await onLinked(row.phone)
              } catch (err) {
                log.warn(`onLinked hook failed for ${row.public_id}:`, err.message)
              }
            }
          }
        }
      } catch (err) {
        log.warn(`isLinked check failed for ${row.public_id}:`, err.message)
      }
    }
  }

  // ── Expiry ───────────────────────────────────────────────────────────────
  async function sweep() {
    if (!running) return
    try {
      // Rows this worker is holding are excluded, so an in-progress pairing is
      // never yanked out from under the socket.
      const hold = [...inFlight]
      const { rowCount } = await pool.query(
        `
        UPDATE link_requests
           SET status = 'expired', updated_at = now()
         WHERE status IN ('pending', 'processing', 'ready')
           AND expires_at < now()
           AND NOT (id = ANY($1::bigint[]))
        `,
        [hold]
      )
      if (rowCount > 0) log.info(`expired ${rowCount} stale request(s)`)
    } catch (err) {
      log.error('sweep failed:', err.message)
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────
  async function tick(fn) {
    try {
      await fn()
    } catch (err) {
      // A single bad tick must never kill the interval.
      log.error('tick error:', err.message)
    }
  }

  async function start() {
    if (running) return
    running = true
    stopped = false
    log.info(`starting (worker ${workerId}, poll ${config.pollMs}ms)`)

    pollTimer = setInterval(() => tick(drain), config.pollMs)
    sweepTimer = setInterval(() => tick(sweep), config.sweepMs)
    if (typeof isLinked === 'function') {
      linkTimer = setInterval(() => tick(checkLinks), config.linkCheckMs)
    } else {
      log.warn('no `isLinked` hook — rows will stop at "ready" and never show as linked')
    }

    // Do not wait for the first interval; pick up anything already queued.
    await tick(drain)
    await tick(sweep)
  }

  async function stop() {
    if (stopped) return
    stopped = true
    running = false
    for (const t of [pollTimer, sweepTimer, linkTimer]) {
      if (t) clearInterval(t)
    }
    pollTimer = sweepTimer = linkTimer = null
    log.info('stopped')
  }

  return {
    start,
    stop,
    // Exposed for tests and for an operator-triggered manual drain.
    drain,
    sweep,
    checkLinks,
    get workerId() {
      return workerId
    },
    get config() {
      return config
    },
  }
}

module.exports = { createLinkQueue, DEFAULTS, normalizeCode }
