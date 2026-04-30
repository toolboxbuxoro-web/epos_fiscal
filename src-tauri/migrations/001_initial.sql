-- EPOS Fiscal — начальная схема БД.
--
-- Конвенции:
--   * Все суммы в тийинах (1 сум = 100 тийинов) → INTEGER
--   * Количество в тысячных долях (1000 = 1 шт) → INTEGER
--   * Все timestamp как unix epoch секунды → INTEGER
--   * raw_json и подобные поля сохраняем целиком для аудита
--   * ON DELETE CASCADE для дочерних связей

PRAGMA foreign_keys = ON;

-- ─────────────────────────────────────────────────────────────────
-- settings — пары ключ/значение для конфигурации
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ─────────────────────────────────────────────────────────────────
-- esf_items — товары с налоговыми приходами (источник: Excel/ЭСФ/didox)
-- из них Matcher выбирает что отправить в EPOS Communicator
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE esf_items (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  source            TEXT    NOT NULL,        -- 'excel' | 'e-faktura' | 'didox'
  external_id       TEXT,                    -- id во внешней системе (ЭСФ #)
  name              TEXT    NOT NULL,
  barcode           TEXT,
  class_code        TEXT    NOT NULL,        -- ИКПУ
  package_code      TEXT    NOT NULL,        -- код упаковки
  vat_percent       INTEGER NOT NULL DEFAULT 0,
  owner_type        INTEGER NOT NULL DEFAULT 0, -- 0=перепродажа,1=производитель,2=услуга
  unit_price_tiyin  INTEGER NOT NULL,        -- цена за единицу в тийинах
  qty_received      INTEGER NOT NULL,        -- получено (в тысячных)
  qty_consumed      INTEGER NOT NULL DEFAULT 0, -- использовано в фискальных чеках
  received_at       INTEGER NOT NULL,        -- timestamp прихода
  imported_at       INTEGER NOT NULL,        -- timestamp импорта в наше приложение
  notes             TEXT
);

CREATE INDEX idx_esf_items_class       ON esf_items(class_code);
CREATE INDEX idx_esf_items_price       ON esf_items(unit_price_tiyin);
CREATE INDEX idx_esf_items_received_at ON esf_items(received_at);

-- ─────────────────────────────────────────────────────────────────
-- ms_receipts — чеки, поступившие из МойСклад
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE ms_receipts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_id       TEXT    NOT NULL UNIQUE,       -- UUID retaildemand МойСклад
  ms_name     TEXT,                          -- номер чека МС (поле name)
  ms_moment   INTEGER NOT NULL,              -- timestamp пробития
  ms_sum_tiyin INTEGER NOT NULL,             -- общая сумма чека (тийины)
  raw_json    TEXT    NOT NULL,              -- полный JSON retaildemand
  status      TEXT    NOT NULL DEFAULT 'pending',
                -- pending | matched | fiscalized | failed | manual | skipped
  fetched_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_ms_receipts_status ON ms_receipts(status);
CREATE INDEX idx_ms_receipts_moment ON ms_receipts(ms_moment DESC);

-- ─────────────────────────────────────────────────────────────────
-- matches — результат подбора esf_items под чек МойСклад
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE matches (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_receipt_id INTEGER NOT NULL,
  strategy      TEXT    NOT NULL,            -- passthrough | price-bucket | multi-item
  total_tiyin   INTEGER NOT NULL,            -- сумма подобранных позиций
  diff_tiyin    INTEGER NOT NULL,            -- расхождение с оригиналом
  created_at    INTEGER NOT NULL,
  approved_at   INTEGER,                     -- NULL = не подтверждён оператором
  FOREIGN KEY (ms_receipt_id) REFERENCES ms_receipts(id) ON DELETE CASCADE
);

CREATE INDEX idx_matches_receipt ON matches(ms_receipt_id);

-- ─────────────────────────────────────────────────────────────────
-- match_items — позиции внутри подбора
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE match_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     INTEGER NOT NULL,
  esf_item_id  INTEGER NOT NULL,
  quantity     INTEGER NOT NULL,             -- в тысячных
  price_tiyin  INTEGER NOT NULL,             -- цена за всё кол-во в тийинах
  vat_tiyin    INTEGER NOT NULL,             -- сумма НДС в тийинах
  FOREIGN KEY (match_id)    REFERENCES matches(id)   ON DELETE CASCADE,
  FOREIGN KEY (esf_item_id) REFERENCES esf_items(id) ON DELETE RESTRICT
);

CREATE INDEX idx_match_items_match ON match_items(match_id);
CREATE INDEX idx_match_items_esf   ON match_items(esf_item_id);

-- ─────────────────────────────────────────────────────────────────
-- fiscal_receipts — чеки, фискализированные через EPOS Communicator
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE fiscal_receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_receipt_id   INTEGER NOT NULL,
  match_id        INTEGER,                   -- NULL для passthrough без замены
  terminal_id     TEXT    NOT NULL,
  receipt_seq     TEXT    NOT NULL,          -- сквозной номер чека ФМ
  fiscal_sign     TEXT    NOT NULL UNIQUE,   -- фискальный признак
  qr_code_url     TEXT    NOT NULL,
  fiscal_datetime TEXT    NOT NULL,          -- из ответа Communicator (формат YYYYMMDDHHMMSS)
  applet_version  TEXT,
  request_json    TEXT    NOT NULL,          -- что отправили в Communicator
  response_json   TEXT    NOT NULL,          -- что вернулось
  fiscalized_at   INTEGER NOT NULL,
  FOREIGN KEY (ms_receipt_id) REFERENCES ms_receipts(id) ON DELETE CASCADE,
  FOREIGN KEY (match_id)      REFERENCES matches(id)
);

CREATE INDEX idx_fiscal_receipts_ms ON fiscal_receipts(ms_receipt_id);

-- ─────────────────────────────────────────────────────────────────
-- replacement_log — журнал замен ИКПУ для аудита
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE replacement_log (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  ms_receipt_id         INTEGER NOT NULL,
  fiscal_receipt_id     INTEGER,
  original_items_json   TEXT    NOT NULL,    -- что было в МойСклад
  fiscalized_items_json TEXT    NOT NULL,    -- что отправили в EPOS
  reason                TEXT,
  created_at            INTEGER NOT NULL,
  FOREIGN KEY (ms_receipt_id)     REFERENCES ms_receipts(id),
  FOREIGN KEY (fiscal_receipt_id) REFERENCES fiscal_receipts(id)
);

CREATE INDEX idx_replacement_log_ms ON replacement_log(ms_receipt_id);
