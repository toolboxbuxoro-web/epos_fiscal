import { fetch } from '@tauri-apps/plugin-http'
import {
  formatMsMoment,
  type MsListResponse,
  type MsRetailDemand,
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

export interface MoyskladClientOptions {
  token: string
  /** Кастомный fetch (для тестов). По умолчанию — Tauri HTTP. */
  fetchImpl?: typeof fetch
  /** Прерывание (AbortSignal) — пробрасывается во все запросы. */
  signal?: AbortSignal
}

export class MoyskladClient {
  constructor(private readonly opts: MoyskladClientOptions) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', `Bearer ${this.opts.token}`)
    headers.set('Accept', 'application/json;charset=utf-8')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const res = await f(url, {
      ...init,
      headers,
      signal: init.signal ?? this.opts.signal,
    })

    if (!res.ok) {
      let body: unknown
      try {
        body = await res.json()
      } catch {
        body = await res.text()
      }
      throw new MoyskladError(
        `MoySklad ${res.status} ${res.statusText} on ${url}`,
        res.status,
        body,
      )
    }
    return (await res.json()) as T
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

  /** Проверка валидности токена. */
  async ping(): Promise<{ ok: true }> {
    await this.request<unknown>('/entity/employee?limit=1')
    return { ok: true }
  }
}
