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
  /**
   * «Бухгалтерское наименование» из характеристик модификации МС.
   *
   * Бухгалтер в МС у товара создаёт модификацию и в характеристике пишет
   * точное имя как в нашей `esf_items` (например «Тепловая электрическая пушка
   * ТЭПК-3000K (керам.нагревательный элемент,круглая) Ресанта»). Tauri читает
   * это значение и ищет в локальной БД через smart-search.
   *
   * Имя характеристики настраивается через `SettingKey.MsLinkCharacteristicName`
   * (default «Бухгалтерское наименование»). См. `extract.ts::readLinkedBuhName`
   * и `strategies.ts::tryLinkedMsVariant`.
   *
   * `null` если позиция — обычный товар (не модификация) или характеристики нет.
   */
  linkedBuhName: string | null
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
  /**
   * Доступен ли swap товара через UI-стрелки `←` / `→`?
   *
   * - **price-bucket** → true (выбираем товар по цене, ИКПУ всё равно меняем)
   * - **passthrough** → false (нельзя менять конкретный ИКПУ-товар, нарушит учёт)
   * - **multi-item** → false в MVP (нужен сложный UI для группы; Phase 2)
   */
  swappable: boolean
  /**
   * Альтернативные варианты замены той же ms-позиции — для UI swap-кнопок.
   * Сортированы по близости цены к `source.totalTiyin`. Первый элемент —
   * текущий выбор (продублирован из `candidates[0]`). Пустой массив если
   * `swappable === false` или альтернатив не нашлось.
   */
  alternatives: MatchCandidate[]
  /** Индекс активного варианта в `alternatives`. -1 если alternatives пуст. */
  selectedAlternativeIndex: number
  /**
   * Текущее число товаров в подборе (= `candidates.length` для multi-item-force).
   *
   *   1 = одна строка (passthrough / price-bucket / single-item multi)
   *   2+ = принудительное дробление через UI «Раздробить»
   *
   * Используется в UI чтобы:
   *   - показать счётчик в SplitControl («Раздробить: − 2 +»)
   *   - скрыть swap-стрелки если splitLevel>1 (нечего свапать одной кнопкой)
   */
  splitLevel: number
  /**
   * Можно ли увеличить splitLevel? false если в пуле не хватит уникальных
   * товаров с подходящей ценой для следующего уровня дробления.
   * UI делает кнопку «+» disabled.
   */
  canSplitMore: boolean
  /**
   * Можно ли вообще дробить позицию?
   *   - false для passthrough (нарушит ИКПУ-учёт)
   *   - true для price-bucket / multi-item
   * Если false — UI прячет SplitControl целиком.
   */
  splittable: boolean
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
  /**
   * Режим подбора. По умолчанию `'classic'` (per-position).
   *
   * - `'classic'`  — `positions[]` это правда; matchedTotalTiyin = Σ candidates.
   * - `'holistic'` — `holistic` это правда; `positions[]` сохраняется только
   *   для UI («оригинал из МС»), фискальные строки строятся из `holistic.lines`.
   *
   * Управляется в `buildMatch` на основе `SettingKey.MatcherMode`.
   */
  mode: 'classic' | 'holistic'
  /**
   * План holistic-подбора. Заполнен только когда `mode === 'holistic'`.
   *
   * Каждая `line` — одна фискальная строка чека: товар × qty × сумма.
   * Сумма plan.totalTiyin совпадает с receipt.sum (exact-sum guarantee
   * по конструкции, иначе planHolistic возвращает Reject).
   *
   * См. `src/lib/matcher/holistic.ts`.
   */
  holistic?: HolisticPlan
  /**
   * Маркер «план собран кассиром вручную через ManualReceiptModal».
   *
   * Используется в Receipt.tsx чтобы при `InventoryStaleError` НЕ перетирать
   * ручной выбор авто-подбором. Если флаг true — после sync показываем
   * кассиру конкретно какой товар закончился, но сам план не трогаем —
   * кассир сам решит что менять.
   *
   * Для авто-планов флаг отсутствует/false — `load()` пересобирает как раньше.
   */
  manuallyBuilt?: boolean
}

/**
 * Одна строка holistic-плана. Каждая → одна позиция в фискальном чеке.
 *
 * Цена `priceTiyin` это **продажная сумма за всё quantity** (как в
 * `MatchCandidate.priceTiyin`). discountTiyin может быть > 0 если в фазе 3
 * пришлось срезать остаток скидкой; vatTiyin рассчитан от `priceTiyin - discountTiyin`.
 */
export interface HolisticLine {
  esfItem: import('@/lib/db/types').EsfItemRow & { available?: MilliQty }
  /** Кол-во штук в миллидолях (1000 = 1 шт). */
  quantity: MilliQty
  /** Продажная сумма ДО скидки за всё quantity, тийины. */
  priceTiyin: Tiyin
  /** Размер скидки в тийинах (0 если без скидки). */
  discountTiyin: Tiyin
  /** НДС от (priceTiyin - discountTiyin), тийины. */
  vatTiyin: Tiyin
}

/**
 * Результат holistic-планировщика: список строк + итоговая сумма.
 *
 * `totalTiyin` = Σ (priceTiyin - discountTiyin) — это то что уйдёт в EPOS
 * как сумма к оплате. Совпадает с `receipt.sum` (exact, проверено в planHolistic).
 *
 * `totalCostTiyin` = Σ unitPrice × (1+vat/100) × qty — себестоимость с НДС.
 * Инвариант: `totalCostTiyin ≤ totalTiyin` (не в убыток).
 */
export interface HolisticPlan {
  lines: HolisticLine[]
  totalTiyin: Tiyin
  totalCostTiyin: Tiyin
  /** Информационные сообщения о том как был собран план (для UI/логов). */
  notes: string[]
}

/**
 * Режим работы matcher'а — управляется `SettingKey.MatcherMode`.
 *
 * См. документацию на `SettingKey.MatcherMode` в `src/lib/db/types.ts`.
 */
export type MatcherMode = 'auto' | 'classic' | 'holistic' | 'off'

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
  /**
   * Отдельный лимит для **надбавки** (`distributeBump`), в тийинах.
   *
   * Зачем отдельно от `maxDiscountPerItemTiyin`: скидка опасна (срезает
   * ниже расчётной, близко к себестоимости — поэтому жёсткие 2000 сум).
   * Надбавка же — это просто бо́льшая наценка на конкретную продажу,
   * юридически и экономически безопасна. На «дырявом» складе разрывы
   * 20-54к, и cap 2000 не давал закрыть сумму → подбор уходил в минус.
   *
   * По умолчанию **1 000 000 (10000 сум)**. Сумма в чек всё равно =
   * pos.totalTiyin (что заплатил клиент), так что расширение безопасно.
   */
  maxBumpPerItemTiyin?: number
  /**
   * Имя характеристики **модификации** МС, в которой бухгалтер пишет
   * связку с приходом (`esf_items.name`). По умолчанию
   * `'Бухгалтерское наименование'`. Используется в `extractPositions`
   * и `tryLinkedMsVariant`.
   */
  linkCharacteristicName?: string
  /**
   * Принудительная ставка НДС для **продаж** (в процентах).
   *
   * Если указана — `loadMatcherPool` override'ит `inv_item.vat_percent`
   * на это значение для всех товаров пула. Это значит:
   *   - расчётная продажная цена всегда = `unit_price × (1+markup/100) × (1+default_vat/100)`
   *   - НДС в фискальном чеке всегда = default_vat
   *   - VATPercent в payload Communicator всегда = default_vat
   *
   * Зачем: учётный `vat_percent` отражает ставку **поставщика** (упрощенцы = 0%).
   * Но **магазин** на общем режиме обязан продавать с НДС 12% всегда —
   * независимо от того что указал поставщик. Default = 12 в РУз.
   *
   * Если не указано (undefined) — используется `inv_item.vat_percent` как раньше
   * (legacy режим — для магазинов на упрощёнке или для тестов).
   */
  defaultVatPercent?: number
  /**
   * Режим matcher'а. По умолчанию `'auto'`:
   *   1. Запускаем classic per-position.
   *   2. Если `hasUnmatched` ИЛИ `matched ≠ target` — пытаемся holistic.
   *   3. Если holistic вернул план — используем его.
   *
   * См. `MatcherMode` и `SettingKey.MatcherMode`.
   */
  matcherMode?: MatcherMode
  /**
   * Максимальное число фискальных строк в holistic-плане. Sanity-cap
   * против чеков из 50+ строк (ОФД и кассир-лента не любят такое).
   * По умолчанию 30. Если план получается длиннее — `planHolistic`
   * вернёт `Reject(TOO_MANY_LINES)` и UI попросит manual picker.
   */
  holisticMaxLines?: number
  /**
   * Резерв (в тийинах) под филлеры в фазе 1 holistic-планировщика.
   * Жадный greedy не «съест» весь target крупными SKU — оставит этот
   * резерв для последующего exact-sum DP на мелких товарах.
   * По умолчанию 3 000 000 (30 000 сум).
   */
  holisticFillerReserveTiyin?: Tiyin
  /**
   * Граница «крупное / мелкое» для holistic-планировщика (тийины
   * за 1 шт продажной цены). Товары с `sellPrice ≤ этого значения`
   * считаются филлерами и идут в фазу 2 (DP), остальные — в фазу 1
   * (greedy крупного). По умолчанию 2 000 000 (20 000 сум).
   */
  holisticFillerThresholdTiyin?: Tiyin
  /**
   * Альтернативная таргет-сумма для подбора (в тийинах).
   *
   * Если задана — matcher работает по этой сумме вместо `receipt.sum`:
   * скейлинг позиций, holistic-fallback, distributeDiscount/Bump, проверка
   * `canAutoFiscalize` — все используют этот override.
   *
   * Зачем: магазин принимает Click/Payme отдельно от ОФД. Кассир в UI
   * вводит «Сумма через Click/Payme» = X, и matcher должен собрать чек
   * на `receipt.sum − X`. Сам `receipt.sum` мы не мутируем (это сырые
   * данные МС, используются в Refund и других местах) — а просто говорим
   * matcher'у: «делай вид что чек на сумму Y».
   *
   * Если не задана — поведение как раньше (`receipt.sum` это правда).
   */
  targetSumOverrideTiyin?: Tiyin
}
