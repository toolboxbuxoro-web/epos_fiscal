import type { MsRetailDemand } from '@/lib/moysklad/types'
import { extractPositions } from './extract'
import {
  costWithVat,
  loadMatcherPool,
  tryLinkedMsVariant,
  tryMultiItem,
  tryMultiItemForce,
  tryPassthrough,
  tryPriceBucket,
  vatIncluded,
  type MatcherPool,
} from './strategies'
import type {
  BuildMatchResult,
  MatcherOptions,
  NormalizedPosition,
  PositionMatch,
} from './types'
import type { MatchStrategy } from '@/lib/db/types'
import { countEsfItems } from '@/lib/db'
import { tiyinToSumDisplay } from '@/lib/format'

export * from './types'
export { extractPositions } from './extract'
export { loadMatcherPool, type MatcherPool } from './strategies'

/**
 * Главная функция: собрать план фискализации для чека МойСклад.
 *
 * Для каждой позиции пробует стратегии в порядке:
 *   1. passthrough  — если есть приход с тем же ИКПУ
 *   2. price-bucket — если есть товар с похожей ценой
 *   3. multi-item   — набрать несколько товаров на сумму
 *
 * Если ни одна не сработала — позиция остаётся без матча и попадёт в `warnings`.
 */
export async function buildMatch(
  receipt: MsRetailDemand,
  opts: MatcherOptions = {},
): Promise<BuildMatchResult> {
  // Имя характеристики модификации МС для связки с приходом — из настроек.
  // Если не передано в opts, парсер использует default 'Бухгалтерское наименование'.
  const rawPositions = extractPositions(receipt, opts.linkCharacteristicName)
  const matches: PositionMatch[] = []
  const warnings: string[] = []

  // ── Скидка на чек МС (бонусы / баллы / ручная скидка) ────────────
  // В retaildemand `sum` — это что покупатель РЕАЛЬНО заплатил (после
  // вычета бонусов/баллов). Сумма позиций может быть БОЛЬШЕ — например
  // покупка на 1 000 000 сум, 100 000 закрыто баллами, к оплате 900 000.
  // Фискализируем именно `receipt.sum`, не сумму товаров. Если сумма
  // позиций больше rd.sum — пропорционально уменьшаем totalTiyin каждой
  // позиции, чтобы matcher подбирал товары на правильную сумму.
  //
  // Если rd.sum = 0 (всё оплачено бонусами) — фискализировать нечего:
  // ОФД не примет нулевой чек, да и обоснования нет.
  const positionsSumRaw = rawPositions.reduce((s, p) => s + p.totalTiyin, 0)
  if (receipt.sum <= 0) {
    return {
      receipt,
      positions: [],
      overallStrategy: 'manual',
      totalDiffTiyin: 0,
      originalTotalTiyin: receipt.sum,
      matchedTotalTiyin: 0,
      canAutoFiscalize: false,
      warnings: [
        'Чек оплачен бонусами / баллами полностью (сумма к оплате 0). ' +
          'Фискализация не нужна — фискальный чек создаётся только на сумму, ' +
          'реально проведённую через кассу.',
      ],
    }
  }

  // Если МС-сумма меньше суммы позиций — масштабируем позиции пропорционально.
  // Скейл применяется ДО подбора: matcher работает с уже-скейленной позиций.
  const positions =
    positionsSumRaw > 0 && receipt.sum < positionsSumRaw
      ? rawPositions.map((p) => ({
          ...p,
          totalTiyin: Math.round((p.totalTiyin * receipt.sum) / positionsSumRaw),
        }))
      : rawPositions
  if (positionsSumRaw > 0 && receipt.sum < positionsSumRaw) {
    const scaledOff = positionsSumRaw - receipt.sum
    warnings.push(
      `Покупатель оплатил частично бонусами/баллами: сумма к оплате ` +
        `${tiyinToSumDisplay(receipt.sum)} сум, ` +
        `сумма товаров ${tiyinToSumDisplay(positionsSumRaw)} сум, ` +
        `списано ${tiyinToSumDisplay(scaledOff)} сум. ` +
        `Подбор пропорционально уменьшен.`,
    )
  }

  // Один раз грузим пул товаров с остатками + предрасчитанные продажные цены.
  // Раньше каждая стратегия для каждой позиции делала свой listEsfItems
  // с лимитом 5000 — на чеке из 5 позиций это 50000 строк через TS↔SQLite
  // мост за один открытый чек. UI заметно лагал при переходах.
  const pool = await loadMatcherPool(opts)

  for (const pos of positions) {
    // Нулевая позиция (бесплатный товар по акции, или после скейла стала 0) —
    // в чек не попадает: фискальный чек не должен содержать пустых строк.
    if (pos.totalTiyin <= 0) continue

    // Pipeline стратегий: от самой надёжной к мягкой.
    // 1. linked-ms — через явную связку «Бухгалтерское наименование» в модификации МС
    // 2. passthrough — ИКПУ из атрибутов МС совпал
    // 3. price-bucket — подбор по цене с подменой ИКПУ
    // 4. multi-item — набор товаров на сумму
    const m =
      tryLinkedMsVariant(pos, pool, opts) ??
      tryPassthrough(pos, pool, opts) ??
      tryPriceBucket(pos, pool, opts) ??
      tryMultiItem(pos, pool, opts)

    if (m) {
      matches.push(m)
      warnings.push(...m.warnings)
    } else {
      const reason = await explainNoMatch(pos, pool, opts)
      warnings.push(
        `Позиция «${pos.name}» (${tiyinToSumDisplay(pos.totalTiyin)} сум, ` +
          `ИКПУ ${pos.classCode ?? '—'}, НДС ${pos.vatPercent}%): ${reason}`,
      )
      // ВАЖНО: всё равно добавляем позицию в matches с ПУСТЫМИ candidates.
      // Иначе она существует только как текст в warnings — у кассира нет
      // строки в UI и негде нажать «Подобрать вручную». С пустым
      // candidates[] Receipt.tsx рисует строку «не подобрано» + кнопку
      // ручного подбора. distributeDiscount/Bump её игнорируют (reduce по
      // пустому candidates = 0). После ручного выбора replacePositionManual
      // заполнит candidates (позиция уже в result.positions, индексируется).
      matches.push({
        source: pos,
        candidates: [],
        strategy: 'manual',
        diffTiyin: 0,
        warnings: [reason],
        swappable: false,
        alternatives: [],
        selectedAlternativeIndex: -1,
        splitLevel: 1,
        canSplitMore: false,
        splittable: false,
      })
    }
  }

  // Применить распределение скидок чтобы итоговая сумма совпала с rd.sum.
  // distributeDiscount: matched > target → срезаем скидкой (cost-floor).
  // distributeBump: matched < target → добавляем надбавку к цене (без cost-floor).
  // Оба гейтятся одним флагом opts.discountForExactSum, симметрично.
  // Каждое — no-op в своём «не моём» направлении, поэтому safe вызывать оба.
  const discountWarnings = distributeDiscount(matches, receipt.sum, opts)
  warnings.push(...discountWarnings)
  const bumpWarnings = distributeBump(matches, receipt.sum, opts)
  warnings.push(...bumpWarnings)

  // matchedTotal теперь = сумма (priceTiyin - discountTiyin) каждого кандидата.
  // Это то что реально пойдёт в EPOS как сумма к оплате (Price - Discount).
  const matchedTotal = matches.reduce(
    (s, m) =>
      s + m.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )
  const totalDiff = matchedTotal - receipt.sum

  // Преобладающая стратегия — самая «слабая» из применённых.
  const overallStrategy = pickOverallStrategy(matches.map((m) => m.strategy))

  // canAutoFiscalize: все позиции linked-ms или passthrough, нет warnings, diff = 0.
  // linked-ms — явная связка от бухгалтера, ещё надёжнее чем passthrough.
  const canAutoFiscalize =
    matches.length === positions.length &&
    matches.every((m) => m.strategy === 'linked-ms' || m.strategy === 'passthrough') &&
    warnings.length === 0 &&
    totalDiff === 0

  return {
    receipt,
    positions: matches,
    overallStrategy,
    totalDiffTiyin: totalDiff,
    originalTotalTiyin: receipt.sum,
    matchedTotalTiyin: matchedTotal,
    canAutoFiscalize,
    warnings,
  }
}

/**
 * Пересчитать BuildMatchResult после swap товара на альтернативу.
 *
 * Используется в UI Receipt.tsx когда кассир жмёт стрелку `←`/`→`
 * у swappable-позиции (price-bucket).
 *
 * Что делается:
 *   1. Заменяет `candidates[0]` выбранной позиции на `alternatives[newIndex]`
 *      (с обнулённой скидкой — она будет пересчитана ниже).
 *   2. Сбрасывает дискаунты/бампы у ВСЕХ позиций (не только у swappable —
 *      потому что distribute-функции могли распределить разницу по нескольким).
 *   3. Заново применяет `distributeDiscount` + `distributeBump` под
 *      `receipt.sum`. Это даёт точное совпадение суммы 1-в-1 в обе стороны.
 *   4. Пересчитывает `matchedTotalTiyin`, `totalDiffTiyin`.
 *
 * Чистая функция — оригинальный `result` не мутируется. Возвращает новый
 * объект (UI просто `setMatch(result)`).
 */
export function recalculateAfterSwap(
  result: BuildMatchResult,
  positionIndex: number,
  newAlternativeIndex: number,
  opts: MatcherOptions = {},
): BuildMatchResult {
  if (positionIndex < 0 || positionIndex >= result.positions.length) {
    return result // невалидный индекс — no-op
  }
  const target = result.positions[positionIndex]!
  if (!target.swappable) return result
  const alt = target.alternatives[newAlternativeIndex]
  if (!alt) return result // индекс вне диапазона

  // Глубокий клон позиций. Мутируем только клон.
  const newPositions = result.positions.map((p, i) => {
    if (i !== positionIndex) {
      // Сбрасываем discount у всех candidates, чтобы distribute-функции
      // считали с нуля (иначе старые скидки с прошлого распределения
      // останутся и сумма «съедет»).
      return {
        ...p,
        candidates: p.candidates.map((c) => ({
          ...c,
          discountTiyin: 0,
          vatTiyin: vatIncluded(c.priceTiyin, c.esfItem.vat_percent),
        })),
      }
    }
    // Свапаемая позиция — заменяем единственного кандидата на alt.
    const freshAlt = {
      ...alt,
      discountTiyin: 0,
      vatTiyin: vatIncluded(alt.priceTiyin, alt.esfItem.vat_percent),
    }
    return {
      ...p,
      candidates: [freshAlt],
      selectedAlternativeIndex: newAlternativeIndex,
    }
  })

  // Применяем distribute заново. Receipt.sum — целевая сумма (что МС хочет видеть).
  //
  // Важно: при swap кассир может выбрать товар отличающийся по цене на
  // несколько тысяч сум от target. distributeDiscount/Bump по дефолту
  // лимитированы 200k тийинов (2000 сум) на позицию — этого может не хватить.
  // Поднимаем лимит до 500k тийинов (5000 сум) — это совпадает с swapTolerance
  // в `tryPriceBucket`, так что любая выбранная альтернатива гарантированно
  // компенсируется и итог чека будет = receipt.sum.
  const target_sum = result.receipt.sum
  const swapOpts: MatcherOptions = {
    ...opts,
    discountForExactSum: true, // forced ON для swap — иначе сумма съедет
    maxDiscountPerItemTiyin: Math.max(
      opts.maxDiscountPerItemTiyin ?? 200_000,
      500_000,
    ),
  }
  distributeDiscount(newPositions, target_sum, swapOpts)
  distributeBump(newPositions, target_sum, swapOpts)

  const matchedTotal = newPositions.reduce(
    (s, m) =>
      s + m.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )

  return {
    ...result,
    positions: newPositions,
    matchedTotalTiyin: matchedTotal,
    totalDiffTiyin: matchedTotal - target_sum,
  }
}

/**
 * Пересобрать одну позицию с другим уровнем дробления (split).
 *
 * Используется UI кнопками «−» / «+» в SplitControl — кассир может разбить
 * один товар на несколько меньших или собрать обратно.
 *
 *   newSplitLevel = 1 → пробуем passthrough → priceBucket (один товар)
 *   newSplitLevel ≥ 2 → tryMultiItemForce (ровно N товаров)
 *
 * Что делается:
 *   1. Запускает соответствующую стратегию для одной позиции
 *   2. Если стратегия вернула null — возвращает `result` БЕЗ изменений
 *      (UI должен показать toast «не получилось» и не менять splitLevel).
 *   3. Заменяет позицию в массиве, сбрасывает discount у всех (потому что
 *      сумма всех matched поменялась).
 *   4. Заново применяет distributeDiscount/Bump с расширенным лимитом
 *      (как в recalculateAfterSwap — чтобы свапы и дробления компенсировались).
 *   5. Пересчитывает overall totals.
 *
 * Pool передаётся снаружи (из useState в Receipt) — не загружается
 * заново, чтобы UI не лагал. Pool обновляется только при загрузке чека
 * или при rematch после reserve-conflict.
 *
 * Чистая функция — оригинальный `result` не мутируется.
 *
 * @returns обновлённый BuildMatchResult или null если split не получился
 */
export function rebuildPositionWithSplit(
  result: BuildMatchResult,
  positionIndex: number,
  newSplitLevel: number,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): BuildMatchResult | null {
  if (positionIndex < 0 || positionIndex >= result.positions.length) return null
  if (newSplitLevel < 1) return null
  const target = result.positions[positionIndex]!
  if (!target.splittable) return null

  // Выбираем стратегию по уровню.
  let newMatch: PositionMatch | null
  if (newSplitLevel === 1) {
    // Возврат к одиночному товару — пробуем те же стратегии что и в buildMatch
    // в том же приоритете: linked-ms (если МС-позиция имеет linkedBuhName) →
    // passthrough → priceBucket. Без linked-ms кассир бы потерял явную
    // связку из МС при возврате после split.
    newMatch =
      tryLinkedMsVariant(target.source, pool, opts) ??
      tryPassthrough(target.source, pool, opts) ??
      tryPriceBucket(target.source, pool, opts)
  } else {
    newMatch = tryMultiItemForce(target.source, pool, opts, newSplitLevel)
  }
  if (!newMatch) return null

  // Заменяем позицию + сбрасываем discount у ВСЕХ (заново распределим ниже).
  const newPositions = result.positions.map((p, i) => {
    if (i === positionIndex) return newMatch!
    return {
      ...p,
      candidates: p.candidates.map((c) => ({
        ...c,
        discountTiyin: 0,
        vatTiyin: vatIncluded(c.priceTiyin, c.esfItem.vat_percent),
      })),
    }
  })

  // Те же расширенные лимиты что и для swap — split может дать большую
  // погрешность по сумме чем 2000 сум, особенно при N=4-5.
  const target_sum = result.receipt.sum
  const adjustOpts: MatcherOptions = {
    ...opts,
    discountForExactSum: true,
    maxDiscountPerItemTiyin: Math.max(
      opts.maxDiscountPerItemTiyin ?? 200_000,
      500_000,
    ),
  }
  distributeDiscount(newPositions, target_sum, adjustOpts)
  distributeBump(newPositions, target_sum, adjustOpts)

  const matchedTotal = newPositions.reduce(
    (s, m) =>
      s + m.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )

  return {
    ...result,
    positions: newPositions,
    matchedTotalTiyin: matchedTotal,
    totalDiffTiyin: matchedTotal - target_sum,
  }
}

/**
 * Заменить позицию вручную выбранным приходом (manual picker).
 *
 * Использование: кассир в UI кликает «Подобрать вручную» → открывается
 * модалка → выбирает inv_item из всего пула → вызывается эта функция.
 *
 * Семантика:
 *   - Цена = `pos.totalTiyin` (1:1 как в чеке МС — клиент уже заплатил эту
 *     сумму, фискализируем именно её, без markup×VAT пересчёта)
 *   - НДС = `vatIncluded(totalTiyin, vat_percent выбранного inv_item)`
 *   - Strategy = `'manual'`
 *   - Swappable / splittable = false (ручной выбор — фиксируем)
 *   - Применяется distributeDiscount/Bump чтобы сумма чека сошлась
 *
 * Защита: проверяем что у inv_item достаточно остатка под `pos.quantity`.
 * Если нет — возвращаем result без изменений (UI должен показать toast).
 *
 * Чистая функция — оригинальный `result` не мутируется.
 *
 * @returns обновлённый BuildMatchResult или null если manual pick невозможен
 */
export function replacePositionManual(
  result: BuildMatchResult,
  positionIndex: number,
  esfItem: import('@/lib/db').EsfItemWithAvailable,
  opts: MatcherOptions = {},
): BuildMatchResult | null {
  if (positionIndex < 0 || positionIndex >= result.positions.length) return null
  const target = result.positions[positionIndex]!
  const pos = target.source

  const available = esfItem.qty_received - esfItem.qty_consumed
  if (available < pos.quantity) return null

  // Создаём candidate с ценой 1:1 из чека МС
  const candidate = {
    esfItem,
    quantity: pos.quantity,
    priceTiyin: pos.totalTiyin,
    discountTiyin: 0,
    vatTiyin: vatIncluded(pos.totalTiyin, esfItem.vat_percent),
  }

  // Клон позиций: только целевую меняем, остальные сбрасываем discount.
  const newPositions: PositionMatch[] = result.positions.map((p, i) => {
    if (i !== positionIndex) {
      return {
        ...p,
        candidates: p.candidates.map((c) => ({
          ...c,
          discountTiyin: 0,
          vatTiyin: vatIncluded(c.priceTiyin, c.esfItem.vat_percent),
        })),
      }
    }
    return {
      ...p,
      candidates: [candidate],
      strategy: 'manual' as MatchStrategy,
      swappable: false,
      alternatives: [],
      selectedAlternativeIndex: -1,
      splittable: false,
      splitLevel: 1,
      canSplitMore: false,
      warnings: [],
    }
  })

  // Distribute discount/bump чтобы сумма чека сошлась 1-в-1
  const target_sum = result.receipt.sum
  const manualOpts: MatcherOptions = {
    ...opts,
    maxDiscountPerItemTiyin: Math.max(
      opts.maxDiscountPerItemTiyin ?? 200_000,
      500_000,
    ),
  }
  distributeDiscount(newPositions, target_sum, manualOpts)
  distributeBump(newPositions, target_sum, manualOpts)

  const matchedTotal = newPositions.reduce(
    (s, m) =>
      s + m.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )

  return {
    ...result,
    positions: newPositions,
    matchedTotalTiyin: matchedTotal,
    totalDiffTiyin: matchedTotal - target_sum,
    overallStrategy: pickOverallStrategy(newPositions.map((p) => p.strategy)),
    canAutoFiscalize: false, // manual = ручная проверка, отключаем auto
  }
}

const STRATEGY_RANK: Record<MatchStrategy, number> = {
  'linked-ms': 0,      // самая надёжная (явная связка из МС)
  passthrough: 1,
  'price-bucket': 2,
  'multi-item': 3,
  manual: 4,
}

function pickOverallStrategy(strategies: MatchStrategy[]): MatchStrategy {
  if (strategies.length === 0) return 'manual'
  return strategies.reduce<MatchStrategy>(
    (acc, s) => (STRATEGY_RANK[s] > STRATEGY_RANK[acc] ? s : acc),
    'linked-ms',
  )
}

/**
 * Объяснить кассиру (и в логи) почему ни одна стратегия не сработала.
 *
 * Использует уже загруженный пул (вместо отдельных запросов в БД, как
 * было раньше) — т.е. почти бесплатно. Если пул пуст — просим импортнуть
 * каталог; иначе ищем ближайшую цену в пуле и формируем сообщение.
 */
async function explainNoMatch(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions,
): Promise<string> {
  // Пул может быть пустой если справочник вообще пустой.
  if (pool.items.length === 0) {
    const total = await countEsfItems()
    if (total === 0) {
      return 'справочник пуст — импортируйте Excel с приходами в разделе «Справочник»'
    }
    return 'в справочнике нет товаров с доступными остатками'
  }

  if (pos.totalTiyin <= 0) {
    return 'нулевая сумма позиции — автоподбор по цене невозможен, нужен ручной выбор'
  }

  const strictVat = opts.vatStrict === true
  const markup = opts.markupPercent ?? 10
  const roundUp = opts.roundUpToSum ?? 1000

  // Если у позиции есть ИКПУ — проверяем, есть ли в пуле такой же.
  if (pos.classCode) {
    const sameIcpu = pool.items.filter(
      (p) => p.item.class_code === pos.classCode,
    )
    if (sameIcpu.length > 0) {
      if (strictVat) {
        const sameVat = sameIcpu.filter(
          (p) => p.item.vat_percent === pos.vatPercent,
        )
        if (sameVat.length === 0) {
          return `есть приходы с этим ИКПУ, но другой НДС (${sameIcpu[0]!.item.vat_percent}% вместо ${pos.vatPercent}%)`
        }
      }
      return `есть приходы с этим ИКПУ и остатками, но количество не покрывает (нужно ${pos.quantity / 1000} шт)`
    }
  }

  const filtered = strictVat
    ? pool.items.filter((p) => p.item.vat_percent === pos.vatPercent)
    : pool.items
  if (filtered.length === 0) {
    return `в справочнике нет товаров с НДС ${pos.vatPercent}% и доступными остатками`
  }

  // Найти ближайшую продажную цену одним проходом.
  let closestSellingPrice = filtered[0]!.sellingPrice
  let closestDiff = Math.abs(closestSellingPrice - pos.totalTiyin)
  let minPrice = closestSellingPrice
  for (const p of filtered) {
    const diff = Math.abs(p.sellingPrice - pos.totalTiyin)
    if (diff < closestDiff) {
      closestDiff = diff
      closestSellingPrice = p.sellingPrice
    }
    if (p.sellingPrice > 0 && p.sellingPrice < minPrice) {
      minPrice = p.sellingPrice
    }
  }

  const tolerance = opts.toleranceTiyin ?? 0
  const vatHint = strictVat ? ` с НДС ${pos.vatPercent}%` : ''
  const priceCtx = `(наценка ${markup}%, округление до ${roundUp} сум)`

  if (closestDiff <= tolerance) {
    return (
      `найден товар${vatHint} с подходящей продажной ценой ` +
      `${tiyinToSumDisplay(closestSellingPrice)} сум ${priceCtx}, ` +
      `но автоподбор отказался — возможна гонка остатков`
    )
  }

  if (pos.totalTiyin < minPrice) {
    return (
      `сумма позиции ${tiyinToSumDisplay(pos.totalTiyin)} меньше самой ` +
      `дешёвой продажной цены в справочнике${vatHint} ` +
      `(${tiyinToSumDisplay(minPrice)} сум ${priceCtx}) — нечем набрать по multi-item`
    )
  }

  return (
    `в справочнике${vatHint} ${filtered.length} товаров с остатками, ` +
    `но ближайшая продажная цена ${tiyinToSumDisplay(closestSellingPrice)} сум ${priceCtx} ` +
    `(разница ${tiyinToSumDisplay(closestDiff)}, tolerance ${tiyinToSumDisplay(tolerance)}); ` +
    `multi-item не собрал`
  )
}

/**
 * Распределить скидки между кандидатами чтобы итоговая сумма совпала с
 * `targetSum` (обычно rd.sum чека МойСклад).
 *
 * Алгоритм:
 *   1. diff = sum(priceTiyin) - targetSum. Если diff <= 0 — ничего не делаем.
 *   2. Для каждого кандидата считаем `maxDiscount`:
 *        min(maxPerItem_лимит, priceTiyin - costWithVat)
 *      где costWithVat = unit_price × (1 + vat/100) × quantity — себестоимость
 *      с НДС (без наценки), ниже которой опускаться нельзя.
 *   3. Раунд 1 — равномерно по всем: каждой по ceil(diff / N), но не больше
 *      её maxDiscount.
 *   4. Раунд 2 — добор остатка с тех у кого ещё есть запас.
 *   5. Если в итоге diff не покрыт — warning, чек уйдёт с расхождением.
 *
 * После распределения VAT каждой позиции пересчитывается от (price - discount).
 *
 * Mutates candidates.discountTiyin / .vatTiyin in-place. Возвращает warnings.
 */
function distributeDiscount(
  matches: PositionMatch[],
  targetSum: number,
  opts: MatcherOptions,
): string[] {
  if (opts.discountForExactSum !== true) return []

  const candidates = matches.flatMap((m) => m.candidates)
  if (candidates.length === 0) return []

  // diff > 0 = подбор больше чека МС, надо «срезать»
  const totalSelling = candidates.reduce((s, c) => s + c.priceTiyin, 0)
  let remaining = totalSelling - targetSum
  if (remaining <= 0) return []

  const maxPerItem = opts.maxDiscountPerItemTiyin ?? 200_000 // 2000 сум

  // Считаем максимально возможную скидку для каждого кандидата.
  type Slot = { c: typeof candidates[number]; max: number }
  const slots: Slot[] = candidates.map((c) => {
    const cost = costWithVat(
      c.esfItem.unit_price_tiyin,
      c.esfItem.vat_percent,
      c.quantity,
    )
    const maxBySelfCost = Math.max(0, c.priceTiyin - cost)
    return { c, max: Math.min(maxBySelfCost, maxPerItem) }
  })

  // Раунд 1: равномерно делим. ceil чтобы покрыть весь diff если все позиции
  // имеют достаточно запаса; если у какой-то меньше — берём по максимуму.
  const N = slots.length
  const perItem = Math.ceil(remaining / N)
  for (const s of slots) {
    if (remaining <= 0) break
    const take = Math.min(perItem, s.max, remaining)
    s.c.discountTiyin = take
    remaining -= take
  }

  // Раунд 2: добор с тех у кого осталось пространство.
  if (remaining > 0) {
    for (const s of slots) {
      if (remaining <= 0) break
      const left = s.max - s.c.discountTiyin
      if (left <= 0) continue
      const take = Math.min(left, remaining)
      s.c.discountTiyin += take
      remaining -= take
    }
  }

  // Пересчитать VAT каждого кандидата от (price - discount).
  for (const c of candidates) {
    c.vatTiyin = vatIncluded(
      c.priceTiyin - c.discountTiyin,
      c.esfItem.vat_percent,
    )
  }

  if (remaining > 0) {
    return [
      `Не удалось обнулить расхождение: осталось ${tiyinToSumDisplay(remaining)} сум, ` +
        `у позиций нет достаточного запаса до себестоимости с НДС ` +
        `(лимит скидки ${tiyinToSumDisplay(maxPerItem)} сум на позицию)`,
    ]
  }
  return []
}

/**
 * Зеркало `distributeDiscount` для случая matched < target — добавляем
 * НАДБАВКУ к цене кандидатов чтобы итоговая сумма выросла до targetSum.
 *
 * Когда сюда попадаем:
 *   - multi-item не добрал последнюю «копейку» — например, цель 5 000 000,
 *     greedy набрал 4 999 500, осталось 500 в пределах tolerance.
 *   - passthrough с округлением quantity дал не ровно targetSum.
 *   - (price-bucket после фикса A всегда даёт точное pos.totalTiyin,
 *     поэтому здесь не появляется.)
 *
 * Алгоритм симметричен distributeDiscount, но:
 *   - **нет cost-floor**: повышение цены = увеличение наценки, это всегда легально.
 *   - **есть cap maxPerItem**: чтобы цена на ленте не выглядела абсурдно
 *     отличающейся от расчётной (используется тот же лимит, что и для скидки —
 *     `maxDiscountPerItemTiyin`).
 *
 * Гейтится тем же флагом `discountForExactSum` — это «один тумблер для
 * точного совпадения суммы», направление выбирается по знаку diff.
 *
 * Mutates `priceTiyin` и `vatTiyin` каждого кандидата in-place. Скидка
 * (`discountTiyin`) не трогается. Возвращает warnings.
 */
function distributeBump(
  matches: PositionMatch[],
  targetSum: number,
  opts: MatcherOptions,
): string[] {
  if (opts.discountForExactSum !== true) return []

  const candidates = matches.flatMap((m) => m.candidates)
  if (candidates.length === 0) return []

  // diff > 0 = подбор МЕНЬШЕ чека МС, надо добавить
  const totalNet = candidates.reduce(
    (s, c) => s + c.priceTiyin - c.discountTiyin,
    0,
  )
  let remaining = targetSum - totalNet
  if (remaining <= 0) return []

  const maxPerItem = opts.maxDiscountPerItemTiyin ?? 200_000 // 2000 сум

  type Slot = { c: typeof candidates[number]; bumped: number }
  const slots: Slot[] = candidates.map((c) => ({ c, bumped: 0 }))

  // Раунд 1: равномерно делим. ceil чтобы покрыть весь diff если все позиции
  // имеют достаточно запаса до cap.
  const N = slots.length
  const perItem = Math.ceil(remaining / N)
  for (const s of slots) {
    if (remaining <= 0) break
    const take = Math.min(perItem, maxPerItem, remaining)
    s.bumped = take
    remaining -= take
  }

  // Раунд 2: добор с тех у кого ещё есть пространство до cap.
  if (remaining > 0) {
    for (const s of slots) {
      if (remaining <= 0) break
      const left = maxPerItem - s.bumped
      if (left <= 0) continue
      const take = Math.min(left, remaining)
      s.bumped += take
      remaining -= take
    }
  }

  // Применить надбавку и пересчитать VAT от (price - discount).
  for (const s of slots) {
    if (s.bumped <= 0) continue
    s.c.priceTiyin += s.bumped
    s.c.vatTiyin = vatIncluded(
      s.c.priceTiyin - s.c.discountTiyin,
      s.c.esfItem.vat_percent,
    )
  }

  if (remaining > 0) {
    return [
      `Не удалось добить до точной суммы: осталось ${tiyinToSumDisplay(remaining)} сум, ` +
        `достигнут лимит надбавки ${tiyinToSumDisplay(maxPerItem)} сум на позицию`,
    ]
  }
  return []
}
