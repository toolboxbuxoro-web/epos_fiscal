import { Toaster as HotToaster, toast as hotToast } from 'react-hot-toast'

/**
 * Mount one <Toaster /> at app root (см. App.tsx).
 *
 * Использование:
 *   import { toast } from '@/components/ui'
 *   toast.success('Чек фискализирован')
 *   toast.error('Не удалось подключиться')
 *   toast.loading('Сохраняю…')
 *   toast.dismiss(id)
 */
export function Toaster() {
  return (
    <HotToaster
      position="top-right"
      toastOptions={{
        // Используем токены через style — react-hot-toast не работает через Tailwind напрямую
        style: {
          background: 'rgb(var(--surface))',
          color: 'rgb(var(--ink))',
          border: '1px solid rgb(var(--border))',
          borderRadius: '0.5rem',
          padding: '10px 14px',
          fontSize: '14px',
          boxShadow:
            '0 1px 3px 0 rgb(0 0 0 / 0.06), 0 1px 2px -1px rgb(0 0 0 / 0.04)',
        },
        success: {
          iconTheme: {
            primary: 'rgb(var(--success))',
            secondary: 'rgb(var(--success-soft))',
          },
        },
        error: {
          iconTheme: {
            primary: 'rgb(var(--danger))',
            secondary: 'rgb(var(--danger-soft))',
          },
          duration: 6000,
        },
        loading: {
          iconTheme: {
            primary: 'rgb(var(--ink-muted))',
            secondary: 'rgb(var(--surface-hover))',
          },
        },
      }}
    />
  )
}

export { hotToast as toast }
