import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  Minus,
  Plus,
  Scissors,
  CreditCard,
  QrCode,
  Send,
  SplitSquareHorizontal,
  TriangleAlert,
} from 'lucide-react'
import {
  getDb,
  getMsReceipt,
  getSetting,
  setMsReceiptStatus,
  SettingKey,
  now,
} from '@/lib/db'
import type { MsReceiptRow } from '@/lib/db/types'
import {
  buildMatch,
  extractPositions,
  loadMatcherPool,
  recalculateAfterSwap,
  rebuildPositionWithSplit,
  type BuildMatchResult,
  type MatcherPool,
} from '@/lib/matcher'
import type { MatcherOptions } from '@/lib/matcher/types'
import { fiscalize, InventoryConflictError } from '@/lib/epos'
import { MoyskladClient, inlinePositions, type MsRetailDemand } from '@/lib/moysklad'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  toast,
} from '@/components/ui'
import {
  formatDateTime,
  milliQtyToDisplay,
  tiyinToSumDisplay,
  tiyinToSumDisplayPrecise,
} from '@/lib/format'
import { cn } from '@/lib/cn'

export default function Receipt() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()

  const [receipt, setReceipt] = useState<MsReceiptRow | null>(null)
  const [match, setMatch] = useState<BuildMatchResult | null>(null)
  // Сохраняем опции последнего вызова buildMatch — нужны при swap/split
  // (recalculateAfterSwap / rebuildPositionWithSplit вызывают distribute
  // c теми же лимитами).
  const [matcherOpts, setMatcherOpts] = useState<MatcherOptions>({})
  // Кэш пула товаров — переиспользуется при swap/split чтобы не перегружать
  // SQLite каждый клик. Загружается параллельно с buildMatch.
  const [pool, setPool] = useState<MatcherPool | null>(null)
  // Тост для UX «не получилось раздробить» / «нет альтернатив».
  const [splitToast, setSplitToast] = useState<string | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fiscalizing, setFiscalizing] = useState(false)
  const [testMode, setTestMode] = useState(false)
  /**
   * server_item_id'ы которые сервер отказал на reserve (другой магазин
   * успел забрать). При rematch matcher их игнорирует — иначе сразу
   * предложил бы те же товары и снова получил 409.
   */
  const [excludedServerIds, setExcludedServerIds] = useState<number[]>([])

  const rd: MsRetailDemand | null = useMemo(() => {
    if (!receipt) return null
    try {
      return JSON.parse(receipt.raw_json) as MsRetailDemand
    } catch {
      return null
    }
  }, [receipt])

  const sourcePositions = useMemo(() => {
    if (!rd) return []
    return extractPositions(rd)
  }, [rd])

  /**
   * Список товаров в подборе у которых пустой ИКПУ или код упаковки.
   *
   * Без MXIK ОФД не начисляет покупателю кешбэк и магазин рискует штрафом
   * 1% от суммы (постановление ВМ-255 от 12.05.2022 п.20 ч.5). Поэтому
   * фискализацию таких чеков мы блокируем — кассир должен дозаполнить
   * ИКПУ в админке mytoolbox.
   *
   * Считаем уникальные имена чтобы баннер не дублировал товары когда
   * один и тот же выбран в multi-item / split.
   */
  const itemsWithoutIkpu = useMemo(() => {
    if (!match) return [] as string[]
    const names = new Set<string>()
    for (const pm of match.positions) {
      for (const c of pm.candidates) {
        if (!c.esfItem.class_code || !c.esfItem.package_code) {
          names.add(c.esfItem.name)
        }
      }
    }
    return Array.from(names)
  }, [match])

  const matchedSourceIndexes = useMemo(() => {
    if (!match) return new Set<number>()
    return new Set(match.positions.map((pm) => pm.source.index))
  }, [match])

  /**
   * Тип оплаты из МойСклад — для бейджа над заголовком.
   * См. подробное описание правил в коммитах прошлых релизов.
   */
  const paymentKind = useMemo<
    null | 'cash' | 'card' | 'qr' | 'mixed'
  >(() => {
    if (!rd) return null
    const cash = rd.cashSum ?? 0
    const card = rd.noCashSum ?? 0
    const qr = rd.qrSum ?? 0
    const hasCard = card > 0 || qr > 0
    if (cash > 0 && hasCard) return 'mixed'
    if (qr > 0) return 'qr'
    if (card > 0) return 'card'
    if (cash > 0) return 'cash'
    return null
  }, [rd])

  useEffect(() => {
    void load()
  }, [id])

  async function load() {
    setBusy(true)
    setError(null)
    try {
      const r = await getMsReceipt(Number(id))
      if (!r) {
        setError('Чек не найден')
        return
      }
      setReceipt(r)

      let parsed = JSON.parse(r.raw_json) as MsRetailDemand

      // МС в list-запросе не отдаёт inline positions. Если их нет —
      // одиночный GET с expand, обновляем raw_json в БД.
      if (!inlinePositions(parsed)) {
        const basic = await getSetting(SettingKey.MoyskladCredentials)
        const token = basic ? null : await getSetting(SettingKey.MoyskladToken)
        if (basic || token) {
          try {
            const client = new MoyskladClient(
              basic ? { basic } : { token: token! },
            )
            const full = await client.getRetailDemand(parsed.id)
            const newRawJson = JSON.stringify(full)
            const db = await getDb()
            await db.execute(
              'UPDATE ms_receipts SET raw_json = $1, updated_at = $2 WHERE id = $3',
              [newRawJson, now(), r.id],
            )
            parsed = full
            setReceipt({ ...r, raw_json: newRawJson })
          } catch (fetchErr) {
            console.warn('Не удалось дозагрузить позиции чека:', fetchErr)
          }
        }
      }

      const DEFAULT_TOLERANCE_TIYIN = 100_000
      const tolStr = await getSetting(SettingKey.MatchToleranceTiyin)
      const tolerance =
        tolStr != null && tolStr !== ''
          ? Number.parseInt(tolStr, 10) || 0
          : DEFAULT_TOLERANCE_TIYIN

      const markupStr = await getSetting(SettingKey.MarkupPercent)
      const markupPercent =
        markupStr != null && markupStr !== ''
          ? Number.parseInt(markupStr, 10) || 0
          : 10
      const roundStr = await getSetting(SettingKey.RoundUpToSum)
      const roundUpToSum =
        roundStr != null && roundStr !== ''
          ? Number.parseInt(roundStr, 10) || 0
          : 1000

      const discRaw = await getSetting(SettingKey.DiscountForExactSum)
      const discountEnabled = discRaw == null ? true : discRaw === 'true'
      const maxDiscStr = await getSetting(SettingKey.MaxDiscountPerItemSum)
      const maxDiscountSum =
        maxDiscStr != null && maxDiscStr !== ''
          ? Number.parseInt(maxDiscStr, 10) || 0
          : 2000
      const maxDiscountPerItemTiyin = maxDiscountSum * 100

      // Имя характеристики модификации МС для связки с приходом
      // (см. matcher/extract.ts::readLinkedBuhName). Default —
      // 'Бухгалтерское наименование'. Бухгалтер может назвать иначе через
      // Settings → «Имя характеристики связки».
      const linkCharRaw = await getSetting(SettingKey.MsLinkCharacteristicName)
      const linkCharacteristicName =
        linkCharRaw && linkCharRaw.trim() ? linkCharRaw.trim() : 'Бухгалтерское наименование'

      const opts: MatcherOptions = {
        toleranceTiyin: tolerance,
        markupPercent,
        roundUpToSum,
        discountForExactSum: discountEnabled,
        maxDiscountPerItemTiyin,
        linkCharacteristicName,
        excludeServerItemIds: excludedServerIds.length > 0 ? excludedServerIds : undefined,
      }
      const result = await buildMatch(parsed, opts)
      setMatch(result)
      setMatcherOpts(opts)
      // Кэшируем пул для swap/split — заново не загружаем при каждом клике.
      // buildMatch внутри тоже грузит pool, но эту копию из state мы используем
      // в UI helpers (rebuildPositionWithSplit). Это +50ms при первом open
      // приемлемо — у юзера всё равно идёт fetch МС-чека и тяжёлый buildMatch.
      const freshPool = await loadMatcherPool(opts)
      setPool(freshPool)

      const test = (await getSetting(SettingKey.TestMode)) === 'true'
      setTestMode(test)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doFiscalize() {
    if (!match || !receipt) return
    setFiscalizing(true)
    setError(null)
    try {
      const result = await fiscalize(match, { msReceiptId: receipt.id })
      if (testMode) {
        const total = match.matchedTotalTiyin / 100
        const itemsCount = match.positions.reduce(
          (s, p) => s + p.candidates.length,
          0,
        )
        toast.success(
          `Тестовый режим: подбор готов на ${total.toLocaleString('ru-RU')} сум, ${itemsCount} позиций`,
          { duration: 5000 },
        )
        return
      }
      toast.success(`Чек фискализирован: ${result.fiscal.FiscalSign}`)
      nav('/history')
    } catch (e) {
      // Multi-shop конфликт: другой магазин успел забрать товар.
      // НЕ ставим status='failed' — чек не failed, просто нужно перематчить
      // с другим товаром. Добавляем отказанные server_item_id в exclude
      // и автоматом перерендериваем match (matcher их пропустит).
      if (e instanceof InventoryConflictError) {
        const newExcludes = [
          ...excludedServerIds,
          ...e.failed.map((f) => f.inv_item_id),
        ]
        setExcludedServerIds(newExcludes)
        toast.error(
          `Товар закончился — другой магазин опередил. Подбираю замену...`,
          { duration: 4000 },
        )
        // Re-build match с новым excludes — тут же без перезагрузки страницы.
        // useEffect от excludedServerIds не сработает, поэтому зовём load() явно.
        // Чуть-чуть ждём чтобы SSE может прилететь.
        setTimeout(() => {
          void load()
        }, 300)
        return
      }
      setError(e instanceof Error ? e.message : String(e))
      await setMsReceiptStatus(receipt.id, 'failed').catch(() => undefined)
    } finally {
      setFiscalizing(false)
    }
  }

  if (busy && !receipt) {
    return (
      <Card>
        <Card.Body>
          <div className="text-body text-ink-muted">Загрузка чека…</div>
        </Card.Body>
      </Card>
    )
  }

  if (error && !receipt) {
    return (
      <Card>
        <Card.Body>
          <EmptyState
            icon={<AlertCircle size={36} />}
            title="Чек не найден"
            description={error}
            action={
              <Button onClick={() => nav('/')} icon={<ArrowLeft size={14} />}>
                К списку
              </Button>
            }
          />
        </Card.Body>
      </Card>
    )
  }

  if (!receipt || !rd || !match) return null

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Чек ${receipt.ms_name ?? `#${receipt.id}`}`}
        subtitle={`${formatDateTime(receipt.ms_moment)} · оригинал из МойСклад`}
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => nav('/')}
              icon={<ArrowLeft size={14} />}
            >
              Назад
            </Button>
            <Button
              variant="primary"
              loading={fiscalizing}
              disabled={
                fiscalizing ||
                match.positions.length === 0 ||
                itemsWithoutIkpu.length > 0
              }
              onClick={doFiscalize}
              icon={!fiscalizing ? <Send size={14} /> : undefined}
              title={
                itemsWithoutIkpu.length > 0
                  ? `Невозможно фискализировать: ${itemsWithoutIkpu.length} товаров без ИКПУ`
                  : undefined
              }
            >
              {testMode ? 'Тестовая фискализация' : 'Фискализировать'}
            </Button>
          </div>
        }
      />

      {/* Payment badge — отдельной строкой */}
      {paymentKind && (
        <div>
          <PaymentBadge
            kind={paymentKind}
            cashSum={rd.cashSum ?? 0}
            cardSum={rd.noCashSum ?? 0}
            qrSum={rd.qrSum ?? 0}
          />
        </div>
      )}

      {testMode && (
        <Card className="border-warning/20 bg-warning-soft">
          <Card.Body className="flex items-start gap-3">
            <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="text-body text-ink">
              <strong className="text-warning">Тестовый режим включён.</strong>{' '}
              Фискализация будет имитирована, в ОФД ничего не уйдёт. Чтобы
              пробивать реально — выключите режим в{' '}
              <em className="not-italic font-medium">Admin → Настройки</em>.
            </div>
          </Card.Body>
        </Card>
      )}

      {error && (
        <Card className="border-danger/20 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="text-body text-danger">{error}</div>
          </Card.Body>
        </Card>
      )}

      {/* Блокировка фискализации: товары без ИКПУ → ОФД отказал бы в кешбэке +
          ГНК штрафанула бы магазин на 1% (постановление ВМ-255 от 12.05.2022).
          Кассир видит баннер и список товаров, кнопка «Фискализировать»
          выше disabled. Дозаполнить нужно в админке mytoolbox. */}
      {itemsWithoutIkpu.length > 0 && (
        <Card className="border-danger/30 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-body font-medium text-danger">
                Невозможно фискализировать: {itemsWithoutIkpu.length}{' '}
                {itemsWithoutIkpu.length === 1 ? 'товар без ИКПУ' : 'товаров без ИКПУ'}
              </div>
              <div className="mt-1 text-caption text-ink">
                Без MXIK ОФД не начислит покупателю кешбэк, а ГНК штрафует
                магазин на 1% от суммы. Дозаполните ИКПУ + код упаковки в{' '}
                <em className="not-italic font-medium">mytoolbox → Inventory → Приходы</em>{' '}
                и обновите чек.
              </div>
              <ul className="mt-2 space-y-0.5 text-caption text-ink">
                {itemsWithoutIkpu.map((name, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-danger shrink-0">·</span>
                    <span className="font-mono truncate">{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card.Body>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Side title="Оригинал из МойСклад" sumTiyin={rd.sum}>
          <PositionsTable
            positions={sourcePositions.map((pos) => ({
              name: pos.name,
              quantity: pos.quantity,
              total: pos.totalTiyin,
              vatPercent: pos.vatPercent,
              meta: pos.classCode ?? '— нет ИКПУ —',
              matched: matchedSourceIndexes.has(pos.index),
            }))}
          />
        </Side>

        <Side
          title={`Подбор: ${strategyLabel(match.overallStrategy)}`}
          sumTiyin={match.matchedTotalTiyin}
          sumDiff={match.totalDiffTiyin}
        >
          <PositionsTable
            positions={match.positions.flatMap((pm, posIdx) =>
              pm.candidates.map((c, candIdx) => {
                // Стрелки swap рисуем только на ПЕРВОМ candidate в группе
                // и только когда позиция не дроблёная (splitLevel=1).
                // При splitLevel>1 несколько строк — нечего свапать одной кнопкой.
                const isFirstCand = candIdx === 0
                const swap =
                  pm.swappable &&
                  isFirstCand &&
                  pm.splitLevel === 1 &&
                  pm.alternatives.length > 1
                    ? {
                        altIndex: pm.selectedAlternativeIndex,
                        altCount: pm.alternatives.length,
                        onPrev:
                          pm.selectedAlternativeIndex > 0
                            ? () =>
                                setMatch(
                                  recalculateAfterSwap(
                                    match,
                                    posIdx,
                                    pm.selectedAlternativeIndex - 1,
                                    matcherOpts,
                                  ),
                                )
                            : undefined,
                        onNext:
                          pm.selectedAlternativeIndex < pm.alternatives.length - 1
                            ? () =>
                                setMatch(
                                  recalculateAfterSwap(
                                    match,
                                    posIdx,
                                    pm.selectedAlternativeIndex + 1,
                                    matcherOpts,
                                  ),
                                )
                            : undefined,
                      }
                    : undefined
                // Split-контрол показывается только на ПЕРВОМ candidate группы.
                // Кнопки enabled зависят от splitLevel + canSplitMore.
                const split =
                  pm.splittable && isFirstCand
                    ? {
                        level: pm.splitLevel,
                        onMore:
                          pm.canSplitMore && pool
                            ? () => {
                                const next = rebuildPositionWithSplit(
                                  match,
                                  posIdx,
                                  pm.splitLevel + 1,
                                  pool,
                                  matcherOpts,
                                )
                                if (next) {
                                  setMatch(next)
                                  setSplitToast(null)
                                } else {
                                  setSplitToast(
                                    `Не получилось раздробить позицию «${pm.source.name}» на ${pm.splitLevel + 1} товаров — недостаточно товаров на эту цену в справочнике.`,
                                  )
                                }
                              }
                            : undefined,
                        onLess:
                          pm.splitLevel > 1 && pool
                            ? () => {
                                const next = rebuildPositionWithSplit(
                                  match,
                                  posIdx,
                                  pm.splitLevel - 1,
                                  pool,
                                  matcherOpts,
                                )
                                if (next) {
                                  setMatch(next)
                                  setSplitToast(null)
                                }
                              }
                            : undefined,
                      }
                    : undefined
                return {
                  name: c.esfItem.name,
                  quantity: c.quantity,
                  total: c.priceTiyin - c.discountTiyin,
                  discount: c.discountTiyin > 0 ? c.discountTiyin : undefined,
                  originalPrice: c.discountTiyin > 0 ? c.priceTiyin : undefined,
                  vatPercent: c.esfItem.vat_percent,
                  meta: c.esfItem.class_code,
                  matched: true,
                  swap,
                  split,
                }
              }),
            )}
          />
        </Side>
      </div>

      {/* Баннер «не получилось раздробить» — показывается когда matcher не нашёл
          достаточно товаров для запрошенного уровня split. */}
      {splitToast && (
        <Card className="border-warning/30 bg-warning-soft">
          <Card.Body className="flex items-start gap-3">
            <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="flex-1 text-body text-ink">{splitToast}</div>
            <button
              type="button"
              onClick={() => setSplitToast(null)}
              className="text-caption text-ink-muted hover:text-ink shrink-0"
            >
              Закрыть
            </button>
          </Card.Body>
        </Card>
      )}

      {match.warnings.length > 0 && (
        <Card className="border-warning/20 bg-warning-soft">
          <Card.Header className="border-warning/20">
            <div className="flex items-center gap-2">
              <TriangleAlert size={16} className="text-warning" />
              <Card.Title className="text-warning">Предупреждения</Card.Title>
            </div>
          </Card.Header>
          <Card.Body>
            <ul className="space-y-1.5 text-body text-ink">
              {match.warnings.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-warning shrink-0">·</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </Card.Body>
        </Card>
      )}
    </div>
  )
}

function strategyLabel(s: string): string {
  return (
    {
      'linked-ms': '🔗 связка из МС',
      passthrough: 'как есть',
      'price-bucket': 'замена по цене',
      'multi-item': 'набор из нескольких',
      manual: 'ручной',
    }[s] ?? s
  )
}

interface DisplayPosition {
  name: string
  quantity: number
  /** К оплате после скидки. */
  total: number
  /** Размер скидки в тийинах, если применена. */
  discount?: number
  /** Цена ДО скидки — для отображения «было/стало». */
  originalPrice?: number
  vatPercent: number
  meta: string
  matched: boolean
  /**
   * Контрол для замены товара на другой по той же цене.
   *
   * Включается только для price-bucket позиций (где matcher выбрал товар
   * по близости цены, а не по точному ИКПУ). Кассир может переключаться
   * через `←` `→` чтобы выбрать другой товар на ту же сумму.
   *
   * `altIndex` / `altCount` — для счётчика «2 / 10» в UI.
   * Колбеки `onPrev`/`onNext` undefined на крайних индексах (=> кнопка disabled).
   */
  swap?: {
    altIndex: number
    altCount: number
    onPrev?: () => void
    onNext?: () => void
  }
  /**
   * Контрол дробления — кассир может разбить один товар на несколько меньших
   * или собрать обратно. Показывается только на первой строке группы и
   * только для splittable позиций (НЕ passthrough).
   *
   * `onMore` undefined если в пуле уже не хватит товаров на следующий уровень
   * (canSplitMore=false). `onLess` undefined при splitLevel=1.
   */
  split?: {
    level: number
    onMore?: () => void
    onLess?: () => void
  }
}

function PositionsTable({ positions }: { positions: DisplayPosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-body text-ink-muted">
        Нет позиций
      </div>
    )
  }
  return (
    <table className="w-full text-body">
      <thead className="border-b border-border bg-canvas">
        <tr>
          <th className="w-10 px-3 py-2.5"></th>
          <th className="px-3 py-2.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wide">
            Товар
          </th>
          <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
            Кол-во
          </th>
          <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
            Сумма
          </th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p, i) => (
          <tr
            key={i}
            className={cn(
              'border-b border-border last:border-0',
              !p.matched && 'bg-warning-soft/40',
            )}
          >
            <td className="w-10 px-3 py-3 text-center align-top">
              <MatchIcon matched={p.matched} />
            </td>
            <td className="px-3 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                {p.swap && <SwapControl swap={p.swap} />}
                <div className="font-medium text-ink">{p.name}</div>
              </div>
              <div className="font-mono text-caption text-ink-subtle mt-0.5">
                {p.meta} · НДС {p.vatPercent}%
              </div>
              {p.split && <SplitControl split={p.split} />}
            </td>
            <td className="px-3 py-3 text-right tabular-nums text-ink-muted">
              {milliQtyToDisplay(p.quantity)}
            </td>
            <td className="px-3 py-3 text-right tabular-nums">
              {p.discount && p.originalPrice ? (
                <div className="space-y-0.5">
                  <div className="text-caption text-ink-subtle line-through">
                    {tiyinToSumDisplayPrecise(p.originalPrice)}
                  </div>
                  <div className="text-caption text-danger">
                    −{tiyinToSumDisplayPrecise(p.discount)}
                  </div>
                  <div className="font-medium text-ink">
                    {tiyinToSumDisplayPrecise(p.total)}
                  </div>
                </div>
              ) : (
                <span className="text-ink">{tiyinToSumDisplayPrecise(p.total)}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Контрол `← 2 / 10 →` для переключения товара на альтернативу той же цены.
 *
 * Появляется рядом с названием товара только для price-bucket позиций
 * (matcher выбрал товар по близости цены, не по точному ИКПУ — значит
 * есть свобода выбора другого товара).
 */
function SwapControl({
  swap,
}: {
  swap: {
    altIndex: number
    altCount: number
    onPrev?: () => void
    onNext?: () => void
  }
}) {
  return (
    <div className="inline-flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={swap.onPrev}
        disabled={!swap.onPrev}
        title="Предыдущий товар той же цены"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="text-caption text-ink-muted tabular-nums w-12 text-center select-none">
        {swap.altIndex + 1} / {swap.altCount}
      </span>
      <button
        type="button"
        onClick={swap.onNext}
        disabled={!swap.onNext}
        title="Следующий товар той же цены"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

/**
 * Контрол `[Раздробить] − N +` — позволяет разбить один товар на несколько
 * на ту же сумму или собрать обратно.
 *
 * Размещается под названием товара/ИКПУ строки. Показывается только на
 * ПЕРВОЙ строке группы (так что для split=3 кнопка одна на 3 товара).
 */
function SplitControl({
  split,
}: {
  split: { level: number; onMore?: () => void; onLess?: () => void }
}) {
  return (
    <div className="mt-1.5 inline-flex items-center gap-1.5">
      <span className="inline-flex items-center gap-1 text-caption text-ink-muted">
        <Scissors size={11} />
        Раздробить:
      </span>
      <button
        type="button"
        onClick={split.onLess}
        disabled={!split.onLess}
        title="Собрать в один товар"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <Minus size={12} />
      </button>
      <span className="text-caption text-ink tabular-nums w-5 text-center font-medium select-none">
        {split.level}
      </span>
      <button
        type="button"
        onClick={split.onMore}
        disabled={!split.onMore}
        title="Раздробить ещё на один товар"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <Plus size={12} />
      </button>
    </div>
  )
}

/** Иконка статуса подбора позиции — заменяет ✓/✗. */
function MatchIcon({ matched }: { matched: boolean }) {
  if (matched) {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-success-soft text-success"
        title="Подобрано"
      >
        <Check size={12} strokeWidth={3} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning-soft text-warning"
      title="Не подобрано"
    >
      <TriangleAlert size={11} />
    </span>
  )
}

interface SideProps {
  title: string
  sumTiyin: number
  sumDiff?: number
  children: React.ReactNode
}

function Side({ title, sumTiyin, sumDiff, children }: SideProps) {
  return (
    <Card className="overflow-hidden">
      <Card.Header className="bg-canvas">
        <Card.Title className="text-body">{title}</Card.Title>
        <Card.HeaderAction>
          <div className="text-right">
            <div className="text-caption text-ink-muted">Итого</div>
            <div className="text-body font-semibold tabular-nums text-ink">
              {tiyinToSumDisplay(sumTiyin)} сум
            </div>
            {sumDiff !== undefined && sumDiff !== 0 && (
              <div
                className={cn(
                  'text-caption tabular-nums',
                  sumDiff > 0 ? 'text-warning' : 'text-info',
                )}
              >
                {sumDiff > 0 ? '+' : ''}
                {tiyinToSumDisplayPrecise(sumDiff)}
              </div>
            )}
          </div>
        </Card.HeaderAction>
      </Card.Header>
      {children}
    </Card>
  )
}

/**
 * Бейдж типа оплаты — рядом с заголовком чека. Показывает суммы по каналам.
 */
function PaymentBadge({
  kind,
  cashSum,
  cardSum,
  qrSum,
}: {
  kind: 'cash' | 'card' | 'qr' | 'mixed'
  cashSum: number
  cardSum: number
  qrSum: number
}) {
  const config = {
    cash: { Icon: Banknote, variant: 'success' as const },
    card: { Icon: CreditCard, variant: 'info' as const },
    qr: { Icon: QrCode, variant: 'info' as const },
    mixed: { Icon: SplitSquareHorizontal, variant: 'warning' as const },
  }[kind]

  const parts: string[] = []
  if (kind === 'mixed') {
    if (cashSum > 0) parts.push(`нал ${tiyinToSumDisplay(cashSum)}`)
    if (cardSum > 0) parts.push(`карта ${tiyinToSumDisplay(cardSum)}`)
    if (qrSum > 0) parts.push(`QR ${tiyinToSumDisplay(qrSum)}`)
  } else if (kind === 'cash') {
    parts.push(`Наличные ${tiyinToSumDisplay(cashSum)}`)
  } else if (kind === 'card') {
    parts.push(`Карта ${tiyinToSumDisplay(cardSum)}`)
  } else if (kind === 'qr') {
    parts.push(`QR ${tiyinToSumDisplay(qrSum)}`)
  }

  return (
    <Badge
      variant={config.variant}
      icon={<config.Icon size={14} />}
      className="text-body py-1 px-2.5"
    >
      <span className="tabular-nums">{parts.join(' + ')} сум</span>
    </Badge>
  )
}
