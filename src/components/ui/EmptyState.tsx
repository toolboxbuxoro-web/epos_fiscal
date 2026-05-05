import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

interface Props {
  /** Lucide-иконка размера 32-40 — обозначает категорию пустоты. */
  icon?: ReactNode
  title: string
  description?: string
  /** Кнопка действия (опционально). */
  action?: ReactNode
  className?: string
}

/**
 * Использовать в ЛЮБОМ месте где может быть пусто:
 *   - таблица без записей
 *   - список без результатов поиска
 *   - страница без данных
 *
 * Цель: НЕ показывать пустую таблицу — это выглядит как баг.
 *
 *   <EmptyState
 *     icon={<Receipt size={36} className="text-ink-subtle" />}
 *     title="Нет чеков в смене"
 *     description="Чеки появятся как только МС-касса пробьёт первый"
 *   />
 */
export function EmptyState({ icon, title, description, action, className }: Props) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center py-12 px-6',
        className,
      )}
    >
      {icon && <div className="mb-3 text-ink-subtle">{icon}</div>}
      <h3 className="text-heading text-ink">{title}</h3>
      {description && (
        <p className="mt-1 text-body text-ink-muted max-w-md">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}
