import Linker from '@/components/Linker'

const STEPS = [
  {
    n: '01',
    title: 'Enter your number',
    body: 'Pick your country and type the WhatsApp number you want to connect. Use the number that is actually on the phone — not a second number you have access to.',
  },
  {
    n: '02',
    title: 'Get a pairing code',
    body: 'We hand the request to the bot, which asks WhatsApp for an 8-character code. It appears on this page and is valid briefly.',
  },
  {
    n: '03',
    title: 'Link it from WhatsApp',
    body: 'Open WhatsApp, go to Linked devices, and choose "Link with phone number instead". Type the code when prompted.',
  },
  {
    n: '04',
    title: 'Done',
    body: 'This page confirms the moment the device connects. The bot keeps running in the background after you close the tab.',
  },
]

const NOTES = [
  {
    title: 'Keep WhatsApp open while you link',
    body: 'The code is entered on the phone itself, inside WhatsApp. If you close the app before entering it, the code expires and you will need a new one.',
  },
  {
    title: 'One number per request',
    body: 'Link them one at a time. Requesting a code for a second number while the first is pending will only slow both down.',
  },
  {
    title: 'Your number is not shown publicly',
    body: 'Requests are queued against a random reference and we store only a salted hash of the network address you came from. You can close this page at any time.',
  },
]

export default function HomePage() {
  const year = new Date().getFullYear()

  return (
    <main className="mx-auto w-full max-w-[720px] px-6 pb-24 sm:px-10">
      {/* ── Utility strip ──────────────────────────────────────────────────── */}
      <header className="flex items-center justify-between gap-4 border-b py-5 hairline">
        <div className="flex items-center gap-2.5">
          <svg
            width="16"
            height="16"
            viewBox="0 0 64 64"
            aria-hidden="true"
            className="shrink-0"
          >
            <path
              d="M36.5 9 L18 35.5 L29.5 35.5 L26.5 55 L46 27.5 L34.2 27.5 Z"
              fill="#DFA457"
            />
          </svg>
          <span className="font-mono text-[11px] uppercase tracking-label text-paper">
            MZAZI TECH
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber animate-pulse-soft"
            aria-hidden="true"
          />
          <span className="label">Link service</span>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────────── */}
      <section className="pt-14 sm:pt-20">
        <p className="label-amber">Device linking</p>
        <h1 className="mt-5 font-display text-[34px] font-medium leading-[1.1] tracking-tight text-paper sm:text-[46px]">
          Link your WhatsApp
          <br />
          to the bot.
        </h1>
        <p className="mt-6 max-w-[52ch] text-[15px] leading-relaxed text-paper-muted">
          No account, no password. Enter the number you want to connect and we
          will generate a pairing code. Type that code into WhatsApp and the
          device is linked.
        </p>
      </section>

      {/* ── The form / state machine ───────────────────────────────────────── */}
      <section className="mt-10">
        <Linker />
      </section>

      {/* ── How it works ───────────────────────────────────────────────────── */}
      <section className="mt-20">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-[15px] font-medium text-paper">
            How linking works
          </h2>
          <span className="label">Four steps</span>
        </div>
        <hr className="rule mt-4" />

        <ol className="mt-2">
          {STEPS.map((step) => (
            <li
              key={step.n}
              className="grid grid-cols-[2.5rem_1fr] gap-x-4 border-b py-5 hairline"
            >
              <span className="index-num pt-1">{step.n}</span>
              <div>
                <h3 className="text-[14px] font-medium text-paper">{step.title}</h3>
                <p className="mt-2 max-w-[54ch] text-[13.5px] leading-relaxed text-paper-muted">
                  {step.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* ── Notes ──────────────────────────────────────────────────────────── */}
      <section className="mt-16">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="font-display text-[15px] font-medium text-paper">
            Worth knowing
          </h2>
          <span className="label">Before you start</span>
        </div>
        <hr className="rule mt-4" />

        <div className="mt-2 grid gap-x-8 sm:grid-cols-2">
          {NOTES.map((note) => (
            <div key={note.title} className="border-b py-5 hairline">
              <h3 className="text-[14px] font-medium text-paper">{note.title}</h3>
              <p className="mt-2 text-[13.5px] leading-relaxed text-paper-muted">
                {note.body}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Footer ─────────────────────────────────────────────────────────── */}
      <footer className="mt-24 border-t pt-6 hairline">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-label text-paper-faint">
            MZAZI TECH INC — Power your digital world
          </span>
          <span className="font-mono text-[10px] uppercase tracking-label text-paper-faint">
            {year}
          </span>
        </div>
        <p className="mt-4 max-w-[62ch] text-[11.5px] leading-relaxed text-paper-faint">
          This service connects your WhatsApp account to an automation bot. Use it
          only with a number you own and control. This site is not affiliated
          with, endorsed by, or connected to WhatsApp.
        </p>
      </footer>
    </main>
  )
}
