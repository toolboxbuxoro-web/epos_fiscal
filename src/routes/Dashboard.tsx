import { useEffect, useMemo, useState } from 'react'
import { formatErrorForUser } from '@/lib/error-message'
import { useNavigate } from 'react-router-dom'
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
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
  pollMoyskladNow,
  subscribePollerStatus,
} from '@/lib/poller-runtime'
import type { PollerStatus } from '@/lib/moysklad/poller'
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

// «Подобраны» (matched) убран: статус нигде не выставляется — поллер
// пишет 'pending', после фискализации сразу 'fiscalized'. Вкладка всегда
// показывала 0 и только путала кассира. Сам статус 'matched' оставлен
// в enum на случай будущего использования.
const STATUS_FILTERS: { value: MsReceiptStatus | 'all'; label: string }[] = [
  { value: 'pending', label: 'Ожидают' },
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
  not_required: { label: 'Не фискальный', status: 'neutral' },
  currency_mismatch: { label: 'Чужая валюта', status: 'warning' },
}

/** Сколько чеков на странице в режиме «Все чеки». */
const ALL_PAGE_SIZE = 50

/**
 * Что показать в колонке «Оплата».
 *
 * У отгрузки разбивки «наличные / карта» нет — она появляется, только когда
 * экран чека дотянет связанные платежи. Здесь хватает `payedSum`: кассиру
 * в очереди важно другое — оплачена ли отгрузка вообще. Неоплаченную
 * пробить не получится, и лучше увидеть это до того, как её открыть.
 *
 * Старые розничные чеки остаются в базе: для них, как раньше, наличные,
 * карта, QR или смешанная.
 */
function getPaymentLabel(rawJson: string): { label: string; tone: 'ok' | 'warn' | 'muted' } | null {
  try {
    const doc = JSON.parse(rawJson) as {
      meta?: { type?: string }
      sum?: number
      payedSum?: number
      cashSum?: number
      noCashSum?: number
      qrSum?: number
    }
    if (doc.meta?.type === 'retaildemand') {
      const cash = doc.cashSum ?? 0
      const card = doc.noCashSum ?? 0
      const qr = doc.qrSum ?? 0
      if (cash > 0 && (card > 0 || qr > 0)) return { label: 'Смешанная', tone: 'warn' }
      if (qr > 0) return { label: 'QR', tone: 'muted' }
      if (card > 0) return { label: 'Карта', tone: 'muted' }
      if (cash > 0) return { label: 'Наличные', tone: 'muted' }
      return null
    }
    const sum = doc.sum ?? 0
    const paid = doc.payedSum ?? 0
    if (sum > 0 && paid >= sum) return { label: 'Оплачена', tone: 'ok' }
    if (paid > 0) return { label: 'Частично', tone: 'warn' }
    return { label: 'Не оплачена', tone: 'warn' }
  } catch {
    return null
  }
}

export default function Dashboard() {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<MsReceiptStatus | 'all'>('pending')
  const [items, setItems] = useState<MsReceiptRow[]>([])
  const [counts, setCounts] = useState<Record<MsReceiptStatus, number>>({
    pending: 0,
    matched: 0,
    fiscalized: 0,
    failed: 0,
    manual: 0,
    skipped: 0,
    not_required: 0,
    currency_mismatch: 0,
  })
  const [pollerStatus, setPollerStatus] = useState<PollerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Страница (0-based). */
  const [page, setPage] = useState(0)

  useEffect(() => {
    void ensurePollerStarted().catch((e) => {
      setError(formatErrorForUser(e))
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
    // Постраничный SQL-запрос (offset = page × PAGE_SIZE) + аггрегат счётчиков.
  }, [filter, page])

  async function load() {
    setLoading(true)
    try {
      // Постраничный список + SQL-аггрегат счётчиков. Розничной смены
      // МойСклад, по которой раньше фильтровалась очередь, у отгрузок нет —
      // очередь это отгрузки в статусе «пробить», их и показываем.
      const [rows, byStatus] = await Promise.all([
        listMsReceipts({
          status: filter === 'all' ? undefined : filter,
          limit: ALL_PAGE_SIZE,
          offset: page * ALL_PAGE_SIZE,
        }),
        countMsReceiptsByStatus(),
      ])
      setItems(rows)
      setCounts(byStatus)
      setError(null)
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setLoading(false)
    }
  }

  const visibleItems = items
  const displayCounts = counts

  // ── Пагинация режима «Все чеки» ───────────────────────────────────
  // Всего записей под текущий фильтр: для конкретного статуса — counts[X],
  // для «Все» — сумма всех. Берём из глобального аггрегата counts.
  const allTotal = useMemo(() => {
    if (filter === 'all') {
      return Object.values(counts).reduce((s, n) => s + n, 0)
    }
    return counts[filter]
  }, [filter, counts])
  const allPageCount = Math.max(1, Math.ceil(allTotal / ALL_PAGE_SIZE))
  const allRangeFrom = allTotal === 0 ? 0 : page * ALL_PAGE_SIZE + 1
  const allRangeTo = Math.min(allTotal, page * ALL_PAGE_SIZE + items.length)

  /**
   * Кнопка «Обновить»: раньше только перечитывала локальную БД — кассир
   * жал и «ничего не происходило», потому что новые чеки из МойСклад
   * подтягивает поллер (раз в 30 сек), а не эта кнопка.
   *
   * Теперь кнопка сначала ПРИНУДИТЕЛЬНО опрашивает МойСклад (pollMoyskladNow),
   * затем перечитывает БД (load). Так клик реально подтягивает свежие чеки.
   */
  async function refreshNow(): Promise<void> {
    setLoading(true)
    try {
      await pollMoyskladNow()
    } catch {
      // Ошибки опроса отражаются в PollerIndicator — здесь глушим,
      // load() ниже всё равно покажет что есть в БД.
    }
    await load()
  }

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
      key: 'payment',
      label: 'Оплата',
      width: '130px',
      cell: (r) => {
        const p = getPaymentLabel(r.raw_json)
        if (!p) return <span className="text-ink-subtle">—</span>
        return (
          <span
            className={
              p.tone === 'warn'
                ? 'text-warning font-medium'
                : p.tone === 'ok'
                  ? 'text-success'
                  : 'text-ink-muted'
            }
          >
            {p.label}
          </span>
        )
      },
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
            onClick={() => void refreshNow()}
            disabled={loading}
            icon={<RefreshCcw size={14} />}
          >
            Обновить
          </Button>
        }
      />

      {/* Состояние опроса МойСклад */}
      <div className="flex flex-wrap items-center justify-end gap-4">
        <PollerIndicator status={pollerStatus} />
      </div>

      {/* Status filters */}
      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => {
          const isActive = filter === f.value
          const count =
            f.value === 'all' ? null : displayCounts[f.value as MsReceiptStatus]
          return (
            <button
              key={f.value}
              onClick={() => {
                setFilter(f.value)
                setPage(0)
              }}
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
            title="Нет отгрузок"
            description="Отгрузки со склада кассы появятся здесь, как только их переведут в статус, выбранный в Настройках."
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

      {/* Пагинация */}
      {allTotal > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-caption text-ink-muted">
            {allRangeFrom}–{allRangeTo} из {allTotal}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ChevronLeft size={14} />}
              disabled={page <= 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Назад
            </Button>
            <span className="text-caption text-ink-muted tabular-nums select-none">
              Страница {page + 1} из {allPageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconRight={<ChevronRight size={14} />}
              disabled={page >= allPageCount - 1 || loading}
              onClick={() => setPage((p) => Math.min(allPageCount - 1, p + 1))}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
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
