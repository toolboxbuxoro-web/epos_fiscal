import {
  inlineAssortment,
  inlinePositions,
  type MsAssortment,
  type MsAttribute,
  type MsRetailDemand,
  type MsRetailDemandPosition,
} from '@/lib/moysklad/types'
import type { NormalizedPosition } from './types'

/** Имена атрибутов МойСклад, в которых обычно хранят ИКПУ. */
const ICPU_ATTR_NAMES = ['икпу', 'ikpu', 'classcode', 'class_code', 'icpu']
const PACKAGE_ATTR_NAMES = [
  'упаковка',
  'код упаковки',
  'package',
  'packagecode',
  'package_code',
]

function readAttr(attrs: MsAttribute[] | undefined, names: string[]): string | null {
  if (!attrs) return null
  for (const a of attrs) {
    const lower = a.name.toLowerCase().trim()
    if (!names.some((n) => lower.includes(n))) continue
    if (typeof a.value === 'string') return a.value || null
    if (typeof a.value === 'number') return String(a.value)
    if (a.value && typeof a.value === 'object' && 'name' in a.value) return a.value.name
  }
  return null
}

function pickBarcode(a: MsAssortment): string | null {
  const codes = a.barcodes ?? []
  for (const code of codes) {
    if (code.ean13) return code.ean13
    if (code.ean8) return code.ean8
    if (code.gtin) return code.gtin
    if (code.code128) return code.code128
    if (code.upc) return code.upc
  }
  return null
}

/**
 * Прочитать значение характеристики модификации МС по имени.
 *
 * Используется для извлечения «Бухгалтерское наименование» — связки между
 * МС-товаром и приходом в `esf_items`. Имя характеристики настраивается
 * через `SettingKey.MsLinkCharacteristicName` (default «Бухгалтерское наименование»).
 *
 * Substring match + case-insensitive — бухгалтер может назвать чуть по-разному
 * («Бухгалтерское имя» / «Имя в бухгалтерии»), главное — содержит ключевое
 * слово.
 */
function readLinkedBuhName(
  characteristics: MsAssortment['characteristics'],
  searchName: string,
): string | null {
  if (!characteristics || characteristics.length === 0) return null
  const lookup = searchName.toLowerCase().trim()
  for (const c of characteristics) {
    if (!c.name) continue
    const cName = c.name.toLowerCase().trim()
    if (cName === lookup || cName.includes(lookup)) {
      const v = c.value
      if (v == null) return null
      const s = String(v).trim()
      return s || null
    }
  }
  return null
}

/**
 * Преобразовать одну позицию retaildemand в нашу нормализованную форму.
 * Извлекает ИКПУ из атрибутов товара (требуется expand=positions.assortment)
 * и «Бухгалтерское наименование» из характеристик модификации (если есть).
 *
 * @param pos позиция чека
 * @param index порядковый номер
 * @param linkCharacteristicName имя характеристики модификации с бух-именем
 *   (default «Бухгалтерское наименование»). Из настроек магазина.
 */
export function normalizePosition(
  pos: MsRetailDemandPosition,
  index: number,
  linkCharacteristicName: string = 'Бухгалтерское наименование',
): NormalizedPosition {
  const assortment = inlineAssortment(pos)
  const name = assortment?.name ?? `Позиция #${index + 1}`

  // Кол-во: МойСклад в дробных штуках, у нас миллидоли.
  const quantity = Math.round(pos.quantity * 1000)

  // Цена * кол-во с учётом скидки. discount в %.
  const priceAfterDiscount = pos.price * (1 - (pos.discount ?? 0) / 100)
  const totalTiyin = Math.round(priceAfterDiscount * pos.quantity)

  return {
    index,
    name,
    quantity,
    totalTiyin,
    vatPercent: pos.vat ?? 0,
    classCode: assortment ? readAttr(assortment.attributes, ICPU_ATTR_NAMES) : null,
    packageCode: assortment ? readAttr(assortment.attributes, PACKAGE_ATTR_NAMES) : null,
    barcode: assortment ? pickBarcode(assortment) : null,
    linkedBuhName: assortment
      ? readLinkedBuhName(assortment.characteristics, linkCharacteristicName)
      : null,
  }
}

/**
 * Услуга в МС — это `assortment.meta.type === 'service'`. Магазины используют
 * этот тип для нетоварных позиций: имя продавца («Турсуной кушмуродова»),
 * доставка курьером, монтажные работы, гарантия и т.п.
 *
 * В фискальный чек УЗ услуги не идут — кассовый аппарат пробивает только
 * товары с ИКПУ. Услуги МС обычно идут с нулевой суммой и без ИКПУ — их
 * нужно полностью исключить из подбора.
 */
function isService(pos: MsRetailDemandPosition): boolean {
  const a = pos.assortment as { meta?: { type?: string } }
  return a?.meta?.type === 'service'
}

/** Извлечь все нормализованные позиции из retaildemand.
 * Услуги (service) полностью отфильтровываются — они не товар и не идут в чек.
 *
 * @param linkCharacteristicName имя характеристики модификации МС с бух-именем
 *   (для стратегии `linked-ms`). Передаётся из настроек магазина.
 */
export function extractPositions(
  rd: MsRetailDemand,
  linkCharacteristicName?: string,
): NormalizedPosition[] {
  const positions = inlinePositions(rd)
  if (!positions) return []
  return positions
    .filter((p) => !isService(p))
    .map((p, i) => normalizePosition(p, i, linkCharacteristicName))
}
