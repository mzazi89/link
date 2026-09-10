-- ─────────────────────────────────────────────────────────────────────────────
-- MZAZI TECH — link site schema
--
-- Two things live here:
--
--   1. device_requests  — the queue between the public site and the quartz bot.
--                         ONE row per job, with `action` distinguishing a link
--                         from a delete. The site inserts; the bot claims and
--                         writes back.
--   2. device_credentials — the per-number password chosen at link time, which
--                         is the only thing that can authorise a later delete.
--
-- Every statement is idempotent, so this is safe to re-run against the shared
-- Neon database that web/, admin/ and quartz/ already live in.
--
--   npm run db:init        (or: psql "$DATABASE_URL" -f lib/schema.sql)
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Migration: link_requests → device_requests ───────────────────────────────
-- The table outgrew its original name once it started carrying deletes too.
-- Renaming keeps a single queue (one worker loop, one claim query, one set of
-- indexes) instead of two parallel tables with duplicated mechanics.
-- Guarded on both sides so it is a no-op on a fresh install and on re-runs.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'link_requests'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'device_requests'
  ) THEN
    ALTER TABLE link_requests RENAME TO device_requests;
  END IF;
END
$$;

-- ── The queue ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS device_requests (
  id            BIGSERIAL    PRIMARY KEY,

  -- Opaque handle handed to the browser. The browser never sees the row id, so
  -- it cannot enumerate other people's requests by counting upwards.
  public_id     TEXT         NOT NULL UNIQUE,

  -- 'link'   → pair a number to the bot (produces a pairing code)
  -- 'delete' → wipe the session for a number (authorised by password first)
  action        TEXT         NOT NULL DEFAULT 'link',

  -- WhatsApp MSISDN in JID form: country code + subscriber number, digits only,
  -- no '+' and no trunk zero. e.g. 254712345678
  phone         TEXT         NOT NULL,
  dial_code     TEXT,

  -- link:   pending → processing → ready → linked | failed | expired
  -- delete: pending → processing → completed | failed | expired
  --
  --   pending    → queued by the site, waiting for a bot worker
  --   processing → a worker claimed it and is working on it
  --   ready      → pairing_code is set, waiting for the user to type it
  --   linked     → the bot saw the device connect            (link, terminal)
  --   completed  → the bot wiped the session                 (delete, terminal)
  --   failed     → the bot could not complete it (see error) (terminal)
  --   expired    → expires_at passed first                   (terminal)
  status        TEXT         NOT NULL DEFAULT 'pending',

  -- The 8-character code WhatsApp generated. Written by the bot only.
  pairing_code  TEXT,
  error         TEXT,

  -- The scrypt hash of the password chosen for THIS link attempt. It is staging
  -- only: the bot promotes it into device_credentials once the device actually
  -- connects, then nulls it here.
  --
  -- Promoting on success rather than on submission is what makes the design
  -- safe. If the credential were written when the request arrived, anyone could
  -- "claim" a stranger's number by queueing a request with their own password
  -- and lock the real owner out of the number they own. Because a promotion
  -- only happens after a pairing code has been typed into the target phone, the
  -- person who ends up holding the password is provably holding the phone.
  password_hash TEXT,

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
  linked_at     TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ
);

-- Bring an already-renamed table up to date. On a fresh install these are no-ops.
ALTER TABLE device_requests ADD COLUMN IF NOT EXISTS action        TEXT;
ALTER TABLE device_requests ADD COLUMN IF NOT EXISTS completed_at  TIMESTAMPTZ;
ALTER TABLE device_requests ADD COLUMN IF NOT EXISTS password_hash TEXT;
UPDATE device_requests SET action = 'link' WHERE action IS NULL;

-- Status guard. Dropped and re-added so the constraint can evolve without a
-- migration tool; the table is small and this runs once per deploy.
ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS link_requests_status_chk;
ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS device_requests_status_chk;
ALTER TABLE device_requests ADD CONSTRAINT device_requests_status_chk
  CHECK (status IN ('pending', 'processing', 'ready', 'linked', 'completed', 'failed', 'expired'));

ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS link_requests_action_chk;
ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS device_requests_action_chk;
ALTER TABLE device_requests ADD CONSTRAINT device_requests_action_chk
  CHECK (action IN ('link', 'delete'));

-- A code may only exist once the bot has actually produced one. It is legal for
-- the row to then leave 'ready' by any route — 'linked' on success, or
-- 'expired'/'failed' if the window closed or pairing broke down — and keep the
-- code for the record. What must never happen is a code appearing while the row
-- is still 'pending' or 'processing', which would mean nobody issued it. A
-- delete never carries a code at all.
ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS link_requests_code_chk;
ALTER TABLE device_requests DROP CONSTRAINT IF EXISTS device_requests_code_chk;
ALTER TABLE device_requests ADD CONSTRAINT device_requests_code_chk
  CHECK (pairing_code IS NULL OR status IN ('ready', 'linked', 'expired', 'failed'));

-- Indexes carried over from the old name are dropped so we do not keep two
-- generations of the same index alive.
DROP INDEX IF EXISTS link_requests_queue_idx;
DROP INDEX IF EXISTS link_requests_phone_recent_idx;
DROP INDEX IF EXISTS link_requests_ip_recent_idx;
DROP INDEX IF EXISTS link_requests_expiry_idx;

-- Bot worker queue: partial index so the claim query touches only live work.
CREATE INDEX IF NOT EXISTS device_requests_queue_idx
  ON device_requests (action, created_at)
  WHERE status = 'pending';

-- Per-phone throttle lookups.
CREATE INDEX IF NOT EXISTS device_requests_phone_recent_idx
  ON device_requests (phone, created_at DESC);

-- Per-IP throttle lookups.
CREATE INDEX IF NOT EXISTS device_requests_ip_recent_idx
  ON device_requests (ip_hash, created_at DESC);

-- Expiry sweeper.
CREATE INDEX IF NOT EXISTS device_requests_expiry_idx
  ON device_requests (expires_at)
  WHERE status IN ('pending', 'processing', 'ready');

-- ── Device credentials ───────────────────────────────────────────────────────
-- The password a user sets when they first link a number. It authorises that
-- number's deletion later, which is the whole reason it exists: with no login,
-- this shared secret is the only proof of ownership the site can check.
--
-- Only the hash is stored. The format is self-describing (see lib/password.js),
-- so the scrypt cost can be raised later without invalidating existing rows.
CREATE TABLE IF NOT EXISTS device_credentials (
  phone            TEXT        PRIMARY KEY,
  password_hash    TEXT        NOT NULL,

  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,

  -- Per-credential lockout. A 128-bit-key KDF makes offline cracking hopeless,
  -- but it does nothing against someone guessing online one request at a time,
  -- so guessing is capped here.
  failed_attempts  SMALLINT    NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ
);

-- ── Verification audit ───────────────────────────────────────────────────────
-- Every password check, successful or not. Failed checks are the signature of
-- someone guessing, and this is what the per-IP throttle counts.
CREATE TABLE IF NOT EXISTS password_attempts (
  id         BIGSERIAL   PRIMARY KEY,
  phone      TEXT        NOT NULL,
  ip_hash    TEXT,
  success    BOOLEAN     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_attempts_ip_recent_idx
  ON password_attempts (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS password_attempts_phone_recent_idx
  ON password_attempts (phone, created_at DESC);

-- ── Operator views ───────────────────────────────────────────────────────────
DROP VIEW IF EXISTS link_requests_live;
DROP VIEW IF EXISTS device_requests_live;
CREATE VIEW device_requests_live AS
SELECT
  public_id,
  action,
  phone,
  status,
  attempts,
  claimed_by,
  created_at,
  expires_at,
  EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
FROM device_requests
WHERE status IN ('pending', 'processing', 'ready')
ORDER BY created_at DESC;

DROP VIEW IF EXISTS device_credentials_summary;
CREATE VIEW device_credentials_summary AS
SELECT
  phone,
  created_at,
  last_verified_at,
  failed_attempts,
  locked_until,
  (locked_until IS NOT NULL AND locked_until > now()) AS currently_locked
FROM device_credentials
ORDER BY created_at DESC;
