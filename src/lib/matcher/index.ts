import type { MsRetailDemand } from '@/lib/moysklad/types'
import { extractPositions } from './extract'
import {
  ceilToSum,
  floorToSum,
  loadMatcherPool,
  priceFloorTiyin,
  tryLinkedMsVariant,
  tryMultiItem,
  tryPassthrough,
  tryPriceBucket,
  vatIncluded,
  type MatcherPool,
} from './strategies'
import { planHolistic } from './holistic'
import type {
  BuildMatchResult,
  MatcherMode,
  MatcherOptions,
  NormalizedPosition,
  PositionMatch,
} from './types'
import type { MatchStrategy } from '@/lib/db/types'
import { countEsfItems } from '@/lib/db'
import { log } from '@/lib/log'
import { tiyinToSumDisplay } from '@/lib/format'

export * from './types'
export { extractPositions } from './extract'
export { loadMatcherPool, type MatcherPool } from './strategies'
export { planHolistic } from './holistic'

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

  // ── Эффективная таргет-сумма ─────────────────────────────────────
  // Обычно = receipt.sum (что покупатель заплатил по МС). Но если кассир
  // в UI указал что часть оплаты прошла через Click/Payme (не фискализируем) —
  // matcher должен работать с уменьшенной суммой. Override приходит через
  // opts.targetSumOverrideTiyin, см. MatcherOptions.
  //
  // `receipt.sum` НЕ мутируем (он используется в Refund.tsx, истории и т.д.).
  // `effectiveTarget` — это локальный «target» для подбора + распределения.
  //
  // Если override отрицательный или > receipt.sum — игнорируем (защита).
  const effectiveTarget =
    typeof opts.targetSumOverrideTiyin === 'number' &&
    opts.targetSumOverrideTiyin >= 0 &&
    opts.targetSumOverrideTiyin <= receipt.sum
      ? opts.targetSumOverrideTiyin
      : receipt.sum

  // ── Скидка на чек МС (бонусы / баллы / ручная скидка) ────────────
  // В retaildemand `sum` — это что покупатель РЕАЛЬНО заплатил (после
  // вычета бонусов/баллов). Сумма позиций может быть БОЛЬШЕ — например
  // покупка на 1 000 000 сум, 100 000 закрыто баллами, к оплате 900 000.
  // Фискализируем именно `effectiveTarget` (= receipt.sum минус Click/Payme).
  // Если сумма позиций больше effectiveTarget — пропорционально уменьшаем
  // totalTiyin каждой позиции, чтобы matcher подбирал товары на правильную сумму.
  //
  // Если effectiveTarget = 0 (всё оплачено бонусами или Click/Payme) — фискализировать
  // нечего: ОФД не примет нулевой чек.
  const positionsSumRaw = rawPositions.reduce((s, p) => s + p.totalTiyin, 0)
  if (effectiveTarget <= 0) {
    const isClickPaymeCase =
      effectiveTarget === 0 &&
      typeof opts.targetSumOverrideTiyin === 'number' &&
      opts.targetSumOverrideTiyin === 0 &&
      receipt.sum > 0
    return {
      receipt,
      positions: [],
      overallStrategy: 'manual',
      totalDiffTiyin: 0,
      originalTotalTiyin: receipt.sum,
      matchedTotalTiyin: 0,
      canAutoFiscalize: false,
      mode: 'classic',
      warnings: [
        isClickPaymeCase
          ? 'Вся сумма чека помечена как оплата через Click/Payme — фискальный ' +
            'чек не выдаётся. Закройте чек как «не фискальный».'
          : 'Чек оплачен бонусами / баллами полностью (сумма к оплате 0). ' +
            'Фискализация не нужна — фискальный чек создаётся только на сумму, ' +
            'реально проведённую через кассу.',
      ],
    }
  }

  // Если эффективный target меньше суммы позиций — масштабируем позиции пропорционально.
  // Скейл применяется ДО подбора: matcher работает с уже-скейленной позиций.
  const positions =
    positionsSumRaw > 0 && effectiveTarget < positionsSumRaw
      ? rawPositions.map((p) => ({
          ...p,
          totalTiyin: Math.round((p.totalTiyin * effectiveTarget) / positionsSumRaw),
        }))
      : rawPositions
  if (positionsSumRaw > 0 && effectiveTarget < positionsSumRaw) {
    const scaledOff = positionsSumRaw - effectiveTarget
    // Различаем причину скейла: Click/Payme или бонусы — баннер у кассира
    // будет точнее.
    const isExcludeScale =
      typeof opts.targetSumOverrideTiyin === 'number' &&
      opts.targetSumOverrideTiyin < receipt.sum
    warnings.push(
      isExcludeScale
        ? `Часть оплаты помечена как Click/Payme: МС-сумма ` +
            `${tiyinToSumDisplay(receipt.sum)} сум, фискализируется ` +
            `${tiyinToSumDisplay(effectiveTarget)} сум, исключено ` +
            `${tiyinToSumDisplay(scaledOff)} сум. Позиции пропорционально уменьшены.`
        : `Покупатель оплатил частично бонусами/баллами: сумма к оплате ` +
            `${tiyinToSumDisplay(effectiveTarget)} сум, ` +
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

  // Применить распределение скидок чтобы итоговая сумма совпала с effectiveTarget.
  // distributeDiscount: matched > target → срезаем скидкой (cost-floor).
  // distributeBump: matched < target → добавляем надбавку к цене (без cost-floor).
  // Оба гейтятся одним флагом opts.discountForExactSum, симметрично.
  // Каждое — no-op в своём «не моём» направлении, поэтому safe вызывать оба.
  const discountWarnings = distributeDiscount(matches, effectiveTarget, opts)
  warnings.push(...discountWarnings)
  const bumpWarnings = distributeBump(matches, effectiveTarget, opts)
  warnings.push(...bumpWarnings)

  // matchedTotal теперь = сумма (priceTiyin - discountTiyin) каждого кандидата.
  // Это то что реально пойдёт в EPOS как сумма к оплате (Price - Discount).
  const matchedTotal = matches.reduce(
    (s, m) =>
      s + m.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )
  // totalDiff считается ОТ effectiveTarget (не от ms_sum) — это то расхождение
  // которое релевантно для подбора. Поле в return называется
  // `originalTotalTiyin` и хранит МС-сумму для UI «оригинал из МС».
  const totalDiff = matchedTotal - effectiveTarget

  // Преобладающая стратегия — самая «слабая» из применённых.
  const overallStrategy = pickOverallStrategy(matches.map((m) => m.strategy))

  // ── Holistic fallback ──────────────────────────────────────────────
  // Если classic не закрыл задачу (есть unmatched позиции или итог ≠ target)
  // И MatcherMode = 'auto' | 'holistic' — пробуем целостный подбор.
  // Phase 1: holistic ЗАМЕЩАЕТ classic-результат целиком (см. holistic.ts).
  // Phase 2 (future): возможно гибридный merge — сейчас простая замена.
  const mode: MatcherMode = opts.matcherMode ?? 'auto'
  const hasUnmatched = matches.some((m) => m.candidates.length === 0)
  const shouldTryHolistic =
    mode === 'holistic' ||
    (mode === 'auto' && (hasUnmatched || matchedTotal !== effectiveTarget))

  if (shouldTryHolistic) {
    const holistic = planHolistic(effectiveTarget, pool, opts)
    if (holistic.ok) {
      void log.info(
        'matcher',
        `[holistic] fallback применён: ${holistic.plan.lines.length} строк`,
        {
          mode,
          unmatchedBefore: matches.filter((m) => m.candidates.length === 0).length,
          classicTotal: matchedTotal,
          holisticTotal: holistic.plan.totalTiyin,
          target: effectiveTarget,
        },
      )
      const holisticMatched = holistic.plan.totalTiyin
      // Сохраняем classic-positions ТОЛЬКО как информационный «оригинал из МС»
      // в UI. fiscalize() и печать пойдут через holistic.lines (см. fiscalize.ts).
      return {
        receipt,
        positions: matches,
        overallStrategy,
        totalDiffTiyin: holisticMatched - effectiveTarget, // должен быть 0
        originalTotalTiyin: receipt.sum,
        matchedTotalTiyin: holisticMatched,
        canAutoFiscalize: false, // holistic = всегда требует подтверждения кассира
        mode: 'holistic',
        holistic: holistic.plan,
        warnings: [
          ...warnings,
          `Подбор переключён в режим holistic: classic не сошёлся ` +
            `(${matches.filter((m) => m.candidates.length === 0).length} неподобранных, ` +
            `сумма ${tiyinToSumDisplay(matchedTotal)} ≠ ${tiyinToSumDisplay(effectiveTarget)}). ` +
            `Чек собран целиком на сумму, фискальные строки см. справа.`,
          ...holistic.plan.notes,
        ],
      }
    }
    // Holistic не справился — продолжаем с classic-результатом
    // (UI покажет unmatched и предложит manual picker).
    void log.warn(
      'matcher',
      `[holistic] fallback отклонён: ${holistic.reason} — ${holistic.detail}`,
      { mode, target: effectiveTarget },
    )
    warnings.push(
      `Holistic-режим не справился (${holistic.reason}): ${holistic.detail}. ` +
        `Используйте ручной подбор для неподобранных позиций.`,
    )
  }

  // Проверка минимальной наценки: ни одна позиция не должна продаваться ниже
  // себестоимости + 5%. Возникает в основном при linked-ms / price-bucket
  // где цена = pos.totalTiyin (что заплатил клиент). Если клиент заплатил
  // меньше чем себестоимость+5% выбранного прихода — предупреждаем кассира
  // (не блокируем: цену чека МС менять нельзя, клиент уже заплатил).
  for (const m of matches) {
    for (const c of m.candidates) {
      const effectivePrice = c.priceTiyin - c.discountTiyin
      const floor = priceFloorTiyin(
        c.esfItem.unit_price_tiyin,
        c.esfItem.vat_percent,
        c.quantity,
      )
      if (effectivePrice > 0 && effectivePrice < floor) {
        const lossTiyin = floor - effectivePrice
        warnings.push(
          `⚠️ «${c.esfItem.name}» продаётся за ${tiyinToSumDisplay(effectivePrice)} ` +
            `— ниже минимальной цены ${tiyinToSumDisplay(floor)} ` +
            `(себестоимость +5%). Не хватает ${tiyinToSumDisplay(lossTiyin)}. ` +
            `Замените товар через ручную сборку если возможно.`,
        )
      }
    }
  }

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
    // originalTotalTiyin = ВСЕГДА receipt.sum (для UI «оригинал из МС» это
    // настоящая МС-сумма, не effectiveTarget). matchedTotalTiyin =
    // effectiveTarget (или близко к нему через bump/discount).
    originalTotalTiyin: receipt.sum,
    matchedTotalTiyin: matchedTotal,
    canAutoFiscalize,
    mode: 'classic',
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
  // В holistic-режиме swap по позициям не имеет смысла — фискальные строки
  // строятся из result.holistic.lines, а result.positions хранится только
  // как «оригинал из МС». UI этой ветки не должен рисовать swap-стрелки.
  if (result.mode === 'holistic') return result
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
  // target_sum уважает Click/Payme exclude (opts.targetSumOverrideTiyin):
  // после swap/split/manual чек должен сойтись на фискальную, а не МС-сумму.
  const target_sum =
    typeof opts.targetSumOverrideTiyin === 'number' &&
    opts.targetSumOverrideTiyin >= 0 &&
    opts.targetSumOverrideTiyin <= result.receipt.sum
      ? opts.targetSumOverrideTiyin
      : result.receipt.sum
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
  // Floor = себестоимость × (1 + 5%) — скидка не может опустить цену ниже
  // «себестоимость + минимальная наценка». Раньше floor был голой
  // себестоимостью (0% маржи) → товар продавался в ноль прибыли.
  type Slot = { c: typeof candidates[number]; max: number }
  const slots: Slot[] = candidates.map((c) => {
    const floor = priceFloorTiyin(
      c.esfItem.unit_price_tiyin,
      c.esfItem.vat_percent,
      c.quantity,
    )
    const maxBySelfCost = Math.max(0, c.priceTiyin - floor)
    return { c, max: Math.min(maxBySelfCost, maxPerItem) }
  })

  // Работаем в ЦЕЛЫХ сумах чтобы финальная цена (price - discount) не имела
  // тийинов на ленте. `remaining` дробим на whole-sum чанки. Сабсумный остаток
  // (< 1 сум) оставляем нераспределённым — в UZ-рознице суммы всегда целые,
  // поэтому для них остаток = 0 (точное совпадение). Для дробного target
  // расхождение < 1 сум, в пределах EPOS-tolerance.
  let toRemove = floorToSum(remaining)
  const N = slots.length

  // Раунд 1: равномерно делим. ceilToSum чтобы перекрыть diff целыми сумами.
  const perItem = ceilToSum(toRemove / N)
  for (const s of slots) {
    if (toRemove <= 0) break
    const take = Math.min(perItem, s.max, toRemove)
    s.c.discountTiyin = take
    toRemove -= take
  }

  // Раунд 2: добор с тех у кого осталось пространство (всё кратно 1 суму).
  if (toRemove > 0) {
    for (const s of slots) {
      if (toRemove <= 0) break
      const left = s.max - s.c.discountTiyin
      if (left <= 0) continue
      const take = Math.min(left, toRemove)
      s.c.discountTiyin += take
      toRemove -= take
    }
  }
  // Остаток для warning ниже: сабсумный + то что не влезло в floor-cap.
  remaining = toRemove + (remaining - floorToSum(remaining))

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

  // Надбавка использует ОТДЕЛЬНЫЙ (больший) лимит — см. maxBumpPerItemTiyin
  // в MatcherOptions. Надбавка = бо́льшая наценка, безопасна; cap 2000 сум
  // от discount не закрывал разрывы 20-54к на дырявом складе → минус.
  const maxPerItem =
    opts.maxBumpPerItemTiyin ??
    Math.max(opts.maxDiscountPerItemTiyin ?? 0, 1_000_000) // 10000 сум

  // maxPerItem округляем вниз до целого сума чтобы все надбавки были whole-sum.
  const maxPerItemSum = floorToSum(maxPerItem)

  type Slot = { c: typeof candidates[number]; bumped: number }
  const slots: Slot[] = candidates.map((c) => ({ c, bumped: 0 }))

  // Работаем в ЦЕЛЫХ сумах (без тийинов на ленте). Дробим whole-sum часть
  // remaining; сабсумный остаток (< 1 сум) оставляем — для целых UZ-сумм = 0.
  let toAdd = floorToSum(remaining)
  const N = slots.length

  // Раунд 1: равномерно делим, ceilToSum — целыми сумами.
  const perItem = ceilToSum(toAdd / N)
  for (const s of slots) {
    if (toAdd <= 0) break
    const take = Math.min(perItem, maxPerItemSum, toAdd)
    s.bumped = take
    toAdd -= take
  }

  // Раунд 2: добор с тех у кого ещё есть пространство до cap.
  if (toAdd > 0) {
    for (const s of slots) {
      if (toAdd <= 0) break
      const left = maxPerItemSum - s.bumped
      if (left <= 0) continue
      const take = Math.min(left, toAdd)
      s.bumped += take
      toAdd -= take
    }
  }

  // Применить надбавку (она уже кратна 1 суму) и пересчитать VAT.
  for (const s of slots) {
    if (s.bumped <= 0) continue
    s.c.priceTiyin += s.bumped
    s.c.vatTiyin = vatIncluded(
      s.c.priceTiyin - s.c.discountTiyin,
      s.c.esfItem.vat_percent,
    )
  }
  // Остаток для warning: не влезшее в cap + сабсумный.
  remaining = toAdd + (remaining - floorToSum(remaining))

  if (remaining > 0) {
    return [
      `Не удалось добить до точной суммы: осталось ${tiyinToSumDisplay(remaining)} сум, ` +
        `достигнут лимит надбавки ${tiyinToSumDisplay(maxPerItem)} сум на позицию`,
    ]
  }
  return []
}
