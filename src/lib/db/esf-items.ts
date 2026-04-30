import { getDb, now } from './client'
import type { EsfItemRow, MilliQty, NewEsfItem } from './types'

export interface EsfItemFilter {
  /** Минимальные доступные остатки (qty_received - qty_consumed) в тысячных. */
  minAvailable?: MilliQty
  classCode?: string
  vatPercent?: number
  search?: string
  limit?: number
  offset?: number
}

export interface EsfItemWithAvailable extends EsfItemRow {
  /** Сколько ещё можно списать (qty_received − qty_consumed). */
  available: MilliQty
}

export async function listEsfItems(filter: EsfItemFilter = {}): Promise<EsfItemWithAvailable[]> {
  const db = await getDb()
  const where: string[] = []
  const params: unknown[] = []
  let n = 1

  if (filter.minAvailable !== undefined) {
    where.push(`(qty_received - qty_consumed) >= $${n++}`)
    params.push(filter.minAvailable)
  }
  if (filter.classCode) {
    where.push(`class_code = $${n++}`)
    params.push(filter.classCode)
  }
  if (filter.vatPercent !== undefined) {
    where.push(`vat_percent = $${n++}`)
    params.push(filter.vatPercent)
  }
  if (filter.search) {
    where.push(`(name LIKE $${n} OR barcode LIKE $${n})`)
    params.push(`%${filter.search}%`)
    n++
  }

  const limit = filter.limit ?? 200
  const offset = filter.offset ?? 0

  const sql = `
    SELECT *, (qty_received - qty_consumed) AS available
    FROM esf_items
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY received_at DESC, id DESC
    LIMIT $${n++} OFFSET $${n}
  `
  params.push(limit, offset)

  return db.select<EsfItemWithAvailable[]>(sql, params)
}

export async function countEsfItems(): Promise<number> {
  const db = await getDb()
  const rows = await db.select<{ c: number }[]>('SELECT COUNT(*) AS c FROM esf_items')
  return rows[0]?.c ?? 0
}

export async function getEsfItem(id: number): Promise<EsfItemRow | null> {
  const db = await getDb()
  const rows = await db.select<EsfItemRow[]>('SELECT * FROM esf_items WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function insertEsfItem(item: NewEsfItem): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `INSERT INTO esf_items (
       source, external_id, name, barcode, class_code, package_code,
       vat_percent, owner_type, unit_price_tiyin, qty_received, qty_consumed,
       received_at, imported_at, notes
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)`,
    [
      item.source,
      item.external_id,
      item.name,
      item.barcode,
      item.class_code,
      item.package_code,
      item.vat_percent,
      item.owner_type,
      item.unit_price_tiyin,
      item.qty_received,
      item.received_at,
      now(),
      item.notes,
    ],
  )
  return result.lastInsertId ?? 0
}

export async function bulkInsertEsfItems(items: NewEsfItem[]): Promise<number> {
  if (items.length === 0) return 0
  const db = await getDb()
  const ts = now()
  let count = 0
  // SQLite транзакция через BEGIN / COMMIT
  await db.execute('BEGIN')
  try {
    for (const item of items) {
      await db.execute(
        `INSERT INTO esf_items (
           source, external_id, name, barcode, class_code, package_code,
           vat_percent, owner_type, unit_price_tiyin, qty_received, qty_consumed,
           received_at, imported_at, notes
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,0,$11,$12,$13)`,
        [
          item.source,
          item.external_id,
          item.name,
          item.barcode,
          item.class_code,
          item.package_code,
          item.vat_percent,
          item.owner_type,
          item.unit_price_tiyin,
          item.qty_received,
          item.received_at,
          ts,
          item.notes,
        ],
      )
      count++
    }
    await db.execute('COMMIT')
  } catch (err) {
    await db.execute('ROLLBACK')
    throw err
  }
  return count
}

/** Зарезервировать (списать) количество на esf_item. Возвращает true, если хватило. */
export async function consumeEsfItem(id: number, quantity: MilliQty): Promise<boolean> {
  const db = await getDb()
  const result = await db.execute(
    `UPDATE esf_items
       SET qty_consumed = qty_consumed + $1
     WHERE id = $2 AND (qty_received - qty_consumed) >= $1`,
    [quantity, id],
  )
  return result.rowsAffected > 0
}

export async function deleteEsfItem(id: number): Promise<void> {
  const db = await getDb()
  await db.execute('DELETE FROM esf_items WHERE id = $1', [id])
}
