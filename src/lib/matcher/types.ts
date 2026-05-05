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
  /** Сумма за всё кол-во в тийинах ДО скидки (продажная цена × quantity). */
  priceTiyin: Tiyin
  /**
   * Скидка на позицию в тийинах (>= 0).
   *
   * Применяется чтобы итоговая сумма подбора совпала 1-в-1 с суммой чека МС
   * (после округления до 1000 сум продажные цены систематически выше).
   * Распределяется в `distributeDiscount` после основного цикла стратегий.
   * Не может опустить позицию ниже себестоимости с НДС (unit_price × (1+vat/100)).
   *
   * В EPOS Communicator передаётся отдельным полем Item.Discount,
   * VAT пересчитывается от (Price - Discount).
   */
  discountTiyin: Tiyin
  /**
   * Сумма НДС в тийинах, рассчитанная от (priceTiyin - discountTiyin).
   * Если discount меняется — vatTiyin тоже пересчитывается.
   */
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
  /**
   * Совпадать по ставке НДС? По умолчанию **false** — потому что главный смысл
   * программы это подменять товары без НДС (BIYOTI, серые) на товары с НДС
   * (UBAY и т.д., с импортом). Если магазин ставит strict, matcher теряет
   * почти все варианты. Включать `true` только если гарантировано что
   * чеки МС и приходы из ЭСФ имеют согласованный НДС.
   */
  vatStrict?: boolean
  /** Максимум кандидатов для multi-item стратегии. */
  maxMultiItem?: number
  /**
   * Процент наценки на приходную цену (по умолчанию 10).
   * Применяется ДО НДС: selling = round_up(price * (1+markup/100) * (1+vat/100)).
   */
  markupPercent?: number
  /**
   * Шаг округления продажной цены ВВЕРХ, в сумах.
   * По умолчанию 1000 — продажная цена всегда кратна 1000 сум.
   * 1 = без округления, 100 = до сотен.
   */
  roundUpToSum?: number
  /**
   * Включить ли автоматическое выравнивание суммы подбора под сумму чека МС?
   * По умолчанию false (не трогаем).
   *
   * Если true — после основного цикла стратегий применяется:
   *   - `distributeDiscount` — если matched > target (срезаем скидкой,
   *     не ниже себестоимости с НДС, лимит `maxDiscountPerItemTiyin`).
   *   - `distributeBump` — если matched < target (добавляем надбавку к цене,
   *     лимит тот же `maxDiscountPerItemTiyin`).
   *
   * Один флаг → точное совпадение суммы в обе стороны.
   */
  discountForExactSum?: boolean
  /**
   * IDs (server_item_id) которые matcher должен ИГНОРИРОВАТЬ.
   *
   * Используется при rematch после `InventoryConflictError`: сервер
   * вернул что таких-то товаров не хватило — значит другой магазин
   * успел их забрать. SSE-обновление локального кэша может ещё не
   * прийти, поэтому форсим их исключение через эту опцию чтобы
   * matcher не предлагал ту же замену снова.
   */
  excludeServerItemIds?: number[]
  /**
   * Максимум коррекции (скидки ИЛИ надбавки) на одну позицию, в тийинах.
   * По умолчанию 200000 (2000 сум). Больше не разрешаем даже если запас
   * позволяет — чтобы цена на ленте не выглядела абсурдно отличающейся
   * от расчётной.
   */
  maxDiscountPerItemTiyin?: number
}
