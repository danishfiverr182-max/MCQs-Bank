import tailwindcssAnimate from 'tailwindcss-animate';

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: ['class'],
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
    './components/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // ── ShadCN semantic tokens (CSS variables) ──────────
        border: 'hsl(var(--border))',
        input: 'hsl(var(--input))',
        ring: 'hsl(var(--ring))',
        background: 'hsl(var(--background))',
        foreground: 'hsl(var(--foreground))',
        card: {
          DEFAULT: 'hsl(var(--card))',
          foreground: 'hsl(var(--card-foreground))',
        },
        // ── Primary brand (Indigo) ──────────────────────────
        primary: {
          50: '#EEF2FF',
          100: '#E0E7FF',
          200: '#C7D2FE',
          300: '#A5B4FC',
          400: '#818CF8',
          500: '#6366F1',
          600: '#4F46E5',
          700: '#4338CA',
          800: '#3730A3',
          900: '#312E81',
          DEFAULT: '#4F46E5',
          foreground: '#FFFFFF',
          hover: '#4338CA',
          light: '#EEF2FF',
        },
        // ── Semantic: Status colors ─────────────────────────
        success: {
          DEFAULT: '#10B981',
          light: '#D1FAE5',
          dark: '#065F46',
        },
        warning: {
          DEFAULT: '#F59E0B',
          light: '#FEF3C7',
          dark: '#92400E',
        },
        danger: {
          DEFAULT: '#EF4444',
          light: '#FEE2E2',
          dark: '#991B1B',
        },
        // ── Surface & neutral ───────────────────────────────
        surface: {
          DEFAULT: '#F8FAFC',
          card: '#FFFFFF',
          border: '#E2E8F0',
        },
        // ── MCQ difficulty colors ───────────────────────────
        easy: { DEFAULT: '#10B981', light: '#D1FAE5', text: '#065F46' },
        medium: { DEFAULT: '#F59E0B', light: '#FEF3C7', text: '#92400E' },
        hard: { DEFAULT: '#EF4444', light: '#FEE2E2', text: '#991B1B' },
        // ── MCQ status colors ────────────────────────────────
        approved: { DEFAULT: '#10B981', light: '#D1FAE5', text: '#065F46' },
        pending: { DEFAULT: '#F59E0B', light: '#FEF3C7', text: '#92400E' },
        rejected: { DEFAULT: '#EF4444', light: '#FEE2E2', text: '#991B1B' },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      fontSize: {
        display: ['2rem', { lineHeight: '2.5rem', fontWeight: '700' }],
        heading: ['1.5rem', { lineHeight: '2rem', fontWeight: '600' }],
        subhead: ['1.125rem', { lineHeight: '1.75rem', fontWeight: '600' }],
        body: ['0.9375rem', { lineHeight: '1.6rem', fontWeight: '400' }],
        small: ['0.8125rem', { lineHeight: '1.4rem', fontWeight: '400' }],
        label: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],
      },
      spacing: {
        sidebar: '260px',
        'sidebar-collapsed': '64px',
        topbar: '60px',
      },
      borderRadius: {
        sm: '4px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
      },
      boxShadow: {
        card: '0 1px 3px 0 rgba(0,0,0,0.08), 0 1px 2px -1px rgba(0,0,0,0.06)',
        modal: '0 20px 60px -10px rgba(0,0,0,0.2)',
        sm: '0 1px 2px 0 rgba(0,0,0,0.05)',
        md: '0 4px 6px -1px rgba(0,0,0,0.08)',
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
        // Sliding bar for ImportProgressBar's 'processing' state (Prompt 48) —
        // there's no real percentage once bytes are uploaded but the server
        // hasn't responded yet, so this just signals "still working".
        'indeterminate-bar': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
        'indeterminate-bar': 'indeterminate-bar 1.2s ease-in-out infinite',
      },
    },
  },
  plugins: [tailwindcssAnimate],
}
