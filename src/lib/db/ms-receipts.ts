import { getDb, now } from './client'
import type { MsReceiptRow, MsReceiptStatus, NewMsReceipt } from './types'

export interface MsReceiptFilter {
  status?: MsReceiptStatus | MsReceiptStatus[]
  limit?: number
  offset?: number
}

export async function listMsReceipts(filter: MsReceiptFilter = {}): Promise<MsReceiptRow[]> {
  const db = await getDb()
  const where: string[] = []
  const params: unknown[] = []
  let n = 1

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    const placeholders = statuses.map(() => `$${n++}`).join(', ')
    where.push(`status IN (${placeholders})`)
    params.push(...statuses)
  }

  const limit = filter.limit ?? 100
  const offset = filter.offset ?? 0

  const sql = `
    SELECT * FROM ms_receipts
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ms_moment DESC, id DESC
    LIMIT $${n++} OFFSET $${n}
  `
  params.push(limit, offset)

  return db.select<MsReceiptRow[]>(sql, params)
}

export async function getMsReceipt(id: number): Promise<MsReceiptRow | null> {
  const db = await getDb()
  const rows = await db.select<MsReceiptRow[]>('SELECT * FROM ms_receipts WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function getMsReceiptByMsId(msId: string): Promise<MsReceiptRow | null> {
  const db = await getDb()
  const rows = await db.select<MsReceiptRow[]>(
    'SELECT * FROM ms_receipts WHERE ms_id = $1',
    [msId],
  )
  return rows[0] ?? null
}

/**
 * Идемпотентная вставка: если ms_id уже есть, ничего не меняет. Возвращает id строки.
 *
 * ⚠️ Вставка идёт через `ON CONFLICT DO NOTHING`, а НЕ через «SELECT → если
 * нет, INSERT». Проверка-перед-вставкой давала гонку: между SELECT и INSERT
 * тот же чек успевал сохранить другой путь — поллер МС и фискализация
 * (`fiscalize.ts` тоже зовёт upsert, когда `opts.msReceiptId` не задан), либо
 * перекрывшиеся тики поллера при медленном ответе МС. В логах это выглядело
 * как `UNIQUE constraint failed: ms_receipts.ms_id`, тик поллера падал целиком
 * и остальные чеки из пачки в этот заход не сохранялись.
 */
export async function upsertMsReceipt(receipt: NewMsReceipt): Promise<number> {
  const db = await getDb()
  const ts = now()
  const status = receipt.status ?? 'pending'

  await db.execute(
    `INSERT INTO ms_receipts (
       ms_id, ms_name, ms_moment, ms_sum_tiyin, raw_json, status, fetched_at, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(ms_id) DO NOTHING`,
    [
      receipt.ms_id,
      receipt.ms_name,
      receipt.ms_moment,
      receipt.ms_sum_tiyin,
      receipt.raw_json,
      status,
      receipt.fetched_at,
      ts,
    ],
  )

  // `lastInsertId` при DO NOTHING не отражает нужную строку (0 либо id прошлой
  // вставки в этом соединении), поэтому всегда перечитываем по ms_id — так
  // возвращаемый id верен и для вставки, и для «уже существовало».
  const row = await getMsReceiptByMsId(receipt.ms_id)
  return row?.id ?? 0
}

export async function setMsReceiptStatus(id: number, status: MsReceiptStatus): Promise<void> {
  const db = await getDb()
  await db.execute(
    `UPDATE ms_receipts SET status = $1, updated_at = $2 WHERE id = $3`,
    [status, now(), id],
  )
}

export async function countMsReceiptsByStatus(): Promise<Record<MsReceiptStatus, number>> {
  const db = await getDb()
  const rows = await db.select<{ status: MsReceiptStatus; c: number }[]>(
    'SELECT status, COUNT(*) AS c FROM ms_receipts GROUP BY status',
  )
  const result = {
    pending: 0,
    matched: 0,
    fiscalized: 0,
    failed: 0,
    manual: 0,
    skipped: 0,
    not_required: 0,
  } as Record<MsReceiptStatus, number>
  for (const row of rows) result[row.status] = row.c
  return result
}
