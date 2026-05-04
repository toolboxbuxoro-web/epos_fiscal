-- Multi-shop inventory sync — поддержка remote inventory server.
--
-- Магазин по-прежнему держит локальный кэш приходов в `esf_items`, но теперь
-- (опционально) синхронизирует его с центральным сервером (mytoolbox/inventory).
-- Каждая локальная строка может ссылаться на серверный id через `server_item_id`.
--
-- Если режим remote НЕ включён (старая инсталляция, или магазин-пилот) —
-- server_item_id остаётся NULL, всё работает по-старому через consumeEsfItem.

ALTER TABLE esf_items ADD COLUMN server_item_id INTEGER;
CREATE INDEX idx_esf_items_server_id ON esf_items(server_item_id) WHERE server_item_id IS NOT NULL;

-- ─────────────────────────────────────────────────────────────────
-- inv_pending_confirms — retry queue для confirm-вызовов.
--
-- Зачем: после успешной фискализации (FiscalSign в ОФД) ОБЯЗАТЕЛЬНО
-- нужно отправить /confirm на сервер чтобы перевести qty_reserved →
-- qty_consumed. Если в этот момент сеть отвалилась, или приложение
-- закрыли — резерв через 5 мин истечёт и НЕ спишется. Чек уже в ОФД,
-- но на сервере остатки выглядят будто его не было → перепродажа.
--
-- Решение: запись пишется СРАЗУ после получения reservation_id, ДО EPOS.
-- После успешного confirm — удаляется. На старте app — ретрай pending.
-- ─────────────────────────────────────────────────────────────────
CREATE TABLE inv_pending_confirms (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id  TEXT    NOT NULL,             -- UUID с сервера
  ms_receipt_id   TEXT    NOT NULL,             -- для трассировки
  fiscal_sign     TEXT,                         -- заполняется ПОСЛЕ EPOS
  status          TEXT    NOT NULL DEFAULT 'reserved',
                  -- 'reserved' (до EPOS) | 'fiscal-ok' (EPOS прошёл, ждём confirm)
                  -- | 'confirmed' (успех; запись можно удалить)
                  -- | 'failed' (release уже отправлен)
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX idx_inv_pending_status ON inv_pending_confirms(status);
CREATE INDEX idx_inv_pending_resv   ON inv_pending_confirms(reservation_id);
