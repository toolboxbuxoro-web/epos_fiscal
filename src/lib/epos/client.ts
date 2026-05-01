import { fetch } from '@tauri-apps/plugin-http'
import type {
  CommunicatorRequest,
  CommunicatorResponse,
  FiscalReceiptInfo,
} from './types'

export class EposError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
    public readonly method?: string,
  ) {
    super(message)
    this.name = 'EposError'
  }
}

export interface EposClientOptions {
  /** Базовый URL Communicator, обычно http://localhost:8347/uzpos. */
  url: string
  /** Фиксированный токен из доки. */
  token: string
  /** Кастомный fetch (тесты). */
  fetchImpl?: typeof fetch
  /** Таймаут запроса, ms. */
  timeoutMs?: number
}

export class EposClient {
  constructor(private readonly opts: EposClientOptions) {}

  /** Низкоуровневый вызов: подставляет token, кидает EposError при error=true. */
  async call<T = unknown>(
    payload: Omit<CommunicatorRequest, 'token'>,
  ): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const body: CommunicatorRequest = {
      token: this.opts.token,
      ...payload,
    } as CommunicatorRequest

    const ctrl = new AbortController()
    const timer =
      this.opts.timeoutMs !== undefined
        ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs)
        : null

    let res: Response
    try {
      res = await f(this.opts.url, {
        method: 'POST',
        // Точная форма из документации Communicator и реальных интеграций
        // (GBS Market UzPosDriver.cs, ismatovbotir/RSGposServer).
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new EposError(
        `Communicator HTTP ${res.status} ${res.statusText}`,
        res.status,
        text,
      )
    }

    const data = (await res.json()) as CommunicatorResponse<T>
    if (data.error) {
      throw new EposError(data.message, undefined, data, payload.method)
    }
    return data.message
  }

  // ── удобные обёртки ────────────────────────────────────────────

  async getVersion(): Promise<string> {
    return this.call<string>({ method: 'getVersion' })
  }

  async checkStatus(): Promise<unknown> {
    return this.call({ method: 'checkStatus' })
  }

  async openZReport(): Promise<unknown> {
    return this.call({ method: 'openZreport' })
  }

  async closeZReport(): Promise<unknown> {
    return this.call({ method: 'closeZreport' })
  }

  async getLastRegisteredReceipt(): Promise<FiscalReceiptInfo> {
    return this.call<FiscalReceiptInfo>({ method: 'getLastRegisteredReceipt' })
  }

  async sale(
    payload: Omit<CommunicatorRequest, 'token' | 'method'>,
  ): Promise<unknown> {
    return this.call({ ...payload, method: 'sale' } as CommunicatorRequest)
  }

  async fastSale(
    payload: Omit<CommunicatorRequest, 'token' | 'method'>,
  ): Promise<unknown> {
    return this.call({ ...payload, method: 'fastSale' } as CommunicatorRequest)
  }
}
