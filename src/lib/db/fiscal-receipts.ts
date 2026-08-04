import { getDb, now } from './client'
import type { FiscalReceiptRow } from './types'
import { buildSearchText, buildWhere, type HistoryFilters } from './receipt-search'

// Наружу отдаём только контракт фильтров — buildWhere/escapeLike и прочие
// внутренности поиска остаются приватными для слоя БД.
export type { HistoryFilters }

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
  /**
   * Тип карты, выбранный кассиром перед фискализацией. Для оплат чисто
   * наличкой и для тестового режима — `null`. Используется для печати
   * строки «Karta turi» на refund-чеке и копии из Истории.
   * В ОФД не отправляется.
   */
  card_kind?: 'fiz' | 'corp' | null
  /**
   * Сумма (тийины) которая была исключена из фискализации как Click/Payme.
   * 0 (default) = ничего не исключалось, фискальный чек = ms_sum.
   * См. migration 010 + FiscalReceiptRow.excluded_payment_tiyin.
   */
  excluded_payment_tiyin?: number
  /**
   * Номер чека МойСклад («05401») — попадает в `search_text`, чтобы кассир
   * мог найти фискальный чек по знакомому ему номеру из Кассы.
   */
  ms_name?: string | null
  /**
   * Названия позиций как они были в чеке МойСклад, ДО подмены ИКПУ. Кассир
   * ищет именно по ним («дрель»), а не по тому что ушло в ОФД («коронка»).
   */
  ms_item_names?: string[] | null
}

export async function insertFiscalReceipt(input: NewFiscalReceipt): Promise<number> {
  const db = await getDb()
  const result = await db.execute(
    `INSERT INTO fiscal_receipts (
       ms_receipt_id, match_id, terminal_id, receipt_seq, fiscal_sign, qr_code_url,
       fiscal_datetime, applet_version, request_json, response_json, fiscalized_at,
       card_kind, excluded_payment_tiyin, search_text
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
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
      input.card_kind ?? null,
      input.excluded_payment_tiyin ?? 0,
      buildSearchText(input),
    ],
  )
  return result.lastInsertId ?? 0
}

// ── Поиск в Истории ──────────────────────────────────────────────
// Чистая логика (нормализация / токенизация / WHERE) живёт в ./receipt-search
// — там её можно тестировать без подключения к SQLite.

/**
 * Страница Истории с учётом фильтров. Фильтрация и пагинация делаются в SQL —
 * в JS никогда не приезжает больше `limit` строк (в них лежит request_json,
 * так что тянуть всю таблицу в память нельзя).
 */
export async function searchFiscalReceipts(
  filters: HistoryFilters,
  limit = 50,
  offset = 0,
): Promise<FiscalReceiptRow[]> {
  const db = await getDb()
  const { sql, params } = buildWhere(filters)
  return db.select<FiscalReceiptRow[]>(
    `SELECT * FROM fiscal_receipts ${sql}
      ORDER BY fiscalized_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset],
  )
}

/**
 * Разовая дозаливка `search_text` для чеков, созданных до migration 014.
 *
 * Идемпотентна: обрабатывает только строки с `search_text IS NULL` (для них
 * есть частичный индекс, поэтому после завершения проверка мгновенная).
 * Чанками по 200 — один SELECT + один UPDATE на чанк: каждый запрос к
 * tauri-plugin-sql это IPC-раунд-трип, построчный UPDATE был бы на порядок
 * медленнее.
 *
 * Возвращает число обработанных чеков.
 */
export async function backfillSearchText(): Promise<number> {
  // Дедуп параллельных вызовов: React.StrictMode в dev монтирует эффекты
  // дважды, да и App + History могут стартовать его одновременно.
  if (backfillInflight) return backfillInflight
  backfillInflight = runBackfillSearchText().finally(() => {
    backfillInflight = null
  })
  return backfillInflight
}

let backfillInflight: Promise<number> | null = null

async function runBackfillSearchText(): Promise<number> {
  const db = await getDb()
  const CHUNK = 200
  /** Потолок итераций (200 × 500 = 100k чеков) — страховка от вечного цикла. */
  const MAX_CHUNKS = 500
  let processed = 0

  for (let guard = 0; guard < MAX_CHUNKS; guard++) {
    const rows = await db.select<
      Array<{
        id: number
        request_json: string
        receipt_seq: string
        fiscal_sign: string
        terminal_id: string
        ms_name: string | null
      }>
    >(
      `SELECT f.id, f.request_json, f.receipt_seq, f.fiscal_sign, f.terminal_id,
              m.ms_name
         FROM fiscal_receipts f
         LEFT JOIN ms_receipts m ON m.id = f.ms_receipt_id
        WHERE f.search_text IS NULL
        LIMIT $1`,
      [CHUNK],
    )
    if (rows.length === 0) break

    // Один UPDATE ... CASE на весь чанк вместо N отдельных запросов.
    // id берутся из БД (целые), поэтому их безопасно вставить в текст запроса;
    // значения search_text идут параметрами.
    const cases: string[] = []
    const params: unknown[] = []
    for (const r of rows) {
      params.push(r.id)
      const idPh = `$${params.length}`
      params.push(buildSearchText(r))
      cases.push(`WHEN ${idPh} THEN $${params.length}`)
    }
    const ids = rows.map((r) => r.id).join(',')
    await db.execute(
      `UPDATE fiscal_receipts
          SET search_text = CASE id ${cases.join(' ')} END
        WHERE id IN (${ids})`,
      params,
    )

    processed += rows.length
    // Последний (неполный) чанк — дальше NULL-строк нет.
    if (rows.length < CHUNK) break
  }
  return processed
}

/**
 * Получить fiscal_receipt по id (для refund flow / печати копии).
 * Возвращает null если запись не найдена.
 */
export async function getFiscalReceiptById(
  id: number,
): Promise<FiscalReceiptRow | null> {
  const db = await getDb()
  const rows = await db.select<FiscalReceiptRow[]>(
    `SELECT * FROM fiscal_receipts WHERE id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
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

/**
 * Число чеков, подходящих под фильтры — для пагинации и счётчика «найдено N».
 * Без аргумента считает все чеки (прежнее поведение).
 */
export async function countFiscalReceipts(
  filters: HistoryFilters = {},
): Promise<number> {
  const db = await getDb()
  const { sql, params } = buildWhere(filters)
  const rows = await db.select<{ c: number }[]>(
    `SELECT COUNT(*) AS c FROM fiscal_receipts ${sql}`,
    params,
  )
  return rows[0]?.c ?? 0
}
