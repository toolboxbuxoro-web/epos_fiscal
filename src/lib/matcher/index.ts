import type { MsRetailDemand } from '@/lib/moysklad/types'
import { extractPositions } from './extract'
import { tryMultiItem, tryPassthrough, tryPriceBucket } from './strategies'
import type {
  BuildMatchResult,
  MatcherOptions,
  NormalizedPosition,
  PositionMatch,
} from './types'
import type { MatchStrategy } from '@/lib/db/types'
import { countEsfItems, listEsfItems } from '@/lib/db'
import { tiyinToSumDisplay } from '@/lib/format'

export * from './types'
export { extractPositions } from './extract'

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
  const positions = extractPositions(receipt)
  const matches: PositionMatch[] = []
  const warnings: string[] = []

  for (const pos of positions) {
    const m =
      (await tryPassthrough(pos, opts)) ??
      (await tryPriceBucket(pos, opts)) ??
      (await tryMultiItem(pos, opts))

    if (m) {
      matches.push(m)
      warnings.push(...m.warnings)
    } else {
      const reason = await explainNoMatch(pos, opts)
      warnings.push(
        `Позиция «${pos.name}» (${tiyinToSumDisplay(pos.totalTiyin)} сум, ` +
          `ИКПУ ${pos.classCode ?? '—'}, НДС ${pos.vatPercent}%): ${reason}`,
      )
    }
  }

  const matchedTotal = matches.reduce(
    (s, m) => s + m.candidates.reduce((cs, c) => cs + c.priceTiyin, 0),
    0,
  )
  const totalDiff = matchedTotal - receipt.sum

  // Преобладающая стратегия — самая «слабая» из применённых.
  const overallStrategy = pickOverallStrategy(matches.map((m) => m.strategy))

  // canAutoFiscalize: все позиции passthrough и нет warnings и diff = 0
  const canAutoFiscalize =
    matches.length === positions.length &&
    matches.every((m) => m.strategy === 'passthrough') &&
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

const STRATEGY_RANK: Record<MatchStrategy, number> = {
  passthrough: 0,
  'price-bucket': 1,
  'multi-item': 2,
  manual: 3,
}

function pickOverallStrategy(strategies: MatchStrategy[]): MatchStrategy {
  if (strategies.length === 0) return 'manual'
  return strategies.reduce<MatchStrategy>(
    (acc, s) => (STRATEGY_RANK[s] > STRATEGY_RANK[acc] ? s : acc),
    'passthrough',
  )
}

/**
 * Объяснить кассиру (и в логи) почему ни одна стратегия не сработала.
 *
 * Делает 1-3 коротких запроса в БД, чтобы дать конкретную причину:
 *   - справочник пуст
 *   - нулевая сумма позиции (нечего подбирать по цене)
 *   - есть точный ИКПУ, но остатки на нуле
 *   - НДС не совпадает (только если vatStrict=true)
 *   - есть похожие, но цены далеко (показывает ближайшую)
 *
 * Без этого warning'и были бесполезны: «подбор не удался» — и поди разберись
 * чего не хватает: справочника, остатков, или просто цены не совпали.
 */
async function explainNoMatch(
  pos: NormalizedPosition,
  opts: MatcherOptions,
): Promise<string> {
  const total = await countEsfItems()
  if (total === 0) {
    return 'справочник пуст — импортируйте Excel с приходами в разделе «Справочник»'
  }

  if (pos.totalTiyin <= 0) {
    return 'нулевая сумма позиции — автоподбор по цене невозможен, нужен ручной выбор'
  }

  const strictVat = opts.vatStrict === true

  // Если у позиции есть ИКПУ — проверяем, есть ли в справочнике с тем же.
  if (pos.classCode) {
    const sameIcpu = await listEsfItems({ classCode: pos.classCode, limit: 5 })
    if (sameIcpu.length > 0) {
      const withStock = sameIcpu.filter((i) => i.qty_received - i.qty_consumed > 0)
      if (withStock.length === 0) {
        return `есть приходы с этим ИКПУ (${sameIcpu.length} шт), но все остатки израсходованы`
      }
      if (strictVat) {
        const sameVat = withStock.filter((i) => i.vat_percent === pos.vatPercent)
        if (sameVat.length === 0) {
          return `есть приходы с этим ИКПУ, но другой НДС (${withStock[0]!.vat_percent}% вместо ${pos.vatPercent}%)`
        }
      }
      return `есть приходы с этим ИКПУ и остатками, но количество не покрывает (нужно ${pos.quantity / 1000} шт)`
    }
    // ИКПУ не найден — попробуем подбор по цене.
  }

  const tolerance = opts.toleranceTiyin ?? 0

  // Если strict — ищем только тот же НДС, иначе любой.
  const pool = await listEsfItems({
    vatPercent: strictVat ? pos.vatPercent : undefined,
    minAvailable: 1000,
    limit: 2000,
  })
  if (pool.length === 0) {
    if (strictVat) {
      return `в справочнике нет товаров с НДС ${pos.vatPercent}% и доступными остатками`
    }
    return 'в справочнике нет товаров с доступными остатками'
  }

  // Найдём ближайшую цену.
  const closest = pool.reduce(
    (acc, item) => {
      const diff = Math.abs(item.unit_price_tiyin - pos.totalTiyin)
      return diff < acc.diff ? { item, diff } : acc
    },
    { item: pool[0]!, diff: Infinity },
  )

  // Минимальная цена в пуле — для подсказки про multi-item.
  const minPrice = pool.reduce(
    (m, i) => (i.unit_price_tiyin < m ? i.unit_price_tiyin : m),
    pool[0]!.unit_price_tiyin,
  )

  const vatHint = strictVat ? ` с НДС ${pos.vatPercent}%` : ''
  if (closest.diff <= tolerance) {
    // Должно было сработать, но не сработало — что-то странное (race?).
    return (
      `найден товар${vatHint} с подходящей ценой ` +
      `(${tiyinToSumDisplay(closest.item.unit_price_tiyin)} сум), ` +
      `но автоподбор отказался — возможна гонка остатков`
    )
  }

  // Если позиция меньше minPrice — multi-item не наберёт ничего.
  if (pos.totalTiyin < minPrice) {
    return (
      `сумма позиции ${tiyinToSumDisplay(pos.totalTiyin)} меньше самого ` +
      `дешёвого товара в справочнике${vatHint} (${tiyinToSumDisplay(minPrice)} сум) — ` +
      `нечем набрать по multi-item`
    )
  }

  return (
    `в справочнике${vatHint} ${pool.length} товаров с остатками, ` +
    `но ближайшая цена ${tiyinToSumDisplay(closest.item.unit_price_tiyin)} сум ` +
    `(разница ${tiyinToSumDisplay(closest.diff)} сум, tolerance ${tiyinToSumDisplay(tolerance)}); ` +
    `multi-item не смог собрать сумму с допуском`
  )
}
