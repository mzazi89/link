'use strict'

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * linkQueue — the quartz side of the device-request contract.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * The public site never talks to the bot directly. It writes a row into
 * `device_requests` in the shared Neon database; this module picks that row up,
 * does the work, and writes the outcome back.
 *
 * Two kinds of job travel through the one queue, distinguished by `action`:
 *
 *   link   → ask WhatsApp for a pairing code, publish it, then confirm the
 *            device connected and promote the user's password into
 *            device_credentials
 *   delete → wipe the session (authorised by the site AFTER it verified the
 *            password, so nothing here needs to know about passwords)
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
 *
 *     // Required for the delete flow. Mirror the existing semantics: unlink
 *     // logs the device out, delete then removes the session folder.
 *     deleteDevice: async (msisdn) => {
 *       await logoutSession(msisdn)
 *       await rmSessionFolder(msisdn)
 *     },
 *
 *     // Required for the website's connected-numbers list. Return the MSISDNs
 *     // the bot currently holds a session folder for.
 *     listSessions: async () => {
 *       const dir = path.join(__dirname, '..', 'database', 'sessions')
 *       const entries = await fs.readdir(dir, { withFileTypes: true })
 *       return entries.filter((e) => e.isDirectory()).map((e) => e.name)
 *     },
 *   })
 *
 *   await linkQueue.start()
 *
 * ── Why the hooks instead of direct Baileys calls ────────────────────────────
 *
 * `generatePairingCode`, `isLinked` and `deleteDevice` are injected because only
 * quartz knows how its socket layer is wired — `whatsapp.js` builds sockets
 * differently for Telegram-sourced and WhatsApp-sourced sessions, and the
 * MZAZIBOT fork adds its own connection hooks. Guessing that here would be a
 * guess baked into two repos. The queue mechanics below are the part that must
 * be exactly right, so that is what this module owns.
 */

const os = require('node:os')

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
  // Abandon a delete that does not finish within this long. Longer than pairing
  // because a logout can wait on a socket handshake.
  deleteTimeoutMs: 60_000,
  // How often to republish the session folder list. Cheap (one upsert plus one
  // update) and only needs to be as fresh as the site's list is useful.
  sessionSyncMs: 60_000,
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
 *   the queue stops at 'ready', the user's password is never promoted, and the
 *   UI never shows the success state — so supply it.
 * @param {(msisdn: string) => Promise<void>} [options.deleteDevice]
 *   Required to serve delete requests. Should log the device out and remove its
 *   session folder. Must reject if the wipe genuinely failed, so the row is
 *   retried rather than reported as done.
 * @param {() => Promise<string[]>} [options.listSessions]
 *   Returns the MSISDNs the bot currently holds a session folder for. This is
 *   what lets the website show connected numbers at all — the site is
 *   serverless and cannot read `database/sessions/` itself, so anything not
 *   reported here is invisible to it.
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
  deleteDevice,
  listSessions,
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
  let sessionTimer = null

  // Rows this worker is actively handling. The sweeper must not expire these —
  // doing so would race the attempt and produce a row whose status contradicts
  // what the socket is doing.
  const inFlight = new Set()

  // ── Claim ────────────────────────────────────────────────────────────────
  // The classic Postgres job-queue idiom: the inner SELECT takes a row lock and
  // SKIP LOCKED makes concurrent workers step over rows another worker holds,
  // so two bot instances never work the same row.
  //
  // Deliberately no `action` filter: both link and delete jobs are drained by
  // the same loop, and deletes are cheap, so letting them queue behind pairing
  // work costs nothing.
  async function claimNext() {
    const { rows } = await pool.query(
      `
      UPDATE device_requests
         SET status      = 'processing',
             attempts    = attempts + 1,
             claimed_at  = now(),
             claimed_by  = $1,
             updated_at  = now()
       WHERE id = (
         SELECT id
           FROM device_requests
          WHERE status = 'pending'
            AND expires_at > now()
            AND attempts < $2
          -- id breaks created_at ties. now() is the TRANSACTION timestamp, so
          -- several rows inserted together share it exactly, and without a
          -- tiebreaker Postgres returns them in an arbitrary order — verified
          -- against a real Postgres, where a delete queued after a link came
          -- back first. Ordering is not load-bearing here, but a queue that
          -- cannot promise FIFO on same-timestamp rows is a bad habit to keep.
          ORDER BY created_at, id
            FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
      RETURNING id, public_id, action, phone, dial_code, attempts, expires_at
      `,
      [workerId, config.maxAttempts]
    )
    return rows[0] || null
  }

  async function markReady(row, code) {
    await pool.query(
      `
      UPDATE device_requests
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
      UPDATE device_requests
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

  async function markCompleted(id) {
    const { rowCount } = await pool.query(
      `
      UPDATE device_requests
         SET status       = 'completed',
             completed_at = now(),
             error        = NULL,
             updated_at   = now()
       WHERE id = $1 AND status = 'processing'
      `,
      [id]
    )
    return rowCount > 0
  }

  /**
   * Retire the credential for a number whose device has been removed.
   *
   * `device_credentials` doubles as the register the site reads to decide
   * whether a number is still connected, so this row has to go — leave it and
   * every removed device keeps showing up as connected. It is also the right
   * privacy call: no reason to keep a password hash for a device that no longer
   * exists.
   *
   * Non-fatal. The session is already gone by the time this runs, and retrying
   * a completed deletion would be worse than a stale list entry, so a failure
   * here is loud in the log rather than fatal to the request.
   */
  async function clearCredential(phone) {
    try {
      const { rowCount } = await pool.query(
        `DELETE FROM device_credentials WHERE phone = $1`,
        [phone]
      )
      return rowCount > 0
    } catch (err) {
      log.error(
        `could not clear credential for +${mask(phone)} — the number will still ` +
          `read as connected:`,
        err.message
      )
      return false
    }
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
      UPDATE device_requests
         SET status       = CASE WHEN attempts >= $3 THEN 'failed' ELSE 'pending' END,
             error        = $2,
             pairing_code = NULL,
             claimed_at   = NULL,
             claimed_by   = NULL,
             updated_at   = now()
       WHERE id = $1 AND status = 'processing'
      `,
      [row.id, String(message || 'Request failed').slice(0, 500), config.maxAttempts]
    )
    return !willRetry
  }

  /**
   * Promote the password staged on a link request into the credential store.
   *
   * This runs ONLY after the device has genuinely connected. That ordering is
   * the whole security model: a pairing code has to be typed into the target
   * phone, so whoever ends up holding the deletion password is provably holding
   * the phone. Promoting on submission instead would let anyone claim a
   * stranger's number by queueing a request with their own password.
   *
   * The `WHERE device_credentials.updated_at <` guard makes this last-writer-
   * wins by request age, so a stale request that finally completes can never
   * clobber a newer credential.
   */
  async function promoteCredential(requestId) {
    try {
      const { rowCount } = await pool.query(
        `
        INSERT INTO device_credentials (phone, password_hash)
        SELECT phone, password_hash
          FROM device_requests
         WHERE id = $1 AND password_hash IS NOT NULL
        ON CONFLICT (phone) DO UPDATE
           SET password_hash   = EXCLUDED.password_hash,
               failed_attempts = 0,
               locked_until    = NULL,
               updated_at      = now()
         WHERE device_credentials.updated_at < (
           SELECT created_at FROM device_requests WHERE id = $1
         )
        `,
        [requestId]
      )

      if (rowCount > 0) {
        // Staging area no longer needs the secret.
        await pool.query(
          `UPDATE device_requests SET password_hash = NULL, updated_at = now() WHERE id = $1`,
          [requestId]
        )
      }
      return rowCount > 0
    } catch (err) {
      // Never fatal to the link itself — the device IS connected. Surface it
      // loudly, because it means the user cannot authorise a deletion yet.
      log.error(`could not promote credential for request ${requestId}:`, err.message)
      return false
    }
  }

  // ── Work ─────────────────────────────────────────────────────────────────
  async function processLink(row) {
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
  }

  async function processDelete(row) {
    if (typeof deleteDevice !== 'function') {
      throw new Error(
        'deleteDevice hook is not configured — cannot serve delete requests'
      )
    }

    await withTimeout(deleteDevice(row.phone), config.deleteTimeoutMs, 'deleteDevice')

    // Retire the register entry before reporting the removal done, so the number
    // drops off the site's list the moment it stops being connected.
    await clearCredential(row.phone)

    await markCompleted(row.id)
    log.info(`removed ${row.public_id} → +${mask(row.phone)}`)
  }

  async function processRow(row) {
    inFlight.add(row.id)
    log.info(
      `claim ${row.public_id} [${row.action}] → +${mask(row.phone)} (attempt ${row.attempts})`
    )

    try {
      if (row.action === 'delete') {
        await processDelete(row)
      } else {
        await processLink(row)
      }
    } catch (err) {
      const final = await markFailed(row, err.message)
      if (final) {
        log.warn(`failed ${row.public_id} [${row.action}]: ${err.message}`)
      } else {
        log.warn(`retry ${row.public_id} [${row.action}]: ${err.message}`)
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
          FROM device_requests
         WHERE status = 'ready'
           AND action = 'link'
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
          // Promote BEFORE flipping the status, and accept that a lost race may
          // promote twice. The order matters to observers: `device_credentials`
          // is what the site reads to decide whether a device is connected, so
          // if the status said 'linked' before the credential landed, a browser
          // polling in that window would see a freshly linked number as not
          // connected. Writing the credential first makes 'linked' imply it.
          await promoteCredential(row.id)

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

  // ── Session register sync ────────────────────────────────────────────────
  /**
   * Publish the bot's session folders into `bot_sessions`.
   *
   * The website has no filesystem access — it is a serverless deployment and the
   * session folders live on the bot's host — so this is the only way the
   * connected-numbers list can exist. Whatever is not reported here simply does
   * not appear on the page.
   *
   * Rows are never deleted: a number that disappears gets `removed_at` stamped,
   * so a number that comes back (relinked) clears it again.
   */
  async function syncSessions() {
    if (!running || typeof listSessions !== 'function') return

    let reported
    try {
      reported = await listSessions()
    } catch (err) {
      log.error('listSessions failed — register left untouched:', err.message)
      return
    }

    if (!Array.isArray(reported)) {
      log.error('listSessions did not return an array — register left untouched')
      return
    }

    const phones = [
      ...new Set(
        reported.filter(
          (n) => typeof n === 'string' && /^[0-9]{8,15}$/.test(n.trim())
        ).map((n) => n.trim())
      ),
    ]

    // The important guard. An empty scan is far more likely to mean the session
    // directory could not be read — wrong working directory, permissions not yet
    // fixed, a container that has not mounted its volume — than that every user
    // unlinked at once. Acting on it would wipe the entire public list, so
    // refuse and shout about it instead. Recovery is automatic: the next good
    // scan repopulates everything, because rows are only ever stamped, not
    // deleted.
    if (phones.length === 0) {
      log.warn(
        'session scan returned no numbers — skipping sync rather than retiring every session'
      )
      return
    }

    try {
      await pool.query(
        `
        INSERT INTO bot_sessions (phone)
        SELECT unnest($1::text[])
        ON CONFLICT (phone) DO UPDATE
           SET last_seen_at = now(),
               removed_at   = NULL
        `,
        [phones]
      )

      const { rowCount } = await pool.query(
        `
        UPDATE bot_sessions
           SET removed_at = now()
         WHERE removed_at IS NULL
           AND NOT (phone = ANY($1::text[]))
        `,
        [phones]
      )

      log.info(`session sync: ${phones.length} live, ${rowCount} retired`)
    } catch (err) {
      log.error('session sync failed:', err.message)
    }
  }

  // ── Expiry ───────────────────────────────────────────────────────────────
  async function sweep() {
    if (!running) return
    try {
      // Rows this worker is holding are excluded, so an in-progress attempt is
      // never yanked out from under the socket.
      const hold = [...inFlight]
      const { rowCount } = await pool.query(
        `
        UPDATE device_requests
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
      log.warn(
        'no `isLinked` hook — rows will stop at "ready", and no deletion password will ever be set'
      )
    }

    if (typeof deleteDevice !== 'function') {
      log.warn('no `deleteDevice` hook — delete requests will fail when drained')
    }

    if (typeof listSessions === 'function') {
      sessionTimer = setInterval(() => tick(syncSessions), config.sessionSyncMs)
    } else {
      log.warn(
        'no `listSessions` hook — the website will show no connected numbers at all'
      )
    }

    // Do not wait for the first interval; pick up anything already queued.
    await tick(drain)
    await tick(sweep)
    await tick(syncSessions)
  }

  async function stop() {
    if (stopped) return
    stopped = true
    running = false
    for (const t of [pollTimer, sweepTimer, linkTimer, sessionTimer]) {
      if (t) clearInterval(t)
    }
    pollTimer = sweepTimer = linkTimer = sessionTimer = null
    log.info('stopped')
  }

  return {
    start,
    stop,
    // Exposed for tests and for an operator-triggered manual drain.
    drain,
    sweep,
    checkLinks,
    syncSessions,
    promoteCredential,
    clearCredential,
    get workerId() {
      return workerId
    },
    get config() {
      return config
    },
  }
}

module.exports = { createLinkQueue, DEFAULTS, normalizeCode }
