import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'
import { EmptyState } from './EmptyState'

export interface Column<T> {
  key: string
  label: string
  cell: (row: T, index: number) => ReactNode
  /** Выравнивание содержимого ячейки. */
  align?: 'left' | 'right' | 'center'
  /** Зафиксированная ширина (CSS value), e.g. '120px' или '20%'. */
  width?: string
  /** Уменьшить шрифт (для tabular чисел / ID). */
  mono?: boolean
  /** Скрыть на мобильном (до md). */
  hideOnMobile?: boolean
}

interface Props<T> {
  columns: Column<T>[]
  rows: T[]
  /** Уникальный ключ строки. */
  rowKey: (row: T, index: number) => string | number
  /** Что показать вместо таблицы когда rows пуст. */
  empty?: ReactNode
  /** Добавить onClick на строку — рендерит как cursor-pointer. */
  onRowClick?: (row: T, index: number) => void
  /** Подсветить активную строку (например выбранный чек). */
  isActiveRow?: (row: T, index: number) => boolean
  /** Дополнительные классы на <table>. */
  className?: string
  loading?: boolean
}

/**
 * Минимальная таблица для списков.
 *
 * Дизайн: строки разделены тонкой линией снизу, hover подсвечивает,
 * компактные отступы. Для денежных колонок — `align="right" mono`
 * (font-mono + tabular-numbers, см. base CSS).
 *
 *   <DataTable
 *     columns={[
 *       { key: 'name', label: 'Чек', cell: (r) => r.name },
 *       { key: 'sum', label: 'Сумма', align: 'right', mono: true,
 *         cell: (r) => fmt(r.sum) },
 *     ]}
 *     rows={receipts}
 *     rowKey={(r) => r.id}
 *     empty={<EmptyState ... />}
 *   />
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  empty,
  onRowClick,
  isActiveRow,
  className,
  loading,
}: Props<T>) {
  const align = (a?: 'left' | 'right' | 'center') =>
    a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left'

  if (rows.length === 0 && !loading) {
    return empty ?? <EmptyState title="Нет данных" />
  }

  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className={cn('w-full text-body', className)}>
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                style={{ width: col.width }}
                className={cn(
                  'px-3 py-2 text-caption font-medium text-ink-muted uppercase tracking-wide',
                  align(col.align),
                  col.hideOnMobile && 'hidden md:table-cell',
                )}
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: 5 }).map((_, i) => (
                <tr key={`sk-${i}`} className="border-b border-border">
                  {columns.map((col) => (
                    <td key={col.key} className="px-3 py-3">
                      <div className="h-4 w-3/4 rounded bg-surface-hover animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))
            : rows.map((row, i) => {
                const active = isActiveRow?.(row, i) ?? false
                return (
                  <tr
                    key={rowKey(row, i)}
                    onClick={onRowClick ? () => onRowClick(row, i) : undefined}
                    className={cn(
                      'border-b border-border transition-colors',
                      onRowClick && 'cursor-pointer hover:bg-surface-hover',
                      active && 'bg-primary-soft',
                    )}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'px-3 py-3 text-ink',
                          align(col.align),
                          col.mono && 'font-mono tabular-nums text-caption',
                          col.hideOnMobile && 'hidden md:table-cell',
                        )}
                      >
                        {col.cell(row, i)}
                      </td>
                    ))}
                  </tr>
                )
              })}
        </tbody>
      </table>
    </div>
  )
}
