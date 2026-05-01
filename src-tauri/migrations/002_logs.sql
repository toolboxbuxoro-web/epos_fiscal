-- Таблица логов: диагностика для пользователя без перекомпиляции.
-- Всё, что важно: poller tick'и, API-запросы (с ошибками), фискализация.

CREATE TABLE logs (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts        INTEGER NOT NULL,           -- epoch секунды
  level     TEXT    NOT NULL,           -- 'debug' | 'info' | 'warn' | 'error'
  source    TEXT    NOT NULL,           -- 'poller' | 'moysklad' | 'epos' | 'matcher' | 'ui' | 'app'
  message   TEXT    NOT NULL,
  details   TEXT                        -- JSON с дополнительными данными (request, response, stack)
);

CREATE INDEX idx_logs_ts     ON logs(ts DESC);
CREATE INDEX idx_logs_level  ON logs(level);
CREATE INDEX idx_logs_source ON logs(source);
