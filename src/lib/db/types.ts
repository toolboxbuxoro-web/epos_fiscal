// Типы соответствуют схеме SQLite (см. src-tauri/migrations/001_initial.sql).
//
// Конвенции:
//   * Все суммы в тийинах (1 сум = 100 тийинов) — `Tiyin`
//   * Количество в тысячных долях (1000 = 1 шт) — `MilliQty`
//   * Все timestamp — секунды с epoch — `EpochSec`

export type Tiyin = number
export type MilliQty = number
export type EpochSec = number

// ── settings ─────────────────────────────────────────────────────

export interface SettingRow {
  key: string
  value: string
  updated_at: EpochSec
}

/** Известные ключи настроек. */
export const SettingKey = {
  /** Bearer-токен МойСклад (старый способ, fallback). */
  MoyskladToken: 'moysklad.token',
  /**
   * Basic-credentials МойСклад (base64 от "login:password").
   * Современный способ авторизации — отправляется в каждом запросе
   * как `Authorization: Basic <это>`. Хранится как plaintext base64,
   * это не шифрование. БД лежит в Application Support, доступ к ней
   * у других программ ограничен ОС.
   */
  MoyskladCredentials: 'moysklad.credentials',
  /** Email/логин текущего залогиненного пользователя МойСклад (для UI). */
  MoyskladLogin: 'moysklad.login',
  /** ID выбранной точки продаж МойСклад. */
  MoyskladRetailStoreId: 'moysklad.retailstore_id',
  /** Имя выбранной точки продаж (для UI). */
  MoyskladRetailStoreName: 'moysklad.retailstore_name',
  /** ID выбранного кассира. */
  MoyskladEmployeeId: 'moysklad.employee_id',
  /** ФИО кассира (печатается в `staffName` чека EPOS). */
  MoyskladEmployeeName: 'moysklad.employee_name',
  /** Интервал поллинга МойСклад в секундах */
  MoyskladPollIntervalSec: 'moysklad.poll_interval_sec',
  /** Адрес EPOS Communicator (обычно http://localhost:8347/uzpos) */
  EposCommunicatorUrl: 'epos.communicator_url',
  /** Токен EPOS — фиксированный, см. universal-communicator.md */
  EposToken: 'epos.token',
  /** Реквизиты компании (печатаются на чеке) */
  CompanyName: 'company.name',
  CompanyInn: 'company.inn',
  CompanyAddress: 'company.address',
  CompanyPhone: 'company.phone',
  /** Ширина ленты принтера: 58 или 80 */
  PrinterSize: 'printer.size',
  /**
   * Имя выбранного термопринтера (точное system_name из ОС).
   * Если пусто — печать чеков отключена даже при PrinterAutoPrint=true.
   */
  PrinterName: 'printer.name',
  /**
   * Автоматически печатать чек после успешной фискализации.
   * 'true' / 'false'. По умолчанию — false (печатать только по кнопке).
   */
  PrinterAutoPrint: 'printer.auto_print',
  /** Допуск по сумме при подборе чека (в тийинах) */
  MatchToleranceTiyin: 'matcher.tolerance_tiyin',
  /** Включён ли режим автоматической фискализации */
  AutoFiscalize: 'matcher.auto_fiscalize',
  /** Включён ли режим подмены ИКПУ для товаров без приходов */
  ReplacementEnabled: 'matcher.replacement_enabled',
} as const

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey]

// ── esf_items ────────────────────────────────────────────────────

export type EsfSource = 'excel' | 'e-faktura' | 'didox'
export type OwnerType = 0 | 1 | 2 // 0=перепродажа, 1=производитель, 2=услуга

export interface EsfItemRow {
  id: number
  source: EsfSource
  external_id: string | null
  name: string
  barcode: string | null
  class_code: string
  package_code: string
  vat_percent: number
  owner_type: OwnerType
  unit_price_tiyin: Tiyin
  qty_received: MilliQty
  qty_consumed: MilliQty
  received_at: EpochSec
  imported_at: EpochSec
  notes: string | null
}

export type NewEsfItem = Omit<EsfItemRow, 'id' | 'qty_consumed' | 'imported_at'>

// ── ms_receipts ──────────────────────────────────────────────────

export type MsReceiptStatus =
  | 'pending'
  | 'matched'
  | 'fiscalized'
  | 'failed'
  | 'manual'
  | 'skipped'

export interface MsReceiptRow {
  id: number
  ms_id: string
  ms_name: string | null
  ms_moment: EpochSec
  ms_sum_tiyin: Tiyin
  raw_json: string
  status: MsReceiptStatus
  fetched_at: EpochSec
  updated_at: EpochSec
}

export type NewMsReceipt = Omit<MsReceiptRow, 'id' | 'updated_at' | 'status'> & {
  status?: MsReceiptStatus
}

// ── matches & match_items ────────────────────────────────────────

export type MatchStrategy = 'passthrough' | 'price-bucket' | 'multi-item' | 'manual'

export interface MatchRow {
  id: number
  ms_receipt_id: number
  strategy: MatchStrategy
  total_tiyin: Tiyin
  diff_tiyin: Tiyin
  created_at: EpochSec
  approved_at: EpochSec | null
}

export interface MatchItemRow {
  id: number
  match_id: number
  esf_item_id: number
  quantity: MilliQty
  price_tiyin: Tiyin
  vat_tiyin: Tiyin
}

// ── fiscal_receipts ──────────────────────────────────────────────

export interface FiscalReceiptRow {
  id: number
  ms_receipt_id: number
  match_id: number | null
  terminal_id: string
  receipt_seq: string
  fiscal_sign: string
  qr_code_url: string
  fiscal_datetime: string // YYYYMMDDHHMMSS
  applet_version: string | null
  request_json: string
  response_json: string
  fiscalized_at: EpochSec
}

// ── replacement_log ──────────────────────────────────────────────

export interface ReplacementLogRow {
  id: number
  ms_receipt_id: number
  fiscal_receipt_id: number | null
  original_items_json: string
  fiscalized_items_json: string
  reason: string | null
  created_at: EpochSec
}
