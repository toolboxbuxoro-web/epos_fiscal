import { bulkInsertEsfItems } from '@/lib/db'
import type { NewEsfItem, OwnerType } from '@/lib/db/types'
import type {
  ColumnMapping,
  EsfField,
  ImportProblem,
  ImportResult,
  RawRow,
} from './types'
import { readExcelAllRows } from './excel'

/** Перевод сум → тийины. */
function sumToTiyin(value: number): number {
  return Math.round(value * 100)
}

/** Парсинг ставки НДС: "12%", "12", 0.12 → целое 12. */
function parseVatPercent(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0
  if (typeof raw === 'number') {
    return raw > 0 && raw <= 1 ? Math.round(raw * 100) : Math.round(raw)
  }
  const cleaned = String(raw).replace('%', '').replace(',', '.').trim()
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n)) return 0
  return n > 0 && n <= 1 ? Math.round(n * 100) : Math.round(n)
}

/** Парсинг типа владения: 0/1/2, "перепродажа"/"производитель"/"услуга". */
function parseOwnerType(raw: unknown): OwnerType {
  if (raw === null || raw === undefined || raw === '') return 0
  if (typeof raw === 'number' && [0, 1, 2].includes(raw)) return raw as OwnerType
  const s = String(raw).toLowerCase().trim()
  if (s.startsWith('1') || s.includes('производ') || s.includes('ishlab')) return 1
  if (s.startsWith('2') || s.includes('услуг') || s.includes('xizmat')) return 2
  return 0
}

/** Парсинг количества: "1.5 кг" / "1500 шт" / "1" → миллидоли. */
function parseQuantity(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') return 0
  if (typeof raw === 'number') return Math.round(raw * 1000)
  const cleaned = String(raw).replace(',', '.').match(/-?\d+(\.\d+)?/)
  if (!cleaned) return 0
  const n = Number.parseFloat(cleaned[0])
  return Number.isFinite(n) ? Math.round(n * 1000) : 0
}

/** Парсинг даты: Date / "DD.MM.YYYY" / "YYYY-MM-DD" / Excel serial → epoch секунды. */
function parseDate(raw: unknown): number {
  if (raw === null || raw === undefined || raw === '') {
    return Math.floor(Date.now() / 1000)
  }
  if (raw instanceof Date) return Math.floor(raw.getTime() / 1000)
  if (typeof raw === 'number') {
    // Excel serial date: дни с 1899-12-30
    const epochMs = (raw - 25569) * 86400 * 1000
    if (Number.isFinite(epochMs)) return Math.floor(epochMs / 1000)
    return Math.floor(Date.now() / 1000)
  }
  const s = String(raw).trim()
  // Сначала пробуем стандартный Date.parse (ISO).
  let t = Date.parse(s)
  if (!Number.isNaN(t)) return Math.floor(t / 1000)
  // Узбекский / русский формат "DD.MM.YYYY"
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/)
  if (m) {
    const [, d, mo, y] = m
    t = Date.UTC(Number(y), Number(mo) - 1, Number(d))
    if (!Number.isNaN(t)) return Math.floor(t / 1000)
  }
  return Math.floor(Date.now() / 1000)
}

function strOrNull(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).trim()
  return s === '' ? null : s
}

function getCell(row: RawRow, mapping: ColumnMapping, field: EsfField): unknown {
  const col = mapping[field]
  if (!col) return null
  return row[col] ?? null
}

/**
 * Сконвертировать одну сырую строку в готовую запись esf_item.
 * Возвращает null + проблему, если обязательные поля не заполнены.
 */
export function rowToEsfItem(
  row: RawRow,
  mapping: ColumnMapping,
  rowIndex: number,
): { item: NewEsfItem | null; problem: ImportProblem | null } {
  const name = strOrNull(getCell(row, mapping, 'name'))
  const classCode = strOrNull(getCell(row, mapping, 'classCode'))
  const packageCode = strOrNull(getCell(row, mapping, 'packageCode'))
  const priceRaw = getCell(row, mapping, 'unitPriceTiyin')
  const qtyRaw = getCell(row, mapping, 'qtyReceived')

  if (!name) {
    return { item: null, problem: { rowIndex, message: 'Нет наименования' } }
  }
  if (!classCode) {
    return { item: null, problem: { rowIndex, message: `«${name}»: нет ИКПУ` } }
  }
  if (!packageCode) {
    return {
      item: null,
      problem: { rowIndex, message: `«${name}»: нет кода упаковки` },
    }
  }

  const priceNum = typeof priceRaw === 'number' ? priceRaw : Number.parseFloat(String(priceRaw ?? ''))
  if (!Number.isFinite(priceNum) || priceNum <= 0) {
    return { item: null, problem: { rowIndex, message: `«${name}»: некорректная цена` } }
  }
  const qty = parseQuantity(qtyRaw)
  if (qty <= 0) {
    return { item: null, problem: { rowIndex, message: `«${name}»: некорректное кол-во` } }
  }

  const item: NewEsfItem = {
    source: 'excel',
    external_id: strOrNull(getCell(row, mapping, 'externalId')),
    name,
    barcode: strOrNull(getCell(row, mapping, 'barcode')),
    class_code: classCode,
    package_code: packageCode,
    vat_percent: parseVatPercent(getCell(row, mapping, 'vatPercent')),
    owner_type: parseOwnerType(getCell(row, mapping, 'ownerType')),
    unit_price_tiyin: sumToTiyin(priceNum),
    qty_received: qty,
    received_at: parseDate(getCell(row, mapping, 'receivedAt')),
    notes: strOrNull(getCell(row, mapping, 'notes')),
  }

  return { item, problem: null }
}

/** План импорта (без записи в БД) — превращает сырые строки в готовые esf_items. */
export function buildImportPlan(mapping: ColumnMapping, allRows: RawRow[]): ImportResult {
  const items: NewEsfItem[] = []
  const problems: ImportProblem[] = []
  allRows.forEach((row, idx) => {
    const { item, problem } = rowToEsfItem(row, mapping, idx + 2) // +2 = 1-based + шапка
    if (item) items.push(item)
    if (problem) problems.push(problem)
  })
  return {
    totalRows: allRows.length,
    successRows: items.length,
    problems,
    items,
  }
}

/** Прочитать файл целиком, посчитать план, записать в БД. */
export async function importExcelFile(
  file: File,
  mapping: ColumnMapping,
): Promise<ImportResult> {
  const allRows = await readExcelAllRows(file)
  const plan = buildImportPlan(mapping, allRows)
  if (plan.items.length > 0) {
    await bulkInsertEsfItems(plan.items)
  }
  return plan
}
