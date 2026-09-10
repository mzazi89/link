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
        'Apply it with `npm run db:init` against DATABASE_URL, or POST to ' +
        '/api/init-db with the INIT_DB_KEY header if you cannot run scripts locally.'
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

export function query(text, params) {
  return getPool()
    .query(text, params)
    .catch((err) => {
      throw decorate(err)
    })
}

/** Run `fn` inside a transaction, rolling back on any throw. */
export async function withTransaction(fn) {
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
