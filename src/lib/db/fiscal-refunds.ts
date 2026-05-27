import { getDb, now } from './client'
import type { FiscalRefundRow, RefundState, Tiyin } from './types'

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
  /**
   * 0 = полный возврат (вся сумма чека), 1 = частичный (часть товаров/qty).
   * При partial обязательно заполнять `refunded_items_snapshot`.
   */
  is_partial?: number
  refunded_items_snapshot?: string | null
}

/**
 * Создать запись о возврате.
 *
 * После миграции 013 UNIQUE на original_fiscal_id СНЯТ — один чек может иметь
 * несколько partial refund'ов + 0..1 full refund. Защита от дубля = UNIQUE
 * на fiscal_sign (один refund-чек = одна запись).
 *
 * Кросс-чек защита от over-refund (сумма qty по item не больше original) —
 * в `processRefund`, не на уровне БД.
 */
export async function insertFiscalRefund(input: NewFiscalRefund): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `INSERT INTO fiscal_refunds (
       original_fiscal_id, ms_return_id, terminal_id, receipt_seq, fiscal_sign,
       qr_code_url, fiscal_datetime, applet_version, items_json,
       refund_cash_tiyin, refund_card_tiyin, refund_qr_tiyin,
       request_json, response_json, reason, cashier_name, refunded_at,
       is_partial, refunded_items_snapshot
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19
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
      input.is_partial ?? 0,
      input.refunded_items_snapshot ?? null,
    ],
  )
  return result.lastInsertId ?? 0
}

/**
 * Получить ПОСЛЕДНИЙ возврат по id оригинального чека.
 *
 * ⚠️ После миграции 013 один чек может иметь несколько partial refund'ов.
 * Эта функция возвращает только последний для совместимости — если нужны
 * все, используйте `listRefundsByOriginalFiscalId`.
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
 * Все refund'ы по оригинальному чеку, отсортированные старые→новые.
 * Используется processRefund чтобы проверить over-refund (сумма всех qty
 * по item не должна превышать оригинал).
 */
export async function listRefundsByOriginalFiscalId(
  originalFiscalId: number,
): Promise<FiscalRefundRow[]> {
  const db = await getDb()
  return db.select<FiscalRefundRow[]>(
    `SELECT * FROM fiscal_refunds WHERE original_fiscal_id = $1
     ORDER BY refunded_at ASC, id ASC`,
    [originalFiscalId],
  )
}

/**
 * Состояние возврата: 'none' | 'partial' | 'full'.
 *
 *   - 'none'    — refund'ов нет
 *   - 'partial' — есть только partial (is_partial=1) и нет full
 *   - 'full'    — есть хотя бы один full refund (is_partial=0)
 *
 * Используется в UI History для badge и блокировки кнопки «Возврат».
 * Кросс-чек по cumulative qty (когда несколько partial покрывают весь
 * оригинал) — TODO Phase 3, пока трактуем как 'partial'.
 */
export async function getRefundState(
  originalFiscalId: number,
): Promise<RefundState> {
  const db = await getDb()
  const rows = await db.select<{ is_partial: number }[]>(
    `SELECT is_partial FROM fiscal_refunds WHERE original_fiscal_id = $1`,
    [originalFiscalId],
  )
  if (rows.length === 0) return 'none'
  if (rows.some((r) => r.is_partial === 0)) return 'full'
  return 'partial'
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
 * Bulk-проверка состояния возвратов для списка fiscal_receipts.id.
 * Возвращает Map<fiscal_id, RefundState>. Чеки без refund'ов в Map отсутствуют
 * (caller трактует отсутствие как 'none').
 *
 * Используется на /history для быстрого рендера статуса «Возвращён»/«Частично».
 */
export async function getRefundStatesMap(
  fiscalIds: number[],
): Promise<Map<number, RefundState>> {
  if (fiscalIds.length === 0) return new Map()
  const db = await getDb()
  const placeholders = fiscalIds.map((_, i) => `$${i + 1}`).join(',')
  const rows = await db.select<{ original_fiscal_id: number; is_partial: number }[]>(
    `SELECT original_fiscal_id, is_partial FROM fiscal_refunds
     WHERE original_fiscal_id IN (${placeholders})`,
    fiscalIds,
  )
  const m = new Map<number, RefundState>()
  for (const r of rows) {
    const cur = m.get(r.original_fiscal_id)
    // full побеждает partial если в чеке есть оба (теоретически невозможно,
    // но не падаем)
    if (cur === 'full') continue
    if (r.is_partial === 0) m.set(r.original_fiscal_id, 'full')
    else if (!cur) m.set(r.original_fiscal_id, 'partial')
  }
  return m
}

/**
 * @deprecated Используйте `getRefundStatesMap` для разделения full/partial.
 * Старая функция возвращает Set всех fiscal_id у которых ЕСТЬ refund (любой).
 * Оставлена для обратной совместимости — Refund.tsx + History.tsx переехали
 * на новую API.
 */
export async function getRefundedFiscalIds(
  fiscalIds: number[],
): Promise<Set<number>> {
  const states = await getRefundStatesMap(fiscalIds)
  return new Set(states.keys())
}
