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
 *   - КАЖДАЯ строка: (priceTiyin - discountTiyin) ≥ priceFloorTiyin(line)
 *     (себестоимость +5%) — не только план в среднем прибыльный, а каждая
 *     партия по отдельности. Одна строка ниже floor отклоняет ВЕСЬ план
 *     (см. финальную построчную проверку в конце функции).
 *   - line.quantity ≤ available[line.esfItem.id] (уважение остатков)
 *   - НЕТ двух строк с одним нормализованным именем товара, но разным
 *     esf_item.id — один товар = одна партия на весь план (анти-микс,
 *     working коллапсируется ДО фаз 1/2 до батча с максимальным
 *     `sellingPrice × available` — то есть с наибольшим потенциалом закрыть
 *     сумму чека; при равенстве — FIFO-самый-старый, см. `normalizeForLink`)
 *   - lines.length ≤ holisticMaxLines (default 30)
 *
 * Не уважает:
 *   - НДС соответствие с МС-позициями (пул override'ится `defaultVatPercent`
 *     ещё в loadMatcherPool, и фискальный VAT_total собирается из item.vat_percent
 *     по строкам — это валидно для ОФД).
 *   - one-to-one mapping «МС-позиция → фискальная строка» (явно нет, в этом и идея).
 */

import type { Tiyin } from '@/lib/db/types'
import {
  costWithVat,
  normalizeForLink,
  priceFloorTiyin,
  vatIncluded,
  MIN_MARKUP_PERCENT,
  type MatcherPool,
  type PoolItem,
} from './strategies'
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
 * Найти первую строку плана, которая продаётся НИЖЕ своего собственного
 * floor (себестоимость +`MIN_MARKUP_PERCENT`%), или `null` если все строки
 * в порядке.
 *
 * Бизнес-правило: КАЖДАЯ строка (партия) должна быть ≥ floor сама по себе —
 * недостаточно чтобы план был прибыльным «в среднем» (одна прибыльная
 * строка компенсирует другую убыточную). Используется как финальная
 * страховка в конце `planHolistic` — если найдена хоть одна нарушающая
 * строка, весь план отклоняется (`BELOW_COST`), а не отправляется частично.
 *
 * Вынесена отдельной экспортируемой функцией, чтобы можно было юнит-тестить
 * именно это правило напрямую (сконструировать `HolisticLine[]` руками),
 * не пытаясь обойти фильтры фаз 1/2 алгоритма через `planHolistic`.
 */
export function findBelowFloorLine(
  lines: HolisticLine[],
): { line: HolisticLine; effective: Tiyin; floor: Tiyin } | null {
  for (const line of lines) {
    const effective = line.priceTiyin - line.discountTiyin
    const floor = priceFloorTiyin(
      line.esfItem.unit_price_tiyin,
      line.esfItem.vat_percent,
      line.quantity,
    )
    if (effective < floor) {
      return { line, effective, floor }
    }
  }
  return null
}

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
  const rawWorking: WorkingItem[] = pool.items
    .filter((p) => p.sellingPrice > 0 && Math.floor(p.item.available / 1000) >= 1)
    .map((p) => ({
      poolItem: p,
      remainingAvailable: Math.floor(p.item.available / 1000), // в штуках
      pickedQty: 0,
    }))

  // ── Анти-микс: один товар (по нормализованному имени) = одна партия ──
  //
  // `rawWorking` может содержать НЕСКОЛЬКО батчей одного товара (разные
  // esf_item.id с разной received_at/unit_price, но тем же именем —
  // например партия за 191к и партия того же товара за 121к). Без коллапса
  // фазы 1/2 могли выбрать РАЗНЫЕ батчи одного товара для точной сборки
  // суммы (реальный баг: 1 шт партии 191к + 4 шт партии 121к в одном чеке).
  //
  // Коллапсируем до ОДНОГО батча на товар — выбираем батч с максимальным
  // `sellingPrice × remainingAvailable` («потолок стоимости» этой партии).
  // Раньше выбирался FIFO самый старый (`received_at` минимальный), тот же
  // принцип что и в tryLinkedMsVariant/tryPassthrough — но для holistic это
  // системно невыгодно: самая старая партия обычно и самая распроданная
  // (меньше остатка), а holistic решает задачу subset-sum, где нужен ЗАПАС
  // возможностей закрыть произвольную сумму — чем больше available × price,
  // тем больше диапазон сумм, которые этот батч способен покрыть один. FIFO
  // мог выбрать батч с остатком 1 шт вместо батча с остатком 50 шт того же
  // товара — план искусственно проваливался (NO_FIT/INSUFFICIENT_POOL) там,
  // где с «богатым» батчем задача решалась легко. При равном потенциале —
  // тай-брейк на FIFO-самый-старый (сохраняет учётную логику при прочих
  // равных). Остальные батчи того же товара полностью исключаются из
  // holistic-плана (не как fallback, не как филлер) — это осознанно
  // сокращает пространство подбора, это и есть цель анти-микс правила.
  const byProductKey = new Map<string, WorkingItem>()
  for (const w of rawWorking) {
    const key = normalizeForLink(w.poolItem.item.name)
    const existing = byProductKey.get(key)
    if (!existing) {
      byProductKey.set(key, w)
      continue
    }
    const wValue = w.poolItem.sellingPrice * w.remainingAvailable
    const existingValue = existing.poolItem.sellingPrice * existing.remainingAvailable
    const better =
      wValue > existingValue ||
      (wValue === existingValue &&
        w.poolItem.item.received_at < existing.poolItem.item.received_at)
    if (better) {
      byProductKey.set(key, w)
    }
  }
  const working: WorkingItem[] = [...byProductKey.values()].sort((a, b) => {
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
    // Floor per-line: если себестоимость +5% > sellPrice, продажа ниже
    // минимальной наценки → не берём. При наценке ≥10% обычно не триггерит,
    // но защищаемся (например магазин на упрощёнке с markup=0).
    const unitFloor = priceFloorTiyin(
      w.poolItem.item.unit_price_tiyin,
      w.poolItem.item.vat_percent,
      1000, // 1 шт
    )
    if (unitFloor > sell) continue

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
      .filter((w) => {
        if (w.poolItem.sellingPrice > fillerThreshold) return false
        if (w.remainingAvailable <= 0) return false
        // Floor per-line — та же защита что в фазе 1 (см. комментарий выше):
        // не берём филлер который продавался бы ниже себестоимости+5%.
        // DP/closest-below не знают про floor сами по себе, поэтому
        // фильтруем на входе — иначе они могли бы выбрать убыточный филлер.
        const unitFloor = priceFloorTiyin(
          w.poolItem.item.unit_price_tiyin,
          w.poolItem.item.vat_percent,
          1000,
        )
        return unitFloor <= w.poolItem.sellingPrice
      })
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
      // Двойной cap чтобы цена строки не «надулась» в 11× при большом delta
      // и маленьком sellingPrice:
      //   1. абсолютный — maxBumpPerLine из настроек (default 10 000 сум)
      //   2. относительный — не более 50% от текущей цены строки
      //      (иначе на ленте 1 шт = 1.1M сум при реальной розничной 100k
      //       выглядит подозрительно для покупателя + ГНК при сверке).
      const RELATIVE_CAP_RATIO = 0.5
      const relativeCap = Math.floor(line.priceTiyin * RELATIVE_CAP_RATIO)
      const room = Math.min(maxBumpPerLine, relativeCap)
      const take = Math.min(toBump, room)
      if (take <= 0) continue
      line.priceTiyin += take
      line.vatTiyin = vatIncluded(
        line.priceTiyin - line.discountTiyin,
        line.esfItem.vat_percent,
      )
      toBump -= take
    }
    if (toBump > 0) {
      notes.push(
        `bump не покрыл delta ${toBump} тийинов (cap 50% от цены строки + ` +
          `maxBumpPerItemTiyin). Добавьте мелкие товары в справочник.`,
      )
    }
    remaining = toBump
  } else if (remaining < 0) {
    // Перебрали — discount, но не ниже floor = себестоимость × (1 + 5%).
    // Раньше floor была голая себестоимость (0% маржи). Теперь скидка не
    // опускает цену ниже «себестоимость + минимальная наценка 5%».
    let toCut = -remaining
    const sorted = [...lines].sort((a, b) => b.priceTiyin - a.priceTiyin)
    for (const line of sorted) {
      if (toCut <= 0) break
      const floor = priceFloorTiyin(
        line.esfItem.unit_price_tiyin,
        line.esfItem.vat_percent,
        line.quantity,
      )
      const maxCut = Math.min(
        maxBumpPerLine, // используем тот же cap
        line.priceTiyin - line.discountTiyin - floor,
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
  // totalCostTiyin — голая себестоимость (для отчёта в HolisticPlan).
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
  // totalFloorTiyin — себестоимость + минимум 5%. Это нижняя граница для
  // всего плана. Если выручка ниже — продаём ниже минимальной наценки.
  const totalFloorTiyin = lines.reduce(
    (s, l) =>
      s +
      priceFloorTiyin(
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

  // ── Финальная страховка (defense-in-depth): жёсткий запрет ниже floor ──
  // ПОСТРОЧНАЯ проверка — основная защита. Бизнес-правило владельца: КАЖДАЯ
  // партия не должна продаваться ниже своей себестоимости+5%, а не «план
  // в среднем прибыльный». Раньше проверялась только агрегатная сумма
  // (totalFloorTiyin vs totalTiyin ниже) — план мог пройти если одна
  // прибыльная строка компенсировала другую убыточную. Теперь ЛЮБАЯ строка
  // ниже своего floor отклоняет ВЕСЬ план целиком (holistic либо весь
  // легальный, либо не возвращается вообще) — план НЕ уходит в ОФД
  // частично, кассир получает classic-результат с unmatched → ручная сборка.
  //
  // В норме фаза 1 (unitFloor check) и фаза 2 (filler floor filter) уже не
  // должны допустить такую строку — это последний рубеж на случай фазы 3
  // (bump/discount) или будущих изменений алгоритма. Вынесено отдельной
  // функцией `findBelowFloorLine` чтобы юнит-тест мог проверить именно это
  // правило напрямую, не пытаясь обойти фильтры фаз 1/2.
  {
    const violation = findBelowFloorLine(lines)
    if (violation) {
      return {
        ok: false,
        reason: 'BELOW_COST',
        detail:
          `строка «${violation.line.esfItem.name}» продавалась бы за ` +
          `${violation.effective} тийинов — ниже собственной минимальной цены ` +
          `${violation.floor} тийинов (себестоимость +${MIN_MARKUP_PERCENT}%). ` +
          `План отклонён целиком, продажа ниже себестоимости запрещена.`,
      }
    }
  }

  // Агрегатная проверка — оставлена как дополнительная подстраховка
  // (не должна срабатывать отдельно от построчной выше, но дёшева и
  // документирует инвариант плана как единого целого).
  if (totalFloorTiyin > totalTiyin) {
    return {
      ok: false,
      reason: 'BELOW_COST',
      detail:
        `минимальная цена (себестоимость +${MIN_MARKUP_PERCENT}%) ${totalFloorTiyin} > ` +
        `выручка ${totalTiyin} — продажа ниже минимальной наценки`,
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
