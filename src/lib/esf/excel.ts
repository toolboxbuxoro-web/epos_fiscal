import * as XLSX from 'xlsx'
import type { ColumnMapping, EsfField, ImportPreview, RawRow } from './types'

/**
 * Прочитать книгу Excel и вернуть превью первого листа:
 * заголовки колонок, sample строки и угаданный маппинг.
 */
export async function readExcelPreview(file: File): Promise<ImportPreview> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })

  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) {
    throw new Error('В файле нет листов')
  }
  const sheet = wb.Sheets[firstSheetName]
  if (!sheet) {
    throw new Error('Не удалось открыть первый лист')
  }

  const rows: RawRow[] = XLSX.utils.sheet_to_json(sheet, {
    raw: true,
    defval: null,
  })

  const columns = rows[0] ? Object.keys(rows[0]) : []
  const sample = rows.slice(0, 20)
  const guessedMapping = guessMapping(columns)

  return {
    columns,
    sample,
    totalRows: rows.length,
    guessedMapping,
  }
}

/** Прочитать все строки (для финального импорта). */
export async function readExcelAllRows(file: File): Promise<RawRow[]> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { type: 'array', cellDates: true })
  const firstSheetName = wb.SheetNames[0]
  if (!firstSheetName) return []
  const sheet = wb.Sheets[firstSheetName]
  if (!sheet) return []
  return XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: true, defval: null })
}

/**
 * Угадать маппинг колонок по эвристике: ищем подстроки в названиях.
 * Поддерживаются русский, узбекский (latin), английский варианты.
 */
export function guessMapping(columns: string[]): ColumnMapping {
  const m: ColumnMapping = {}
  const lc = columns.map((c) => ({ orig: c, low: c.toLowerCase().trim() }))

  const find = (...patterns: string[]): string | undefined => {
    for (const { orig, low } of lc) {
      for (const p of patterns) {
        if (low.includes(p)) return orig
      }
    }
    return undefined
  }

  const setIf = (field: EsfField, value: string | undefined) => {
    if (value !== undefined) m[field] = value
  }

  setIf('name', find('наимен', 'товар', 'name', 'mahsulot', 'tovar'))
  setIf('classCode', find('икпу', 'ikpu', 'class'))
  setIf('packageCode', find('упаков', 'package', 'qadoq'))
  setIf('barcode', find('штрих', 'barcode', 'shtrih', 'shtrix'))
  setIf('unitPriceTiyin', find('цена', 'price', 'narx', 'sotuv'))
  setIf('qtyReceived', find('кол-во', 'количество', 'qty', 'soni', 'miqdor'))
  setIf('vatPercent', find('ндс', 'vat', 'qqs'))
  setIf('ownerType', find('тип влад', 'owner', 'произв', 'перепрод'))
  setIf('receivedAt', find('дата', 'date', 'sana'))
  setIf('externalId', find('эсф', 'invoice', 'номер счёт', 'факт'))

  return m
}
