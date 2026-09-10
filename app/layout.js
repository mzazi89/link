import localFont from 'next/font/local'

import './globals.css'

/**
 * IBM Plex Mono, self-hosted, and used for EVERYTHING — headings, body, labels,
 * numbers. A monospace display face is the whole point here: it is what gives
 * the page its terminal character, and it is already the mono in the MZAZI
 * design system, so this is that identity applied consistently rather than a new
 * one bolted on.
 *
 * Self-hosted rather than fetched, for the same reason quartzxd ships its own
 * type: no third-party request on load, no layout shift, and a build that does
 * not depend on Google being reachable.
 */
const plexMono = localFont({
  src: [
    { path: './fonts/IBMPlexMono-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/IBMPlexMono-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/IBMPlexMono-Bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-plex',
  display: 'swap',
  fallback: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
})

/**
 * Absolute URL used for metadata (canonical links, Open Graph).
 *
 * Resolved from the platform rather than demanded as configuration, so that
 * DATABASE_URL really is the only variable you have to set. Order:
 *
 *   NEXT_PUBLIC_BASE_URL           explicit override, e.g. a custom domain
 *   VERCEL_PROJECT_PRODUCTION_URL  the stable production domain
 *   VERCEL_URL                     this deployment (right for previews)
 *   localhost
 */
function resolveBaseUrl() {
  if (process.env.NEXT_PUBLIC_BASE_URL) return process.env.NEXT_PUBLIC_BASE_URL
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  if (host) return `https://${host}`
  return 'http://localhost:3000'
}

const baseUrl = resolveBaseUrl()

const TITLE = 'MZAZI LINK — WhatsApp Pairing'
const DESCRIPTION =
  'Pair your WhatsApp number with the MZAZI bot. Get a code, see every connected device, and remove one with the password you set. No login.'

export const metadata = {
  metadataBase: new URL(baseUrl),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: 'MZAZI LINK',
  manifest: '/manifest.webmanifest',
  robots: { index: true, follow: true },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: baseUrl,
    siteName: 'MZAZI LINK',
    type: 'website',
  },
}

export const viewport = {
  themeColor: '#0B0D0F',
  width: 'device-width',
  initialScale: 1,
  // The pairing code is the one thing that must be readable without pinching.
  maximumScale: 5,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={plexMono.variable}>{children}</body>
    </html>
  )
}
