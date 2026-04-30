import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
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
import { formatDateTime, tiyinToSumDisplay } from '@/lib/format'

const STATUS_FILTERS: { value: MsReceiptStatus | 'all'; label: string }[] = [
  { value: 'pending', label: 'Ожидают' },
  { value: 'matched', label: 'Подобраны' },
  { value: 'fiscalized', label: 'Готовы' },
  { value: 'failed', label: 'Ошибки' },
  { value: 'all', label: 'Все' },
]

export default function Dashboard() {
  const [filter, setFilter] = useState<MsReceiptStatus | 'all'>('pending')
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
    // Авто-обновление списка раз в 5 секунд.
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

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Очередь чеков</h1>
          <p className="mt-1 text-sm text-slate-500">
            Чеки из МойСклад — выберите ожидающий, чтобы собрать и фискализировать.
          </p>
        </div>
        <PollerIndicator status={pollerStatus} />
      </div>

      <div className="flex flex-wrap gap-2">
        {STATUS_FILTERS.map((f) => (
          <button
            key={f.value}
            onClick={() => setFilter(f.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition ${
              filter === f.value
                ? 'border-slate-900 bg-slate-900 text-white'
                : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {f.label}
            {f.value !== 'all' && (
              <span className="ml-1.5 opacity-70">
                {counts[f.value as MsReceiptStatus] ?? 0}
              </span>
            )}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>№</Th>
              <Th>Время</Th>
              <Th>Сумма</Th>
              <Th>Статус</Th>
              <Th>Действие</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={5}>
                  Загрузка…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={5}>
                  Нет чеков с этим статусом.
                </td>
              </tr>
            ) : (
              items.map((it) => (
                <tr key={it.id} className="hover:bg-slate-50">
                  <Td className="font-medium">{it.ms_name ?? `#${it.id}`}</Td>
                  <Td>{formatDateTime(it.ms_moment)}</Td>
                  <Td className="text-right tabular-nums">
                    {tiyinToSumDisplay(it.ms_sum_tiyin)} сум
                  </Td>
                  <Td>
                    <StatusBadge status={it.status} />
                  </Td>
                  <Td>
                    <Link
                      to={`/receipts/${it.id}`}
                      className="text-sm font-medium text-slate-900 underline-offset-2 hover:underline"
                    >
                      Открыть →
                    </Link>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function PollerIndicator({ status }: { status: PollerStatus | null }) {
  const isOk = !!status?.running && !status.lastError
  const isWarn = !!status?.lastError
  const dotColor = isOk ? 'bg-emerald-500' : isWarn ? 'bg-amber-500' : 'bg-slate-300'
  return (
    <div className="flex flex-col items-end gap-0.5 text-xs">
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
        <span className="text-slate-600">
          {!status?.running
            ? 'МойСклад: не запущен'
            : isWarn
              ? 'МойСклад: ошибка'
              : `МойСклад: каждые ${status.intervalSec}с`}
        </span>
      </div>
      {status?.lastSuccessAt && (
        <span className="text-slate-400">
          Последний успех: {formatDateTime(status.lastSuccessAt)}
        </span>
      )}
      {status?.lastError && (
        <span className="text-amber-700" title={status.lastError}>
          {status.lastError.slice(0, 60)}…
        </span>
      )}
    </div>
  )
}

const STATUS_LABELS: Record<MsReceiptStatus, { label: string; color: string }> = {
  pending: { label: 'Ожидает', color: 'bg-slate-100 text-slate-700' },
  matched: { label: 'Подобран', color: 'bg-blue-100 text-blue-700' },
  fiscalized: { label: 'Готов', color: 'bg-emerald-100 text-emerald-700' },
  failed: { label: 'Ошибка', color: 'bg-red-100 text-red-700' },
  manual: { label: 'Ручной', color: 'bg-amber-100 text-amber-700' },
  skipped: { label: 'Пропущен', color: 'bg-slate-100 text-slate-500' },
}

function StatusBadge({ status }: { status: MsReceiptStatus }) {
  const { label, color } = STATUS_LABELS[status]
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${color}`}>
      {label}
    </span>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>
}
