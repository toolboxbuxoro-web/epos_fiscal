import { APP_VERSION } from '@/lib/app-version'

/**
 * Ненавязчивый номер версии в правом нижнем углу окна.
 * Помогает кассиру/админу быстро понять, какая сборка стоит на машине.
 */
export function AppVersionBadge() {
  return (
    <div
      className="fixed bottom-2 right-2 z-40 select-none rounded-md border border-border bg-surface/95 px-2 py-0.5 font-mono text-[10px] text-ink-subtle shadow-subtle pointer-events-none"
      title={`Toolbox Fiscal v${APP_VERSION}`}
    >
      v{APP_VERSION}
    </div>
  )
}
