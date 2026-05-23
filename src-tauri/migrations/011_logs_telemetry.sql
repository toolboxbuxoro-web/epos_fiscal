-- ─────────────────────────────────────────────────────────────────
-- 011: sent_to_server в logs — телеметрия error/critical логов на mytoolbox
-- ─────────────────────────────────────────────────────────────────
--
-- Зачем: централизованный сбор ошибок 4 магазинов на mytoolbox-сервере.
-- Админ видит все error/critical в одной admin-панели, не подключаясь к
-- каждой Win-машине. Telegram-алерты на critical (refund в ОФД но не
-- сохранён локально и т.п.) — мгновенная реакция вместо «через 3 дня
-- кассир напишет».
--
-- Архитектура (см. src/lib/telemetry.ts):
--   1. Все логи пишутся в local SQLite как и раньше (log.ts)
--   2. Background-flusher раз в 30 сек выбирает unsent error/critical
--   3. Батч POST на /api/v1/telemetry/logs с Bearer api_key магазина
--   4. На успехе — UPDATE sent_to_server=1
--   5. PII-скрабинг ДО отправки (убираем tin/pinfl/clientName)
--
-- Значения sent_to_server:
--   0 = ещё не отправлен (default для новых записей)
--   1 = отправлен на сервер
--
-- info/debug/warn НЕ шлются — только error+critical. Засорять трафик
-- не хочется, debug-инфа остаётся локально для разбора админом по
-- кнопке «Сообщить о проблеме» (Phase 2).

ALTER TABLE logs ADD COLUMN sent_to_server INTEGER NOT NULL DEFAULT 0;

-- Индекс для быстрой выборки unsent error/critical (горячий путь flusher'а
-- каждые 30 сек). Без него — full table scan, при больших объёмах логов
-- (~10к строк/день) flusher тормозил бы.
CREATE INDEX idx_logs_unsent_errors
  ON logs(sent_to_server, level, ts)
  WHERE sent_to_server = 0 AND level IN ('error');
