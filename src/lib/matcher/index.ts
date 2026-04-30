import type { MsRetailDemand } from '@/lib/moysklad/types'
import { extractPositions } from './extract'
import { tryMultiItem, tryPassthrough, tryPriceBucket } from './strategies'
import type { BuildMatchResult, MatcherOptions, PositionMatch } from './types'
import type { MatchStrategy } from '@/lib/db/types'

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
      warnings.push(
        `Позиция «${pos.name}» (${pos.totalTiyin / 100} сум): подбор не удался`,
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
