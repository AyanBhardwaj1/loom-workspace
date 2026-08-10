/**
 * @type {import('tailwindcss').Config}
 *
 * The theme is a thin mapping onto the custom properties in
 * src/styles/tokens.css — utilities never carry raw values. If a value isn't
 * a token, it doesn't belong in a className.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    // full replacement (not extend) for the axes the system owns
    colors: {
      transparent: 'transparent',
      current: 'currentColor',
      canvas: 'var(--bg-canvas)',
      surface: 'var(--bg-surface)',
      raised: 'var(--bg-raised)',
      overlay: 'var(--bg-overlay)',
      inset: 'var(--bg-inset)',
      primary: 'var(--text-primary)',
      secondary: 'var(--text-secondary)',
      tertiary: 'var(--text-tertiary)',
      disabled: 'var(--text-disabled)',
      'on-accent': 'var(--text-on-accent)',
      lav: {
        300: 'var(--lav-300)',
        400: 'var(--lav-400)',
        500: 'var(--lav-500)',
        600: 'var(--lav-600)',
        fill: 'var(--lav-fill)',
        border: 'var(--lav-border)',
      },
      ok: { DEFAULT: 'var(--ok)', fill: 'var(--ok-fill)', border: 'var(--ok-border)' },
      danger: { DEFAULT: 'var(--danger)', fill: 'var(--danger-fill)', border: 'var(--danger-border)' },
      warn: { DEFAULT: 'var(--warn)', fill: 'var(--warn-fill)', border: 'var(--warn-border)' },
      scrim: 'var(--scrim)',
      hairline: {
        DEFAULT: 'var(--hairline)',
        hover: 'var(--hairline-hover)',
        strong: 'var(--hairline-strong)',
      },
    },
    borderRadius: {
      none: '0',
      sm: '4px', // kbd caps only
      DEFAULT: '6px', // controls, chips, inputs, segments
      lg: '8px', // cards, bubbles, composer, diff cards
      xl: '10px', // modals + command palette only
      full: '999px', // pills, avatars
    },
    boxShadow: {
      none: 'none',
      modal: 'var(--shadow-modal)',
      dropdown: 'var(--shadow-dropdown)',
      live: 'var(--glow-live)', // the app's single glow
    },
    zIndex: {
      0: '0',
      sticky: '10',
      sidebar: '20',
      dropdown: '30',
      scrim: '40',
      modal: '50',
      toast: '60',
    },
    fontFamily: {
      sans: ['Geist Variable', 'Geist Fallback', 'ui-sans-serif', 'system-ui', 'sans-serif'],
      mono: ['Geist Mono Variable', 'Geist Mono Fallback', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
    },
    fontSize: {
      // role-named scale — size/leading/tracking travel together
      micro: ['11px', { lineHeight: '16px', letterSpacing: '0.08em', fontWeight: '500' }],
      small: ['12px', { lineHeight: '18px' }],
      ui: ['13px', { lineHeight: '20px' }],
      body: ['14px', { lineHeight: '23px' }],
      h4: ['16px', { lineHeight: '24px', letterSpacing: '-0.01em', fontWeight: '500' }],
      h3: ['18px', { lineHeight: '26px', letterSpacing: '-0.014em', fontWeight: '600' }],
      h2: ['20px', { lineHeight: '28px', letterSpacing: '-0.016em', fontWeight: '600' }],
      display: ['24px', { lineHeight: '32px', letterSpacing: '-0.02em', fontWeight: '600' }],
      // data sizes (mono contexts)
      'code-sm': ['12px', { lineHeight: '18px' }],
      code: ['13px', { lineHeight: '20px' }],
    },
    extend: {
      spacing: {
        // 4px grid comes with Tailwind; nothing extra needed
      },
      transitionDuration: {
        micro: 'var(--t-micro)',
        fast: 'var(--t-fast)',
        enter: 'var(--t-enter)',
      },
      transitionTimingFunction: {
        out: 'var(--ease-out)',
        standard: 'var(--ease-standard)',
        exit: 'var(--ease-exit)',
      },
      keyframes: {
        // skeleton shimmer sweep (statically disabled under reduced motion)
        'shimmer-x': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(100%)' },
        },
        // streaming caret
        'caret-blink': { '50%': { opacity: '0' } },
        // tool-chip name while running
        'soft-pulse': { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.7' } },
        // fresh-change row highlight (history feed)
        highlight: {
          '0%': { backgroundColor: 'var(--lav-fill)' },
          '100%': { backgroundColor: 'transparent' },
        },
        // row entrance: fade + 4px rise
        rise: {
          '0%': { opacity: '0', transform: 'translateY(4px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'shimmer-x': 'shimmer-x 2s var(--ease-standard) infinite',
        'caret-blink': 'caret-blink 1s steps(2) infinite',
        'soft-pulse': 'soft-pulse 1.4s var(--ease-standard) infinite',
        highlight: 'highlight 2s var(--ease-standard) both',
        rise: 'rise var(--t-enter) var(--ease-out) both',
      },
    },
  },
  plugins: [],
}
