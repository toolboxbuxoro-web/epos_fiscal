// Типы МойСклад JSON API 1.2 (https://dev.moysklad.ru/doc/api/remap/1.2/).
// Здесь только то, что нам нужно для работы с retaildemand и сопутствующими сущностями.

// ── Auth ─────────────────────────────────────────────────────────

export interface MsTokenResponse {
  access_token: string
}

// ── Сотрудники / точки продаж ───────────────────────────────────

export interface MsRetailStore {
  meta: MsMeta
  id: string
  accountId: string
  name: string
  address?: string
  archived?: boolean
  active?: boolean
  cashiers?: MsRef
  organization?: MsRef
}

export interface MsEmployee {
  meta: MsMeta
  id: string
  accountId: string
  name: string
  email?: string
  fullName?: string
  shortFio?: string
  archived?: boolean
}

export interface MsMeta {
  href: string
  metadataHref?: string
  type: string
  mediaType?: string
  uuidHref?: string
}

export interface MsRef {
  meta: MsMeta
}

// ── Розничная смена (retailshift) ───────────────────────────────
//
// МС-смены: точка открывает смену → пробивает чеки → закрывает.
// `closeDate=null` ⇒ смена активна. У `retaildemand` всегда есть
// `retailShift` (meta-ссылка на смену в которой пробит).
export interface MsRetailShift {
  meta: MsMeta
  id: string
  accountId: string
  name?: string
  /** Когда открыта (ISO с миллисекундами в UTC). */
  created: string
  /** Когда закрыта. null/undefined = активна. */
  closeDate?: string | null
  /** Сводные суммы — могут быть полезны для UI. */
  proceedsCash?: number
  proceedsNoCash?: number
  retailStore?: MsRef
  organization?: MsRef
  store?: MsRef
}

export interface MsListResponse<T> {
  context?: { employee?: { meta: MsMeta } }
  meta: {
    href: string
    type: string
    mediaType: string
    size: number
    limit: number
    offset: number
    nextHref?: string
    previousHref?: string
  }
  rows: T[]
}

// ── retaildemand ─────────────────────────────────────────────────

/** Розничная продажа (пробитый чек). */
export interface MsRetailDemand {
  meta: MsMeta
  id: string
  accountId: string
  syncId?: string
  updated: string // "YYYY-MM-DD HH:MM:SS.SSS"
  name: string
  moment: string // "YYYY-MM-DD HH:MM:SS.SSS"
  applicable: boolean
  printed: boolean
  published: boolean
  rate: { currency: MsRef; value?: number }
  /** Сумма документа в копейках/тийинах (минимальной денежной единице). */
  sum: number
  vatSum: number
  vatEnabled: boolean
  vatIncluded: boolean
  cashSum?: number
  noCashSum?: number
  qrSum?: number
  retailShift: MsRef
  retailStore: MsRef
  organization: MsRef
  agent: MsRef
  store?: MsRef
  group?: MsRef
  owner?: MsRef
  shared?: boolean
  /** Позиции чека. Доступны через expand=positions. */
  positions: MsRef | { meta: MsMeta; rows: MsRetailDemandPosition[] }
  fiscalPrintInfo?: {
    fiscalDocSign?: string
    fiscalDocNumber?: string
    fnNumber?: string
    kktRegNumber?: string
    time?: string
  }
  attributes?: MsAttribute[]
}

export interface MsRetailDemandPosition {
  meta: MsMeta
  id: string
  accountId: string
  /** Кол-во в штуках/кг, дробное (1 = 1 шт, 2.5 = 2.5 кг). */
  quantity: number
  /** Цена единицы в тийинах. */
  price: number
  /** Скидка позиции в процентах (0..100). */
  discount: number
  /** Ставка НДС, %. 0 если нет НДС. */
  vat: number
  vatEnabled: boolean
  /** Ссылка на товар или модификацию. Через expand=positions.assortment получаем сам товар. */
  assortment: MsRef | MsAssortment
  /** Маркировки (для марк-тов). */
  things?: string[]
}

export interface MsAssortment {
  meta: MsMeta
  id: string
  name: string
  code?: string
  article?: string
  externalCode?: string
  description?: string
  barcodes?: Array<{ ean13?: string; ean8?: string; code128?: string; gtin?: string; upc?: string }>
  uom?: MsRef
  /** Кастомные атрибуты — там часто хранят ИКПУ. */
  attributes?: MsAttribute[]
  /**
   * Характеристики **модификации** (только если `meta.type === 'variant'`).
   * Бухгалтер записывает «Бухгалтерское наименование» как характеристику —
   * Tauri читает её и связывает позицию МС с конкретным приходом в `esf_items`.
   * См. `matcher/strategies.ts::tryLinkedMsVariant`.
   */
  characteristics?: Array<{ id: string; name: string; value: string }>
}

export interface MsAttribute {
  meta?: MsMeta
  id: string
  name: string
  type: string
  value: string | number | boolean | { name: string } | null
}

/**
 * Модификация товара (variant).
 *
 * Получается через `GET /entity/variant?filter=productid=<id>`.
 * Используется в matcher для подтягивания characteristics когда в чеке
 * пришёл базовый товар, а связку с приходом бухгалтер положил
 * в характеристику модификации.
 */
export interface MsVariant {
  meta: MsMeta
  id: string
  name: string
  code?: string
  externalCode?: string
  characteristics?: Array<{ id: string; name: string; value: string }>
}

// ── helpers ─────────────────────────────────────────────────────

/** Получить inline-позиции, если они expand-нуты. */
export function inlinePositions(
  rd: MsRetailDemand,
): MsRetailDemandPosition[] | null {
  if (rd.positions && 'rows' in rd.positions) {
    return rd.positions.rows
  }
  return null
}

/** Получить inline-assortment у позиции. */
export function inlineAssortment(
  pos: MsRetailDemandPosition,
): MsAssortment | null {
  const a = pos.assortment as Partial<MsAssortment> & MsRef
  if ('id' in a && 'name' in a) return a as MsAssortment
  return null
}

/**
 * Обогатить чек МС характеристиками модификаций.
 *
 * Сценарий: бухгалтер создал у товара модификацию с характеристикой
 * «Бухгалтерское наименование», но кассир в МС пробил **базовый товар**,
 * а не модификацию. В чеке `assortment.meta.type === 'product'`, без
 * characteristics → matcher не находит связку.
 *
 * Эта функция:
 *   1. Находит все product-позиции без characteristics
 *   2. Параллельно тянет модификации для каждого через `GET /entity/variant`
 *   3. Если у товара РОВНО ОДНА модификация — копирует её characteristics
 *      в `assortment.characteristics` (мутация inline)
 *   4. Если 0 или >1 модификаций — пропускает (нельзя угадать какую)
 *
 * Результат: matcher видит characteristics даже когда чек на product.
 * Бухгалтер заполняет связку 1 раз в модификации, кассир продаёт как
 * обычно. Самый удобный path of use.
 *
 * @param rd чек МС (мутируется inline — добавляются characteristics)
 * @param fetchVariants функция тянущая модификации по productId
 *   (передаётся `client.listVariantsByProduct` чтобы не плодить deps)
 */
export async function enrichWithVariants(
  rd: MsRetailDemand,
  fetchVariants: (productId: string) => Promise<MsVariant[]>,
): Promise<{ enrichedCount: number; productsChecked: number }> {
  const positions = inlinePositions(rd)
  if (!positions) return { enrichedCount: 0, productsChecked: 0 }

  const productIds = new Set<string>()
  for (const pos of positions) {
    const a = inlineAssortment(pos)
    if (!a) continue
    if (a.meta?.type !== 'product') continue
    if (a.characteristics && a.characteristics.length > 0) continue
    productIds.add(a.id)
  }

  if (productIds.size === 0) {
    return { enrichedCount: 0, productsChecked: 0 }
  }

  // Параллельно тянем модификации каждого товара
  const productToVariants = new Map<string, MsVariant[]>()
  await Promise.all(
    [...productIds].map(async (productId) => {
      try {
        const variants = await fetchVariants(productId)
        productToVariants.set(productId, variants)
      } catch {
        // Сетевая ошибка — пропускаем, fallback на passthrough
      }
    }),
  )

  // Применяем: если у товара ровно 1 модификация — переносим её
  // characteristics в product.characteristics (matcher будет читать)
  let enrichedCount = 0
  for (const pos of positions) {
    const a = inlineAssortment(pos)
    if (!a || a.meta?.type !== 'product') continue
    const variants = productToVariants.get(a.id)
    if (!variants || variants.length !== 1) continue
    const v = variants[0]
    if (!v?.characteristics || v.characteristics.length === 0) continue
    a.characteristics = v.characteristics
    enrichedCount++
  }

  return { enrichedCount, productsChecked: productIds.size }
}

/**
 * Парсинг даты МойСклад "YYYY-MM-DD HH:MM:SS.SSS" → epoch секунды.
 *
 * МойСклад API ВСЕГДА возвращает время в МСК (UTC+3) без указания таймзоны.
 * Поэтому добавляем явный offset `+03:00`, иначе при отображении на машинах
 * с другим часовым поясом (Узбекистан UTC+5, например) получится сдвиг.
 *
 * Документация: https://dev.moysklad.ru/doc/api/remap/1.2/#mojsklad-json-api-obschie-svedeniq-format-daty-i-vremeni
 */
export function parseMsMoment(s: string): number {
  // Пробел между датой и временем. Trailing fractional seconds опциональны.
  const iso = s.replace(' ', 'T') + '+03:00'
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.floor(t / 1000)
}

/**
 * Форматирование даты для filter-параметра МойСклад: "YYYY-MM-DD HH:MM:SS.SSS".
 *
 * МС интерпретирует filter-параметр как МСК-время. Поэтому при формировании
 * курсора `updated>...` берём UTC-эпоху, прибавляем 3 часа и форматируем
 * как «MSK без таймзоны» — это то что МС ожидает на стороне filter'а.
 */
export function formatMsMoment(epochSec: number): string {
  // +3 часа к UTC чтобы получить MSK-time для фильтра
  const d = new Date((epochSec + 3 * 3600) * 1000)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const HH = String(d.getUTCHours()).padStart(2, '0')
  const MM = String(d.getUTCMinutes()).padStart(2, '0')
  const SS = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}.000`
}
