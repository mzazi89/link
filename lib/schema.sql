-- ─────────────────────────────────────────────────────────────────────────────
-- MZAZI LINK — schema
--
-- WHAT THIS FILE OWNS
--
--   device_credentials  one password per number; authorises removal
--   password_attempts   verification audit, and the per-IP guessing budget
--   request_log         every request this site raised, for throttling
--
-- WHAT IT DELIBERATELY DOES NOT TOUCH
--
--   bot_control, bot_status
--
-- Those two belong to quartz and are shared with quartzxd and the admin panel.
-- This site only reads and writes rows in them; it must never create or alter
-- them, because several services depend on their shape and one of them is not
-- the owner. If they are missing, the bot is not running yet — not this site's
-- problem to fix.
--
-- Superseded by the move onto bot_control: an earlier version of this file
-- created `device_requests` and `bot_sessions` as a private queue and session
-- register. Nothing reads them any more and they are no longer created. They are
-- left in place rather than dropped, because dropping a table is how you find
-- out months later that something still wanted it.
--
-- Every statement is idempotent, and the app applies this itself on first use —
-- see ensureSchema in lib/db.js. `npm run db:init` does the same thing
-- explicitly.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── Credentials ──────────────────────────────────────────────────────────────
-- One row per number that has a deletion password. The password is chosen when a
-- pairing is requested but is only inserted here once a pairing has genuinely
-- completed — see promoteCredential in lib/botControl.js for why that ordering
-- is load-bearing rather than fussy.
CREATE TABLE IF NOT EXISTS device_credentials (
  phone            TEXT PRIMARY KEY,
  password_hash    TEXT        NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_verified_at TIMESTAMPTZ,
  -- Per-number lockout, so online guessing against one number runs out of road
  -- even from a rotating IP.
  failed_attempts  SMALLINT    NOT NULL DEFAULT 0,
  locked_until     TIMESTAMPTZ
);

-- A credential is meaningless without a hash, and a hash of nothing would be a
-- silent bypass. Cheapest possible guard against that.
ALTER TABLE device_credentials DROP CONSTRAINT IF EXISTS device_credentials_hash_chk;
ALTER TABLE device_credentials ADD CONSTRAINT device_credentials_hash_chk
  CHECK (length(password_hash) > 0);

-- ── Verification attempts ────────────────────────────────────────────────────
-- Append-only. Counted by lib/rateLimit.js to throttle guessing from an IP
-- across many numbers, which the per-number lockout above cannot see.
CREATE TABLE IF NOT EXISTS password_attempts (
  id         BIGSERIAL PRIMARY KEY,
  phone      TEXT        NOT NULL,
  ip_hash    TEXT,
  success    BOOLEAN     NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS password_attempts_ip_recent_idx
  ON password_attempts (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS password_attempts_phone_recent_idx
  ON password_attempts (phone, created_at DESC);

-- ── Request log ──────────────────────────────────────────────────────────────
-- Written once per request this site acts on, accepted or not, so the request
-- throttle has something to count. A counter that only saw successes would be
-- trivial to stay under.
CREATE TABLE IF NOT EXISTS request_log (
  id         BIGSERIAL PRIMARY KEY,
  action     TEXT        NOT NULL,
  phone      TEXT        NOT NULL,
  ip_hash    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE request_log DROP CONSTRAINT IF EXISTS request_log_action_chk;
ALTER TABLE request_log ADD CONSTRAINT request_log_action_chk
  CHECK (action IN ('pair', 'unpair'));

CREATE INDEX IF NOT EXISTS request_log_ip_recent_idx
  ON request_log (ip_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS request_log_phone_recent_idx
  ON request_log (phone, created_at DESC);

-- ── Operator view ────────────────────────────────────────────────────────────
-- Every number with a real password, and whether it is currently locked out.
--
-- To find connected numbers that are still on a PRIMARY password, compare this
-- against the bot's own list — the view cannot do it for you, because it would
-- have to read bot_status, which this file must not depend on:
--
--   SELECT n.phone
--     FROM (SELECT json_array_elements_text(session_numbers::json) AS phone
--             FROM bot_status) n
--     LEFT JOIN device_credentials c ON c.phone = n.phone
--    WHERE c.phone IS NULL;
--
-- No bot_id filter: on a deployment with more than one bot, restricting this to
-- the primary row would miss every number the other bot holds. The numbers are
-- a set across all of them.
--
-- Deliberately a view rather than an API response: publishing which numbers rely
-- on a shared default would be handing out a list of targets, so the site never
-- exposes it and you check here instead.
--
-- CREATE OR REPLACE rather than DROP + CREATE: this script can run against a
-- live database, and dropping a view opens a window where readers fail. The
-- trade is that it cannot change a column's name or type — rename by hand if a
-- future version needs to.
CREATE OR REPLACE VIEW device_credentials_summary AS
SELECT
  phone,
  created_at,
  last_verified_at,
  failed_attempts,
  locked_until,
  (locked_until IS NOT NULL AND locked_until > now()) AS currently_locked
FROM device_credentials
ORDER BY created_at DESC;
