// JSON-RPC 2.0 клиент к новому EPOS Communicator API на :3448/rpc/api.
//
// Endpoint и имена методов извлечены из декомпиляции F-Lab Market 6.6.12
// (репозиторий izzatbek1988/TestMarket, файлы 5Entities.cs–17Entities.cs).
//
// Это «современный» API Communicator. Старый /uzpos на :8347 у новых
// установок отвечает NO_SUCH_METHOD_AVAILABLE на большинство методов —
// нужно использовать этот.

import { fetch } from '@tauri-apps/plugin-http'

const DEFAULT_URL = 'http://localhost:3448/rpc/api'

export class JsonRpcEposError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly data?: unknown,
    public readonly method?: string,
  ) {
    super(message)
    this.name = 'JsonRpcEposError'
  }
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0'
  id: number | string
  result?: T
  error?: { code: number; message: string; data?: unknown }
}

export interface JsonRpcEposClientOptions {
  /** URL endpoint, по умолчанию http://localhost:3448/rpc/api */
  url?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
  timeoutMs?: number
}

// ── Доменные типы (имена полей строго как в JSON, big-endian PascalCase) ──

/** Позиция чека. Все денежные значения — в тийинах. Amount — в тысячных. */
export interface JsonRpcItem {
  Price: number
  Discount: number
  Barcode: string
  Amount: number
  VAT: number
  Name: string
  Other: number
  /** ИКПУ. В декомпиле GBS поле отсутствует, но в реальном API
   * актуальной версии Communicator скорее всего обязательно. Добавляем
   * опционально — если сервер не знает поле, оно игнорируется. */
  ClassCode?: string
  PackageCode?: string
  VATPercent?: number
  Label?: string
  CommissionTIN?: string
  OwnerType?: 0 | 1 | 2
}

export interface JsonRpcReceipt {
  /** ISO datetime: "2026-05-01T15:30:00". */
  Time: string
  Items: JsonRpcItem[]
  ReceivedCash: number
  ReceivedCard: number
}

export interface JsonRpcFiscalAnswer {
  AppletVersion: string
  QRCodeURL: string
  TerminalID: string
  ReceiptSeq: string
  /** Формат YYYYMMDDHHMMSS или "YYYY-MM-DD HH:MM:SS". */
  DateTime: string
  FiscalSign: string
}

export interface JsonRpcStatusAnswer {
  StartTime?: string
  Sender?: {
    LiveAddress?: string
    LastSendReceiveDuration?: string
    LastOnlineTime?: string
    TotalFilesSent?: Record<string, number>
    FullReceiptFilesSent?: Record<string, number>
  }
  DB?: { ArchivedFiles?: Record<string, number> }
}

// ── Клиент ─────────────────────────────────────────────────────────────

export class JsonRpcEposClient {
  private readonly url: string
  private nextId = 1

  constructor(private readonly opts: JsonRpcEposClientOptions = {}) {
    this.url = opts.url ?? DEFAULT_URL
  }

  /** Сырой JSON-RPC вызов. Никаких побочных эффектов до вашего вызова. */
  async call<T = unknown>(method: string, params: object = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const id = this.nextId++
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })

    const ctrl = new AbortController()
    const timer =
      this.opts.timeoutMs !== undefined
        ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs)
        : null

    let res: Response
    try {
      res = await f(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body,
        signal: ctrl.signal,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new JsonRpcEposError(
        `EPOS JSON-RPC HTTP ${res.status}: ${text}`,
        undefined,
        text,
        method,
      )
    }

    const data = (await res.json()) as JsonRpcResponse<T>
    if (data.error) {
      throw new JsonRpcEposError(
        data.error.message,
        data.error.code,
        data.error.data,
        method,
      )
    }
    return data.result as T
  }

  // ── Read-only методы ────────────────────────────────────────────

  /** Полный статус Communicator: связь с ОФД, отправленные файлы, terminal id. */
  status(): Promise<JsonRpcStatusAnswer> {
    return this.call('Api.Status')
  }

  /** Кол-во чеков в локальной БД и applet версия. */
  getReceiptCount(): Promise<{ Count: number; AppletVersion: string }> {
    return this.call('Api.GetReceiptCount')
  }

  /** Кол-во неотправленных в ОФД чеков + terminal id. */
  getUnsentCount(): Promise<{ Count: number; TerminalID: unknown }> {
    return this.call('Api.GetUnsentCount')
  }

  // ── Фискальные методы (write) ──────────────────────────────────

  /** Открыть смену. Идемпотентно: если уже открыта — вернёт ошибку, не сломает. */
  openZReport(time: Date = new Date()): Promise<{ AppletVersion: string }> {
    return this.call('Api.OpenZReport', { Time: this.formatTime(time) })
  }

  /** Закрыть смену. */
  closeZReport(): Promise<{ AppletVersion: string }> {
    return this.call('Api.CloseZReport')
  }

  /** Отправить чек продажи. Возвращает фискальный признак. */
  sendSaleReceipt(receipt: JsonRpcReceipt): Promise<JsonRpcFiscalAnswer> {
    return this.call('Api.SendSaleReceipt', { Receipt: receipt })
  }

  /** Отправить чек возврата. */
  sendRefundReceipt(receipt: JsonRpcReceipt): Promise<JsonRpcFiscalAnswer> {
    return this.call('Api.SendRefundReceipt', { Receipt: receipt })
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Формат даты для Communicator: "2026-05-01 15:30:00" (Go reference time).
   *
   * ВАЖНО: пробел между датой и временем, НЕ `T`. Communicator написан на Go
   * и парсит парсером `time.Parse("2006-01-02 15:04:05", ...)`. Если послать
   * ISO с `T` — получаем `cannot parse "T..." as " "` (illegal argument).
   *
   * Время — локальное (а не UTC), потому что Communicator работает в local TZ
   * терминала (Asia/Tashkent в нашем случае).
   */
  private formatTime(d: Date): string {
    return formatGoTime(d)
  }
}

/**
 * Форматировать дату в Go-style "2006-01-02 15:04:05" (локальное время).
 * Экспортируется чтобы fiscalize.ts использовал тот же формат.
 */
export function formatGoTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  )
}
