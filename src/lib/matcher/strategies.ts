import { listEsfItems, type EsfItemWithAvailable } from '@/lib/db'
import type {
  MatchCandidate,
  MatcherOptions,
  NormalizedPosition,
  PositionMatch,
} from './types'
import type { Tiyin } from '@/lib/db/types'

/** НДС из суммы с включённой ставкой: vat = total * percent / (100+percent). */
export function vatIncluded(totalTiyin: Tiyin, vatPercent: number): Tiyin {
  if (vatPercent <= 0) return 0
  return Math.round((totalTiyin * vatPercent) / (100 + vatPercent))
}

/** НДС начисленный сверху: vat = total * percent / 100. */
export function vatAddedOn(netTiyin: Tiyin, vatPercent: number): Tiyin {
  if (vatPercent <= 0) return 0
  return Math.round((netTiyin * vatPercent) / 100)
}

/**
 * Рассчитать продажную цену из приходной.
 *
 * Формула: round_up( unit_price × (1 + markup/100) × (1 + vat/100), step ).
 *
 *   1. К приходной цене добавляется наценка (markupPercent, по умолчанию 10%).
 *   2. К результату начисляется НДС товара (item.vat_percent — обычно 12%).
 *   3. Сумма округляется ВВЕРХ до шага roundUpToSum (в сумах, по умолчанию 1000).
 *
 * Пример: приход 595 928 тийинов (5 959.28 сум), наценка 10%, НДС 12%, шаг 1000:
 *   5959.28 × 1.10 × 1.12 = 7 341.63 сум  →  округление вверх до 1000  →  8000 сум
 */
export function calculateSellingPrice(
  unitPriceTiyin: Tiyin,
  vatPercent: number,
  markupPercent: number,
  roundUpToSum: number,
): Tiyin {
  if (unitPriceTiyin <= 0) return 0
  const withMarkup = (unitPriceTiyin * (100 + markupPercent)) / 100
  const withVat = (withMarkup * (100 + Math.max(0, vatPercent))) / 100
  const stepTiyin = Math.max(1, roundUpToSum) * 100
  return Math.ceil(withVat / stepTiyin) * stepTiyin
}

/** Общие дефолты ценообразования. */
const DEFAULT_MARKUP = 10
const DEFAULT_ROUND_UP_SUM = 1000

/**
 * Пул товаров с предрасчитанными продажными ценами.
 *
 * Загружается ОДИН РАЗ на чек в buildMatch и передаётся во все стратегии.
 * Раньше каждая стратегия для каждой позиции делала свой listEsfItems
 * с лимитом 5000 — на чеке из 5 позиций это 50000 строк через TS↔SQLite
 * мост, что давало заметные лаги UI.
 */
export interface MatcherPool {
  /** Все доступные товары (qty_received - qty_consumed >= 1000) с кэшем sellingPrice. */
  items: PoolItem[]
  /** Минимальная цена в пуле — для подсказок «нечем набрать по multi-item». */
  minSellingPrice: Tiyin
}

export interface PoolItem {
  item: EsfItemWithAvailable
  sellingPrice: Tiyin
}

/**
 * Загрузить пул и предрасчитать продажные цены. Один запрос в БД,
 * один проход для расчёта sellingPrice. Результат переиспользуется
 * во всех трёх стратегиях для всех позиций чека.
 */
export async function loadMatcherPool(opts: MatcherOptions = {}): Promise<MatcherPool> {
  const raw = await listEsfItems({ minAvailable: 1000, limit: 5000 })
  const markup = opts.markupPercent ?? DEFAULT_MARKUP
  const roundUp = opts.roundUpToSum ?? DEFAULT_ROUND_UP_SUM
  let minSellingPrice = Number.POSITIVE_INFINITY
  const items: PoolItem[] = raw.map((item) => {
    const sellingPrice = calculateSellingPrice(
      item.unit_price_tiyin,
      item.vat_percent,
      markup,
      roundUp,
    )
    if (sellingPrice > 0 && sellingPrice < minSellingPrice) {
      minSellingPrice = sellingPrice
    }
    return { item, sellingPrice }
  })
  return {
    items,
    minSellingPrice: Number.isFinite(minSellingPrice) ? minSellingPrice : 0,
  }
}

/**
 * Стратегия 1: passthrough.
 *
 * Если позиция содержит валидный ИКПУ, который есть в нашем справочнике
 * с достаточными остатками — фискализируем «как есть» через найденный esf_item.
 * Цена в фискальном чеке — продажная (с наценкой и НДС).
 */
export function tryPassthrough(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция (бесплатный товар по акции / бонусами) — не подбираем.
  // Иначе для pos.totalTiyin=0 matcher может подобрать дешёвые товары через
  // tolerance — это неправильно, нулевая позиция не должна занимать место в чеке.
  if (pos.totalTiyin <= 0) return null
  if (!pos.classCode) return null

  const strictVat = opts.vatStrict === true
  const candidates = pool.items.filter(
    (p) =>
      p.item.class_code === pos.classCode &&
      p.item.qty_received - p.item.qty_consumed >= pos.quantity &&
      (!strictVat || p.item.vat_percent === pos.vatPercent),
  )

  if (candidates.length === 0) return null

  // FIFO — самый старый приход.
  const chosen = [...candidates].sort(
    (a, b) => a.item.received_at - b.item.received_at,
  )[0]
  if (!chosen) return null

  const totalSelling = chosen.sellingPrice * (pos.quantity / 1000)
  const candidate = makeCandidate(chosen.item, pos.quantity, totalSelling)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'passthrough',
    diffTiyin: totalSelling - pos.totalTiyin,
    warnings: [],
  }
}

/**
 * Стратегия 2: price-bucket.
 *
 * Найти один товар, у которого РАСЧЁТНАЯ продажная цена близка к сумме
 * позиции из чека МойСклад (в пределах `toleranceTiyin`). Берём 1 шт.
 *
 * **Записываем в чек `pos.totalTiyin`, а не `best.sellingPrice`** — потому что
 * покупатель реально заплатил за эту позицию `pos.totalTiyin`, и фискальный
 * чек должен отразить именно эту сумму. Расчётная цена `sellingPrice`
 * (вычисленная из приходной с наценкой и НДС) использовалась ТОЛЬКО для
 * проверки «адекватности» замены. Если `pos.totalTiyin` чуть выше
 * `sellingPrice` — это просто означает чуть бо́льшую наценку на эту продажу
 * (что нормально и допустимо).
 *
 * Это убирает систематический микро-минус по сумме чека, когда замена
 * нашлась с ценой на 500–1000 сум ниже позиции.
 */
export function tryPriceBucket(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция — не подбираем, см. tryPassthrough.
  if (pos.totalTiyin <= 0) return null
  const tolerance = opts.toleranceTiyin ?? 0
  const strictVat = opts.vatStrict === true

  let best: { item: EsfItemWithAvailable; sellingPrice: Tiyin; diff: number } | null = null
  for (const p of pool.items) {
    if (strictVat && p.item.vat_percent !== pos.vatPercent) continue
    const diff = Math.abs(p.sellingPrice - pos.totalTiyin)
    if (diff > tolerance) continue
    if (!best || diff < best.diff) {
      best = { item: p.item, sellingPrice: p.sellingPrice, diff }
    }
  }
  if (!best) return null

  // Цена в чеке = pos.totalTiyin (что покупатель заплатил).
  // best.sellingPrice (расчётная) использовалась только для матчинга.
  const candidate = makeCandidate(best.item, 1000, pos.totalTiyin)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'price-bucket',
    diffTiyin: 0,
    warnings: pos.classCode
      ? [`ИКПУ заменён: ${pos.classCode} → ${best.item.class_code}`]
      : [`Без ИКПУ в исходной позиции, заменён на ${best.item.class_code}`],
  }
}

/**
 * Стратегия 3: multi-item (greedy knapsack).
 *
 * Набираем несколько товаров суммарно на нужную сумму (с допуском).
 * Жадный алгоритм по убыванию ПРОДАЖНОЙ цены.
 */
export function tryMultiItem(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция — не подбираем, см. tryPassthrough.
  if (pos.totalTiyin <= 0) return null
  const tolerance = opts.toleranceTiyin ?? 0
  const maxItems = opts.maxMultiItem ?? 5
  const strictVat = opts.vatStrict === true

  const filtered = strictVat
    ? pool.items.filter((p) => p.item.vat_percent === pos.vatPercent)
    : pool.items
  if (filtered.length === 0) return null

  // Сортируем по убыванию ПРОДАЖНОЙ цены (без копирования если можно).
  const sorted = [...filtered].sort((a, b) => b.sellingPrice - a.sellingPrice)

  const picks: { item: EsfItemWithAvailable; quantity: number; sellingPrice: Tiyin }[] = []
  let remaining = pos.totalTiyin

  for (const { item, sellingPrice } of sorted) {
    if (picks.length >= maxItems) break
    if (remaining <= 0) break
    if (sellingPrice <= 0) continue
    if (sellingPrice > remaining + tolerance) continue

    const fitsByPrice = Math.floor(remaining / sellingPrice)
    const fitsByStock = Math.floor(item.available / 1000)
    const qty = Math.min(fitsByPrice, fitsByStock)
    if (qty <= 0) continue

    picks.push({ item, quantity: qty, sellingPrice })
    remaining -= qty * sellingPrice
  }

  if (picks.length === 0) return null
  if (Math.abs(remaining) > tolerance) return null

  const candidates: MatchCandidate[] = picks.map(({ item, quantity, sellingPrice }) => {
    const totalSelling = sellingPrice * quantity
    return makeCandidate(item, quantity * 1000, totalSelling)
  })

  const matchedSum = candidates.reduce((s, c) => s + c.priceTiyin, 0)
  const diffTiyin = matchedSum - pos.totalTiyin

  return {
    source: pos,
    candidates,
    strategy: 'multi-item',
    diffTiyin,
    warnings: [`Подобрано ${picks.length} позиций вместо одной`],
  }
}

/**
 * Собрать MatchCandidate.
 *
 * `priceTiyin` — продажная сумма за всё quantity (без скидки).
 * `discountTiyin = 0` по умолчанию — скидка распределяется потом
 * в distributeDiscount() если включено.
 * `vatTiyin` — НДС, рассчитанный от priceTiyin (т.е. без учёта скидки;
 * после распределения скидок vatTiyin будет пересчитан).
 */
function makeCandidate(
  item: EsfItemWithAvailable,
  quantity: number,
  sellingTotalTiyin: Tiyin,
): MatchCandidate {
  const vat = vatIncluded(sellingTotalTiyin, item.vat_percent)
  return {
    esfItem: item,
    quantity,
    priceTiyin: sellingTotalTiyin,
    discountTiyin: 0,
    vatTiyin: vat,
  }
}

/**
 * Себестоимость с НДС для всей позиции (за `quantity` единиц).
 * Это пол скидки: `discount` не может опустить (price - discount) ниже этой
 * суммы — иначе продажа в убыток. НДС применяется ПРАВИЛЬНО (последовательно,
 * не суммой 22%): unit_price × (1 + vat/100).
 *
 * Используется в distributeDiscount.
 */
export function costWithVat(
  unitPriceTiyin: Tiyin,
  vatPercent: number,
  quantityMilli: number,
): Tiyin {
  if (unitPriceTiyin <= 0) return 0
  const unitWithVat = (unitPriceTiyin * (100 + Math.max(0, vatPercent))) / 100
  return Math.round((unitWithVat * quantityMilli) / 1000)
}
