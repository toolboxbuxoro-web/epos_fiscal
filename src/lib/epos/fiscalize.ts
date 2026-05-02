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
import { printFiscalQr } from '@/lib/printer'
import { EposClient } from './client'
import { JsonRpcEposClient, formatGoTime, type JsonRpcReceipt } from './jsonrpc-client'
import type {
  CommunicatorItem,
  CommunicatorParams,
  CommunicatorSaleRequest,
  FiscalReceiptInfo,
} from './types'
import { vatIncluded } from '@/lib/matcher/strategies'

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

  // 1-2. Сохранить ms_receipt и match.
  const { msReceiptId, matchDbId } = await persistMatch(build, opts)

  if (build.positions.length === 0) {
    throw new Error('Нечего отправлять в Communicator: пустой план')
  }
  const matchedTotal = build.positions.reduce(
    (s, pm) => s + pm.candidates.reduce((cs, c) => cs + c.priceTiyin, 0),
    0,
  )
  const receivedCash = opts.receivedCash ?? matchedTotal
  const receivedCard = opts.receivedCard ?? 0

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

  // 7. Авто-печать QR на термопринтер, если включено в Settings.
  // Печать НЕ должна валить фискализацию — чек уже в ОФД, лента это
  // просто удобство для покупателя. Любая ошибка идёт в логи и видна
  // в разделе «Логи», но возвращаемый результат остаётся успешным.
  await maybePrintQr(fiscal.QRCodeURL)

  return { fiscal, fiscalReceiptDbId, matchDbId }
}

/**
 * Если в настройках включена авто-печать и выбран принтер — отправить QR
 * на термопринтер. Ошибки залогировать, но не пробрасывать наверх.
 */
async function maybePrintQr(qrUrl: string): Promise<void> {
  try {
    const enabled = (await getSetting(SettingKey.PrinterAutoPrint)) === 'true'
    if (!enabled) return
    const printerName = await getSetting(SettingKey.PrinterName)
    if (!printerName) {
      await log.warn(
        'fiscalize',
        'Авто-печать включена, но принтер не выбран',
      )
      return
    }
    const jobId = await printFiscalQr(printerName, qrUrl)
    await log.info('fiscalize', `QR-чек отправлен на печать (job #${jobId})`, {
      printer: printerName,
    })
  } catch (err) {
    await log.error('fiscalize', 'Ошибка печати QR-чека', {
      error: err instanceof Error ? err.message : String(err),
    })
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
      Price: c.priceTiyin,
      Discount: 0,
      Barcode: c.esfItem.barcode ?? '0',
      Amount: c.quantity,
      VAT: vatIncluded(c.priceTiyin, c.esfItem.vat_percent),
      Name: c.esfItem.name,
      Other: 0,
      // Опциональные поля. Если сервер не знает — игнорирует;
      // если знает (актуальная версия Communicator) — использует.
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
      price: c.priceTiyin,
      discount: 0,
      barcode: c.esfItem.barcode ?? '0',
      amount: c.quantity,
      vatPercent: c.esfItem.vat_percent,
      vat: vatIncluded(c.priceTiyin, c.esfItem.vat_percent),
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

  const matchItems = build.positions.flatMap((pm) =>
    pm.candidates.map((c) => ({
      esf_item_id: c.esfItem.id,
      quantity: c.quantity,
      price_tiyin: c.priceTiyin,
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
