import localFont from 'next/font/local'

import './globals.css'

/**
 * Space Grotesk, self-hosted.
 *
 * quartzxd ships the TTFs in app/fonts and loads them this way, so the same
 * three files are used here — no Google Fonts request, no layout shift, and the
 * two sites render with byte-identical type.
 */
const spaceGrotesk = localFont({
  src: [
    { path: './fonts/SpaceGrotesk-Regular.ttf', weight: '400', style: 'normal' },
    { path: './fonts/SpaceGrotesk-Medium.ttf', weight: '500', style: 'normal' },
    { path: './fonts/SpaceGrotesk-Bold.ttf', weight: '700', style: 'normal' },
  ],
  variable: '--font-display',
  display: 'swap',
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
  'Pair your WhatsApp number with the MZAZI bot. Generate a pairing code, see every connected device, and remove one with the password you set — no login required.'

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
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={spaceGrotesk.variable}>{children}</body>
    </html>
  )
}
