import './globals.css'

/**
 * Absolute URL used for metadata (canonical links, Open Graph).
 *
 * Resolved from the platform rather than demanded as configuration, so that
 * DATABASE_URL can be the only variable you actually have to set. Order:
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

export const metadata = {
  metadataBase: new URL(baseUrl),
  title: 'Link a device — MZAZI TECH',
  description:
    'Connect your WhatsApp number to the MZAZI TECH bot. Enter your number, get a pairing code, and link the device from WhatsApp. No account needed.',
  applicationName: 'MZAZI TECH Link',
  manifest: '/manifest.webmanifest',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Link a device — MZAZI TECH',
    description:
      'Enter your WhatsApp number and link the device in under a minute. No sign-up required.',
    url: baseUrl,
    siteName: 'MZAZI TECH',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Link a device — MZAZI TECH',
    description: 'Enter your WhatsApp number and link the device in under a minute.',
  },
}

export const viewport = {
  themeColor: '#0D0C0B',
  colorScheme: 'dark',
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        {/* Loaded from the Google Fonts CDN with preconnect rather than via
            next/font, so the build has no outbound network dependency. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500&family=Manrope:wght@400;500&family=IBM+Plex+Mono:wght@400&display=swap"
        />
      </head>
      <body className="canvas-wash canvas-frame min-h-screen">
        {/* Content sits above the fixed wash and frame. */}
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  )
}
