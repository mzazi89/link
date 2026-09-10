# MZAZI TECH — Link a device

A public, login-free site whose only job is connecting a WhatsApp number to the
bot — and disconnecting it again. The user enters their number, **sets a
password**, taps **Link device**, and gets an 8-character pairing code to type
into WhatsApp. There is no sign-up and no session.

That password is not a login. It is the per-number secret that authorises
**removing** the device later, which is the only way to protect a destructive
action on a site with no accounts. See [Passwords and
removal](#passwords-and-removal).

It is the fourth repo in the MZAZI TECH stack and it follows the same rule as the
others: **the shared Neon database is the only integration point.**

```
link (this repo)  → link.mzazi.shop        public linking page + queue writer
web/              → mzazi.shop             product site (login required)
admin/            → admin.mzazi.shop       standalone admin panel
quartz/           → WhatsApp × Telegram bot  ← consumes the queue
baileys/          → custom Baileys fork      ← issues the pairing code
                      └── all share the SAME Neon database
```

---

## The contract

The site and the bot never call each other. One table carries the whole
conversation:

```
  browser                link site (this repo)              quartz bot
     │                          │                              │
      │  POST /api/link          │                              │
      │  { phone, password }     │                              │
      │─────────────────────────>│                              │
      │                          │  INSERT device_requests      │
      │                          │  action = 'link'             │
      │                          │  status = 'pending'          │
      │  { publicId }            │─────────────────────────────>│
      │<─────────────────────────│                              │
      │                          │              claim (SKIP LOCKED)
      │  GET /api/requests/{id}  │                   status = 'processing'
      │─────────────────────────>│<─────────────────────────────│
      │  { status: 'pending' }   │                              │  requestPairingCode()
      │<─────────────────────────│                              │
      │        ⋮                 │              write code      │
      │                          │<─────────────────────────────│
      │                          │                   status = 'ready'
      │  { status: 'ready',      │                              │
      │    pairingCode }         │                              │
      │<─────────────────────────│                              │
      │   user types the code into WhatsApp                     │
      │                          │         device connected     │
      │                          │<─────────────────────────────│
      │  { status: 'linked' }    │                   status = 'linked'
      │<─────────────────────────│   + password promoted into   │
      │                          │     device_credentials       │
 ```

Deletion travels the same queue, having passed the password check first:

```
  browser                  link site                       quartz bot
     │                          │                              │
     │  POST /api/unlink        │                              │
     │  { phone, password }     │                              │
     │─────────────────────────>│                              │
     │                          │  verify against              │
     │                          │  device_credentials          │
     │                          │  (scrypt, constant time)     │
     │                          │                              │
     │                          │  wrong → 401, same message   │
     │                          │  and same work as "no such   │
     │                          │  device"; counter incremented│
     │                          │                              │
     │                          │  correct → INSERT            │
     │  { publicId }            │  action = 'delete'           │
     │<─────────────────────────│─────────────────────────────>│
     │  GET /api/requests/{id}  │        logout + wipe session │
     │─────────────────────────>│                              │
     │  { status:'completed' }  │                   status = 'completed'
     │<─────────────────────────│                              │
```

### Status lifecycle

| Action | Status | Written by | Meaning |
|---|---|---|---|
| link | `pending` | site | Queued, no worker has touched it. |
| link | `processing` | bot | Claimed; the bot is asking WhatsApp for a code. |
| link | `ready` | bot | `pairing_code` is set. Waiting on the user. |
| link | `linked` | bot | The device connected. **Terminal.** |
| delete | `pending` | site | Queued after the password check passed. |
| delete | `processing` | bot | Claimed; the session is being disconnected and wiped. |
| delete | `completed` | bot | The session is gone. **Terminal.** |
| either | `failed` | bot | Gave up after `maxAttempts`. **Terminal.** |
| either | `expired` | bot (sweeper) or site | Window closed first. **Terminal.** |

The site also lazily expires rows it finds past `expires_at` while still in
`pending` — an unclaimed row would otherwise spin forever. It deliberately does
**not** touch `processing` or `ready` rows, because a worker may be mid-flight
and racing it would leave the row disagreeing with the socket.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # DATABASE_URL is the only value you have to fill in
npm run dev                    # http://localhost:3000
```

Nothing else to do. `DATABASE_URL` must point at the **same** database `quartz/`
and `web/` use, and the app creates its own tables on first use — see
[First deploy](#first-deploy-the-schema-applies-itself). `npm run db:init` still
works if you would rather apply the schema explicitly; `lib/schema.sql` is
idempotent either way.

> **Upgrading from an earlier version of this schema?** Re-run `npm run db:init`.
> It renames `link_requests` to `device_requests` and adds the `action` and
> `password_hash` columns inside a guarded `DO` block, so it is a no-op on a
> fresh install and safe on an existing one. Any rows already in the table come
> through as `action = 'link'`. The same run creates `bot_sessions`, which is
> where the connected-numbers list comes from — until the bot starts syncing
> into it, that list will be empty.

### Environment

**Only `DATABASE_URL` is required.** Every other variable has a working default,
so a deployment with nothing but the connection string behaves correctly.

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | **yes** | Neon connection string, shared with the bot and both panels. |
| `NEXT_PUBLIC_BASE_URL` | no | Derived from `VERCEL_PROJECT_PRODUCTION_URL` (or `VERCEL_URL` for previews), falling back to localhost. Set only to force a custom domain. |
| `INIT_DB_KEY` | no | Needed only to **re-run** `/api/init-db` once the schema exists. The first run needs no key. |
| `AUTO_MIGRATE` | no | Set to `off` to stop the app creating missing tables on first use. Only useful if your database user has no DDL rights. |
| `LEGACY_DEFAULT_PASSWORDS` | no | Primary passwords for numbers that have none (default `1234,0000`). Empty disables the fallback. |
| `RATE_LIMIT_IP_MAX` / `RATE_LIMIT_IP_WINDOW_MIN` | no | Per-IP cap (default 5 per 15 min). |
| `RATE_LIMIT_PHONE_MAX` / `RATE_LIMIT_PHONE_WINDOW_MIN` | no | Per-number cap (default 3 per 60 min). |
| `LINK_TTL_MINUTES` | no | How long a request stays alive (default 10). |
| `NOTIFY_CHANNEL` | no | Postgres channel the bot listens on for instant pickup (default `mzazi_device_requests`). Must match the bot's value. |
| `VERIFY_IP_MAX` / `VERIFY_IP_WINDOW_MIN` | no | Password guesses per IP across all numbers (default 12 per 15 min). |
| `VERIFY_LOCKOUT_AFTER` / `VERIFY_LOCKOUT_MINUTES` | no | Wrong guesses against one number before it locks (default 5, for 15 min). |
| `VERIFY_LOG_RETENTION_DAYS` | no | How long `password_attempts` is kept (default 7). |
| `IP_HASH_SALT` | no | Salt for hashing caller IPs. Unset, it is derived from `DATABASE_URL` — stable across instances, so the per-IP throttle stays correct. Set it only to rotate the salt. |
| `PGSSL_STRICT` | no | Set to `1` to enforce full TLS chain verification. |

---

## Wiring up the bot

Copy `bot/linkQueue.js` into the quartz repo and start it after the bots boot:

```js
const { Pool } = require('pg')
const { createLinkQueue } = require('./lib/linkQueue')

const linkPool = new Pool({ connectionString: process.env.DATABASE_URL })

const linkQueue = createLinkQueue({
  pool: linkPool,

  // Only quartz knows how its socket layer is built. Open a fresh, UNPAIRED
  // socket for this number and return the code the fork hands back.
  generatePairingCode: async (msisdn) => {
    const sock = await createPairingSocket(msisdn)
    return await sock.requestPairingCode(msisdn)
  },

  // Required. Without it rows stop at 'ready', the user never sees the success
  // state, AND no deletion password is ever set — because promotion happens here.
  isLinked: async (msisdn) => sessionExists(msisdn) && isConnected(msisdn),

  // Required to serve delete requests. Mirror the existing semantics: unlink
  // logs the device out, delete then removes the session folder.
  deleteDevice: async (msisdn) => {
    await logoutSession(msisdn)
    await rmSessionFolder(msisdn)
  },

  // Required for the website's connected-numbers list. Return the MSISDNs the
  // bot currently holds a session folder for — anything missing here is
  // invisible to the site.
  listSessions: async () => {
    const entries = await fs.readdir(SESSIONS_DIR, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  },

  // Optional side effects when a device connects.
  onLinked: async (msisdn) => {
    await recordLink(msisdn)
  },
})

await linkQueue.start()
```

The hooks are injected rather than called directly because `whatsapp.js`
builds sockets differently for Telegram-sourced and WhatsApp-sourced sessions,
and the MZAZIBOT fork adds its own connection hooks. The queue mechanics are the
part that has to be exactly right, so that is what the module owns.

`deleteDevice` should **reject** if the wipe genuinely failed, so the row is
retried rather than reported as done. Treating "I could not delete the folder"
as success is the one way this flow can silently lie to a user.

Tunables live in `DEFAULTS` in that file — `pollMs`, `maxAttempts`,
`codeTimeoutMs`, `deleteTimeoutMs`, `batchSize`. Pairing is stateful, so
`batchSize` defaults to 1 and attempts are serialised; raise it only if your
pairing path is genuinely concurrent.

### The one step that is easy to miss

`promoteCredential` is called automatically the moment `isLinked` reports true.
It copies the `password_hash` staged on the request into `device_credentials`
and then nulls it on the request. If you write your own worker instead of using
this module, that promotion is the part to replicate — skip it and every number
will link fine, be impossible to remove, **and never appear in the connected
list**, because that table is also the register the site reads.

Its counterpart is `clearCredential`, called on the delete path after the
session is wiped. Both halves are needed: promotion without clearing leaves
removed devices showing as connected forever.

It is also guarded so an old request cannot clobber a newer credential:

```sql
ON CONFLICT (phone) DO UPDATE
   SET password_hash = EXCLUDED.password_hash, ...
 WHERE device_credentials.updated_at < (
   SELECT created_at FROM device_requests WHERE id = $1
 )
```

---

## Deployment

1. Push this repo and add it as a **new Vercel project**.
2. Set `DATABASE_URL` (identical to the other three services) and the rest of
   the env vars.
3. Run `npm run db:init` once against that database.
4. Optionally bind it to `link.mzazi.shop`.

Security headers and `Cache-Control: no-store` on `/api/*` are set in
`next.config.js` — a cached "ready" response would hand someone a code that has
already rotated.

### First deploy: the schema applies itself

Deploying the code and initialising the database used to be two separate acts, and
doing the first without the second was the most common way to end up with a site
that 503s on everything. It no longer is: on the first request, the app checks for
its tables and creates any that are missing.

The cost is one catalog query per process, not per request — the full schema runs
only when something is genuinely absent. `AUTO_MIGRATE=off` turns it off entirely
if you would rather migrations were a deliberate, separate act.

Two properties are what make this safe to do without asking:

- **Additive.** `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN IF NOT
  EXISTS`, `CREATE OR REPLACE VIEW`, `CREATE INDEX IF NOT EXISTS`. It never drops
  a table or a row, so re-running it cannot destroy anything.
- **Serialised.** Several instances booting at once would race on `CREATE TABLE`
  and fail with duplicate-key errors against the system catalogs. They take a
  Postgres advisory lock first, re-check inside it, and give up after 5s rather
  than block a request.

If a missing-schema error still appears, the cause is now logged rather than fatal,
and one of these will tell you which:

```
# the database user lacks DDL rights, or schema.sql did not ship:
DATABASE_URL="postgresql://..." npm run db:init   # locally
https://<your-deployment>/api/init-db             # from the deployment
```

That endpoint is deliberately asymmetric. While the schema is missing it needs no
key at all — bootstrapping an empty database with an additive script gains an
attacker nothing, and demanding a key just to bootstrap is friction with no
benefit. Once the tables exist it refuses unauthenticated calls, so re-running it
later needs `INIT_DB_KEY`:

```
curl -X POST -H "x-init-key: <value>" https://<your-deployment>/api/init-db
```

`/api/init-db` and `npm run db:init` both finish with a per-table row count.
**Read that output rather than assuming**: if it succeeds but `bot_sessions` is 0,
the schema is fine and the missing piece is the bot's `listSessions` sync.

A key in a query string lands in access logs, so prefer the header when you use one.

---

## How fast a code appears, and what decides it

The whole budget, end to end:

| Step | Typical | Bounded by |
|---|---|---|
| Site inserts the request | ~100ms | a Neon round trip |
| Bot notices it | **~10ms** | Postgres `NOTIFY` |
| Bot asks WhatsApp for the code | 2–15s | WhatsApp, not us |
| Bot writes the code back | ~100ms | a Neon round trip |
| User's page displays it | ≤1.2s | the client poll |

So what decides whether you wait 5 seconds or 25 is **WhatsApp issuing the code**.
Everything on this side is sub-second.

### The bot is woken, not polled

Polling puts a floor on latency: a user waits, on average, half an interval before
a worker even looks at their request. Instead the site sends `pg_notify` the moment
a row is committed and the bot is `LISTEN`ing for it.

The poll has not gone away — it has been demoted to a safety net for a dropped
connection. If the listener dies the worker reconnects after 5s, and the poll
underneath still finds the row, so correctness never rests on a side channel.

That is why the poll interval is adaptive: **2s** while the listener is healthy and
**1s** when it is not, because then the poll *is* the mechanism.

### One deployment detail that matters

**Point the bot at the direct connection string, not `-pooler`.**

Neon's pooled endpoint runs PgBouncer in transaction mode, which does not preserve
session state. `LISTEN` there does not error — it silently never delivers, because
the session that subscribed is not the session that later carries the notify. A
silent failure is the worst shape, so the worker detects a `-pooler` hostname and
refuses to depend on it: it logs a warning and falls back to fast polling.

`SELECT pg_notify` from the site is unaffected either way — one statement, no
session state to lose.

### If a request sits at "waiting for the bot"

That status means `pending`: the row exists and is valid, but nothing has claimed
it. It is not a latency problem, and no interval tuning will help. Either the
bot-side worker is not running, or `linkQueue.start()` was never called.

The page says so itself after 15 seconds, and the bot log is the place to confirm:

```
[linkQueue] listening on mzazi_device_requests — requests picked up immediately
[linkQueue] claim <ref> [link] → +••••••8399 (attempt 1)
```

If the first line is missing, the listener did not start. If both are missing, the
worker is not running.

---

## Passwords and removal

With no accounts, a per-number password is the only proof of ownership the site
can check before destroying something. Three decisions define it.

### 1. The password is set at link time, and only becomes real on success

A user picks a password while requesting a pairing code. It is hashed and stored
**on the request row**, and the bot promotes it into `device_credentials` only
after the device actually connects.

Promoting on submission instead would be a hijack primitive: anyone could queue
a request for a stranger's number with their own password, and the real owner
would then be permanently locked out of the number they own. Because promotion
waits for a pairing code to be typed into the target phone, whoever holds the
password is provably holding the phone.

This also gives a natural recovery path. There is no reset email — there is no
account to send one to — but re-linking from the phone always sets a new
password, and control of the phone is the real authority anyway.

### 2. Hashing is scrypt from `node:crypto`

No dependency, and no native build — the same class of problem the quartz repo
works around by blocking the `sharp` peer. The stored format is
self-describing:

```
scrypt$N$r$p$<base64 salt>$<base64 hash>
```

so the cost parameters can be raised later without invalidating any existing
row. Current parameters are `N=16384, r=8, p=1` — about 16 MiB and ~55 ms per
hash. That is below OWASP's headline scrypt figure (N=2^17), which would cost
128 MiB per concurrent request and is not a reasonable ask of a serverless
function. The trade is documented in `lib/password.js`.

Verification is constant-time (`timingSafeEqual`), inputs are NFKC-normalised so
a password typed on a phone matches the same password typed on a laptop, and
parameters read back out of the database are bounded — otherwise a tampered row
could specify an enormous `N` and turn one login attempt into a memory
exhaustion attack.

### 3. Failures are indistinguishable from "no such device"

A wrong password and a number that was never linked return the **same status,
the same message, and the same amount of cryptographic work** (`burnVerificationTime`).
Otherwise the response would reveal whether a given phone number uses the
service.

The lockout is reported as `rate_limited` with `scope: 'ip'` even when it was
really the per-number lockout, so the two cannot be told apart from outside.

### 4. Numbers paired before this site existed use a primary password

Sessions that already existed were paired when nobody was asked for a password.
Without a fallback they would be permanently un-deletable through this page, so
`LEGACY_DEFAULT_PASSWORDS` (default `1234,0000`, either accepted) authorises them.

**This is a public master key, and it is worth being blunt about it.** Anyone who
knows those four digits can delete any session that has no password of its own.
It is not a secret once it lives in a repository and is used by a page with no
login. Two consequences follow:

- It identifies legacy sessions. A wrong password and an unknown number return an
  identical 401, so the failure path leaks nothing — but a *correct* `1234` tells
  the caller that number is a session. That is a small disclosure the shared
  default creates and the real-credential path does not have.
- There is no per-number lockout on this path, because there is no credential row
  to count against. Only the per-IP throttle applies. That is tolerable precisely
  because the password is not a secret — but if you ever set it to something
  meaningful, add the lockout first.

The way out is to convert the numbers:

```sql
SELECT phone FROM bot_sessions_active WHERE has_password = false;
```

Relink those through this page, set a real password, and they stop accepting the
defaults. Once that query returns nothing, set `LEGACY_DEFAULT_PASSWORDS=""` to
switch the fallback off. That is the correct end state.

The fallback only ever applies to a number that is an **active session**. An
unknown number gets the same burn-time treatment and the same 401 as a wrong
password, so this cannot be used to probe numbers the bot has never seen.

---

## Connected numbers

The page lists every number the bot currently holds a session for, with the
middle digits hidden:

```
254741388986  →  254741****86
```

### ⚠ This list is public

There is no login and `GET /api/connected` takes no parameters, so **anyone who
opens the page sees every connected number**. Be clear-eyed about what that
means:

- A visitor can count your customers and watch the count grow.
- The mask keeps six leading and two trailing digits, so a specific entry can be
  narrowed substantially by anyone who already half-knows a number.
- A raw number is never sent — but a partial number is, and that is a real
  exposure, not a theoretical one.

If that is not acceptable, this endpoint is the one to gate. The earlier
browser-scoped variant (each visitor saw only what they had linked) is in the
git history if you want it back.

### Where the list comes from

Not from the site. The session folders live on the bot's host inside
`database/sessions/`, and this deployment is serverless with no filesystem
access to them. So the bot publishes what it finds:

```
bot's database/sessions/*  →  listSessions()  →  bot_sessions table  →  GET /api/connected
```

The worker re-scans on an interval (`sessionSyncMs`, default 60s), upserts every
number it finds, and stamps `removed_at` on anything no longer present. Rows are
never deleted, so a number that comes back clears the stamp.

**Whatever the bot does not report simply does not appear.** If the list is empty
on a busy bot, the problem is almost always `listSessions` — not this site.

One guard matters more than the rest: **an empty scan is ignored**. Empty almost
always means the session directory could not be read (wrong working directory,
permissions, an unmounted volume) rather than every user unlinking at once.
Acting on it would wipe the whole public list, so the sync refuses and logs a
warning instead. Recovery is automatic on the next good scan.

### Masking tiers

A fixed "first six" is reasonable on a 12-digit Kenyan number and far too
generous on an 8-digit one, so the reveal shrinks with the number:

| Length | Keeps | Example |
|---|---|---|
| 11+ | first 6, last 2 | `254741388986` → `254741****86` |
| 9–10 | first 4, last 2 | `447911123456` → `447911****56` |
| 7–8 | first 3, last 2 | `12345678` → `123***78` |
| ≤ 6 | first 1, last 1 | `123456` → `1****6` |

Every result hides at least one digit and preserves the length, so the shape of
the number is still recognisable to its owner.

### Why the rows are keyed on a hash

Two different numbers can mask to the *same* string — the hidden digits are
exactly the ones that differ, so `254741999986` and `254741888886` both render as
`254741****86`. The masked form therefore cannot identify a row. Each entry
carries an `id` derived from a SHA-256 of the number, which is stable across
refreshes and unique even when the masks collide.

That id is not a privacy control, and does not pretend to be: the masked number
sits beside it in the same response, so reversing it reveals nothing the row does
not already show.

---

## Abuse controls — read this before going public

Removing login removes the only thing that used to limit who could create a
session. What replaces it:

- **Per-IP throttle** — 5 requests / 15 min by default.
- **Per-phone throttle** — 3 requests / 60 min by default.
- **Verification throttle** — 12 failed password guesses per IP per 15 min,
  across all numbers. This catches someone spreading a few guesses over many
  numbers, which the per-number lockout would never notice.
- **Per-number lockout** — 5 wrong guesses locks that number for 15 min. scrypt
  makes offline cracking hopeless but does nothing against online guessing, so
  guessing is capped directly.
- **Salted IP hashes** — `ip_hash` is a SHA-256 of `salt:ip`. Raw IPs are never
  written to the shared database, so the table cannot be turned into a log of
  who visited.
- **Opaque references** — the browser polls a 24-character random `public_id`,
  never the row id, so the endpoint cannot be walked to read other people's
  codes.
- **Fail-closed** — if a throttle check cannot run, requests are refused rather
  than queued or verified.

Three things this site deliberately does **not** do, and you should decide about:

1. **It does not check whether the number is already linked.** The endpoint is
   unauthenticated, so a "that number is already linked" reply would turn it into
   a free oracle for testing whether any given phone number uses the service.
   Requests are queued regardless and the bot decides — it can see its own
   session folders.

2. **It bypasses your subscription and device limits.** This is the one to think
   about. On `web/`, a Free user is capped at one device and paid plans gate the
   rest; this site has no idea which plan a number is on, and it does not ask.
   Anyone with a URL can queue pairing requests here.

   If you want those limits to keep meaning something, enforce them in the bot's
   `generatePairingCode` hook — it is the only place in this flow that can see
   the `users` / `subscriptions` tables and the session folder count. Return a
   rejected promise and the row lands in `failed` with your message shown to the
   user.

3. **The password only gates deletion initiated from this page.** Deletion also
   exists elsewhere in your stack — `/delpair` and `.delpair` on the bot, and
   the admin panel's Sessions screen — and none of those read
   `device_credentials`. So today a user can still wipe their own session by
   command without knowing the password, and an admin bypasses it entirely.

   That may be exactly what you want (the admin *should* bypass it; a user
   deleting their own device by command is harmless). But if the password is
   meant to be the single authority for removal, the bot's delete commands need
   to verify against `device_credentials` too. The hashing is in
   `lib/password.js` and the lookup is a single indexed read — copy
   `lib/password.js` and `lib/credentials.js` into quartz and call
   `loadCredential` + `verifyPassword` before the wipe. Ask me and I'll wire it.

---

## Files

```
app/
  page.js                  → the single page: hero, linker, how-it-works, notes
  layout.js                → document shell, fonts, metadata
  globals.css              → Ink & Bolt design tokens and component classes
  icon.svg                 → bolt monogram favicon
  api/link/route.js        → POST create a link request (requires a password)
  api/unlink/route.js      → POST verify the password, queue a delete
  api/requests/[publicId]/route.js → GET poll status, action + pairing code
  api/connected/route.js   → GET every connected session, masked
components/
  Linker.jsx               → the whole state machine (client)
  DeviceList.jsx           → the masked connected-numbers list
lib/
  schema.sql               → device_requests + device_credentials + bot_sessions
  password.js              → scrypt hashing, verification, strength policy
  credentials.js           → credential store + per-number lockout
  legacyPassword.js        → the primary password for numbers that have none
  sessions.js              → reading the session register, list keys
  db.js                    → pooled pg client, cached across hot reloads
  phone.js                 → E.164 normalization, display masking
  countries.js             → dial codes for the selector
  rateLimit.js             → DB-backed throttling + IP hashing
  pairingCode.js           → code formatting for display
bot/
  linkQueue.js             → DROP-IN for the quartz repo
scripts/
  init-db.mjs              → applies schema.sql
```

The palette and typography follow the **Ink & Bolt** direction already used
across `web/` and `admin/` — warm charcoal, amber and cobalt, hairline rules,
Space Grotesk / Manrope / IBM Plex Mono. The tokens live in `tailwind.config.js`
and `app/globals.css`; swap in the real values from `web/globals.css` if you want
them byte-identical.

---

MZAZI TECH INC — Power your digital world.

This service is not affiliated with, endorsed by, or connected to WhatsApp.
