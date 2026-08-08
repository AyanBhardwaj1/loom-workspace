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
          faint: 'rgba(139, 124, 246, 0.14)',
        },
        ink: {
          950: '#0a0a0f',
          900: '#0f0f16',
          850: '#13131c',
          800: '#181824',
          700: '#1f1f2e',
          600: '#2a2a3d',
          500: '#3a3a52',
          400: '#585874',
          300: '#8888a3',
          200: '#b8b8cc',
          100: '#e2e2ee',
        },
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      keyframes: {
        'pulse-ring': {
          '0%': { boxShadow: '0 0 0 0 rgba(139, 124, 246, 0.55)' },
          '70%': { boxShadow: '0 0 0 7px rgba(139, 124, 246, 0)' },
          '100%': { boxShadow: '0 0 0 0 rgba(139, 124, 246, 0)' },
        },
        'fade-in-up': {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '0%': { backgroundPosition: '-400px 0' },
          '100%': { backgroundPosition: '400px 0' },
        },
        highlight: {
          '0%': { backgroundColor: 'rgba(139, 124, 246, 0.18)' },
          '100%': { backgroundColor: 'transparent' },
        },
      },
      animation: {
        'pulse-ring': 'pulse-ring 1.8s ease-out infinite',
        'fade-in-up': 'fade-in-up 0.25s ease-out both',
        shimmer: 'shimmer 1.4s linear infinite',
        highlight: 'highlight 2.2s ease-out both',
      },
    },
  },
  plugins: [],
}
