/**
 * Синхронизация фискальных чеков (и их возвратов) на mytoolbox-сервер.
 *
 * Зачем: 4 магазина в проде, каждый со своей локальной SQLite. Продажи
 * не видны нигде централизованно — сверка с бухгалтерией/ОФД требует
 * ручного экспорта с каждой Win-машины. Раз в 60 сек шлём пачку ещё не
 * отправленных чеков на mytoolbox, там они лягут в общую таблицу для
 * админ-панели/отчётов.
 *
 * Паттерн скопирован из `src/lib/telemetry.ts` — флашер по таймеру, батч,
 * exp backoff, никогда не бросает наружу. Два важных отличия от telemetry:
 *
 *   1. 404 здесь НЕ значит «эндпоинт не задеплоен» — `/sales` уже в проде,
 *      поэтому 404 = ошибка конфигурации (не тот serverUrl/прокси) и идёт
 *      в общую ветку failure с backoff, а не помечается отправленным.
 *      Иначе — безвозвратная потеря финансовых записей.
 *   2. `buildSaleEntry` НИКОГДА не возвращает null (см. ниже) — иначе чек,
 *      который не удалось распарсить (legacy `/uzpos`-формат), навсегда
 *      застревал бы в очереди и по `ORDER BY id LIMIT 20` блокировал бы
 *      ВСЕ последующие чеки (у legacy — самые маленькие id).
 *
 * Что шлётся:
 *   - Только `fiscal_receipts` (тестовые чеки туда вообще не попадают —
 *     см. CLAUDE.md «Тестовый режим», поэтому `is_test` в payload всегда
 *     `false`)
 *   - Возвраты (`fiscal_refunds`) едут ВЛОЖЕННЫМИ в payload своего
 *     родительского чека (`sales[].refunds[]`), отдельного top-level
 *     запроса на refund'ы нет
 *
 * Серверная сторона (mytoolbox, уже задеплоена):
 *   - Endpoint: POST /api/v1/inventory/sales
 *   - Auth: Bearer <SettingKey.InventoryShopApiKey>
 *   - Батч ≤ 20 чеков за запрос
 *   - Идемпотентен: UNIQUE(shop_id, fiscal_sign) — повторная отправка
 *     одного и того же чека (например при обрыве сети ПОСЛЕ того как
 *     сервер принял, но ДО того как клиент получил ответ) безопасна
 *
 * Возвраты почти всегда происходят ПОЗЖЕ, чем чек уехал на сервер (покупатель
 * приходит через день-два), поэтому выборка батча берёт не только неотправленные
 * чеки, но и уже отправленные, у которых появился неотправленный refund.
 * Сервер к этому готов: он обрабатывает блок `refunds` даже когда шапка чека
 * пришла дублем, и пересчитывает `refund_state`.
 */

import type Database from '@tauri-apps/plugin-sql'
import { fetchWithTimeout } from './http'
import { getDb, getSetting, SettingKey } from '@/lib/db'
import type { FiscalReceiptRow, FiscalRefundRow } from '@/lib/db'
import { log } from '@/lib/log'
import { APP_VERSION } from '@/lib/app-version'
import { parseRequestJsonReceipt, type NormalizedReceiptItem } from '@/lib/epos/request-json'
import { extractPositions } from '@/lib/matcher'
import type { MsRetailDemand } from '@/lib/moysklad/types'

/** Интервал между попытками flush'а — 60 сек. */
const FLUSH_INTERVAL_MS = 60_000
/** Первый тик — с задержкой 10 сек, чтобы приложение успело инициализироваться. */
const FIRST_TICK_DELAY_MS = 10_000
/** Сколько чеков за один POST — серверный лимит. */
const BATCH_SIZE = 20

let started = false
let timer: ReturnType<typeof setInterval> | null = null
/** Сколько подряд-неудач до эскалации в log.error (тик = 60 сек, т.е. ~5 минут). */
const STALL_THRESHOLD = 5

/** Разовая эскалация залипшей очереди, сбрасывается при первом успехе. */
let loggedStallOnce = false

/** Кол-во подряд-failed flush'ей для exp backoff. */
let consecutiveFailures = 0

/**
 * Запустить background-flusher один раз на всё приложение.
 * Идемпотентно. Вызывается из App.tsx рядом с ensureTelemetryStarted.
 */
export async function ensureSalesSyncStarted(): Promise<void> {
  if (started) return
  started = true

  setTimeout(() => {
    void flushSalesToServer()
  }, FIRST_TICK_DELAY_MS)

  timer = setInterval(() => {
    void flushSalesToServer()
  }, FLUSH_INTERVAL_MS)
}

/** Для тестов/shutdown — остановить таймер. */
export function stopSalesSync(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
  consecutiveFailures = 0
  inFlight = null
  logged404Once = false
}

// ── Payload-типы (контракт POST /api/v1/inventory/sales) ──────────

export interface SalesSyncMsItemPayload {
  name: string
  qty_milli: number
  total_tiyin: number
}

export interface SalesSyncItemPayload {
  name: string
  class_code: string
  package_code: string | null
  qty_milli: number
  /**
   * Сумма ПО СТРОКЕ (за всё `qty_milli`), ДО скидки и ВКЛЮЧАЯ НДС — это
   * `Price` из фискального payload (что ушло в ОФД). НЕ путать с
   * `unit_cost_tiyin` ниже — разные основания (строка vs единица,
   * с НДС vs без НДС), их легко перепутать при чтении соседних полей.
   */
  price_tiyin: number
  discount_tiyin: number
  vat_tiyin: number
  vat_percent: number
  inv_item_id: number | null
  /**
   * Цена прихода ЗА ЕДИНИЦУ и БЕЗ НДС (`esf_items.unit_price_tiyin` —
   * себестоимость до наценки, НДС добавляется отдельно при расчёте
   * продажной цены, см. `costWithVat` в CLAUDE.md/matcher/strategies.ts).
   * Сервер вычитает НДС из выручки при расчёте маржи — если перепутать
   * это поле с `price_tiyin`, маржа посчитается неверно.
   */
  unit_cost_tiyin: number | null
  /** Построчной привязки к позиции МС нет — всегда null (см. CLAUDE.md). */
  ms_name: null
  ms_price_tiyin: null
  strategy: string | null
}

export interface SalesSyncRefundPayload {
  fiscal_sign: string
  fiscal_datetime: string
  is_partial: boolean
  cash_tiyin: number
  card_tiyin: number
  total_tiyin: number
  items_snapshot: unknown
  reason: string | null
}

export interface SalesSyncSaleEntry {
  fiscal_sign: string
  terminal_id: string
  receipt_seq: string
  fiscal_datetime: string
  qr_code_url: string
  ms_receipt_id: string | null
  ms_receipt_name: string | null
  ms_total_tiyin: number | null
  total_tiyin: number
  cash_tiyin: number
  card_tiyin: number
  vat_tiyin: number
  excluded_payment_tiyin: number
  card_kind: 'fiz' | 'corp' | null
  matcher_strategy: string | null
  is_test: false
  fiscalized_at: string
  raw_request: unknown
  ms_items: SalesSyncMsItemPayload[]
  items: SalesSyncItemPayload[]
  refunds: SalesSyncRefundPayload[]
}

export interface SalesSyncPayload {
  app_version: string
  sales: SalesSyncSaleEntry[]
}

// ── Чистые функции (тестируемые без БД) ────────────────────────────

/**
 * Конвертировать `fiscal_datetime`/`refund.fiscal_datetime` (как хранится
 * в SQLite — либо 14 цифр `YYYYMMDDHHMMSS`, либо Go-style `YYYY-MM-DD
 * HH:MM:SS`) в ISO-строку.
 *
 * Оба «наших» формата (14 цифр, Go-style без зоны) — ЛОКАЛЬНОЕ время
 * магазина (не UTC!), поэтому парсим через `new Date(y, m-1, d, h, mi, s)`,
 * а не `Date.UTC`/`Date.parse`.
 *
 * НО если строка САМА несёт зону (заканчивается на `Z` или `±HH:MM`,
 * например `2026-05-16T04:54:18.000Z` — такое может прилететь если
 * какой-то путь когда-то записал `toISOString()` в эту колонку) — её
 * нужно парсить как есть через `Date.parse`, иначе `Z` тихо отбрасывается
 * регэкспом и UTC-время трактуется как локальное (ошибка в несколько
 * часов, зависит от TZ магазина).
 *
 * Оба regex'а заякорены (`^...$` / `^...$` с фиксированной длиной групп) —
 * не матчим по префиксу.
 *
 * Если строка не распознана (legacy/битые данные) — используем
 * `fallbackEpochSec` (обычно `fiscalized_at`/`refunded_at`).
 */
export function toIso(fiscalDatetime: string | null | undefined, fallbackEpochSec: number): string {
  const raw = (fiscalDatetime ?? '').trim()

  // Строка сама несёт таймзону (Z или ±HH:MM) — доверяем ей буквально,
  // Date.parse корректно учтёт смещение.
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(raw)) {
    const parsed = Date.parse(raw)
    if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  }

  // 14 цифр подряд, ничего больше: YYYYMMDDHHMMSS
  const digitsMatch = raw.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/)
  if (digitsMatch) {
    const [, y, mo, d, h, mi, s] = digitsMatch
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString()
  }

  // Go-style/ISO с разделителями, без зоны: "2026-05-16 09:54:18" или
  // "2026-05-16T09:54:18" (опционально с миллисекундами), до конца строки.
  const sepMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?$/)
  if (sepMatch) {
    const [, y, mo, d, h, mi, s] = sepMatch
    return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString()
  }

  return new Date(fallbackEpochSec * 1000).toISOString()
}

/** Распарсить JSON, возвращая `null` вместо throw при некорректном вводе. */
function safeParseJson(s: string | null | undefined): unknown {
  if (!s) return null
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/**
 * Вычистить `ExtraInfo`/`extraInfo` из распарсенного `request_json` перед тем
 * как класть его в `raw_request` (payload шлётся на сервер ДОСЛОВНО).
 *
 * Сегодня в extraInfo лежит только `cardType` — утечки ПД нет. Но
 * `JsonRpcExtraInfo` (см. jsonrpc-client.ts) уже объявляет `tin`/`pinfl`
 * (ИНН/ПИНФЛ покупателя) — тот же ключ у обоих написаний. Как только UI
 * начнёт их собирать, они уедут на сервер без единой правки ЭТОГО файла и
 * без падающего теста — raw_request копирует request_json как есть. Чистим
 * на входе заранее, пока это дёшево, а не когда поле уже используется.
 *
 * Рекурсивно и без привязки к конкретной вложенности — EPOS кладёт
 * ExtraInfo/extraInfo в `params.Receipt`, FiscalDriveService в `receipt`
 * (только PascalCase), но обходить оба пути отдельно не нужно: любой ключ
 * `ExtraInfo`/`extraInfo` на любом уровне вырезается целиком.
 */
export function stripExtraInfo(raw: unknown): unknown {
  if (Array.isArray(raw)) {
    return raw.map(stripExtraInfo)
  }
  if (raw !== null && typeof raw === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (key === 'ExtraInfo' || key === 'extraInfo') continue
      out[key] = stripExtraInfo(value)
    }
    return out
  }
  return raw
}

/** Информация из esf_items, нужная для одной позиции payload. */
export interface EsfJoinInfo {
  serverItemId: number | null
  unitPriceTiyin: number
  packageCode: string
}

/**
 * Собрать `items[]` payload: позиции, реально ушедшие в ОФД (из
 * `parseRequestJsonReceipt(request_json).items`), обогащённые
 * `inv_item_id`/`unit_cost_tiyin`/`package_code` из `esf_items` через
 * `match_items`.
 *
 * Сопоставление — ПО ПОРЯДКУ: `matchItemsOrdered[i]` (отсортированные
 * `match_items.id ASC`) соответствует `parsedItems[i]`. Если количество
 * строк не совпало (нет match_id / manual picker / расхождение после
 * distributeDiscount-Bump) — обогащение не делаем, оставляем поля null,
 * НЕ пытаемся угадать пары.
 */
export function buildSaleItems(
  parsedItems: NormalizedReceiptItem[],
  matchItemsOrdered: Array<{ esfItemId: number }>,
  esfInfoByLocalId: Map<number, EsfJoinInfo>,
  strategy: string | null,
): SalesSyncItemPayload[] {
  const aligned = matchItemsOrdered.length === parsedItems.length

  return parsedItems.map((item, idx) => {
    const mi = aligned ? matchItemsOrdered[idx] : undefined
    const esf = mi ? (esfInfoByLocalId.get(mi.esfItemId) ?? null) : null

    return {
      name: item.name,
      class_code: item.classCode,
      package_code: esf?.packageCode ?? null,
      qty_milli: item.amount,
      price_tiyin: item.priceTiyin,
      discount_tiyin: item.discountTiyin,
      vat_tiyin: item.vatTiyin,
      vat_percent: item.vatPercent,
      inv_item_id: esf?.serverItemId ?? null,
      unit_cost_tiyin: esf?.unitPriceTiyin ?? null,
      ms_name: null,
      ms_price_tiyin: null,
      strategy,
    }
  })
}

/**
 * Состав чека МойСклад целиком (до подмены ИКПУ) — из `ms_receipts.raw_json`.
 * `null`/битый JSON → пустой массив (не блокируем отправку самого чека
 * из-за того что не смогли восстановить состав МС).
 */
export function buildMsItems(rawJson: string | null | undefined): SalesSyncMsItemPayload[] {
  if (!rawJson) return []
  try {
    const rd = JSON.parse(rawJson) as MsRetailDemand
    return extractPositions(rd).map((p) => ({
      name: p.name,
      qty_milli: p.quantity,
      total_tiyin: p.totalTiyin,
    }))
  } catch {
    return []
  }
}

/** Собрать один элемент `refunds[]` payload из строки `fiscal_refunds`. */
export function buildRefundPayload(row: FiscalRefundRow): SalesSyncRefundPayload {
  return {
    fiscal_sign: row.fiscal_sign,
    fiscal_datetime: toIso(row.fiscal_datetime, row.refunded_at),
    is_partial: row.is_partial === 1,
    cash_tiyin: row.refund_cash_tiyin,
    card_tiyin: row.refund_card_tiyin,
    total_tiyin: row.refund_cash_tiyin + row.refund_card_tiyin + row.refund_qr_tiyin,
    items_snapshot: safeParseJson(row.refunded_items_snapshot),
    reason: row.reason ?? null,
  }
}

// ── Сборка одного sale-entry из строк БД ────────────────────────────

interface MsReceiptSlice {
  ms_id: string
  ms_name: string | null
  ms_sum_tiyin: number
  raw_json: string
}

/**
 * Собрать payload одного чека из уже прочитанных строк БД. Чистая функция
 * (без обращения к БД) — все данные передаются явно, что и делает её
 * тестируемой без mock'а SQLite.
 *
 * НИКОГДА не возвращает `null`. Раньше нераспознанный `request_json`
 * (главным образом — чеки, пробитые ДО 0.10.13 через legacy `/uzpos`,
 * формат `{token, method:'sale', params:{items, receivedCash, ...},
 * extraInfo:{...}}` вместо `params.Receipt`) приводил к `null` → чек
 * пропускался в цикле → никогда не помечался `synced_to_server=1` →
 * висел в очереди навсегда. Выборка идёт `ORDER BY id LIMIT N`, у
 * legacy-чеков самые маленькие id — при ≥N таких чеков не уезжал бы ни
 * один чек вообще, молча.
 *
 * Вместо этого при нераспознанном `request_json` отдаём «деградированную»
 * запись: реальные колонки чека (`fiscal_sign`/`terminal_id`/`receipt_seq`/
 * `fiscal_datetime`/`qr_code_url`/…) есть всегда независимо от формата,
 * их и шлём. `items: []` (позиции восстановить не можем без парсинга
 * legacy-формата), `raw_request: null` — legacy-блоб содержит
 * `extraInfo:{tin, pinfl}` (ПД клиента), поэтому сырой legacy JSON НЕ
 * попадает в payload ни при каких условиях. Денежная сумма — из
 * `matches.total_tiyin` если у чека есть `match_id` (кладём в cash_tiyin,
 * т.к. реального сплита cash/card без парсинга не знаем — total=cash+card
 * остаётся инвариантом), иначе 0.
 *
 * Тот же мотив (extraInfo может нести ПД) применяется и к РАСПОЗНАННОМУ
 * `request_json` ниже: `raw_request` идёт через `stripExtraInfo`, а не
 * кладётся как есть — см. её doc-comment.
 */
export function buildSaleEntry(input: {
  receipt: FiscalReceiptRow
  msReceipt: MsReceiptSlice | null
  matchStrategy: string | null
  matchTotalTiyin: number | null
  matchItemsOrdered: Array<{ esfItemId: number }>
  esfInfoByLocalId: Map<number, EsfJoinInfo>
  refunds: FiscalRefundRow[]
}): SalesSyncSaleEntry {
  const { receipt, msReceipt, matchStrategy, matchTotalTiyin, matchItemsOrdered, esfInfoByLocalId, refunds } =
    input

  const parsed = parseRequestJsonReceipt(receipt.request_json)

  if (!parsed) {
    // Деградированная запись — см. комментарий выше.
    const totalTiyin = matchTotalTiyin ?? 0
    return {
      fiscal_sign: receipt.fiscal_sign,
      terminal_id: receipt.terminal_id,
      receipt_seq: receipt.receipt_seq,
      fiscal_datetime: toIso(receipt.fiscal_datetime, receipt.fiscalized_at),
      qr_code_url: receipt.qr_code_url,
      ms_receipt_id: msReceipt?.ms_id ?? null,
      ms_receipt_name: msReceipt?.ms_name ?? null,
      ms_total_tiyin: msReceipt?.ms_sum_tiyin ?? null,
      total_tiyin: totalTiyin,
      // Реальный split нал/карта из legacy-блоба не восстановить, а записать
      // всю сумму в наличные — значит выдумать способ оплаты и испортить
      // отчёт «нал/карта». Оставляем нули: выручка (total_tiyin) верная, а
      // в колонке «Оплата» админка честно покажет «—».
      cash_tiyin: 0,
      card_tiyin: 0,
      vat_tiyin: 0,
      excluded_payment_tiyin: receipt.excluded_payment_tiyin,
      card_kind: receipt.card_kind,
      matcher_strategy: matchStrategy,
      is_test: false,
      fiscalized_at: new Date(receipt.fiscalized_at * 1000).toISOString(),
      raw_request: null,
      ms_items: buildMsItems(msReceipt?.raw_json),
      items: [],
      refunds: refunds.map(buildRefundPayload),
    }
  }

  const items = buildSaleItems(parsed.items, matchItemsOrdered, esfInfoByLocalId, matchStrategy)
  const vatTiyin = parsed.items.reduce((sum, it) => sum + it.vatTiyin, 0)

  return {
    fiscal_sign: receipt.fiscal_sign,
    terminal_id: receipt.terminal_id,
    receipt_seq: receipt.receipt_seq,
    fiscal_datetime: toIso(receipt.fiscal_datetime, receipt.fiscalized_at),
    qr_code_url: receipt.qr_code_url,
    ms_receipt_id: msReceipt?.ms_id ?? null,
    ms_receipt_name: msReceipt?.ms_name ?? null,
    ms_total_tiyin: msReceipt?.ms_sum_tiyin ?? null,
    total_tiyin: parsed.receivedCashTiyin + parsed.receivedCardTiyin,
    cash_tiyin: parsed.receivedCashTiyin,
    card_tiyin: parsed.receivedCardTiyin,
    vat_tiyin: vatTiyin,
    excluded_payment_tiyin: receipt.excluded_payment_tiyin,
    card_kind: receipt.card_kind,
    matcher_strategy: matchStrategy,
    is_test: false,
    fiscalized_at: new Date(receipt.fiscalized_at * 1000).toISOString(),
    // stripExtraInfo — см. её doc-comment: ExtraInfo/extraInfo может содержать
    // ПД покупателя (tin/pinfl), request_json копируется на сервер дословно.
    raw_request: stripExtraInfo(safeParseJson(receipt.request_json)),
    ms_items: buildMsItems(msReceipt?.raw_json),
    items,
    refunds: refunds.map(buildRefundPayload),
  }
}

// ── DB-обвязка (не чистая — читает/пишет SQLite) ────────────────────

/**
 * Прочитать всё, что нужно для payload одного чека, и собрать sale-entry.
 * Возвращает также id refund'ов, реально попавших в payload — чтобы
 * пометить именно их synced_to_server=1 после успешной отправки.
 *
 * Никогда не возвращает null — `buildSaleEntry` всегда отдаёт запись (см.
 * его комментарий). Если `request_json` не распознан, здесь только логируем
 * это (диагностика), сама деградация сумма/items — забота `buildSaleEntry`.
 */
async function loadSaleEntry(
  db: Database,
  receipt: FiscalReceiptRow,
): Promise<{ sale: SalesSyncSaleEntry; refundIds: number[] }> {
  const msRows = await db.select<MsReceiptSlice[]>(
    `SELECT ms_id, ms_name, ms_sum_tiyin, raw_json FROM ms_receipts WHERE id = $1 LIMIT 1`,
    [receipt.ms_receipt_id],
  )
  const msReceipt = msRows[0] ?? null

  let matchStrategy: string | null = null
  let matchTotalTiyin: number | null = null
  let matchItemsOrdered: Array<{ esfItemId: number }> = []

  if (receipt.match_id != null) {
    const matchRows = await db.select<Array<{ strategy: string; total_tiyin: number }>>(
      `SELECT strategy, total_tiyin FROM matches WHERE id = $1 LIMIT 1`,
      [receipt.match_id],
    )
    matchStrategy = matchRows[0]?.strategy ?? null
    matchTotalTiyin = matchRows[0]?.total_tiyin ?? null

    const miRows = await db.select<Array<{ esf_item_id: number }>>(
      `SELECT esf_item_id FROM match_items WHERE match_id = $1 ORDER BY id ASC`,
      [receipt.match_id],
    )
    matchItemsOrdered = miRows.map((r) => ({ esfItemId: r.esf_item_id }))
  }

  const esfInfoByLocalId = new Map<number, EsfJoinInfo>()
  const esfIds = [...new Set(matchItemsOrdered.map((m) => m.esfItemId))]
  if (esfIds.length > 0) {
    const placeholders = esfIds.map((_, i) => `$${i + 1}`).join(',')
    const esfRows = await db.select<
      Array<{ id: number; server_item_id: number | null; unit_price_tiyin: number; package_code: string }>
    >(
      `SELECT id, server_item_id, unit_price_tiyin, package_code FROM esf_items WHERE id IN (${placeholders})`,
      esfIds,
    )
    for (const r of esfRows) {
      esfInfoByLocalId.set(r.id, {
        serverItemId: r.server_item_id,
        unitPriceTiyin: r.unit_price_tiyin,
        packageCode: r.package_code,
      })
    }
  }

  const refunds = await db.select<FiscalRefundRow[]>(
    `SELECT * FROM fiscal_refunds WHERE original_fiscal_id = $1 ORDER BY id ASC`,
    [receipt.id],
  )

  if (parseRequestJsonReceipt(receipt.request_json) === null) {
    void log.warn(
      'sales-sync',
      `fiscal_receipt #${receipt.id}: request_json не распознан (legacy /uzpos или битый формат) — ` +
        `отправлен как деградированная запись (items: [], без позиций)`,
    )
  }

  const sale = buildSaleEntry({
    receipt,
    msReceipt,
    matchStrategy,
    matchTotalTiyin,
    matchItemsOrdered,
    esfInfoByLocalId,
    refunds,
  })

  return { sale, refundIds: refunds.map((r) => r.id) }
}

async function markSynced(db: Database, receiptIds: number[], refundIds: number[]): Promise<void> {
  if (receiptIds.length > 0) {
    const placeholders = receiptIds.map((_, i) => `$${i + 1}`).join(',')
    await db.execute(
      `UPDATE fiscal_receipts SET synced_to_server = 1 WHERE id IN (${placeholders})`,
      receiptIds,
    )
  }
  if (refundIds.length > 0) {
    const placeholders = refundIds.map((_, i) => `$${i + 1}`).join(',')
    await db.execute(
      `UPDATE fiscal_refunds SET synced_to_server = 1 WHERE id IN (${placeholders})`,
      refundIds,
    )
  }
}

/** Guard от параллельных запусков — см. `flushSalesToServer`. */
let inFlight: Promise<void> | null = null

/**
 * Отправлен ли уже `log.error` про текущую серию 404 (см. `runFlushCycle`).
 * Сбрасывается при первом же успехе, чтобы следующая серия 404 (например
 * после того как кто-то на 5 минут сломал прокси) снова дала один error.
 */
let logged404Once = false

/**
 * Потолок ожидания сервера при отправке пачки чеков.
 *
 * До этого таймаута не было вовсе, и цена оказалась высокой: зависший POST
 * навсегда залипал guard `inFlight` (см. `flushSalesToServer`), магазин
 * переставал синхронизироваться совсем и не писал об этом ни строчки.
 * 60 сек с запасом хватает на пачку из 20 чеков даже на плохом канале.
 */
const SALES_TIMEOUT_MS = 60_000

/**
 * Сколько держим guard `inFlight` прежде чем счесть флаш зависшим.
 * Заведомо больше `SALES_TIMEOUT_MS` × запас на цепочку догоняющих флашей.
 */
const INFLIGHT_MAX_MS = 10 * 60_000

/** Когда стартовал текущий флаш — для сторожа выше. */
let inFlightStartedAt = 0

/** Раз во сколько тиков проверяем здоровье очереди (тик = 60 сек → раз в 30 мин). */
const QUEUE_CHECK_EVERY = 30

/** С какого возраста самого старого неотправленного чека бьём тревогу. */
const BACKLOG_ALERT_HOURS = 24

let queueCheckCounter = 0
let loggedBacklogOnce = false

/** Сообщали ли уже про ненастроенный сервер — чтобы не писать это каждую минуту. */
let loggedNoConfigOnce = false

/** Потолок доп.флашей подряд в рамках одного тика — см. `runFlushCycle`. */
const MAX_CHAIN_FLUSHES = 25

/**
 * Публичная точка входа флашера.
 *
 * Guard `inFlight`: если предыдущий вызов (например от таймера) ещё не
 * завершился к моменту следующего тика (POST не уложился в 60 сек),
 * возвращаем ТУ ЖЕ промису вместо того чтобы стартовать второй
 * параллельный флаш — иначе оба выберут одни и те же unsynced-строки
 * и задвоят отправку (сервер идемпотентен, но зачем множить трафик и
 * гонки на markSynced).
 *
 * Никогда не throw'ит — вся обработка ошибок внутри `runFlushCycle`.
 */
export async function flushSalesToServer(): Promise<void> {
  // Сторож на случай, если промис всё-таки залипнет.
  //
  // Сам guard `inFlight` — правильный, но у него есть цена: пока промис не
  // завершился, флашер стоит. Один незавершающийся вызов = магазин молча
  // выпадает из синхронизации навсегда. Именно так и вышло: POST без
  // таймаута висел, guard не снимался, и Хонабод три месяца не отправил ни
  // одного чека. Таймаут в `fetchWithTimeout` закрывает известную причину,
  // сторож — все остальные: держим guard не дольше INFLIGHT_MAX_MS.
  if (inFlight) {
    const heldMs = Date.now() - inFlightStartedAt
    if (heldMs < INFLIGHT_MAX_MS) return inFlight
    void log.error(
      'sales-sync',
      `предыдущий флаш висит ${Math.round(heldMs / 1000)} сек — снимаю блокировку и начинаю заново`,
    )
    inFlight = null
  }

  inFlightStartedAt = Date.now()
  const started = inFlight = runFlushChain(0).finally(() => {
    // Только если это всё ещё НАШ промис: сторож мог обнулить inFlight и
    // запустить новый флаш, и зависший старый не должен его затирать.
    if (inFlight === started) inFlight = null
  })
  return inFlight
}

/**
 * Прогнать `runFlushCycle` и, если за один раз ушёл полный батч (значит в
 * очереди наверняка есть ещё), сразу продолжить — не ждать 60 сек до
 * следующего таймера. Актуально при разборе накопленной истории (например
 * после первого запуска этой фичи на магазине с тысячами старых чеков) —
 * без чейнинга это тянулось бы часами по 20 штук в минуту.
 *
 * `MAX_CHAIN_FLUSHES` — защита от бесконечного цикла в рамках одного тика
 * (если поток новых чеков не иссякает быстрее чем мы их разбираем).
 * Остаток доедет по обычному таймеру.
 */
async function runFlushChain(chainDepth: number): Promise<void> {
  const batchWasFull = await runFlushCycle()
  if (!batchWasFull) return
  if (chainDepth + 1 >= MAX_CHAIN_FLUSHES) {
    void log.warn(
      'sales-sync',
      `догонка остановлена по лимиту ${MAX_CHAIN_FLUSHES} флашей подряд, остаток доедет по таймеру (60 сек)`,
    )
    return
  }
  await runFlushChain(chainDepth + 1)
}

/**
 * Один цикл flush'а — выбрать unsynced чеки, собрать payload, отправить,
 * пометить synced.
 *
 * Возвращает `true`, если стоит немедленно повторить (успешно отправили
 * полный батч — вероятно есть ещё), иначе `false`.
 *
 * Никогда не throw'ит — ошибки логируем через log.warn/log.error.
 */
async function runFlushCycle(): Promise<boolean> {
  try {
    const serverUrl = await getSetting(SettingKey.InventoryServerUrl)
    const apiKey = await getSetting(SettingKey.InventoryShopApiKey)
    if (!serverUrl || !apiKey) {
      // Раньше здесь был немой `return` — магазин без настроек не отправлял
      // ничего и молчал об этом. Один log.error за сессию: и админ увидит
      // в телеметрии, и логи не заспамим (тик раз в 60 сек).
      if (!loggedNoConfigOnce) {
        loggedNoConfigOnce = true
        void log.error(
          'sales-sync',
          'синхронизация продаж выключена: не заданы адрес сервера или ключ магазина (Настройки → Inventory)',
        )
      }
      return false
    }
    loggedNoConfigOnce = false

    // Exp backoff после подряд-failures, тот же приём что в telemetry.ts:
    // шанс попытки = 1 / 2^failures, просто пропускаем тик если не повезло.
    if (consecutiveFailures > 0) {
      const chance = 1 / Math.pow(2, Math.min(consecutiveFailures, 6))
      if (Math.random() > chance) return false
    }

    const db = await getDb()
    await checkQueueHealth(db)

    // Берём и чеки, которые ещё не уехали, и уже уехавшие, у которых появился
    // неотправленный возврат. Без второго условия возвраты не доезжали бы почти
    // никогда: покупатель приходит через день-два, а чек уходит на сервер
    // в течение минуты после продажи. Сервер обрабатывает блок refunds даже
    // когда шапка чека приходит дублем.
    //
    // Форма запроса — намеренно НЕ `WHERE synced_to_server = 0 OR id IN (...)`:
    // такое условие не может использовать частичные индексы (EXPLAIN
    // показывает `SCAN fiscal_receipts` — полный скан таблицы на каждый тик,
    // раз в 60 сек, по всем строкам когда-либо созданным). Форма ниже —
    // `id IN (SELECT ... UNION SELECT ...)` — использует оба частичных
    // индекса (`idx_fiscal_receipts_unsynced` и `idx_fiscal_refunds_unsynced`
    // на `original_fiscal_id`, см. migration 015) и достаёт только маленький
    // хвост unsynced-строк независимо от размера таблицы.
    const receipts = await db.select<FiscalReceiptRow[]>(
      `SELECT * FROM fiscal_receipts WHERE id IN (
         SELECT id FROM fiscal_receipts WHERE synced_to_server = 0
         UNION
         SELECT original_fiscal_id FROM fiscal_refunds WHERE synced_to_server = 0
       ) ORDER BY id LIMIT $1`,
      [BATCH_SIZE],
    )
    if (receipts.length === 0) {
      consecutiveFailures = 0
      return false
    }

    const sales: SalesSyncSaleEntry[] = []
    const includedReceiptIds: number[] = []
    const includedRefundIds: number[] = []
    // Чеки, для которых сборка payload упала с исключением (не путать с
    // «деградированной» записью buildSaleEntry — та не бросает). Такие
    // помечаем synced БЕЗУСЛОВНО (независимо от результата POST), иначе
    // они, как legacy-null раньше, застрянут в очереди навсегда и по
    // `ORDER BY id` заблокируют всё что идёт следом. Цена — эта конкретная
    // запись не уедет на сервер, зато очередь не встаёт колом; log.error
    // чтобы админ увидел и разобрался руками.
    const poisonReceiptIds: number[] = []

    for (const receipt of receipts) {
      try {
        const entry = await loadSaleEntry(db, receipt)
        sales.push(entry.sale)
        includedReceiptIds.push(receipt.id)
        includedRefundIds.push(...entry.refundIds)
      } catch (e) {
        poisonReceiptIds.push(receipt.id)
        void log.error(
          'sales-sync',
          `fiscal_receipt #${receipt.id}: не удалось собрать payload, чек помечен synced БЕЗ отправки на сервер (иначе блокирует очередь) — ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }

    if (poisonReceiptIds.length > 0) {
      await markSynced(db, poisonReceiptIds, [])
    }

    // Весь батч оказался «ядовитым» — не считаем это сетевым failure
    // (сервер тут ни при чём, backoff не нужен), но и нет смысла бить
    // пустой POST.
    if (sales.length === 0) {
      consecutiveFailures = 0
      return false
    }

    const url = serverUrl.replace(/\/$/, '') + '/api/v1/inventory/sales'
    const res = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          app_version: APP_VERSION,
          sales,
        } satisfies SalesSyncPayload),
      },
      SALES_TIMEOUT_MS,
      'POST /inventory/sales',
    )

    if (res.status >= 200 && res.status < 300) {
      await markSynced(db, includedReceiptIds, includedRefundIds)
      consecutiveFailures = 0
      logged404Once = false
      loggedStallOnce = false

      // Сервер мог принять пачку, но отклонить отдельные чеки (он изолирует
      // каждый SAVEPOINT'ом). Такие чеки помечены synced выше вместе со всеми —
      // это осознанно: повторная отправка даст ту же ошибку, а очередь встанет
      // колом. Чек остаётся в ОФД и в локальной БД, теряется только серверная
      // копия — поэтому log.error, чтобы админ увидел причину в телеметрии.
      const failed = await readFailed(res)
      if (failed.length > 0) {
        void log.error(
          'sales-sync',
          `сервер отклонил ${failed.length} чек(ов), они помечены synced без серверной копии: ` +
            failed.map((f) => `${f.fiscal_sign}: ${f.reason}`).join(' | '),
        )
      }
      return receipts.length === BATCH_SIZE
    }

    // Не-2xx — failure, ничего не помечаем (повторим в следующем тике).
    // ВАЖНО: 404 сюда же — `/api/v1/inventory/sales` уже задеплоен и
    // работает (в отличие от telemetry.ts, где 404 когда-то означало «ещё
    // не задеплоено» и можно было безопасно списать лог). Здесь 404 —
    // ошибка конфигурации клиента (не тот InventoryServerUrl, сломанный
    // прокси и т.п.), а пометка synced на 404 означала бы безвозвратную
    // потерю финансовых записей. Первый 404 подряд — через log.error
    // (уйдёт в телеметрию, админ увидит и поправит конфиг), последующие —
    // log.warn, чтобы не заспамить.
    consecutiveFailures += 1
    if (res.status === 404) {
      if (!logged404Once) {
        logged404Once = true
        void log.error(
          'sales-sync',
          `HTTP 404 при POST /api/v1/inventory/sales — эндпоинт задеплоен, проверьте InventoryServerUrl/прокси в Настройках (подряд-ошибок ${consecutiveFailures})`,
        )
      } else {
        void log.warn(
          'sales-sync',
          `HTTP 404 при POST /api/v1/inventory/sales (подряд-ошибок ${consecutiveFailures})`,
        )
      }
    } else {
      reportStall(`HTTP ${res.status} при POST /api/v1/inventory/sales`)
    }
    return false
  } catch (e) {
    consecutiveFailures += 1
    reportStall(`flush упал — ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

/**
 * Ошибка синхронизации: пока она разовая — warn (сеть моргнула, идёт деплой).
 * Но если очередь стоит STALL_THRESHOLD тиков подряд — это уже поломка, и
 * её надо увидеть.
 *
 * Почему это важно: раньше здесь был только log.warn, а warn остаётся
 * ЛОКАЛЬНО (в телеметрию уходит лишь level='error'). Из-за этого магазин
 * Хонабод месяц не отправлял на сервер ни одного чека — очередь упёрлась в
 * чек, который сервер не мог принять, клиент честно писал warn в свою
 * SQLite, и снаружи это выглядело просто как «продаж нет».
 */
function reportStall(message: string): void {
  if (consecutiveFailures >= STALL_THRESHOLD && !loggedStallOnce) {
    loggedStallOnce = true
    void log.error(
      'sales-sync',
      `очередь продаж не уезжает на сервер ${consecutiveFailures} попыток подряд — ${message}`,
    )
    return
  }
  void log.warn('sales-sync', `${message} (подряд-ошибок ${consecutiveFailures})`)
}

/**
 * Проверка «а очередь вообще движется?».
 *
 * Все ошибки отправки — сетевые, поэтому обычно это warn: канал моргнул,
 * идёт деплой, через минуту повторим. Из-за этого поломка синхронизации
 * выглядит ровно как исправная работа, и заметить её можно только по
 * отсутствию продаж на сервере — то есть недели спустя. Здесь мы смотрим на
 * результат, а не на попытки: если самый старый неотправленный чек висит
 * дольше суток, что-то сломано, независимо от причины.
 *
 * Считаем редко (раз в QUEUE_CHECK_EVERY тиков) — запрос по частичному
 * индексу дешёвый, но и раз в минуту он не нужен.
 */
async function checkQueueHealth(db: Database): Promise<void> {
  queueCheckCounter += 1
  if (queueCheckCounter % QUEUE_CHECK_EVERY !== 1) return

  try {
    const rows = await db.select<Array<{ oldest: number | null; total: number }>>(
      `SELECT MIN(fiscalized_at) AS oldest, COUNT(*) AS total
         FROM fiscal_receipts WHERE synced_to_server = 0`,
    )
    const oldest = rows[0]?.oldest
    const total = rows[0]?.total ?? 0
    if (!oldest || total === 0) {
      loggedBacklogOnce = false
      return
    }

    const ageHours = (Date.now() / 1000 - oldest) / 3600
    if (ageHours < BACKLOG_ALERT_HOURS) {
      loggedBacklogOnce = false
      return
    }
    if (loggedBacklogOnce) return

    loggedBacklogOnce = true
    void log.error(
      'sales-sync',
      `очередь продаж не уезжает: ${total} чек(ов) не отправлено, самый старый ждёт ${Math.round(ageHours)} ч. ` +
        `Чеки целы (они в ОФД и в локальной базе), но на сервере их нет — проверьте связь с mytoolbox.`,
    )
  } catch {
    // Диагностика не должна ронять сам флаш.
  }
}

/** Разбор `failed[]` из ответа сервера. Тело может быть чем угодно — не роняем flush. */
async function readFailed(res: Response): Promise<Array<{ fiscal_sign: string; reason: string }>> {
  try {
    const body = (await res.json()) as { failed?: unknown }
    if (!Array.isArray(body?.failed)) return []
    return body.failed.map((f) => ({
      fiscal_sign: String((f as { fiscal_sign?: unknown })?.fiscal_sign ?? '?'),
      reason: String((f as { reason?: unknown })?.reason ?? 'причина не указана'),
    }))
  } catch {
    return []
  }
}
