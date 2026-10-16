/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/renderer/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        view: {
          bg: '#0A0E14',
          card: '#11161F',
          surface: '#1A212E',
          border: 'rgba(148,163,184,0.12)',
          hairline: 'rgba(255,255,255,0.06)',
          primary: '#38BDF8',
          online: '#22C55E',
          offline: '#EF4444',
          unknown: '#6B7280',
          text: '#E5E7EB',
          muted: '#94A3B8',
          dim: '#475569',
        },
      },
      fontFamily: {
        sans: ['"Plus Jakarta Sans"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
