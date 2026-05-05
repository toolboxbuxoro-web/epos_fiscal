import { useEffect, useState } from 'react'
import {
  countEsfItems,
  getSetting,
  listEsfItems,
  SettingKey,
  type EsfItemWithAvailable,
} from '@/lib/db'
import { Button, Card, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { ExcelImportDialog } from '@/components/ExcelImportDialog'
import { CloudUpload, Loader2, TriangleAlert } from 'lucide-react'
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
  const [showImport, setShowImport] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Migration state
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [unmigratedCount, setUnmigratedCount] = useState(0)
  const [migrating, setMigrating] = useState(false)
  const [migrationProgress, setMigrationProgress] = useState<MigrationProgress | null>(
    null,
  )

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [rows, count, remote, stats] = await Promise.all([
        listEsfItems({ search: search || undefined, limit: 200 }),
        countEsfItems(),
        getSetting(SettingKey.InventoryRemoteEnabled),
        getMigrationStats(),
      ])
      setItems(rows)
      setTotal(count)
      setRemoteEnabled(remote === 'true')
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
            Товары с налоговыми приходами. Из них Matcher собирает чеки для отправки в EPOS.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setShowImport(true)}>
            Импорт Excel
          </Button>
        </div>
      </div>

      {/* Migration banner — показывается когда remote включён И есть
          непереданные локальные приходы. После миграции счётчик 0 → исчезает. */}
      {remoteEnabled && unmigratedCount > 0 && (
        <Card className="border-info/20 bg-info-soft">
          <Card.Body className="flex items-start gap-3">
            <CloudUpload size={18} className="text-info shrink-0 mt-0.5" />
            <div className="flex-1 min-w-0">
              <div className="text-body font-medium text-ink">
                Локальные приходы можно перенести в общий пул
              </div>
              <div className="text-caption text-ink-muted mt-0.5">
                {unmigratedCount} {unmigratedCount === 1 ? 'приход' : 'приходов'}{' '}
                импортированы локально через Excel и пока не привязаны к серверу.
                После переноса остатки будут синхронизироваться с другими магазинами.
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

      {/* Warning когда remote включён но локально импорт через Excel */}
      {remoteEnabled && unmigratedCount === 0 && (
        <Card className="border-warning/20 bg-warning-soft">
          <Card.Body className="flex items-start gap-3 text-caption">
            <TriangleAlert size={16} className="text-warning shrink-0 mt-0.5" />
            <div className="text-ink">
              <strong className="text-warning">Remote-режим активен.</strong>{' '}
              Импорт Excel локально больше не используется — приходы загружает
              бухгалтер централизованно через mytoolbox админку.
            </div>
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
                    : 'Справочник пуст. Импортируйте приходы из Excel.'}
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

      {showImport && (
        <ExcelImportDialog
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false)
            void load()
          }}
        />
      )}
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
