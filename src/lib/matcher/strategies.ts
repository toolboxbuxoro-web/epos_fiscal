import { listEsfItems, type EsfItemWithAvailable } from '@/lib/db'
import type {
  MatchCandidate,
  MatcherOptions,
  NormalizedPosition,
  PositionMatch,
} from './types'
import type { Tiyin } from '@/lib/db/types'

/** НДС из суммы с включённой ставкой: vat = total * percent / (100+percent). */
export function vatIncluded(totalTiyin: Tiyin, vatPercent: number): Tiyin {
  if (vatPercent <= 0) return 0
  return Math.round((totalTiyin * vatPercent) / (100 + vatPercent))
}

/** НДС начисленный сверху: vat = total * percent / 100. */
export function vatAddedOn(netTiyin: Tiyin, vatPercent: number): Tiyin {
  if (vatPercent <= 0) return 0
  return Math.round((netTiyin * vatPercent) / 100)
}

/**
 * Рассчитать продажную цену из приходной.
 *
 * Формула: round_up( unit_price × (1 + markup/100) × (1 + vat/100), step ).
 *
 *   1. К приходной цене добавляется наценка (markupPercent, по умолчанию 10%).
 *   2. К результату начисляется НДС товара (item.vat_percent — обычно 12%).
 *   3. Сумма округляется ВВЕРХ до шага roundUpToSum (в сумах, по умолчанию 1000).
 *
 * Пример: приход 595 928 тийинов (5 959.28 сум), наценка 10%, НДС 12%, шаг 1000:
 *   5959.28 × 1.10 × 1.12 = 7 341.63 сум  →  округление вверх до 1000  →  8000 сум
 */
export function calculateSellingPrice(
  unitPriceTiyin: Tiyin,
  vatPercent: number,
  markupPercent: number,
  roundUpToSum: number,
): Tiyin {
  if (unitPriceTiyin <= 0) return 0
  const withMarkup = (unitPriceTiyin * (100 + markupPercent)) / 100
  const withVat = (withMarkup * (100 + Math.max(0, vatPercent))) / 100
  const stepTiyin = Math.max(1, roundUpToSum) * 100
  return Math.ceil(withVat / stepTiyin) * stepTiyin
}

/** Общие дефолты ценообразования. */
const DEFAULT_MARKUP = 10
const DEFAULT_ROUND_UP_SUM = 1000

/**
 * Пул товаров с предрасчитанными продажными ценами.
 *
 * Загружается ОДИН РАЗ на чек в buildMatch и передаётся во все стратегии.
 * Раньше каждая стратегия для каждой позиции делала свой listEsfItems
 * с лимитом 5000 — на чеке из 5 позиций это 50000 строк через TS↔SQLite
 * мост, что давало заметные лаги UI.
 */
export interface MatcherPool {
  /** Все доступные товары (qty_received - qty_consumed >= 1000) с кэшем sellingPrice. */
  items: PoolItem[]
  /** Минимальная цена в пуле — для подсказок «нечем набрать по multi-item». */
  minSellingPrice: Tiyin
}

export interface PoolItem {
  item: EsfItemWithAvailable
  sellingPrice: Tiyin
}

/**
 * Загрузить пул и предрасчитать продажные цены. Один запрос в БД,
 * один проход для расчёта sellingPrice. Результат переиспользуется
 * во всех трёх стратегиях для всех позиций чека.
 */
export async function loadMatcherPool(opts: MatcherOptions = {}): Promise<MatcherPool> {
  // source='remote' — только товары синкнутые из mytoolbox (актуальный склад).
  // Это предотвращает «призраков» из legacy-excel импортов: исторически
  // программа умела импортировать Excel прямо в локальную DB; после миграции
  // на remote-only архитектуру (0.10+) эти записи могут содержать товары,
  // которых уже нет в фактическом учёте, но они засоряли подбор.
  const rawAll = await listEsfItems({
    minAvailable: 1000,
    limit: 5000,
    source: 'remote',
  })
  // Исключаем server_item_id'ы которые сервер только что отказал — даже
  // если локальный кэш ещё «думает» что они доступны (SSE не догнал).
  // Без этого retry после 409 сразу попадает в тот же конфликт.
  const excludeSet =
    opts.excludeServerItemIds && opts.excludeServerItemIds.length > 0
      ? new Set(opts.excludeServerItemIds)
      : null
  const raw = excludeSet
    ? rawAll.filter((i) => i.server_item_id == null || !excludeSet.has(i.server_item_id))
    : rawAll
  const markup = opts.markupPercent ?? DEFAULT_MARKUP
  const roundUp = opts.roundUpToSum ?? DEFAULT_ROUND_UP_SUM
  let minSellingPrice = Number.POSITIVE_INFINITY
  const items: PoolItem[] = raw.map((item) => {
    const sellingPrice = calculateSellingPrice(
      item.unit_price_tiyin,
      item.vat_percent,
      markup,
      roundUp,
    )
    if (sellingPrice > 0 && sellingPrice < minSellingPrice) {
      minSellingPrice = sellingPrice
    }
    return { item, sellingPrice }
  })
  return {
    items,
    minSellingPrice: Number.isFinite(minSellingPrice) ? minSellingPrice : 0,
  }
}

/**
 * Стратегия 1: passthrough.
 *
 * Если позиция содержит валидный ИКПУ, который есть в нашем справочнике
 * с достаточными остатками — фискализируем «как есть» через найденный esf_item.
 * Цена в фискальном чеке — продажная (с наценкой и НДС).
 */
export function tryPassthrough(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция (бесплатный товар по акции / бонусами) — не подбираем.
  // Иначе для pos.totalTiyin=0 matcher может подобрать дешёвые товары через
  // tolerance — это неправильно, нулевая позиция не должна занимать место в чеке.
  if (pos.totalTiyin <= 0) return null
  if (!pos.classCode) return null

  const strictVat = opts.vatStrict === true
  const candidates = pool.items.filter(
    (p) =>
      p.item.class_code === pos.classCode &&
      p.item.qty_received - p.item.qty_consumed >= pos.quantity &&
      (!strictVat || p.item.vat_percent === pos.vatPercent),
  )

  if (candidates.length === 0) return null

  // FIFO — самый старый приход.
  const chosen = [...candidates].sort(
    (a, b) => a.item.received_at - b.item.received_at,
  )[0]
  if (!chosen) return null

  const totalSelling = chosen.sellingPrice * (pos.quantity / 1000)
  const candidate = makeCandidate(chosen.item, pos.quantity, totalSelling)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'passthrough',
    diffTiyin: totalSelling - pos.totalTiyin,
    warnings: [],
    swappable: false, // ИКПУ менять нельзя, даже если есть товары с такой же ценой
    alternatives: [],
    selectedAlternativeIndex: -1,
    splitLevel: 1,
    canSplitMore: false,
    splittable: false, // passthrough = ИКПУ совпадает, дробление нарушит учёт
  }
}

/**
 * Стратегия 2: price-bucket.
 *
 * Найти один товар, у которого РАСЧЁТНАЯ продажная цена близка к сумме
 * позиции из чека МойСклад (в пределах `toleranceTiyin`). Берём 1 шт.
 *
 * **Записываем в чек `pos.totalTiyin`, а не `best.sellingPrice`** — потому что
 * покупатель реально заплатил за эту позицию `pos.totalTiyin`, и фискальный
 * чек должен отразить именно эту сумму. Расчётная цена `sellingPrice`
 * (вычисленная из приходной с наценкой и НДС) использовалась ТОЛЬКО для
 * проверки «адекватности» замены. Если `pos.totalTiyin` чуть выше
 * `sellingPrice` — это просто означает чуть бо́льшую наценку на эту продажу
 * (что нормально и допустимо).
 *
 * Это убирает систематический микро-минус по сумме чека, когда замена
 * нашлась с ценой на 500–1000 сум ниже позиции.
 */
export function tryPriceBucket(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция — не подбираем, см. tryPassthrough.
  if (pos.totalTiyin <= 0) return null
  const tolerance = opts.toleranceTiyin ?? 0
  const strictVat = opts.vatStrict === true

  // Свапу даём БОЛЬШИЙ tolerance чем основному match'у:
  //
  //   - matchTolerance — используется для проверки «хороший ли это match»
  //     (best должен быть в этом радиусе). По дефолту 100k тийинов = 1000 сум.
  //   - swapTolerance — радиус для поиска альтернатив. По дефолту 500k
  //     тийинов = 5000 сум. Даёт кассиру нормальный выбор (обычно 4-10
  //     товаров), а разницу в цене покрывает distributeDiscount/Bump
  //     с расширенным лимитом (см. recalculateAfterSwap, где opts
  //     получают maxDiscountPerItemTiyin = swapTolerance).
  //
  // Ниже мы сначала проверяем что best есть (matchTolerance), а потом
  // расширяем зону поиска до swapTolerance чтобы UI было что показывать.
  const matchTolerance = tolerance
  const SWAP_TOLERANCE_DEFAULT = 500_000 // 5000 сум
  const swapTolerance = Math.max(matchTolerance, SWAP_TOLERANCE_DEFAULT)

  // Собираем ВСЕХ кандидатов в пределах swapTolerance, отсортированных
  // по близости к target — первый = best.
  const inRange: { item: EsfItemWithAvailable; sellingPrice: Tiyin; diff: number }[] = []
  for (const p of pool.items) {
    if (strictVat && p.item.vat_percent !== pos.vatPercent) continue
    const diff = Math.abs(p.sellingPrice - pos.totalTiyin)
    if (diff > swapTolerance) continue
    inRange.push({ item: p.item, sellingPrice: p.sellingPrice, diff })
  }
  if (inRange.length === 0) return null

  inRange.sort((a, b) => a.diff - b.diff)
  const best = inRange[0]!

  // Best должен быть в пределах ОСНОВНОГО tolerance — иначе price-bucket
  // вообще не подходит, лучше провалиться в multi-item стратегию.
  if (best.diff > matchTolerance) return null

  // Цена в чеке = pos.totalTiyin (что покупатель заплатил).
  // best.sellingPrice (расчётная) использовалась только для матчинга.
  const bestCandidate = makeCandidate(best.item, 1000, pos.totalTiyin)

  // Топ-N альтернатив (включая best) для UI swap. Limit 10 — баланс
  // между «достаточно выбора» и «UI не тормозит при рендере списка».
  const ALT_LIMIT = 10
  const alternatives: MatchCandidate[] = inRange
    .slice(0, ALT_LIMIT)
    .map((alt) => makeCandidate(alt.item, 1000, pos.totalTiyin))

  return {
    source: pos,
    candidates: [bestCandidate],
    strategy: 'price-bucket',
    diffTiyin: 0,
    warnings: pos.classCode
      ? [`ИКПУ заменён: ${pos.classCode} → ${best.item.class_code}`]
      : [`Без ИКПУ в исходной позиции, заменён на ${best.item.class_code}`],
    swappable: alternatives.length > 1,
    alternatives,
    selectedAlternativeIndex: 0,
    splitLevel: 1,
    // canSplitMore вычисляется в `enrichSplitInfo` после построения, потому что
    // зависит от состояния пула после всех других позиций.
    canSplitMore: canSplitToLevel(pos, pool, opts, 2),
    splittable: true,
  }
}

/**
 * Стратегия 3: multi-item (greedy knapsack).
 *
 * Набираем несколько товаров суммарно на нужную сумму (с допуском).
 * Жадный алгоритм по убыванию ПРОДАЖНОЙ цены.
 */
export function tryMultiItem(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  // Нулевая позиция — не подбираем, см. tryPassthrough.
  if (pos.totalTiyin <= 0) return null
  const tolerance = opts.toleranceTiyin ?? 0
  const maxItems = opts.maxMultiItem ?? 5
  const strictVat = opts.vatStrict === true

  const filtered = strictVat
    ? pool.items.filter((p) => p.item.vat_percent === pos.vatPercent)
    : pool.items
  if (filtered.length === 0) return null

  // Сортируем по убыванию ПРОДАЖНОЙ цены (без копирования если можно).
  const sorted = [...filtered].sort((a, b) => b.sellingPrice - a.sellingPrice)

  const picks: { item: EsfItemWithAvailable; quantity: number; sellingPrice: Tiyin }[] = []
  let remaining = pos.totalTiyin

  for (const { item, sellingPrice } of sorted) {
    if (picks.length >= maxItems) break
    if (remaining <= 0) break
    if (sellingPrice <= 0) continue
    if (sellingPrice > remaining + tolerance) continue

    const fitsByPrice = Math.floor(remaining / sellingPrice)
    const fitsByStock = Math.floor(item.available / 1000)
    const qty = Math.min(fitsByPrice, fitsByStock)
    if (qty <= 0) continue

    picks.push({ item, quantity: qty, sellingPrice })
    remaining -= qty * sellingPrice
  }

  if (picks.length === 0) return null
  if (Math.abs(remaining) > tolerance) return null

  const candidates: MatchCandidate[] = picks.map(({ item, quantity, sellingPrice }) => {
    const totalSelling = sellingPrice * quantity
    return makeCandidate(item, quantity * 1000, totalSelling)
  })

  const matchedSum = candidates.reduce((s, c) => s + c.priceTiyin, 0)
  const diffTiyin = matchedSum - pos.totalTiyin

  return {
    source: pos,
    candidates,
    strategy: 'multi-item',
    diffTiyin,
    warnings: [`Подобрано ${picks.length} позиций вместо одной`],
    swappable: false, // MVP: для multi-item swap пока не реализован (Phase 2)
    alternatives: [],
    selectedAlternativeIndex: -1,
    splitLevel: picks.length,
    canSplitMore: canSplitToLevel(pos, pool, opts, picks.length + 1),
    splittable: true,
  }
}

/**
 * Принудительно подобрать РОВНО N товаров суммарно на `pos.totalTiyin`.
 *
 * Используется UI кнопкой «Раздробить»: кассир видит один товар на 99 000 сум,
 * жмёт «+» — программа подбирает 2 товара на ту же сумму, ещё «+» — 3 и т.д.
 *
 * Алгоритм:
 *   1. targetAvg = pos.totalTiyin / N — целевая средняя цена за единицу
 *   2. Сортируем пул по близости sellingPrice к targetAvg
 *   3. Жадно берём первые N с qty=1 шт каждый, проверяя stock
 *   4. Если набралось < N — возвращает null (UI отрубит «+»)
 *   5. Сумма обычно ≠ pos.totalTiyin → выравнивается через
 *      distributeDiscount/Bump (вне этой функции, в rebuildPositionWithSplit).
 *
 * Берём 1 шт каждого товара, не суммарное N×qty — чтобы дробить было
 * максимально предсказуемо (1 клик = +1 строка в чеке).
 */
export function tryMultiItemForce(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions,
  forceItemCount: number,
): PositionMatch | null {
  if (pos.totalTiyin <= 0) return null
  if (forceItemCount < 2) return null
  const strictVat = opts.vatStrict === true
  const targetAvg = Math.floor(pos.totalTiyin / forceItemCount)

  // Фильтр по НДС если strict + только товары с qty >= 1 шт.
  const candidatesPool = pool.items.filter(
    (p) =>
      (!strictVat || p.item.vat_percent === pos.vatPercent) &&
      p.sellingPrice > 0 &&
      Math.floor(p.item.available / 1000) >= 1,
  )

  // Сортируем по близости к target_avg.
  const sorted = [...candidatesPool].sort(
    (a, b) =>
      Math.abs(a.sellingPrice - targetAvg) - Math.abs(b.sellingPrice - targetAvg),
  )

  // Берём первые N уникальных (одна позиция = один товар, не дублируем).
  const picks: { item: EsfItemWithAvailable; sellingPrice: Tiyin }[] = []
  const usedIds = new Set<number>()
  for (const p of sorted) {
    if (picks.length >= forceItemCount) break
    if (usedIds.has(p.item.id)) continue
    picks.push({ item: p.item, sellingPrice: p.sellingPrice })
    usedIds.add(p.item.id)
  }
  if (picks.length < forceItemCount) return null

  // Сумма sellingPrice обычно не равна pos.totalTiyin — distributeBump/Discount
  // выровняет в rebuildPositionWithSplit. Но мы пишем в priceTiyin именно
  // sellingPrice (без претензии на точное совпадение) — distribute сделает
  // финальную коррекцию через priceTiyin/discountTiyin.
  const candidates: MatchCandidate[] = picks.map(({ item, sellingPrice }) =>
    makeCandidate(item, 1000, sellingPrice),
  )
  const matchedSum = candidates.reduce((s, c) => s + c.priceTiyin, 0)

  return {
    source: pos,
    candidates,
    strategy: 'multi-item',
    diffTiyin: matchedSum - pos.totalTiyin,
    warnings: [`Раздроблено на ${forceItemCount} товаров`],
    swappable: false,
    alternatives: [],
    selectedAlternativeIndex: -1,
    splitLevel: forceItemCount,
    canSplitMore: canSplitToLevel(pos, pool, opts, forceItemCount + 1),
    splittable: true,
  }
}

/**
 * Проверить можно ли в этом пуле подобрать N разных товаров на сумму
 * `pos.totalTiyin`. Используется для UI флага `canSplitMore`.
 *
 * Логика: считаем сколько товаров в пуле имеют sellingPrice близкую
 * к `targetAvg = totalTiyin / N` (в радиусе toleranceTiyin × N для гибкости).
 * Если их >= N — `true`.
 *
 * Дешёвый O(items) проход без сортировок и аллокаций — годится для вызова
 * на каждую позицию каждого чека.
 */
export function canSplitToLevel(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions,
  N: number,
): boolean {
  if (N < 2) return false
  if (pos.totalTiyin <= 0) return false
  const targetAvg = Math.floor(pos.totalTiyin / N)
  // Радиус расширяем пропорционально N — чем больше частей, тем больше
  // допустимая средняя погрешность по каждой (распределение скомпенсирует).
  const radius = Math.max(opts.toleranceTiyin ?? 100_000, 200_000) * N
  const strictVat = opts.vatStrict === true
  let cnt = 0
  for (const p of pool.items) {
    if (strictVat && p.item.vat_percent !== pos.vatPercent) continue
    if (Math.floor(p.item.available / 1000) < 1) continue
    if (Math.abs(p.sellingPrice - targetAvg) > radius) continue
    cnt++
    if (cnt >= N) return true
  }
  return false
}

/**
 * Собрать MatchCandidate.
 *
 * `priceTiyin` — продажная сумма за всё quantity (без скидки).
 * `discountTiyin = 0` по умолчанию — скидка распределяется потом
 * в distributeDiscount() если включено.
 * `vatTiyin` — НДС, рассчитанный от priceTiyin (т.е. без учёта скидки;
 * после распределения скидок vatTiyin будет пересчитан).
 */
function makeCandidate(
  item: EsfItemWithAvailable,
  quantity: number,
  sellingTotalTiyin: Tiyin,
): MatchCandidate {
  const vat = vatIncluded(sellingTotalTiyin, item.vat_percent)
  return {
    esfItem: item,
    quantity,
    priceTiyin: sellingTotalTiyin,
    discountTiyin: 0,
    vatTiyin: vat,
  }
}

/**
 * Себестоимость с НДС для всей позиции (за `quantity` единиц).
 * Это пол скидки: `discount` не может опустить (price - discount) ниже этой
 * суммы — иначе продажа в убыток. НДС применяется ПРАВИЛЬНО (последовательно,
 * не суммой 22%): unit_price × (1 + vat/100).
 *
 * Используется в distributeDiscount.
 */
export function costWithVat(
  unitPriceTiyin: Tiyin,
  vatPercent: number,
  quantityMilli: number,
): Tiyin {
  if (unitPriceTiyin <= 0) return 0
  const unitWithVat = (unitPriceTiyin * (100 + Math.max(0, vatPercent))) / 100
  return Math.round((unitWithVat * quantityMilli) / 1000)
}
