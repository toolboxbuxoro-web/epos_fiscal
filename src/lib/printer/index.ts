import { invoke } from '@tauri-apps/api/core'

/**
 * Принтер, видимый ОС.
 * Получается из Rust команды `list_printers` через крейт `printers`.
 */
export interface PrinterInfo {
  /** Человекочитаемое имя (для UI). */
  name: string
  /** Точное имя в системе (для печати — передаётся обратно в команды). */
  system_name: string
  /** Это принтер по умолчанию в системе? */
  is_default: boolean
  /** Состояние: "READY" / "OFFLINE" / "PAUSED" / "PRINTING" / "UNKNOWN". */
  state: string
}

/**
 * Получить все принтеры, зарегистрированные в системе.
 *
 * На Windows — через winspool, на macOS/Linux — через CUPS.
 * Включает все типы принтеров (термо, лазерные, виртуальные PDF).
 */
export async function listPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>('list_printers')
}

/**
 * Напечатать тестовый чек на указанный принтер.
 * Использует тот же шаблон что и реальный, чтобы заодно проверить
 * рендер кириллицы, выравнивание колонок и QR.
 */
export async function printTestQr(printerName: string): Promise<number> {
  return invoke<number>('print_test_qr', { printerName })
}

// ── Структуры данных для полного фискального чека ──────────────

export interface ReceiptCompany {
  name: string
  address: string
  phone: string
  inn: string
}

export interface ReceiptItem {
  /** Полное название товара (как пойдёт на ленту). */
  name: string
  /** ИКПУ — 17 цифр. */
  class_code: string
  /** Кол-во в виде строки: "1", "2", "1.5". */
  qty_str: string
  /** Сумма за позицию готовая для печати: "14 375.00" (ДО скидки). */
  price_str: string
  /**
   * Размер скидки готовый для печати: "1 000.00".
   * Пустая строка если скидки нет — Rust не выводит строку «Skidka».
   */
  discount_str: string
  /** Сумма НДС готовая для печати: "1 540.18". */
  vat_str: string
  /** Ставка НДС в процентах (12 / 0 / 15). */
  vat_percent: number
}

export interface ReceiptData {
  /** Оригинал ("Asli") или копия ("Chek nusxasi"). */
  is_copy: boolean
  /**
   * Если `true`, в шапке печатается «ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК»,
   * подвал тоже меняется. Используется для проверки настройки
   * принтера/реквизитов без реальной фискализации.
   */
  is_test?: boolean
  company: ReceiptCompany
  receipt_seq: string
  /** Дата для печати: "02.05.2026 11:32". */
  date_str: string
  items: ReceiptItem[]
  total_str: string
  total_vat_str: string
  cash_str: string
  card_str: string
  cashier: string
  terminal_id: string
  fiscal_sign: string
  /** Формат YYYYMMDDHHMMSS. */
  virtual_kassa: string
  qr_url: string
}

/**
 * Распечатать полный фискальный чек с QR-кодом.
 * Шаблон повторяет формат EPOS Cashdesk — реквизиты, позиции,
 * итоги, способ оплаты, фискальные данные, QR, подвал про кешбек.
 */
export async function printFiscalReceipt(
  printerName: string,
  data: ReceiptData,
): Promise<number> {
  return invoke<number>('print_fiscal_receipt', { printerName, data })
}

// ── Хелперы форматирования (общие для fiscalize и History) ─────

/** Тийины → "1 234.56" с пробелами как разделителями тысяч. */
export function formatTiyinForPrint(tiyin: number): string {
  const sum = tiyin / 100
  const fixed = sum.toFixed(2)
  const [intPart, fracPart] = fixed.split('.')
  const withThousands = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
  return `${withThousands}.${fracPart}`
}

/** Миллидоли → "1" / "1.5" (без trailing нулей). */
export function formatQtyForPrint(milli: number): string {
  if (milli % 1000 === 0) return String(milli / 1000)
  return (milli / 1000).toFixed(3).replace(/\.?0+$/, '')
}

/** YYYYMMDDHHMMSS → "DD.MM.YYYY HH:MM" для печати в шапке. */
export function formatPrintDate(s: string): string {
  if (!/^\d{14}$/.test(s)) return s
  const y = s.slice(0, 4)
  const m = s.slice(4, 6)
  const d = s.slice(6, 8)
  const h = s.slice(8, 10)
  const mi = s.slice(10, 12)
  return `${d}.${m}.${y} ${h}:${mi}`
}
