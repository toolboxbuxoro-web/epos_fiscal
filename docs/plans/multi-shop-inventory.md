# Multi-shop inventory — план реализации

Документ-памятка по миграции с «каждый магазин = свой SQLite» к
**общему пулу приходов в mytoolbox** (Express + node-pg + Postgres
на Railway) с атомарной координацией между магазинами.

Дата: 2026-05-04
Статус: ⏳ Phase 1 — стартуем

---

## Зачем

Сейчас каждый магазин держит локальную SQLite со своими `esf_items`.
Бухгалтер импортирует Excel в каждый магазин отдельно. Между
магазинами никакой координации — если бы они физически делили один
склад, было бы двойное списание.

Цель: один общий пул приходов, доступный всем магазинам, с атомарной
резервацией и реальным учётом.

## Архитектура

```
Бухгалтер
   │ Excel import через Mytoolbox UI
   ▼
Mytoolbox (Express + Postgres + Next.js, Railway)  ←─ ОДИН монолит, не отдельный сервис
   │ /api/v1/inventory/*  (reserve/confirm/release/items/events SSE)
   │ HTTPS + API key per-shop
   ▼
┌──────────┬──────────┬──────────┬──────────┐
Магазин 1   Магазин 2   Магазин 3   Магазин 4
(Tauri)     (Tauri)     (Tauri)     (Tauri)
SQLite cache + локальный matcher
fiscal_receipts (локально, для аудита/печати)
pending_confirms (retry queue)
```

**Ключевое:** integrate в существующий mytoolbox backend как
дополнительный модуль (`routes/inventory.js` + `services/inventory/`),
не отдельный сервер. Один деплой, одна Postgres, переиспользуем
auth-паттерн `notification_api_clients`.

## Стек (mytoolbox)

| Слой | Технология |
|---|---|
| Backend framework | Express 4 |
| DB driver | node-postgres (`pg`), raw SQL, без ORM |
| Migrations | inline `CREATE TABLE IF NOT EXISTS` в `db.js` (additive, идемпотентные) |
| Auth (shop API) | bcryptjs + `api_key_prefix` для O(1) lookup (по образцу `notification_api_clients`) |
| Auth (admin UI) | JWT (`middleware/auth.js`) |
| SSE | Express response keep-alive |
| Frontend | Next.js 16 App Router + SWR + zod |
| Deploy | Railway (existing) |

## Решения

| # | Что | Решение |
|---|---|---|
| 1 | Где БД | mytoolbox Postgres (тот же DATABASE_URL) |
| 2 | Сервис | Внутри mytoolbox, не отдельный — переиспользуем deploy/auth/logging |
| 3 | Фискальные чеки (история) | Локально в магазине, не в центральной |
| 4 | Sync магазин↔сервер | SSE push + incremental polling fallback |
| 5 | Auth shop | API key per-shop (паттерн `notification_api_clients`) |
| 6 | Reserve TTL | 5 минут |
| 7 | Excel импорт | Через mytoolbox админку (бухгалтер) |
| 8 | Пул | Общий на все магазины, поле `organization_id` для будущего разделения |

## Schema (новые таблицы в mytoolbox `db.js`)

Naming convention: префикс `inv_` чтобы не конфликтовать с существующими
таблицами mytoolbox.

```sql
-- Магазины (клиенты inventory API)
CREATE TABLE IF NOT EXISTS inv_shops (
  id              SERIAL PRIMARY KEY,
  slug            VARCHAR(50) UNIQUE NOT NULL,        -- 'toolbox-honabod'
  name            VARCHAR(100) NOT NULL,
  organization_id VARCHAR(50) NOT NULL DEFAULT 'default',
  api_key_hash    TEXT NOT NULL,                       -- bcrypt
  api_key_prefix  VARCHAR(16) NOT NULL,                -- индексируем для O(1) lookup
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_inv_shops_prefix
  ON inv_shops(api_key_prefix) WHERE is_active;

-- Приходы (импортируются бухгалтером из Excel)
CREATE TABLE IF NOT EXISTS inv_items (
  id               SERIAL PRIMARY KEY,
  organization_id  VARCHAR(50) NOT NULL DEFAULT 'default',
  name             VARCHAR(500) NOT NULL,
  class_code       VARCHAR(20) NOT NULL,              -- ИКПУ
  package_code     VARCHAR(20),
  vat_percent      INTEGER NOT NULL,
  unit_price_tiyin BIGINT NOT NULL,
  qty_received     INTEGER NOT NULL,                  -- миллидоли
  qty_consumed     INTEGER NOT NULL DEFAULT 0,
  qty_reserved     INTEGER NOT NULL DEFAULT 0,
  received_at      TIMESTAMPTZ NOT NULL,
  imported_at      TIMESTAMPTZ DEFAULT NOW(),
  source_doc       TEXT,                              -- ссылка на ЭСФ
  CHECK (qty_received >= 0),
  CHECK (qty_consumed >= 0),
  CHECK (qty_reserved >= 0),
  CHECK (qty_consumed + qty_reserved <= qty_received)
);
CREATE INDEX IF NOT EXISTS idx_inv_items_org_class
  ON inv_items(organization_id, class_code);
CREATE INDEX IF NOT EXISTS idx_inv_items_available
  ON inv_items(organization_id, (qty_received - qty_consumed - qty_reserved));

-- Резервации (TTL 5 мин)
CREATE TABLE IF NOT EXISTS inv_reservations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inv_item_id     INTEGER NOT NULL REFERENCES inv_items(id),
  shop_id         INTEGER NOT NULL REFERENCES inv_shops(id),
  ms_receipt_id   VARCHAR(100) NOT NULL,
  quantity        INTEGER NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'active',  -- active|confirmed|released|expired
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  confirmed_at    TIMESTAMPTZ,
  fiscal_sign     VARCHAR(100),
  release_reason  TEXT,
  CHECK (status IN ('active', 'confirmed', 'released', 'expired'))
);
CREATE INDEX IF NOT EXISTS idx_inv_resv_active
  ON inv_reservations(status, expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS idx_inv_resv_shop_receipt
  ON inv_reservations(shop_id, ms_receipt_id);

-- Audit log
CREATE TABLE IF NOT EXISTS inv_events (
  id              SERIAL PRIMARY KEY,
  inv_item_id     INTEGER NOT NULL,
  shop_id         INTEGER,
  type            VARCHAR(30) NOT NULL,    -- reserved|confirmed|released|expired|imported|adjusted
  quantity        INTEGER NOT NULL,
  reservation_id  UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  meta            JSONB
);
CREATE INDEX IF NOT EXISTS idx_inv_events_item
  ON inv_events(inv_item_id, created_at DESC);
```

`available = qty_received − qty_consumed − qty_reserved`

## Endpoints

```
# Shop API (Bearer api_key per shop)
POST   /api/v1/inventory/reserve     {ms_receipt_id, items[]}
POST   /api/v1/inventory/confirm     {reservation_id, fiscal_sign}
POST   /api/v1/inventory/release     {reservation_id, reason}
POST   /api/v1/inventory/extend      {reservation_id, extend_seconds}
GET    /api/v1/inventory/items?since=ts&limit=N&class_code=X
GET    /api/v1/inventory/events                        # SSE (live updates)

# Admin (JWT — существующий middleware/auth.js)
GET    /api/v1/admin/inventory/shops                   # список + статус
POST   /api/v1/admin/inventory/shops                   # создать → возвращает API key (one-time)
POST   /api/v1/admin/inventory/shops/:id/rotate-key    # перевыпуск
PATCH  /api/v1/admin/inventory/shops/:id               # is_active toggle, переименование

GET    /api/v1/admin/inventory/items                   # список с фильтрами
POST   /api/v1/admin/inventory/items/import-excel      # multipart upload
PATCH  /api/v1/admin/inventory/items/:id               # ручная корректировка
DELETE /api/v1/admin/inventory/items/:id               # удалить если не consumed

GET    /api/v1/admin/inventory/reservations            # активные/истёкшие
GET    /api/v1/admin/inventory/events?item_id=X        # audit
```

## Поток одного чека (reserve → fiscal → confirm)

```
МАГАЗИН                        SERVER (Express + Postgres)
─────────                      ─────────
1. matcher на локальном кэше
   выбрал кандидатов

2. POST /reserve {items[]}  →  pg.query('BEGIN')
                                FOR each item: SELECT … FOR UPDATE
                                if все available >= qty:
                                  UPDATE inv_items SET qty_reserved += qty
                                  INSERT inv_reservations
                                  INSERT inv_events
                                  → 200 {reservation_id, expires_at}
                                else:
                                  → 409 {failed: [{id, available, requested}]}
                                pg.query('COMMIT')
                                → SSE broadcast 'item.reserved'

3a. Если 200:
    → EPOS Communicator
    → FiscalSign

    POST /confirm {resv_id}  →  BEGIN
                                  SELECT FOR UPDATE на inv_reservations + inv_items
                                  inv_reservations.status = 'confirmed'
                                  qty_reserved -= qty
                                  qty_consumed += qty
                                  INSERT inv_events
                                  → 200 {confirmed_at, item: {qty_received, qty_consumed, qty_reserved}}
                                COMMIT
                                → SSE broadcast 'item.confirmed'

3b. Если 409:
    → matcher re-runs без отказанных items
    → новые кандидаты → новый /reserve

4. Ошибка EPOS:
    POST /release {resv_id, reason}  →  qty_reserved -= qty
                                         status = 'released'
                                         → SSE broadcast 'item.released'
```

## Edge cases

| Случай | Решение |
|---|---|
| Магазин «упал» между EPOS и confirm | Локальная очередь `pending_confirms` (SQLite в Tauri) → retry на старте. `/confirm` идемпотентен по reservation_id |
| TTL истёк, но магазин уже выбил чек | `/confirm` идемпотентен — даже если status='expired', проверяет что есть запас и переводит в 'confirmed'. Если нет — 409, магазин в логи (фискальный чек уже в ОФД, нужна ручная коррекция) |
| Network down | Fail fast: «нет связи с inventory server» → блок UI, кассир ждёт. (Опционально оффлайн-очередь — не Phase 1) |
| EPOS-зависание дольше TTL | `/extend` endpoint + heartbeat |
| Massive Excel re-import | Bulk upsert. Старые qty_consumed/reserved не трогаем, только обновляем qty_received если он стал меньше → конфликт-чек |
| Магазин «зажадничал» резервами | Cron-job (раз в минуту) `UPDATE WHERE expires_at<NOW() AND status='active' SET status='expired'` + qty_reserved обратно. Админ-UI видит активные > 1 мин |
| Уведомления | На confirm → события в `inv_events`. Опционально low-stock alerts через `notifications.dispatch({type: 'inventory.low_stock'})` если qty_received-qty_consumed < threshold |

## Tauri клиент: что меняется

1. **Новый модуль** `src/lib/inventory/server-client.ts` — обёртка reserve/confirm/release/extend с retry+timeout
2. **Замена** `consumeEsfItem(id, qty)` в `fiscalize.ts` на `serverClient.reserve → fiscal → confirm`
3. **Локальный SQLite** теперь = read-only кэш. Sync:
   - На старте: `GET /items?since=last_sync_ts` → upsert в local SQLite
   - SSE-канал `/events` для live updates
   - Fallback polling каждые 30 сек если SSE отвалился
4. **`pending_confirms` SQLite таблица** — retry queue
5. **Settings**:
   - `inventory_server_url` (например `https://mytoolbox-backend.up.railway.app`)
   - `shop_id` (slug, напр. `toolbox-honabod`)
   - `shop_api_key`
6. **UX 409**: тост + auto re-match без отказанных позиций
7. **Dual-mode флаг** `useRemoteInventory: bool`:
   - false (default на старых установках) — старый локальный режим
   - true — talks to server
   - переключение в Settings, миграция через прогон импорта на server

## Phases

| # | Фаза | Что | Где |
|---|---|---|---|
| **1a** | Schema | Inline migrations в `mytoolbox/backend/src/db.js` для inv_* таблиц | mytoolbox |
| **1b** | Routes | `routes/inventory.js` со shop endpoints + auth middleware | mytoolbox |
| **1c** | Services | `services/inventory/{reservations,items,sse}.js` + crom job для expire | mytoolbox |
| **2** | Tauri sync | `src/lib/inventory/server-client.ts` + SSE + локальный cache sync | epos_fiscal |
| **3** | Integration | Замена `consumeEsfItem` + pending queue + UX 409 + dual-mode флаг | epos_fiscal |
| **4** | Admin UI | Next.js страницы под `frontend/app/(admin)/inventory/{shops,items,reservations}` + Excel import | mytoolbox |
| **5** | Cleanup | Удалить локальный Catalog.tsx импорт когда все магазины переехали | epos_fiscal |

## Открытые вопросы (можно отложить)

- Использовать ли для shop-auth ту же таблицу `notification_api_clients` или отдельную `inv_shops`? — пока отдельную, переиспользовать паттерн но не данные (другая модель: магазин = клиент, не abstract API client).
- Domain имя API — `https://api.mytoolbox.uz/api/v1/inventory/*` или существующий backend domain. Уточнить когда будем настраивать deploy.
- Notifications хуки — опционально. На low-stock и stuck reservations можно слать в Telegram через существующий канал.
