-- Возвраты (refunds) — отдельная таблица, не путать с fiscal_receipts.
--
-- На MVP реализуем ТОЛЬКО полный возврат всего чека (см. план в чате).
-- При полном возврате:
--   * UNIQUE (original_fiscal_id) — один возврат на один продажный чек.
--     Повторно вернуть нельзя, кассир получит ошибку «уже возвращён».
--   * Все позиции из match_items идут в items_json как есть.
--   * Сумма возврата = сумма оригинального чека (cash/card соответственно).
--
-- В Phase 2 добавим частичные возвраты — тогда UNIQUE снимется и добавится
-- колонка `qty_refunded` в match_items + поле `items_json` будет содержать
-- только частично возвращённые позиции.

CREATE TABLE fiscal_refunds (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Ссылка на оригинальный продажный чек (его FiscalSign / TerminalID / ReceiptSeq
  -- используются для refundInfo в payload Communicator).
  original_fiscal_id    INTEGER NOT NULL UNIQUE,
  -- Опционально: id чека из ms_receipts если кассир привязал возврат к какому-то
  -- retailReturn из МойСклад. Для MVP всегда NULL — МС-интеграции нет.
  ms_return_id          INTEGER,
  -- Поля от Communicator (refund получает свой собственный FiscalSign).
  terminal_id           TEXT    NOT NULL,
  receipt_seq           TEXT    NOT NULL,
  fiscal_sign           TEXT    NOT NULL UNIQUE,
  qr_code_url           TEXT    NOT NULL,
  fiscal_datetime       TEXT    NOT NULL,            -- YYYYMMDDHHMMSS
  applet_version        TEXT,
  -- Снапшот позиций возврата (для аудита и печати).
  -- Структура совпадает с match_items, но это денормализация — даже если
  -- match_items потом изменится, items_json не двинется.
  items_json            TEXT    NOT NULL,
  -- Куда выдали деньги. Кассир выбирает в UI, по дефолту = как было оплачено
  -- в оригинале (cashSum / noCashSum / qrSum из ms_receipts.raw_json).
  refund_cash_tiyin     INTEGER NOT NULL DEFAULT 0,
  refund_card_tiyin     INTEGER NOT NULL DEFAULT 0,
  refund_qr_tiyin       INTEGER NOT NULL DEFAULT 0,
  -- Дамп request/response в Communicator — для debug если что-то пошло не так.
  request_json          TEXT    NOT NULL,
  response_json         TEXT    NOT NULL,
  -- Свободный текст: «брак», «не подошёл», «передумал» и т.п. (для аудита)
  reason                TEXT,
  -- Кассир оформивший возврат (имя из Settings.MoyskladEmployeeName).
  cashier_name          TEXT,
  refunded_at           INTEGER NOT NULL,
  FOREIGN KEY (original_fiscal_id) REFERENCES fiscal_receipts(id),
  FOREIGN KEY (ms_return_id)       REFERENCES ms_receipts(id)
);

CREATE INDEX idx_fiscal_refunds_original ON fiscal_refunds(original_fiscal_id);
CREATE INDEX idx_fiscal_refunds_date     ON fiscal_refunds(refunded_at DESC);

-- Расширяем inv_pending_confirms ещё одним типом операции — `unconsume`
-- (возврат остатка в пул). До этого было только `confirm` (списание после
-- успешного refund).
--
-- ВНИМАНИЕ: схема inv_pending_confirms в миграции 003 имеет конкретные
-- колонки `inv_item_id, qty, fiscal_sign, retries, last_error, created_at`.
-- Если в будущем поменяется тип операции — расширить здесь.
ALTER TABLE inv_pending_confirms ADD COLUMN op_type TEXT NOT NULL DEFAULT 'confirm';
-- op_type: 'confirm' (legacy default) | 'unconsume' (возврат остатка)
