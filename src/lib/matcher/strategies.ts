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
 *
 * Все вычисления в тийинах, чтобы не потерять копейки на промежутках.
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
  const stepTiyin = Math.max(1, roundUpToSum) * 100 // шаг в тийинах
  return Math.ceil(withVat / stepTiyin) * stepTiyin
}

/** Общие дефолты ценообразования (синхронны с SettingKey defaults). */
const DEFAULT_MARKUP = 10
const DEFAULT_ROUND_UP_SUM = 1000

function effectivePrice(
  item: EsfItemWithAvailable,
  opts: MatcherOptions,
): Tiyin {
  return calculateSellingPrice(
    item.unit_price_tiyin,
    item.vat_percent,
    opts.markupPercent ?? DEFAULT_MARKUP,
    opts.roundUpToSum ?? DEFAULT_ROUND_UP_SUM,
  )
}

/**
 * Стратегия 1: passthrough.
 *
 * Если позиция содержит валидный ИКПУ, который есть в нашем справочнике
 * с достаточными остатками — фискализируем «как есть» через найденный esf_item.
 * Цена в фискальном чеке — продажная (с наценкой и НДС).
 */
export async function tryPassthrough(
  pos: NormalizedPosition,
  opts: MatcherOptions = {},
): Promise<PositionMatch | null> {
  if (!pos.classCode) return null

  const candidates = await listEsfItems({
    classCode: pos.classCode,
    minAvailable: pos.quantity,
    vatPercent: opts.vatStrict === true ? pos.vatPercent : undefined,
    limit: 50,
  })

  if (candidates.length === 0) return null

  // Берём самый старый приход (FIFO).
  const sorted = [...candidates].sort((a, b) => a.received_at - b.received_at)
  const chosen = sorted[0]
  if (!chosen) return null

  // Продажная цена за 1 шт × количество = totalSelling.
  const unitSelling = effectivePrice(chosen, opts)
  const totalSelling = unitSelling * (pos.quantity / 1000)
  const candidate = makeCandidate(chosen, pos.quantity, totalSelling)

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
 * Найти один товар, у которого ПРОДАЖНАЯ цена (с наценкой+НДС, округлённая)
 * близка к сумме позиции из чека МойСклад. Берём 1 шт.
 */
export async function tryPriceBucket(
  pos: NormalizedPosition,
  opts: MatcherOptions = {},
): Promise<PositionMatch | null> {
  const tolerance = opts.toleranceTiyin ?? 0

  const all = await listEsfItems({
    minAvailable: 1000,
    vatPercent: opts.vatStrict === true ? pos.vatPercent : undefined,
    limit: 5000,
  })

  // Считаем продажную цену для каждого, фильтруем по tolerance, ранжируем.
  const ranked = all
    .map((item) => {
      const sellingPrice = effectivePrice(item, opts)
      return {
        item,
        sellingPrice,
        diff: Math.abs(sellingPrice - pos.totalTiyin),
      }
    })
    .filter((r) => r.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff)

  const best = ranked[0]
  if (!best) return null

  const candidate = makeCandidate(best.item, 1000, best.sellingPrice)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'price-bucket',
    diffTiyin: best.sellingPrice - pos.totalTiyin,
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
export async function tryMultiItem(
  pos: NormalizedPosition,
  opts: MatcherOptions = {},
): Promise<PositionMatch | null> {
  const tolerance = opts.toleranceTiyin ?? 0
  const maxItems = opts.maxMultiItem ?? 5

  const pool = await listEsfItems({
    minAvailable: 1000,
    vatPercent: opts.vatStrict === true ? pos.vatPercent : undefined,
    limit: 5000,
  })

  if (pool.length === 0) return null

  // Подмешиваем расчётную продажную цену сразу, чтобы дальше не пересчитывать.
  const enriched = pool.map((item) => ({
    item,
    sellingPrice: effectivePrice(item, opts),
  }))

  // Сортируем по убыванию ПРОДАЖНОЙ цены.
  enriched.sort((a, b) => b.sellingPrice - a.sellingPrice)

  const picks: { item: EsfItemWithAvailable; quantity: number; sellingPrice: Tiyin }[] = []
  let remaining = pos.totalTiyin

  for (const { item, sellingPrice } of enriched) {
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

  const candidates: MatchCandidate[] = picks.map(
    ({ item, quantity, sellingPrice }) => {
      const totalSelling = sellingPrice * quantity
      return makeCandidate(item, quantity * 1000, totalSelling)
    },
  )

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
 * `priceTiyin` — это ПРОДАЖНАЯ сумма (с наценкой+НДС, округлённая) за весь
 * объём позиции. Именно она пойдёт в фискальный чек EPOS как `Price`.
 *
 * `vatTiyin` рассчитывается как НДС, включённый в продажную цену (вычленяется
 * из общей суммы по ставке) — это формат ОФД ГНК для UZ.
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
    vatTiyin: vat,
  }
}
