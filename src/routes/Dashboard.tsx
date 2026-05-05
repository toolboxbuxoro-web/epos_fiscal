import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  Receipt as ReceiptIcon,
  RefreshCcw,
  Wifi,
  WifiOff,
} from 'lucide-react'
import {
  countMsReceiptsByStatus,
  listMsReceipts,
  type MsReceiptRow,
  type MsReceiptStatus,
} from '@/lib/db'
import {
  ensurePollerStarted,
  subscribePollerStatus,
} from '@/lib/poller-runtime'
import type { PollerStatus } from '@/lib/moysklad/poller'
import { useShiftStatus } from '@/lib/moysklad'
import { formatDateTime, tiyinToSumDisplay } from '@/lib/format'
import {
  Badge,
  Button,
  Card,
  DataTable,
  EmptyState,
  PageHeader,
  StatusBadge,
  type Column,
} from '@/components/ui'
import { cn } from '@/lib/cn'

/**
 * Достать UUID активной смены из MsRetailDemand.raw_json.
 * Парсим лениво и кэшируем — так дешевле чем JSON1 в SQLite.
 */
function getShiftIdFromRawJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { retailShift?: { meta?: { href?: string } } }
    const href = parsed?.retailShift?.meta?.href
    if (typeof href !== 'string') return null
    const idx = href.lastIndexOf('/')
    return idx >= 0 ? href.slice(idx + 1) : null
  } catch {
    return null
  }
}

const STATUS_FILTERS: { value: MsReceiptStatus | 'all'; label: string }[] = [
  { value: 'pending', label: 'Ожидают' },
  { value: 'matched', label: 'Подобраны' },
  { value: 'fiscalized', label: 'Готовы' },
  { value: 'failed', label: 'Ошибки' },
  { value: 'all', label: 'Все' },
]

const STATUS_TO_BADGE: Record<
  MsReceiptStatus,
  { label: string; status: 'pending' | 'info' | 'success' | 'error' | 'warning' | 'neutral' }
> = {
  pending: { label: 'Ожидает', status: 'pending' },
  matched: { label: 'Подобран', status: 'info' },
  fiscalized: { label: 'Готов', status: 'success' },
  failed: { label: 'Ошибка', status: 'error' },
  manual: { label: 'Ручной', status: 'warning' },
  skipped: { label: 'Пропущен', status: 'neutral' },
}

type Scope = 'shift' | 'all'

export default function Dashboard() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<MsReceiptStatus | 'all'>('pending')
  const [scope, setScope] = useState<Scope>('shift')
  const shift = useShiftStatus()
  const [items, setItems] = useState<MsReceiptRow[]>([])
  const [counts, setCounts] = useState<Record<MsReceiptStatus, number>>({
    pending: 0,
    matched: 0,
    fiscalized: 0,
    failed: 0,
    manual: 0,
    skipped: 0,
  })
  const [pollerStatus, setPollerStatus] = useState<PollerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void ensurePollerStarted().catch((e) => {
      setError(e instanceof Error ? e.message : String(e))
    })
    const unsub = subscribePollerStatus(setPollerStatus)
    return () => {
      unsub()
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(t)
  }, [filter])

  async function load() {
    setLoading(true)
    try {
      const [rows, byStatus] = await Promise.all([
        listMsReceipts({
          status: filter === 'all' ? undefined : filter,
          limit: 100,
        }),
        countMsReceiptsByStatus(),
      ])
      setItems(rows)
      setCounts(byStatus)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Локальный фильтр по retailShift.id из raw_json. Поллер тащит все чеки
  // в БД (для истории), а UI показывает текущую смену по умолчанию.
  const visibleItems = useMemo(() => {
    if (scope === 'all') return items
    if (!shift.shiftId) return []
    return items.filter((it) => getShiftIdFromRawJson(it.raw_json) === shift.shiftId)
  }, [items, scope, shift.shiftId])

  const subtitle = (() => {
    const total = visibleItems.length
    const pendingCount = visibleItems.filter((i) => i.status === 'pending').length
    if (total === 0) return 'Нет чеков'
    if (filter === 'pending') return `${pendingCount} ожидают фискализации`
    return `${total} ${total === 1 ? 'чек' : total < 5 ? 'чека' : 'чеков'}`
  })()

  const columns: Column<MsReceiptRow>[] = [
    {
      key: 'name',
      label: 'Чек',
      width: '20%',
      cell: (r) => (
        <span className="font-medium text-ink">{r.ms_name ?? `#${r.id}`}</span>
      ),
    },
    {
      key: 'time',
      label: 'Время',
      cell: (r) => (
        <span className="text-ink-muted">{formatDateTime(r.ms_moment)}</span>
      ),
    },
    {
      key: 'sum',
      label: 'Сумма',
      align: 'right',
      mono: true,
      cell: (r) => (
        <span className="text-ink">{tiyinToSumDisplay(r.ms_sum_tiyin)} сум</span>
      ),
    },
    {
      key: 'status',
      label: 'Статус',
      width: '140px',
      cell: (r) => {
        const m = STATUS_TO_BADGE[r.status]
        return <StatusBadge status={m.status}>{m.label}</StatusBadge>
      },
    },
    {
      key: 'action',
      label: '',
      width: '80px',
      align: 'right',
      cell: () => (
        <ArrowRight size={16} className="text-ink-subtle inline-block" />
      ),
    },
  ]

  return (
    <div className="space-y-6">
      <PageHeader
        title="Касса"
        subtitle={subtitle}
        icon={<ReceiptIcon size={24} />}
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void load()}
            icon={<RefreshCcw size={14} />}
          >
            Обновить
          </Button>
        }
      />

      {/* Top row: scope selector + poller indicator */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeButton active={scope === 'shift'} onClick={() => setScope('shift')}>
            Текущая смена
            {shift.shiftId && shift.openedAt && (
              <span className="ml-1.5 text-ink-subtle">
                {shift.openedAt.toLocaleTimeString('ru-RU', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            )}
          </ScopeButton>
          <ScopeButton active={scope === 'all'} onClick={() => setScope('all')}>
            Все чеки
          </ScopeButton>
          {scope === 'shift' && !shift.shiftId && shift.ready && (
            <span className="ml-2 text-caption text-warning">
              Смена не открыта в МойСклад
            </span>
          )}
        </div>
        <PollerIndicator status={pollerStatus} />
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const isActive = filter === f.value
          const count = f.value === 'all' ? null : counts[f.value as MsReceiptStatus]
          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-caption transition-colors',
                isActive
                  ? 'border-primary bg-primary text-ink-inverse'
                  : 'border-border bg-surface text-ink-muted hover:bg-surface-hover hover:text-ink',
              )}
            >
              {f.label}
              {count != null && (
                <Badge
                  variant={isActive ? 'primary' : 'neutral'}
                  size="sm"
                  className={cn(
                    isActive && 'bg-ink-inverse/20 text-ink-inverse border-transparent',
                  )}
                >
                  {count}
                </Badge>
              )}
            </button>
          )
        })}
      </div>

      {error && (
        <Card>
          <Card.Body className="text-danger text-body">{error}</Card.Body>
        </Card>
      )}

      <Card>
        {visibleItems.length === 0 && !loading ? (
          <EmptyState
            icon={<ReceiptIcon size={36} />}
            title={
              scope === 'shift'
                ? shift.shiftId
                  ? 'В этой смене пока нет чеков'
                  : 'Откройте смену в МойСклад'
                : 'Нет чеков'
            }
            description={
              scope === 'shift' && !shift.shiftId
                ? 'Чеки появятся здесь сразу после того как кассир откроет смену в МС.'
                : 'Чеки автоматически появятся когда МС-касса пробьёт первый.'
            }
          />
        ) : (
          <DataTable
            columns={columns}
            rows={visibleItems}
            rowKey={(r) => r.id}
            onRowClick={(r) => navigate(`/receipts/${r.id}`)}
            loading={loading && visibleItems.length === 0}
          />
        )}
      </Card>
    </div>
  )
}

function ScopeButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-md px-3 py-1.5 text-caption transition-colors',
        active
          ? 'bg-primary text-ink-inverse'
          : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}

function PollerIndicator({ status }: { status: PollerStatus | null }) {
  const isOk = !!status?.running && !status.lastError
  const isErr = !!status?.lastError
  const Icon = isOk ? Wifi : WifiOff
  const tone = isOk ? 'text-success' : isErr ? 'text-warning' : 'text-ink-subtle'
  const label = !status?.running
    ? 'МС: не запущен'
    : isErr
      ? 'МС: ошибка'
      : `МС: каждые ${status.intervalSec}с`
  return (
    <div
      className={cn('flex items-center gap-1.5 text-caption', tone)}
      title={status?.lastError ?? undefined}
    >
      <Icon size={14} />
      <span>{label}</span>
    </div>
  )
}
