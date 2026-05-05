import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface Props {
  title: string
  /** Подзаголовок мелким шрифтом — кол-во записей, контекст и т.п. */
  subtitle?: string
  /** Кнопка/группа справа. */
  action?: ReactNode
  /** Иконка слева от заголовка (Lucide 24-28). */
  icon?: ReactNode
  className?: string
}

/**
 * Шапка страницы — единый стиль для всех routes.
 *
 *   <PageHeader
 *     title="Касса"
 *     subtitle="3 чека ожидают фискализации"
 *     action={<Button icon={<RefreshCcw size={16} />}>Обновить</Button>}
 *   />
 */
export function PageHeader({ title, subtitle, action, icon, className }: Props) {
  return (
    <div
      className={cn(
        'flex items-start justify-between gap-4 mb-6',
        className,
      )}
    >
      <div className="flex items-start gap-3 min-w-0">
        {icon && <div className="shrink-0 text-ink-muted mt-0.5">{icon}</div>}
        <div className="min-w-0">
          <h1 className="text-display text-ink truncate">{title}</h1>
          {subtitle && (
            <p className="mt-1 text-body text-ink-muted truncate">{subtitle}</p>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}
