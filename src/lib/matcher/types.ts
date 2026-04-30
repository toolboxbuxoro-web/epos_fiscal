import type { EsfItemRow, MatchStrategy, MilliQty, Tiyin } from '@/lib/db/types'
import type { MsRetailDemand } from '@/lib/moysklad/types'

/** Нормализованная позиция чека МойСклад в наших единицах. */
export interface NormalizedPosition {
  index: number
  name: string
  /** Количество в тысячных (наша конвенция). */
  quantity: MilliQty
  /** Цена за единицу × количество, тийины. */
  totalTiyin: Tiyin
  /** Ставка НДС: 0/12/15. */
  vatPercent: number
  /** ИКПУ, если найден в кастомных атрибутах товара МС. */
  classCode: string | null
  /** Code упаковки, если найден. */
  packageCode: string | null
  barcode: string | null
}

export interface MatchCandidate {
  /** Источник: товар из esf_items. */
  esfItem: EsfItemRow
  /** Сколько штук берём (миллидоли). */
  quantity: MilliQty
  /** Сумма за всё кол-во в тийинах. */
  priceTiyin: Tiyin
  /** Сумма НДС в тийинах. */
  vatTiyin: Tiyin
}

export interface PositionMatch {
  /** Какую позицию исходного чека замещаем. */
  source: NormalizedPosition
  /** Чем замещаем (1+ кандидатов). */
  candidates: MatchCandidate[]
  /** Стратегия для этой позиции. */
  strategy: MatchStrategy
  /** Расхождение по сумме (положительное = больше оригинала). */
  diffTiyin: Tiyin
  /** Если нужна ручная подстройка — список причин. */
  warnings: string[]
}

export interface BuildMatchResult {
  receipt: MsRetailDemand
  positions: PositionMatch[]
  /** Сводка: какая стратегия преобладает. */
  overallStrategy: MatchStrategy
  /** Суммарное расхождение. */
  totalDiffTiyin: Tiyin
  /** Сумма оригинала. */
  originalTotalTiyin: Tiyin
  /** Сумма подбора. */
  matchedTotalTiyin: Tiyin
  /** Может ли быть фискализирован «как есть» автоматически. */
  canAutoFiscalize: boolean
  /** Все warning'и в одном плоском списке. */
  warnings: string[]
}

export interface MatcherOptions {
  /** Допуск по сумме на одну позицию (тийины). По умолчанию 0 (точное совпадение). */
  toleranceTiyin?: Tiyin
  /** Совпадать по ставке НДС? По умолчанию true. */
  vatStrict?: boolean
  /** Максимум кандидатов для multi-item стратегии. */
  maxMultiItem?: number
}
