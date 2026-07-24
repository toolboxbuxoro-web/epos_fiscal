/**
 * Единый парсер `fiscal_receipts.request_json` для UI (История, Возврат,
 * печать копий).
 *
 * Поддерживает ОБА формата хранения:
 *   - EPOS JSON-RPC (:3448): { params: { Receipt: { Items[PascalCase+spic],
 *     ReceivedCash, ReceivedCard } } }
 *   - FiscalDriveService (:3449): { factoryId, receipt: { Items[PascalCase+SPIC],
 *     ReceivedCash, ReceivedCard } }
 *
 * История бага: UI-парсеры знали только `params.Receipt` — у FDS-чеков
 * (магазин Хазрати Имом) История показывала прочерки в Сумма/Оплата, а
 * Возврат — «0 позиций, сумма чека 0» и блокировал возврат.
 * refund.ts::parseRequest оба формата знал, а UI — нет. Теперь все читают
 * request_json через этот модуль.
 */

interface RawItem {
  Name?: string
  spic?: string // EPOS camelCase
  SPIC?: string // FDS PascalCase
  ClassCode?: string // совсем старые записи
  Amount?: number
  Price?: number
  Discount?: number
  VAT?: number
  VATPercent?: number
}

interface RawReceipt {
  Items?: RawItem[]
  ReceivedCash?: number
  ReceivedCard?: number
}

export interface NormalizedReceiptItem {
  name: string
  classCode: string
  /** тысячные: 1000 = 1 шт */
  amount: number
  priceTiyin: number
  discountTiyin: number
  vatTiyin: number
  vatPercent: number
}

export interface NormalizedReceipt {
  receivedCashTiyin: number
  receivedCardTiyin: number
  items: NormalizedReceiptItem[]
}

/**
 * Распарсить request_json любого поддерживаемого формата в нормализованную
 * структуру. `null` — если JSON битый или формат неизвестен (UI покажет
 * прочерк/пустоту, как для legacy-чеков).
 */
export function parseRequestJsonReceipt(json: string): NormalizedReceipt | null {
  try {
    const parsed = JSON.parse(json) as {
      params?: { Receipt?: RawReceipt }
      receipt?: RawReceipt
    }
    // EPOS JSON-RPC → params.Receipt; FiscalDriveService → receipt.
    const raw = parsed?.params?.Receipt ?? parsed?.receipt
    if (!raw?.Items) return null
    return {
      receivedCashTiyin: Math.max(0, raw.ReceivedCash ?? 0),
      receivedCardTiyin: Math.max(0, raw.ReceivedCard ?? 0),
      items: raw.Items.map((it) => ({
        name: it.Name ?? '',
        classCode: it.spic ?? it.SPIC ?? it.ClassCode ?? '',
        amount: it.Amount ?? 1000,
        priceTiyin: it.Price ?? 0,
        discountTiyin: it.Discount ?? 0,
        vatTiyin: it.VAT ?? 0,
        vatPercent: it.VATPercent ?? 0,
      })),
    }
  } catch {
    return null
  }
}
