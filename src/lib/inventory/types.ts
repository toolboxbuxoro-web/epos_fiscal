/**
 * Типы для общения с mytoolbox inventory server.
 *
 * Соглашения совпадают с серверной стороной:
 *   - quantity в МИЛЛИДОЛЯХ (1000 = 1 шт)
 *   - деньги в ТИЙИНАХ (100 = 1 сум)
 *   - timestamps в ISO 8601 строках с timezone
 */

import type { MilliQty, Tiyin } from '@/lib/db/types'

/** Один приход из общего пула. Совпадает с строкой `inv_items` на сервере. */
export interface RemoteInvItem {
  id: number
  organization_id: string
  name: string
  class_code: string
  package_code: string | null
  vat_percent: number
  unit_price_tiyin: Tiyin
  qty_received: MilliQty
  qty_consumed: MilliQty
  qty_reserved: MilliQty
  available: MilliQty // computed = qty_received - qty_consumed - qty_reserved
  received_at: string // ISO
  imported_at: string // ISO
  source_doc: string | null
}

/** Ответ /items endpoint. */
export interface ItemsListResponse {
  items: RemoteInvItem[]
  server_time: string
}

/** Тело /reserve. */
export interface ReserveRequest {
  ms_receipt_id: string
  items: { inv_item_id: number; quantity: MilliQty }[]
  ttl_seconds?: number
}

/** Одна резервация — соответствует одной строке `inv_reservations`. */
export interface ReservationInfo {
  reservation_id: string
  inv_item_id: number
  quantity: MilliQty
  expires_at: string
}

/** Положительный ответ /reserve. */
export interface ReserveOk {
  ok: true
  idempotent_replay?: boolean
  reservations: ReservationInfo[]
  items: Array<{
    id: number
    qty_received: MilliQty
    qty_consumed: MilliQty
    qty_reserved: MilliQty
    available: MilliQty
  }>
}

/** 409: не хватает остатков. */
export interface ReserveFail {
  ok: false
  code: 'INSUFFICIENT_STOCK' | 'NO_ITEMS'
  failed: Array<{
    inv_item_id: number
    requested: MilliQty
    available: MilliQty
    reason: string
  }>
}

export type ReserveResponse = ReserveOk | ReserveFail

export interface ConfirmRequest {
  reservation_ids: string | string[]
  fiscal_sign: string
}

export interface ConfirmOk {
  ok: true
  items: Array<{
    id: number
    qty_received: MilliQty
    qty_consumed: MilliQty
    qty_reserved: MilliQty
    available: MilliQty
  }>
}

export interface ConfirmFail {
  ok: false
  code:
    | 'NOT_FOUND'
    | 'ALREADY_RELEASED'
    | 'EXPIRED_AND_INSUFFICIENT'
    | 'NO_RESERVATIONS'
  reservation_id?: string
  available?: MilliQty
  requested?: MilliQty
}

export type ConfirmResponse = ConfirmOk | ConfirmFail

export interface ReleaseRequest {
  reservation_ids: string | string[]
  reason?: string
}

export interface ReleaseResponse {
  ok: boolean
  code?: string
  items?: ConfirmOk['items']
}

export interface ExtendRequest {
  reservation_ids: string | string[]
  extend_seconds?: number
}

/** Конфигурация магазина для inventory клиента. */
export interface InventoryClientConfig {
  serverUrl: string // 'https://mytoolbox-backend.up.railway.app' (без trailing /)
  apiKey: string
  /** Слаг магазина для логов. Не используется в auth (auth по api key). */
  shopSlug?: string
}

/**
 * Ответ GET /api/v1/inventory/shop/me — что Tauri-клиент знает о себе.
 * `moysklad.basic_credentials` приходит уже расшифрованный, готовый
 * для записи в local SettingKey.MoyskladCredentials.
 *
 * `null` поля = не сконфигурировано в админке. UI покажет «обратитесь к админу».
 */
export interface ShopMeResponse {
  shop: {
    id: number
    slug: string
    name: string
    organization_id: string
  }
  moysklad: {
    login: string | null
    /** base64 от "login:password" — готов для МС Authorization header. */
    basic_credentials: string | null
    retailstore_id: string | null
    retailstore_name: string | null
    employee_id: string | null
    employee_name: string | null
  }
}
