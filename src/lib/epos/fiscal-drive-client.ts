// REST-клиент к FiscalDriveService на http://localhost:3449.
//
// Отличия от E-POS Communicator JSON-RPC:
//   - Протокол: REST (path-based) вместо JSON-RPC
//   - Регистрация чека: 2 шага — GetTXID → RegisterTXID (retry-safe)
//   - Идентификация ФМ: FactoryID в URL (серийник USB-карты)
//   - Поле ИКПУ: SPIC (uppercase), а не spic (lowercase)
//   - Поле Units (OKEI) обязательно — у JSON-RPC его нет
//
// Документация: docs/external-apis/fiscal-drive-service.md

import { fetch } from '@tauri-apps/plugin-http'
import type { JsonRpcZReportInfo } from './jsonrpc-client'
import type { FiscalReceiptInfo } from './types'

export const FISCAL_DRIVE_DEFAULT_URL = 'http://localhost:3449'

/**
 * OKEI-код единицы измерения «штука» по умолчанию.
 *
 * ⚠️ TODO: подтвердить точный код у E-POS. Стандартный ОКЕИ-код штуки = 796,
 * но FiscalDriveService может использовать другую кодировку.
 * Примеры в доке показывают значения 244272402 и 142235374 — они явно не
 * совпадают со стандартными 3-значными ОКЕИ-кодами. Нужно тестировать на
 * реальном ФМ магазина 2 (Хазрати Имом).
 */
export const OKEI_PIECE_DEFAULT = 796

export class FiscalDriveError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly path?: string,
  ) {
    super(message)
    this.name = 'FiscalDriveError'
  }
}

// ── Типы JSON-чека FiscalDriveService ────────────────────────────────────────

export interface FiscalDriveLocation {
  Latitude: number
  Longitude: number
}

/** Позиция чека FiscalDriveService. Денежные значения в тийинах, количество в тысячных. */
export interface FiscalDriveItem {
  Name: string
  Barcode: string
  /** ИКПУ (uppercase — отличается от `spic` в JSON-RPC Communicator!). */
  SPIC: string
  /**
   * ОКЭИ-код единицы измерения. Обязательное поле (в отличие от JSON-RPC).
   * Дефолт: OKEI_PIECE_DEFAULT (штука). TODO: уточнить точный код у E-POS.
   */
  Units: number
  PackageCode: string
  /** 0=перепродажа, 1=производитель, 2=услуга. */
  OwnerType: 0 | 1 | 2
  /** Количество в тысячных (1000 = 1 шт). */
  Amount: number
  /** Сумма позиции до скидки, тийины. */
  Price: number
  /** Скидка, тийины. */
  Discount: number
  /** Прочие, тийины. */
  Other: number
  VATPercent: number
  VAT: number
}

export interface FiscalDriveExtraInfo {
  /** Тип карты: 1=корпоративная, 2=личная. Соответствует нашему card_kind. */
  CardType?: 1 | 2
  TIN?: string
  PINFL?: string
  PhoneNumber?: string
}

/**
 * Ссылка на оригинальный чек при возврате.
 * Формат DateTime — строго 14 цифр YYYYMMDDHHMMSS (как в JSON-RPC refundInfo).
 */
export interface FiscalDriveRefundInfo {
  TerminalID: string
  /** Порядковый номер оригинального чека (строка или число). */
  ReceiptSeq: string | number
  /** Дата+время оригинала: 14 цифр YYYYMMDDHHMMSS без разделителей. */
  DateTime: string
  FiscalSign: string
}

export interface FiscalDriveReceipt {
  /** Go-style "2026-06-02 10:43:56" (с пробелом, локальное время). */
  Time: string
  ReceivedCash: number
  ReceivedCard: number
  /** 0=обычный (покупка), 1=аванс, 2=кредит. */
  Type: 0 | 1 | 2
  /** 0=продажа, 1=возврат. */
  Operation: 0 | 1
  Location?: FiscalDriveLocation
  Items: FiscalDriveItem[]
  ExtraInfo?: FiscalDriveExtraInfo
  /** Только для возврата (Operation=1). */
  RefundInfo?: FiscalDriveRefundInfo
}

export interface FiscalDriveFiscalAnswer {
  TerminalID: string
  ReceiptSeq: number | string
  DateTime: string
  FiscalSign: string
  QRCodeURL: string
}

export interface FiscalDriveDriveInfo {
  FactoryID: string
  ReaderName: string
  ATR: string
  AppletVersion: string
  Description?: string
}

export interface FiscalDriveInfo {
  AppletVersion: string
  TerminalID: string
  Locked: boolean
  POSLocked: boolean
  POSAuth: boolean
}

/** Ответ /FiscalDrive/ZReport/Info — вложенные объекты Sale/Refund. */
export interface FiscalDriveZReportRaw {
  TerminalID: string
  OpenTime: string
  /** Пустая строка пока смена открыта. */
  CloseTime: string
  TotalSaleCount: number
  TotalRefundCount: number
  TotalCash: { Sale: number; Refund: number }
  TotalCard: { Sale: number; Refund: number }
  TotalVAT: { Sale: number; Refund: number }
  FirstReceiptSeq: number | string
  LastReceiptSeq: number | string
}

// ── Клиент ─────────────────────────────────────────────────────────────────

export interface FiscalDriveClientOptions {
  baseUrl?: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class FiscalDriveClient {
  private readonly baseUrl: string

  constructor(private readonly opts: FiscalDriveClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? FISCAL_DRIVE_DEFAULT_URL).replace(/\/$/, '')
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const url = `${this.baseUrl}${path}`

    const ctrl = new AbortController()
    const timer =
      this.opts.timeoutMs !== undefined
        ? setTimeout(() => ctrl.abort(), this.opts.timeoutMs)
        : null

    let res: Response
    try {
      res = await f(url, {
        method,
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      })
    } finally {
      if (timer) clearTimeout(timer)
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new FiscalDriveError(
        `FiscalDriveService HTTP ${res.status}: ${text}`,
        res.status,
        path,
      )
    }

    const text = await res.text()
    // API возвращает "OK" строкой для open/close ZReport
    if (text.trim() === '"OK"' || text.trim() === 'OK') return 'OK' as unknown as T
    return JSON.parse(text) as T
  }

  /** Список подключённых ФМ-карт. FactoryID первой = актуальный серийник. */
  listDrives(): Promise<FiscalDriveDriveInfo[]> {
    return this.request('POST', '/FiscalDrive/List')
  }

  /** Состояние ФМ: Locked, TerminalID, версия апплета. */
  getInfo(factoryId: string): Promise<FiscalDriveInfo> {
    return this.request('POST', `/FiscalDrive/Info/${enc(factoryId)}`)
  }

  /** Открыть смену. */
  openZReport(factoryId: string): Promise<'OK'> {
    return this.request('POST', `/FiscalDrive/ZReport/Open/${enc(factoryId)}`)
  }

  /** Закрыть смену. */
  closeZReport(factoryId: string): Promise<'OK'> {
    return this.request('POST', `/FiscalDrive/ZReport/Close/${enc(factoryId)}`)
  }

  /**
   * Информация о Z/X-отчёте по индексу в памяти ФМ.
   *
   * Index 0 — самый первый, последний = ZReportsCount-1. Для текущей открытой
   * смены нужно передать индекс текущего (нужно получить через FiscalMemory/Info
   * или listDrives). Если данные не найдены — возвращает null.
   *
   * ⚠️ TODO: уточнить какой Index соответствует текущей открытой смене.
   * Нужно протестировать на реальном FiscalDriveService (магазин 2).
   */
  async getZReportInfo(factoryId: string, index = 0): Promise<FiscalDriveZReportRaw | null> {
    try {
      return await this.request<FiscalDriveZReportRaw>(
        'POST',
        `/FiscalDrive/ZReport/Info/${enc(factoryId)}?Index=${index}`,
      )
    } catch (e) {
      if (e instanceof FiscalDriveError && (e.statusCode === 404 || e.statusCode === 400)) {
        return null
      }
      throw e
    }
  }

  /**
   * Шаг 1: записать JSON-чек в БД FiscalDriveService, получить TXID.
   *
   * Retry-safe: если этот же чек уже записан (после сбоя связи) — вернёт
   * тот же TXID, не создаст дубликат.
   */
  getReceiptTXID(factoryId: string, receipt: FiscalDriveReceipt): Promise<number> {
    return this.request('POST', `/FiscalDrive/Receipt/GetTXID/${enc(factoryId)}`, receipt)
  }

  /**
   * Шаг 2: зарегистрировать чек в ФМ по TXID. Возвращает FiscalSign + QR.
   *
   * Retry-safe: при повторном вызове того же TXID ФМ возвращает результат
   * первой регистрации без дубликата — это ключевое отличие от JSON-RPC.
   */
  registerReceiptTXID(factoryId: string, txid: number): Promise<FiscalDriveFiscalAnswer> {
    return this.request('POST', `/FiscalDrive/Receipt/RegisterTXID/${enc(factoryId)}`, txid)
  }
}

// ── Mappers ─────────────────────────────────────────────────────────────────

/**
 * Маппинг ответа ZReport/Info (FDS) → JsonRpcZReportInfo (наш единый формат).
 *
 * Различия:
 *   FDS:      TotalCash.Sale / TotalCard.Sale / TotalVAT.Sale (вложенные)
 *   JSON-RPC: плоские TotalSaleCash / TotalSaleCard / TotalSaleVAT
 *
 *   FDS не возвращает Number (номер смены) — ставим 0.
 *   FDS не возвращает AppletVersion в ZReport — ставим ''.
 */
export function mapFdsZReportToJsonRpc(raw: FiscalDriveZReportRaw): JsonRpcZReportInfo {
  return {
    TerminalID: raw.TerminalID,
    Number: 0,
    Count: 0,
    OpenTime: raw.OpenTime,
    CloseTime: raw.CloseTime,
    FirstReceiptSeq: String(raw.FirstReceiptSeq),
    LastReceiptSeq: String(raw.LastReceiptSeq),
    TotalSaleCount: raw.TotalSaleCount,
    TotalSaleCash: raw.TotalCash.Sale,
    TotalSaleCard: raw.TotalCard.Sale,
    TotalSaleVAT: raw.TotalVAT.Sale,
    TotalRefundCount: raw.TotalRefundCount,
    TotalRefundCash: raw.TotalCash.Refund,
    TotalRefundCard: raw.TotalCard.Refund,
    TotalRefundVAT: raw.TotalVAT.Refund,
    AppletVersion: '',
  }
}

/**
 * Маппинг FiscalDriveFiscalAnswer → FiscalReceiptInfo (наш унифицированный тип).
 * Одинаковый формат ответа что у JSON-RPC, что у FDS — ReceiptSeq нормализуем в строку.
 */
export function mapFdsFiscalAnswer(answer: FiscalDriveFiscalAnswer): FiscalReceiptInfo {
  return {
    TerminalID: answer.TerminalID,
    ReceiptSeq: String(answer.ReceiptSeq),
    DateTime: answer.DateTime,
    FiscalSign: answer.FiscalSign,
    QRCodeURL: answer.QRCodeURL,
  }
}

function enc(s: string): string {
  return encodeURIComponent(s)
}
