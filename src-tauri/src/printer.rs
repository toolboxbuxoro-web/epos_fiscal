//! Печать чека на термопринтер через системный print spooler.
//!
//! Архитектура:
//!   - Принтер (Xprinter XP-80, Star, Epson и любой ESC/POS совместимый)
//!     зарегистрирован в ОС через драйвер (на Win — обычно "Generic / Text Only"
//!     или родной драйвер Xprinter).
//!   - Мы находим его по имени через крейт `printers` и шлём сырые ESC/POS
//!     байты на этот принтер. ОС сама заботится про USB/Ethernet транспорт.
//!   - QR-код печатает САМ принтер по команде `GS ( k` — без растровой картинки.
//!
//! Это даёт кросс-платформенность (Win/Mac/Linux) и работает с любым
//! ESC/POS принтером без специальных USB-permissions.

use printers::common::base::job::PrinterJobOptions;
use serde::Serialize;

/// Метаданные принтера для UI выбора в Settings.
#[derive(Serialize, Clone, Debug)]
pub struct PrinterInfo {
    pub name: String,
    pub system_name: String,
    pub is_default: bool,
    /// "READY" / "OFFLINE" / "PAUSED" / "PRINTING" / "UNKNOWN".
    pub state: String,
}

/// Получить список всех принтеров, зарегистрированных в системе.
#[tauri::command]
pub fn list_printers() -> Vec<PrinterInfo> {
    printers::get_printers()
        .into_iter()
        .map(|p| PrinterInfo {
            name: p.name.clone(),
            system_name: p.system_name.clone(),
            is_default: p.is_default,
            state: format!("{:?}", p.state),
        })
        .collect()
}

/// Распечатать тестовый QR с фиксированной ссылкой.
/// Для проверки что принтер настроен правильно — без реальной фискализации.
#[tauri::command]
pub fn print_test_qr(printer_name: String) -> Result<u64, String> {
    let bytes = build_qr_receipt("https://soliq.uz/check?test=1");
    print_raw(&printer_name, &bytes)
}

/// Распечатать чек с QR-кодом фискального чека.
/// Вызывается автоматически после успешной фискализации в EPOS Communicator.
#[tauri::command]
pub fn print_fiscal_qr(printer_name: String, qr_url: String) -> Result<u64, String> {
    let bytes = build_qr_receipt(&qr_url);
    print_raw(&printer_name, &bytes)
}

// ── Низкоуровневая часть ──────────────────────────────────────────

/// Найти принтер по имени и отправить сырые байты.
fn print_raw(printer_name: &str, bytes: &[u8]) -> Result<u64, String> {
    let printer = printers::get_printer_by_name(printer_name)
        .ok_or_else(|| format!("Принтер «{}» не найден в системе", printer_name))?;

    // На Linux/macOS нужно явно сказать CUPS что данные сырые ESC/POS,
    // иначе он попытается интерпретировать их как PostScript/PDF и сломает.
    // На Windows raw_properties игнорируется — winspool по умолчанию RAW.
    let options = PrinterJobOptions {
        name: Some("EPOS Fiscal — чек"),
        raw_properties: &[("document-format", "application/vnd.cups-raw")],
        converter: printers::common::converters::Converter::None,
    };

    printer
        .print(bytes, options)
        .map_err(|e| format!("Не удалось напечатать: {:?}", e))
}

/// Собрать ESC/POS байты для чека: init → центрирование → QR → cut.
///
/// Печатается **только QR-код** — по согласованию с пользователем минимум.
/// Если потом захотим добавить шапку магазина или сумму — это место.
fn build_qr_receipt(qr_url: &str) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(256);

    // Init принтер (сбросить любые предыдущие настройки).
    buf.extend_from_slice(&[0x1B, 0x40]); // ESC @

    // Пустая строка сверху для отступа от обрезки предыдущего чека.
    buf.push(0x0A); // LF

    // Центрирование.
    buf.extend_from_slice(&[0x1B, 0x61, 0x01]); // ESC a 1

    // QR код через стандартные ESC/POS GS ( k команды.
    // Поддерживается всеми Xprinter, Star, Epson, Citizen и совместимыми.
    append_qr_code(&mut buf, qr_url);

    // Несколько пустых строк между QR и резкой, чтобы лента
    // успела прокрутиться.
    buf.extend_from_slice(&[0x0A, 0x0A, 0x0A, 0x0A]);

    // Partial cut (надрез почти до конца, оставив тонкую перемычку).
    // GS V m — m=1 partial cut.
    buf.extend_from_slice(&[0x1D, 0x56, 0x01]);

    buf
}

/// Добавить ESC/POS QR-код в буфер.
///
/// Спецификация: ESC/POS манурlinks
///   https://reference.epson-biz.com/modules/ref_escpos/index.php?content_id=140
///
/// Команды:
///   1. GS ( k 4 0  49 65 50 0   — model 2 (большая ёмкость, чаще поддерживается)
///   2. GS ( k 3 0  49 67 8      — module size 8 (1..16, 8 ≈ 1cm на 80мм ленте)
///   3. GS ( k 3 0  49 69 48     — error correction L (48=L, 49=M, 50=Q, 51=H)
///   4. GS ( k pL pH 49 80 48 D  — store data D
///   5. GS ( k 3 0  49 81 48     — print stored QR
fn append_qr_code(buf: &mut Vec<u8>, data: &str) {
    let data_bytes = data.as_bytes();

    // 1. Set QR model.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);

    // 2. Set module size (1..16). 8 даёт читаемый QR на 80мм ленте.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x08]);

    // 3. Error correction level L (48). M/Q/H плотнее на ошибки, но больше
    //    точек в QR. L достаточно — чек не подвергается грязи на ленте.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30]);

    // 4. Store data.
    let len = data_bytes.len() + 3;
    let p_l = (len & 0xFF) as u8;
    let p_h = ((len >> 8) & 0xFF) as u8;
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, p_l, p_h, 0x31, 0x50, 0x30]);
    buf.extend_from_slice(data_bytes);

    // 5. Print stored QR.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]);
}
