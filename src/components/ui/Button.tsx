import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/cn'

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  /** Показать spinner и заблокировать клики. */
  loading?: boolean
  /** Иконка слева от текста (16px Lucide рекомендуется). */
  icon?: ReactNode
  /** Иконка справа. */
  iconRight?: ReactNode
}

// Используем hardcoded `text-white` / `text-zinc-900` вместо CSS-токенов
// `text-ink-inverse`, потому что в Tauri WKWebView с macOS Dark Mode UA-стили
// иногда пробивают CSS-переменные form-controls. Hardcoded `white`/`zinc-900`
// 100% переопределяет system-цвета и гарантирует читаемость в любой среде.
// ВАЖНО: для primary/danger используем `text-ink-inverse` (CSS-переменная
// rgb(var(--ink-inverse))), НЕ hardcoded `text-white`. WKWebView в macOS Dark
// Mode иногда перекрывает Tailwind `text-white` своими UA-стилями (особенно
// внутри <button>), и текст становится тёмным на тёмном фоне = невидимым.
// CSS-переменная гарантированно `#fafafa` в light-теме (которая залочена
// через `color-scheme: only light` в index.css).
const variants: Record<Variant, string> = {
  primary:
    'bg-primary text-ink-inverse hover:bg-primary-hover disabled:bg-ink-subtle disabled:text-ink-inverse',
  secondary:
    'bg-surface text-ink border border-border hover:bg-surface-hover disabled:opacity-50',
  ghost:
    'bg-transparent text-ink-muted hover:bg-surface-hover hover:text-ink disabled:opacity-50',
  danger:
    'bg-danger text-ink-inverse hover:opacity-90 disabled:opacity-50',
}

const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-caption gap-1.5',
  md: 'h-9 px-4 text-body gap-2',
  lg: 'h-11 px-5 text-body gap-2',
}

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    className,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading
  // Inline style для primary/danger — safety net против WKWebView UA-стилей
  // в macOS Dark Mode которые иногда перекрывают Tailwind text-* классы
  // внутри form-controls. Inline `style` имеет наивысший CSS-приоритет.
  // Merge с user-style (rest.style) чтобы не перетирать.
  const forceColor =
    variant === 'primary' || variant === 'danger'
      ? { color: 'rgb(var(--ink-inverse))' }
      : undefined
  const mergedStyle = forceColor
    ? { ...(rest.style || {}), ...forceColor }
    : rest.style
  // Извлекаем style из rest чтобы не перетирался ниже
  const { style: _userStyle, ...restWithoutStyle } = rest
  return (
    <button
      ref={ref}
      disabled={isDisabled}
      style={mergedStyle}
      className={cn(
        'inline-flex items-center justify-center rounded-md font-medium transition-colors',
        'disabled:cursor-not-allowed',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        variants[variant],
        sizes[size],
        className,
      )}
      {...restWithoutStyle}
    >
      {loading ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
      ) : (
        icon && <span className="shrink-0">{icon}</span>
      )}
      {children}
      {!loading && iconRight && <span className="shrink-0">{iconRight}</span>}
    </button>
  )
})
