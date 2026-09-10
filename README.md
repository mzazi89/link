# MZAZI LINK

A public, login-free site that pairs a WhatsApp number with the bot, shows every
connected device, and removes one — all through the same Neon database the rest
of the MZAZI stack already uses.

It speaks **`bot_control`** and **`bot_status`**, the two tables `quartz` already
maintains. That is the whole point of this version: it needs **no bot-side
changes at all**. Deploy it with `DATABASE_URL` and it works against the running
bot.

---

## Why that matters

The previous version of this repo invented its own queue (`device_requests`) and
its own session register (`bot_sessions`), then asked `quartz` to run a worker to
feed them. Nothing ever did, so pairing sat at *"waiting for the bot to pick up
your request"* forever.

`bot_control` and `bot_status` are tables the bot is **already** reading and
writing. Anything that speaks to them is a client of machinery that exists.

|  | old design | this |
|---|---|---|
| Pair | `device_requests` + a worker you had to wire up | `bot_control` row the bot already polls |
| Device list | `bot_sessions`, synced by `listSessions` | `bot_status`, written by the bot's own heartbeat |
| Remove | `device_requests` + a `deleteDevice` hook | `bot_control` row, `action='unpair'` |
| Bot changes needed | four hooks and a `start()` | **none** |

Same contract as `mzazi333-creator/quartzxd`, so the two are interchangeable
clients of one mechanism rather than two mechanisms.

---

## The contract

### Pairing

```sql
INSERT INTO bot_control (action, payload, status)
VALUES ('pair', '{"number":"254741388986","password_hash":"scrypt$…"}'::jsonb, 'pending')
RETURNING id;
```

Poll that id back; the bot writes `status` → `done` and the code into `result`:

```sql
SELECT id, action, status, payload, result, created_at, done_at
  FROM bot_control WHERE id = $1;
```

The `result` key is the bot's to name, and it has been spelled more than one way.
The extractor accepts `code`, `pairingCode` and `pairing_code`, and tolerates
`result` arriving as either a JSON string or already-parsed text.

`password_hash` is one key of ours that the bot ignores. It is where the deletion
password waits until the pairing genuinely succeeds — see below.

### Removal

```sql
INSERT INTO bot_control (action, payload, status)
VALUES ('unpair', '{"number":"254741388986","mode":"delete"}'::jsonb, 'pending');
```

`action` is `'unpair'`, **not** `'delete'`, and `mode: 'delete'` is what tells the
bot to wipe the session rather than merely log it out. Both match quartzxd, which
matches the bot.

### Devices

One row per bot in `bot_status`, keyed `bot_id = 'main'`, written by the bot's
heartbeat (`lib/botTelemetry.js` on the bot side):

| column | meaning |
|---|---|
| `online` | is the bot connected |
| `session_numbers` | JSON array of MSISDNs — the bot's real session folders |
| `devices_meta` | JSON object keyed by MSISDN → `{ online, battery, plugged, lastSeen }` |
| `ip_address` | the bot host's public IP |
| `last_seen_at` | when the heartbeat was last written |

Nothing here is trusted. A malformed blob degrades to "no telemetry" rather than
throwing, because a site that 500s on bad heartbeat JSON is worse than one that
shows a dash.

**A stale heartbeat is not reported as online.** If the row has not been written
for five minutes, the boolean inside it is history rather than status.

> **Battery and charging read `—` for now.** The current Baileys build does not
> report them. The pipeline is wired end to end, so the values light up on their
> own the moment it does.

---

## How fast a code appears

| Step | Typical | Bounded by |
|---|---|---|
| Site inserts the request | ~100ms | a Neon round trip |
| Bot notices it | **up to ~15s** | quartz's own `bot_control` poll |
| Bot asks WhatsApp for the code | 2–15s | WhatsApp |
| Page displays it | ≤2s | the page's poll |

**The ~15s is the honest number and you should plan around it.** It is quartz's
poll interval for `bot_control`, and this site cannot change it from outside.

If that is too slow, the seam is already in place: `notifyRequest()` sends a
Postgres `NOTIFY` on the `mzazi_bot_requests` channel after each request is
committed. Nothing listens yet, so those notifications are currently dropped —
but adding a `LISTEN` to the bot's `bot_control` consumer turns 15 seconds into
milliseconds **with no change on this side**. That is a three-line change in
`quartz`, and it is the single highest-value thing you could do to this flow.

---

## Passwords and removal

With no accounts, a per-number password is the only proof of ownership this site
can check before destroying something.

### Set at link time, real only on success

A user picks a password when requesting a code. It is hashed and staged on the
request row, and promoted into `device_credentials` **only once the pairing has
actually completed**.

Promoting on submission instead would be a hijack: anyone could claim a
stranger's number with their own password and then delete it. A pairing code can
only be entered on the phone that owns the number, so requiring `done` means
whoever set the password is whoever held the phone.

Two guards do the rest, and both are load-bearing:

- **`ORDER BY id ASC`** — the earliest completed request wins. If a second
  request for the same number also reaches `done`, the first owner's password is
  the one that sticks.
- **`ON CONFLICT DO NOTHING`** — a credential is never overwritten. A later
  success cannot take a number away from the person who already linked it.

Promotion runs both when the page sees `done` and **lazily on the removal path**,
so close the tab early and the password is still there when you come back.

### There is no reset

No reset email, no recovery question — there is no account to hang one on. The
practical answer is that re-linking from the phone sets a new one, and control of
the phone was always the real authority anyway.

### Numbers paired before this site existed

They have no credential, so `LEGACY_DEFAULT_PASSWORDS` (default `1234,0000`,
either accepted) authorises them. **This is a public master key** — anyone who
knows those four digits can delete any session without a real password. It is not
a secret once it is in a repository and used by a page with no login.

To close it out: relink those numbers, set real passwords, then set
`LEGACY_DEFAULT_PASSWORDS=""`. The query to find them is in the comment on the
operator view in `lib/schema.sql`.

### Failures are indistinguishable

A wrong password, a number that was never linked, and a number with no password
at all return the same status and the same message, and all three do the same
amount of hashing work. Otherwise this endpoint becomes a way to test whether any
given phone uses the service. The per-number lockout even reports itself as
`scope: 'ip'` so it cannot be told apart from the IP throttle.

---

## Masking

Numbers are shown with the middle hidden:

```
254741388986  →  254741****86
```

A fixed "first six" is fine on a 12-digit Kenyan number and far too generous on a
short one, so the reveal shrinks with length. Every result hides at least one
digit and preserves the length.

| Length | Result |
|---|---|
| 11+ | `254741388986` → `254741****86` |
| 9–10 | `447911123456` → `447911****56` |
| 7–8 | `12345678` → `123***78` |
| ≤6 | `123456` → `1****6` |

Two different numbers can mask to the **same** string — the hidden digits are
exactly the ones that differ, so `254741999986` and `254741888886` both render as
`254741****86`. The masked form therefore cannot identify a row, and each entry
carries a separate `id` (a truncated SHA-256 of the number) for that purpose and
for matching "the number I just paired" against the device list.

> **This list is public.** `GET /api/connected` takes no parameters, so anyone who
> loads the page sees every connected number, masked. They can count your
> customers. That is a deliberate change from the previous version, which scoped
> the list to the browser that created it.

---

## Abuse controls

Removing login removes the only thing that used to limit who could create a
session.

- **Per-IP throttle** — 5 requests / 15 min (default).
- **Per-phone throttle** — 3 requests / 60 min (default).
- **Salted IP hashes** — raw IPs are never written to the shared database, so the
  table cannot become a log of who visited. With no `IP_HASH_SALT` set, the salt
  is derived from `DATABASE_URL`, which keeps the per-IP count correct across
  serverless instances.
- **One live request per number** — two codes for one number would race, and only
  one can be entered.
- **Bot-offline short circuit** — a request is refused with a clear message rather
  than parked in front of a spinner.

---

## The schema applies itself

`DATABASE_URL` is the only variable you have to set. On first use the app checks
for its own three tables and creates any that are missing, so there is no
bootstrap step to forget.

It costs one catalog query per process, not per request — the DDL only runs when
something is genuinely absent, and it detects a *partial* schema, which is what an
upgrade looks like. `AUTO_MIGRATE=off` disables it.

**It only ever creates its own tables.** `bot_control` and `bot_status` belong to
`quartz` and are shared with the admin panel and quartzxd; this site reads and
writes rows in them and never creates or alters them. If they are missing, the
bot has not started — a different problem with a different fix.

---

## Environment

**Only `DATABASE_URL` is required.** Everything else has a working default.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **yes** | Neon connection string, shared with the bot and the other panels. |
| `CODE_TTL_MINUTES` | no | How long the page says a code is good for (default 3). Display only. |
| `LEGACY_DEFAULT_PASSWORDS` | no | Primary passwords for numbers with none (default `1234,0000`). Empty disables. |
| `RATE_LIMIT_IP_MAX` / `_WINDOW_MIN` | no | Per-IP request cap (default 5 per 15 min). |
| `RATE_LIMIT_PHONE_MAX` / `_WINDOW_MIN` | no | Per-number request cap (default 3 per 60 min). |
| `VERIFY_IP_MAX` / `_WINDOW_MIN` | no | Password guesses per IP (default 12 per 15 min). |
| `VERIFY_LOCKOUT_AFTER` / `_MINUTES` | no | Wrong guesses against one number before it locks (default 5, for 15 min). |
| `NOTIFY_CHANNEL` | no | Channel for the optional instant-pickup notification (default `mzazi_bot_requests`). |
| `AUTO_MIGRATE` | no | `off` stops the app creating missing tables. |
| `INIT_DB_KEY` | no | Only needed to **re-run** `/api/init-db` once the schema exists. |
| `NEXT_PUBLIC_BASE_URL` | no | Derived from Vercel's env on Vercel, localhost elsewhere. |
| `IP_HASH_SALT` | no | Set only to rotate the IP hash salt. |
| `PGSSL_STRICT` | no | `1` enforces full TLS chain verification. |

---

## Getting started

```bash
npm install
cp .env.example .env.local     # DATABASE_URL is the only value to fill in
npm run dev                    # http://localhost:3000
```

Deploy: new Vercel project, set `DATABASE_URL`, done. No other services.

### If a request sits at "not picked up yet"

The page says so itself after 25 seconds. It means the row is valid and nothing
has claimed it, which points at the bot, not at this page:

- Is `quartz` running, and does it poll `bot_control`?
- Is `bot_status.online` true and its `last_seen_at` recent? The header pill
  reports this — a stale heartbeat reads as offline on purpose.

---

## Layout

```
app/
  page.js                  → renders the one client component
  api/link/route.js        → POST queue a pairing
  api/unlink/route.js      → POST verify password, queue a removal
  api/requests/[id]/route.js → GET poll a request, by bot_control id
  api/connected/route.js   → GET connected numbers + telemetry, masked
  api/init-db/route.js     → apply the schema from the deployment
  fonts/                   → Space Grotesk, self-hosted (same files as quartzxd)
  globals.css              → QUARTZ XD's design system, plus a marked extension
components/
  LinkStation.jsx          → page shell, owns bot status + device list
  Linker.jsx               → both flows and the whole state machine
  DeviceList.jsx           → the device cards
lib/
  botControl.js            → the bot_control contract
  botStatus.js             → the bot_status contract
  password.js              → scrypt hashing, verification, strength policy
  legacyPassword.js        → the primary password
  credentials.js           → credential store + per-number lockout
  deviceKey.js             → the opaque row identity
  rateLimit.js             → request and verification throttles
  phone.js                 → E.164 normalisation and masking
  schema.sql               → the three tables this site owns
  db.js                    → pooled client; applies the schema on first use
```

`node_modules` carries no Tailwind: quartzxd has none, and two styling systems
would fight. `app/globals.css` is quartzxd's stylesheet verbatim, with every
addition quarantined below a marked line so the shared parts stay identical.

---

## Verified

- **49 assertions** against a real Postgres, driving the actual `lib/` modules
  over a socket: the pair and unpair insert shapes, `action='unpair'` and
  `mode:'delete'`, in-flight detection, code extraction across all three key
  spellings, `readRequest` on a JSON-string payload, credential promotion
  including the never-overwrite and earliest-wins guards, `clearStagedHash`
  leaving the number intact, heartbeat parsing with malformed `session_numbers`
  and `devices_meta`, non-numeric session entries dropped, stale-heartbeat
  handling, latest-row-wins, and proof that applying the schema creates exactly
  three base tables and never touches `bot_control` or `bot_status`.
- **26 assertions** on normalisation, masking, hashing and policy: the exact
  `254741****86` format plus length-based degradation, trunk zeros, a pasted
  international number overriding the selector, `00` prefixes, six malformed
  stored hashes returning `false` rather than throwing, real scrypt cost (~55ms),
  NFKC composed/decomposed equality, and all eight policy rejections including
  the three ways people write their own number.
- Build clean; `lib/schema.sql` traced into all five API routes; three TTFs in the
  build and no Google Fonts request left.

75 assertions in total.

---

<div align="center"><sub>MZAZI LINK — MZAZI TECH INC</sub></div>
