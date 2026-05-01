import { fetch } from '@tauri-apps/plugin-http'
import {
  formatMsMoment,
  type MsEmployee,
  type MsListResponse,
  type MsRetailDemand,
  type MsRetailStore,
} from './types'

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2'

export class MoyskladError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MoyskladError'
  }
}

/**
 * Закодировать login:password в base64 для Basic Auth.
 *
 * btoa(unescape(encodeURIComponent(...))) — стандартный приём для
 * корректной обработки не-ASCII символов в логине/пароле.
 */
export function makeBasicCredentials(login: string, password: string): string {
  return btoa(unescape(encodeURIComponent(`${login}:${password}`)))
}

export interface MoyskladClientOptions {
  /**
   * Один из двух:
   *   - `basic`: base64 от "login:password" — Authorization: Basic <basic>
   *   - `token`: Bearer токен — Authorization: Bearer <token>
   * Если оба — приоритет у `basic`.
   */
  basic?: string
  token?: string
  /** Кастомный fetch (для тестов). */
  fetchImpl?: typeof fetch
  /** Прерывание (AbortSignal). */
  signal?: AbortSignal
}

export class MoyskladClient {
  constructor(private readonly opts: MoyskladClientOptions) {
    if (!opts.basic && !opts.token) {
      throw new Error('MoyskladClient requires either `basic` or `token`')
    }
  }

  private authHeader(): string {
    if (this.opts.basic) return `Basic ${this.opts.basic}`
    return `Bearer ${this.opts.token}`
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', this.authHeader())
    headers.set('Accept', 'application/json;charset=utf-8')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const res = await f(url, {
      ...init,
      headers,
      signal: init.signal ?? this.opts.signal,
    })

    // Читаем тело один раз — повторное чтение даёт "Body is disturbed or locked".
    const text = await res.text()
    let body: unknown = text
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        // оставляем text как есть
      }
    }

    if (!res.ok) {
      // Достаём осмысленное сообщение из ответа МойСклад, если есть.
      const errMsg =
        (body as { errors?: Array<{ error?: string }> })?.errors?.[0]?.error ??
        `MoySklad ${res.status} ${res.statusText} on ${path}`
      throw new MoyskladError(errMsg, res.status, body)
    }
    return body as T
  }

  // ── retaildemand ────────────────────────────────────────────

  /**
   * Получить розничные продажи, обновлённые с указанного момента.
   * Идеально для поллинга: передаём lastSync, получаем только новые/изменённые.
   *
   * @param updatedFrom — epoch секунды (МойСклад принимает дату с миллисекундами)
   * @param limit — максимум 1000 за запрос
   */
  async listRecentRetailDemands(
    updatedFrom: number,
    limit = 100,
  ): Promise<MsRetailDemand[]> {
    const params = new URLSearchParams()
    params.set('filter', `updated>${formatMsMoment(updatedFrom)}`)
    params.set('order', 'updated,asc')
    params.set('limit', String(Math.min(limit, 1000)))
    params.set('expand', 'positions.assortment')

    const res = await this.request<MsListResponse<MsRetailDemand>>(
      `/entity/retaildemand?${params.toString()}`,
    )
    return res.rows
  }

  /** Получить одну розничную продажу по UUID. */
  async getRetailDemand(id: string, expand = 'positions.assortment'): Promise<MsRetailDemand> {
    const params = new URLSearchParams()
    if (expand) params.set('expand', expand)
    return this.request<MsRetailDemand>(
      `/entity/retaildemand/${id}?${params.toString()}`,
    )
  }

  /** Проверка валидности credentials. Возвращает информацию о текущем пользователе. */
  async getMe(): Promise<MsEmployee> {
    return this.request<MsEmployee>('/context/employee')
  }

  /** Получить активные торговые точки. */
  async listRetailStores(): Promise<MsRetailStore[]> {
    const res = await this.request<MsListResponse<MsRetailStore>>(
      '/entity/retailstore?limit=100',
    )
    return res.rows.filter((s) => s.archived !== true)
  }

  /** Получить активных сотрудников (кассиров). */
  async listEmployees(): Promise<MsEmployee[]> {
    const res = await this.request<MsListResponse<MsEmployee>>(
      '/entity/employee?limit=200',
    )
    return res.rows.filter((e) => e.archived !== true)
  }
}
