/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,jsx}',
    './components/**/*.{js,jsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Warm charcoal canvas — the "Ink" half of the system.
        ink: {
          950: '#0D0C0B',
          900: '#131110',
          850: '#191715',
          800: '#201D1A',
          700: '#2A2622',
          600: '#3A342E',
          500: '#4C443C',
        },
        // Warm off-white text ramp, deliberately not pure white.
        paper: {
          DEFAULT: '#F3EEE5',
          muted: '#A69C8D',
          faint: '#6E665B',
        },
        // "Bolt" accents.
        amber: {
          DEFAULT: '#DFA457',
          deep: '#B87F33',
        },
        cobalt: {
          DEFAULT: '#5B7FB9',
          deep: '#3B5B90',
        },
        // Reserved strictly for failure and throttling states. Using it for
        // anything decorative would make a real error read as ordinary chrome.
        rust: {
          DEFAULT: '#C9603F',
        },
      },
      fontFamily: {
        display: ['var(--font-display)', 'Space Grotesk', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        sans: ['var(--font-sans)', 'Manrope', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        // Hairline geometry: this system barely rounds anything.
        DEFAULT: '2px',
        sm: '2px',
        md: '3px',
        lg: '4px',
      },
      letterSpacing: {
        label: '0.14em',
      },
      keyframes: {
        'rise': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pulse-soft': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.35' },
        },
      },
      animation: {
        rise: 'rise 320ms ease-out both',
        'pulse-soft': 'pulse-soft 1.6s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
