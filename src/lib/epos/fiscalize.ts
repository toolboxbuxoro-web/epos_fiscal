import {
  consumeEsfItem,
  createMatch,
  insertFiscalReceipt,
  setMsReceiptStatus,
  upsertMsReceipt,
  getSetting,
  SettingKey,
} from '@/lib/db'
import { log } from '@/lib/log'
import type { BuildMatchResult } from '@/lib/matcher/types'
import {
  formatPrintDate,
  formatQtyForPrint,
  formatTiyinForPrint,
  printFiscalReceipt,
  type ReceiptData,
} from '@/lib/printer'
import { EposClient } from './client'
import { JsonRpcEposClient, formatGoTime, type JsonRpcReceipt } from './jsonrpc-client'
import type {
  CommunicatorItem,
  CommunicatorParams,
  CommunicatorSaleRequest,
  FiscalReceiptInfo,
} from './types'

export interface FiscalizeOptions {
  /** Использовать `fastSale` (без печати чека) — только для legacy /uzpos. */
  fast?: boolean
  staffName?: string
  clientTin?: string
  clientPinfl?: string
  cardType?: 1 | 2
  receivedCash?: number
  receivedCard?: number
  msReceiptId?: number
}

export interface FiscalizeResult {
  fiscal: FiscalReceiptInfo
  fiscalReceiptDbId: number
  matchDbId: number | null
}

/**
 * Главная функция фискализации.
 *
 * Авто-определяет протокол по URL Communicator:
 *   • URL содержит `/rpc/api` → новый JSON-RPC 2.0 (Api.SendSaleReceipt)
 *   • иначе → legacy /uzpos (sale/fastSale)
 *
 * Все денежные значения и количество приходят уже в правильных единицах
 * (тийины и тысячные).
 */
export async function fiscalize(
  build: BuildMatchResult,
  opts: FiscalizeOptions = {},
): Promise<FiscalizeResult> {
  const eposUrl =
    (await getSetting(SettingKey.EposCommunicatorUrl)) ??
    'http://localhost:8347/uzpos'
  const eposToken =
    (await getSetting(SettingKey.EposToken)) ?? 'DXJFX32CN1296678504F2'

  if (build.positions.length === 0) {
    throw new Error('Нечего отправлять в Communicator: пустой план')
  }
  // matchedTotal — сумма к оплате (с учётом скидок если они применены).
  // = sum(priceTiyin - discountTiyin). Совпадает с rd.sum если включена
  // discountForExactSum и хватает запаса по себестоимости.
  const matchedTotal = build.positions.reduce(
    (s, pm) =>
      s + pm.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )

  // Тип оплаты — берём из МойСклад (cashSum / noCashSum / qrSum), сумму —
  // из подбора (matchedTotal, после наценки+НДС+округления). Так чек
  // в EPOS/ОФД сходится: сумма items = сумма оплат. Если кассир хочет
  // переопределить (через FiscalizeOptions) — opts.receivedCash/Card
  // выигрывают.
  const auto = determinePaymentFromMs(build.receipt, matchedTotal)
  const receivedCash = opts.receivedCash ?? auto.receivedCash
  const receivedCard = opts.receivedCard ?? auto.receivedCard

  // ── Тестовый режим (сухой прогон) ────────────────────────────
  // UI отрабатывает «как будто» фискализация прошла, но в Communicator
  // ничего не уходит, остатки не списываются, fiscal_receipt не создаётся.
  // ПЕЧАТЬ всё равно идёт (если включена авто-печать) — иначе тестовый
  // режим бесполезен для проверки шаблона чека и реквизитов. На ленте
  // вместо «Asli» будет «ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК», подвал тоже
  // переключается на пометку «ничего не отправлено в ОФД».
  const testMode = (await getSetting(SettingKey.TestMode)) === 'true'
  if (testMode) {
    await log.info(
      'fiscalize',
      'ТЕСТОВЫЙ РЕЖИМ: пропускаю отправку в EPOS Communicator',
      {
        receipt: build.receipt.name,
        items: build.positions.length,
        matchedTotalTiyin: matchedTotal,
      },
    )
    const fakeFiscal: FiscalReceiptInfo = {
      TerminalID: 'TEST-MODE',
      ReceiptSeq: 'TEST',
      FiscalSign: `TEST-${Date.now()}`,
      QRCodeURL: 'тестовый режим: чек НЕ отправлен в ОФД',
      DateTime: formatTestDateTime(new Date()),
      AppletVersion: 'TEST',
    }
    // Печать всё равно отправляем — она не имеет побочных эффектов в ОФД.
    await maybePrintReceipt(build, fakeFiscal, receivedCash, receivedCard, false, true)
    return { fiscal: fakeFiscal, fiscalReceiptDbId: 0, matchDbId: null }
  }

  // 1-2. Сохранить ms_receipt и match.
  const { msReceiptId, matchDbId } = await persistMatch(build, opts)

  await log.info('fiscalize', `Отправляю чек ${build.receipt.name} в EPOS`, {
    eposUrl,
    items: build.positions.length,
    total: matchedTotal,
  })

  // 3. Выбрать клиент по URL и отправить.
  const isJsonRpc = /\/rpc\/?(?:api)?$/i.test(eposUrl) || eposUrl.includes(':3448')

  let fiscal: FiscalReceiptInfo
  let requestJson: string

  if (isJsonRpc) {
    const result = await fiscalizeJsonRpc(eposUrl, build, receivedCash, receivedCard)
    fiscal = result.fiscal
    requestJson = result.requestJson
  } else {
    const result = await fiscalizeLegacy(eposUrl, eposToken, build, opts, receivedCash, receivedCard)
    fiscal = result.fiscal
    requestJson = result.requestJson
  }

  await log.info('fiscalize', `Чек фискализирован: ${fiscal.FiscalSign}`, {
    terminalId: fiscal.TerminalID,
    receiptSeq: fiscal.ReceiptSeq,
    qr: fiscal.QRCodeURL,
  })

  // 4. Списать остатки.
  for (const pm of build.positions) {
    for (const c of pm.candidates) {
      await consumeEsfItem(c.esfItem.id, c.quantity)
    }
  }

  // 5. Сохранить fiscal_receipt.
  const fiscalReceiptDbId = await insertFiscalReceipt({
    ms_receipt_id: msReceiptId,
    match_id: matchDbId,
    terminal_id: fiscal.TerminalID,
    receipt_seq: fiscal.ReceiptSeq,
    fiscal_sign: fiscal.FiscalSign,
    qr_code_url: fiscal.QRCodeURL,
    fiscal_datetime: fiscal.DateTime,
    applet_version: fiscal.AppletVersion ?? null,
    request_json: requestJson,
    response_json: JSON.stringify(fiscal),
  })

  // 6. Статус.
  await setMsReceiptStatus(msReceiptId, 'fiscalized')

  // 7. Авто-печать на термопринтер, если включено в Settings.
  // Печать НЕ должна валить фискализацию — чек уже в ОФД, лента это
  // просто удобство для покупателя. Любая ошибка идёт в логи.
  await maybePrintReceipt(build, fiscal, receivedCash, receivedCard, false, false)

  return { fiscal, fiscalReceiptDbId, matchDbId }
}

/**
 * Определить тип оплаты по чеку МС.
 *
 * Логика:
 *   - Только `cashSum > 0` → всё в `ReceivedCash`
 *   - Только `noCashSum`/`qrSum` > 0 → всё в `ReceivedCard`
 *   - Смешанная (есть и нал, и безнал) → пропорция от matchedTotal:
 *       cashShare = cashSum / (cashSum + noCashSum + qrSum)
 *       receivedCash = round(matchedTotal × cashShare)
 *       receivedCard = matchedTotal - receivedCash  (остаток, чтобы суммы
 *                                                   совпадали тийин-в-тийин)
 *   - Все три = 0 (странный случай) → fallback на нал
 *
 * Сумму берём именно из подбора (после наценки+НДС+округления), а не
 * `rd.sum` — иначе сумма items не равна сумме оплат и Communicator/ОФД
 * могут отвергнуть чек как несбалансированный.
 *
 * Пример (смешанная):
 *   МС: cashSum=10000, noCashSum=5000 (15000 = 10к нал + 5к карта)
 *   matchedTotal=1800000 (18к сум продажной цены)
 *   cashShare = 10000/15000 = 0.667
 *   receivedCash = round(1800000 × 0.667) = 1200600
 *   receivedCard = 1800000 - 1200600 = 599400
 */
function determinePaymentFromMs(
  rd: import('@/lib/moysklad/types').MsRetailDemand,
  matchedTotal: number,
): { receivedCash: number; receivedCard: number } {
  const cash = rd.cashSum ?? 0
  const card = (rd.noCashSum ?? 0) + (rd.qrSum ?? 0)
  const total = cash + card

  // Все нули — fallback на нал.
  if (total <= 0) {
    return { receivedCash: matchedTotal, receivedCard: 0 }
  }
  // Только нал.
  if (card === 0) {
    return { receivedCash: matchedTotal, receivedCard: 0 }
  }
  // Только безнал (карта/QR).
  if (cash === 0) {
    return { receivedCash: 0, receivedCard: matchedTotal }
  }
  // Смешанная — пропорционально, остаток уходит в карту чтобы copecks
  // не потерялись при округлении.
  const receivedCash = Math.round((matchedTotal * cash) / total)
  const receivedCard = matchedTotal - receivedCash
  return { receivedCash, receivedCard }
}

/**
 * Формат DateTime в стиле YYYYMMDDHHMMSS — как у реальных фискальных ответов.
 * Используется только в тестовом режиме, чтобы UI History корректно
 * парсил «фейковый» чек (если он туда попадёт).
 */
function formatTestDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Если в настройках включена авто-печать и выбран принтер — собрать
 * полные данные чека (реквизиты компании, позиции, итоги, фискальные
 * данные) и отправить на термопринтер. Ошибки логируются, но наверх
 * не пробрасываются: чек уже в ОФД, лента — это удобство для покупателя.
 *
 * Используется и при первой фискализации, и при перепечати из Истории.
 */
export async function maybePrintReceipt(
  build: BuildMatchResult,
  fiscal: FiscalReceiptInfo,
  receivedCash: number,
  receivedCard: number,
  isCopy: boolean,
  isTest: boolean = false,
): Promise<void> {
  try {
    const enabled = (await getSetting(SettingKey.PrinterAutoPrint)) === 'true'
    if (!enabled) {
      await log.info(
        'fiscalize',
        'Печать пропущена: авто-печать выключена в Настройках → Печать чека',
      )
      return
    }
    const printerName = await getSetting(SettingKey.PrinterName)
    if (!printerName) {
      await log.warn(
        'fiscalize',
        'Печать пропущена: авто-печать включена, но принтер не выбран',
      )
      return
    }

    const data = await buildReceiptData(
      build,
      fiscal,
      receivedCash,
      receivedCard,
      isCopy,
      isTest,
    )
    const jobId = await printFiscalReceipt(printerName, data)
    await log.info('fiscalize', `Чек отправлен на печать (job #${jobId})`, {
      printer: printerName,
      isCopy,
      isTest,
    })
  } catch (err) {
    await log.error('fiscalize', 'Ошибка печати чека', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Собрать ReceiptData для термопринтера из match + ответа Communicator + Settings.
 * Все денежные значения форматируются в строки «1 234.56» под печать.
 */
async function buildReceiptData(
  build: BuildMatchResult,
  fiscal: FiscalReceiptInfo,
  receivedCash: number,
  receivedCard: number,
  isCopy: boolean,
  isTest: boolean,
): Promise<ReceiptData> {
  const company = await readCompanySettings()
  const cashier = (await getSetting(SettingKey.MoyskladEmployeeName)) ?? ''

  // Все позиции — после подмены, по продажным ценам, со скидкой если есть.
  // На ленте: Price = до скидки, Discount = размер скидки (показывается
  // отдельной строкой на принтере если > 0).
  const items = build.positions.flatMap((pm) =>
    pm.candidates.map((c) => ({
      name: c.esfItem.name,
      class_code: c.esfItem.class_code,
      qty_str: formatQtyForPrint(c.quantity),
      price_str: formatTiyinForPrint(c.priceTiyin),
      // Пустая строка если скидки нет — Rust пропустит строку «Skidka».
      discount_str:
        c.discountTiyin > 0 ? formatTiyinForPrint(c.discountTiyin) : '',
      vat_str: formatTiyinForPrint(c.vatTiyin),
      vat_percent: c.esfItem.vat_percent,
    })),
  )

  // Итог = сумма (price - discount) по всем кандидатам — то что покупатель
  // реально платит и что должно совпасть с receivedCash + receivedCard.
  const totalTiyin = build.positions.reduce(
    (s, pm) =>
      s + pm.candidates.reduce((cs, c) => cs + c.priceTiyin - c.discountTiyin, 0),
    0,
  )
  const totalVatTiyin = build.positions.reduce(
    (s, pm) => s + pm.candidates.reduce((cs, c) => cs + c.vatTiyin, 0),
    0,
  )

  return {
    is_copy: isCopy,
    is_test: isTest,
    company: {
      name: company.name || '',
      address: company.address || '',
      phone: company.phone || '',
      inn: company.inn || '',
    },
    receipt_seq: fiscal.ReceiptSeq,
    date_str: formatPrintDate(fiscal.DateTime),
    items,
    total_str: formatTiyinForPrint(totalTiyin),
    total_vat_str: formatTiyinForPrint(totalVatTiyin),
    cash_str: formatTiyinForPrint(receivedCash),
    card_str: formatTiyinForPrint(receivedCard),
    cashier,
    terminal_id: fiscal.TerminalID,
    fiscal_sign: fiscal.FiscalSign,
    virtual_kassa: fiscal.DateTime,
    qr_url: fiscal.QRCodeURL,
  }
}


// ── Реализация для нового JSON-RPC :3448/rpc/api ──────────────────────

async function fiscalizeJsonRpc(
  url: string,
  build: BuildMatchResult,
  receivedCash: number,
  receivedCard: number,
): Promise<{ fiscal: FiscalReceiptInfo; requestJson: string }> {
  const items = build.positions.flatMap((pm) =>
    pm.candidates.map((c) => ({
      Price: c.priceTiyin,           // продажная сумма ДО скидки за всё quantity
      Discount: c.discountTiyin,     // размер скидки в тийинах (0 если без скидки)
      Barcode: c.esfItem.barcode ?? '0',
      Amount: c.quantity,
      // VAT уже пересчитан в matcher с учётом скидки = (price-discount) × % / (100+%)
      VAT: c.vatTiyin,
      Name: c.esfItem.name,
      Other: 0,
      ClassCode: c.esfItem.class_code,
      PackageCode: c.esfItem.package_code,
      VATPercent: c.esfItem.vat_percent,
      OwnerType: c.esfItem.owner_type,
    })),
  )

  const receipt: JsonRpcReceipt = {
    // Go-style "2026-05-01 15:30:00" с ПРОБЕЛОМ. ISO с T парсер
    // Communicator не понимает: "cannot parse \"T05:47:34\" as \" \"".
    // Локальное время (а не UTC) — Communicator работает в TZ терминала.
    Time: formatGoTime(new Date()),
    Items: items,
    ReceivedCash: receivedCash,
    ReceivedCard: receivedCard,
  }

  const client = new JsonRpcEposClient({ url })
  const requestJson = JSON.stringify({
    jsonrpc: '2.0',
    method: 'Api.SendSaleReceipt',
    params: { Receipt: receipt },
  })

  // Полный дамп ЗАПРОСА в логи — без этого ошибки от Communicator
  // («illegal argument» и т.п.) непонятно к какому полю относятся.
  await log.info('fiscalize', 'Отправляю Api.SendSaleReceipt в Communicator', {
    url,
    request: receipt,
    itemsCount: receipt.Items.length,
  })

  let answer
  try {
    answer = await client.sendSaleReceipt(receipt)
  } catch (e) {
    // При ошибке тоже дампим всё — request + текст ошибки + любой data из JSON-RPC.
    const eposError = e as { code?: number; data?: unknown; message?: string }
    await log.error('fiscalize', 'JSON-RPC EPOS вернул ошибку', {
      error: e instanceof Error ? e.message : String(e),
      url,
      jsonRpcCode: eposError.code,
      jsonRpcData: eposError.data,
      request: receipt,
      requestJson,
    })
    throw e
  }

  // Успех — полный ответ тоже в логи на уровне info, чтобы потом
  // можно было сравнить с тем что уехало в ОФД.
  await log.info('fiscalize', 'JSON-RPC EPOS успешно ответил', {
    response: answer,
  })

  const fiscal: FiscalReceiptInfo = {
    TerminalID: answer.TerminalID,
    ReceiptSeq: answer.ReceiptSeq,
    DateTime: typeof answer.DateTime === 'string'
      ? answer.DateTime
      : new Date(answer.DateTime).toISOString(),
    FiscalSign: answer.FiscalSign,
    AppletVersion: answer.AppletVersion,
    QRCodeURL: answer.QRCodeURL,
  }
  return { fiscal, requestJson }
}

// ── Реализация для legacy :8347/uzpos ─────────────────────────────────

async function fiscalizeLegacy(
  eposUrl: string,
  eposToken: string,
  build: BuildMatchResult,
  opts: FiscalizeOptions,
  receivedCash: number,
  receivedCard: number,
): Promise<{ fiscal: FiscalReceiptInfo; requestJson: string }> {
  const company = await readCompanySettings()
  const printerSize = ((await getSetting(SettingKey.PrinterSize)) === '58' ? 58 : 80) as 58 | 80
  const staffName =
    opts.staffName ?? (await getSetting(SettingKey.MoyskladEmployeeName)) ?? undefined

  const items: CommunicatorItem[] = build.positions.flatMap((pm) =>
    pm.candidates.map((c) => ({
      price: c.priceTiyin,           // до скидки
      discount: c.discountTiyin,     // размер скидки
      barcode: c.esfItem.barcode ?? '0',
      amount: c.quantity,
      vatPercent: c.esfItem.vat_percent,
      vat: c.vatTiyin,               // уже пересчитан от (price - discount)
      name: c.esfItem.name,
      classCode: c.esfItem.class_code,
      packageCode: c.esfItem.package_code,
      other: 0,
      ownerType: c.esfItem.owner_type,
    })),
  )

  const params: CommunicatorParams = {
    items,
    paycheckNumber: build.receipt.name || undefined,
    receivedCash,
    receivedCard,
    extraInfos: { 'Модель виртуальной кассы': 'E-POS' },
  }

  const request: CommunicatorSaleRequest = {
    token: eposToken,
    method: opts.fast ? 'fastSale' : 'sale',
    companyName: company.name,
    companyAddress: company.address,
    companyINN: company.inn,
    staffName,
    printerSize,
    phoneNumber: company.phone || undefined,
    companyPhoneNumber: company.phone || undefined,
    params,
    epsInfo: { transactionId: '' },
    extraInfo: {
      tin: opts.clientTin,
      pinfl: opts.clientPinfl,
      cardType: opts.cardType ?? 2,
    },
  }

  const client = new EposClient({ url: eposUrl, token: eposToken })

  // Полный дамп запроса перед отправкой, чтобы можно было отладить ошибки
  // Communicator (NO_SUCH_METHOD_AVAILABLE / illegal argument) по полям.
  await log.info('fiscalize', 'Отправляю sale в EPOS (legacy /uzpos)', {
    eposUrl,
    request,
    itemsCount: items.length,
  })

  try {
    await client.call(request)
  } catch (e) {
    await log.error('fiscalize', 'EPOS Communicator (legacy) вернул ошибку', {
      error: e instanceof Error ? e.message : String(e),
      eposUrl,
      request,
    })
    throw e
  }

  const fiscal = await client.getLastRegisteredReceipt()
  await log.info('fiscalize', 'Legacy EPOS успешно ответил', {
    fiscal,
  })
  return { fiscal, requestJson: JSON.stringify(request) }
}

// ── Helpers ────────────────────────────────────────────────────────

async function persistMatch(
  build: BuildMatchResult,
  opts: FiscalizeOptions,
): Promise<{ msReceiptId: number; matchDbId: number | null }> {
  let msReceiptId: number
  if (opts.msReceiptId) {
    msReceiptId = opts.msReceiptId
  } else {
    msReceiptId = await upsertMsReceipt({
      ms_id: build.receipt.id,
      ms_name: build.receipt.name,
      ms_moment: 0,
      ms_sum_tiyin: build.receipt.sum,
      raw_json: JSON.stringify(build.receipt),
      fetched_at: Math.floor(Date.now() / 1000),
    })
  }

  // В match_items сохраняем сумму К ОПЛАТЕ (price - discount) — то что
  // покупатель реально заплатил по этой позиции. discount как отдельное
  // поле в схеме БД сейчас нет, но это фиксируется в request_json.
  const matchItems = build.positions.flatMap((pm) =>
    pm.candidates.map((c) => ({
      esf_item_id: c.esfItem.id,
      quantity: c.quantity,
      price_tiyin: c.priceTiyin - c.discountTiyin,
      vat_tiyin: c.vatTiyin,
    })),
  )

  const matchDbId =
    matchItems.length > 0
      ? await createMatch({
          ms_receipt_id: msReceiptId,
          strategy: build.overallStrategy,
          total_tiyin: build.matchedTotalTiyin,
          diff_tiyin: build.totalDiffTiyin,
          items: matchItems,
        })
      : null

  return { msReceiptId, matchDbId }
}

interface CompanySettings {
  name: string
  inn: string
  address: string
  phone: string | null
}

async function readCompanySettings(): Promise<CompanySettings> {
  const name = await getSetting(SettingKey.CompanyName)
  const inn = await getSetting(SettingKey.CompanyInn)
  const address = await getSetting(SettingKey.CompanyAddress)
  const phone = await getSetting(SettingKey.CompanyPhone)

  if (!name || !inn || !address) {
    throw new Error(
      'Реквизиты компании не заполнены (для legacy /uzpos API). Откройте «Настройки».',
    )
  }
  return { name, inn, address, phone }
}
