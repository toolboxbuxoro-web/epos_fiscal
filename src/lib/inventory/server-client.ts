/**
 * Клиент для общения с Toolbox Fiscal Inventory API на mytoolbox-сервере.
 *
 * Все запросы идут через Bearer-аутентификацию (api_key per-shop).
 * `tauri-plugin-http` (reqwest) — потому что обычный fetch'у CORS мешает,
 * + capabilities в `default.json` уже разрешают `localhost`/`192.168.*`/MS.
 *
 * При деплое нужно дописать домен mytoolbox в capabilities (или сделать
 * broad allow по нашей домену, см. CLAUDE.md «не сужать allow-list»).
 */

import { fetchWithTimeout } from '../http'
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
  UnconsumeRequest,
  UnconsumeResponse,
} from './types'

/**
 * Потолок ожидания ответа сервера. Резерв/подтверждение делаются, пока кассир
 * стоит у чека, — ждать дольше нет смысла, лучше показать ошибку и повторить.
 */
const REQUEST_TIMEOUT_MS = 20_000

/**
 * Потолок для объёмных выгрузок (полный список приходов).
 *
 * Отдельный от `REQUEST_TIMEOUT_MS` намеренно: страница из 1000 позиций —
 * это сотни килобайт, и на канале магазина она может идти дольше, чем
 * короткий резерв. Оборвать её по «кассирскому» таймауту значит вернуть
 * поломку со stale-кэшем: sync не доходит до конца, локальный справочник
 * устаревает, и подбор начинает биться о несуществующие остатки.
 */
const BULK_TIMEOUT_MS = 60_000

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
  /**
   * Один запрос к inventory-серверу с ПОВТОРОМ на кратковременных сбоях шлюза.
   *
   * Зачем: сервер живёт на Railway, и при каждом деплое он на несколько секунд
   * отдаёт 502. Раньше кассир в этот момент получал «Сервер inventory
   * недоступен, попробуйте через минуту» посреди продажи и жал
   * «Фискализировать» заново (реальный случай 20.08 у Дон бозори).
   *
   * Повторяем ТОЛЬКО транзиентное: 502/503/504 и сетевые обрывы. Бизнес-ответы
   * (409 «товар закончился», 400, 401) отдаём сразу — их повтор не исправит,
   * а задержка навредит.
   *
   * Повтор безопасен: и `reserve` (идемпотентен по shop_id+ms_receipt_id →
   * idempotent_replay), и `confirm` (идемпотентен по статусу резервации)
   * рассчитаны на повторную отправку — см. CLAUDE.md, раздел про атомарность.
   */
  private async request<T>(
    path: string,
    init: RequestInit & { allowStatuses?: number[]; timeoutMs?: number } = {},
  ): Promise<T> {
    const TRANSIENT = new Set([502, 503, 504])
    const MAX_ATTEMPTS = 3
    const BACKOFF_MS = [400, 1200]

    let lastErr: unknown
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.requestOnce<T>(path, init)
      } catch (e) {
        lastErr = e
        const status = e instanceof InventoryServerError ? e.status : undefined
        // Сетевой обрыв (status undefined) или транзиентный код шлюза.
        const retriable = status === undefined || TRANSIENT.has(status)
        if (!retriable || attempt === MAX_ATTEMPTS) throw e
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 1200))
      }
    }
    throw lastErr
  }

  private async requestOnce<T>(
    path: string,
    init: RequestInit & { allowStatuses?: number[]; timeoutMs?: number } = {},
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
    // Таймаут обязателен: без него зависший запрос к серверу блокирует
    // кассу на неопределённое время (fetch сам по себе не сдаётся никогда).
    const res = await fetchWithTimeout(
      url,
      { ...init, headers },
      init.timeoutMs ?? REQUEST_TIMEOUT_MS,
      `${init.method ?? 'GET'} ${path}`,
    )
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

  /**
   * Вернуть остаток в пул после refund.
   *
   * Идемпотентно через `refund_fiscal_sign` — двойной вызов не двинет
   * остаток повторно.
   *
   * Разрешаем 404 (endpoint ещё не задеплоен) и 409 (conflict —
   * ALREADY_UNCONSUMED это OK с точки зрения идемпотентности).
   *
   * Если 404 — caller (`processRefund`) кладёт операцию в локальный
   * `inv_pending_confirms` с op_type='unconsume' для повторной попытки.
   */
  async unconsume(req: UnconsumeRequest): Promise<UnconsumeResponse> {
    return this.request<UnconsumeResponse>('/api/v1/inventory/unconsume', {
      method: 'POST',
      body: JSON.stringify(req),
      allowStatuses: [404, 409],
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
      { timeoutMs: BULK_TIMEOUT_MS },
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
