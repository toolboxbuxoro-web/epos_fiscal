/**
 * Клиент для общения с EPOS Fiscal Inventory API на mytoolbox-сервере.
 *
 * Все запросы идут через Bearer-аутентификацию (api_key per-shop).
 * `tauri-plugin-http` (reqwest) — потому что обычный fetch'у CORS мешает,
 * + capabilities в `default.json` уже разрешают `localhost`/`192.168.*`/MS.
 *
 * При деплое нужно дописать домен mytoolbox в capabilities (или сделать
 * broad allow по нашей домену, см. CLAUDE.md «не сужать allow-list»).
 */

import { fetch } from '@tauri-apps/plugin-http'
import type {
  ConfirmRequest,
  ConfirmResponse,
  ExtendRequest,
  InventoryClientConfig,
  ItemsListResponse,
  ReleaseRequest,
  ReleaseResponse,
  ReserveRequest,
  ReserveResponse,
  ShopMeResponse,
} from './types'

export class InventoryServerError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'InventoryServerError'
  }
}

export class InventoryServerClient {
  constructor(private readonly cfg: InventoryClientConfig) {
    if (!cfg.serverUrl) throw new Error('InventoryServerClient: serverUrl required')
    if (!cfg.apiKey) throw new Error('InventoryServerClient: apiKey required')
  }

  /**
   * Базовый запрос. Бросает InventoryServerError на не-2xx, возвращает
   * распарсенное тело на 2xx. Также возвращает 409 как обычное тело
   * (это ожидаемая ошибка «не хватило остатков», не exceptional).
   */
  private async request<T>(
    path: string,
    init: RequestInit & { allowStatuses?: number[] } = {},
  ): Promise<T> {
    const url = path.startsWith('http')
      ? path
      : `${this.cfg.serverUrl.replace(/\/$/, '')}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.cfg.apiKey}`)
    headers.set('Accept', 'application/json')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }
    const res = await fetch(url, {
      ...init,
      headers,
    })
    const text = await res.text()
    let body: unknown = text
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        // оставляем как text
      }
    }
    const allow = new Set([200, 201, 204, ...(init.allowStatuses ?? [])])
    if (!allow.has(res.status)) {
      const msg =
        typeof body === 'object' && body !== null && 'error' in body
          ? String((body as { error: unknown }).error)
          : `HTTP ${res.status}`
      throw new InventoryServerError(msg, res.status, body)
    }
    return body as T
  }

  // ── Reserve flow ──────────────────────────────────────────────

  /**
   * Зарезервировать набор позиций. 409 НЕ кидаем — это ожидаемый ответ
   * «не хватило», вернём как { ok: false }, чтобы caller перематчил.
   */
  async reserve(req: ReserveRequest): Promise<ReserveResponse> {
    return this.request<ReserveResponse>('/api/v1/inventory/reserve', {
      method: 'POST',
      body: JSON.stringify(req),
      allowStatuses: [409],
    })
  }

  /** Подтвердить (после получения FiscalSign). Идемпотентно. */
  async confirm(req: ConfirmRequest): Promise<ConfirmResponse> {
    return this.request<ConfirmResponse>('/api/v1/inventory/confirm', {
      method: 'POST',
      body: JSON.stringify(req),
      allowStatuses: [404, 409],
    })
  }

  /** Отпустить резерв (фискализация не удалась). */
  async release(req: ReleaseRequest): Promise<ReleaseResponse> {
    return this.request<ReleaseResponse>('/api/v1/inventory/release', {
      method: 'POST',
      body: JSON.stringify(req),
      allowStatuses: [404],
    })
  }

  /** Продлить TTL (если EPOS долго обрабатывает). */
  async extend(req: ExtendRequest): Promise<{ ok: boolean }> {
    return this.request('/api/v1/inventory/extend', {
      method: 'POST',
      body: JSON.stringify(req),
    })
  }

  // ── Items sync ────────────────────────────────────────────────

  /**
   * Список приходов. Используется для:
   *   - первичного pull при старте программы
   *   - delta-sync через `updated_since` (ISO timestamp)
   *   - точечного fetch'а одного класса при матчинге (опционально)
   */
  async listItems(opts: {
    updated_since?: string
    class_code?: string
    min_available?: number
    limit?: number
    offset?: number
  } = {}): Promise<ItemsListResponse> {
    const params = new URLSearchParams()
    if (opts.updated_since) params.set('updated_since', opts.updated_since)
    if (opts.class_code) params.set('class_code', opts.class_code)
    if (typeof opts.min_available === 'number')
      params.set('min_available', String(opts.min_available))
    if (typeof opts.limit === 'number') params.set('limit', String(opts.limit))
    if (typeof opts.offset === 'number') params.set('offset', String(opts.offset))
    const qs = params.toString()
    return this.request<ItemsListResponse>(
      `/api/v1/inventory/items${qs ? '?' + qs : ''}`,
    )
  }

  /**
   * Helper: проверка соединения. GET /items?limit=1 — самый дешёвый
   * smoke-check, который и auth верифицирует, и связь с БД.
   */
  async ping(): Promise<{ ok: true; itemsCount?: number }> {
    const res = await this.listItems({ limit: 1 })
    return { ok: true, itemsCount: res.items.length }
  }

  /**
   * Получить инфо о магазине + расшифрованные МС-creds (если сконфигурированы
   * в админке). Tauri клиент кэширует результат в local Settings и
   * использует для МС-поллера.
   */
  async getShopMe(): Promise<ShopMeResponse> {
    return this.request<ShopMeResponse>('/api/v1/inventory/shop/me')
  }
}
