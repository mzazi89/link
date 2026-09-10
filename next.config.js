/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    // lib/db.js reads lib/schema.sql at runtime, with a path built from
    // process.cwd(), so the app can make sure its own tables exist. Next's file
    // tracing cannot follow that statically, so without these the file is left
    // out of the serverless bundle and the read fails with ENOENT in production
    // only — the worst place to find out.
    //
    // Every route that touches the database needs it, because ensureSchema runs
    // from the shared query helper. Listed explicitly rather than with a broad
    // glob so a new route missing from this list is obvious in review.
    outputFileTracingIncludes: {
      '/api/link': ['./lib/schema.sql'],
      '/api/unlink': ['./lib/schema.sql'],
      '/api/connected': ['./lib/schema.sql'],
      '/api/requests/[id]': ['./lib/schema.sql'],
      '/api/init-db': ['./lib/schema.sql'],
    },
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
        ],
      },
      {
        // The linking endpoints are pure JSON and must never be cached by a
        // browser, a CDN edge, or an intermediary — a stale "ready" response
        // would hand a user a pairing code that has already rotated.
        source: '/api/:path*',
        headers: [
          { key: 'Cache-Control', value: 'no-store, no-cache, must-revalidate, max-age=0' },
        ],
      },
    ]
  },
}

module.exports = nextConfig
