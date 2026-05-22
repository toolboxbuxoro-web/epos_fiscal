import { useEffect, useMemo, useState } from 'react'
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
}

type Scope = 'shift' | 'all'

/** Сколько чеков на странице в режиме «Все чеки». */
const ALL_PAGE_SIZE = 50

/** Тип оплаты чека — определяется по cashSum/noCashSum/qrSum из raw_json МС. */
type PayKind = 'cash' | 'card' | 'qr' | 'mixed' | null

/**
 * Определить способ оплаты из raw_json МС-чека.
 *
 * МС возвращает три поля: cashSum (наличные), noCashSum (банк.карта),
 * qrSum (QR — Click/Payme/Uzcard QR). Логика та же что в Receipt.tsx::paymentKind.
 *   - есть нал И есть безнал → 'mixed' (смешанная)
 *   - только qr → 'qr'
 *   - только карта → 'card'
 *   - только нал → 'cash'
 *   - всё по нулям / битый json → null
 */
function getPaymentKind(rawJson: string): PayKind {
  try {
    const rd = JSON.parse(rawJson) as {
      cashSum?: number
      noCashSum?: number
      qrSum?: number
    }
    const cash = rd.cashSum ?? 0
    const card = rd.noCashSum ?? 0
    const qr = rd.qrSum ?? 0
    const hasCard = card > 0 || qr > 0
    if (cash > 0 && hasCard) return 'mixed'
    if (qr > 0) return 'qr'
    if (card > 0) return 'card'
    if (cash > 0) return 'cash'
    return null
  } catch {
    return null
  }
}

const PAY_LABEL: Record<'cash' | 'card' | 'qr' | 'mixed', string> = {
  cash: 'Наличные',
  card: 'Карта',
  qr: 'QR',
  mixed: 'Смешанная',
}

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
    not_required: 0,
  })
  const [pollerStatus, setPollerStatus] = useState<PollerStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** Страница (0-based) для режима «Все чеки». В режиме смены не используется. */
  const [page, setPage] = useState(0)

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
    // scope/filter/page в deps:
    //   - «Текущая смена» — load() грузит широкое окно чеков для in-memory
    //     подсчёта по смене (page игнорируется)
    //   - «Все чеки» — постраничный SQL-запрос (offset = page × PAGE_SIZE)
    //     + глобальный аггрегат счётчиков
  }, [filter, scope, page])

  async function load() {
    setLoading(true)
    try {
      if (scope === 'all') {
        // Глобально: ПОСТРАНИЧНЫЙ список + SQL-аггрегат счётчиков.
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
      } else {
        // По смене: грузим окно последних чеков (одна смена заведомо < 1000),
        // дальше фильтрация по shiftId + по статусу и подсчёт бейджей идут
        // in-memory (см. shiftItems / visibleItems / displayCounts). Это
        // нужно потому что shiftId лежит внутри raw_json (JSON), и SQL им
        // фильтровать нельзя.
        const rows = await listMsReceipts({ limit: 1000 })
        setItems(rows)
        // counts (глобальный) в shift-scope не используется — displayCounts
        // считает из shiftItems. Но обновим чтобы не висело старое значение.
      }
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  // Чеки ТЕКУЩЕЙ смены (все статусы) — фильтр по retailShift.id из raw_json.
  // Поллер тащит все чеки в БД (для истории), UI по умолчанию показывает смену.
  // В scope='all' пусто — там работаем напрямую с items.
  const shiftItems = useMemo(() => {
    if (scope !== 'shift') return []
    if (!shift.shiftId) return []
    return items.filter(
      (it) => getShiftIdFromRawJson(it.raw_json) === shift.shiftId,
    )
  }, [items, scope, shift.shiftId])

  // Что показывать в таблице:
  //   scope='all'   — items уже отфильтрованы по статусу в load()
  //   scope='shift' — shiftItems + ручной фильтр по выбранному статусу
  const visibleItems = useMemo(() => {
    if (scope === 'all') return items
    if (filter === 'all') return shiftItems
    return shiftItems.filter((it) => it.status === filter)
  }, [items, shiftItems, scope, filter])

  // Счётчики на бейджах — теперь УВАЖАЮТ scope:
  //   scope='all'   — глобальный SQL-аггрегат (counts из load())
  //   scope='shift' — пересчёт по чекам текущей смены (shiftItems)
  // Раньше бейджи всегда показывали глобал → «Готовы 49» при пустой смене.
  const displayCounts = useMemo<Record<MsReceiptStatus, number>>(() => {
    if (scope === 'all') return counts
    const c: Record<MsReceiptStatus, number> = {
      pending: 0,
      matched: 0,
      fiscalized: 0,
      failed: 0,
      manual: 0,
      skipped: 0,
      not_required: 0,
    }
    for (const r of shiftItems) c[r.status]++
    return c
  }, [scope, counts, shiftItems])

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
        const k = getPaymentKind(r.raw_json)
        if (!k) return <span className="text-ink-subtle">—</span>
        // Смешанная — выделяем (кассиру важно: там может быть Click/Payme).
        return (
          <span
            className={k === 'mixed' ? 'text-warning font-medium' : 'text-ink-muted'}
          >
            {PAY_LABEL[k]}
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

      {/* Top row: scope selector + poller indicator */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <ScopeButton
            active={scope === 'shift'}
            onClick={() => {
              setScope('shift')
              setPage(0)
            }}
          >
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
          <ScopeButton
            active={scope === 'all'}
            onClick={() => {
              setScope('all')
              setPage(0)
            }}
          >
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

      {/* Пагинация — только в режиме «Все чеки». В режиме смены весь
          набор смены уже на экране (load грузит окно), страницы не нужны. */}
      {scope === 'all' && allTotal > 0 && (
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
