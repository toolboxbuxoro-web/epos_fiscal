import {
  consumeEsfItem,
  createMatch,
  insertFiscalReceipt,
  setMsReceiptStatus,
  upsertMsReceipt,
  getSetting,
  SettingKey,
} from '@/lib/db'
import type { BuildMatchResult } from '@/lib/matcher/types'
import { EposClient } from './client'
import type {
  CommunicatorItem,
  CommunicatorParams,
  CommunicatorSaleRequest,
  FiscalReceiptInfo,
} from './types'
import { vatIncluded } from '@/lib/matcher/strategies'

export interface FiscalizeOptions {
  /** Использовать `fastSale` (без печати чека). */
  fast?: boolean
  /** Имя кассира. */
  staffName?: string
  /** ИНН клиента (если есть). */
  clientTin?: string
  /** ПИНФЛ клиента (если есть). */
  clientPinfl?: string
  /** Тип карты: 1=корп, 2=физлицо. По умолчанию 2. */
  cardType?: 1 | 2
  /** Принято наличными, тийины. По умолчанию вся сумма. */
  receivedCash?: number
  /** Принято картой, тийины. */
  receivedCard?: number
  /** Перезаписать ms_receipt_id (для повторных попыток). */
  msReceiptId?: number
}

export interface FiscalizeResult {
  fiscal: FiscalReceiptInfo
  fiscalReceiptDbId: number
  matchDbId: number | null
}

/**
 * Превратить план подбора в запрос Communicator, отправить, сохранить результат.
 *
 * Все денежные значения и количество приходят уже в правильных единицах
 * (тийины и тысячные), доп. конвертация не нужна.
 */
export async function fiscalize(
  build: BuildMatchResult,
  opts: FiscalizeOptions = {},
): Promise<FiscalizeResult> {
  const company = await readCompanySettings()
  const eposUrl = (await getSetting(SettingKey.EposCommunicatorUrl))
    ?? 'http://localhost:8347/uzpos'
  const eposToken = (await getSetting(SettingKey.EposToken))
    ?? 'DXJFX32CN1296678504F2'
  const printerSize = ((await getSetting(SettingKey.PrinterSize)) === '58' ? 58 : 80) as 58 | 80
  // Имя кассира: либо переданное, либо выбранный в Settings, либо undefined.
  const staffName =
    opts.staffName ?? (await getSetting(SettingKey.MoyskladEmployeeName)) ?? undefined

  // 1. Сохранить ms_receipt в БД (или взять из opts).
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

  // 2. Сохранить план match'а.
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

  // 3. Собрать запрос для Communicator.
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

  if (items.length === 0) {
    throw new Error('Нечего отправлять в Communicator: пустой план')
  }

  const total = items.reduce((s, i) => s + i.price, 0)
  const receivedCash = opts.receivedCash ?? total
  const receivedCard = opts.receivedCard ?? 0

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

  // 4. Вызвать Communicator.
  const client = new EposClient({ url: eposUrl, token: eposToken })
  await client.call(request)

  // 5. Получить фискальный признак из getLastRegisteredReceipt.
  const fiscal = await client.getLastRegisteredReceipt()

  // 6. Списать остатки на esf_items.
  for (const pm of build.positions) {
    for (const c of pm.candidates) {
      await consumeEsfItem(c.esfItem.id, c.quantity)
    }
  }

  // 7. Сохранить fiscal_receipt.
  const fiscalReceiptDbId = await insertFiscalReceipt({
    ms_receipt_id: msReceiptId,
    match_id: matchDbId,
    terminal_id: fiscal.TerminalID,
    receipt_seq: fiscal.ReceiptSeq,
    fiscal_sign: fiscal.FiscalSign,
    qr_code_url: fiscal.QRCodeURL,
    fiscal_datetime: fiscal.DateTime,
    applet_version: fiscal.AppletVersion ?? null,
    request_json: JSON.stringify(request),
    response_json: JSON.stringify(fiscal),
  })

  // 8. Поменять статус ms_receipt.
  await setMsReceiptStatus(msReceiptId, 'fiscalized')

  return { fiscal, fiscalReceiptDbId, matchDbId }
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
      'Реквизиты компании не заполнены. Откройте «Настройки» и заполните название, ИНН и адрес.',
    )
  }
  return { name, inn, address, phone }
}
