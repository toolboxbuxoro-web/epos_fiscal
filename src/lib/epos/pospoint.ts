// Фискализация через Pospoint: перевод нашего чека в их формат, отправка с
// защитой от двойного пробития, возврат, X/Z-отчёт и понятные кассиру ошибки.
//
// Наш чек (подбор) хранит строки как «сумма за всё количество до скидки» в
// тийинах. Pospoint ждёт цену ЗА ЕДИНИЦУ в сумах и скидку суммой на строку.
// Цену за единицу округляем вверх до ЦЕЛОГО сума (на ленте нет тийинов, и
// касса не теряет тийин на неточном двоичном представлении), излишек — в
// скидку строки: сумма чека совпадает до тийина. Проверено на 4 845 реальных
// чеках: ни одного нарушения правил кассы ни для продажи, ни для возврата.
//
// В fiscal_receipts.request_json кладём и то, что ушло в Pospoint (без
// ключа кассы), и тот же чек в нашем общем виде (`receipt`, как у
// FiscalDriveService) — его читают История, возвраты и синк продаж.
//
// Неизвестный исход (нет ответа, обрыв, сбой ФМ) не значит «не пробит»:
// попытка остаётся в журнале (SettingKey.PospointPending), и следующий
// запуск того же документа сначала спрашивает Pospoint, пробит ли он.

import { getSetting, setSetting, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'
import { formatGoTime, type JsonRpcZReportInfo } from './jsonrpc-client'
import {
  isPospointOutcomeUnknown,
  POSPOINT_TEST_KEY,
  PospointBadResponseError,
  PospointClient,
  PospointError,
  PospointNoAnswerError,
  PospointUnavailableError,
  type PospointReceiptAnswer,
  type PospointRefundItem,
  type PospointRefundParams,
  type PospointSaleItem,
  type PospointSaleParams,
  type PospointXReport,
  type PospointZReport,
} from './pospoint-client'
import type { FiscalReceiptInfo } from './types'

// ── Ошибки ────────────────────────────────────────────────────────────────

/** Ошибка, текст которой показываем кассиру как есть (см. error-message.ts). */
export class PospointUserError extends Error {
  readonly userFacing = true
  constructor(
    message: string,
    readonly codes: number[] = [],
  ) {
    super(message)
    this.name = 'PospointUserError'
  }
}

/**
 * Пробит ли чек — неизвестно. Попытка остаётся в журнале; повтор того же
 * документа сначала спросит Pospoint и второй чек не пробьёт.
 */
export class PospointOutcomeUnknownError extends PospointUserError {
  readonly outcomeUnknown = true
  constructor(
    message: string,
    codes: number[] = [],
    /** ФМ, судя по X-отчёту, мог подписать чек без записи в Pospoint. */
    readonly fmMaySigned = false,
  ) {
    super(message, codes)
    this.name = 'PospointOutcomeUnknownError'
  }
}

// ── Версия апплета ФМ ─────────────────────────────────────────────────────

/**
 * Одни и те же коды ФМ значат разное на апплетах 3 и 4 (36912, 36913, 36897).
 * Версию узнаёт фоновая проверка (checkFmStatus); null — ещё не знаем.
 */
let knownApplet: string | null = null

export function setPospointApplet(v: string | null | undefined): void {
  if (v) knownApplet = String(v)
}

function isApplet4(): boolean | null {
  return knownApplet ? /^0?4/.test(knownApplet) : null
}

// ── Строка чека ───────────────────────────────────────────────────────────

/** То, что нужно от строки подбора (MatchCandidate и HolisticLine подходят как есть). */
export interface PospointLine {
  esfItem: {
    name: string
    class_code: string
    package_code: string | null
    owner_type: number | null
    vat_percent: number
    barcode: string | null
  }
  /** Тысячные: 1000 = 1 шт. */
  quantity: number
  /** Сумма строки до скидки, тийины. */
  priceTiyin: number
  discountTiyin: number
}

export interface PospointUnit {
  packageCode: number
  unit: string
}

/** Строка в нашем общем виде — как у FiscalDriveService (см. request-json.ts). */
export interface StoredReceiptItem {
  Name: string
  SPIC: string
  Amount: number
  Price: number
  Discount: number
  VAT: number
  VATPercent: number
  Barcode: string
  PackageCode: string
  OwnerType: 0 | 1 | 2
}

const VALID_TAX = [0, 6, 12]

function vatIncluded(totalTiyin: number, percent: number): number {
  if (percent <= 0) return 0
  return Math.round((totalTiyin * percent) / (100 + percent))
}

function ownerTypeOf(v: number | null | undefined): 0 | 1 | 2 {
  return v === 1 || v === 2 ? v : 0
}

function barcodeOf(v: string | null | undefined): string | undefined {
  const b = (v ?? '').trim()
  return b && b !== '0' ? b : undefined
}

/**
 * Строка подбора → позиция Pospoint + та же строка в нашем общем виде.
 *
 * Цена за единицу — вверх до целого сума, излишек уходит в скидку:
 * price × amount − discount равно сумме строки до тийина.
 */
export function toPospointItem(line: PospointLine, unit: PospointUnit): {
  item: PospointSaleItem
  stored: StoredReceiptItem
} {
  const { esfItem } = line
  const name = esfItem.name
  const q = line.quantity
  if (!(q > 0)) throw new PospointUserError(`У товара «${name}» количество ${q / 1000} — так пробить нельзя.`)
  if (!VALID_TAX.includes(esfItem.vat_percent)) {
    throw new PospointUserError(
      `У товара «${name}» ставка НДС ${esfItem.vat_percent}% — Pospoint принимает только 0, 6 или 12 %.`,
    )
  }
  if (!/^\d{17}$/.test(esfItem.class_code ?? '')) {
    throw new PospointUserError(
      `У товара «${name}» ИКПУ «${esfItem.class_code ?? ''}» — нужно 17 цифр. Исправьте приход в админке.`,
    )
  }
  if (!(line.priceTiyin > 0)) throw new PospointUserError(`У товара «${name}» нулевая цена — так пробить нельзя.`)
  if (line.discountTiyin < 0 || line.discountTiyin > line.priceTiyin) {
    throw new PospointUserError(`У товара «${name}» скидка больше цены строки — так пробить нельзя.`)
  }

  let unitTiyin: number
  let grossTiyin: number
  if (q % 1000 === 0) {
    const pcs = q / 1000
    unitTiyin = Math.ceil(line.priceTiyin / (pcs * 100)) * 100
    grossTiyin = unitTiyin * pcs
  } else {
    // Весовой товар: цена за единицу тоже целыми сумами; сумму строки
    // округляем вниз — она всё равно не меньше суммы подбора.
    unitTiyin = Math.ceil((line.priceTiyin * 1000) / q / 100) * 100
    grossTiyin = Math.floor((unitTiyin * q) / 1000)
  }
  const discountTiyin = line.discountTiyin + (grossTiyin - line.priceTiyin)
  const barcode = barcodeOf(esfItem.barcode)

  const item: PospointSaleItem = {
    name,
    unit: unit.unit,
    packageCode: unit.packageCode,
    mxik: esfItem.class_code,
    ownerType: ownerTypeOf(esfItem.owner_type),
    amount: q / 1000,
    price: unitTiyin / 100,
    taxPercent: esfItem.vat_percent,
    ...(discountTiyin > 0 ? { discount: discountTiyin / 100 } : {}),
    ...(barcode ? { barcode } : {}),
  }
  const stored: StoredReceiptItem = {
    Name: name,
    SPIC: esfItem.class_code,
    Amount: q,
    Price: grossTiyin,
    Discount: discountTiyin,
    VAT: vatIncluded(grossTiyin - discountTiyin, esfItem.vat_percent),
    VATPercent: esfItem.vat_percent,
    Barcode: barcode ?? '0',
    PackageCode: String(unit.packageCode || ''),
    OwnerType: ownerTypeOf(esfItem.owner_type),
  }
  return { item, stored }
}

const CARD_TYPE: Record<'fiz' | 'corp', 1 | 2> = { corp: 1, fiz: 2 }

export interface PospointSaleBuild {
  params: PospointSaleParams
  /** Для fiscal_receipts.request_json — без ключа кассы. */
  requestJson: string
  /** Строки в нашем общем виде — то, что реально ушло в ОФД (для печати). */
  stored: StoredReceiptItem[]
}

/** Собрать продажу. Суммы оплаты — тийины, как во всей программе. */
export function buildPospointSale(input: {
  lines: PospointLine[]
  unitOf: (line: PospointLine) => PospointUnit
  receivedCash: number
  receivedCard: number
  cardKind?: 'fiz' | 'corp'
  payCheckNumber: string
  now?: Date
}): PospointSaleBuild {
  const converted = input.lines.map((l) => toPospointItem(l, input.unitOf(l)))
  const total = converted.reduce((s, c) => s + c.stored.Price - c.stored.Discount, 0)
  const paid = input.receivedCash + input.receivedCard
  if (Math.abs(total - paid) > 1) {
    throw new Error(`Pospoint: сумма позиций ${total} ≠ оплате ${paid} (тийины) — чек не отправлен`)
  }
  const params: PospointSaleParams = {
    items: converted.map((c) => c.item),
    byCash: input.receivedCash / 100,
    byCard: input.receivedCard / 100,
    type: 'SALE',
    payCheckNumber: input.payCheckNumber,
    print: false,
    ...(input.receivedCard > 0 && input.cardKind ? { cardType: CARD_TYPE[input.cardKind] } : {}),
  }
  const stored = converted.map((c) => c.stored)
  const requestJson = JSON.stringify({
    backend: 'pospoint',
    method: 'registerSaleFull',
    payCheckNumber: input.payCheckNumber,
    params,
    receipt: {
      Time: formatGoTime(input.now ?? new Date()),
      ReceivedCash: input.receivedCash,
      ReceivedCard: input.receivedCard,
      Items: stored,
    },
  })
  return { params, requestJson, stored }
}

/** «20260516095418» — как хранится fiscal_datetime у других бэкендов. */
export function formatFiscalDateTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  )
}

export function mapPospointAnswer(a: PospointReceiptAnswer): FiscalReceiptInfo {
  return {
    TerminalID: a.fmNo ?? '',
    // Номер чека Pospoint — по нему же потом делается возврат.
    ReceiptSeq: String(a.id),
    DateTime: formatFiscalDateTime(a.time ? new Date(a.time) : new Date()),
    FiscalSign: a.fiscalSign ?? '',
    QRCodeURL: a.url ?? '',
    // Сырой ответ кассы — в response_json, для сверки (kkmNo, время и т.п.).
    Raw: a,
  }
}

/** Через какую программу пробит чек — по формату его request_json. */
export function fiscalFormatOf(requestJson: string): 'pospoint' | 'fiscaldrive' | 'epos' | 'unknown' {
  try {
    const p = JSON.parse(requestJson) as { backend?: string; factoryId?: unknown; params?: { Receipt?: unknown } }
    if (p.backend === 'pospoint') return 'pospoint'
    if (p.factoryId !== undefined) return 'fiscaldrive'
    if (p.params?.Receipt) return 'epos'
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

function parseStored(requestJson: string): {
  payCheckNumber?: string
  params?: PospointSaleParams
  receipt?: { Items?: StoredReceiptItem[] }
} {
  try {
    return JSON.parse(requestJson) as ReturnType<typeof parseStored>
  } catch {
    return {}
  }
}

/** Строки, которые реально ушли в ОФД, — из сохранённого request_json. */
export function storedItemsOf(requestJson: string): StoredReceiptItem[] {
  return parseStored(requestJson).receipt?.Items ?? []
}

// ── Единицы измерения ─────────────────────────────────────────────────────

interface UnitsCacheEntry {
  at: number
  packages: Array<{ code: number; name: string }>
  /** Справочник не знает этот ИКПУ — повторяем не чаще раза в сутки. */
  miss?: boolean
}
interface UnitsCache {
  [mxik: string]: UnitsCacheEntry
}

/** Справочник tasnif меняется редко — обновляем раз в месяц, промахи — раз в сутки. */
const UNITS_TTL_SEC = 30 * 24 * 3600
const UNITS_MISS_TTL_SEC = 24 * 3600

async function loadUnitsCache(): Promise<UnitsCache> {
  try {
    const raw = await getSetting(SettingKey.PospointUnitsCache)
    return raw ? (JSON.parse(raw) as UnitsCache) : {}
  } catch {
    return {}
  }
}

/**
 * Дотянуть из справочника единицы для ИКПУ, которых нет в кэше. Берём только
 * точное совпадение ИКПУ — чужие единицы хуже, чем никаких. Ошибки справочника
 * не роняют продажу: останется запасной вариант (см. pickUnit).
 */
export async function ensureUnits(
  client: PospointClient,
  mxiks: string[],
  opts: { maxFetch?: number; timeoutMs?: number; stopOnOutage?: boolean } = {},
): Promise<UnitsCache> {
  const cache = await loadUnitsCache()
  const now = Math.floor(Date.now() / 1000)
  const stale = (e: UnitsCacheEntry | undefined) =>
    !e || now - e.at > (e.miss ? UNITS_MISS_TTL_SEC : UNITS_TTL_SEC)
  const missing = [...new Set(mxiks)].filter((m) => m && stale(cache[m]))
  let changed = false
  for (const mxik of missing.slice(0, opts.maxFetch ?? missing.length)) {
    try {
      const found = await client.getMxikInfo(mxik, opts.timeoutMs)
      const entry = found.find((f) => f.mxik === mxik)
      cache[mxik] = entry?.packages?.length
        ? {
            at: now,
            packages: entry.packages.map((p) => ({ code: p.code, name: (p.nameRu ?? p.nameLat ?? p.nameUz ?? '').trim() })),
          }
        : { at: now, packages: [], miss: true }
      changed = true
    } catch (e) {
      if (opts.stopOnOutage && (e instanceof PospointUnavailableError || e instanceof PospointNoAnswerError)) break
    }
  }
  if (changed) {
    await setSetting(SettingKey.PospointUnitsCache, JSON.stringify(cache)).catch(() => {})
  }
  return cache
}

/**
 * Единица для строки. Код — наш (из прихода), название — из справочника.
 * Нет кода — берём из справочника («шт», если вариантов несколько). Совсем
 * ничего — код 0 и «шт»: такой чек ОФД примет, но без единицы измерения,
 * и бухгалтер правит его руками на soliq.uz — поэтому об этом пишем error.
 */
export function pickUnit(
  cache: UnitsCache,
  mxik: string,
  packageCode: string | null,
): PospointUnit & { note?: string; bad?: boolean } {
  const packages = cache[mxik]?.packages ?? []
  const code = Number.parseInt((packageCode ?? '').trim(), 10)
  if (Number.isFinite(code) && code > 0) {
    const name = packages.find((p) => p.code === code)?.name
    if (name) return { packageCode: code, unit: name }
    return packages.length
      ? { packageCode: code, unit: 'шт', note: `код единицы ${code} не из справочника для этого ИКПУ`, bad: true }
      : { packageCode: code, unit: 'шт', note: `нет названия единицы для кода ${code}` }
  }
  const byName = packages.find((p) => p.name.toLowerCase() === 'шт') ?? packages[0]
  if (byName) {
    return { packageCode: byName.code, unit: byName.name || 'шт', note: 'код единицы взят из справочника' }
  }
  return { packageCode: 0, unit: 'шт', note: 'нет кода единицы — в ОФД уйдёт без единицы измерения', bad: true }
}

/** Плохие единицы — error на сервер, не чаще раза в сутки на ИКПУ. */
const unitErrorAt = new Map<string, number>()

async function reportUnitProblems(problems: Array<{ name: string; mxik: string; note: string }>): Promise<void> {
  const now = Date.now()
  const fresh = problems.filter((p) => now - (unitErrorAt.get(p.mxik) ?? 0) > 24 * 3600 * 1000)
  if (!fresh.length) return
  for (const p of fresh) unitErrorAt.set(p.mxik, now)
  await log.error('fiscalize', 'Pospoint: у товаров нет верной единицы измерения — дозаполните код упаковки в приходах', {
    items: fresh,
  })
}

// ── Настройки и клиент ────────────────────────────────────────────────────

export async function getPospointClient(opts: { background?: boolean } = {}): Promise<PospointClient> {
  const key = ((await getSetting(SettingKey.PospointKey)) ?? '').trim()
  if (!key) {
    throw new PospointUserError('Не задан ключ кассы Pospoint. Настройки → Pospoint → «Ключ кассы».')
  }
  if (key === POSPOINT_TEST_KEY) {
    // Тестовый ключ из документации: касса отвечает случайными данными, в
    // ФМ и ОФД ничего не уходит — а мы считали бы чек пробитым.
    throw new PospointUserError(
      'Указан тестовый ключ Pospoint из документации — с ним чеки не фискализируются. Вставьте ключ этой кассы, выданный Pospoint.',
    )
  }
  const baseUrl = (await getSetting(SettingKey.PospointUrl)) ?? undefined
  return new PospointClient({ baseUrl, key, background: opts.background })
}

// ── Фискальный модуль передан Pospoint ────────────────────────────────────

/**
 * Кассир уже работал с ФМ через Pospoint (чек, смена, «Проверить
 * подключение») — значит, старая программа выключена. До этого фоновая
 * проверка ФМ не трогает: сразу после переключения им ещё может владеть
 * старая программа, а checkFmStatus на апплете 4 привязывает ФМ к кассе.
 * Сбрасывается при каждом переключении программы (Настройки).
 */
export async function isPospointFmHandedOver(): Promise<boolean> {
  return (await getSetting(SettingKey.PospointFmHandedOver).catch(() => null)) === 'true'
}

export async function markPospointFmHandedOver(): Promise<void> {
  if (await isPospointFmHandedOver()) return
  await setSetting(SettingKey.PospointFmHandedOver, 'true').catch(() => {})
}

// ── Журнал попыток с неизвестным исходом ──────────────────────────────────

export interface PendingAttempt {
  kind: 'sale' | 'refund'
  /** Отпечаток того, что пытались пробить (строки + оплата) — заметить подмену. */
  inputFp: string
  requestJson: string
  /** Всё, что нужно, чтобы довести попытку до конца (план чека / строки возврата). */
  snapshot: unknown
  at: number
  /** X-отчёт сдвинулся без записи в Pospoint — снимать только вручную. */
  fmMaySigned?: boolean
  /** Когда фоновая проверка последний раз сообщала о попытке. */
  reportedAt?: number
  /**
   * Резервы остатков, которые подтверждаются этим чеком. Пишутся ДО confirm:
   * упадёт запись чека в БД — повтор подтвердит эти же резервы (confirm по
   * резерву идемпотентен), а не спишет остатки второй раз.
   */
  reservations?: Array<{ reservation_id: string }>
}

// Записи журнала сами не истекают: каждая — либо чек в ОФД, которого у нас
// нет, либо документ, заблокированный до сверки. Снимает их только разбор
// (кассир, фоновая проверка) или администратор.
type Journal = Record<string, PendingAttempt>

async function loadJournal(): Promise<Journal> {
  try {
    const raw = await getSetting(SettingKey.PospointPending)
    return raw ? (JSON.parse(raw) as Journal) : {}
  } catch {
    return {}
  }
}

async function saveJournal(j: Journal): Promise<void> {
  await setSetting(SettingKey.PospointPending, JSON.stringify(j))
}

export async function getPendingAttempt(payCheckNumber: string): Promise<PendingAttempt | null> {
  return (await loadJournal())[payCheckNumber] ?? null
}

export async function listPendingAttempts(): Promise<Array<[string, PendingAttempt]>> {
  return Object.entries(await loadJournal())
}

/**
 * Журнал — одна настройка, и правится он «прочитал → изменил → записал».
 * Правки идут строго по одной: иначе фоновая проверка, отметив свою запись,
 * затёрла бы попытку, которую кассир записал между её чтением и записью.
 */
let journalTail: Promise<unknown> = Promise.resolve()

function mutateJournal(change: (j: Journal) => boolean): Promise<void> {
  const run = async () => {
    const j = await loadJournal()
    if (change(j)) await saveJournal(j)
  }
  const next = journalTail.then(run, run)
  journalTail = next.catch(() => {})
  return next
}

export function setPendingAttempt(payCheckNumber: string, a: PendingAttempt): Promise<void> {
  return mutateJournal((j) => {
    j[payCheckNumber] = a
    return true
  })
}

export function updatePendingAttempt(payCheckNumber: string, patch: Partial<PendingAttempt>): Promise<void> {
  return mutateJournal((j) => {
    if (!j[payCheckNumber]) return false
    j[payCheckNumber] = { ...j[payCheckNumber]!, ...patch }
    return true
  })
}

export function clearPendingAttempt(payCheckNumber: string): Promise<void> {
  return mutateJournal((j) => {
    if (!(payCheckNumber in j)) return false
    delete j[payCheckNumber]
    return true
  })
}

/**
 * Пока кассир пробивает чек или возврат, фоновая проверка журнала молчит:
 * иначе она сочла бы «найденной, но не сохранённой» попытку, которую
 * кассир как раз сохраняет, или сняла бы запись посреди разбора сбоя.
 */
let foreground = 0
let lockTail: Promise<void> = Promise.resolve()

/**
 * Операции с кассой (чек, возврат, их доведение из журнала) идут строго по
 * одной: двойной клик или фоновое доведение во время чека кассира иначе
 * разобрали бы одну попытку дважды — второй резерв, ложная тревога.
 */
export async function runPospointForeground<T>(fn: () => Promise<T>): Promise<T> {
  foreground++
  const prev = lockTail
  let release!: () => void
  lockTail = new Promise<void>((r) => (release = r))
  try {
    await prev
    return await fn()
  } finally {
    release()
    foreground--
  }
}

export function isPospointForegroundBusy(): boolean {
  return foreground > 0
}

/** Отпечаток попытки: строки и оплата, без времени и прочего шума. */
export function inputFingerprint(parts: unknown): string {
  return JSON.stringify(parts)
}

/**
 * Перед новой попыткой документа — разобраться с прошлой, исход которой
 * неизвестен: пробита — вернуть её (сохранять надо её, а не новый план);
 * не пробита — снять из журнала; проверить нельзя — не пускать дальше.
 */
export async function resolvePendingAttempt(
  payCheckNumber: string,
  kind: 'sale' | 'refund',
): Promise<{ status: 'none' } | { status: 'found'; answer: PospointReceiptAnswer; pending: PendingAttempt }> {
  // Ключ проверяем сразу — до резерва остатков и прочей работы.
  const client = await getPospointClient()
  const pending = await getPendingAttempt(payCheckNumber)
  if (!pending || pending.kind !== kind) return { status: 'none' }
  const look = await lookupReceipt(client, payCheckNumber)
  if (look.status === 'found') return { status: 'found', answer: look.receipt, pending }
  if (look.status === 'unknown') {
    throw new PospointOutcomeUnknownError(
      'Прошлая попытка пробить этот документ осталась без ответа, а проверить её сейчас не удалось. Повторите позже — второй чек не пробьётся.',
    )
  }
  if (pending.fmMaySigned) {
    throw new PospointOutcomeUnknownError(
      'Прошлая попытка могла быть подписана фискальным модулем без записи в Pospoint. Пока администратор не сверит чек, пробивать этот документ нельзя (Настройки → Pospoint → незавершённые попытки).',
      [],
      true,
    )
  }
  await clearPendingAttempt(payCheckNumber)
  return { status: 'none' }
}

// ── Отправка с защитой от двойного пробития ───────────────────────────────

type Operation = 'sale' | 'refund' | 'shift'

/** Пробит ли чек под этим номером. 'unknown' — касса не ответила на поиск. */
async function lookupReceipt(
  client: PospointClient,
  payCheckNumber: string,
): Promise<{ status: 'found'; receipt: PospointReceiptAnswer } | { status: 'absent' } | { status: 'unknown' }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await client.getReceiptByPayCheckNumber(payCheckNumber)
      return r ? { status: 'found', receipt: r } : { status: 'absent' }
    } catch (e) {
      // Чек есть, но без признака — сохранить нельзя, это тоже «не знаем».
      if (e instanceof PospointBadResponseError) return { status: 'unknown' }
      if (attempt < 2) await new Promise((res) => setTimeout(res, 1000 * (attempt * 2 + 1)))
    }
  }
  return { status: 'unknown' }
}

/** Снимок счётчиков смены: X-отчёт, 'closed' — смена не открыта, null — не узнали. */
type XSnap = { saleCount: number; refundCount: number; lastReceiptSeq: number | null } | 'closed' | null

async function xSnapshot(client: PospointClient): Promise<XSnap> {
  try {
    const x = await client.getXReport()
    return { saleCount: x.saleCount ?? 0, refundCount: x.refundCount ?? 0, lastReceiptSeq: x.lastReceiptSeq ?? null }
  } catch (e) {
    return isPospointShiftClosed(e) ? 'closed' : null
  }
}

/**
 * Снимок после сбоя — с повтором: ФМ, только что не ответивший на чек, часто
 * отвечает через пару секунд, а «сравнить не по чему» блокирует документ до
 * сверки человеком.
 */
async function xSnapshotAfterFailure(client: PospointClient): Promise<XSnap> {
  for (let attempt = 0; ; attempt++) {
    const snap = await xSnapshot(client)
    if (snap !== null || attempt >= 2) return snap
    await new Promise((res) => setTimeout(res, 1500))
  }
}

/**
 * Касса ответила только «ФМ не найден» (USB-ридер отключён): подписать чек
 * было нечем, значит он точно не пробит.
 */
function isFmAbsent(e: unknown): boolean {
  return e instanceof PospointError && e.errors.every((x) => x.code === 4240 || x.code === 4100)
}

/** Сдвинулись ли счётчики смены: true / false, null — сравнить не по чему. */
function xMoved(before: XSnap, after: XSnap, op: 'sale' | 'refund'): boolean | null {
  if (before === null || after === null) return null
  if (before === 'closed') {
    if (after === 'closed') return false
    return (op === 'sale' ? after.saleCount : after.refundCount) > 0 || after.lastReceiptSeq !== null
  }
  if (after === 'closed') return null
  const key = op === 'sale' ? 'saleCount' : 'refundCount'
  return after[key] !== before[key] || after.lastReceiptSeq !== before.lastReceiptSeq
}

/**
 * Отправить в ОФД накопленное (ФМ не принимает чеки, пока не уйдут старые).
 * Останавливаемся, как только отправка не продвигается, — иначе кассир ждал
 * бы десятки вызовов по две минуты.
 */
export async function flushOfd(client: PospointClient, maxRounds = 3): Promise<number> {
  let sent = 0
  let prevUnsent = Number.POSITIVE_INFINITY
  for (let round = 0; round < maxRounds; round++) {
    const r = await client.syncWithOfd()
    const s = r.sentCount ?? 0
    const u = r.unsentCount ?? 0
    sent += s
    if (!u || !s || u >= prevUnsent) break
    prevUnsent = u
  }
  return sent
}

export interface SendResult {
  answer: PospointReceiptAnswer
  /** Чек взят поиском по номеру (14824 или исход был неизвестен), а не прямым ответом. */
  recovered: boolean
}

/**
 * Отправить чек и разобраться с любым исходом по правилам Pospoint:
 *   - 14824 «уже пробит» → берём чек поиском по номеру;
 *   - ответа нет, обрыв, непонятный ответ или код ФМ → поиск: нашёлся —
 *     успех; нет — сверяем X-отчёт (ФМ мог подписать чек, не записав
 *     номер); счётчики не сдвинулись — чек точно не пробит, поправимое
 *     (память ФМ, синхронизация) лечим и повторяем один раз;
 *   - остальное → понятное кассиру сообщение.
 */
export async function sendWithRecovery(
  client: PospointClient,
  op: 'sale' | 'refund',
  payCheckNumber: string,
  call: () => Promise<PospointReceiptAnswer>,
  opts: { before?: XSnap } = {},
  attempt = 0,
): Promise<SendResult> {
  const source = op === 'sale' ? 'fiscalize' : 'refund'
  const what = op === 'sale' ? 'чек' : 'возврат'
  try {
    return { answer: await call(), recovered: false }
  } catch (e) {
    const codes = e instanceof PospointError ? e.codes : []
    const msg = e instanceof Error ? e.message : String(e)

    // Чека продажи у кассы нет — это ответ, а не сбой: искать нечего.
    if (op === 'refund' && e instanceof PospointError && e.has(36872)) throw toUserError(e, op)

    if (e instanceof PospointError && e.has(14824)) {
      const found = await lookupReceipt(client, payCheckNumber)
      if (found.status === 'found') {
        await log.warn(source, `Pospoint: ${what} ${payCheckNumber} уже был пробит раньше — беру его данные`, {
          receipt: found.receipt,
        })
        return { answer: found.receipt, recovered: true }
      }
      if (found.status === 'absent') {
        await log.error(source, `🚨 Pospoint: ${what} ${payCheckNumber} «уже пробит» (14824), но поиск его не находит`)
      }
      // Касса сказала «уже пробит» — значит, чек есть. Если позже поиск его
      // не найдёт (Pospoint стирает базу при входе), это не «не пробит»:
      // документ блокируется до сверки (fmMaySigned).
      throw new PospointOutcomeUnknownError(
        found.status === 'absent'
          ? 'Pospoint считает этот чек уже пробитым, но не находит его. Не пробивайте снова — сверьте последний чек в программе Pospoint и сообщите администратору.'
          : 'Pospoint считает этот чек уже пробитым, а проверить его сейчас не удалось. Повторите позже — второй раз под тем же номером чек не пробьётся.',
        codes,
        true,
      )
    }

    if (isPospointOutcomeUnknown(e)) {
      const found = await lookupReceipt(client, payCheckNumber)
      if (found.status === 'found') {
        await log.warn(source, `Pospoint: ответа не было, но ${what} ${payCheckNumber} пробит — беру его данные`, {
          error: msg,
          receipt: found.receipt,
        })
        return { answer: found.receipt, recovered: true }
      }
      if (found.status === 'unknown') {
        // Поиск не ответил — всё равно сверяем счётчики смены. Сдвинулись или
        // сравнить не по чему — ФМ мог подписать чек; тогда «не найден» при
        // следующем разборе не докажет, что чека нет (см. resolvePendingAttempt).
        const maySigned = isFmAbsent(e)
          ? false
          : xMoved(opts.before ?? null, await xSnapshotAfterFailure(client), op) !== false
        throw new PospointOutcomeUnknownError(
          'Pospoint не ответил, и проверить, пробит ли чек, не удалось. Повторите позже — под тем же номером второй чек не пробьётся.',
          codes,
          maySigned,
        )
      }
      // По номеру не нашёлся. ФМ мог подписать чек, а Pospoint — не записать
      // номер (документация: «до повтора сверьте getXReport»). Без ФМ подписать
      // было нечем — тогда и сверять нечего: X-отчёт без него не читается, и
      // «сравнить не по чему» зря заблокировало бы документ.
      if (isFmAbsent(e)) throw toUserError(e, op)
      const after = await xSnapshotAfterFailure(client)
      if (xMoved(opts.before ?? null, after, op) !== false) {
        await log.error(
          source,
          `🚨 Pospoint: ${what} ${payCheckNumber} мог быть подписан фискальным модулем без записи в Pospoint — повтор заблокирован`,
          { error: msg, before: opts.before ?? null, after },
        )
        throw new PospointOutcomeUnknownError(
          'Фискальный модуль мог подписать чек, но Pospoint его не записал. Не пробивайте снова: сверьте последний чек в программе Pospoint и сообщите администратору.',
          codes,
          true,
        )
      }
      // Точно не пробит. Поправимое лечим и пробуем ещё раз.
      if (attempt === 0 && e instanceof PospointError) {
        const unsent = e.has(36886, 36889, 37105) || (e.has(36913) && (op === 'sale' || isApplet4() !== false))
        if (unsent) {
          let sent = 0
          try {
            sent = await flushOfd(client, 3)
          } catch (fe) {
            await log.error(source, '🚨 Pospoint: ФМ ждёт отправки старых чеков в ОФД, а отправить их не удалось — продажи стоят', {
              error: fe instanceof Error ? fe.message : String(fe),
            })
            throw toUserError(e, op)
          }
          if (sent === 0) {
            await log.error(source, '🚨 Pospoint: ФМ ждёт отправки старых чеков, но в ОФД ничего не уходит — продажи стоят')
            throw toUserError(e, op)
          }
          await log.warn(source, `Pospoint: ФМ ждал отправки старых чеков — отправлено ${sent}, повторяю`)
          return sendWithRecovery(client, op, payCheckNumber, call, { before: await xSnapshot(client) }, attempt + 1)
        }
        if (e.has(37008)) {
          await client.syncFmState().catch(() => null)
          await log.warn(source, 'Pospoint: ФМ требовал синхронизации — синхронизировал, повторяю')
          return sendWithRecovery(client, op, payCheckNumber, call, { before: await xSnapshot(client) }, attempt + 1)
        }
      }
      if (attempt > 0 && e instanceof PospointError && e.has(36886, 36889, 37105)) {
        await log.error(source, '🚨 Pospoint: ФМ не принимает чеки и после отправки старых — продажи стоят')
      }
      throw toUserError(e, op)
    }

    throw toUserError(e, op)
  }
}

/** Сообщение кассиру по кодам Pospoint. Неизвестное остаётся технической ошибкой. */
export function toUserError(e: unknown, op: Operation): Error {
  if (e instanceof PospointUserError) return e
  if (e instanceof PospointUnavailableError) {
    return new PospointUserError(
      'Программа Pospoint не отвечает. Откройте Pospoint, войдите и включите «Режим интеграции» (значок вверху экрана) и «Использовать локальный адрес». Если они уже включены — выключите и включите «Режим интеграции» снова. Чек не пробит, затем повторите.',
    )
  }
  if (e instanceof PospointNoAnswerError || e instanceof PospointBadResponseError) {
    return new PospointUserError(
      op === 'shift'
        ? 'Pospoint не ответил вовремя. Обновите экран — операция могла уже выполниться.'
        : 'Pospoint не ответил вовремя, чек не пробит. Нажмите ещё раз — дубля не будет.',
    )
  }
  if (!(e instanceof PospointError)) return e instanceof Error ? e : new Error(String(e))
  const codes = e.codes
  const msg = (text: string) => new PospointUserError(text, codes)
  const applet4 = isApplet4()

  if (e.has(14800)) return msg('Pospoint не принял ключ кассы. Проверьте ключ: Настройки → Pospoint.')
  if (e.has(-10)) return msg('Касса Pospoint не активна. Проверьте регистрацию и подписку или обратитесь в поддержку Pospoint.')
  if (e.has(-12)) return msg('В Pospoint выключен фискальный режим. Включите его в настройках Pospoint.')
  if (e.has(-555)) return msg('Исчерпан лимит демо-режима Pospoint. Обратитесь в Pospoint.')
  if (e.has(-15)) {
    return msg(
      'Pospoint отклонил чек: ограничение оплаты наличными (УП-246) или ошибка проверки маркировки. Попробуйте оплату картой; если не помогает — сообщите администратору.',
    )
  }
  if (e.has(14823)) return msg('Налоговая отклонила код маркировки товара в чеке. Сообщите администратору.')
  if (e.has(14807)) {
    return msg(
      op === 'refund'
        ? 'Сумма возврата больше, чем стоят возвращаемые товары с учётом скидки. Уменьшите сумму.'
        : 'Сумма оплаты не совпала с суммой чека (ошибка 14807). Сообщите администратору.',
    )
  }
  if (e.has(4240, 4100)) return msg('Фискальный модуль не найден. Проверьте, что USB-ридер ФМ подключён к компьютеру.')
  if (e.has(-13)) {
    return msg(
      op === 'shift'
        ? 'Фискальный модуль не ответил. Проверьте USB-ридер ФМ и обновите экран.'
        : 'Фискальный модуль не ответил, чек не пробит. Нажмите ещё раз; если повторяется — проверьте USB-ридер ФМ.',
    )
  }
  if (e.has(37011)) return msg('Касса не авторизована в фискальном модуле. Обратитесь в поддержку Pospoint.')
  if (e.has(36911, 36928, 36929, 36930, 36931, 36932, 36933)) {
    return msg('Смена переполнена. Закройте смену в разделе «Смена» и пробейте чек снова.')
  }
  if (op === 'refund') {
    if (e.has(36872)) {
      return msg(
        'Pospoint не нашёл чек продажи у себя. Вернуть можно только на кассе, где пробита продажа; после входа в Pospoint по логину или смены организации он стирает уже отправленные чеки — тогда вернуть через Pospoint нельзя.',
      )
    }
    if (e.has(14811)) return msg('В чеке продажи нет такой позиции или возвращается больше, чем продано.')
    if (e.has(36914, 36917) || (e.has(36913) && applet4 === false)) {
      return msg('Возврат больше, чем продано в этой смене этим способом оплаты. Верните другим способом (наличные или карта) или позже.')
    }
    if (e.has(36913)) {
      return msg(
        'Возврат не прошёл: в ОФД не ушли старые чеки или в смене мало продаж этим способом оплаты. Проверьте интернет и повторите; если не помогает — верните другим способом.',
      )
    }
  }
  if (op === 'shift' && e.has(36897) && applet4 === false) {
    return msg('Время закрытия смены раньше её открытия. Проверьте дату и время Windows и повторите.')
  }
  if (e.has(36888, 36916) || (e.has(36912) && (op === 'sale' || applet4 === true))) {
    return msg('Время на компьютере кассы раньше последнего чека. Проверьте дату и время Windows и повторите.')
  }
  if (e.has(36886, 36889, 37105) || (op === 'sale' && e.has(36913))) {
    return msg('Фискальный модуль не принимает чеки: в ОФД не ушли старые. Проверьте интернет — Pospoint отправит их сам, затем повторите.')
  }
  return e
}

/**
 * Попытка не удалась. Исход неизвестен — запись остаётся (и помнит, если ФМ
 * мог подписать чек); исход известен — чек не пробит, запись не нужна.
 */
async function settleFailedAttempt(payCheckNumber: string, attempt: PendingAttempt, e: unknown): Promise<void> {
  try {
    if (e instanceof PospointOutcomeUnknownError) {
      await setPendingAttempt(payCheckNumber, { ...attempt, ...(e.fmMaySigned ? { fmMaySigned: true } : {}) })
    } else {
      await clearPendingAttempt(payCheckNumber)
    }
  } catch (je) {
    await log.error('fiscalize', 'Pospoint: не удалось обновить журнал попыток', {
      payCheckNumber,
      error: je instanceof Error ? je.message : String(je),
    })
  }
}

// ── Продажа ───────────────────────────────────────────────────────────────

/**
 * Пробить продажу. Перед вызовом fiscalize() уже разобрался с прошлой
 * попыткой этого документа (resolvePendingAttempt), поэтому «восстановленный»
 * здесь чек — пробитый именно этой попыткой.
 */
export async function fiscalizePospoint(input: {
  lines: PospointLine[]
  receivedCash: number
  receivedCard: number
  cardKind?: 'fiz' | 'corp'
  payCheckNumber: string
  /** Отпечаток попытки (см. inputFingerprint) и то, чем её довести. */
  inputFp: string
  snapshot: unknown
}): Promise<{
  fiscal: FiscalReceiptInfo
  requestJson: string
  stored: StoredReceiptItem[]
  /** Чек найден поиском (уже был пробит), а не пробит этим вызовом. */
  recovered: boolean
}> {
  const client = await getPospointClient()
  const mxiks = input.lines.map((l) => l.esfItem.class_code)
  // Недостающие единицы спрашиваем у справочника коротко: касса без
  // интернета не должна держать кассира (кэш греет фоновая проверка).
  const cache = await ensureUnits(client, mxiks, { timeoutMs: 8_000, stopOnOutage: true })
  const notes: string[] = []
  const problems: Array<{ name: string; mxik: string; note: string }> = []
  const sale = buildPospointSale({
    ...input,
    unitOf: (l) => {
      const u = pickUnit(cache, l.esfItem.class_code, l.esfItem.package_code)
      if (u.note) notes.push(`${l.esfItem.name}: ${u.note}`)
      if (u.bad) problems.push({ name: l.esfItem.name, mxik: l.esfItem.class_code, note: u.note ?? '' })
      return u
    },
  })
  if (notes.length) await log.warn('fiscalize', 'Pospoint: единица измерения подобрана не из прихода', { notes })
  if (problems.length) await reportUnitProblems(problems)

  // Журнал ДО отправки: если ответа не будет, следующая попытка узнает о ней.
  // Снимает запись вызывающий — после того как чек сохранён в БД.
  const attempt: PendingAttempt = {
    kind: 'sale',
    inputFp: input.inputFp,
    requestJson: sale.requestJson,
    snapshot: input.snapshot,
    at: Date.now(),
  }
  await setPendingAttempt(input.payCheckNumber, attempt)
  const before = await xSnapshot(client)

  await log.info('fiscalize', 'Отправляю registerSaleFull в Pospoint', {
    url: client.baseUrl,
    payCheckNumber: input.payCheckNumber,
    params: sale.params,
  })

  let result: SendResult
  try {
    result = await sendWithRecovery(
      client,
      'sale',
      input.payCheckNumber,
      () => client.registerSaleFull(sale.params),
      { before },
    )
  } catch (e) {
    await settleFailedAttempt(input.payCheckNumber, attempt, e)
    throw e
  }
  await log.info('fiscalize', 'Pospoint: чек пробит', { answer: result.answer, recovered: result.recovered })
  await markPospointFmHandedOver()
  return {
    fiscal: mapPospointAnswer(result.answer),
    requestJson: sale.requestJson,
    stored: sale.stored,
    recovered: result.recovered,
  }
}

// ── Возврат ───────────────────────────────────────────────────────────────

/** Строка возврата в нашем виде (JsonRpcItem из refund.ts). */
export interface RefundLine {
  Name: string
  spic: string
  Barcode?: string
  /** Тысячные. */
  Amount: number
  /** Сумма строки до скидки, тийины. */
  Price: number
  Discount?: number
  VAT?: number
  VATPercent?: number
  packageCode?: string
  OwnerType?: number
}

/** Номер документа возврата: `<номер продажи>-R<n>`. */
export function pospointRefundPayCheck(originalRequestJson: string, originalReceiptSeq: string, refundIndex: number): string {
  const sale = parseStored(originalRequestJson).payCheckNumber ?? `receipt-${originalReceiptSeq}`
  return `${sale}-R${refundIndex}`
}

export interface PospointRefundBuild {
  params: PospointRefundParams
  requestJson: string
  /** Суммы возврата — могли урезаться на тийины до потолка кассы. */
  refundCash: number
  refundCard: number
  /** Строки, которые касса не сможет однозначно найти в чеке продажи. */
  ambiguous: string[]
}

export function buildPospointRefund(input: {
  originalRequestJson: string
  originalReceiptSeq: string
  lines: RefundLine[]
  /** Номер строки продажи для каждой строки возврата. */
  originalIndexes: number[]
  refundCash: number
  refundCard: number
  cardKind?: 'fiz' | 'corp' | null
  /** Порядковый номер возврата по этому чеку: 1, 2, … */
  refundIndex: number
  now?: Date
}): PospointRefundBuild {
  const idRefundReceipt = Number.parseInt(input.originalReceiptSeq, 10)
  if (fiscalFormatOf(input.originalRequestJson) !== 'pospoint' || !Number.isFinite(idRefundReceipt)) {
    throw new PospointUserError(
      'Этот чек пробит не через Pospoint — вернуть его через Pospoint нельзя: возврат проходит там, где была продажа.',
    )
  }
  const saleItems = parseStored(input.originalRequestJson).params?.items ?? []
  const payCheckNumber = pospointRefundPayCheck(input.originalRequestJson, input.originalReceiptSeq, input.refundIndex)
  const count = <K extends 'mxik' | 'barcode' | 'name'>(k: K, v: string | undefined) =>
    v ? saleItems.filter((s) => s[k] === v).length : 0

  const ambiguous: string[] = []
  let ceilingExact = 0
  const items: PospointRefundItem[] = input.lines.map((l, i) => {
    const k = l.Amount / 1000
    const si = saleItems[input.originalIndexes[i] ?? -1]
    if (!si) {
      // Старый формат без params — цена из суммы строки (для целых штук точна).
      const price = Math.round(l.Price / k) / 100
      ceilingExact += l.Price - (l.Discount ?? 0)
      const barcode = barcodeOf(l.Barcode)
      return { name: l.Name, ...(l.spic ? { mxik: l.spic } : {}), ...(barcode ? { barcode } : {}), amount: k, price }
    }
    // Касса ищет строку продажи по ИКПУ или штрихкоду, по названию — только
    // если ни того, ни другого нет. В одном чеке бывает несколько товаров с
    // одним ИКПУ (15 % чеков), поэтому шлём только однозначный ключ.
    const mxikUnique = count('mxik', si.mxik) === 1
    const barcodeUnique = !!si.barcode && count('barcode', si.barcode) === 1
    if (!mxikUnique && !barcodeUnique && count('name', si.name) !== 1) ambiguous.push(si.name)
    const unitTiyin = Math.round(si.price * 100)
    const discountTiyin = Math.round((si.discount ?? 0) * 100)
    // Стоимость по правилам кассы: цена × количество минус доля скидки строки.
    ceilingExact += unitTiyin * k - (discountTiyin * k) / si.amount
    return {
      name: si.name,
      ...(mxikUnique ? { mxik: si.mxik } : {}),
      ...(barcodeUnique ? { barcode: si.barcode } : {}),
      amount: k,
      // Цена — ровно та, что ушла в продаже (касса её не сверяет, но ОФД — да).
      price: si.price,
    }
  })

  // Возврат не может быть больше стоимости позиций с учётом скидки (14807).
  // Тийины округления урезаем сами; заметную разницу — показываем кассиру.
  const ceiling = Math.floor(ceilingExact + 1e-6)
  let refundCash = input.refundCash
  let refundCard = input.refundCard
  const excess = refundCash + refundCard - ceiling
  if (excess > 0) {
    if (excess > 100) {
      throw new PospointUserError(
        `Сумма возврата ${(refundCash + refundCard) / 100} сум больше стоимости возвращаемых товаров ${ceiling / 100} сум. Уменьшите сумму.`,
        [14807],
      )
    }
    const fromCard = Math.min(excess, refundCard)
    refundCard -= fromCard
    refundCash -= excess - fromCard
  }

  const params: PospointRefundParams = {
    idRefundReceipt,
    items,
    byCash: refundCash / 100,
    byCard: refundCard / 100,
    payCheckNumber,
    print: false,
    ...(refundCard > 0 && input.cardKind ? { cardType: CARD_TYPE[input.cardKind] } : {}),
  }
  const requestJson = JSON.stringify({
    backend: 'pospoint',
    method: 'registerRefundFull',
    payCheckNumber,
    params,
    receipt: {
      Time: formatGoTime(input.now ?? new Date()),
      ReceivedCash: refundCash,
      ReceivedCard: refundCard,
      Items: input.lines.map((l) => ({
        Name: l.Name,
        SPIC: l.spic,
        Amount: l.Amount,
        Price: l.Price,
        Discount: l.Discount ?? 0,
        VAT: l.VAT ?? 0,
        VATPercent: l.VATPercent ?? 0,
        Barcode: l.Barcode ?? '0',
        PackageCode: l.packageCode ?? '',
        OwnerType: ownerTypeOf(l.OwnerType),
      })),
    },
  })
  return { params, requestJson, refundCash, refundCard, ambiguous }
}

/**
 * Пробить возврат, собранный buildPospointRefund (суммы в нём уже урезаны
 * до потолка кассы — их и сохранять). Запись в журнале снимает вызывающий,
 * когда возврат сохранён в БД.
 */
export async function sendRefundPospoint(input: {
  built: PospointRefundBuild
  /** Фискальный признак продажи — сверить, что номер чека в Pospoint тот же. */
  originalFiscalSign?: string
  inputFp: string
  snapshot: unknown
}): Promise<{ fiscal: FiscalReceiptInfo; requestJson: string; recovered: boolean }> {
  const { built } = input
  const client = await getPospointClient()
  const payCheckNumber = built.params.payCheckNumber

  // Pospoint стирает отправленные чеки после входа по логину: убеждаемся,
  // что номер продажи у него всё ещё тот самый чек.
  try {
    const sale = await client.getReceipt(built.params.idRefundReceipt)
    if (input.originalFiscalSign && sale.fiscalSign && sale.fiscalSign !== input.originalFiscalSign) {
      await log.error('refund', '🚨 Pospoint: под номером чека продажи теперь другой чек — возврат остановлен', {
        id: built.params.idRefundReceipt,
        expected: input.originalFiscalSign,
        actual: sale.fiscalSign,
      })
      throw new PospointUserError(
        'В Pospoint под номером этого чека теперь другой чек (после повторного входа номера могли начаться заново). Вернуть через Pospoint нельзя — сообщите администратору.',
      )
    }
  } catch (e) {
    if (e instanceof PospointUserError) throw e
    if (e instanceof PospointError && e.has(-18)) {
      throw new PospointUserError(
        'Pospoint не нашёл чек продажи у себя: после входа по логину или смены организации он стирает отправленные чеки. Вернуть через Pospoint нельзя — сообщите администратору.',
        e.codes,
      )
    }
    // Проверить не удалось — возврат всё равно попробуем: касса сама ответит 36872.
  }

  if (built.ambiguous.length) {
    await log.warn('refund', 'Pospoint: в чеке продажи несколько строк с тем же ИКПУ и названием — касса может взять не ту', {
      items: built.ambiguous,
    })
  }

  const attempt: PendingAttempt = {
    kind: 'refund',
    inputFp: input.inputFp,
    requestJson: built.requestJson,
    snapshot: input.snapshot,
    at: Date.now(),
  }
  await setPendingAttempt(payCheckNumber, attempt)
  const before = await xSnapshot(client)
  await log.info('refund', 'Отправляю registerRefundFull в Pospoint', { url: client.baseUrl, params: built.params })

  let result: SendResult
  try {
    result = await sendWithRecovery(client, 'refund', payCheckNumber, () => client.registerRefundFull(built.params), {
      before,
    })
  } catch (e) {
    await settleFailedAttempt(payCheckNumber, attempt, e)
    throw e
  }
  await log.info('refund', 'Pospoint: возврат пробит', { answer: result.answer, recovered: result.recovered })
  await markPospointFmHandedOver()
  return { fiscal: mapPospointAnswer(result.answer), requestJson: built.requestJson, recovered: result.recovered }
}

// ── Смена ─────────────────────────────────────────────────────────────────

function formatShiftTime(ms: number | undefined): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/**
 * getXReport → наш формат экрана «Смена». Суммы X-отчёта у Pospoint уже в
 * тийинах. НДС приходит одним числом — продажи минус возвраты, поэтому
 * весь он записан в продажи, а у возвратов 0: итог на ленте верный.
 * Номера смены X-отчёт не даёт — 0, экран показывает прочерк.
 */
export function mapPospointXReport(x: PospointXReport): JsonRpcZReportInfo {
  return {
    TerminalID: x.terminalId ?? '',
    Number: 0,
    Count: 0,
    OpenTime: formatShiftTime(x.openTime),
    CloseTime: '',
    FirstReceiptSeq: x.firstReceiptSeq != null ? String(x.firstReceiptSeq) : '',
    LastReceiptSeq: x.lastReceiptSeq != null ? String(x.lastReceiptSeq) : '',
    TotalSaleCount: x.saleCount ?? 0,
    TotalSaleCash: x.saleCashTotal ?? 0,
    TotalSaleCard: x.saleCardTotal ?? 0,
    TotalSaleVAT: x.totalVat ?? 0,
    TotalRefundCount: x.refundCount ?? 0,
    TotalRefundCash: x.refundCashTotal ?? 0,
    TotalRefundCard: x.refundCardTotal ?? 0,
    TotalRefundVAT: 0,
    AppletVersion: '',
  }
}

/**
 * closeZReport → тот же формат, для печати Z-отчёта. Суммы Z-отчёта у
 * Pospoint в СУМАХ (в отличие от X-отчёта) — переводим в тийины.
 */
export function mapPospointZReport(z: PospointZReport): JsonRpcZReportInfo {
  const t = (v: number | undefined) => Math.round((v ?? 0) * 100)
  return {
    TerminalID: z.terminalId ?? '',
    Number: z.reportNumber ?? 0,
    Count: z.reportNumber ?? 0,
    OpenTime: formatShiftTime(z.openTime),
    CloseTime: formatShiftTime(z.closeTime),
    FirstReceiptSeq: z.firstReceiptSeq != null ? String(z.firstReceiptSeq) : '',
    LastReceiptSeq: z.lastReceiptSeq != null ? String(z.lastReceiptSeq) : '',
    TotalSaleCount: z.saleCount ?? 0,
    TotalSaleCash: t(z.saleCashTotal),
    TotalSaleCard: t(z.saleCardTotal),
    TotalSaleVAT: t(z.saleVat),
    TotalRefundCount: z.refundCount ?? 0,
    TotalRefundCash: t(z.refundCashTotal),
    TotalRefundCard: t(z.refundCardTotal),
    TotalRefundVAT: t(z.refundVat),
    AppletVersion: '',
  }
}

/**
 * Смена не открыта: -14 у getXReport, 36909 у ФМ; 36897 — только на апплете 4
 * (на апплете 3 этот код значит «время закрытия в прошлом»).
 */
export function isPospointShiftClosed(e: unknown): boolean {
  return e instanceof PospointError && (e.has(-14, 36909) || (e.has(36897) && isApplet4() !== false))
}
