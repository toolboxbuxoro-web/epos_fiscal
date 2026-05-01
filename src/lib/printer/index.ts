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
 * UI должен дать пользователю выбрать какой именно использовать.
 */
export async function listPrinters(): Promise<PrinterInfo[]> {
  return invoke<PrinterInfo[]>('list_printers')
}

/**
 * Напечатать тестовый QR-чек на указанный принтер.
 * Используется в Settings для проверки настроек до реальной фискализации.
 */
export async function printTestQr(printerName: string): Promise<number> {
  return invoke<number>('print_test_qr', { printerName })
}

/**
 * Напечатать чек с QR-кодом фискального чека ОФД.
 *
 * Вызывается автоматически после успешной фискализации, если в Settings
 * включена опция авто-печати и выбран принтер. На принтере распечатается
 * только QR (по согласованию с пользователем), по которому покупатель
 * откроет электронный чек на soliq.uz.
 */
export async function printFiscalQr(
  printerName: string,
  qrUrl: string,
): Promise<number> {
  return invoke<number>('print_fiscal_qr', { printerName, qrUrl })
}
