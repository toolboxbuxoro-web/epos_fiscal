import { getDb, now } from './client'
import type { FiscalReceiptRow } from './types'

export interface NewFiscalReceipt {
  ms_receipt_id: number
  match_id: number | null
  terminal_id: string
  receipt_seq: string
  fiscal_sign: string
  qr_code_url: string
  fiscal_datetime: string
  applet_version: string | null
  request_json: string
  response_json: string
}

export async function insertFiscalReceipt(input: NewFiscalReceipt): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `INSERT INTO fiscal_receipts (
       ms_receipt_id, match_id, terminal_id, receipt_seq, fiscal_sign, qr_code_url,
       fiscal_datetime, applet_version, request_json, response_json, fiscalized_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      input.ms_receipt_id,
      input.match_id,
      input.terminal_id,
      input.receipt_seq,
      input.fiscal_sign,
      input.qr_code_url,
      input.fiscal_datetime,
      input.applet_version,
      input.request_json,
      input.response_json,
      now(),
    ],
  )
  return result.lastInsertId ?? 0
}

export async function getFiscalReceiptByMsId(msReceiptId: number): Promise<FiscalReceiptRow | null> {
  const db = await getDb()
  const rows = await db.select<FiscalReceiptRow[]>(
    `SELECT * FROM fiscal_receipts WHERE ms_receipt_id = $1
     ORDER BY fiscalized_at DESC, id DESC LIMIT 1`,
    [msReceiptId],
  )
  return rows[0] ?? null
}

export async function listFiscalReceipts(limit = 100, offset = 0): Promise<FiscalReceiptRow[]> {
  const db = await getDb()
  return db.select<FiscalReceiptRow[]>(
    `SELECT * FROM fiscal_receipts ORDER BY fiscalized_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  )
}
