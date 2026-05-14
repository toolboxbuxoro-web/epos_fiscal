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

// ── Smart-search helpers для linked-ms ──────────────────────────────────

/**
 * Нормализация для сравнения имён:
 *   - lowercase
 *   - ё → е
 *   - множественные пробелы → один пробел
 *   - trim
 *
 * НЕ удаляем знаки препинания — они часто различают модели
 * («HR-2470» vs «HR 2470» — отличаются только дефисом, но это та же модель,
 * а вот «ТЭПК-3000K» vs «ТЭПК-3000» — разные). Поэтому только
 * пробельная нормализация.
 */
function normalizeForLink(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/**
 * Значимые токены имени (для fuzzy fallback):
 *   - длина >= 3
 *   - либо буква+цифра (model: HR2641, ARC-200)
 *   - либо просто слово >= 4 букв (тип товара: «перфоратор», «дрель»)
 *
 * Игнорируем bare 4-digit numbers (типа «400г», «2000вт») — это спецификации,
 * а не идентификаторы.
 */
function meaningfulTokens(name: string): string[] {
  const lower = normalizeForLink(name)
  const tokens = new Set<string>()
  // Model-tokens: смешение букв и цифр, длина >=4
  const reModel = /[a-zа-я]+[-]?\d+[a-zа-я\d-]*|\d+[-]?[a-zа-я]+[a-zа-я\d-]*/gi
  let m: RegExpExecArray | null
  while ((m = reModel.exec(lower)) !== null) {
    const t = m[0].replace(/[^a-zа-я\d-]/g, '')
    if (t.length >= 4) tokens.add(t)
  }
  // Type-words: чисто буквенные >= 4 символа
  const reWord = /[а-яa-z]{4,}/gi
  while ((m = reWord.exec(lower)) !== null) {
    tokens.add(m[0])
  }
  return [...tokens]
}

/**
 * Найти в пуле приходов inv_item чьё имя соответствует `linkedBuhName`.
 *
 * Стратегия (от самого надёжного к мягкому):
 *   1. **Exact** — нормализованные имена совпадают полностью.
 *   2. **Substring** — одно имя содержится в другом (бух мог написать
 *      сокращённое имя).
 *   3. **Token-fuzzy** — ≥50% значимых токенов совпали И ≥1 model-token.
 *
 * Возвращает массив подходящих pool-items, отсортированных по убыванию
 * качества совпадения. Caller потом фильтрует по остатку и делает FIFO.
 */
function findLinkedCandidates(
  buhName: string,
  pool: MatcherPool,
): PoolItem[] {
  const target = normalizeForLink(buhName)
  if (!target) return []

  // 1. Exact match
  const exact = pool.items.filter(
    (p) => normalizeForLink(p.item.name) === target,
  )
  if (exact.length > 0) return exact

  // 2. Substring match (любая сторона содержит другую)
  const substr = pool.items.filter((p) => {
    const inv = normalizeForLink(p.item.name)
    return inv.includes(target) || target.includes(inv)
  })
  if (substr.length > 0) return substr

  // 3. Token-based fuzzy: ≥50% совпадение И есть model-token
  const targetTokens = new Set(meaningfulTokens(buhName))
  if (targetTokens.size === 0) return []

  const scored = pool.items
    .map((p) => {
      const itemTokens = meaningfulTokens(p.item.name)
      const overlap = itemTokens.filter((t) => targetTokens.has(t))
      const hasModelToken = overlap.some(
        (t) => /\d/.test(t) && /[a-zа-я]/i.test(t) && t.replace(/\D/g, '').length >= 2,
      )
      return { p, score: overlap.length, hasModelToken }
    })
    .filter((s) => {
      const minOverlap = Math.max(2, Math.floor(targetTokens.size * 0.5))
      return s.score >= minOverlap && s.hasModelToken
    })
    .sort((a, b) => b.score - a.score)
    .map((s) => s.p)

  return scored
}

/**
 * Стратегия 0 (приоритет 1): linked-ms.
 *
 * Бухгалтер в МС у товара создаёт **модификацию** и в характеристике
 * (`SettingKey.MsLinkCharacteristicName`, default «Бухгалтерское наименование»)
 * записывает имя как в нашей `esf_items`. Tauri читает это значение и через
 * smart-search находит конкретный приход.
 *
 * Ключевая фишка: **цена в фискальном чеке = цена из чека МС** (`pos.totalTiyin`),
 * НЕ пересчитывается через markup×VAT. Это «реальная закупка с реальной маржой».
 *
 * Возвращает null если:
 *   - в позиции нет `linkedBuhName` (товар без модификации/характеристики)
 *   - smart-search не нашёл inv_item с этим именем
 *   - найдено, но нет остатка (qty_received - consumed < pos.quantity)
 *
 * В fallback кейсах matcher пойдёт дальше по pipeline: passthrough → price-bucket.
 */
export function tryLinkedMsVariant(
  pos: NormalizedPosition,
  pool: MatcherPool,
  opts: MatcherOptions = {},
): PositionMatch | null {
  void opts
  if (pos.totalTiyin <= 0) return null
  if (!pos.linkedBuhName) return null

  // Находим всех кандидатов в пуле по имени
  const candidates = findLinkedCandidates(pos.linkedBuhName, pool)
  if (candidates.length === 0) return null

  // Фильтруем по остатку: должно хватить на нашу quantity
  const withStock = candidates.filter(
    (p) => p.item.qty_received - p.item.qty_consumed >= pos.quantity,
  )
  if (withStock.length === 0) return null

  // FIFO — самый старый приход
  const chosen = [...withStock].sort(
    (a, b) => a.item.received_at - b.item.received_at,
  )[0]
  if (!chosen) return null

  // ВАЖНО: цена 1-в-1 как в чеке МС (не пересчитываем sellingPrice)
  const candidate = makeCandidate(chosen.item, pos.quantity, pos.totalTiyin)

  return {
    source: pos,
    candidates: [candidate],
    strategy: 'linked-ms',
    diffTiyin: 0, // цена та же что и в МС — разницы нет
    warnings: [],
    swappable: false, // связь явная — нет смысла менять
    alternatives: [],
    selectedAlternativeIndex: -1,
    splitLevel: 1,
    canSplitMore: false,
    splittable: false,
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
