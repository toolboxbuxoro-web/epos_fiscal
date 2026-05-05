import { useDevMode } from '@/lib/dev-mode'

/**
 * Маленький DEV-индикатор в углу окна.
 *
 * Видно когда:
 *   - `vite dev` (build-time `import.meta.env.DEV`)
 *   - ИЛИ runtime разблокирован через AdminUnlockModal в Settings
 *
 * В production-сборке без runtime-разблокировки — null.
 *
 * Помогает не путать диагностический режим с реальной программой кассира.
 */
export function DevMarker() {
  const enabled = useDevMode()
  if (!enabled) return null
  return (
    <div
      className="fixed bottom-2 right-2 z-50 select-none rounded-md border border-warning/30 bg-warning-soft px-2 py-0.5 text-[10px] font-bold tracking-wide text-warning shadow-subtle pointer-events-none"
      title="Разработка (Vite dev)"
    >
      DEV
    </div>
  )
}
