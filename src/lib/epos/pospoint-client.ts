// Клиент к кассовой программе Pospoint («мобильная касса», mobkassa.uz).
//
// Pospoint ставится на компьютер кассы вместо E-POS Communicator и слушает
// http://127.0.0.1:6461. Протокол — JSON-RPC-подобный: POST /pospoint с
// {method, id, key, version, params}; ответ — {result} или {error: [...]}
// (ошибок может быть несколько), HTTP-статус всегда 200.
//
// Главные отличия от Communicator (подробно — docs/external-apis/pospoint-erp-api.md):
//   - суммы в СУМАХ (до 2 знаков), а не в тийинах; цена — за единицу;
//   - у каждой кассы свой ключ, протокол строго "1.0.2", id — только цифры;
//   - касса выполняет запросы строго по одному — здесь очередь;
//   - ответ на чек ждать не меньше 60 с, сервер запрос не обрывает;
//   - защита от двойного чека — payCheckNumber + getReceiptByPayCheckNumber.

import { fetch } from '@tauri-apps/plugin-http'

export const POSPOINT_DEFAULT_URL = 'http://127.0.0.1:6461'
export const POSPOINT_PROTOCOL_VERSION = '1.0.2'
/**
 * Публичный тестовый ключ из документации Pospoint: касса проверяет формат
 * запроса и отвечает случайными данными, ФМ и ОФД не трогаются. Только для
 * проверки связи и формата — чек с ним не фискальный.
 */
export const POSPOINT_TEST_KEY = '41192fcccd93a9097843057e60e1da1904798f9f'

/** Ответ на чек ждём дольше минимума из документации (60 с): маркировка, медленный ФМ. */
export const POSPOINT_RECEIPT_TIMEOUT_MS = 90_000
const SHORT_TIMEOUT_MS = 20_000
/**
 * Поиск чека встаёт в очередь кассы за зависшим чеком — ждём не меньше, чем
 * требует документация для ответа на чек.
 */
const LOOKUP_TIMEOUT_MS = 60_000
const OFD_SYNC_TIMEOUT_MS = 120_000

// ── Ошибки ────────────────────────────────────────────────────────────────

export interface PospointErrorItem {
  code: number
  message: string
  data?: unknown
}

/** Касса ответила ошибкой (одной или несколькими). Чек при этом, как правило, НЕ пробит. */
export class PospointError extends Error {
  constructor(
    readonly method: string,
    readonly errors: PospointErrorItem[],
  ) {
    super(
      `Pospoint ${method}: ` +
        (errors.length ? errors.map((e) => `${e.code} ${e.message}`.trim()).join('; ') : 'ошибка без описания'),
    )
    this.name = 'PospointError'
  }

  get codes(): number[] {
    return this.errors.map((e) => e.code)
  }

  has(...codes: number[]): boolean {
    return this.errors.some((e) => codes.includes(e.code))
  }
}

/**
 * Запрос ушёл, а ответа нет (наш таймаут). Пробит ли чек — неизвестно:
 * сначала getReceiptByPayCheckNumber, потом решать.
 */
export class PospointNoAnswerError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    /** Обрыв связи уже после отправки — текст ошибки транспорта. */
    readonly transport?: string,
  ) {
    super(
      transport
        ? `Pospoint ${method}: связь оборвалась после отправки (${transport})`
        : `Pospoint ${method}: нет ответа за ${Math.round(timeoutMs / 1000)} сек`,
    )
    this.name = 'PospointNoAnswerError'
  }
}

/**
 * Касса ответила, но не так, как обещает протокол: пустое тело, не JSON,
 * пустой список ошибок, чек без номера или фискального признака. Пробит ли
 * чек — неизвестно: разбираемся так же, как при отсутствии ответа.
 */
export class PospointBadResponseError extends Error {
  constructor(
    readonly method: string,
    readonly detail: string,
  ) {
    super(`Pospoint ${method}: непонятный ответ (${detail})`)
    this.name = 'PospointBadResponseError'
  }
}

/** До программы не достучаться: не запущена, не выполнен вход или выключен «Режим интеграции». */
export class PospointUnavailableError extends Error {
  constructor(
    readonly method: string,
    cause: string,
  ) {
    super(`Pospoint ${method}: нет связи с программой (${cause})`)
    this.name = 'PospointUnavailableError'
  }
}

// ── Типы запросов и ответов ───────────────────────────────────────────────

export interface PospointSaleItem {
  name: string
  /** Единица измерения из справочника tasnif («шт»). */
  unit: string
  /** Код единицы измерения из tasnif. */
  packageCode: number
  /** ИКПУ, 17 цифр. */
  mxik: string
  /** 0 — перепродажа, 1 — собственное производство, 2 — услуга. */
  ownerType: 0 | 1 | 2
  /** Количество (штуки; для весового — дробное). */
  amount: number
  /** Цена ЗА ЕДИНИЦУ, сумы, до 2 знаков. */
  price: number
  /** НДС включён в цену: 0, 6 или 12. */
  taxPercent: number
  /** Скидка на всю позицию, сумы. */
  discount?: number
  barcode?: string
}

export interface PospointSaleParams {
  items: PospointSaleItem[]
  byCash: number
  byCard: number
  type: 'SALE'
  /** Номер документа у нас — защита от двойного пробития. */
  payCheckNumber: string
  /** 1 — корпоративная, 2 — личная. */
  cardType?: 1 | 2
  /** false — печатаем сами (наш шаблон чека). */
  print?: boolean
}

export interface PospointRefundItem {
  name: string
  mxik?: string
  barcode?: string
  amount: number
  /** Цена за единицу из чека продажи, сумы. */
  price: number
}

export interface PospointRefundParams {
  /** result.id чека продажи на этой кассе. */
  idRefundReceipt: number
  items: PospointRefundItem[]
  byCash: number
  byCard: number
  payCheckNumber: string
  cardType?: 1 | 2
  print?: boolean
}

/** Ответ на чек (и на поиск чека). Поля со значением null касса не присылает. */
export interface PospointReceiptAnswer {
  id: number
  fmNo?: string
  kkmNo?: string
  /** unix ms */
  time?: number
  /** Ссылка для QR-кода. */
  url?: string
  fiscalSign?: string
  shiftNumber?: number
}

/** getXReport: суммы в ТИЙИНАХ (целые). */
export interface PospointXReport {
  terminalId?: string
  openTime?: number
  saleCount?: number
  saleCashTotal?: number
  saleCardTotal?: number
  refundCount?: number
  refundCashTotal?: number
  refundCardTotal?: number
  /** НДС продаж минус НДС возвратов. */
  totalVat?: number
  firstReceiptSeq?: number
  lastReceiptSeq?: number
}

/** closeZReport: суммы в СУМАХ — не путать с getXReport. */
export interface PospointZReport {
  success?: boolean
  reportNumber?: number
  terminalId?: string
  openTime?: number
  closeTime?: number
  saleCount?: number
  saleCashTotal?: number
  saleCardTotal?: number
  refundCount?: number
  refundCashTotal?: number
  refundCardTotal?: number
  saleVat?: number
  refundVat?: number
  firstReceiptSeq?: number
  lastReceiptSeq?: number
}

export interface PospointFmStatus {
  isConnected: boolean
  terminalId?: string
  serialNumber?: string
  appletVersion?: string
  unsentReceiptCount?: number
}

export interface PospointOfdSync {
  terminalId?: string
  sentCount?: number
  unsentCount?: number
  zReportsSent?: boolean
}

export interface PospointMxikPackage {
  code: number
  nameRu?: string
  nameUz?: string
  nameLat?: string
}

export interface PospointMxikInfo {
  mxik: string
  name?: string
  label?: number
  cashSale?: number
  packages?: PospointMxikPackage[]
}

// ── Клиент ────────────────────────────────────────────────────────────────

export interface PospointClientOptions {
  baseUrl?: string
  key: string
  fetchImpl?: typeof fetch
  /**
   * Фоновый клиент (проверки, досылка в ОФД, справочник): его запросы
   * пропускают вперёд запросы кассира — чек не ждёт за фоновой работой,
   * кроме той, что уже выполняется.
   */
  background?: boolean
}

/**
 * Очередь запросов на каждый адрес кассы: Pospoint выполняет их строго по
 * одному. Запросы кассира идут раньше фоновых, ждущих своей очереди. Таймаут
 * запроса начинается, когда до него дошла очередь.
 */
interface Scheduler {
  busy: boolean
  high: Array<() => Promise<void>>
  low: Array<() => Promise<void>>
}
const schedulers = new Map<string, Scheduler>()

function schedule<T>(key: string, background: boolean, task: () => Promise<T>): Promise<T> {
  let s = schedulers.get(key)
  if (!s) {
    s = { busy: false, high: [], low: [] }
    schedulers.set(key, s)
  }
  const sch = s
  return new Promise<T>((resolve, reject) => {
    ;(background ? sch.low : sch.high).push(() => task().then(resolve, reject))
    void pump(sch)
  })
}

async function pump(s: Scheduler): Promise<void> {
  if (s.busy) return
  const next = s.high.shift() ?? s.low.shift()
  if (!next) return
  s.busy = true
  try {
    await next()
  } finally {
    s.busy = false
    void pump(s)
  }
}

let lastId = 0
/**
 * id запроса — только цифры (иначе 14822). Держим в пределах 9 цифр: формат
 * числа на стороне Pospoint не описан, а миллисекунды (13 цифр) могли бы не
 * влезть в 32-битное целое. Ответ и так относится к своему HTTP-запросу.
 */
function nextRequestId(): string {
  const base = Math.floor(Date.now() / 1000) % 900_000_000
  lastId = base > lastId ? base : lastId + 1
  return String(lastId)
}

/**
 * Адрес Pospoint в виде «http://хост:порт» — без пути. Кассир может ввести
 * «127.0.0.1», «127.0.0.1:6461/pospoint» или адрес из документации целиком:
 * схема по умолчанию http, порт — 6461, путь отбрасываем.
 */
export function normalizePospointBaseUrl(url: string | null | undefined): string {
  let raw = (url ?? '').trim()
  if (!raw) return POSPOINT_DEFAULT_URL
  if (!/^https?:\/\//i.test(raw)) raw = `http://${raw}`
  try {
    const u = new URL(raw)
    return `${u.protocol}//${u.hostname}:${u.port || '6461'}`
  } catch {
    return raw.replace(/\/+$/, '')
  }
}

/**
 * Ошибка транспорта до отправки запроса (соединение не установлено) — чек
 * точно не ушёл. Всё остальное (обрыв, сброс) — запрос мог дойти. Годится
 * и для других локальных программ (Communicator, FiscalDriveService): так
 * «программа выключена» отличается от «программа занята».
 */
export function isNotSent(message: string): boolean {
  return /error trying to connect|tcp connect error|refused|10061|os error 61\b|os error 111\b|dns error|failed to lookup|not allowed|scope/i.test(
    message,
  )
}

export class PospointClient {
  readonly baseUrl: string

  constructor(private readonly opts: PospointClientOptions) {
    this.baseUrl = normalizePospointBaseUrl(opts.baseUrl)
  }

  /** Сервер жив? Отвечает сразу, даже когда касса занята чеком; ФМ не проверяет. */
  async health(timeoutMs = 5_000): Promise<boolean> {
    const f = this.opts.fetchImpl ?? fetch
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await f(`${this.baseUrl}/health`, { method: 'GET', signal: ctrl.signal })
      const body = (await res.json().catch(() => null)) as { status?: string } | null
      return res.ok && body?.status === 'UP'
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  async registerSaleFull(params: PospointSaleParams): Promise<PospointReceiptAnswer> {
    return validReceipt('registerSaleFull', await this.call('registerSaleFull', params, POSPOINT_RECEIPT_TIMEOUT_MS))
  }

  async registerRefundFull(params: PospointRefundParams): Promise<PospointReceiptAnswer> {
    return validReceipt('registerRefundFull', await this.call('registerRefundFull', params, POSPOINT_RECEIPT_TIMEOUT_MS))
  }

  /**
   * Чек по нашему номеру документа; null — такого чека на кассе нет. Чек
   * без фискального признака — PospointBadResponseError: сохранить его нельзя.
   */
  async getReceiptByPayCheckNumber(payCheckNumber: string): Promise<PospointReceiptAnswer | null> {
    const r = await this.call<Partial<PospointReceiptAnswer> | null>(
      'getReceiptByPayCheckNumber',
      { payCheckNumber },
      LOOKUP_TIMEOUT_MS,
    )
    if (!r || typeof r.id !== 'number') return null
    return validReceipt('getReceiptByPayCheckNumber', r)
  }

  async getReceipt(billId: number): Promise<PospointReceiptAnswer> {
    return validReceipt('getReceipt', await this.call('getReceipt', { billId }, LOOKUP_TIMEOUT_MS))
  }

  async openZReport(): Promise<{ success?: boolean; time?: number }> {
    return checkSuccess('openZReport', await this.call('openZReport', {}, POSPOINT_RECEIPT_TIMEOUT_MS))
  }

  getXReport(): Promise<PospointXReport> {
    return this.call('getXReport', {}, SHORT_TIMEOUT_MS)
  }

  async closeZReport(): Promise<PospointZReport> {
    return checkSuccess('closeZReport', await this.call('closeZReport', {}, POSPOINT_RECEIPT_TIMEOUT_MS))
  }

  checkFmStatus(): Promise<PospointFmStatus> {
    return this.call('checkFmStatus', {}, SHORT_TIMEOUT_MS)
  }

  syncWithOfd(): Promise<PospointOfdSync> {
    return this.call('syncWithOfd', {}, OFD_SYNC_TIMEOUT_MS)
  }

  syncFmState(): Promise<{ terminalId?: string; synced?: boolean }> {
    return this.call('syncFmState', {}, SHORT_TIMEOUT_MS)
  }

  async getMxikInfo(mxik: string, timeoutMs = 30_000): Promise<PospointMxikInfo[]> {
    const r = await this.call<PospointMxikInfo[]>('getMxikInfo', { mxik, size: 5 }, timeoutMs)
    return Array.isArray(r) ? r : []
  }

  /** Один запрос к кассе, в очереди за предыдущими. */
  private call<T>(method: string, params: object, timeoutMs: number): Promise<T> {
    return schedule(this.baseUrl, !!this.opts.background, () => this.send<T>(method, params, timeoutMs))
  }

  private async send<T>(method: string, params: object, timeoutMs: number): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const body = {
      method,
      id: nextRequestId(),
      key: this.opts.key,
      version: POSPOINT_PROTOCOL_VERSION,
      params,
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    let text: string
    try {
      const res = await f(`${this.baseUrl}/pospoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      })
      text = await res.text()
    } catch (e) {
      if (ctrl.signal.aborted) throw new PospointNoAnswerError(method, timeoutMs)
      const msg = e instanceof Error ? e.message : String(e)
      if (isNotSent(msg)) throw new PospointUnavailableError(method, msg)
      // Соединение было, но оборвалось — касса могла успеть пробить чек.
      throw new PospointNoAnswerError(method, timeoutMs, msg)
    } finally {
      clearTimeout(timer)
    }

    let json: { result?: unknown; error?: unknown } | null
    try {
      json = text.trim() ? (JSON.parse(text) as typeof json) : null
    } catch {
      throw new PospointBadResponseError(method, `не JSON: ${text.slice(0, 120)}`)
    }
    if (!json || typeof json !== 'object') {
      throw new PospointBadResponseError(method, 'пустой ответ')
    }
    if (json.error !== undefined && json.error !== null) {
      const errors = normalizeErrors(json.error)
      if (errors.length === 0) throw new PospointBadResponseError(method, 'пустой список ошибок')
      throw new PospointError(method, errors)
    }
    if (!('result' in json)) throw new PospointBadResponseError(method, 'нет result')
    return json.result as T
  }
}

/** Ответ на чек годится к сохранению: есть номер и фискальный признак. */
function validReceipt(method: string, r: unknown): PospointReceiptAnswer {
  const x = r as Partial<PospointReceiptAnswer> | null
  if (!x || typeof x.id !== 'number' || !Number.isFinite(x.id) || !x.fiscalSign) {
    throw new PospointBadResponseError(method, `чек без номера или признака: ${JSON.stringify(r)?.slice(0, 160)}`)
  }
  return x as PospointReceiptAnswer
}

function checkSuccess<T extends { success?: boolean }>(method: string, r: T): T {
  if (r && r.success === false) {
    throw new PospointError(method, [{ code: -2, message: 'касса ответила success: false' }])
  }
  return r
}

/** `error` — массив по документации, но на всякий случай принимаем и одиночный объект. */
function normalizeErrors(raw: unknown): PospointErrorItem[] {
  const list = Array.isArray(raw) ? raw : [raw]
  return list.map((e) => {
    const x = (e ?? {}) as { code?: unknown; message?: unknown; data?: unknown }
    const code = typeof x.code === 'number' ? x.code : Number(x.code)
    return {
      code: Number.isFinite(code) ? code : -1,
      message: typeof x.message === 'string' ? x.message : '',
      ...(x.data !== undefined ? { data: x.data } : {}),
    }
  })
}

// ── Что значит ошибка ─────────────────────────────────────────────────────

/** Коды, при которых чек МОГ пробиться: решать только после getReceiptByPayCheckNumber. */
const UNKNOWN_OUTCOME_CODES = [-13, -32603, -32099]

/**
 * Результат неизвестен: ответа нет, внутренняя ошибка кассы или код самого
 * ФМ (их коды — десятичные 4-5-значные, вне диапазона 148xx).
 */
export function isPospointOutcomeUnknown(e: unknown): boolean {
  if (e instanceof PospointNoAnswerError || e instanceof PospointBadResponseError) return true
  if (!(e instanceof PospointError)) return false
  return e.errors.some((x) => UNKNOWN_OUTCOME_CODES.includes(x.code) || isFmCode(x.code))
}

/** Коды ФМ приходят десятичными (4240, 369xx, 370xx). */
function isFmCode(code: number): boolean {
  return code === 4240 || code === 4100 || (code >= 36864 && code <= 37375)
}
