import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  TriangleAlert,
} from 'lucide-react'
import { useSystemStatus, type SystemIssue } from '@/lib/system-status'
import { cn } from '@/lib/cn'

/**
 * Системный статус — постоянная панель в подвале сайдбара (или другом месте).
 *
 *   <SystemStatusPanel />
 *
 * Отрисовка:
 *   ✓ нет проблем → компактный «Всё работает» (зелёный)
 *   ⚠ есть warnings → жёлтая полоса с числом + раскрывается по клику
 *   ✗ есть errors → красная полоса
 *
 * При клике по issue с action — переход по href через React Router.
 */
export function SystemStatusPanel({ className }: { className?: string }) {
  const status = useSystemStatus()
  const navigate = useNavigate()
  const [expanded, setExpanded] = useState(false)

  const tone = status.hasErrors
    ? 'error'
    : status.hasWarnings
      ? 'warning'
      : 'ok'

  const Icon =
    tone === 'error' ? AlertCircle : tone === 'warning' ? TriangleAlert : CheckCircle2
  const label =
    tone === 'error'
      ? `${status.issues.filter((i) => i.severity === 'error').length} ${plural(status.issues.filter((i) => i.severity === 'error').length, 'ошибка', 'ошибки', 'ошибок')}`
      : tone === 'warning'
        ? `${status.issues.length} ${plural(status.issues.length, 'предупреждение', 'предупреждения', 'предупреждений')}`
        : 'Всё работает'

  const styleByTone = {
    ok: 'border-success/20 bg-success-soft text-success',
    warning: 'border-warning/20 bg-warning-soft text-warning',
    error: 'border-danger/20 bg-danger-soft text-danger',
  }[tone]

  // Если всё ОК — компактный пассивный индикатор без раскрытия
  if (tone === 'ok') {
    return (
      <div
        className={cn(
          'flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-caption',
          styleByTone,
          className,
        )}
      >
        <Icon size={14} />
        <span className="truncate">{label}</span>
      </div>
    )
  }

  return (
    <div className={cn('rounded-md border', styleByTone, className)}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-caption hover:opacity-80 transition-opacity"
        aria-expanded={expanded}
      >
        <Icon size={14} className="shrink-0" />
        <span className="flex-1 text-left truncate">{label}</span>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>

      {expanded && (
        <div className="border-t border-current/10 px-2 py-2 space-y-1.5 max-h-72 overflow-y-auto scrollbar-thin">
          {status.issues.map((issue) => (
            <IssueRow
              key={issue.id}
              issue={issue}
              onAction={(href) => {
                navigate(href)
                setExpanded(false)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function IssueRow({
  issue,
  onAction,
}: {
  issue: SystemIssue
  onAction: (href: string) => void
}) {
  const dot = issue.severity === 'error' ? 'bg-danger' : 'bg-warning'
  return (
    <div className="rounded-md bg-surface/60 p-2 text-caption">
      <div className="flex items-start gap-2">
        <span className={cn('mt-1 h-1.5 w-1.5 shrink-0 rounded-full', dot)} />
        <div className="min-w-0 flex-1">
          <div className="text-ink font-medium truncate">{issue.title}</div>
          {issue.detail && (
            <div className="text-ink-muted mt-0.5 line-clamp-2">{issue.detail}</div>
          )}
          {issue.action && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onAction(issue.action!.href)
              }}
              className="mt-1 text-info hover:underline font-medium"
            >
              {issue.action.label} →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few
  return many
}
