# MZAZI TECH — Link a device

A public, login-free site whose only job is connecting a WhatsApp number to the
bot. The user enters their number, taps **Link device**, and gets an 8-character
pairing code to type into WhatsApp. There is no sign-up, no password, and no
session.

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
     │─────────────────────────>│                              │
     │                          │  INSERT link_requests        │
     │                          │  status = 'pending'          │
     │  { publicId }            │─────────────────────────────>│
     │<─────────────────────────│                              │
     │                          │              claim (SKIP LOCKED)
     │  GET /api/link/{id}      │                   status = 'processing'
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
     │<─────────────────────────│                              │
```

### Status lifecycle

| Status | Written by | Meaning |
|---|---|---|
| `pending` | site | Queued, no worker has touched it. |
| `processing` | bot | Claimed; the bot is asking WhatsApp for a code. |
| `ready` | bot | `pairing_code` is set. Waiting on the user. |
| `linked` | bot | The device connected. Terminal. |
| `failed` | bot | Gave up after `maxAttempts`. Terminal. |
| `expired` | bot (sweeper) or site | Window closed first. Terminal. |

The site also lazily expires rows it finds past `expires_at` while still in
`pending` — an unclaimed row would otherwise spin forever. It deliberately does
**not** touch `processing` or `ready` rows, because a worker may be mid-flight
and racing it would leave the row disagreeing with the socket.

---

## Quick start

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL and tune the limits
npm run db:init                # idempotent — applies lib/schema.sql
npm run dev                    # http://localhost:3000
```

`npm run db:init` must run against the **same** database `quartz/` and `web/`
use. `lib/schema.sql` is entirely idempotent, so it is safe to re-run on every
deploy.

### Environment

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string, shared with the bot and both panels. |
| `NEXT_PUBLIC_BASE_URL` | yes | Public URL of this deployment. |
| `RATE_LIMIT_IP_MAX` / `RATE_LIMIT_IP_WINDOW_MIN` | no | Per-IP cap (default 5 per 15 min). |
| `RATE_LIMIT_PHONE_MAX` / `RATE_LIMIT_PHONE_WINDOW_MIN` | no | Per-number cap (default 3 per 60 min). |
| `LINK_TTL_MINUTES` | no | How long a request stays alive (default 10). |
| `IP_HASH_SALT` | recommended | Salt for hashing caller IPs before storage. |
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

  // Optional but strongly recommended — without it rows stop at 'ready' and the
  // user never sees the success state.
  isLinked: async (msisdn) => sessionExists(msisdn) && isConnected(msisdn),

  // Optional side effects when a device connects.
  onLinked: async (msisdn) => {
    await recordLink(msisdn)
  },
})

await linkQueue.start()
```

The two hooks are injected rather than called directly because `whatsapp.js`
builds sockets differently for Telegram-sourced and WhatsApp-sourced sessions,
and the MZAZIBOT fork adds its own connection hooks. The queue mechanics are the
part that has to be exactly right, so that is what the module owns.

Tunables live in `DEFAULTS` in that file — `pollMs`, `maxAttempts`,
`codeTimeoutMs`, `batchSize`. Pairing is stateful, so `batchSize` defaults to 1
and attempts are serialised; raise it only if your pairing path is genuinely
concurrent.

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

---

## Abuse controls — read this before going public

Removing login removes the only thing that used to limit who could create a
session. What replaces it:

- **Per-IP throttle** — 5 requests / 15 min by default.
- **Per-phone throttle** — 3 requests / 60 min by default.
- **Salted IP hashes** — `ip_hash` is a SHA-256 of `salt:ip`. Raw IPs are never
  written to the shared database, so the table cannot be turned into a log of
  who visited.
- **Opaque references** — the browser polls a 24-character random `public_id`,
  never the row id, so the endpoint cannot be walked to read other people's
  codes.
- **Fail-closed** — if the throttle check cannot run, requests are refused
  rather than queued.

Two things this site deliberately does **not** do, and you should decide about:

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

---

## Files

```
app/
  page.js                  → the single page: hero, linker, how-it-works, notes
  layout.js                → document shell, fonts, metadata
  globals.css              → Ink & Bolt design tokens and component classes
  icon.svg                 → bolt monogram favicon
  api/link/route.js        → POST create a link request
  api/link/[publicId]/route.js → GET poll status + pairing code
components/
  Linker.jsx               → the whole state machine (client)
lib/
  schema.sql               → link_requests DDL (idempotent)
  db.js                    → pooled pg client, cached across hot reloads
  phone.js                 → E.164 normalization and validation
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
