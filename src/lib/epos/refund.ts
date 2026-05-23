/**
 * Возврат фискального чека (full refund на MVP).
 *
 * Поток:
 *   1. Загружаем оригинальный fiscal_receipts + его request_json (там есть
 *      все Items с правильными ИКПУ, ценами, скидками — пересобирать
 *      из match_items не надо, request_json — точная копия что уехало).
 *   2. Парсим request_json → получаем JsonRpcReceipt из оригинала.
 *   3. Из ms_receipts.raw_json берём как было распределено по cash/card/qr.
 *      По дефолту refund_cash/card/qr = соответствующие поля оригинала
 *      (магазин возвращает деньги тем же каналом). UI может переопределить.
 *   4. Строим payload refund:
 *      - Items = items оригинала (как есть, со скидками)
 *      - ReceivedCash/Card = refund-суммы (что отдаём покупателю)
 *      - RefundInfo = { terminalId, receiptSeq, dateTime, fiscalSign } из оригинала
 *   5. Отправляем `Api.SendRefundReceipt` через JsonRpcEposClient.
 *   6. На успех:
 *      - INSERT fiscal_refunds (terminal_id/receipt_seq/fiscal_sign возврата)
 *      - POST /api/v1/inventory/unconsume → возврат остатков в пул
 *      - Если /unconsume вернул 404 (endpoint не задеплоен) — кладём в
 *        inv_pending_confirms (op_type='unconsume') для retry на стартe app
 *      - Печать refund-чека на термопринтер (с шапкой «ВОЗВРАТ»)
 *
 * Защиты:
 *   - UNIQUE(original_fiscal_id) в схеме БД — двойной refund невозможен,
 *     даже если кассир обойдёт UI-проверку
 *   - Тестовый режим: skip Communicator + /unconsume, печать с шапкой «ТЕСТ»
 *   - Смена должна быть открыта (как и для sale) — иначе ОФД отказывает
 */

import {
  getDb,
  getMsReceipt,
  getRefundByOriginalFiscalId,
  getSetting,
  insertFiscalRefund,
  now,
  SettingKey,
  type FiscalReceiptRow,
  type FiscalRefundRow,
} from '@/lib/db'
import { log } from '@/lib/log'
import {
  formatPrintDate,
  formatTiyinForPrint,
  formatQtyForPrint,
  printFiscalReceipt,
  type ReceiptData,
  type ReceiptItem,
} from '@/lib/printer'
import {
  getInventoryClient,
  loadInventoryConfig,
} from '@/lib/inventory'
import {
  JsonRpcEposClient,
  formatGoTime,
  type JsonRpcItem,
  type JsonRpcReceipt,
  type JsonRpcRefundInfo,
  type JsonRpcFiscalAnswer,
} from './jsonrpc-client'
import type { FiscalReceiptInfo } from './types'

/** Входные параметры для refund (от UI). */
export interface ProcessRefundOptions {
  /** Оригинальный продажный чек (fiscal_receipts.id). */
  originalFiscalId: number
  /** Куда возвращаем деньги. Если не указано — берём пропорцию из оригинала. */
  refundCashTiyin?: number
  refundCardTiyin?: number
  refundQrTiyin?: number
  /** Свободный текст: причина возврата (для аудита). */
  reason?: string
}

export interface ProcessRefundResult {
  fiscal: FiscalReceiptInfo
  refundDbId: number
}

/**
 * Кастомная ошибка для UI: на этот чек уже был возврат.
 * UI ловит и показывает «Этот чек уже возвращён <date>».
 */
export class RefundAlreadyExistsError extends Error {
  constructor(public readonly existing: FiscalRefundRow) {
    super(`Чек уже возвращён ${new Date(existing.refunded_at * 1000).toLocaleString('ru-RU')}`)
    this.name = 'RefundAlreadyExistsError'
  }
}

/**
 * Главная функция возврата чека.
 */
export async function processRefund(opts: ProcessRefundOptions): Promise<ProcessRefundResult> {
  // 1. Проверка: ещё не возвращали?
  const existing = await getRefundByOriginalFiscalId(opts.originalFiscalId)
  if (existing) {
    throw new RefundAlreadyExistsError(existing)
  }

  // 2. Грузим оригинал.
  const original = await loadOriginal(opts.originalFiscalId)

  // 3. Определяем суммы возврата (по каналам оплаты).
  // По дефолту = как было оплачено. UI может переопределить.
  const originalReceipt = parseRequest(original.fr.request_json)
  const refundCash = opts.refundCashTiyin ?? originalReceipt.ReceivedCash
  const refundCard = opts.refundCardTiyin ?? originalReceipt.ReceivedCard
  const refundQr = opts.refundQrTiyin ?? 0 // в JsonRpcReceipt нет отдельного QR

  const refundTotal = refundCash + refundCard + refundQr
  if (refundTotal <= 0) {
    throw new Error('Сумма возврата = 0. Укажите какую сумму и каким способом возвращаем.')
  }

  // 4. Тестовый режим — skip Communicator + /unconsume.
  const testMode = (await getSetting(SettingKey.TestMode)) === 'true'
  if (testMode) {
    await log.info(
      'refund',
      'ТЕСТОВЫЙ РЕЖИМ: skip Communicator, печатаю «ТЕСТ — ВОЗВРАТ»',
      { originalFiscalId: opts.originalFiscalId, refundTotal },
    )
    const fakeFiscal: FiscalReceiptInfo = {
      TerminalID: 'TEST-MODE',
      ReceiptSeq: 'TEST',
      FiscalSign: `TEST-REFUND-${Date.now()}`,
      QRCodeURL: 'тестовый режим: возврат НЕ отправлен в ОФД',
      DateTime: formatTestDateTime(new Date()),
      AppletVersion: 'TEST',
    }
    await maybePrintRefundReceipt(
      original,
      originalReceipt,
      fakeFiscal,
      refundCash,
      refundCard,
      true,
    )
    return { fiscal: fakeFiscal, refundDbId: 0 }
  }

  // 5. Билдим refund payload (Items копируем из request_json оригинала).
  //
  // ⚠️ КРИТИЧНО для привязки к оригиналу в ОФД (иначе «бириктирилмаган»):
  //
  //   1. Имя поля — `refundInfo` (camelCase). Вся дока E-POS (mobile-api +
  //      universal-communicator) показывает именно camelCase. PascalCase
  //      `RefundInfo` Communicator ИГНОРИРУЕТ → refund уходит без привязки.
  //      Шлём ОБА варианта (как с `spic` — belt & suspenders, лишний ключ
  //      Communicator молча проигнорирует).
  //
  //   2. `dateTime` — строго 14 цифр YYYYMMDDHHMMSS без разделителей
  //      (universal-communicator.md стр.111). `fiscal_datetime` оригинала
  //      может быть «2026-05-16 09:54:18» (Go-style) или ISO — нормализуем.
  const refundInfo: JsonRpcRefundInfo = {
    terminalId: original.fr.terminal_id,
    receiptSeq: original.fr.receipt_seq,
    dateTime: toRefundDateTime(original.fr.fiscal_datetime),
    fiscalSign: original.fr.fiscal_sign,
  }

  // JsonRpcReceipt типизирован с `RefundInfo`, но шлём ещё и `refundInfo`
  // (camelCase) — основной рабочий вариант по доке. Каст через unknown
  // т.к. в интерфейсе нет lowercase-ключа (он намеренный alias на проводе).
  const refundReceipt = {
    Time: formatGoTime(new Date()),
    // Items копируем как есть — те же ИКПУ, цены, скидки, НДС.
    // Это критично: ОФД сверяет с оригиналом, items должны быть идентичны.
    Items: originalReceipt.Items,
    ReceivedCash: refundCash,
    ReceivedCard: refundCard,
    RefundInfo: refundInfo, // PascalCase (на всякий)
    refundInfo, // camelCase — основной по доке E-POS
  } as unknown as JsonRpcReceipt

  const eposUrl =
    (await getSetting(SettingKey.EposCommunicatorUrl)) ??
    'http://localhost:3448/rpc/api'
  const client = new JsonRpcEposClient({ url: eposUrl })
  const requestJson = JSON.stringify({
    jsonrpc: '2.0',
    method: 'Api.SendRefundReceipt',
    params: { Receipt: refundReceipt },
  })

  await log.info('refund', 'Отправляю Api.SendRefundReceipt', {
    url: eposUrl,
    originalFiscalId: opts.originalFiscalId,
    refundInfo,
    refundCash,
    refundCard,
    itemsCount: refundReceipt.Items.length,
  })

  let answer: JsonRpcFiscalAnswer
  try {
    answer = await client.sendRefundReceipt(refundReceipt)
  } catch (e) {
    const eposError = e as { code?: number; data?: unknown; message?: string }
    await log.error('refund', `❌ Refund НЕ пробился: ${eposError.message ?? e}`, {
      url: eposUrl,
      jsonRpcCode: eposError.code,
      jsonRpcData: eposError.data,
      request: refundReceipt,
    })
    throw e
  }

  const fiscal: FiscalReceiptInfo = {
    TerminalID: answer.TerminalID,
    ReceiptSeq: answer.ReceiptSeq,
    DateTime:
      typeof answer.DateTime === 'string'
        ? answer.DateTime
        : new Date(answer.DateTime).toISOString(),
    FiscalSign: answer.FiscalSign,
    AppletVersion: answer.AppletVersion,
    QRCodeURL: answer.QRCodeURL,
  }

  await log.info('refund', `Refund фискализирован: ${fiscal.FiscalSign}`, {
    terminalId: fiscal.TerminalID,
    receiptSeq: fiscal.ReceiptSeq,
    qr: fiscal.QRCodeURL,
  })

  // 6. INSERT fiscal_refunds с RETRY.
  //
  // Refund УЖЕ в ОФД (Communicator вернул FiscalSign). Если INSERT упадёт
  // (SQLite BUSY, диск, FK violation) — UNIQUE-защита от двойного refund
  // НЕ сработает, кассир кликнет «Возврат» снова → refund уйдёт в ОФД
  // ВТОРОЙ раз (реальная потеря денег магазина).
  //
  // До 3 попыток с exp backoff (500 / 1000 ms). Если все упали — CRITICAL
  // в логи с полным контекстом + явная ошибка для UI «обратитесь в саппорт».
  // Админ восстановит запись вручную по FiscalSign из логов.
  const cashier = (await getSetting(SettingKey.MoyskladEmployeeName)) ?? null
  const refundPayload = {
    original_fiscal_id: opts.originalFiscalId,
    ms_return_id: null, // на MVP МС не интегрирован
    terminal_id: fiscal.TerminalID,
    receipt_seq: fiscal.ReceiptSeq,
    fiscal_sign: fiscal.FiscalSign,
    qr_code_url: fiscal.QRCodeURL,
    fiscal_datetime: fiscal.DateTime,
    applet_version: fiscal.AppletVersion ?? null,
    items_json: JSON.stringify(originalReceipt.Items),
    refund_cash_tiyin: refundCash,
    refund_card_tiyin: refundCard,
    refund_qr_tiyin: refundQr,
    request_json: requestJson,
    response_json: JSON.stringify(fiscal),
    reason: opts.reason ?? null,
    cashier_name: cashier,
  }
  let refundDbId: number | null = null
  let lastInsertErr: unknown = null
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      refundDbId = await insertFiscalRefund(refundPayload)
      lastInsertErr = null
      break
    } catch (e) {
      lastInsertErr = e
      await log.warn(
        'refund',
        `INSERT fiscal_refunds попытка ${attempt}/3 упала: ` +
          (e instanceof Error ? e.message : String(e)),
        { fiscalSign: fiscal.FiscalSign, attempt },
      )
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, attempt * 500))
      }
    }
  }
  if (refundDbId === null) {
    // CRITICAL — refund в ОФД, локально не сохранён. Кладём в логи ВСЁ
    // что нужно для ручного восстановления записи админом.
    await log.error(
      'refund',
      `🚨 КРИТИЧНО: refund фискализирован в ОФД (FiscalSign=${fiscal.FiscalSign}), ` +
        `но НЕ сохранён в fiscal_refunds после 3 попыток. Срочно восстановите ` +
        `запись вручную (original_fiscal_id=${opts.originalFiscalId}). Иначе ` +
        `повторный «Возврат» на этот чек пройдёт ВТОРОЙ раз в ОФД!`,
      {
        fiscal,
        originalFiscalId: opts.originalFiscalId,
        refundCash,
        refundCard,
        refundQr,
        requestJson,
        lastError:
          lastInsertErr instanceof Error
            ? lastInsertErr.message
            : String(lastInsertErr),
      },
    )
    throw new Error(
      `Refund прошёл в ОФД (FiscalSign ${fiscal.FiscalSign}), но локально ` +
        `не сохранён из-за ошибки БД. НЕ нажимайте «Возврат» повторно — ` +
        `refund уйдёт в ОФД второй раз. Обратитесь в саппорт с этим ` +
        `FiscalSign для восстановления записи.`,
    )
  }

  // 7. Возврат остатков на сервер (best-effort).
  await tryUnconsume(original, refundDbId, fiscal.FiscalSign)

  // 8. Печать на термопринтер.
  await maybePrintRefundReceipt(
    original,
    originalReceipt,
    fiscal,
    refundCash,
    refundCard,
    false,
  )

  return { fiscal, refundDbId }
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Нормализовать дату оригинала к строгому 14-значному YYYYMMDDHHMMSS
 * (формат refundInfo.dateTime по universal-communicator.md стр.111).
 *
 * `fiscal_receipts.fiscal_datetime` хранится «как вернул Communicator»:
 *   - «20260516095418»          (уже 14 цифр)        → как есть
 *   - «2026-05-16 09:54:18»     (Go-style, пробел)   → убрать разделители
 *   - «2026-05-16T09:54:18.000Z»(ISO с мс)           → цифры, первые 14
 *
 * Стратегия: выкинуть ВСЕ нецифры и взять первые 14. Это корректно для
 * всех трёх форматов и не делает timezone-математику (Communicator и так
 * отдаёт локальное время терминала Asia/Tashkent — пересчёт сломал бы).
 *
 * Бросает осмысленную ошибку если результат < 14 цифр (битый
 * `fiscal_datetime` в БД, повреждение данных). Без проверки refund уходил
 * бы в «бириктирилмаган» в soliq.uz — теперь fail-fast с понятной
 * причиной чтобы кассир не молча терял refund.
 */
function toRefundDateTime(raw: string | null | undefined): string {
  const result = (raw ?? '').replace(/\D/g, '').slice(0, 14)
  if (result.length !== 14) {
    throw new Error(
      `fiscal_datetime оригинала повреждён или пустой («${raw ?? ''}» → ` +
        `${result.length} цифр вместо 14). Refund не может быть привязан ` +
        `к оригинальному чеку в ОФД. Обратитесь в саппорт.`,
    )
  }
  return result
}

interface OriginalContext {
  fr: FiscalReceiptRow
  /** Имя позиции из ms_receipts (для печати — UI у нас в МС-имени). */
  msName: string | null
  /** match_items позиций оригинала (для /unconsume). */
  matchItems: Array<{ esf_item_id: number; quantity: number; server_item_id: number | null }>
}

async function loadOriginal(fiscalId: number): Promise<OriginalContext> {
  const db = await getDb()
  const frRows = await db.select<FiscalReceiptRow[]>(
    `SELECT * FROM fiscal_receipts WHERE id = $1 LIMIT 1`,
    [fiscalId],
  )
  const fr = frRows[0]
  if (!fr) {
    throw new Error(`Оригинальный фискальный чек id=${fiscalId} не найден`)
  }

  let msName: string | null = null
  if (fr.ms_receipt_id) {
    const ms = await getMsReceipt(fr.ms_receipt_id)
    msName = ms?.ms_name ?? null
  }

  // match_items с join к esf_items для server_item_id (нужно для /unconsume)
  let matchItems: OriginalContext['matchItems'] = []
  if (fr.match_id) {
    matchItems = await db.select<{
      esf_item_id: number
      quantity: number
      server_item_id: number | null
    }[]>(
      `SELECT mi.esf_item_id, mi.quantity, ei.server_item_id
         FROM match_items mi
         JOIN esf_items ei ON ei.id = mi.esf_item_id
        WHERE mi.match_id = $1`,
      [fr.match_id],
    )
  }

  return { fr, msName, matchItems }
}

function parseRequest(requestJson: string): JsonRpcReceipt {
  try {
    const parsed = JSON.parse(requestJson) as {
      jsonrpc: string
      method: string
      params: { Receipt: JsonRpcReceipt }
    }
    if (!parsed.params?.Receipt) {
      throw new Error('В request_json нет params.Receipt')
    }
    return parsed.params.Receipt
  } catch (e) {
    throw new Error(
      `Не удалось распарсить request_json оригинала: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

/**
 * POST /unconsume на inventory сервер. Если endpoint вернул 404
 * (не задеплоен ещё) — кладём операцию в pending_confirms для retry.
 */
async function tryUnconsume(
  original: OriginalContext,
  refundDbId: number,
  refundFiscalSign: string,
): Promise<void> {
  if (original.matchItems.length === 0) {
    await log.info('refund', 'match_items пуст — /unconsume пропущен')
    return
  }
  const items = original.matchItems
    .filter((mi) => mi.server_item_id != null)
    .map((mi) => ({ inv_item_id: mi.server_item_id!, quantity: mi.quantity }))
  if (items.length === 0) {
    await log.warn(
      'refund',
      'У всех match_items нет server_item_id (legacy excel-импорт). Остатки на сервере не возвращены.',
    )
    return
  }

  const cfg = await loadInventoryConfig()
  if (!cfg) {
    await log.warn('refund', 'Inventory не сконфигурирован — /unconsume пропущен')
    await queueUnconsumePending(items, refundDbId, refundFiscalSign, 'inventory-not-configured')
    return
  }
  const client = await getInventoryClient()
  if (!client) {
    await queueUnconsumePending(items, refundDbId, refundFiscalSign, 'inventory-client-null')
    return
  }

  try {
    const resp = await client.unconsume({
      items,
      refund_fiscal_sign: refundFiscalSign,
      idempotency_key: `refund-${refundDbId}`,
    })
    if (resp.ok) {
      await log.info('refund', `/unconsume OK — ${items.length} позиций возвращено в пул`)
      return
    }
    // ok=false но без throw — типа ALREADY_UNCONSUMED (тоже OK с точки зрения идемпотентности).
    await log.warn('refund', `/unconsume вернул code=${resp.code}`, resp)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    // Если 404 (endpoint не задеплоен) — кладём в pending, retry на старте app.
    const isNotFound = msg.includes('404') || (e as { status?: number }).status === 404
    if (isNotFound) {
      await log.warn(
        'refund',
        '/unconsume endpoint не задеплоен на сервере. Положил в pending для retry.',
      )
      await queueUnconsumePending(items, refundDbId, refundFiscalSign, 'endpoint-not-deployed')
    } else {
      await log.error('refund', `/unconsume threw: ${msg}`)
      await queueUnconsumePending(items, refundDbId, refundFiscalSign, msg)
    }
  }
}

/**
 * Положить операцию unconsume в inv_pending_confirms.
 * Используется когда сервер недоступен или endpoint ещё не задеплоен.
 *
 * NB: текущая схема inv_pending_confirms заточена под reservation_id,
 * но мы переиспользуем op_type='unconsume' добавленный миграцией 008.
 * В качестве «reservation_id» пишем синтетический ключ — для уникальности.
 */
async function queueUnconsumePending(
  items: Array<{ inv_item_id: number; quantity: number }>,
  refundDbId: number,
  refundFiscalSign: string,
  reason: string,
): Promise<void> {
  const db = await getDb()
  const ts = now()
  // Один INSERT на каждую позицию — так проще обрабатывать retry.
  for (const it of items) {
    const syntheticKey = `unconsume-${refundDbId}-${it.inv_item_id}`
    try {
      await db.execute(
        `INSERT OR IGNORE INTO inv_pending_confirms
           (reservation_id, ms_receipt_id, fiscal_sign, status, attempts,
            last_error, created_at, updated_at, op_type)
         VALUES ($1, $2, $3, 'fiscal-ok', 0, $4, $5, $5, 'unconsume')`,
        [syntheticKey, `refund-${refundDbId}`, refundFiscalSign, reason, ts],
      )
    } catch (e) {
      await log.warn(
        'refund',
        `Не удалось записать unconsume в pending: ${e instanceof Error ? e.message : String(e)}`,
        { item: it },
      )
    }
  }
}

/** Печать refund-чека на термопринтер (с шапкой «ВОЗВРАТ»). */
async function maybePrintRefundReceipt(
  original: OriginalContext,
  originalReceipt: JsonRpcReceipt,
  fiscal: FiscalReceiptInfo,
  refundCash: number,
  refundCard: number,
  isTest: boolean,
): Promise<void> {
  try {
    const enabled = (await getSetting(SettingKey.PrinterAutoPrint)) === 'true'
    if (!enabled) {
      await log.info('refund', 'Печать пропущена: авто-печать выключена в Настройках')
      return
    }
    const printerName = await getSetting(SettingKey.PrinterName)
    if (!printerName) {
      await log.warn('refund', 'Печать пропущена: принтер не выбран')
      return
    }

    const data = await buildRefundReceiptData(
      original,
      originalReceipt,
      fiscal,
      refundCash,
      refundCard,
      isTest,
    )
    const jobId = await printFiscalReceipt(printerName, data)
    await log.info('refund', `Refund-чек отправлен на печать (job #${jobId})`, {
      printer: printerName,
      isTest,
    })
  } catch (err) {
    // Печать не должна валить refund — фискальный refund уже в ОФД.
    await log.error('refund', 'Ошибка печати refund-чека', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

async function buildRefundReceiptData(
  original: OriginalContext,
  originalReceipt: JsonRpcReceipt,
  fiscal: FiscalReceiptInfo,
  refundCash: number,
  refundCard: number,
  isTest: boolean,
): Promise<ReceiptData> {
  const [name, address, phone, inn] = await Promise.all([
    getSetting(SettingKey.CompanyName),
    getSetting(SettingKey.CompanyAddress),
    getSetting(SettingKey.CompanyPhone),
    getSetting(SettingKey.CompanyInn),
  ])
  const cashier = (await getSetting(SettingKey.MoyskladEmployeeName)) ?? ''

  const items: ReceiptItem[] = originalReceipt.Items.map((it: JsonRpcItem) => ({
    name: it.Name,
    class_code: it.spic,
    qty_str: formatQtyForPrint(it.Amount),
    price_str: formatTiyinForPrint(it.Price),
    discount_str: it.Discount > 0 ? formatTiyinForPrint(it.Discount) : '',
    vat_str: formatTiyinForPrint(it.VAT),
    vat_percent: it.VATPercent ?? 0,
  }))

  const totalTiyin = originalReceipt.Items.reduce(
    (s, it) => s + it.Price - it.Discount,
    0,
  )
  const totalVatTiyin = originalReceipt.Items.reduce(
    (s, it) => s + it.VAT,
    0,
  )

  return {
    is_copy: false,
    is_test: isTest,
    is_refund: true,
    original_receipt_ref: `${original.fr.receipt_seq} от ${formatPrintDate(original.fr.fiscal_datetime)}`,
    company: {
      name: name || '',
      address: address || '',
      phone: phone || '',
      inn: inn || '',
    },
    receipt_seq: fiscal.ReceiptSeq,
    date_str: formatPrintDate(fiscal.DateTime),
    items,
    total_str: formatTiyinForPrint(totalTiyin),
    total_vat_str: formatTiyinForPrint(totalVatTiyin),
    cash_str: formatTiyinForPrint(refundCash),
    card_str: formatTiyinForPrint(refundCard),
    // Тип карты для печати — берём из оригинального чека (был выбран кассиром
    // при первичной фискализации). Печатается только если в refund реально
    // есть карточная часть (refundCard > 0) и оригинал имел сохранённый тип.
    // Для legacy-чеков до миграции 009 card_kind=null → строка не печатается.
    karta_turi: refundCard > 0 ? (original.fr.card_kind ?? '') : '',
    cashier,
    terminal_id: fiscal.TerminalID,
    fiscal_sign: fiscal.FiscalSign,
    virtual_kassa: fiscal.DateTime,
    qr_url: fiscal.QRCodeURL,
  }
}

function formatTestDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Helper для UI: дать дефолтные суммы возврата = как было оплачено в оригинале.
 *
 * Используется в Refund.tsx чтобы при открытии страницы поля cash/card
 * сразу заполнились правильными значениями.
 */
export async function getDefaultRefundAmounts(
  originalFiscalId: number,
): Promise<{ cash: number; card: number; qr: number }> {
  // Если refund уже есть на этот fiscal_receipts.id — берём ровно его суммы
  // (но в UI всё равно поля будут disabled — повторный refund невозможен).
  // Не глотаем ошибки молча: при БД-locked логируем, чтобы знать о проблеме.
  // Возвращаем null — это безопасный fallback (поля заполнятся из ms_receipt
  // ниже). Безопасность гарантирует processRefund — там check без .catch.
  let refund = null
  try {
    refund = await getRefundByOriginalFiscalId(originalFiscalId)
  } catch (e) {
    await log
      .warn(
        'refund',
        `getRefundByOriginalFiscalId упал в getDefaultRefundAmounts: ` +
          (e instanceof Error ? e.message : String(e)),
        { originalFiscalId },
      )
      .catch(() => {})
  }
  if (refund) {
    return {
      cash: refund.refund_cash_tiyin,
      card: refund.refund_card_tiyin,
      qr: refund.refund_qr_tiyin,
    }
  }
  const db = await getDb()
  const rows = await db.select<{ request_json: string }[]>(
    `SELECT request_json FROM fiscal_receipts WHERE id = $1 LIMIT 1`,
    [originalFiscalId],
  )
  if (!rows[0]) return { cash: 0, card: 0, qr: 0 }
  try {
    const parsed = JSON.parse(rows[0].request_json) as {
      params: { Receipt: JsonRpcReceipt }
    }
    return {
      cash: parsed.params.Receipt.ReceivedCash,
      card: parsed.params.Receipt.ReceivedCard,
      qr: 0,
    }
  } catch {
    return { cash: 0, card: 0, qr: 0 }
  }
}
