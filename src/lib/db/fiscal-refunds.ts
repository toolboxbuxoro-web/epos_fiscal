import { getDb, now } from './client'
import type { FiscalRefundRow, Tiyin } from './types'

/** Payload для вставки нового возврата (после успешной отправки в Communicator). */
export interface NewFiscalRefund {
  original_fiscal_id: number
  ms_return_id: number | null
  terminal_id: string
  receipt_seq: string
  fiscal_sign: string
  qr_code_url: string
  fiscal_datetime: string
  applet_version: string | null
  items_json: string
  refund_cash_tiyin: Tiyin
  refund_card_tiyin: Tiyin
  refund_qr_tiyin: Tiyin
  request_json: string
  response_json: string
  reason: string | null
  cashier_name: string | null
}

/**
 * Создать запись о возврате.
 *
 * Throws если на этот original_fiscal_id уже есть refund (UNIQUE constraint).
 * UI должен ловить эту ошибку и показывать «Этот чек уже был возвращён».
 */
export async function insertFiscalRefund(input: NewFiscalRefund): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `INSERT INTO fiscal_refunds (
       original_fiscal_id, ms_return_id, terminal_id, receipt_seq, fiscal_sign,
       qr_code_url, fiscal_datetime, applet_version, items_json,
       refund_cash_tiyin, refund_card_tiyin, refund_qr_tiyin,
       request_json, response_json, reason, cashier_name, refunded_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17
     )`,
    [
      input.original_fiscal_id,
      input.ms_return_id,
      input.terminal_id,
      input.receipt_seq,
      input.fiscal_sign,
      input.qr_code_url,
      input.fiscal_datetime,
      input.applet_version,
      input.items_json,
      input.refund_cash_tiyin,
      input.refund_card_tiyin,
      input.refund_qr_tiyin,
      input.request_json,
      input.response_json,
      input.reason,
      input.cashier_name,
      now(),
    ],
  )
  return result.lastInsertId ?? 0
}

/**
 * Получить возврат по id оригинального продажного чека.
 * Используется UI чтобы понять «этот чек уже возвращён или нет».
 *
 * Возвращает null если возврата ещё не было.
 */
export async function getRefundByOriginalFiscalId(
  originalFiscalId: number,
): Promise<FiscalRefundRow | null> {
  const db = await getDb()
  const rows = await db.select<FiscalRefundRow[]>(
    `SELECT * FROM fiscal_refunds WHERE original_fiscal_id = $1
     ORDER BY refunded_at DESC, id DESC LIMIT 1`,
    [originalFiscalId],
  )
  return rows[0] ?? null
}

/**
 * Получить refund по его собственному id (для печати / просмотра).
 */
export async function getFiscalRefund(id: number): Promise<FiscalRefundRow | null> {
  const db = await getDb()
  const rows = await db.select<FiscalRefundRow[]>(
    `SELECT * FROM fiscal_refunds WHERE id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

/**
 * Список refund'ов для отчётов / аудита.
 * По умолчанию свежие сверху.
 */
export async function listFiscalRefunds(
  limit = 100,
  offset = 0,
): Promise<FiscalRefundRow[]> {
  const db = await getDb()
  return db.select<FiscalRefundRow[]>(
    `SELECT * FROM fiscal_refunds ORDER BY refunded_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
}

/**
 * Bulk-проверка: какие из переданных fiscal_receipts.id уже возвращены.
 * Используется на /history чтобы быстро дисэйблить кнопку «Возврат».
 *
 * @returns Set из original_fiscal_id'ов которые уже имеют refund.
 */
export async function getRefundedFiscalIds(
  fiscalIds: number[],
): Promise<Set<number>> {
  if (fiscalIds.length === 0) return new Set()
  const db = await getDb()
  const placeholders = fiscalIds.map((_, i) => `$${i + 1}`).join(',')
  const rows = await db.select<{ original_fiscal_id: number }[]>(
    `SELECT DISTINCT original_fiscal_id FROM fiscal_refunds
     WHERE original_fiscal_id IN (${placeholders})`,
    fiscalIds,
  )
  return new Set(rows.map((r) => r.original_fiscal_id))
}
