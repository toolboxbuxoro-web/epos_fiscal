-- Phase 2: частичный возврат (partial refund).
--
-- БЫЛО: один продажный чек = один полный refund (UNIQUE на original_fiscal_id).
-- СТАЛО: один чек может иметь N partial refunds + 0..1 full refund.
--
-- Защиты в коде (НЕ в БД):
--   * Снят UNIQUE на original_fiscal_id (SQLite не умеет DROP CONSTRAINT, recreate)
--   * fiscal_sign остаётся UNIQUE (защита от дабл-клика в одном refund-флоу)
--   * cumulative qty по каждому item не должен превышать original qty (проверка в processRefund)
--
-- Новые колонки:
--   * is_partial: 1 = частичный возврат, 0 = полный (legacy default = 0)
--   * refunded_items_snapshot: JSON snapshot выбранных items с qty
--     формат: [{ "originalItemIndex": 0, "qtyMilli": 1000, "refundTiyin": 100000 }]

PRAGMA foreign_keys = OFF;

CREATE TABLE fiscal_refunds_new (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  -- БЫЛО: UNIQUE. СТАЛО: обычная колонка с индексом.
  original_fiscal_id        INTEGER NOT NULL,
  ms_return_id              INTEGER,
  terminal_id               TEXT    NOT NULL,
  receipt_seq               TEXT    NOT NULL,
  -- fiscal_sign refund'а остаётся уникальным — защита от дабл-клика
  -- в одном refund-флоу. Два РАЗНЫХ refund-чека на тот же оригинал
  -- получат разные FiscalSign от Communicator.
  fiscal_sign               TEXT    NOT NULL UNIQUE,
  qr_code_url               TEXT    NOT NULL,
  fiscal_datetime           TEXT    NOT NULL,
  applet_version            TEXT,
  items_json                TEXT    NOT NULL,
  refund_cash_tiyin         INTEGER NOT NULL DEFAULT 0,
  refund_card_tiyin         INTEGER NOT NULL DEFAULT 0,
  refund_qr_tiyin           INTEGER NOT NULL DEFAULT 0,
  request_json              TEXT    NOT NULL,
  response_json             TEXT    NOT NULL,
  reason                    TEXT,
  cashier_name              TEXT,
  refunded_at               INTEGER NOT NULL,
  -- НОВОЕ: тип возврата.
  is_partial                INTEGER NOT NULL DEFAULT 0,
  -- НОВОЕ: snapshot выбранных позиций (для partial). NULL для full.
  -- Формат: JSON-массив [{originalItemIndex, qtyMilli, refundTiyin}]
  refunded_items_snapshot   TEXT,
  FOREIGN KEY (original_fiscal_id) REFERENCES fiscal_receipts(id),
  FOREIGN KEY (ms_return_id)       REFERENCES ms_receipts(id)
);

-- Переносим данные (все старые refund'ы = full, is_partial=0).
INSERT INTO fiscal_refunds_new (
  id, original_fiscal_id, ms_return_id, terminal_id, receipt_seq,
  fiscal_sign, qr_code_url, fiscal_datetime, applet_version,
  items_json, refund_cash_tiyin, refund_card_tiyin, refund_qr_tiyin,
  request_json, response_json, reason, cashier_name, refunded_at,
  is_partial, refunded_items_snapshot
)
SELECT
  id, original_fiscal_id, ms_return_id, terminal_id, receipt_seq,
  fiscal_sign, qr_code_url, fiscal_datetime, applet_version,
  items_json, refund_cash_tiyin, refund_card_tiyin, refund_qr_tiyin,
  request_json, response_json, reason, cashier_name, refunded_at,
  0, NULL
FROM fiscal_refunds;

DROP TABLE fiscal_refunds;
ALTER TABLE fiscal_refunds_new RENAME TO fiscal_refunds;

CREATE INDEX idx_fiscal_refunds_original ON fiscal_refunds(original_fiscal_id);
CREATE INDEX idx_fiscal_refunds_date     ON fiscal_refunds(refunded_at DESC);

PRAGMA foreign_keys = ON;
