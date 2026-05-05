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

export interface BulkInsertResult {
  inserted: number
  errors: Array<{ index: number; message: string }>
}

/**
 * Массово вставить приходы.
 *
 * Каждая строка в собственном try/catch — одна сломанная не прерывает остальные.
 * Раньше использовался BEGIN/COMMIT через отдельные db.execute(), но в
 * tauri-plugin-sql это не работает как настоящая транзакция: каждый execute
 * берёт свой коннект из пула, BEGIN на нём бесполезен, а ошибка в середине
 * прерывала цикл и оставляла половину данных в БД.
 *
 * Возвращает фактическое количество вставленных и список ошибок с индексами,
 * чтобы UI мог показать «успешно X из Y, упало Z».
 */
export async function bulkInsertEsfItems(
  items: NewEsfItem[],
): Promise<BulkInsertResult> {
  if (items.length === 0) return { inserted: 0, errors: [] }
  const db = await getDb()
  const ts = now()
  let inserted = 0
  const errors: Array<{ index: number; message: string }> = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    try {
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
      inserted++
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ index: i, message: `«${item.name}»: ${message}` })
    }
  }

  return { inserted, errors }
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

/**
 * Удалить ВСЕ записи из esf_items.
 * Используется при «Импорт с очисткой» в диалоге Excel-импорта,
 * чтобы повторный импорт того же файла не создавал дубликаты.
 *
 * Безопасно вызывать только когда нет фискализаций со ссылками
 * (но т.к. match_items имеет ON DELETE RESTRICT, попытка удалить
 * использованный приход упадёт на FK — это и нужное поведение).
 */
export async function clearAllEsfItems(): Promise<number> {
  const db = await getDb()
  const result = await db.execute('DELETE FROM esf_items')
  return result.rowsAffected ?? 0
}

// ── Migration helpers ──────────────────────────────────────────────────

/**
 * Локальные приходы которые ещё НЕ перенесены в общий пул.
 *
 *   - source != 'remote' (из Excel/ЭСФ/didox, не пришедшие через sync)
 *   - server_item_id IS NULL (нет связи с серверной строкой)
 *   - available > 0 (зачем переносить уже использованные?)
 *
 * Используется migration-tool в Catalog UI.
 */
export async function listLocalUnmigrated(): Promise<EsfItemRow[]> {
  const db = await getDb()
  return db.select<EsfItemRow[]>(
    `SELECT * FROM esf_items
     WHERE server_item_id IS NULL
       AND source != 'remote'
       AND (qty_received - qty_consumed) > 0
     ORDER BY received_at ASC`,
  )
}

/** Сколько локальных непереданных. */
export async function countLocalUnmigrated(): Promise<number> {
  const db = await getDb()
  const rows = await db.select<Array<{ c: number }>>(
    `SELECT COUNT(*) AS c FROM esf_items
     WHERE server_item_id IS NULL
       AND source != 'remote'
       AND (qty_received - qty_consumed) > 0`,
  )
  return rows[0]?.c ?? 0
}

/**
 * Привязать локальную строку к id на сервере (после успешной миграции).
 * Также обнуляем qty_consumed — потому что фактический остаток теперь живёт
 * на сервере (мы отправили на сервер `qty_received - qty_consumed` как новый
 * qty_received). Локальный qty_received → также синхронизируется в режиме
 * remote через applyItemsUpdate, так что после миграции при первом SSE-event
 * данные станут консистентны.
 */
export async function setServerItemId(
  localId: number,
  serverItemId: number,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `UPDATE esf_items
       SET server_item_id = $1,
           qty_consumed = 0
     WHERE id = $2`,
    [serverItemId, localId],
  )
}
