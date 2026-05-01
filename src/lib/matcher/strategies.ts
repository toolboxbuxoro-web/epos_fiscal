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
 * Стратегия 1: passthrough.
 *
 * Если позиция содержит валидный ИКПУ, который есть в нашем справочнике
 * с достаточными остатками — фискализируем «как есть» через найденный esf_item.
 *
 * Возвращает PositionMatch или null, если стратегия не применима.
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

  const candidate = makeCandidate(chosen, pos.quantity, pos.totalTiyin, pos.vatPercent)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'passthrough',
    diffTiyin: 0,
    warnings: [],
  }
}

/**
 * Стратегия 2: price-bucket.
 *
 * Найти один товар с подходящей суммой (с учётом допуска),
 * совпадающей ставкой НДС и достаточным остатком. Берём 1 шт.
 */
export async function tryPriceBucket(
  pos: NormalizedPosition,
  opts: MatcherOptions = {},
): Promise<PositionMatch | null> {
  const tolerance = opts.toleranceTiyin ?? 0
  // Ищем товары с ценой ≈ totalTiyin (за 1 шт, qty_received ≥ 1000).
  const all = await listEsfItems({
    minAvailable: 1000,
    vatPercent: opts.vatStrict === true ? pos.vatPercent : undefined,
    limit: 1000,
  })

  // Сортировка по близости цены.
  const ranked = all
    .map((item) => ({
      item,
      diff: Math.abs(item.unit_price_tiyin - pos.totalTiyin),
    }))
    .filter((r) => r.diff <= tolerance)
    .sort((a, b) => a.diff - b.diff)

  const best = ranked[0]
  if (!best) return null

  const candidate = makeCandidate(best.item, 1000, best.item.unit_price_tiyin, pos.vatPercent)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'price-bucket',
    diffTiyin: candidate.priceTiyin - pos.totalTiyin,
    warnings: pos.classCode
      ? [`ИКПУ заменён: ${pos.classCode} → ${best.item.class_code}`]
      : [`Без ИКПУ в исходной позиции, заменён на ${best.item.class_code}`],
  }
}

/**
 * Стратегия 3: multi-item (greedy knapsack).
 *
 * Набираем несколько товаров суммарно на нужную сумму (с допуском).
 * Greedy: берём по убыванию цены, пока не достигнем целевой суммы.
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
    limit: 2000,
  })

  if (pool.length === 0) return null

  // Сортируем по убыванию цены.
  const sorted = [...pool].sort((a, b) => b.unit_price_tiyin - a.unit_price_tiyin)

  const picks: { item: EsfItemWithAvailable; quantity: number }[] = []
  let remaining = pos.totalTiyin

  for (const item of sorted) {
    if (picks.length >= maxItems) break
    if (remaining <= 0) break
    if (item.unit_price_tiyin > remaining + tolerance) continue

    // Сколько штук влезает (но не больше остатков).
    const fitsByPrice = Math.floor(remaining / item.unit_price_tiyin)
    const fitsByStock = Math.floor(item.available / 1000)
    const qty = Math.min(fitsByPrice, fitsByStock)
    if (qty <= 0) continue

    picks.push({ item, quantity: qty })
    remaining -= qty * item.unit_price_tiyin
  }

  if (picks.length === 0) return null
  if (Math.abs(remaining) > tolerance) return null

  const candidates: MatchCandidate[] = picks.map(({ item, quantity }) => {
    const totalTiyin = item.unit_price_tiyin * quantity
    return makeCandidate(item, quantity * 1000, totalTiyin, pos.vatPercent)
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

function makeCandidate(
  item: EsfItemWithAvailable,
  quantity: number,
  totalTiyin: Tiyin,
  vatPercent: number,
): MatchCandidate {
  // Ставка НДС берётся из приходной записи, но округляем НДС от суммы покупки.
  const vat = vatIncluded(totalTiyin, item.vat_percent || vatPercent)
  return {
    esfItem: item,
    quantity,
    priceTiyin: totalTiyin,
    vatTiyin: vat,
  }
}
