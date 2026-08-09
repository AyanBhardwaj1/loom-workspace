/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // one accent color across the whole product
        accent: {
          DEFAULT: '#8b7cf6',
          soft: '#a99df8',
          bright: '#b9aef8',
          faint: 'rgba(139, 124, 246, 0.14)',
        },
        // semantic "thread" hues — each event type in the stream has a signature
        thread: {
          agent: '#8b7cf6', // narration — violet
          tool: '#38d6e0', // tool activity — cyan
          add: '#38e0a5', // additions — emerald
          del: '#f26d6d', // deletions — red
          commit: '#f4c95d', // commits — gold
          suggest: '#f0a952', // suggestions — amber
          fork: '#e879f9', // forks — magenta
        },
        ink: {
          950: '#08080d',
          900: '#0d0d14',
          850: '#12121b',
          800: '#181824',
          700: '#22222f',
          600: '#2c2c3d',
          500: '#3a3a52',
          400: '#585874',
          300: '#8888a3',
          200: '#b8b8cc',
          100: '#e6e6f0',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      boxShadow: {
        glass: 'inset 0 1px 0 0 rgba(255,255,255,0.05), 0 1px 2px 0 rgba(0,0,0,0.4)',
        'glass-lg': 'inset 0 1px 0 0 rgba(255,255,255,0.06), 0 12px 40px -12px rgba(0,0,0,0.7)',
        'glow-accent': '0 0 0 1px rgba(139,124,246,0.4), 0 0 24px -4px rgba(139,124,246,0.5)',
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(139, 124, 246, 0.5)' },
          '70%': { boxShadow: '0 0 0 6px rgba(139, 124, 246, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(139, 124, 246, 0)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        // event-row entrance — the signature stream motion
        'rise-in': {
          '0%': { opacity: '0', transform: 'translateY(7px) scale(0.995)' },
          '100%': { opacity: '1', transform: 'translateY(0) scale(1)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        // skeleton shimmer sweep
        'shimmer-x': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        highlight: {
          '0%': { backgroundColor: 'rgba(139, 124, 246, 0.16)' },
          '100%': { backgroundColor: 'transparent' },
        },
        // gold pulse when a commit lands
        'gold-pulse': {
          '0%': { boxShadow: '0 0 0 0 rgba(244,201,93,0.45)', borderColor: 'rgba(244,201,93,0.6)' },
          '100%': { boxShadow: '0 0 0 10px rgba(244,201,93,0)', borderColor: 'rgba(244,201,93,0.25)' },
        },
        // preview "updated" sweep
        sweep: {
          '0%': { transform: 'translateX(-100%)', opacity: '0.5' },
          '100%': { transform: 'translateX(300%)', opacity: '0' },
        },
        // weaving shuttle — the thinking indicator
        shuttle: {
          '0%,100%': { transform: 'translateX(0)' },
          '50%': { transform: 'translateX(10px)' },
        },
        // signature loader ring spin
        'spin-slow': { to: { transform: 'rotate(360deg)' } },
        // presence avatars breathe
        breathe: {
          '0%,100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.82', transform: 'scale(0.94)' },
        },
        // ambient glow drift on the newest filament node
        'node-pulse': {
          '0%,100%': { opacity: '0.35', transform: 'scale(1)' },
          '50%': { opacity: '1', transform: 'scale(1.35)' },
        },
        // streaming caret
        'caret-blink': { '50%': { opacity: '0' } },
        // segmented control glow
        'seg-in': { '0%': { opacity: '0.4' }, '100%': { opacity: '1' } },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
        'fade-in-up': 'fade-in-up 0.25s ease-out both',
        'rise-in': 'rise-in 0.24s cubic-bezier(0.16,0.8,0.3,1) both',
        shimmer: 'shimmer 1.4s linear infinite',
        'shimmer-x': 'shimmer-x 1.5s ease-in-out infinite',
        highlight: 'highlight 2.2s ease-out both',
        'gold-pulse': 'gold-pulse 1.6s ease-out 1',
        sweep: 'sweep 1s ease-out 1',
        shuttle: 'shuttle 1.1s ease-in-out infinite',
        'spin-slow': 'spin-slow 0.9s linear infinite',
        breathe: 'breathe 2.6s ease-in-out infinite',
        'node-pulse': 'node-pulse 2s ease-in-out infinite',
        'caret-blink': 'caret-blink 1s steps(2) infinite',
      },
    },
  },
  plugins: [],
}
