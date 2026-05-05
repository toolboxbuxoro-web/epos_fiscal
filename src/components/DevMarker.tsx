/**
 * Маленький DEV-индикатор в углу окна.
 *
 * Видно только в `vite dev` (`import.meta.env.DEV === true`).
 * В production-сборке (`npm run build`) — null, не рендерится вообще.
 *
 * Помогает не путать локальную разработку с реальной программой кассира.
 */
export function DevMarker() {
  if (!import.meta.env.DEV) return null
  return (
    <div
      className="fixed bottom-2 right-2 z-50 select-none rounded-md border border-warning/30 bg-warning-soft px-2 py-0.5 text-[10px] font-bold tracking-wide text-warning shadow-subtle pointer-events-none"
      title="Разработка (Vite dev)"
    >
      DEV
    </div>
  )
}
