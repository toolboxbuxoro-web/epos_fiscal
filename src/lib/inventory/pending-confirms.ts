/**
 * DAO над таблицей `inv_pending_confirms` — retry queue для подтверждений
 * резерваций после успешной фискализации в ОФД.
 *
 * Жизненный цикл одной записи:
 *   1. ДО /reserve — НЕТ записи
 *   2. ПОСЛЕ /reserve, ДО EPOS — INSERT со status='reserved'
 *   3. ПОСЛЕ успеха EPOS (получили FiscalSign) — UPDATE status='fiscal-ok' + fiscal_sign
 *   4. ПОСЛЕ /confirm на сервер — DELETE (success path)
 *
 * Если сеть упала на шаге 4 — запись остаётся со status='fiscal-ok'.
 * При следующем старте app `retryPendingConfirms()` находит её и шлёт
 * /confirm заново. Запрос идемпотентен (см. reservations.js на сервере).
 *
 * Если EPOS на шаге 3 вернул ошибку (FiscalSign НЕ получен):
 *   - вызываем /release для освобождения резерва
 *   - DELETE запись (или UPDATE status='failed' для аудита)
 */

import { getDb, now } from '@/lib/db/client'

export type PendingConfirmStatus =
  | 'reserved' // зарезервировано, EPOS ещё не отработал
  | 'fiscal-ok' // EPOS прошёл, ждём confirm на сервере
  | 'confirmed' // успешно подтверждено (запись можно удалить)
  | 'failed' // release уже отправлен

export interface PendingConfirmRow {
  id: number
  reservation_id: string
  ms_receipt_id: string
  fiscal_sign: string | null
  status: PendingConfirmStatus
  attempts: number
  last_error: string | null
  created_at: number
  updated_at: number
}

/** Новая запись после /reserve. Один INSERT на каждое reservation_id чека. */
export async function recordReserved(
  reservation_id: string,
  ms_receipt_id: string,
): Promise<void> {
  const db = await getDb()
  const ts = now()
  await db.execute(
    `INSERT INTO inv_pending_confirms
       (reservation_id, ms_receipt_id, status, attempts, created_at, updated_at)
     VALUES ($1, $2, 'reserved', 0, $3, $3)`,
    [reservation_id, ms_receipt_id, ts],
  )
}

/** EPOS прошёл успешно — переводим в fiscal-ok с fiscal_sign. */
export async function markFiscalOk(
  reservation_ids: string[],
  fiscal_sign: string,
): Promise<void> {
  if (reservation_ids.length === 0) return
  const db = await getDb()
  const ts = now()
  // Один UPDATE с массивом id'ов через IN.
  const placeholders = reservation_ids.map((_, i) => `$${i + 3}`).join(', ')
  await db.execute(
    `UPDATE inv_pending_confirms
       SET status = 'fiscal-ok', fiscal_sign = $1, updated_at = $2
     WHERE reservation_id IN (${placeholders})`,
    [fiscal_sign, ts, ...reservation_ids],
  )
}

/** /confirm успешно отправлен — удаляем (success path). */
export async function deletePendingByReservations(
  reservation_ids: string[],
): Promise<void> {
  if (reservation_ids.length === 0) return
  const db = await getDb()
  const placeholders = reservation_ids.map((_, i) => `$${i + 1}`).join(', ')
  await db.execute(
    `DELETE FROM inv_pending_confirms WHERE reservation_id IN (${placeholders})`,
    reservation_ids,
  )
}

/** Записать ошибку attempt (для логов / админ-UI / алертов). */
export async function recordAttemptFailure(
  reservation_id: string,
  error: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `UPDATE inv_pending_confirms
       SET attempts = attempts + 1,
           last_error = $1,
           updated_at = $2
     WHERE reservation_id = $3`,
    [error, now(), reservation_id],
  )
}

/** Все записи статуса 'fiscal-ok' (готовы к /confirm). */
export async function listFiscalOk(): Promise<PendingConfirmRow[]> {
  const db = await getDb()
  return db.select<PendingConfirmRow[]>(
    `SELECT * FROM inv_pending_confirms
     WHERE status = 'fiscal-ok'
     ORDER BY created_at ASC`,
  )
}

/** Все записи 'reserved' старше N секунд — кандидаты на release. */
export async function listStaleReserved(olderThanSec = 600): Promise<PendingConfirmRow[]> {
  const db = await getDb()
  const cutoff = now() - olderThanSec
  return db.select<PendingConfirmRow[]>(
    `SELECT * FROM inv_pending_confirms
     WHERE status = 'reserved' AND created_at < $1
     ORDER BY created_at ASC`,
    [cutoff],
  )
}

/** Полный список (для UI диагностики). */
export async function listAll(limit = 100): Promise<PendingConfirmRow[]> {
  const db = await getDb()
  return db.select<PendingConfirmRow[]>(
    `SELECT * FROM inv_pending_confirms ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  )
}

/** Помечаем 'failed' (release уже отправлен) — для аудита. */
export async function markFailed(
  reservation_id: string,
  error: string,
): Promise<void> {
  const db = await getDb()
  await db.execute(
    `UPDATE inv_pending_confirms
       SET status = 'failed',
           last_error = $1,
           updated_at = $2
     WHERE reservation_id = $3`,
    [error, now(), reservation_id],
  )
}
