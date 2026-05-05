import type { HTMLAttributes, ReactNode } from 'react'
import { cn } from '@/lib/cn'

type Variant = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'primary'
type Size = 'sm' | 'md'

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant
  size?: Size
  /** Иконка слева (Lucide 12-14px рекомендуется). */
  icon?: ReactNode
}

const variants: Record<Variant, string> = {
  neutral: 'bg-surface-hover text-ink-muted border-border',
  success: 'bg-success-soft text-success border-success/20',
  warning: 'bg-warning-soft text-warning border-warning/20',
  danger: 'bg-danger-soft text-danger border-danger/20',
  info: 'bg-info-soft text-info border-info/20',
  primary: 'bg-primary text-ink-inverse border-transparent',
}

const sizes: Record<Size, string> = {
  sm: 'text-[11px] leading-none px-1.5 py-0.5 gap-1',
  md: 'text-caption px-2 py-0.5 gap-1.5',
}

/**
 * Универсальный бейдж — статус, счётчик, метка.
 *
 *   <Badge variant="success" icon={<Check size={12} />}>Фискализирован</Badge>
 *   <Badge variant="primary" size="sm">3</Badge>
 */
export function Badge({
  variant = 'neutral',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border font-medium whitespace-nowrap',
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      {children}
    </span>
  )
}
