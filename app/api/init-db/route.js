import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { applySchema, query, schemaExists } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Apply lib/schema.sql to the configured database.
 *
 *   # empty database — no key needed, so DATABASE_URL can be the only var
 *   curl -X POST https://your-deployment/api/init-db
 *
 *   # once the schema exists, re-running it needs the key
 *   curl -X POST -H "x-init-key: $INIT_DB_KEY" https://your-deployment/api/init-db
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Deploying the site and applying the schema are two separate acts, and it is
 * easy to do the first without the second — the symptom is every request
 * returning 503 with `relation "..." does not exist` in the logs. Running
 * `npm run db:init` locally is the normal fix, but it requires the production
 * connection string on a machine with the repo checked out, which is awkward if
 * you are working from a phone or a panel.
 *
 * ── Safety ───────────────────────────────────────────────────────────────────
 *
 * Two modes, decided by whether the schema is already there:
 *
 *   missing → allowed with no configuration at all. Creating empty tables from
 *             an additive script gives an attacker nothing, and demanding a key
 *             just to bootstrap is friction with no security benefit. This is
 *             what lets DATABASE_URL be the only variable you have to set.
 *   present → requires INIT_DB_KEY, compared in constant time, so a live
 *             database never has an open DDL endpoint.
 *
 * The schema is purely additive: CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD
 * COLUMN IF NOT EXISTS, CREATE OR REPLACE VIEW, CREATE INDEX IF NOT EXISTS. It
 * never drops a table or a row, so even a leaked key cannot destroy data.
 */

// Hardcoded, so nothing here is interpolated from user input.
const TABLES = ['device_requests', 'device_credentials', 'password_attempts', 'bot_sessions']

function sameKey(a, b) {
  const left = Buffer.from(String(a ?? ''))
  const right = Buffer.from(String(b ?? ''))
  // timingSafeEqual requires equal lengths; the length check leaks only whether
  // someone guessed the right number of characters, which is not useful.
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

async function run(request) {
  const configured = process.env.INIT_DB_KEY || ''
  const url = new URL(request.url)
  // Header preferred — a key in a query string ends up in access logs.
  const supplied = request.headers.get('x-init-key') || url.searchParams.get('key') || ''

  let present
  try {
    present = await schemaExists()
  } catch (err) {
    console.error('[link][init-db] could not reach the database:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'unavailable',
        message: `Could not reach the database: ${err.message}`,
      },
      { status: 503, headers: NO_STORE }
    )
  }

  let bootstrapped = false

  if (configured) {
    if (!sameKey(supplied, configured)) {
      console.warn('[link][init-db] rejected: bad or missing key')
      return NextResponse.json(
        { ok: false, error: 'forbidden', message: 'Missing or incorrect INIT_DB_KEY.' },
        { status: 403, headers: NO_STORE }
      )
    }
  } else if (present) {
    // The schema is already there, so this is a maintenance re-run rather than a
    // bootstrap. Without a key configured we refuse, so that "forgot to set the
    // key" can never leave a permanently open DDL endpoint on a live database.
    return NextResponse.json(
      {
        ok: false,
        error: 'key_required',
        message:
          'The schema already exists, so re-running it needs authorisation. Set ' +
          'INIT_DB_KEY on this deployment, or use `npm run db:init` locally.',
      },
      { status: 403, headers: NO_STORE }
    )
  } else {
    // Bootstrapping an empty database. Deliberately allowed with no configuration
    // at all, because requiring a key to create the tables is friction with no
    // security benefit: the script is purely additive, it drops no table and no
    // row, and running it first gives an attacker nothing they could not get by
    // waiting. It also means DATABASE_URL can be the only variable you set.
    bootstrapped = true
    console.warn(
      '[link][init-db] bootstrapping an empty database with no INIT_DB_KEY configured'
    )
  }

  const sqlPath = path.join(process.cwd(), 'lib', 'schema.sql')

  let sql
  try {
    sql = await readFile(sqlPath, 'utf8')
  } catch (err) {
    console.error('[link][init-db] could not read schema:', err.message)
    return NextResponse.json(
      {
        ok: false,
        error: 'schema_unreadable',
        message: `Could not read ${sqlPath}: ${err.message}`,
      },
      { status: 500, headers: NO_STORE }
    )
  }

  try {
    await applySchema(sql)
  } catch (err) {
    console.error('[link][init-db] apply failed:', err.message)
    return NextResponse.json(
      { ok: false, error: 'failed', message: err.message },
      { status: 500, headers: NO_STORE }
    )
  }

  // Report what exists now, so the caller can confirm rather than assume. An
  // empty result here is the useful signal: the schema applied but the database
  // is the wrong one, or the bot has not synced anything yet.
  const tables = {}
  for (const table of TABLES) {
    try {
      const { rows } = await query(`SELECT count(*)::int AS n FROM ${table}`)
      tables[table] = rows[0].n
    } catch (err) {
      tables[table] = `error: ${err.message}`
    }
  }

  const host = String(process.env.DATABASE_URL || '')
    .replace(/^.*@/, '')
    .replace(/[/?].*$/, '')

  console.log('[link][init-db] schema applied to', host || '(unknown host)')

  return NextResponse.json(
    {
      ok: true,
      applied: true,
      bootstrapped,
      databaseHost: host || null,
      tables,
      note: bootstrapped
        ? 'Bootstrapped an empty database with no key configured. Re-running it ' +
          'later will need INIT_DB_KEY. The connected-numbers list stays empty ' +
          'until the bot syncs its session folders.'
        : 'Idempotent — safe to run again. The connected-numbers list stays empty ' +
          'until the bot syncs its session folders.',
    },
    { headers: NO_STORE }
  )
}

export const GET = run
export const POST = run
