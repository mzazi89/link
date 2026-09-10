#!/usr/bin/env node
/**
 * Apply lib/schema.sql to the shared Neon database.
 *
 *   npm run db:init
 *
 * Idempotent — safe to run on every deploy. Reads DATABASE_URL from the
 * environment, falling back to .env.local / .env so it works without extra
 * tooling.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Pool } from 'pg'

const here = dirname(fileURLToPath(import.meta.url))

function loadEnvFile(name) {
  const path = resolve(here, '..', name)
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i.exec(line)
    if (!match) continue
    const [, key, value] = match
    if (process.env[key] !== undefined) continue
    // Strip surrounding quotes and any trailing comment.
    process.env[key] = value.replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '')
  }
}

loadEnvFile('.env.local')
loadEnvFile('.env')

const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  console.error(
    '[db:init] DATABASE_URL is not set.\n' +
      '          Copy .env.example to .env.local and paste the Neon connection\n' +
      '          string that quartz/ and web/ already use.'
  )
  process.exit(1)
}

const sql = readFileSync(resolve(here, '..', 'lib', 'schema.sql'), 'utf8')

const wantsSsl = /sslmode=require|sslmode=verify/i.test(connectionString)
const pool = new Pool({
  connectionString,
  max: 1,
  ssl: wantsSsl ? { rejectUnauthorized: process.env.PGSSL_STRICT === '1' } : undefined,
})

try {
  await pool.query(sql)
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM link_requests')
  console.log('[db:init] schema applied — link_requests holds', rows[0].n, 'row(s)')
} catch (err) {
  console.error('[db:init] failed:', err.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
