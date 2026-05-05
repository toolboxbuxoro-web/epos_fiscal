import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { cn } from '@/lib/cn'

interface Props {
  open: boolean
  onClose: () => void
  title?: string
  description?: string
  /** Размер контейнера. */
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** Прятать [×] кнопку (для критичных диалогов где нужен явный выбор). */
  hideClose?: boolean
  /** Закрывать на клик по бэкдропу. По умолчанию true. */
  closeOnBackdropClick?: boolean
  children: ReactNode
  /** Footer-зона для кнопок «Отмена / OK». */
  footer?: ReactNode
}

const sizes = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
}

/**
 * Модалка через portal-less overlay (для Tauri этого достаточно — нет SSR).
 * Esc и backdrop-click закрывают.
 *
 *   <Modal open={show} onClose={() => setShow(false)} title="Создать магазин">
 *     <Field label="Slug"><Input ... /></Field>
 *   </Modal>
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  size = 'md',
  hideClose,
  closeOnBackdropClick = true,
  children,
  footer,
}: Props) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    // Блок прокрутки фона
    const orig = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = orig
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? 'modal-title' : undefined}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      onClick={closeOnBackdropClick ? onClose : undefined}
    >
      {/* Backdrop */}
      <div className="absolute inset-0 bg-ink/40" aria-hidden />

      {/* Container */}
      <div
        onClick={(e) => e.stopPropagation()}
        className={cn(
          'relative w-full bg-surface rounded-card shadow-overlay border border-border',
          'flex flex-col max-h-[calc(100vh-2rem)] overflow-hidden',
          'animate-slide-down',
          sizes[size],
        )}
      >
        {(title || !hideClose) && (
          <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
            <div className="min-w-0">
              {title && (
                <h2 id="modal-title" className="text-heading text-ink">
                  {title}
                </h2>
              )}
              {description && (
                <p className="mt-1 text-caption text-ink-muted">{description}</p>
              )}
            </div>
            {!hideClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Закрыть"
                className="shrink-0 -m-1 p-1 rounded-md text-ink-muted hover:text-ink hover:bg-surface-hover transition-colors"
              >
                <X size={18} />
              </button>
            )}
          </div>
        )}

        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-4">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}
