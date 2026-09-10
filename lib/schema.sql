-- ─────────────────────────────────────────────────────────────────────────────
-- MZAZI TECH — link site schema
--
-- This table is the ONLY interface between the public linking site and the
-- quartz bot. The site inserts; the bot claims, pairs, and writes back.
-- Every statement is idempotent so it is safe to re-run against the shared
-- Neon database that web/, admin/ and quartz/ already live in.
--
--   npm run db:init        (or: psql "$DATABASE_URL" -f lib/schema.sql)
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS link_requests (
  id            BIGSERIAL    PRIMARY KEY,

  -- Opaque handle handed to the browser. The browser never sees the row id, so
  -- it cannot enumerate other people's requests by counting upwards.
  public_id     TEXT         NOT NULL UNIQUE,

  -- WhatsApp MSISDN in JID form: country code + subscriber number, digits only,
  -- no '+' and no trunk zero. e.g. 254712345678
  phone         TEXT         NOT NULL,
  dial_code     TEXT,

  -- pending    → queued by the site, waiting for a bot worker
  -- processing → a bot worker claimed it and is generating the pairing code
  -- ready      → pairing_code is set, waiting for the user to type it in WhatsApp
  -- linked     → the bot saw the device connect
  -- failed     → the bot could not complete it (see error)
  -- expired    → expires_at passed before it completed
  status        TEXT         NOT NULL DEFAULT 'pending',

  -- The 8-character code WhatsApp generated. Written by the bot only.
  pairing_code  TEXT,
  error         TEXT,

  -- Abuse forensics. ip_hash is salted+hashed; we never store a raw IP.
  ip_hash       TEXT,
  user_agent    TEXT,

  -- How many times a worker has picked this row up. Lets the bot give up after
  -- repeated failures instead of looping on one bad number forever.
  attempts      SMALLINT     NOT NULL DEFAULT 0,

  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL DEFAULT (now() + interval '10 minutes'),

  -- Claim bookkeeping, so an operator can tell which bot instance handled what.
  claimed_at    TIMESTAMPTZ,
  claimed_by    TEXT,

  code_ready_at TIMESTAMPTZ,
  linked_at     TIMESTAMPTZ
);

-- Status guard. Dropped and re-added so the constraint can evolve without a
-- migration tool; the table is small and this runs once per deploy.
ALTER TABLE link_requests DROP CONSTRAINT IF EXISTS link_requests_status_chk;
ALTER TABLE link_requests ADD CONSTRAINT link_requests_status_chk
  CHECK (status IN ('pending', 'processing', 'ready', 'linked', 'failed', 'expired'));

-- A code may only exist once the bot has actually produced one. It is legal for
-- the row to then leave 'ready' by any route — 'linked' on success, or
-- 'expired'/'failed' if the window closed or pairing broke down — and keep the
-- code for the record. What must never happen is a code appearing while the row
-- is still 'pending' or 'processing', which would mean nobody issued it.
ALTER TABLE link_requests DROP CONSTRAINT IF EXISTS link_requests_code_chk;
ALTER TABLE link_requests ADD CONSTRAINT link_requests_code_chk
  CHECK (pairing_code IS NULL OR status IN ('ready', 'linked', 'expired', 'failed'));

-- Bot worker queue: partial index so the claim query touches only live work.
CREATE INDEX IF NOT EXISTS link_requests_queue_idx
  ON link_requests (created_at)
  WHERE status = 'pending';

-- Per-phone throttle lookups.
CREATE INDEX IF NOT EXISTS link_requests_phone_recent_idx
  ON link_requests (phone, created_at DESC);

-- Per-IP throttle lookups.
CREATE INDEX IF NOT EXISTS link_requests_ip_recent_idx
  ON link_requests (ip_hash, created_at DESC);

-- Expiry sweeper.
CREATE INDEX IF NOT EXISTS link_requests_expiry_idx
  ON link_requests (expires_at)
  WHERE status IN ('pending', 'processing', 'ready');

-- ─────────────────────────────────────────────────────────────────────────────
-- Operator convenience: requests still in flight, newest first.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW link_requests_live AS
SELECT
  public_id,
  phone,
  status,
  attempts,
  claimed_by,
  created_at,
  expires_at,
  EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
FROM link_requests
WHERE status IN ('pending', 'processing', 'ready')
ORDER BY created_at DESC;
