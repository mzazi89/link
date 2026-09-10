/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    // /api/init-db reads lib/schema.sql at runtime with a path built from
    // process.cwd(). Next's file tracing cannot follow that statically, so
    // without this the file is left out of the serverless bundle and the
    // endpoint fails with ENOENT in production only — the worst place to find
    // out.
    outputFileTracingIncludes: {
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
