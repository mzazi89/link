import { timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { NextResponse } from 'next/server'

import { applySchema, query } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

/**
 * Apply lib/schema.sql to the configured database.
 *
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
 * Requires INIT_DB_KEY to be set on the deployment, and refuses when it is not —
 * failing closed, so forgetting to configure it can never leave this open. The
 * key is compared in constant time.
 *
 * The schema is purely additive: CREATE TABLE IF NOT EXISTS, ALTER TABLE ADD
 * COLUMN IF NOT EXISTS, and view/index replacement. It never drops a table or a
 * row, so even a leaked key cannot destroy data. It can only bring the database
 * up to the shape the code expects.
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
  const configured = process.env.INIT_DB_KEY
  if (!configured) {
    return NextResponse.json(
      {
        ok: false,
        error: 'not_enabled',
        message:
          'Set INIT_DB_KEY on this deployment to enable schema initialisation, or ' +
          'run `npm run db:init` locally instead.',
      },
      { status: 503, headers: NO_STORE }
    )
  }

  const url = new URL(request.url)
  // Header preferred — a key in a query string ends up in access logs.
  const supplied = request.headers.get('x-init-key') || url.searchParams.get('key') || ''

  if (!sameKey(supplied, configured)) {
    console.warn('[link][init-db] rejected: bad or missing key')
    return NextResponse.json(
      { ok: false, error: 'forbidden', message: 'Missing or incorrect INIT_DB_KEY.' },
      { status: 403, headers: NO_STORE }
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
      databaseHost: host || null,
      tables,
      note:
        'Idempotent — safe to run again. The connected-numbers list stays empty ' +
        'until the bot syncs its session folders.',
    },
    { headers: NO_STORE }
  )
}

export const GET = run
export const POST = run
