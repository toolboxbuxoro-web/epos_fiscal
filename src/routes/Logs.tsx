import { useEffect, useState } from 'react'
import {
  clearLogs,
  listLogs,
  type LogLevel,
  type LogRow,
  type LogSource,
} from '@/lib/log'
import { Button } from '@/components/ui/Button'
import { Select } from '@/components/ui/Select'
import { formatDateTime } from '@/lib/format'

const LEVELS: { value: LogLevel | 'all'; label: string }[] = [
  { value: 'all', label: 'Все' },
  { value: 'error', label: 'Ошибки' },
  { value: 'warn', label: 'Предупреждения' },
  { value: 'info', label: 'Инфо' },
  { value: 'debug', label: 'Отладка' },
]

const SOURCES: { value: LogSource | 'all'; label: string }[] = [
  { value: 'all', label: 'Все источники' },
  { value: 'app', label: 'Приложение' },
  { value: 'poller', label: 'Опрос МойСклад' },
  { value: 'moysklad', label: 'МойСклад API' },
  { value: 'epos', label: 'EPOS Communicator' },
  { value: 'matcher', label: 'Подбор' },
  { value: 'fiscalize', label: 'Фискализация' },
  { value: 'updater', label: 'Обновления' },
  { value: 'ui', label: 'Интерфейс' },
]

export default function Logs() {
  const [rows, setRows] = useState<LogRow[]>([])
  const [level, setLevel] = useState<LogLevel | 'all'>('all')
  const [source, setSource] = useState<LogSource | 'all'>('all')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    try {
      const r = await listLogs({
        level: level === 'all' ? undefined : level,
        source: source === 'all' ? undefined : source,
        limit: 500,
      })
      setRows(r)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  useEffect(() => {
    void load()
  }, [level, source])

  useEffect(() => {
    if (!autoRefresh) return
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [autoRefresh, level, source])

  async function doClear() {
    if (!confirm('Очистить все логи?')) return
    await clearLogs()
    await load()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Логи</h1>
          <p className="mt-1 text-sm text-slate-500">
            Диагностика приложения. Здесь видны все важные события и ошибки.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void load()}>
            Обновить
          </Button>
          <Button variant="ghost" size="sm" onClick={doClear}>
            Очистить
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={level}
          onChange={(e) => setLevel(e.target.value as LogLevel | 'all')}
          className="max-w-[200px]"
        >
          {LEVELS.map((l) => (
            <option key={l.value} value={l.value}>
              {l.label}
            </option>
          ))}
        </Select>
        <Select
          value={source}
          onChange={(e) => setSource(e.target.value as LogSource | 'all')}
          className="max-w-[260px]"
        >
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={autoRefresh}
            onChange={(e) => setAutoRefresh(e.target.checked)}
          />
          Автообновление каждые 3 сек
        </label>
        <span className="ml-auto text-xs text-slate-500">
          Записей: {rows.length}
        </span>
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
              <Th className="w-40">Время</Th>
              <Th className="w-24">Уровень</Th>
              <Th className="w-32">Источник</Th>
              <Th>Сообщение</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={4}>
                  Логов пока нет.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <>
                  <tr
                    key={r.id}
                    className={`cursor-pointer hover:bg-slate-50 ${
                      r.level === 'error'
                        ? 'bg-red-50/40'
                        : r.level === 'warn'
                          ? 'bg-amber-50/40'
                          : ''
                    }`}
                    onClick={() =>
                      setExpandedId(expandedId === r.id ? null : r.id)
                    }
                  >
                    <Td className="text-xs text-slate-600">
                      {formatDateTime(r.ts)}
                    </Td>
                    <Td>
                      <LevelBadge level={r.level} />
                    </Td>
                    <Td className="text-xs text-slate-600">{r.source}</Td>
                    <Td className="font-medium text-slate-900">{r.message}</Td>
                  </tr>
                  {expandedId === r.id && r.details && (
                    <tr key={`${r.id}-d`}>
                      <td colSpan={4} className="bg-slate-50 px-4 py-2">
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words text-xs text-slate-700">
                          {prettyJson(r.details)}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2)
  } catch {
    return s
  }
}

const LEVEL_STYLES: Record<LogLevel, string> = {
  debug: 'bg-slate-100 text-slate-600',
  info: 'bg-blue-100 text-blue-700',
  warn: 'bg-amber-100 text-amber-800',
  error: 'bg-red-100 text-red-700',
}

function LevelBadge({ level }: { level: LogLevel }) {
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${LEVEL_STYLES[level]}`}
    >
      {level}
    </span>
  )
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={`px-3 py-2 text-left text-xs font-medium text-slate-600 ${className}`}>
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>
}
