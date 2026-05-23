import { useEffect, useState } from 'react'
import { formatErrorForUser } from '@/lib/error-message'
import {
  countEsfItems,
  getSetting,
  listEsfItems,
  SettingKey,
  type EsfItemWithAvailable,
} from '@/lib/db'
import { calculateSellingPrice } from '@/lib/matcher/strategies'
import { Button, Card, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { CloudUpload, Loader2, RefreshCw } from 'lucide-react'
import {
  getMigrationStats,
  migrateLocalToServer,
  syncFromServer,
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
  // Полная пересинхронизация с сервером (forceFull + reconcile удаляет
  // призраков). Сервер — источник правды; Справочник всегда показывает
  // ровно то что на сервере.
  const [syncing, setSyncing] = useState(false)
  // Параметры ценообразования (наценка / шаг округления / ставка НДС) —
  // нужны для расчёта ПРОДАЖНОЙ цены в колонке таблицы. Те же что matcher
  // использует в loadMatcherPool. Дефолты: 10% / 1000 сум / 12%.
  const [pricing, setPricing] = useState({ markup: 10, roundUp: 1000, vat: 12 })

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [rows, count, stats, markupS, roundS, vatS] = await Promise.all([
        // source='remote' — показываем только синкнутые из mytoolbox.
        // Legacy excel-импорты (если ещё не удалены миграцией 004) фильтруем —
        // чтобы кассир не путался какие товары актуальны.
        listEsfItems({ search: search || undefined, limit: 200, source: 'remote' }),
        countEsfItems(),
        getMigrationStats(),
        getSetting(SettingKey.MarkupPercent),
        getSetting(SettingKey.RoundUpToSum),
        getSetting(SettingKey.DefaultVatPercent),
      ])
      setItems(rows)
      setTotal(count)
      setUnmigratedCount(stats.unmigratedCount)
      // Важно: не `|| def` — иначе валидный 0 (НДС упрощёнки) превратился бы
      // в дефолт 12. Проверяем Number.isFinite явно.
      const parseNum = (v: string | null, def: number) => {
        if (v == null || v === '') return def
        const n = Number.parseInt(v, 10)
        return Number.isFinite(n) ? n : def
      }
      setPricing({
        markup: parseNum(markupS, 10),
        roundUp: parseNum(roundS, 1000),
        vat: parseNum(vatS, 12),
      })
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setLoading(false)
    }
  }

  /**
   * Полная пересинхронизация: тянем ПОЛНЫЙ снимок сервера + reconcile
   * (удаляем локальные приходы которых на сервере уже нет — TRUNCATE,
   * удаление прихода бухгалтером и т.п.). После — перечитываем список.
   *
   * Вызывается:
   *   - автоматически при открытии экрана (см. useEffect ниже) — чтобы
   *     кассир ВСЕГДА видел актуальный серверный пул, а не застрявший кэш
   *   - вручную кнопкой «Обновить с сервера»
   */
  async function fullResync(manual: boolean) {
    setSyncing(true)
    setError(null)
    try {
      const r = await syncFromServer({ forceFull: true })
      if (manual) {
        toast.success(
          `Синхронизировано: ${r.synced} приходов` +
            (r.deleted > 0 ? `, удалено призраков: ${r.deleted}` : '') +
            (r.errors > 0 ? `, ошибок: ${r.errors}` : ''),
          { duration: 4000 },
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // Не блокируем — покажем что есть в кэше + предупреждение.
      setError(`Не удалось синхронизироваться с сервером: ${msg}. Показан локальный кэш.`)
    } finally {
      setSyncing(false)
    }
    await load()
  }

  // При открытии экрана — сразу форс-ресинк с сервера (источник правды),
  // потом load() внутри fullResync покажет актуальные данные.
  useEffect(() => {
    void fullResync(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Поиск — только перечитать локально (sync уже прошёл при открытии).
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
            здесь только просмотр. Данные берутся <strong>с сервера</strong>.
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void fullResync(true)}
          loading={syncing}
          icon={!syncing ? <RefreshCw size={14} /> : undefined}
          title="Полная пересинхронизация: тянет актуальный снимок сервера и убирает приходы которых там больше нет"
        >
          {syncing ? 'Синхронизация…' : 'Обновить с сервера'}
        </Button>
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
        {syncing && (
          <span className="text-xs text-info inline-flex items-center gap-1">
            <Loader2 size={12} className="animate-spin" />
            Синхронизация с сервером…
          </span>
        )}
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
              <Th>Приходная</Th>
              <Th>Продажная</Th>
              <Th>Получено</Th>
              <Th>Доступно</Th>
              <Th>НДС</Th>
              <Th>Дата</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={8}>
                  Загрузка…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={8}>
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
                  <Td className="text-right text-ink-muted">
                    {tiyinToSumDisplay(item.unit_price_tiyin)}
                  </Td>
                  <Td className="text-right font-medium text-ink">
                    {tiyinToSumDisplay(
                      calculateSellingPrice(
                        item.unit_price_tiyin,
                        pricing.vat,
                        pricing.markup,
                        pricing.roundUp,
                      ),
                    )}
                  </Td>
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
