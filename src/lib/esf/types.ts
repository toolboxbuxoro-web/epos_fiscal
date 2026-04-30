import type { NewEsfItem } from '@/lib/db/types'

/** Прочитанная строка Excel: { 'Колонка': 'значение' }. */
export type RawRow = Record<string, string | number | null>

/** Поля, которые нужны для записи в esf_items. */
export type EsfField =
  | 'name'
  | 'classCode'
  | 'packageCode'
  | 'barcode'
  | 'unitPriceTiyin'
  | 'qtyReceived'
  | 'vatPercent'
  | 'ownerType'
  | 'receivedAt'
  | 'externalId'
  | 'notes'

/** Маппинг: для каждого нашего поля — какая колонка Excel (или константа). */
export type ColumnMapping = Partial<Record<EsfField, string>>

export interface ImportPreview {
  /** Все распознанные колонки Excel. */
  columns: string[]
  /** Первые ~20 строк сырого датасета. */
  sample: RawRow[]
  /** Всего строк в файле (без шапки). */
  totalRows: number
  /** Угаданный маппинг (можно править). */
  guessedMapping: ColumnMapping
}

export interface ImportProblem {
  rowIndex: number
  message: string
}

export interface ImportResult {
  totalRows: number
  successRows: number
  problems: ImportProblem[]
  /** Готовые к вставке записи. */
  items: NewEsfItem[]
}
