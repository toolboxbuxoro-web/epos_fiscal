// Типы МойСклад JSON API 1.2 (https://dev.moysklad.ru/doc/api/remap/1.2/).
// Здесь только то, что нам нужно для работы с retaildemand и сопутствующими сущностями.

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
}

export interface MsAttribute {
  meta?: MsMeta
  id: string
  name: string
  type: string
  value: string | number | boolean | { name: string } | null
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

/** Парсинг даты МойСклад "YYYY-MM-DD HH:MM:SS.SSS" → epoch секунды. */
export function parseMsMoment(s: string): number {
  // Пробел между датой и временем. Trailing fractional seconds опциональны.
  const iso = s.replace(' ', 'T') + 'Z' // считаем как UTC; реально МойСклад в МСК-таймзоне
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.floor(t / 1000)
}

/** Форматирование даты для filter-параметра МойСклад: "YYYY-MM-DD HH:MM:SS.SSS". */
export function formatMsMoment(epochSec: number): string {
  const d = new Date(epochSec * 1000)
  const yyyy = d.getUTCFullYear()
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  const HH = String(d.getUTCHours()).padStart(2, '0')
  const MM = String(d.getUTCMinutes()).padStart(2, '0')
  const SS = String(d.getUTCSeconds()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}.000`
}
