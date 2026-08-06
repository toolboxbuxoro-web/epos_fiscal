-- ─────────────────────────────────────────────────────────────────
-- 015: синхронизация фискальных чеков (и их возвратов) на mytoolbox
-- ─────────────────────────────────────────────────────────────────
--
-- Зачем: сейчас каждый чек живёт только в локальной SQLite конкретного
-- магазина — админ не видит продажи 4 магазинов в одном месте, сверка
-- с ОФД/бухгалтерией требует ручного экспорта с каждой Win-машины.
--
-- `src/lib/sales-sync.ts` (по образцу telemetry.ts) раз в 60 сек берёт
-- пачку ещё не отправленных чеков (`synced_to_server = 0`), собирает
-- payload (сумма, позиции, состав чека МойСклад, возвраты) и шлёт на
-- `POST /api/v1/inventory/sales`. Эндпоинт идемпотентен на сервере
-- (UNIQUE shop_id+fiscal_sign), поэтому повторная отправка одного и
-- того же чека (например после сетевого сбоя ДО получения ответа) не
-- создаёт дублей — флаг тут нужен только чтобы не гонять уже принятые
-- сервером чеки на каждый тик.
--
-- Колонка добавлена в ОБЕ таблицы:
--   - `fiscal_receipts` — сами продажи, это основной драйвер выборки
--     в flushSalesToServer (`synced_to_server = 0`).
--   - `fiscal_refunds` — возвраты уезжают ВЛОЖЕННЫМИ в payload своего
--     родительского чека (`sales[].refunds[]`), а не отдельным
--     top-level запросом. Отдельный флаг на refunds всё равно нужен
--     чтобы после успешной отправки батча пометить именно те refund'ы,
--     что реально попали в payload (а не все refund'ы чека вообще).
--
-- Возврат почти всегда оформляется ПОЗЖЕ, чем чек уехал на сервер
-- (покупатель приходит через день-два). Поэтому выборка батча берёт не
-- только неотправленные чеки, но и уже отправленные, у которых появился
-- неотправленный возврат. Сервер к этому готов: блок `refunds` он
-- обрабатывает даже когда шапка чека приходит дублем.
ALTER TABLE fiscal_receipts ADD COLUMN synced_to_server INTEGER NOT NULL DEFAULT 0;
ALTER TABLE fiscal_refunds  ADD COLUMN synced_to_server INTEGER NOT NULL DEFAULT 0;

-- Частичные индексы — выборка «что ещё не отправлено» не сканирует всю
-- таблицу (десятки/сотни тысяч строк на зрелом магазине), а сразу берёт
-- маленький хвост неотправленных.
--
-- ВАЖНО: flushSalesToServer выбирает батч через
--   `id IN (SELECT id FROM fiscal_receipts WHERE synced_to_server = 0
--           UNION SELECT original_fiscal_id FROM fiscal_refunds WHERE synced_to_server = 0)`
-- (форма `WHERE synced_to_server = 0 OR id IN (...)` НЕ использует частичные
-- индексы — EXPLAIN показывал `SCAN fiscal_receipts`, полный скан таблицы
-- на каждый тик раз в 60 сек). Для этой формы индекс на `fiscal_refunds`
-- должен быть по `original_fiscal_id` (не по `id`) — именно эту колонку
-- селектит вторая ветка UNION, а значит индекс становится ПОКРЫВАЮЩИМ
-- (index-only scan, без похода в таблицу).
CREATE INDEX IF NOT EXISTS idx_fiscal_receipts_unsynced ON fiscal_receipts(id) WHERE synced_to_server = 0;
CREATE INDEX IF NOT EXISTS idx_fiscal_refunds_unsynced ON fiscal_refunds(original_fiscal_id) WHERE synced_to_server = 0;
