//! Печать чека на термопринтер через системный print spooler.
//!
//! Печатает полноценный фискальный чек: реквизиты компании, позиции,
//! итоги, способы оплаты, фискальные данные, QR-код. Шаблон повторяет
//! формат, который выдаёт EPOS Cashdesk на бумажный чек —
//! привычный покупателям в Узбекистане.
//!
//! Технически:
//!   - Принтер регистрируется в ОС (драйвер Xprinter XP-80 или совместимый).
//!   - Мы шлём сырые ESC/POS байты через крейт `printers`.
//!   - Кириллица кодируется в WCP1251 (codepage 46 на Xprinter).
//!   - QR-код печатает САМ принтер по команде GS ( k.

use encoding_rs::IBM866;
use printers::common::base::job::PrinterJobOptions;
use serde::{Deserialize, Serialize};

/// Метаданные принтера для UI выбора в Settings.
#[derive(Serialize, Clone, Debug)]
pub struct PrinterInfo {
    pub name: String,
    pub system_name: String,
    pub is_default: bool,
    pub state: String,
}

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

/// Тестовая печать — короткий чек с фейковым QR.
/// Использует тот же шаблон что и реальный чек, чтобы заодно проверить
/// рендер кириллицы и форматирование колонок.
#[tauri::command]
pub fn print_test_qr(printer_name: String) -> Result<u64, String> {
    let test_data = ReceiptData {
        is_copy: false,
        is_test: true,
        company: CompanyInfo {
            name: "ТЕСТОВЫЙ МАГАЗИН".to_string(),
            address: "Бухара".to_string(),
            phone: "+998 00 000-00-00".to_string(),
            inn: "000000000".to_string(),
        },
        receipt_seq: "TEST".to_string(),
        date_str: "01.01.2026 00:00".to_string(),
        items: vec![ReceiptItem {
            name: "Тестовый товар".to_string(),
            class_code: "00000000000000000".to_string(),
            qty_str: "1".to_string(),
            price_str: "1 000.00".to_string(),
            discount_str: String::new(),
            vat_str: "107.14".to_string(),
            vat_percent: 12,
        }],
        total_str: "1 000.00".to_string(),
        total_vat_str: "107.14".to_string(),
        cash_str: "1 000.00".to_string(),
        card_str: "0.00".to_string(),
        cashier: "TEST".to_string(),
        terminal_id: "TEST-MODE".to_string(),
        fiscal_sign: "0000000000".to_string(),
        virtual_kassa: "20260101000000".to_string(),
        qr_url: "https://ofd.soliq.uz/check?test=1".to_string(),
    };
    let bytes = build_receipt(&test_data);
    print_raw(&printer_name, &bytes)
}

/// Главная команда — распечатать полноценный фискальный чек.
/// Все строковые суммы должны быть готовы к выводу (с разделителями,
/// 2 знака после точки) — Rust их уже не переформатирует.
#[tauri::command]
pub fn print_fiscal_receipt(
    printer_name: String,
    data: ReceiptData,
) -> Result<u64, String> {
    let bytes = build_receipt(&data);
    print_raw(&printer_name, &bytes)
}

// ── Структуры данных для команды (приходят с фронта) ─────────────

#[derive(Deserialize, Debug)]
pub struct ReceiptData {
    /// `false` — оригинал ("Asli"), `true` — копия ("Chek nusxasi").
    pub is_copy: bool,
    /// `true` — это тестовый прогон, в шапке печатается «ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК»
    /// и QR не читается. Никаких реальных побочных эффектов.
    #[serde(default)]
    pub is_test: bool,
    pub company: CompanyInfo,
    pub receipt_seq: String,
    pub date_str: String,
    pub items: Vec<ReceiptItem>,
    pub total_str: String,
    pub total_vat_str: String,
    pub cash_str: String,
    pub card_str: String,
    pub cashier: String,
    pub terminal_id: String,
    pub fiscal_sign: String,
    /// Формат YYYYMMDDHHMMSS — печатается как Virtual kassa.
    pub virtual_kassa: String,
    pub qr_url: String,
}

#[derive(Deserialize, Debug)]
pub struct CompanyInfo {
    pub name: String,
    pub address: String,
    pub phone: String,
    pub inn: String,
}

#[derive(Deserialize, Debug)]
pub struct ReceiptItem {
    pub name: String,
    pub class_code: String,
    pub qty_str: String,
    /// Цена за позицию ДО скидки. На ленте всегда печатается.
    pub price_str: String,
    /// Размер скидки, готовый к печати. Пустая строка = скидки нет
    /// (тогда строка «Skidka» не выводится).
    #[serde(default)]
    pub discount_str: String,
    pub vat_str: String,
    pub vat_percent: u8,
}

// ── Печать ────────────────────────────────────────────────────────

fn print_raw(printer_name: &str, bytes: &[u8]) -> Result<u64, String> {
    let printer = printers::get_printer_by_name(printer_name)
        .ok_or_else(|| format!("Принтер «{}» не найден в системе", printer_name))?;

    // Windows winspool ожидает константы "RAW" / "TEXT" / "XPS_PASS",
    // CUPS — `application/vnd.cups-raw`. На Win пустой массив = дефолт RAW.
    #[cfg(target_os = "windows")]
    let raw_properties: &[(&str, &str)] = &[];
    #[cfg(not(target_os = "windows"))]
    let raw_properties: &[(&str, &str)] =
        &[("document-format", "application/vnd.cups-raw")];

    let options = PrinterJobOptions {
        name: Some("EPOS Fiscal — чек"),
        raw_properties,
        converter: printers::common::converters::Converter::None,
    };

    printer
        .print(bytes, options)
        .map_err(|e| format!("Не удалось напечатать: {:?}", e))
}

// ── Построение ESC/POS байтов ─────────────────────────────────────

/// Ширина строки на 80мм ленте в шрифте Font A (стандарт). 48 символов.
const LINE_WIDTH: usize = 48;

/// UTF-8 → CP866 (PC866 / IBM866) — DOS Cyrillic.
///
/// Принтер ждёт байты в текущей кодовой странице, которую мы установили
/// командой `ESC t 17` в начале чека. Кириллические символы кодируются
/// в один байт по таблице CP866. Латиница, цифры, пробелы — совпадают
/// с ASCII, идут как есть.
///
/// Почему именно CP866: это исторический стандарт DOS, поддерживается
/// всеми ESC/POS принтерами с кириллицей без исключения. WCP1251 у
/// разных производителей под разными номерами codepage (или вообще
/// отсутствует) — нашли это эмпирически.
fn cyr(s: &str) -> Vec<u8> {
    let (cow, _, _) = IBM866.encode(s);
    cow.into_owned()
}

/// Собрать ESC/POS байты для полного чека.
fn build_receipt(d: &ReceiptData) -> Vec<u8> {
    let mut buf: Vec<u8> = Vec::with_capacity(2048);

    // 1. Init принтер.
    buf.extend_from_slice(&[0x1B, 0x40]); // ESC @

    // 2. Установить кодовую страницу PC866 (DOS Cyrillic) — code 17 у Xprinter.
    //    Это исторический стандарт для русской термопечати, поддерживается
    //    всеми Xprinter / Star / Epson с поддержкой кириллицы. WCP1251 (code 46
    //    у некоторых моделей) — не работает на нашем XP-80, давал иероглифы.
    buf.extend_from_slice(&[0x1B, 0x74, 17]);

    // 3. ── Шапка ────────────────────────────────────────────
    center(&mut buf);
    if d.is_test {
        // Жирная двойной высоты надпись «ТЕСТ» — кассир не должен спутать
        // тестовый чек с реальным фискальным.
        bold_on(&mut buf);
        // ESC ! n — задаёт стили: 0x10 = двойная высота, 0x20 = двойная ширина.
        buf.extend_from_slice(&[0x1B, 0x21, 0x30]);
        write_line(&mut buf, "ТЕСТ");
        buf.extend_from_slice(&[0x1B, 0x21, 0x00]);
        bold_off(&mut buf);
        write_line(&mut buf, "НЕ ФИСКАЛЬНЫЙ ЧЕК");
        write_line(&mut buf, "");
    } else if d.is_copy {
        write_line(&mut buf, "Chek nusxasi");
    } else {
        write_line(&mut buf, "Asli");
    }

    bold_on(&mut buf);
    write_line(&mut buf, &d.company.name);
    bold_off(&mut buf);
    write_line(&mut buf, &d.company.address);
    write_line(&mut buf, &d.company.phone);

    // 4. ── Реквизиты (две колонки) ──────────────────────────
    left(&mut buf);
    write_line(&mut buf, &two_cols("STIR:", &d.company.inn));
    write_line(&mut buf, &two_cols("Chek:", &d.receipt_seq));
    write_line(&mut buf, &two_cols("Sana:", &d.date_str));
    divider(&mut buf);

    // 5. ── Позиции товаров ─────────────────────────────────
    for item in &d.items {
        // Название (с переносом по словам).
        for line in wrap_text(&item.name, LINE_WIDTH) {
            write_line(&mut buf, &line);
        }
        // Кол-во + сумма (ДО скидки если она есть).
        let qty_left = format!("Miqdori:  {}", item.qty_str);
        let qty_right = format!("{} so'm", item.price_str);
        write_line(&mut buf, &two_cols(&qty_left, &qty_right));

        // Скидка — если применена. discount_str пустой = скидки нет.
        if !item.discount_str.is_empty() {
            let disc_value = format!("-{} so'm", item.discount_str);
            write_line(&mut buf, &two_cols("Skidka:", &disc_value));
        }

        // НДС (рассчитан от price - discount).
        let vat_label = format!("Sh.J. QQS {}%:", item.vat_percent);
        let vat_value = format!("{} so'm", item.vat_str);
        write_line(&mut buf, &two_cols(&vat_label, &vat_value));

        // ИКПУ.
        write_line(&mut buf, &two_cols("MXIK kodi:", &item.class_code));
    }
    divider(&mut buf);

    // 6. ── Итоги ────────────────────────────────────────────
    write_line(&mut buf, &two_cols("Jami:", &format!("{} so'm", d.total_str)));
    write_line(
        &mut buf,
        &two_cols("Sh.J. QQS 12%:", &format!("{} so'm", d.total_vat_str)),
    );
    divider(&mut buf);

    // 7. ── Способ оплаты ───────────────────────────────────
    center(&mut buf);
    write_line(&mut buf, "To'lov Turi");
    left(&mut buf);
    write_line(&mut buf, &two_cols("Naqd:", &format!("{} so'm", d.cash_str)));
    write_line(
        &mut buf,
        &two_cols("Bank kartasi:", &format!("{} so'm", d.card_str)),
    );
    write_line(&mut buf, &two_cols("Chek turi:", "Xarid"));
    write_line(&mut buf, &two_cols("Kassir:", &d.cashier));
    divider(&mut buf);

    // 8. ── Фискальные данные ───────────────────────────────
    center(&mut buf);
    write_line(&mut buf, "Fiskal ma'lumot");
    left(&mut buf);
    write_line(&mut buf, &two_cols("Virtual kassa:", &d.virtual_kassa));
    write_line(&mut buf, &two_cols("FM raqami:", &d.terminal_id));
    write_line(&mut buf, &two_cols("Fiskal belgi:", &d.fiscal_sign));

    // 9. ── QR-код (по центру) ──────────────────────────────
    buf.push(0x0A);
    center(&mut buf);
    append_qr_code(&mut buf, &d.qr_url);
    buf.push(0x0A);

    // 10. ── Подвал ─────────────────────────────────────────
    if d.is_test {
        write_line(&mut buf, "Это тестовый прогон.");
        write_line(&mut buf, "В ОФД ГНК ничего не отправлено.");
        write_line(&mut buf, "QR-код не сканируется.");
    } else {
        write_line(&mut buf, "Siz xaridning 1% miqdorida");
        write_line(&mut buf, "\"Keshbek\" olish huquqiga ega");
        write_line(&mut buf, "bo'ldingiz!");
    }

    // 11. ── Хвост и обрезка ────────────────────────────────
    buf.extend_from_slice(&[0x0A, 0x0A, 0x0A, 0x0A]);
    buf.extend_from_slice(&[0x1D, 0x56, 0x01]); // GS V 1 — partial cut

    buf
}

// ── Хелперы для байтов ────────────────────────────────────────────

fn center(buf: &mut Vec<u8>) {
    buf.extend_from_slice(&[0x1B, 0x61, 0x01]); // ESC a 1
}

fn left(buf: &mut Vec<u8>) {
    buf.extend_from_slice(&[0x1B, 0x61, 0x00]); // ESC a 0
}

fn bold_on(buf: &mut Vec<u8>) {
    buf.extend_from_slice(&[0x1B, 0x45, 0x01]); // ESC E 1
}

fn bold_off(buf: &mut Vec<u8>) {
    buf.extend_from_slice(&[0x1B, 0x45, 0x00]); // ESC E 0
}

/// Записать строку в буфер: WCP1251-байты + LF.
fn write_line(buf: &mut Vec<u8>, s: &str) {
    buf.extend_from_slice(&cyr(s));
    buf.push(0x0A);
}

/// Линия-разделитель шириной LINE_WIDTH.
fn divider(buf: &mut Vec<u8>) {
    left(buf);
    let dashes = "-".repeat(LINE_WIDTH);
    write_line(buf, &dashes);
}

/// Сформировать строку с выравниванием: левая часть слева, правая —
/// прижата к правому краю общей ширины LINE_WIDTH. Если суммарно
/// больше LINE_WIDTH — обрезается левая часть.
fn two_cols(left: &str, right: &str) -> String {
    let lw = display_width(left);
    let rw = display_width(right);
    if lw + rw + 1 > LINE_WIDTH {
        // Не влезает — обрезаем левую часть.
        let cap = LINE_WIDTH.saturating_sub(rw + 1);
        let truncated: String = left.chars().take(cap).collect();
        format!("{} {}", truncated, right)
    } else {
        let pad = LINE_WIDTH - lw - rw;
        format!("{}{}{}", left, " ".repeat(pad), right)
    }
}

/// Перенос текста по словам в строки шириной не более `width`.
fn wrap_text(text: &str, width: usize) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current = String::new();
    for word in text.split_whitespace() {
        let candidate = if current.is_empty() {
            word.to_string()
        } else {
            format!("{} {}", current, word)
        };
        if display_width(&candidate) <= width {
            current = candidate;
        } else {
            if !current.is_empty() {
                lines.push(current.clone());
                current.clear();
            }
            // Слово длиннее ширины — режем.
            if display_width(word) > width {
                let mut chunk = String::new();
                for ch in word.chars() {
                    let mut next = chunk.clone();
                    next.push(ch);
                    if display_width(&next) > width {
                        lines.push(chunk.clone());
                        chunk.clear();
                    }
                    chunk.push(ch);
                }
                if !chunk.is_empty() {
                    current = chunk;
                }
            } else {
                current = word.to_string();
            }
        }
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

/// Сколько ячеек строка займёт на ленте.
///
/// В CP866 каждый кириллический символ — это 1 байт = 1 знакоместо принтера,
/// как и латиница/цифры. Поэтому для ширины колонок считаем просто chars().
fn display_width(s: &str) -> usize {
    s.chars().count()
}

// ── QR-код ────────────────────────────────────────────────────────

fn append_qr_code(buf: &mut Vec<u8>, data: &str) {
    let data_bytes = data.as_bytes();

    // Set QR model = 2.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]);
    // Module size = 8.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x43, 0x08]);
    // Error correction level L.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x45, 0x30]);
    // Store data.
    let len = data_bytes.len() + 3;
    let p_l = (len & 0xFF) as u8;
    let p_h = ((len >> 8) & 0xFF) as u8;
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, p_l, p_h, 0x31, 0x50, 0x30]);
    buf.extend_from_slice(data_bytes);
    // Print stored QR.
    buf.extend_from_slice(&[0x1D, 0x28, 0x6B, 0x03, 0x00, 0x31, 0x51, 0x30]);
}
