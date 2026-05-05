import type { Config } from 'tailwindcss'

/**
 * EPOS Fiscal — design tokens.
 *
 * Все цвета, типографика и шкалы заданы здесь и в src/index.css (CSS variables).
 * Правила см. в docs/ui-conventions.md.
 *
 *  - canvas / surface / border / ink* — нейтральная палитра, через `rgb(var(--…))`,
 *    что позволяет один и тот же класс работать в light/dark теме.
 *  - success / warning / danger / info — semantic статусы, у каждого .soft фон
 *    для бейджей и .DEFAULT для иконок/обводки.
 *  - НЕТ raw цветов в JSX (.bg-slate-50 / .text-emerald-700 запрещены).
 *  - Spacing — стандартная Tailwind шкала (4 8 12 16 20 24 32 40 48 64).
 *    Никаких arbitrary [14px] в коде.
 */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral surfaces
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-hover': 'rgb(var(--surface-hover) / <alpha-value>)',
        // Borders
        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        // Text
        ink: {
          DEFAULT: 'rgb(var(--ink) / <alpha-value>)',
          muted: 'rgb(var(--ink-muted) / <alpha-value>)',
          subtle: 'rgb(var(--ink-subtle) / <alpha-value>)',
          inverse: 'rgb(var(--ink-inverse) / <alpha-value>)',
        },
        // Brand / primary action
        primary: {
          DEFAULT: 'rgb(var(--primary) / <alpha-value>)',
          hover: 'rgb(var(--primary-hover) / <alpha-value>)',
          soft: 'rgb(var(--primary-soft) / <alpha-value>)',
        },
        // Semantic statuses (DEFAULT — для иконок/линий, soft — для backgrounds)
        success: {
          DEFAULT: 'rgb(var(--success) / <alpha-value>)',
          soft: 'rgb(var(--success-soft) / <alpha-value>)',
        },
        warning: {
          DEFAULT: 'rgb(var(--warning) / <alpha-value>)',
          soft: 'rgb(var(--warning-soft) / <alpha-value>)',
        },
        danger: {
          DEFAULT: 'rgb(var(--danger) / <alpha-value>)',
          soft: 'rgb(var(--danger-soft) / <alpha-value>)',
        },
        info: {
          DEFAULT: 'rgb(var(--info) / <alpha-value>)',
          soft: 'rgb(var(--info-soft) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['JetBrains Mono', 'SF Mono', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      fontSize: {
        // Семантические размеры — используй вместо text-2xl/text-sm
        display: ['1.875rem', { lineHeight: '2.25rem', fontWeight: '700' }], // 30/36
        heading: ['1.125rem', { lineHeight: '1.5rem', fontWeight: '600' }],   // 18/24
        body: ['0.875rem', { lineHeight: '1.25rem', fontWeight: '400' }],     // 14/20
        caption: ['0.75rem', { lineHeight: '1rem', fontWeight: '500' }],      // 12/16
      },
      borderRadius: {
        // Tailwind уже даёт sm/md/lg/xl. Используем их + наш `card` алиас
        card: '0.625rem', // 10px — фирменное закругление карточек
      },
      boxShadow: {
        // Минималистичные тени — никаких размытых ореолов
        'subtle': '0 1px 2px 0 rgb(0 0 0 / 0.04)',
        'card': '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        'overlay': '0 10px 30px -5px rgb(0 0 0 / 0.15)',
      },
      animation: {
        'fade-in': 'fadeIn 150ms ease-out',
        'slide-down': 'slideDown 200ms ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideDown: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
} satisfies Config
