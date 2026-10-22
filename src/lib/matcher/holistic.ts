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
 *   Фаза 1 (greedy крупное) — крупные SKU по убыванию sellPrice, сколько
 *           влезает в сумму чека.
 *
 *   Фаза 2 (мелочь на остаток) — что крупным не закрылось, добираем
 *           филлерами (sellPrice ≤ holisticFillerThresholdTiyin) НАИМЕНЬШИМ
 *           числом штук: точно, если сумма достижима, иначе ближайшую снизу.
 *
 *   Фаза 3 (delta-патч) — недобор закрываем надбавкой (bump) к крупной
 *           строке, перебор — скидкой не ниже cost-floor.
 *           Cap = `maxBumpPerItemTiyin`.
 *
 * Мелочь — дефицит, её берём только на хвост. До 0.12.2 фаза 1 намеренно
 * оставляла под филлеры резерв 30 000 сум, а точная сборка брала первую
 * найденную комбинацию — и каждый чек «съедал» 30–60 тысяч мелочи (пачки
 * по 10–20 штук). Прогон истории с 01.09 по 22.10.2026 (2 379 чеков,
 * склад восстановлен по журналу): партия мелочи жила в среднем 1,9 дня,
 * 7 910 винтов ушли за 10 дней. Без резерва и с наименьшим числом штук —
 * 2 306 штук мелочи вместо 20 724 за тот же период, все чеки собраны, а
 * себестоимость списанного почти та же (+1%).
 * Инструмент прогона — `__tests__/history-replay.test.ts`.
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

const DEFAULT_FILLER_THRESHOLD_TIYIN: Tiyin = 2_000_000 // 20 000 сум selling
const DEFAULT_MAX_LINES = 30
const DEFAULT_MAX_BUMP_PER_LINE_TIYIN: Tiyin = 1_000_000 // 10 000 сум
/**
 * Предел размера таблицы добора (сумм × филлеров). Дальше — простой
 * жадный добор: таблица на десятки мегабайт подвесила бы кассу, а такой
 * остаток бывает только при совсем пустом складе крупного.
 */
const MAX_DP_CELLS = 5_000_000

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
/**
 * Потолок штук одного товара в строке по умолчанию.
 *
 * Взят по реальным данным: строки крупнее задевают около 12% чеков, а сотни
 * штук в одной строке выглядят неправдоподобно и для проверяющего, и для
 * склада.
 */
const DEFAULT_MAX_QTY_PER_LINE = 20

/**
 * Целостный подбор на сумму чека.
 *
 * Сначала пробуем с ограничением на количество штук в строке, а если план не
 * сошёлся — повторяем без него. Ограничение здесь именно ПРЕДПОЧТЕНИЕ:
 * неправдоподобный чек хуже красивого, но непробитый чек хуже обоих. Кассир не
 * должен упереться в отказ из-за нашей заботы о правдоподобии.
 */
export function planHolistic(
  target: Tiyin,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): HolisticOutcome {
  const cap = opts.maxQtyPerLine ?? DEFAULT_MAX_QTY_PER_LINE
  const capped = planHolisticWithCap(target, pool, opts, cap)
  if (capped.ok || !Number.isFinite(cap)) return capped

  const relaxed = planHolisticWithCap(target, pool, opts, Number.POSITIVE_INFINITY)
  if (!relaxed.ok) return capped // причина отказа понятнее из основной попытки
  relaxed.plan.notes.push(
    `Ограничение ${cap} шт на строку снято — иначе чек на эту сумму не собирался. ` +
      `Проверьте склад: не хватает недорогих позиций для точного набора.`,
  )
  return relaxed
}

function planHolisticWithCap(
  target: Tiyin,
  pool: MatcherPool,
  opts: MatcherOptions,
  maxQtyPerLine: number,
): HolisticOutcome {
  if (target <= 0) {
    return { ok: false, reason: 'TARGET_TOO_SMALL', detail: 'target ≤ 0' }
  }
  if (pool.items.length === 0) {
    return { ok: false, reason: 'POOL_EMPTY', detail: 'пул товаров пуст' }
  }

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
      // Потолок применяем ЗДЕСЬ — и жадная фаза, и точная сборка, и добор
      // берут количество из одного этого поля, поэтому одного ограничения
      // хватает на все три.
      remainingAvailable: Math.min(
        Math.floor(p.item.available / 1000),
        maxQtyPerLine,
      ), // в штуках
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

  // ── Фаза 1: greedy крупное ──
  const notes: string[] = []
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

    // Без резерва под мелочь: крупное закрывает всё, что может, — мелочь
    // идёт только на хвост (см. заголовок файла).
    if (remaining < sell) continue

    const fitsByBudget = Math.floor(remaining / sell)
    const fitsByStock = w.remainingAvailable
    const qty = Math.min(fitsByBudget, fitsByStock)
    if (qty <= 0) continue

    w.pickedQty += qty
    w.remainingAvailable -= qty
    remaining -= qty * sell
  }

  // ── Фаза 2: остаток — мелочью, наименьшим числом штук ──
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
      // Точно — если сумма достижима, иначе ближайшая снизу; разницу
      // закроет фаза 3.
      for (const { workingIndex, qty } of dpFewestPieces(remaining, fillers)) {
        const w = fillers[workingIndex]!
        w.pickedQty += qty
        w.remainingAvailable -= qty
        remaining -= qty * w.poolItem.sellingPrice
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
 * Мелочь на сумму ≤ target наименьшим числом штук: точно, если сумма
 * достижима, иначе ближайшая снизу (разницу закроет фаза 3).
 *
 * Почему «наименьшим»: раньше бралась первая найденная комбинация, и на
 * остаток 22 000 уходили 22 винта по 1 000 вместо трёх товаров по 7 000.
 * Чек выглядел неправдоподобно, а дешёвые приходы кончались за дни.
 *
 * Ограниченный рюкзак «минимум монет». Шаг сумм — НОД цен филлеров: при
 * округлении до 1000 сум это 1000 сум и больше, а у магазина с другим
 * шагом (100, 500) таблица просто мельче — товары с «некруглой» ценой не
 * выпадают из подбора. Филлеры по одному за проход; для суммы b на проходе f:
 *   best_f[b] = min по q ∈ [0, maxQty] (best_{f-1}[b − q·step] + q).
 * Минимум по окну q считается монотонной очередью отдельно для каждого
 * остатка b mod step — O(сумм) на филлер, не O(сумм × штук): при снятом
 * потолке штук (повтор без лимита в planHolistic) у товара бывает 7 000+
 * штук в остатке, и прямой перебор q подвешивал бы кассу.
 *
 * На каждом проходе запоминаем, сколько штук ЭТОГО филлера взяли; план
 * восстанавливается проходами с конца. При равенстве штук выигрывает
 * филлер раньше по списку — они отсортированы по убыванию цены.
 */
function dpFewestPieces(target: Tiyin, fillers: WorkingItem[]): DpPick[] {
  const usable = fillers.filter((w) => w.poolItem.sellingPrice > 0 && w.remainingAvailable > 0)
  if (target <= 0 || usable.length === 0) return []
  const unit = usable.reduce((g, w) => gcd(g, w.poolItem.sellingPrice), 0)
  const T = Math.floor(target / unit)
  if (T <= 0) return []
  if ((T + 1) * fillers.length > MAX_DP_CELLS) return greedyBelow(target, fillers)

  const INF = 0x3fffffff
  let best = new Int32Array(T + 1).fill(INF)
  best[0] = 0
  const takenByStage: Array<Uint16Array | null> = []

  for (let f = 0; f < fillers.length; f++) {
    const sell = fillers[f]!.poolItem.sellingPrice
    const maxQty = Math.min(fillers[f]!.remainingAvailable, 0xffff)
    if (sell <= 0 || maxQty <= 0) {
      takenByStage.push(null)
      continue
    }
    const step = sell / unit
    const next = new Int32Array(T + 1)
    const taken = new Uint16Array(T + 1)
    const queue = new Int32Array(Math.floor(T / step) + 2)
    for (let r = 0; r < step && r <= T; r++) {
      // Очередь индексов j (сумма r + j·step) по возрастанию best − j.
      let head = 0
      let tail = 0
      for (let j = 0, b = r; b <= T; j++, b += step) {
        const cur = best[b]!
        if (cur !== INF) {
          const key = cur - j
          while (tail > head && best[r + queue[tail - 1]! * step]! - queue[tail - 1]! >= key) tail--
          queue[tail++] = j
        }
        while (tail > head && queue[head]! < j - maxQty) head++
        let value = cur
        let q = 0
        if (tail > head) {
          const src = queue[head]!
          const cand = best[r + src * step]! + (j - src)
          if (cand < value) {
            value = cand
            q = j - src
          }
        }
        next[b] = value
        taken[b] = q
      }
    }
    best = next
    takenByStage.push(taken)
  }

  let b = T
  while (b > 0 && best[b] === INF) b--
  const picks: DpPick[] = []
  for (let f = fillers.length - 1; f >= 0 && b > 0; f--) {
    const q = takenByStage[f]?.[b] ?? 0
    if (q > 0) {
      picks.push({ workingIndex: f, qty: q })
      b -= q * (fillers[f]!.poolItem.sellingPrice / unit)
    }
  }
  return picks
}

/**
 * Запасной добор для огромного остатка: филлеры по убыванию цены, пока
 * влезают. Неточно, но мгновенно — разницу закроет фаза 3.
 */
function greedyBelow(target: Tiyin, fillers: WorkingItem[]): DpPick[] {
  const picks: DpPick[] = []
  let remaining = target
  for (let f = 0; f < fillers.length && remaining > 0; f++) {
    const sell = fillers[f]!.poolItem.sellingPrice
    const take = sell > 0 ? Math.min(Math.floor(remaining / sell), fillers[f]!.remainingAvailable) : 0
    if (take <= 0) continue
    picks.push({ workingIndex: f, qty: take })
    remaining -= take * sell
  }
  return picks
}

/** Для тестов: добор мелочи на сумму — индексы во входном списке и штуки. */
export function _fewestPiecesForTests(
  target: Tiyin,
  fillers: Array<{ sellingPrice: Tiyin; qty: number }>,
): Array<{ index: number; qty: number }> {
  const working = fillers.map<WorkingItem>((f) => ({
    poolItem: { item: {} as PoolItem['item'], sellingPrice: f.sellingPrice },
    remainingAvailable: f.qty,
    pickedQty: 0,
  }))
  return dpFewestPieces(target, working).map((p) => ({ index: p.workingIndex, qty: p.qty }))
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
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
