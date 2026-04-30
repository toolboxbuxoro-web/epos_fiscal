// Типы Universal Communicator — см. docs/external-apis/universal-communicator.md.
//
// Все денежные значения — в тийинах (целое).
// Количество — в тысячных долях (1000 = 1 шт).

export interface CommunicatorBaseRequest {
  token: string
  method: string
}

export interface CommunicatorItem {
  /** Цена за всё кол-во, тийины. */
  price: number
  /** Скидка позиции, тийины. */
  discount: number
  /** Штрих-код. Если нет — "0". */
  barcode: string
  /** Количество в тысячных. */
  amount: number
  /** Ставка НДС, %. */
  vatPercent: number
  /** Сумма НДС, тийины. */
  vat: number
  /** Название товара. */
  name: string
  /** Маркировка (для маркируемых товаров). */
  label?: string
  /** ИКПУ. */
  classCode: string
  /** Код упаковки ИКПУ. */
  packageCode: string
  /** ИНН комитента. */
  commissionTIN?: string
  /** Прочие скидки, тийины. */
  other: number
  /** 0=перепродажа, 1=производитель, 2=услуга. */
  ownerType?: 0 | 1 | 2
}

export interface CommunicatorParams {
  items: CommunicatorItem[]
  paycheckNumber?: string
  paymentNumber?: string
  note?: string
  stateDuty?: string
  fineAmount?: string
  contractSum?: string
  clientName?: string
  discountCard?: {
    available?: string
    addition?: string
    subtraction?: string
    remainder?: string
  }
  /** Принято наличными, тийины. */
  receivedCash?: number
  /** Принято картой, тийины. */
  receivedCard?: number
  /** Принято EPS, тийины (только для EPS-методов). */
  receivedEps?: number
  extraInfos?: Record<string, string>
}

export interface CommunicatorExtraInfo {
  tin?: string
  pinfl?: string
  phoneNumber?: string
  carNumber?: string
  cashedOutFromCard?: number
  /** 1=корп, 2=физ.лицо (обязательно по доке). */
  cardType: 1 | 2
  pptid?: string
}

export interface CommunicatorRefundInfo {
  terminalId: string
  receiptSeq: string
  /** Формат YYYYMMDDHHMMSS. */
  dateTime: string
  fiscalSign: string
}

export interface CommunicatorSaleRequest extends CommunicatorBaseRequest {
  method: 'sale' | 'fastSale' | 'refund' | 'credit' | 'advance'
  companyName: string
  companyAddress: string
  companyINN: string
  staffName?: string
  /** Ширина ленты, мм: 58 или 80. */
  printerSize: 58 | 80
  phoneNumber?: string
  companyPhoneNumber?: string
  params: CommunicatorParams
  epsInfo?: { transactionId: string }
  extraInfo: CommunicatorExtraInfo
  /** Только для refund. */
  refundInfo?: CommunicatorRefundInfo
}

export interface CommunicatorSimpleRequest extends CommunicatorBaseRequest {
  method:
    | 'openZreport'
    | 'closeZreport'
    | 'getZreportInfo'
    | 'getZReportCount'
    | 'getVersion'
    | 'getDeviceId'
    | 'checkStatus'
    | 'getLastRegisteredReceipt'
    | 'getReceiptCount'
    | 'getUnsentCount'
    | 'rescanReceipts'
    | 'resendUnsent'
    | 'printLastPaycheck'
}

export type CommunicatorRequest = CommunicatorSaleRequest | CommunicatorSimpleRequest

/** Базовая форма ответа Communicator. */
export interface CommunicatorErrorResponse {
  error: true
  message: string
}

export interface CommunicatorSuccessResponse<T = unknown> {
  error: false
  message: T
}

export type CommunicatorResponse<T = unknown> =
  | CommunicatorErrorResponse
  | CommunicatorSuccessResponse<T>

/** Структура ответа на sale (≈ getLastRegisteredReceipt). */
export interface FiscalReceiptInfo {
  TerminalID: string
  ReceiptSeq: string
  /** YYYYMMDDHHMMSS. */
  DateTime: string
  FiscalSign: string
  AppletVersion?: string
  QRCodeURL: string
}
