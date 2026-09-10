import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { Pool } from 'pg'

/**
 * Shared Neon PostgreSQL pool.
 *
 * This app is deliberately stateless and has no user accounts — the database is
 * both the queue and the record. Everything else is derived from it.
 */

let cached = globalThis.__mzaziLinkPool

function createPool() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env.local and paste the ' +
        'same Neon connection string that quartz/ and web/ use.'
    )
  }

  // Neon hands out a cert chain that some Node builds do not ship, so a strict
  // verification fails with SELF_SIGNED_CERT_IN_CHAIN. The connection is still
  // TLS-encrypted; the host is trusted by configuration. Set PGSSL_STRICT=1 to
  // enforce full chain verification if your runtime has the roots.
  const wantsSsl =
    /sslmode=require|sslmode=verify/i.test(connectionString) ||
    process.env.PGSSL === 'require'
  const strict = process.env.PGSSL_STRICT === '1'

  const pool = new Pool({
    connectionString,
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: wantsSsl ? { rejectUnauthorized: strict } : undefined,
  })

  // A pooled client can die between requests (Neon scale-to-zero, network
  // resets). Swallow it here so a single dropped socket never takes the
  // process down; the next query transparently gets a fresh client.
  pool.on('error', (err) => {
    console.error('[link][db] idle client error:', err.message)
  })

  return pool
}

/**
 * In dev, Next.js re-evaluates modules on every edit. Without caching on
 * globalThis we would mint a new pool per hot reload and exhaust Neon's
 * connection limit within a few saves.
 */
export function getPool() {
  if (!cached) {
    cached = createPool()
    globalThis.__mzaziLinkPool = cached
  }
  return cached
}

/**
 * Postgres 42P01 = undefined_table.
 *
 * On a fresh deployment the overwhelming cause is that the schema was never
 * applied. The raw driver message — `relation "device_requests" does not exist`
 * — names the symptom but not the fix, and it is exactly the sort of thing that
 * gets misread as a code bug. Rewrite it into something actionable before it
 * reaches a log or an operator's screen.
 */
export class SchemaMissingError extends Error {
  constructor(relation, cause) {
    super(
      `Database schema is not initialised (missing table "${relation || 'unknown'}"). ` +
        'Open /api/init-db in a browser to apply it — allowed without a key while the ' +
        'schema is missing — or run `npm run db:init` locally with DATABASE_URL set.'
    )
    this.name = 'SchemaMissingError'
    this.code = 'SCHEMA_MISSING'
    this.relation = relation || null
    this.cause = cause
  }
}

function decorate(err) {
  if (err && err.code === '42P01') {
    const relation = /relation "([^"]+)"/.exec(err.message || '')?.[1]
    return new SchemaMissingError(relation, err)
  }
  return err
}

/**
 * Shape a 503 body.
 *
 * A missing schema is an operator problem with a known fix, so say so rather
 * than hiding it behind "try again shortly" — that message sends whoever is
 * debugging off looking for a bug in the wrong place.
 */
export function unavailable(error, fallbackMessage) {
  if (error?.code === 'SCHEMA_MISSING') {
    return { ok: false, error: 'schema_missing', message: error.message }
  }
  return { ok: false, error: 'unavailable', message: fallbackMessage }
}

// ── Schema self-application ──────────────────────────────────────────────────
//
// The site used to require someone to run `npm run db:init` or open
// /api/init-db before it would work at all. That is a deployment step nobody
// remembers, and the failure mode is every request returning 503 until they
// figure it out. Since the schema is purely additive and idempotent, the app
// can simply make sure it is there.
//
// Three things keep this cheap and safe:
//
//   1. It checks first. One catalog query per process, and only if a table is
//      actually missing does it run any DDL — so a healthy deployment pays a
//      single indexed read per cold start rather than re-running 20 statements.
//   2. Advisory lock. Several serverless instances booting at once would
//      otherwise race on CREATE TABLE and CREATE INDEX, which fails with
//      duplicate-key errors on the system catalogs.
//   3. Failure is not fatal. If the database user lacks DDL rights, the schema
//      still works for reads; letting the real query fail afterwards gives a
//      far more accurate error than anything this layer could invent.

const SCHEMA_PATH = path.join(process.cwd(), 'lib', 'schema.sql')

// Arbitrary, but must be identical across instances — it only has to be unique
// within this database. Two different numbers keep schema work from blocking
// unrelated advisory locks the bot may use.
const SCHEMA_LOCK_KEY = 831742001

// How long to wait for another instance to finish applying the schema before
// giving up and letting the request proceed.
const LOCK_WAIT_MS = 5000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const EXPECTED_TABLES = [
  'device_requests',
  'device_credentials',
  'password_attempts',
  'bot_sessions',
]

export async function readSchemaSql() {
  return readFile(SCHEMA_PATH, 'utf8')
}

async function missingTables(runner) {
  const { rows } = await runner.query(
    `SELECT table_name
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
    [EXPECTED_TABLES]
  )
  const found = new Set(rows.map((r) => r.table_name))
  return EXPECTED_TABLES.filter((t) => !found.has(t))
}

/** Apply the schema if anything is missing. Returns which tables were absent. */
export async function applySchemaIfNeeded() {
  if (String(process.env.AUTO_MIGRATE || '').toLowerCase() === 'off') {
    return { applied: false, skipped: 'AUTO_MIGRATE=off', missing: [] }
  }

  const pool = getPool()
  const missing = await missingTables(pool)
  if (missing.length === 0) return { applied: false, missing: [] }

  const client = await pool.connect()
  let locked = false

  try {
    // pg_advisory_lock blocks indefinitely when another instance holds it, which
    // on a cold-start stampede would hang requests rather than queue them
    // usefully. Try instead, and poll briefly: the other instance is applying
    // the same additive script, so waiting a moment usually means the work is
    // already done and this instance has nothing left to do.
    const deadline = Date.now() + LOCK_WAIT_MS
    while (Date.now() < deadline) {
      const { rows } = await client.query(
        'SELECT pg_try_advisory_lock($1) AS acquired',
        [SCHEMA_LOCK_KEY]
      )
      if (rows[0]?.acquired) {
        locked = true
        break
      }
      await sleep(250)
    }

    // Checked inside the lock when we got it, and harmlessly re-checked when we
    // did not.
    const stillMissing = await missingTables(client)
    if (stillMissing.length === 0) return { applied: false, missing }

    if (!locked) {
      // Someone else is on it. Do not risk a catalog race by applying anyway —
      // their run will satisfy the next request.
      console.warn(
        '[link][db] schema still missing but the setup lock is held elsewhere — deferring'
      )
      return { applied: false, deferred: true, missing: stillMissing }
    }

    const sql = await readSchemaSql()
    console.log(`[link][db] applying schema — missing: ${stillMissing.join(', ')}`)
    await client.query(sql)
    return { applied: true, missing: stillMissing }
  } finally {
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock($1)', [SCHEMA_LOCK_KEY])
      } catch (err) {
        // The lock dies with the session anyway; losing the explicit release is
        // not worth masking whatever error brought us here.
        console.warn('[link][db] could not release schema lock:', err.message)
      }
    }
    client.release()
  }
}

let setupPromise = null

/**
 * Ensure the schema exists, at most once per process.
 *
 * Never throws: a failure is logged once and the caller proceeds, because the
 * query it was about to run will produce a better error than we could.
 */
export function ensureSchema() {
  if (!setupPromise) {
    setupPromise = applySchemaIfNeeded().then(
      (result) => {
        if (result.applied) {
          console.log('[link][db] schema applied automatically')
        }
        return result
      },
      (err) => {
        console.error(
          '[link][db] could not apply the schema automatically:',
          err.message,
          '— continuing; run `npm run db:init` or open /api/init-db if requests fail.'
        )
        return { applied: false, error: err.message }
      }
    )
  }
  return setupPromise
}

export function query(text, params) {
  return ensureSchema()
    .then(() => getPool().query(text, params))
    .catch((err) => {
      throw decorate(err)
    })
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
  await ensureSchema()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // A rollback failure means the connection is already gone; the pool will
      // discard it. Nothing useful to do beyond not masking the original error.
    }
    throw decorate(err)
  } finally {
    client.release()
  }
}

/** Read and apply lib/schema.sql. Idempotent, so it is safe to call repeatedly. */
export async function applySchema(sql) {
  await getPool().query(sql)
}

/**
 * Is the schema in place?
 *
 * Used by /api/init-db to decide whether it is being asked to bootstrap an empty
 * database (allowed without a key, because creating empty tables from an additive
 * script gives an attacker nothing) or to re-run against a live one (key
 * required, because that is a maintenance action).
 */
export async function schemaExists() {
  const { rows } = await getPool().query(
    `SELECT 1
       FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'device_requests'
      LIMIT 1`
  )
  return rows.length > 0
}
