/**
 * Holistic matcher — целостный подбор товаров на сумму чека.
 *
 * Зачем: classic per-position matcher жадно решает «одна МС-позиция = один
 * (или несколько) фискальный товар». При разреженном пуле это часто
 * заходит в тупик: ранние позиции «съедают» удобные SKU, поздние не
 * собираются. Holistic смотрит на весь чек как на задачу coin-change:
 *
 *   target = receipt.sum
 *   pool   = inv_items с остатками
 *   найти: набор (item_i, qty_i) такой что Σ priceTiyin = target,
 *          уважая available и cost-floor (не в убыток).
 *
 * Алгоритм:
 *   Фаза 1 (greedy крупное) — крупные SKU по убыванию sellPrice,
 *           но НЕ съедаем всё: оставляем резерв `holisticFillerReserveTiyin`
 *           под филлеры. Это предотвращает ситуацию когда крупный товар
 *           вписался ровно, а дробить остаток нечем.
 *
 *   Фаза 2 (DP exact-sum) — оставшийся `remaining` собираем точным
 *           subset-sum на филлерах (sellPrice ≤ holisticFillerThresholdTiyin).
 *           DP по сумме с шагом ~1000 тийинов, размер таблицы маленький
 *           (типично remaining ≤ 50k, ≤50 buckets × ≤30 filler-SKU).
 *
 *   Фаза 3 (delta-патч) — если DP не нашёл exact, берём closest-below
 *           и компенсируем недостачу через bump (увеличение priceTiyin
 *           одной из выбранных строк) или discount (если closest-above
 *           ближе и cost-floor позволяет). Cap = `maxBumpPerItemTiyin`.
 *
 * Гарантии (если возвращён Ok):
 *   - Σ (line.priceTiyin - line.discountTiyin) = target (exact)
 *   - Σ cost_with_vat(line) ≤ target (не в убыток глобально)
 *   - line.quantity ≤ available[line.esfItem.id] (уважение остатков)
 *   - lines.length ≤ holisticMaxLines (default 30)
 *
 * Не уважает:
 *   - НДС соответствие с МС-позициями (пул override'ится `defaultVatPercent`
 *     ещё в loadMatcherPool, и фискальный VAT_total собирается из item.vat_percent
 *     по строкам — это валидно для ОФД).
 *   - one-to-one mapping «МС-позиция → фискальная строка» (явно нет, в этом и идея).
 */

import type { Tiyin } from '@/lib/db/types'
import { costWithVat, vatIncluded, type MatcherPool, type PoolItem } from './strategies'
import type { HolisticLine, HolisticPlan, MatcherOptions } from './types'

const DEFAULT_FILLER_RESERVE_TIYIN: Tiyin = 3_000_000 // 30 000 сум
const DEFAULT_FILLER_THRESHOLD_TIYIN: Tiyin = 2_000_000 // 20 000 сум selling
const DEFAULT_MAX_LINES = 30
const DEFAULT_MAX_BUMP_PER_LINE_TIYIN: Tiyin = 1_000_000 // 10 000 сум
const DP_BUCKET_TIYIN: Tiyin = 100_000 // 1000 сум — шаг округления цен (`roundUpToSum` default)

export type HolisticRejectReason =
  | 'POOL_EMPTY'
  | 'TARGET_TOO_SMALL'
  | 'INSUFFICIENT_POOL'
  | 'TOO_MANY_LINES'
  | 'BELOW_COST'
  | 'NO_FIT'

export type HolisticOutcome =
  | { ok: true; plan: HolisticPlan }
  | { ok: false; reason: HolisticRejectReason; detail: string }

/**
 * Собрать holistic-план на сумму `target` из `pool`.
 *
 * Чистая функция: не мутирует pool, не пишет в БД, не вызывает сеть.
 * Логирование — только log.info/warn для трассировки.
 */
export function planHolistic(
  target: Tiyin,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): HolisticOutcome {
  if (target <= 0) {
    return { ok: false, reason: 'TARGET_TOO_SMALL', detail: 'target ≤ 0' }
  }
  if (pool.items.length === 0) {
    return { ok: false, reason: 'POOL_EMPTY', detail: 'пул товаров пуст' }
  }

  const fillerReserve = opts.holisticFillerReserveTiyin ?? DEFAULT_FILLER_RESERVE_TIYIN
  const fillerThreshold = opts.holisticFillerThresholdTiyin ?? DEFAULT_FILLER_THRESHOLD_TIYIN
  const maxLines = opts.holisticMaxLines ?? DEFAULT_MAX_LINES
  const maxBumpPerLine = opts.maxBumpPerItemTiyin ?? DEFAULT_MAX_BUMP_PER_LINE_TIYIN

  // VAT-strict тут не реализован отдельно: holistic собирает по сумме чека,
  // а ставка НДС каждой строки берётся из item.vat_percent (после override
  // `defaultVatPercent` на уровне loadMatcherPool). ОФД принимает чек с
  // НДС-микс на строках, итоги корректные.

  // Working pool — клонируем `available` чтобы не мутировать оригинал.
  // Сортировка по (sellingPrice DESC, item.id ASC) — детерминизм.
  const working: WorkingItem[] = pool.items
    .filter((p) => p.sellingPrice > 0 && Math.floor(p.item.available / 1000) >= 1)
    .map((p) => ({
      poolItem: p,
      remainingAvailable: Math.floor(p.item.available / 1000), // в штуках
      pickedQty: 0,
    }))
    .sort((a, b) => {
      if (b.poolItem.sellingPrice !== a.poolItem.sellingPrice) {
        return b.poolItem.sellingPrice - a.poolItem.sellingPrice
      }
      return a.poolItem.item.id - b.poolItem.item.id
    })

  if (working.length === 0) {
    return { ok: false, reason: 'POOL_EMPTY', detail: 'нет товаров с остатками >= 1шт' }
  }

  // Самый дешёвый SKU — если target меньше него, мы не сможем ничего собрать.
  const cheapest = working.reduce(
    (min, w) => (w.poolItem.sellingPrice < min ? w.poolItem.sellingPrice : min),
    working[0]!.poolItem.sellingPrice,
  )
  if (target < cheapest) {
    return {
      ok: false,
      reason: 'TARGET_TOO_SMALL',
      detail: `target ${target} < min sellPrice пула ${cheapest}`,
    }
  }

  // Глобальный sanity-check: достаточно ли вообще запасов?
  const maxAvailableValue = working.reduce(
    (s, w) => s + w.poolItem.sellingPrice * w.remainingAvailable,
    0,
  )
  if (maxAvailableValue < target) {
    return {
      ok: false,
      reason: 'INSUFFICIENT_POOL',
      detail:
        `суммарный потолок пула ${maxAvailableValue} тийинов меньше target ${target} — ` +
        `не хватает товара на складе`,
    }
  }

  // ── Фаза 1: greedy крупное (с резервом под филлеры) ──
  const notes: string[] = []
  const hasFillers = working.some(
    (w) => w.poolItem.sellingPrice <= fillerThreshold && w.remainingAvailable > 0,
  )
  let remaining = target

  for (const w of working) {
    if (remaining <= 0) break
    const sell = w.poolItem.sellingPrice
    if (sell <= fillerThreshold) continue // мелкое — для фазы 2
    // Cost-floor per-line: если unit_price × vat > sellPrice, продажа в убыток.
    // Это маловероятно при наценке ≥10%, но защищаемся.
    const unitCost = costWithVat(
      w.poolItem.item.unit_price_tiyin,
      w.poolItem.item.vat_percent,
      1000, // 1 шт
    )
    if (unitCost > sell) continue

    // Целевой бюджет фазы 1: либо весь remaining (если филлеров нет),
    // либо remaining - fillerReserve (оставляем под фазу 2).
    const phase1Budget = hasFillers
      ? Math.max(0, remaining - fillerReserve)
      : remaining
    if (phase1Budget < sell) continue

    const fitsByBudget = Math.floor(phase1Budget / sell)
    const fitsByStock = w.remainingAvailable
    const qty = Math.min(fitsByBudget, fitsByStock)
    if (qty <= 0) continue

    w.pickedQty += qty
    w.remainingAvailable -= qty
    remaining -= qty * sell
  }

  // ── Фаза 2: точная сборка остатка через DP subset-sum (с повторами) ──
  if (remaining > 0) {
    const fillers = working
      .filter(
        (w) =>
          w.poolItem.sellingPrice <= fillerThreshold &&
          w.remainingAvailable > 0,
      )
      // Снова сортируем по убыванию цены (после фазы 1 могли остаться разные).
      .sort((a, b) => b.poolItem.sellingPrice - a.poolItem.sellingPrice)

    if (fillers.length > 0 && remaining >= cheapest) {
      const dpPicks = dpExactSum(remaining, fillers)
      if (dpPicks) {
        for (const { workingIndex, qty } of dpPicks) {
          const w = fillers[workingIndex]!
          w.pickedQty += qty
          w.remainingAvailable -= qty
          remaining -= qty * w.poolItem.sellingPrice
        }
      } else {
        // DP exact не нашлось — берём closest-below и фаза 3 закрывает delta.
        const below = dpClosestBelow(remaining, fillers)
        for (const { workingIndex, qty } of below) {
          const w = fillers[workingIndex]!
          w.pickedQty += qty
          w.remainingAvailable -= qty
          remaining -= qty * w.poolItem.sellingPrice
        }
      }
    }
  }

  // ── Фаза 3: компенсация delta через bump/discount ──
  // remaining > 0 → надо добавить (bump к одной из строк).
  // remaining < 0 → перебрали (discount, если cost-floor позволяет).
  // Цель — sum(line) === target.
  const picked = working.filter((w) => w.pickedQty > 0)
  if (picked.length === 0) {
    return { ok: false, reason: 'NO_FIT', detail: 'не подобрано ни одного товара' }
  }

  if (picked.length > maxLines) {
    return {
      ok: false,
      reason: 'TOO_MANY_LINES',
      detail: `план содержит ${picked.length} строк, лимит ${maxLines}`,
    }
  }

  // Строим черновик линий + патчим delta.
  const lines = picked.map<HolisticLine>((w) => {
    const qty = w.pickedQty // штук
    const quantityMilli = qty * 1000
    const priceTiyin = w.poolItem.sellingPrice * qty
    return {
      esfItem: w.poolItem.item,
      quantity: quantityMilli,
      priceTiyin,
      discountTiyin: 0,
      vatTiyin: vatIncluded(priceTiyin, w.poolItem.item.vat_percent),
    }
  })

  if (remaining > 0) {
    // Не добрали — bump к строке у которой больше всего «жирка» (sellPrice).
    // Не превышаем maxBumpPerLine, иначе раскидываем по нескольким строкам.
    let toBump = remaining
    // Сортируем по убыванию price — крупная строка проще «утоптает» bump.
    const sorted = [...lines].sort((a, b) => b.priceTiyin - a.priceTiyin)
    for (const line of sorted) {
      if (toBump <= 0) break
      const room = maxBumpPerLine // без cost-floor — bump = больше наценка, всегда легально
      const take = Math.min(toBump, room)
      line.priceTiyin += take
      line.vatTiyin = vatIncluded(
        line.priceTiyin - line.discountTiyin,
        line.esfItem.vat_percent,
      )
      toBump -= take
    }
    if (toBump > 0) {
      notes.push(
        `bump не покрыл delta ${toBump} тийинов — расширьте maxBumpPerItemTiyin`,
      )
    }
    remaining = toBump
  } else if (remaining < 0) {
    // Перебрали — discount, но не ниже cost-floor.
    let toCut = -remaining
    const sorted = [...lines].sort((a, b) => b.priceTiyin - a.priceTiyin)
    for (const line of sorted) {
      if (toCut <= 0) break
      const cost = costWithVat(
        line.esfItem.unit_price_tiyin,
        line.esfItem.vat_percent,
        line.quantity,
      )
      const maxCut = Math.min(
        maxBumpPerLine, // используем тот же cap
        line.priceTiyin - line.discountTiyin - cost,
      )
      if (maxCut <= 0) continue
      const take = Math.min(toCut, maxCut)
      line.discountTiyin += take
      line.vatTiyin = vatIncluded(
        line.priceTiyin - line.discountTiyin,
        line.esfItem.vat_percent,
      )
      toCut -= take
    }
    if (toCut > 0) {
      // Не удалось срезать — план в убытке/расхождении.
      return {
        ok: false,
        reason: 'BELOW_COST',
        detail:
          `подбор перебрал target на ${-remaining} тийинов, ` +
          `не получилось срезать (осталось ${toCut} вне cost-floor)`,
      }
    }
    remaining = -toCut // 0
  }

  // Проверки инвариантов.
  const totalTiyin = lines.reduce(
    (s, l) => s + l.priceTiyin - l.discountTiyin,
    0,
  )
  const totalCostTiyin = lines.reduce(
    (s, l) =>
      s +
      costWithVat(
        l.esfItem.unit_price_tiyin,
        l.esfItem.vat_percent,
        l.quantity,
      ),
    0,
  )

  if (totalTiyin !== target) {
    return {
      ok: false,
      reason: 'NO_FIT',
      detail: `итог plan ${totalTiyin} ≠ target ${target} (delta ${totalTiyin - target})`,
    }
  }
  if (totalCostTiyin > totalTiyin) {
    return {
      ok: false,
      reason: 'BELOW_COST',
      detail:
        `глобальная себестоимость ${totalCostTiyin} > выручка ${totalTiyin} — ` +
        `продажа в убыток`,
    }
  }

  return {
    ok: true,
    plan: { lines, totalTiyin, totalCostTiyin, notes },
  }
}

/**
 * DP exact-sum: найти комбинацию qty_i для каждого filler-SKU такую что
 * Σ (sellPrice_i × qty_i) = target.
 *
 * Возвращает picks или null если exact-sum не достижим.
 *
 * Алгоритм: bounded subset-sum с повторами через reachability-DP.
 * Квантуем по `DP_BUCKET_TIYIN` (шаг 1000 сум = шаг округления selling-цены).
 *
 * Каждый filler обрабатывается ОДИН раз, и для каждого srcBucket в текущем
 * reachable пробуем добавить qty=1..maxQty копий — это аккуратно соблюдает
 * bounded-условие (никаких следов "сколько уже взяли" по цепочке).
 *
 * Структура: reach[b] = parent-info, либо null если bucket недостижим.
 * После обработки filler f, новые bucket'ы могли появиться только через
 * добавление 1+ копий именно f к bucket'ам, достижимым ДО f.
 *
 * Сложность: O(F × |reachable| × maxQty). Для F=30, |reachable|≤500, maxQty≤50
 * это 750k операций — мс-scale в JS.
 */
function dpExactSum(
  target: Tiyin,
  fillers: WorkingItem[],
): DpPick[] | null {
  if (target <= 0) return []
  if (target % DP_BUCKET_TIYIN !== 0) {
    // Селлинг цены кратны DP_BUCKET_TIYIN (roundUpToSum=1000). Если target
    // не кратен — exact-sum невозможен без bump'а. Возвращаем null чтобы
    // вызвать closest-below + bump path.
    return null
  }
  const targetBuckets = target / DP_BUCKET_TIYIN

  // reach[b] = { fillerIndex, qtyTaken, prev } — как мы пришли в b,
  // или null если bucket недостижим. reach[0] — стартовое состояние.
  type ParentInfo = { fillerIndex: number; qtyTaken: number; prev: number }
  const reach: (ParentInfo | null)[] = new Array(targetBuckets + 1).fill(null)
  // Маркер для bucket=0 (специальный): нет родителя, но достижим.
  reach[0] = { fillerIndex: -1, qtyTaken: 0, prev: -1 }

  for (let f = 0; f < fillers.length; f++) {
    const sell = fillers[f]!.poolItem.sellingPrice
    if (sell <= 0 || sell % DP_BUCKET_TIYIN !== 0) continue
    const stepBuckets = sell / DP_BUCKET_TIYIN
    if (stepBuckets <= 0) continue
    const maxQty = fillers[f]!.remainingAvailable
    if (maxQty <= 0) continue

    // Снимок reach ДО обработки этого filler — чтобы добавлять только новые
    // достижения, не зацикливая «беру f → реход через f → беру f ещё раз»
    // в один проход.
    const snapshot: (ParentInfo | null)[] = reach.slice()
    for (let srcBucket = 0; srcBucket <= targetBuckets; srcBucket++) {
      if (snapshot[srcBucket] === null) continue
      // Пробуем взять qty штук filler[f] поверх snapshot[srcBucket].
      for (let qty = 1; qty <= maxQty; qty++) {
        const dstBucket = srcBucket + qty * stepBuckets
        if (dstBucket > targetBuckets) break
        // Если уже достижимо — не перезаписываем (любой путь к target нас устраивает).
        if (reach[dstBucket] !== null) continue
        reach[dstBucket] = { fillerIndex: f, qtyTaken: qty, prev: srcBucket }
      }
    }

    // Ранний выход: если target уже достижим — можно собирать восстановление.
    if (reach[targetBuckets] !== null) break
  }

  if (reach[targetBuckets] === null) return null

  // Восстанавливаем picks: проходим цепочку parent'ов от target до 0.
  const counts = new Map<number, number>() // fillerIndex → суммарный qty
  let cur = targetBuckets
  // Безопасность от поломанной цепочки.
  let safety = targetBuckets + 10
  while (cur > 0 && safety-- > 0) {
    const step = reach[cur]
    if (!step) return null
    if (step.fillerIndex >= 0) {
      counts.set(
        step.fillerIndex,
        (counts.get(step.fillerIndex) ?? 0) + step.qtyTaken,
      )
    }
    cur = step.prev
  }
  if (safety < 0) return null

  const picks: DpPick[] = []
  counts.forEach((qty, workingIndex) => picks.push({ workingIndex, qty }))
  return picks
}

/**
 * Closest-below: ближайшая достижимая сумма ≤ target. Использует ту же DP-таблицу
 * но возвращает максимальный достижимый bucket. Гарантированно возвращает что-то
 * (как минимум пустой пик, если ни один филлер не помещается).
 */
function dpClosestBelow(
  target: Tiyin,
  fillers: WorkingItem[],
): DpPick[] {
  if (target <= 0) return []
  // Простая жадность: берём филлеры по убыванию цены, пока влезают.
  // (DP closest-below был бы точнее, но усложнение не стоит — фаза 3 bump
  //  закроет небольшую разницу.)
  const picks = new Map<number, number>()
  let remaining = target
  for (let f = 0; f < fillers.length; f++) {
    const sell = fillers[f]!.poolItem.sellingPrice
    const maxQty = fillers[f]!.remainingAvailable
    if (sell <= 0 || maxQty <= 0) continue
    const take = Math.min(Math.floor(remaining / sell), maxQty)
    if (take <= 0) continue
    picks.set(f, take)
    remaining -= take * sell
    if (remaining <= 0) break
  }
  const result: DpPick[] = []
  picks.forEach((qty, workingIndex) => result.push({ workingIndex, qty }))
  return result
}

// ── Внутренние типы ──────────────────────────────────────────────────

interface WorkingItem {
  poolItem: PoolItem
  /** Остаток в штуках (после фаз 1/2 уменьшается). */
  remainingAvailable: number
  /** Сколько взяли (штуки). */
  pickedQty: number
}

interface DpPick {
  /** Индекс в массиве `fillers` (не в pool). */
  workingIndex: number
  qty: number
}
