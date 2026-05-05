import { useEffect, useState } from 'react'
import {
  countEsfItems,
  listEsfItems,
  type EsfItemWithAvailable,
} from '@/lib/db'
import { Button, Card, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { CloudUpload, Loader2 } from 'lucide-react'
import {
  getMigrationStats,
  migrateLocalToServer,
  type MigrationProgress,
} from '@/lib/inventory'
import {
  formatDate,
  milliQtyToDisplay,
  tiyinToSumDisplay,
} from '@/lib/format'

export default function Catalog() {
  const [items, setItems] = useState<EsfItemWithAvailable[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Migration state
  const [unmigratedCount, setUnmigratedCount] = useState(0)
  const [migrating, setMigrating] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(
    null,
  )

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [rows, count, stats] = await Promise.all([
        listEsfItems({ search: search || undefined, limit: 200 }),
        countEsfItems(),
        getMigrationStats(),
      ])
      setItems(rows)
      setTotal(count)
      setUnmigratedCount(stats.unmigratedCount)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [search])

  async function startMigration() {
    if (
      !confirm(
        `Перенести ${unmigratedCount} локальных приходов в общий пул на сервере?\n\n` +
          `Это безопасно: повторный запуск не создаёт дубликаты, серверная сторона ` +
          `дедупит по (ИКПУ + наименование + дата прихода). Если такой же приход уже ` +
          `есть на сервере (например другой магазин уже его импортнул) — локальная ` +
          `строка просто привяжется к существующей серверной.\n\n` +
          `После миграции приходы перестанут импортироваться локально через Excel — ` +
          `их будет загружать бухгалтер централизованно через mytoolbox админку.`,
      )
    ) {
      return
    }
    setMigrating(true)
    setMigrationProgress(null)
    try {
      const result = await migrateLocalToServer((p) => setMigrationProgress(p))
      if (result.ok) {
        toast.success(
          `Миграция завершена: ${result.inserted} новых, ${result.skipped} уже было на сервере`,
        )
        await load() // обновим список + счётчики
      } else {
        toast.error(result.errorMessage ?? 'Миграция не завершилась')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setMigrating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Справочник приходов</h1>
          <p className="mt-1 text-sm text-ink-muted">
            Приходы с ИКПУ из общего пула. Загружает бухгалтер через mytoolbox админку —
            здесь только просмотр.
          </p>
        </div>
      </div>

      {/* Migration banner — есть непереданные локальные приходы (с 0.8.x). */}
      {unmigratedCount > 0 && (
        <Card className="border-info/20 bg-info-soft">
          <Card.Body className="flex items-start gap-3">
            <CloudUpload size={18} className="text-info shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-body font-medium text-ink">
                Локальные приходы нужно перенести в общий пул
              </div>
              <div className="text-caption text-ink-muted mt-0.5">
                {unmigratedCount} {unmigratedCount === 1 ? 'приход' : 'приходов'}{' '}
                остались с прошлой версии (импортированы локально через Excel).
                После переноса они станут доступны всем магазинам сети, до этого —
                фискализация будет падать с ошибкой «приход импортирован локально».
              </div>
              {migrationProgress && (
                <div className="mt-2 text-caption text-ink-muted">
                  Перенесено: {migrationProgress.processed} из{' '}
                  {migrationProgress.total} (новых: {migrationProgress.inserted}, уже было:{' '}
                  {migrationProgress.skipped}, ошибок: {migrationProgress.errors})
                </div>
              )}
            </div>
            <Button
              variant="primary"
              size="sm"
              onClick={startMigration}
              loading={migrating}
              icon={!migrating ? <CloudUpload size={14} /> : undefined}
            >
              Перенести
            </Button>
          </Card.Body>
        </Card>
      )}

      <div className="flex items-center gap-3">
        <Input
          placeholder="Поиск по названию или штрих-коду…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        <span className="text-xs text-ink-muted">Всего записей: {total}</span>
        {migrating && (
          <span className="text-xs text-info inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" />
            Миграция…
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-canvas">
            <tr>
              <Th>Наименование</Th>
              <Th>ИКПУ</Th>
              <Th>Цена</Th>
              <Th>Получено</Th>
              <Th>Доступно</Th>
              <Th>НДС</Th>
              <Th>Дата</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={7}>
                  Загрузка…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={7}>
                  {search
                    ? 'По запросу ничего не найдено.'
                    : 'Справочник пуст. Бухгалтер загружает приходы через mytoolbox админку.'}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-canvas">
                  <Td>
                    <div className="font-medium text-ink">{item.name}</div>
                    {item.barcode && (
                      <div className="text-xs text-ink-muted">{item.barcode}</div>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{item.class_code}</Td>
                  <Td className="text-right">{tiyinToSumDisplay(item.unit_price_tiyin)}</Td>
                  <Td className="text-right">{milliQtyToDisplay(item.qty_received)}</Td>
                  <Td className="text-right">
                    <span
                      className={
                        item.available > 0 ? 'text-success font-medium' : 'text-ink-subtle'
                      }
                    >
                      {milliQtyToDisplay(item.available)}
                    </span>
                  </Td>
                  <Td className="text-center">{item.vat_percent}%</Td>
                  <Td className="text-xs text-ink-muted">{formatDate(item.received_at)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium text-ink-muted">
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>
}
