# CLAUDE.md — заметки для разработчиков

Документ-памятка по проекту. Читать перед тем как трогать код. Обновлять
когда меняются ключевые архитектурные решения или внешние API.

---

## Одной фразой

Десктоп-приложение (Tauri 2) для магазинов в Узбекистане. Принимает чеки
из МойСклад → подбирает товары с налоговыми приходами на нужную сумму
(matcher) → фискализирует через локальный EPOS Communicator → ОФД ГНК.

## Стек

| Слой | Технология | Где |
|---|---|---|
| Каркас | Tauri 2 (Rust) | `src-tauri/` |
| UI | React 18 + TypeScript + Vite + Tailwind | `src/` |
| Локальная БД | SQLite через `tauri-plugin-sql` | `src-tauri/migrations/` |
| HTTP | `tauri-plugin-http` (reqwest, **с фичей `gzip`**) | client.ts/jsonrpc-client.ts |
| Excel | SheetJS (`xlsx` from CDN, не из npm) | `src/lib/esf/excel.ts` |
| Auto-update | `tauri-plugin-updater` + minisign | `src/lib/updater.ts` |
| Печать чека | crate `printers` + raw ESC/POS байты | `src-tauri/src/printer.rs` + `src/lib/printer/` |
| CI | GitHub Actions | `.github/workflows/release.yml` |

## Архитектура (один магазин)

```
МойСклад API ──────HTTPS──────► Toolbox Fiscal (наша программа на Win)
(розничная касса)                    │
                                     │ HTTP localhost
                                     ▼
                             EPOS Communicator (от E-POS Systems)
                                     │
                                     │ PC/SC + крипта
                                     ▼
                              USB-карта EPOS (физическая)
                                     │
                                     ▼
                              ОФД (s2.ofd.uz / soliq.uz)
```

Внутри нашей программы:

```
Polling МойСклад (раз в 30 сек, фильтр retailStore)
       │
       ▼
ms_receipts (raw JSON чеков из МС)
       │
       ▼
Matcher (4 стратегии classic + holistic fallback + manual picker)
       │  ↑    targetSumOverrideTiyin ← Click/Payme exclude (UI поле)
       │  └── читает esf_items (mirror серверного inv_items, sync c reconcile)
       ▼
matches + match_items (план: чем подменить)
       │
       ▼  + AlreadyFiscalizedError guard (запрет повторной фискализации)
       ▼  + ShiftNotOpenError detect (понятный баннер «откройте смену»)
       ▼  + CardKindModal (Korporativ/Jismoniy shaxs — только на печать)
fiscalize() → JsonRpcEposClient.sendSaleReceipt (Api.SendSaleReceipt)
       │       + excludePaymentTiyin (вычитается из noCashSum при split)
       ▼
fiscal_receipts (FiscalSign, card_kind, excluded_payment_tiyin для аудита)
       │
       ▼
printer.rs::print_fiscal_receipt (ESC/POS + Karta turi + сумма без exclude)

Параллельная ветка — смена ККМ (роут /zreport):
   getZReportInfo (раз в 30 сек) → UI данные
   openShift → Api.OpenZReport
   closeShift → Api.CloseZReport → printer.rs::print_z_report (Z auto)

Ветка возврата (роут /refund/:fiscalReceiptId) — см. секцию «Возвраты»:
   Чеки → клик «Возврат» → processRefund()
        → Api.SendRefundReceipt + refundInfo (camelCase, dateTime 14 цифр)
        → fiscal_refunds (UNIQUE на original_fiscal_id — один refund на чек)
        → /api/v1/inventory/unconsume на сервер (idempotent, retry-очередь)
        → печать «ВОЗВРАТ ТОВАРА»
```

## Multi-shop

Каждый магазин = своя Win-машина = свой USB-фискальный модуль = своя
инсталляция нашей программы. БД у каждой своя, в `%APPDATA%`. Между
магазинами — никакого общего состояния.

Если все 4 магазина под **одним МС-аккаунтом** — поллер фильтрует по
точке продаж (`SettingKey.MoyskladRetailStoreId`), иначе магазин 1
фискализировал бы чеки магазина 3 через свою USB.

## EPOS Communicator: JSON-RPC API

Используем **только JSON-RPC** на `http://localhost:3448/rpc/api`. Legacy
`/uzpos` удалён в 0.10.13 потому что на актуальных версиях Communicator
(3.20+) он урезан — `NO_SUCH_METHOD_AVAILABLE` на `sale`/`fastSale`.

### Формат

JSON-RPC 2.0: `{jsonrpc: "2.0", id, method, params}`. Token не нужен.

Методы: `Api.SendSaleReceipt`, `Api.SendRefundReceipt`, `Api.OpenZReport`,
`Api.CloseZReport`, `Api.GetReceiptCount`, `Api.GetUnsentCount`,
`Api.Status`, `Api.GetZReportInfo` (текущий X/Z-отчёт со всеми тоталами).

**Чего НЕТ в Communicator JSON-RPC:** методов печати X/Z-отчёта. Проверили
4 кандидата (`Api.PrintXReport` / `Api.PrintZReport` / `Api.PrintCurrentZReport` /
`Api.PrintZReportInfo`) — все вернули `NO_SUCH_METHOD_AVAILABLE`. Поэтому
X/Z-отчёт печатаем сами через ESC/POS в `printer.rs` → см. секцию «Z-отчёт ККМ».

### ⚠️ Критичные имена полей в `params.Receipt.Items[]`

```ts
{
  Name: string,           // название товара
  Price: number,          // цена в тийинах за всё quantity (до скидки)
  Discount: number,       // размер скидки в тийинах (0 если нет)
  Amount: number,         // 1 шт = 1000 (миллидоли)
  Barcode: string,        // штрих-код или "0"
  VAT: number,            // сумма НДС в тийинах
  VATPercent: number,     // 0, 12, 15
  Other: number,          // 0
  OwnerType: 0|1|2,       // 0=перепродажа, 1=производитель, 2=услуга
  spic: string,           // ⭐ ИКПУ (17 цифр) — ИМЕННО `spic`, не classCode!
  packageCode: string,    // код упаковки из getICPCPackage(spic)
}
```

**`spic`** — ключевое поле для MXIK. Имя найдено через
`docs.epos.uz/ru/mobile-api/receipts-sale` (E-POS Mobile API того же
производителя). Подтверждено реальной фискализацией с TerminalID
`VG343420011189` в 0.10.12 — MXIK дошёл до ОФД, кешбэк начислился.

**Не менять имя `spic` без проверки!** Communicator JSON-RPC игнорирует
любые альтернативные имена (`classCode`, `Mxik`, `IKPU`, etc) — мы
проверили в 0.10.5–0.10.11 через shotgun-стратегию, ни одно не сработало.

### `params.Receipt` верхний уровень

```ts
{
  Time: string,           // Go-style "2026-05-08 10:57:46" (с пробелом!)
  Items: JsonRpcItem[],
  ReceivedCash: number,   // тийины
  ReceivedCard: number,
  Cashier?: string,       // ФИО — попадает на бумажный чек
}
```

Реквизиты компании (название/ИНН/адрес/телефон) **НЕ передаём** — Communicator
берёт их с физического USB-фискального модуля, привязанного к ГНК.

### В нашем коде
- `src/lib/epos/jsonrpc-client.ts` — типы и клиент
- `src/lib/epos/fiscalize.ts` — построение payload и отправка

### Документация
- `docs/external-apis/universal-communicator.md` — Communicator API (legacy + JSON-RPC)
- `docs/external-apis/epos-mobile-api.md` — E-POS Mobile API (источник имён `spic`, `packageCode`)
- `docs/external-apis/fiscal-drive-service.md` — FiscalDriveService (alt путь интеграции,
  open-source, на :3449/rpc REST, минует E-POS Communicator)

## МойСклад API — критичные детали

### `Accept-Encoding: gzip` обязателен
Без этого заголовка МойСклад API возвращает **HTTP 415**. Решение:
`tauri-plugin-http = { version = "2", features = ["gzip"] }` в Cargo.toml.
Reqwest сам добавляет заголовок и распаковывает ответ.

### Basic Auth — современный путь
Метод `POST /security/token` через Tauri http возвращает 400 (мистика
Tauri/reqwest). Поэтому в каждом запросе шлём `Authorization: Basic <base64(login:pass)>`.
Хранится base64-credentials в `SettingKey.MoyskladCredentials`.

### Lazy-load позиций чека
В list-запросе `/entity/retaildemand` МС возвращает только meta-link на
позиции — даже с `expand=positions.assortment`. Чтобы получить inline
позиции — отдельный GET по UUID с expand. Делается лениво в Receipt.tsx.

### Polling-курсор
В `LAST_SYNC_KEY` храним epoch-секунды самой свежей увиденной записи.
Следующий запрос — `filter=updated>{cursor}`. Гарантирует не пропустить
и не дублировать.

## Доменные единицы (критично — не ломать!)

| Что | Единица | Пример |
|---|---|---|
| Денежные суммы | **тийины** (1 сум = 100 тийинов), целое | 5000000 = 50 000 сум |
| Количество товара | **тысячные** (1000 = 1 шт) | 2500 = 2.5 кг |
| Время в БД | **epoch секунды** | now() helper |
| Дата для МС filter | `YYYY-MM-DD HH:MM:SS.SSS` UTC | `formatMsMoment` |
| Дата `Receipt.Time` (JSON-RPC sale/refund) | **Go-style с пробелом**, локальное время | `2026-05-04 15:30:00` (через `formatGoTime`) |
| **`refundInfo.dateTime`** (внутри refund-payload) | **строго 14 цифр** YYYYMMDDHHMMSS без разделителей | `20260516095418` (через `toRefundDateTime` — выкидывает нецифры, первые 14) |
| `fiscal_receipts.fiscal_datetime` (хранилка) | Как вернул Communicator — может быть либо | `20260516095418` или `2026-05-16 09:54:18` |

Любой числовой расчёт с деньгами — в тийинах. Конвертация только на
вход (Excel) и UI-форматирование (`format.ts`).

**`refundInfo.dateTime` критично** — формат с разделителями (Go-style/ISO)
ОФД не парсит и refund попадает в «Бириктирилмаган» (не привязан к оригиналу).
`toRefundDateTime()` в `refund.ts` нормализует любой формат.

## ИКПУ и приходы

ИКПУ (17 цифр) и `packageCode` — обязательны для каждой позиции в чеке
по налоговому кодексу РУз. С 01.07.2022 штраф 1% за указание чужого ИКПУ.

В `esf_items` храним:
- `class_code` — ИКПУ
- `package_code` — код единицы измерения
- `qty_received` / `qty_consumed` — приход и сколько уже использовано

Matcher выбирает товары так, чтобы суммарно совпадало по цене и НДС
с оригинальным чеком из МойСклад.

**Юридический нюанс:** подмена ИКПУ — серая зона. Юзер взял на себя
ответственность. Журнал замен — `replacement_log` для аудита.

## Matcher: цена и четыре стратегии + manual

### Формула продажной цены

`selling = round_up(unit_price × (1 + markup/100) × (1 + vat/100), step)` —
**последовательно**, не суммой 22%. Дефолты: markup 10%, step 1000 сум.

Пример: приход 5959.28 сум, markup 10%, НДС 12%, шаг 1000 →
`5959.28 × 1.10 × 1.12 = 7341.63` → округление вверх → **8000 сум**.

Себестоимость с НДС (пол скидки): `unit_price × (1 + vat/100)` × quantity —
**без** наценки. Это нижняя граница для `distributeDiscount` **и** ручного
подбора (`replacePositionManual` отвергает если cost > pos.totalTiyin).

### НДС override (общий режим магазина)

`SettingKey.DefaultVatPercent` (default `'12'`) — override `inv_item.vat_percent`
для **всех** товаров пула в `loadMatcherPool`. Магазин на общем режиме РУз
продаёт всё с НДС 12% независимо от того что указал поставщик в ЭСФ
(упрощенцы шлют 0%). Override применяется в pool → matcher → fiscalize →
печать одновременно. Если магазин на упрощёнке — поставь `'0'`.

### Стратегии (по очереди для каждой позиции)

1. **linked-ms** — в МС-модификации есть характеристика «Бухгалтерское
   наименование» (имя как в `esf_items.name`) → smart-search по пулу
   (exact → substring ≥15 символов с model-token → token-fuzzy ≥50%
   + model-token). Самая надёжная — явная связка от бухгалтера.
   Swap между **батчами** одного buh-name + split разрешены.
2. **passthrough** — есть приход с тем же ИКПУ и достаточным остатком →
   фискализируем «как есть». Цена = расчётная продажная.
3. **price-bucket** — нет ИКПУ или нет остатка → ищем товар, у которого
   расчётная цена близка к `pos.totalTiyin` в пределах `toleranceTiyin`.
   **В чек пишем `pos.totalTiyin` (не calculated)** — клиент заплатил
   эту сумму, фискализируем именно её.
4. **multi-item** — greedy knapsack по убыванию цены, набираем N товаров
   на сумму ± tolerance. Лимит N — `maxMultiItem` (default **10**, был 5).

**Manual picker (UI fallback)** — если ни одна не сработала, позиция
попадает в `match.positions` с пустым `candidates[]` (раньше уходила
только в warnings). UI рисует строку «не подобрано» + кнопку «Подобрать
вручную» → модалка с индексированным поиском по всему пулу + фильтром
по цене. `replacePositionManual()` атомарно заменяет позицию и
проверяет `costWithVat ≤ pos.totalTiyin` (нельзя в убыток).

### Pool-фильтр (важно)

`loadMatcherPool`:
- Только `source='remote'` (synced from mytoolbox), legacy excel-импорты
  с `server_item_id IS NULL` исключены — они не работают в multi-shop.
- Исключаем приходы без `class_code` (ИКПУ обязателен по mobile-api E-013).
- **`package_code` НЕ требуем** — по mobile-api он ❌ опциональное
  (E-014 только при НЕВЕРНОМ коде). Раньше зря фильтровали — товары с
  валидным ИКПУ но без package_code выпадали из подбора.
- НДС override (см. выше).

### Финальное выравнивание суммы

После основного цикла (если флаг `discountForExactSum=true`):

- `distributeDiscount` — matched > target → срезаем скидкой. Cap
  `maxDiscountPerItemTiyin` (default 200_000 = 2000 сум). Floor —
  себестоимость с НДС (нельзя продавать в убыток).
- `distributeBump` — matched < target → надбавка к цене. **Отдельный**
  cap `maxBumpPerItemTiyin` (default **1_000_000 = 10000 сум**, не общий
  с discount). Bump = легальная наценка, нет cost-floor — можно поднимать
  выше. Дефолт 10000 сум закрывает разрывы 20-54к при «дырявом» складе.

Один флаг → точное совпадение в обе стороны. По дефолту флаг **включён**
(в Receipt.tsx fallback `null → true`).

### tolerance дефолт

`Receipt.tsx::DEFAULT_TOLERANCE_TIYIN = 500_000` (5000 сум). Раньше 100k
(1000 сум) — при округлении цен до 1000 и редком складе ничего не
матчилось. ±5000 + bump 10000 закрывает разумные разрывы. В чек всё
равно пишется `pos.totalTiyin` (что заплатил клиент) — расширение
безопасно. Переопределяется через `SettingKey.MatchToleranceTiyin`.

### Пул товаров — один запрос на чек

`loadMatcherPool` грузит все `esf_items` с `available >= 1000` ОДИН раз
и предрасчитывает `sellingPrice` для каждого. Все 3 стратегии работают
по этому пулу in-memory. Раньше каждая стратегия делала свой
`listEsfItems(limit:5000)` × N позиций — UI лагал на чеках 5+ позиций.

### Услуги (`assortment.meta.type === 'service'`)

В МС магазины используют тип service для нетоварных позиций: имя
кассира («Турсуной кушмуродова»), доставка, монтаж, гарантия.
**В фискальный чек УЗ услуги не идут** — кассовый аппарат пробивает
только товары с ИКПУ. `extractPositions` фильтрует их по
`assortment.meta.type === 'service'` ещё до matcher.

### Бонусы / частичная оплата

В МС `rd.sum` — что покупатель РЕАЛЬНО заплатил (после вычета бонусов).
Сумма позиций может быть **больше** — например покупка на 1 000 000,
100 000 закрыто баллами, к оплате 900 000.

- `rd.sum <= 0` → возврат пустого результата + warning (фискализация
  не нужна, ОФД не примет нулевой чек).
- `rd.sum < positionsSum` → **скейлим позиции пропорционально** до подбора:
  `pos.totalTiyin × (rd.sum / positionsSum)`. Matcher работает уже со
  скейленными позициями.

### Авто-определение оплаты (cash/card/QR/mixed)

Поля МС: `cashSum`, `noCashSum`, `qrSum`. В fiscalize.ts функция
`determinePaymentFromMs` смотрит соотношение и заполняет
`receivedCash` / `receivedCard` пропорционально matchedTotal:

- только cash → `receivedCash = matchedTotal`
- только card/qr → `receivedCard = matchedTotal`
- mixed → пропорциональный split от `cash:(card+qr)`.

В UI Receipt.tsx — бейдж типа оплаты с суммами.

## Click/Payme — частичная фискализация

Магазин в РУз часто принимает оплату через **Click / Payme / Apelsin** —
эти электронные платежи **НЕ фискализируются** через ОФД (магазин ведёт
их отдельно, обычно на упрощёнке или через другое юр.лицо). Нужен
механизм исключить такую сумму из фискального чека.

### Семантика

Кассир в Receipt.tsx видит мини-карточку «Сумма через Click/Payme» с
input-полем. Вводит сумму электронной оплаты — matcher пересобирает
план на оставшуюся (rd.sum − exclude), фискальный чек уходит в ОФД
только на эту меньшую сумму.

Пример: МС-чек 300 000 (150к нал + 150к Click) → кассир вводит 150 000
в поле → фискальный чек = 150 000 нал → ОФД получает 150 000.

### Flow

```
Receipt.tsx
  ├─ excludeTiyin state (default 0)
  ├─ input + debounced 400ms → load() → buildMatch
  │
  ▼  opts.targetSumOverrideTiyin = rd.sum − excludeTiyin
matcher/index.ts::buildMatch
  ├─ effectiveTarget = override ?? receipt.sum
  ├─ scaling позиций пропорционально к effectiveTarget
  ├─ holistic.planHolistic(effectiveTarget, ...) — если fallback нужен
  ├─ distributeDiscount/Bump → targetSum = effectiveTarget
  ▼  matchedTotal ≈ effectiveTarget
fiscalize() opts.excludePaymentTiyin
  ├─ determinePaymentFromMs(rd, matchedTotal, excludePayment):
  │    cash = rd.cashSum (как есть)
  │    effectiveCard = max(0, rd.noCashSum + rd.qrSum − excludePayment)
  │    total = cash + effectiveCard
  │    receivedCash/Card = пропорция от matchedTotal по этому split
  │
  ├─ Api.SendSaleReceipt → ОФД (только фискальная часть)
  ▼
fiscal_receipts INSERT:
  excluded_payment_tiyin = excludePayment  ← для аудита/отчётов
  card_kind                                 ← (если карта была)
```

### Граничные случаи

| Кейс | Поведение |
|---|---|
| `exclude = 0` | Всё как раньше, override не передаётся в matcher |
| `0 < exclude < rd.sum` | Фискальный чек на (rd.sum − exclude). Кнопка «Фискализировать» |
| `exclude >= rd.sum` | Effective = 0. Кнопка меняется на **«Отметить как не фискальный»** → `ms_receipts.status='not_required'`, ОФД ничего не получает |
| `exclude > noCashSum + qrSum` | Предупреждение в UI: «больше безналичной части МС». Не блок — кассир знает что делает. effectiveCard кэпится на 0 |
| `exclude < 0` или `> rd.sum` | Игнорируется (input заклампован; override в matcher тоже отбрасывается) |

### Refund / reprint

- **Refund** работает с **фискальным** итогом (150к), не с МС (300к).
  Excluded часть Click возвращается через кабинет Click — **вне нашего флоу**.
- **Reprint копии** из Истории — берёт сумму из `request_json`
  (это 150к, что ушло в ОФД). Никаких пересчётов.
- **excluded_payment_tiyin** хранится в БД для отчётов «сколько было
  Click/Payme за день/месяц» (отчёты в Phase 2, поле уже сохраняется).

### Юр.аспект

МС-чек 300к, фискальный 150к → расхождение видно при сверке. Магазин
принимает риск перед ГНК. Та же серая зона как и подмена ИКПУ. Юзер
дал на это согласие, программа — инструмент.

### Файлы

- `src/lib/matcher/types.ts` — `MatcherOptions.targetSumOverrideTiyin`
- `src/lib/matcher/index.ts` — `effectiveTarget` в `buildMatch` +
  `recalculateAfterSwap` / `rebuildPositionWithSplit` / `replacePositionManual`
- `src/lib/epos/fiscalize.ts` — `FiscalizeOptions.excludePaymentTiyin`,
  `determinePaymentFromMs` с третьим параметром
- `src/lib/db/types.ts` — `FiscalReceiptRow.excluded_payment_tiyin`,
  `MsReceiptStatus` += `'not_required'`
- `src/lib/db/fiscal-receipts.ts` — INSERT с новой колонкой
- `src/routes/Receipt.tsx` — input UI + `markNotRequired()` handler
- `src-tauri/migrations/010_fiscal_receipts_excluded_payment.sql` — ALTER ADD COLUMN

## Телеметрия — error-логи на mytoolbox

С 0.10.31 шлём `level='error'` логи на сервер для централизованного
debugging'а 4 магазинов. Админ видит ошибки всех в одной admin-панели
mytoolbox без подключения к каждой Win-машине отдельно. Critical-ошибки
типа `🚨 refund в ОФД но не сохранён локально` → Telegram-алерт сразу.

### Что шлётся

- `level='error'` (включая помеченные как CRITICAL — это всё ещё error
  по уровню, но с маркером 🚨 в message)
- info/debug/warn остаются **локально** в `logs` таблице SQLite
- ПД клиента (`pinfl`, `tin`, телефон, email) предварительно убираются
  `scrubText` через regex-замену

### Архитектура

```
log.error(...) → INSERT logs (sent_to_server=0)
                       │
                       ▼  раз в 30 сек
              src/lib/telemetry.ts::flushLogsToServer
                       │
                       ├─ listUnsentLogsForServer(limit=50)
                       ├─ scrubText(message) + scrubText(details)
                       ├─ POST /api/v1/inventory/telemetry/logs
                       │     Bearer <InventoryShopApiKey>
                       │     { shop_slug, app_version, logs: [...] }
                       ├─ 200 OK → markLogsSentToServer(ids)
                       ├─ 404 → markSent (endpoint не задеплоен — не циклимся)
                       └─ 5xx/network → exp backoff (1/2, 1/4, ... шанс на следующий тик)
                       ▼
              mytoolbox.shop_logs (TTL 90 дней)
                       │
                       ▼
              admin UI + Telegram-бот на CRITICAL
```

### Серверный контракт (для mytoolbox-репо)

**Endpoint:** `POST /api/v1/inventory/telemetry/logs`

**Auth:** `Authorization: Bearer <api_key>` — тот же что для inventory.

**Request body:**
```json
{
  "shop_slug": "toolbox-honabod",
  "app_version": "0.10.31",
  "logs": [
    {
      "ts": 1735056000,
      "level": "error",
      "source": "refund",
      "message": "🚨 КРИТИЧНО: refund в ОФД (FiscalSign=ABC123) ...",
      "details": "{\"fiscal\":{...},\"originalFiscalId\":42}",
      "local_log_id": 1234
    }
  ]
}
```

**Response:** `{ "ok": true }` на success. Body не обязателен для клиента —
Tauri проверяет только status 2xx.

**Серверная таблица (примерная схема):**
```sql
CREATE TABLE shop_logs (
  id              BIGSERIAL PRIMARY KEY,
  shop_id         INT NOT NULL REFERENCES inv_shops(id),
  ts              TIMESTAMP NOT NULL,
  level           VARCHAR(10) NOT NULL,
  source          VARCHAR(50) NOT NULL,
  message         TEXT NOT NULL,
  details         JSONB,
  app_version     VARCHAR(20),
  local_log_id    INT, -- для дедупа + трассировки
  received_at     TIMESTAMP DEFAULT NOW(),

  UNIQUE (shop_id, local_log_id)  -- дедуп при retry клиента
);
CREATE INDEX idx_shop_logs_ts ON shop_logs(ts DESC);
CREATE INDEX idx_shop_logs_critical ON shop_logs(received_at)
  WHERE message LIKE '%🚨%' OR message LIKE '%КРИТИЧНО%';
```

**TTL:** удалять `received_at < NOW() - 90 days` (job раз в день).

**Telegram-бот** слушает `INSERT` через triggers/notify где message
содержит `🚨` или `КРИТИЧНО` → шлёт в чат админа. Spam-protection:
дедуп по message-fingerprint не чаще 1/час.

**Дедуп:** на сервере `UNIQUE(shop_id, local_log_id)` — повторный
POST одного и того же лога (например после ретрая при network glitch)
не создаст дубликат.

### Opt-out

`SettingKey.TelemetryEnabled` (default 'true'). Магазин может выключить
через Настройки → секция «Inventory» → «Отправлять ошибки на сервер
для анализа». Tauri-клиент мгновенно остановит flush на следующем тике
(не сразу — настройка читается каждый цикл).

### Файлы

- `src-tauri/migrations/011_logs_telemetry.sql` — ALTER TABLE logs ADD COLUMN sent_to_server
- `src/lib/log.ts` — `listUnsentLogsForServer`, `markLogsSentToServer`
- `src/lib/telemetry.ts` — главный модуль, flusher, scrubText, ensureTelemetryStarted
- `src/lib/db/types.ts` — `SettingKey.TelemetryEnabled`
- `src/routes/Settings.tsx` — selector «Отправлять ошибки на сервер»
- `src/App.tsx` — `ensureTelemetryStarted()` в useEffect

## Тестовый режим (`SettingKey.TestMode`)

Флаг в Настройках. Если включён — fiscalize.ts:
- НЕ дёргает Communicator
- НЕ пишет в `fiscal_receipts` реальный TerminalID/FiscalSign
- Печатает чек на термопринтер с шапкой **«ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК»**

Цель — проверить подбор + раскладку по позициям без реальной отправки
в ОФД (карта USB в этот момент может ещё не быть подключена). По
дефолту флаг сбрасывается в false при чистой установке.

## Печать чека (Xprinter XP-80 USB)

Подсистема в `src-tauri/src/printer.rs` + JS-обёртка `src/lib/printer/`.

### Технические детали

- **Crate `printers`** — обёртка над winspool на Win, CUPS на Mac/Linux.
- **На Win — raw_properties = `{}` (пустой)**. winspool ожидает «RAW»
  сам по себе и валится с `StartDocPrinterW failed` если передать ему
  `application/vnd.cups-raw`. Поэтому `cfg(windows)` ветка пустая.
- **Кодировка кириллицы — CP866 (DOS Cyrillic)**. На Xprinter код 17.
  Конвертация через `encoding_rs::IBM866`. Пробовали WCP1251 (код 46) —
  на этой модели маппится на греческий/математические символы.
- **ESC/POS** — посылаем raw байты: cut, размер шрифта, выравнивание,
  и **native QR через `GS ( k`** (без рендера PNG).

### Когда печатается

После успешной фискализации (или сразу в тестовом режиме). Печать
«fire-and-forget» — ошибка принтера не ломает фискализацию (в логах).

### Что показывает

- Реквизиты компании / магазина / кассира (из Settings)
- Дата+время фискализации
- Список позиций: имя, ИКПУ, qty, цена, **скидка отдельной строкой
  («Skidka:»)** если distributeDiscount/Bump применили, итого позиции
- ИТОГО, тип оплаты, сумма НДС
- TerminalID / ReceiptSeq / FiscalSign
- QR-код на ОФД-сайт (https://ofd.soliq.uz/...)

В тестовом режиме вместо TerminalID/FiscalSign — заглушка.

## Z-отчёт ККМ

Раздел «Смена» (роут `/zreport`, пункт «Смена» в сайдбаре с иконкой
`ClipboardList`). UI повторяет E-POS Cashdesk: 2×2 сетка (инфо смены /
чеки / продажи / возвраты) + большая кнопка «Закрыть смену» + иконка
принтера для X-отчёта. Auto-refresh каждые 30 сек.

### Архитектура: данные от Communicator, печать сами

Communicator JSON-RPC даёт **только данные** (`Api.GetZReportInfo`,
`Api.OpenZReport`, `Api.CloseZReport`). Метода печати X/Z **нет** —
проверено curl'ом 4 кандидатов, см. Pitfalls.

Поэтому:
- **Данные**: `JsonRpcEposClient.getZReportInfo()` → `JsonRpcZReportInfo`
  с тоталами (TotalSaleCount/Cash/Card/VAT, TotalRefundCount/..., FirstReceiptSeq,
  LastReceiptSeq, OpenTime, CloseTime, TerminalID, Number).
- **Печать**: своя Rust-команда `print_z_report` в `src-tauri/src/printer.rs`
  — формирует ESC/POS байты по тому же шаблону что бумажный X-отчёт от
  E-POS Cashdesk (CHEKLAR / TO'LOVLAR / QAYTARUVLAR / JAMI блоки), пишет
  кириллицу в CP866 как и чек.

### Открытие смены: guard от двойного открытия

`openShift()` сначала зовёт `getZReportInfo()`. Если ответ есть и `CloseTime
=== ''` → смена уже открыта, просто обновляем UI и выходим **без** вызова
`openZReport`. Это решает кейс когда первый `getZReportInfo` упал по timeout,
UI показал «Смена не открыта», юзер нажал «Открыть» → Communicator справедливо
ругается что смена и так открыта (с пустым `message`, см. формат ошибок ниже).

### Retry в `refresh()`

Communicator иногда занят отправкой чека в ОФД и отвечает timeout. До 3
попыток с exp backoff (300ms → 900ms). Если упасть с первой — юзер увидел
бы пустой стейт и нажал бы «Открыть», что только запутало бы всё.

### Auto-print Z при закрытии смены

После успешного `closeZReport` тихо вызывается `printReport(true)`. Если
печать упала (нет принтера, оффлайн) — пишем warn в логи, **не** ломаем
закрытие. Смена уже закрыта в ОФД, это главное.

### Формат ошибок Communicator

JSON-RPC Communicator иногда возвращает `code/data` без `message`. Поэтому
в `formatEposError()` мы аккумулируем всё что есть: `message · code=N ·
data=<json>`. Иначе в UI выводилось бы пустое «Не удалось закрыть смену:».

### В нашем коде

- `src/routes/Zreport.tsx` — UI, refresh, openShift с guard'ом, closeShift с auto-print
- `src/lib/printer/index.ts` — `printZReport(printerName, data)` + `ZReportPrintData` интерфейс (mirror Rust-структуры)
- `src-tauri/src/printer.rs` — `print_z_report` Tauri-команда + `build_z_report` (ESC/POS байты) + struct `ZReportPrintData`
- `src/lib/epos/jsonrpc-client.ts` — `getZReportInfo()`, `openZReport()`, `closeZReport()` + интерфейс `JsonRpcZReportInfo`

## Возвраты (refund) — full feature

Кассир из Чеков → клик «Возврат» на ранее фискализированном чеке →
`/refund/:fiscalReceiptId` → `processRefund()` отправляет `Api.SendRefundReceipt`
в Communicator → ОФД и пишет `fiscal_refunds`.

### Привязка к оригиналу — **критично** для ОФД

Communicator/ОФД требует блок `refundInfo` в payload с ссылкой на оригинал.
Без правильной привязки refund попадает в soliq.uz как «Бириктирилмаган»
(не привязан к продажному чеку).

```ts
const refundReceipt = {
  Time: formatGoTime(new Date()),
  Items: originalReceipt.Items,    // 1-в-1 как ушло в ОФД при продаже
  ReceivedCash: refundCash,
  ReceivedCard: refundCard,
  RefundInfo: refundInfo,          // PascalCase — на всякий случай
  refundInfo,                      // camelCase — ОСНОВНОЙ по доке E-POS
}
```

**2 правила** (нашли эмпирически после провала первой версии):
1. **Имя поля — `refundInfo` (camelCase).** Шлём оба варианта (как с `spic` —
   belt & suspenders). PascalCase `RefundInfo` Communicator игнорирует.
2. **`dateTime` — строго 14 цифр `YYYYMMDDHHMMSS`.** Helper
   `toRefundDateTime()` нормализует любой формат (Go-style «2026-05-16
   09:54:18», ISO с мс, уже 14 цифр) выкидывая нецифры и беря первые 14.

### Идемпотентность + защита

- `fiscal_refunds.original_fiscal_id` **UNIQUE** — один продажный чек =
  один refund. Повторный клик «Возврат» получает `RefundAlreadyExistsError`.
- При успехе: INSERT `fiscal_refunds` + POST `/api/v1/inventory/unconsume`
  на сервер (возврат остатка в пул) → SSE-broadcast другим магазинам.
- `/unconsume` идемпотентен по `refund_fiscal_sign` (сервер проверяет
  `inv_events` на наличие события `unconsumed` с этим признаком).
- Если `/unconsume` упал (сеть/404) → строки кладутся в
  `inv_pending_confirms` с `op_type='unconsume'`, `retryUnconsumePending()`
  добивает на старте app + периодике, реконструируя items из
  `fiscal_refunds→fiscal_receipts→match_items→server_item_id`.

### Печать refund-чека

Шапка **«QAYTARUV / ВОЗВРАТ ТОВАРА»** (двойная высота+ширина, жирная),
подзаголовок «По чеку №ABC от 14.05.2026», `Chek turi: Qaytaruv`,
footer без кешбэка («Tovar qaytarildi. Pul mijozga to'liq qaytarildi.»).

### UI

- Чеки (`/history`) — колонка «Возврат»: кнопка `/refund/:id` или бейдж
  «Возвращён» (если уже был, см. `getRefundedFiscalIds` bulk-проверка).
- `/refund/:id` показывает **3 секции**: оригинальные позиции МС
  (что покупатель купил, до подмены ИКПУ — через `extractPositions`
  из `ms_receipts.raw_json`), фискальные позиции (что ушло в ОФД),
  поля возврата денег (cash/card pre-fill = как было оплачено).
- Тестовый режим: refund НЕ уходит в ОФД, печатается «ТЕСТ — ВОЗВРАТ».

### Файлы

- `src-tauri/migrations/008_refunds.sql` — `fiscal_refunds` + колонка
  `op_type` в `inv_pending_confirms` (`confirm`/`unconsume`).
- `src/lib/db/fiscal-refunds.ts` — DAO (`insertFiscalRefund`,
  `getRefundByOriginalFiscalId`, `getRefundedFiscalIds`).
- `src/lib/epos/refund.ts` — `processRefund()`, `toRefundDateTime()`,
  `getDefaultRefundAmounts()`, `RefundAlreadyExistsError`.
- `src/lib/epos/jsonrpc-client.ts` — `JsonRpcRefundInfo` + `RefundInfo` в
  `JsonRpcReceipt` (плюс camelCase alias в payload).
- `src/lib/inventory/{server-client,types}.ts` — `unconsume()` + типы.
- `src/lib/inventory/retry.ts` — `retryUnconsumePending()`.
- `src/routes/Refund.tsx` — UI.
- Backend `mytoolbox`:
  - `backend/src/services/inventory/reservations.js::unconsume()` —
    атомарная функция (`BEGIN→FOR UPDATE→qty_consumed-=qty→inv_events→COMMIT`),
    идемпотентность по `refund_fiscal_sign` через `inv_events`.
  - `backend/src/routes/inventory.js::shopRouter.post('/unconsume')`.

## Sync приходов: сервер = источник правды

`esf_items` — **зеркало** серверного `inv_items` (mytoolbox Postgres).
Локально только read-cache, реальные reserve/confirm/release/unconsume
идут на сервер атомарно с FOR UPDATE.

### `syncFromServer({ forceFull?: true })`

При `forceFull` тянем ПОЛНЫЙ снимок сервера и **reconcile**:
- Собираем все увиденные `server_item_id` в Set.
- `reconcileDeletedItems()`: локальные строки `source='remote'` которых
  нет в Set — кандидаты на удаление.
- **С историей фискализаций** (FK `match_items`): не удаляем физически
  (PG/SQLite кинул бы FK violation, sync упал бы). Soft-void:
  `qty_received := qty_consumed` (available=0) + пометка в notes.
  Matcher фильтрует `available ≥ 1000` → товар-призрак не попадает в
  подбор, аудит цел.
- **Без истории**: физический `DELETE` чанками по 500.
- Reconcile **только при forceFull** (полный снимок). Delta-sync с
  `updated_since` не знает про удаления — для него reconcile отключён.
- Safety: если pull оборвался → `throw` ДО reconcile (incomplete set
  не двинет удаления).

### Когда вызывается forceFull

- `runInventoryHousekeeping()` на **старте app** — кэш самозалечивается
  даже если sync вообще не было между запусками.
- **Periodic timer** (раз в N мин) — тоже forceFull (бандвидс не критичен
  для ≤5000 строк раз в N мин, корректность важнее).
- **Открытие Catalog** (`/catalog`) — Справочник всегда показывает
  актуальный серверный пул, не застрявший кэш.
- Кнопка «🔄 Обновить с сервера» в Справочнике (manual trigger).

### SSE (real-time updates)

`subscribeToInventoryEvents` подписывается на `/api/v1/inventory/events`,
получает `inv.items.updated` с массивом `{id, available}` → `applyItemsUpdate`
делает UPDATE qty_received локально. SSE НЕ удаляет — для удалений нужен
forceFull reconcile (см. выше).

## Атомарность/идемпотентность склада

### Server-side (mytoolbox Postgres) — крепкая

| Операция | Атомарность | Идемпотентность |
|---|---|---|
| `reserve` | BEGIN→`SELECT FOR UPDATE` (ORDER BY id — анти-deadlock)→COMMIT | по `(shop_id, ms_receipt_id)` → `idempotent_replay: true` |
| `confirm` | BEGIN+FOR UPDATE | по статусу резервации: `confirmed`→replay, `released`/`expired`→коды |
| `release / extend / expireStale` | BEGIN+FOR UPDATE | ✓ |
| `unconsume` | BEGIN→FOR UPDATE→`qty_consumed -= qty`→inv_events→COMMIT | по `refund_fiscal_sign` через `inv_events.meta` |
| `bulkImport` | SAVEPOINT per-row | dedup 6-key (org+class+name+date+source_doc+price) |
| `createItem` (ручной ввод) | BEGIN/COMMIT | dedup 6-key |

**DB-инварианты `inv_items`** (физически нельзя нарушить):
```sql
CHECK (qty_consumed + qty_reserved <= qty_received)
CHECK (qty_received/consumed/reserved >= 0)
```

### Local-side (epos_fiscal SQLite) — best-effort

- `tauri-plugin-sql` имеет известный pitfall: `BEGIN/COMMIT` через
  `db.execute` ненадёжен (разные коннекшены). Поэтому локальные
  операции не транзакционные, но **идемпотентные**: повторный прогон
  сходится к тому же состоянию.
- `reconcileDeletedItems` — не транзакционный (несколько `db.execute`),
  но запускается только на полном снимке → consistency over time.

### Граница Communicator — не ACID (by design)

`Communicator OK → INSERT fiscal_receipts/refunds`. Если INSERT упал
после успеха Communicator → чек в ОФД, локально нет. Защита:
`fiscal_refunds.original_fiscal_id UNIQUE` + `fiscal_receipts.fiscal_sign
UNIQUE`. Стандартная distributed-проблема, та же что у sale, митигируется
UNIQUE + ручная сверка.

## Защиты фискализации (error classes)

Все экспортятся из `@/lib/epos`. UI ловит и показывает понятные баннеры
вместо сырых ошибок.

| Класс | Когда | Что UI делает |
|---|---|---|
| `AlreadyFiscalizedError(fiscalSign, receiptSeq)` | `getFiscalReceiptByMsId()` нашёл существующий → защита от двойной фискализации. Бросается в Receipt.tsx UI dispatch + defense-in-depth в `fiscalize()` | Кнопка «Уже фискализирован» (disabled) + красный баннер с FiscalSign и ссылками «В Историю» / «Оформить возврат» |
| `ShiftNotOpenError()` | Communicator вернул `ERROR_ZREPORT_IS_NOT_OPEN` (code 36909) или текст содержит ZREPORT_IS_NOT_OPEN — detect в catch `fiscalizeJsonRpc` | Жёлтый баннер «Смена ККМ не открыта» + кнопка «Перейти в Смену» |
| `RefundAlreadyExistsError(existing)` | На `original_fiscal_id` уже есть `fiscal_refunds` | Баннер «Этот чек уже возвращён DD.MM, FiscalSign…» + поля disabled |
| `InventoryConflictError(failed)` | Server `/reserve` вернул 409 INSUFFICIENT_STOCK | Toast «товар закончился» + auto-rematch с excluded server_ids |
| `InventoryNotConfiguredError` | Нет `serverUrl`/`apiKey` в Settings | Сообщение «Откройте Настройки и подключитесь» |
| `ManualPickOutcome.reason='below_cost'` (не Error, дискриминированный return) | `replacePositionManual` — `costWithVat > pos.totalTiyin` | Toast «себестоимость X выше суммы Y, нельзя в убыток» + в модалке строка серая с бейджем «убыток» |

## Релизы и Auto-update

```
git push origin main
git tag v0.X.Y
git push origin v0.X.Y
   │
   ▼ ~7–10 мин
GitHub Actions (Win + Mac параллельно; Linux отключён ради скорости)
   │
   ▼
Подписанный релиз в Releases (releaseDraft: false)
   │
   ▼
latest.json с подписями
   │
   ▼
При следующем запуске на Win: silent download + install + relaunch
```

### Ключи подписи
- `~/.tauri/epos-fiscal.key` — приватный (НЕ КОММИТИТЬ).
- Public key вшит в `tauri.conf.json`.
- Содержимое приватного — в GitHub Secret `TAURI_SIGNING_PRIVATE_KEY`.

### Авто-публикация
В `release.yml`: `releaseDraft: false`. Каждый push тега = публичный
релиз без ручного клика «Publish».

### Авто-применение на клиенте
В `App.tsx` → `autoApplyOnStartup()`. Без диалогов, тихо. Окно дёргается
один раз — версия другая.

## Capabilities Tauri

`src-tauri/capabilities/default.json` — принцип: **localhost broad, HTTPS точечно**.

Сейчас разрешено:
- `http://localhost:*` (любой порт — Communicator может быть на 8347/3448)
- `http://127.0.0.1:*`
- `http://192.168.*:*` / `http://10.*:*` (LAN, если Communicator на другом ПК)
- `https://api.moysklad.ru/*` (МойСклад API)
- `https://backend-production-c3d4.up.railway.app/*` (mytoolbox inventory API)

**Почему так:**
- Localhost+LAN broad **по портам** (не по конкретным `:8347`/`:3448`) — потому что
  раньше был баг: жёсткий whitelist портов **молча блочил** запросы к новым портам
  Communicator без понятных ошибок. Любой порт на localhost безопасен (доступ к
  localhost требует уже быть на машине).
- HTTPS — **точечно по доменам**, НЕ `https://*`. Иначе при XSS из ms-данных или
  supply-chain атаке на пакет атакующий сможет сливать ИКПУ/фискальные данные на
  свой домен. Точечный whitelist — defense-in-depth.

**При добавлении нового внешнего HTTPS-сервиса** — добавляй конкретный домен,
не `*`. Если для Communicator появится новый порт — он автоматически разрешён.

## Команды разработки

```bash
# Локальный запуск (Mac/Win с установленным Rust+Node):
npm run dev

# Только typecheck:
npx tsc -b --noEmit

# Только cargo check:
cd src-tauri && cargo check

# Production-сборка локально:
npm run build

# Поднять Win-окружение из чистой Win-машины:
# В PowerShell:
irm https://raw.githubusercontent.com/toolboxbuxoro-web/epos_fiscal/main/scripts/setup-windows.ps1 | iex
```

## Структура файлов (важные)

```
src-tauri/
  Cargo.toml              ← features: tauri-plugin-http["gzip"], printers
  tauri.conf.json         ← bundle.createUpdaterArtifacts: true (для подписи)
  capabilities/default.json ← localhost broad, HTTPS точечно
  src/
    printer.rs            ← raw ESC/POS + CP866 + native QR (GS ( k)
                            + build_receipt + build_z_report (X/Z layout)
    lib.rs                ← Tauri handlers: print_test_qr / print_fiscal_receipt
                            / print_z_report / list_printers + migrations
  migrations/
    001_initial.sql       ← 7 таблиц (settings, esf_items, ms_receipts, ...)
    002_logs.sql          ← логи диагностики
    003_inventory_sync.sql ← inventory remote-конфиг (mytoolbox) + inv_pending_confirms
    004_drop_legacy_items.sql ← очистка legacy excel_items таблицы
    005_drop_legacy_epos_url.sql ← сброс старого uzpos URL
    006_revert_legacy_url.sql ← (откат после прерывания 0.10.8)
    007_force_jsonrpc_url.sql ← форсим http://localhost:3448/rpc/api
    008_refunds.sql       ← fiscal_refunds (UNIQUE original_fiscal_id) +
                            колонка op_type в inv_pending_confirms (confirm/unconsume)
    009_fiscal_receipts_card_kind.sql ← + card_kind ('fiz'|'corp'|NULL) для
                                          печати «Karta turi» на refund/reprint
    010_fiscal_receipts_excluded_payment.sql ← + excluded_payment_tiyin
                            (тийины Click/Payme, не пошедшие в ОФД, для аудита)
src/
  lib/
    db/                   ← SQLite, типы и DAO (SettingKey enum)
      fiscal-refunds.ts   ← DAO refund-чеков (insert/getByOriginal/listRefunded)
    moysklad/
      variants-cache.ts   ← LRU+TTL5min для МС-модификаций (linked-ms enrichment)
    esf/                  ← Excel импорт с автомаппингом колонок
    matcher/
      extract.ts          ← service-фильтр + нормализация + readLinkedBuhName
                            из characteristics И attributes (для linked-ms)
      strategies.ts       ← 4 стратегии (linked-ms first!) + pricing +
                            cost-with-VAT + НДС override в loadMatcherPool +
                            reconcile-фильтры (ИКПУ обязателен, package_code НЕТ)
      index.ts            ← buildMatch + distributeDiscount + distributeBump
                            (separate maxBumpPerItemTiyin cap) +
                            replacePositionManual (ManualPickOutcome) +
                            recalculateAfterSwap + rebuildPositionWithSplit
      search.ts           ← in-memory search для manual picker (substring +
                            AND-токены + score, ИКПУ exact 14-17 digits)
      types.ts            ← MatchCandidate + MatcherOptions +
                            ManualPickOutcome (discriminated) + maxBumpPerItemTiyin
    epos/
      jsonrpc-client.ts   ← /rpc/api + formatGoTime + JsonRpcZReportInfo +
                            JsonRpcRefundInfo (camelCase в payload!)
                            методы: SendSaleReceipt, SendRefundReceipt,
                            OpenZReport, CloseZReport, GetZReportInfo, ...
      fiscalize.ts        ← главный flow + payment split + spic поле +
                            AlreadyFiscalizedError + ShiftNotOpenError +
                            InventoryConflictError + InventoryNotConfiguredError
      refund.ts           ← processRefund + toRefundDateTime + queueUnconsumePending +
                            RefundAlreadyExistsError + печать «ВОЗВРАТ»
    inventory/
      server-client.ts    ← reserve/confirm/release/extend/unconsume/listItems
      sync.ts             ← syncFromServer(forceFull) + reconcileDeletedItems
      retry.ts            ← retryFiscalOkPending + retryUnconsumePending +
                            runInventoryHousekeeping
      pending-confirms.ts ← DAO (op_type='confirm'|'unconsume', listFiscalOk
                            фильтрует op_type='confirm')
      sse.ts              ← live updates (только qty, удаления через reconcile)
    printer/              ← JS-обёртка: printFiscalReceipt + printZReport
                            (ReceiptData теперь имеет is_refund + original_receipt_ref)
    log.ts                ← запись в logs таблицу (LogSource: + 'refund')
    updater.ts            ← autoApplyOnStartup
  routes/                 ← 8 экранов:
                            Dashboard / Receipt / Refund (NEW) / Zreport /
                            History / Catalog / Logs / Settings
    Receipt/
      ManualPickerModal.tsx ← модалка manual picker (поиск, фильтр цены,
                              блок строк с убытком)
  components/
    Layout.tsx            ← sidebar: 6 пунктов (Касса/Смена/Чеки/Справочник/
                            Настройки/Логи) — пункт «Смена» с ClipboardList
                            (Refund доступен через Чеки → клик «Возврат»)
docs/
  external-apis/
    universal-communicator.md  ← Communicator API (JSON-RPC + legacy историч.)
    epos-mobile-api.md         ← E-POS Mobile API snapshot (источник `spic`)
    fiscal-drive-service.md    ← FiscalDriveService (alt путь на :3449/rpc)
.github/workflows/release.yml  ← CI: Win+Mac (без Linux), releaseDraft:false
```

**Примечание про legacy:** `src/lib/epos/client.ts` (legacy /uzpos клиент)
был удалён в 0.10.13 после подтверждения что `spic` работает через JSON-RPC.
В коде остался только `jsonrpc-client.ts`.

## Чек-лист первого запуска у магазина

1. На Win-машине запустить: `irm https://raw.githubusercontent.com/toolboxbuxoro-web/epos_fiscal/main/scripts/setup-windows.ps1 | iex` (если разработка) или скачать `.exe` из GitHub Releases.
2. Установить EPOS Cashdesk + USB-фискальный модуль (если ещё нет — это E-POS делает).
3. Открыть Toolbox Fiscal → Настройки:
   - Логин/пароль МойСклад → Войти
   - Точка продаж: выбрать конкретный магазин
   - Кассир: выбрать ФИО (для печати)
   - EPOS URL: `http://localhost:3448/rpc/api`
   - Реквизиты компании
   - Принтер чеков (опционально, default — системный)
   - Markup % / округление (default 10% / 1000 сум)
   - Скидка для точной суммы (default ВКЛ, max 2000 сум)
   - **Тестовый режим: ВКЛ** на первое время — чтобы проверить подбор без отправки в ОФД
4. Справочник → Импорт Excel с приходами от бухгалтерии.
5. **Смена** → «Открыть смену» (запускает X-отчёт в Communicator). Без открытой смены фискализация не работает.
6. Касса — приходят чеки из МС. Открыть чек → проверить подбор → Фискализировать.
7. В конце рабочего дня: **Смена** → «Закрыть смену». Z-отчёт автоматически уходит в ОФД и печатается на термопринтере.
8. Когда тест прошёл успешно (печать корректна, суммы совпадают) — выключить тестовый режим в Настройках. Дальше всё уходит в ОФД реально.

## Известные подводные камни

| Симптом | Причина | Решение |
|---|---|---|
| HTTP 415 на `/security/token` | Нет `Accept-Encoding: gzip` | Включена feature `gzip` в reqwest, не трогать |
| HTTP 400 на `/security/token` | Tauri http странно шлёт POST body | Используем Basic Auth напрямую на каждый запрос |
| `Body is disturbed or locked` | Двойной `res.json()` после fail `res.text()` | Читаем `text()` один раз, потом `JSON.parse` |
| `NO_SUCH_METHOD_AVAILABLE` на `/uzpos` | На Communicator 3.20+ legacy урезан | Использовать только JSON-RPC `http://localhost:3448/rpc/api` (legacy удалён в 0.10.13) |
| MXIK = "0" в чеке ОФД, «MXIK kodi xato» | Поле в payload называется неправильно (`classCode`, `Mxik` etc) | Шлём `spic` (camelCase). Подтверждено на TerminalID VG343420011189 |
| Communicator не отвечает в Tauri, но curl работает | Capability blocking порта | Не сужать `http:default` allow |
| Receipt позиции пустые | МС в list-запросе не возвращает inline rows | Lazy-load в Receipt.tsx через GET одиночный |
| Auto-update «Could not fetch latest.json» | Репо приватный или нет `latest.json` | Сделать репо public + `bundle.createUpdaterArtifacts: true` |
| `StartDocPrinterW failed` на Win | Передавали `vnd.cups-raw` mime в winspool | `raw_properties = {}` через `cfg(windows)` |
| Кириллица иероглифами на Xprinter | Кодировка WCP1251 (код 46) → греческий/мат | CP866 (код 17) + `encoding_rs::IBM866` |
| Communicator-сервер на Go отвергает `T` в дате | Парсит `time.Parse("2006-01-02 15:04:05", ...)` | `formatGoTime(d)` — пробел вместо T |
| `BEGIN`/`COMMIT` через `db.execute` не работает | tauri-plugin-sql использует разные коннекшены | Manual cleanup в catch-блоке |
| matched < target = -1000 на чеке | price-bucket писал `best.sellingPrice` вместо `pos.totalTiyin` | Фикс в strategies.ts + `distributeBump` для остатка |
| Тестовый режим выключал печать | Возврат до `maybePrintReceipt` | Печатать с `is_test=true`, шапка «ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК» |
| `discountForExactSum` дефолт не применялся | `null === 'true'` = false для never-saved setting | `discRaw == null ? true : discRaw === 'true'` |
| matched=789, rd.sum=790, услуги=0 | МС-позиция «service» (имя кассира) ломала подбор | Фильтр `assortment.meta.type === 'service'` в `extractPositions` |
| `Api.PrintXReport` / `PrintZReport` / `PrintCurrentZReport` / `PrintZReportInfo` = NO_SUCH_METHOD | Communicator JSON-RPC API не умеет печатать X/Z | Печатаем сами через `print_z_report` (ESC/POS) — Rust+printer.rs |
| «Не удалось открыть смену» с пустым сообщением | Communicator вернул JSON-RPC error без `message`, только `code/data`; смена уже была открыта | В `openShift()` сначала `getZReportInfo()` — если `CloseTime===''`, просто обновляем UI. `formatEposError()` показывает `code+data` если `message` пуст |
| `getZReportInfo` рандомные timeout-ы | Communicator занят отправкой чека в ОФД | Retry до 3 раз с exp backoff (300→900ms) в `refresh()` Zreport.tsx |
| «Не настроен принтер чеков» при печати Z | `SettingKey.PrinterName` пустой | Настройки → Печать чека → выбрать принтер |
| Refund в soliq.uz попадает в «Бириктирилмаган» (не привязан к оригиналу) | (а) поле было `RefundInfo` PascalCase — Communicator игнорил; (б) `dateTime` не нормализован к 14 цифрам | Шлём ОБА варианта (`refundInfo` + `RefundInfo`); `toRefundDateTime()` нормализует к 14 цифрам YYYYMMDDHHMMSS |
| Товары без ИКПУ блокировали фискализацию даже когда не были выбраны | Pool возвращал «призраков» без ИКПУ → multi-item их подбирал → guard в fiscalize блокировал чек | `loadMatcherPool` фильтрует `!class_code`; package_code НЕ фильтруем (опционален по mobile-api) |
| После TRUNCATE/удаления приходов на сервере локальный кэш показывал призраков навсегда | Delta-sync только upsert'ил, никогда не удалял | `syncFromServer({forceFull:true})` теперь reconcile: удаляет orphans, soft-void для строк с FK-историей. Bootstrap + periodic + открытие Catalog — все forceFull |
| Существующий `retryFiscalOkPending` хватал unconsume-строки и слал как confirm | `listFiscalOk` не фильтровал по op_type | `listFiscalOk` теперь `WHERE op_type='confirm' OR op_type IS NULL`; `retryUnconsumePending` отдельно обрабатывает unconsume-очередь |
| Manual picker позволял выбрать товар приходом 1М на позицию 500к | Не было cost-floor для ручного выбора | `replacePositionManual` возвращает `ManualPickOutcome` с `reason='below_cost'`; в модалке строки-убытки серые + бейдж «убыток» + клик заблокирован |
| Двойная фискализация из «Чеки → внутрь чека → Фискализировать» | UI не проверял существующий fiscal_receipt по ms_receipt_id | Receipt.tsx грузит `getFiscalReceiptByMsId` → дизейбл + баннер; `fiscalize()` defense-in-depth → `AlreadyFiscalizedError` |
| `ERROR_ZREPORT_IS_NOT_OPEN` сырой код в UI | Нет detection в catch | Code 36909 / текст `/ZREPORT_IS_NOT_OPEN/i` → `ShiftNotOpenError` → жёлтый баннер «Откройте смену» + кнопка в /zreport |
| matcher не подбирал — minus тыс. сум | Дырявый склад + жёсткий tolerance 1000 сум + общий bump cap 2000 не закрывал разрывы 20-54к | tolerance дефолт 500_000 тийинов (5000 сум); maxMultiItem 5→10; отдельный `maxBumpPerItemTiyin` 1_000_000 (10000 сум). Что не добралось — manual picker. UX-баннер «подобрано N/M, не хватает X» |
| Неподобранные позиции жили только в `warnings` (текст), manual picker недостижим | `match.positions` содержал только matched | Теперь buildMatch добавляет позицию с пустым `candidates[]` → UI рисует строку «не подобрано» + кнопку manual; фискализация блокирована пока `hasUnmatched` |
| Бухгалтер-упрощенец шлёт vat=0 в ЭСФ, но магазин на общем режиме продаёт с 12% | inv_item.vat_percent — это ставка ПОСТАВЩИКА, не магазина | `SettingKey.DefaultVatPercent` (default 12) → override всех vat в `loadMatcherPool` |
| Holistic не сошёлся на нестандартном шаге округления (`roundUpToSum != 1000`) | DP_BUCKET_TIYIN зашит как 100_000 (=1000 сум). При шаге 250 selling-цены не кратны bucket → `dpExactSum` возвращает null | Фаза 3 (closest-below + bump) закрывает delta до `maxBumpPerItemTiyin`. Если магазин использует step≠1000 — поднять `maxBumpPerItemTiyin` в Настройках |
| Сумма МС-чека и фискального чека различаются (Click/Payme exclude) | Магазин принимает электронные платежи отдельно от ОФД; кассир вручную исключает в Receipt.tsx | Поле «Сумма через Click/Payme» → `targetSumOverrideTiyin` в matcher; `excludePaymentTiyin` в fiscalize → корректирует payment split (вычитает из noCashSum/qrSum, cash не трогает) + сохраняет в `fiscal_receipts.excluded_payment_tiyin` |
| Refund / reprint копии должны показывать тот же тип карты что и оригинал | Без сохранения тип терялся при печати refund/копии | Migration 009 → колонка `fiscal_receipts.card_kind`. fiscalize.ts сохраняет `opts.cardKind`. refund.ts + History.tsx читают из БД и кладут в `karta_turi` ReceiptData |

## Открытые вопросы

- **VAT-формула**: по умолчанию `vat = total * percent / (100 + percent)` (НДС включён в цену). Если у магазина НДС начисляется сверху — нужно поменять `vatIncluded` → `vatAddedOn` в `matcher/strategies.ts`.
- **Ключи подписи**: `~/.tauri/epos-fiscal.key` живёт только на одной машине разработчика. Если потеряем — нужно перевыпустить и заново публиковать клиентам (auto-update сломается). Бэкап ключа — обязательно.

## Текущее состояние (на 2026-05-21)

### Версии

- **Последний released tag:** `v0.10.18` (12.05.2026) — на этом сидят все 4 магазина в проде
- **Dev-сборка (текущая):** `0.10.29` (в package.json), ветка `dev-test/holistic-phase1`. НЕ тегнута. Авто-апдейт на магазины НЕ идёт. Для теста — dev-build `.exe` через push в `dev-test/**` или `gh workflow run dev-build.yml`
- **Накопленные фичи между 0.10.18 → 0.10.30 ждут production-тег** (11 крупных feature/fix коммитов)

### ✅ Что готово и в коде (0.10.29)

**Базовое (было в 0.10.18):**
- MVP функционально полный, auto-update Win+Mac
- Multi-shop архитектура, фильтр по точке продаж
- MXIK через `spic` (подтверждено реальной фискализацией, кешбэк ✅)
- JSON-RPC only (legacy /uzpos удалён)
- Z-отчёт ККМ, smart open-shift, retry refresh
- Печать QR на Xprinter (CP866, ESC/POS native QR)
- Pricing markup×VAT с округлением, distributeDiscount/Bump

**Добавлено 0.10.19 → 0.10.29:**

| Версия | Что |
|---|---|
| 0.10.20-22 | Linked-ms (связка МС-модификация ↔ inv_item по «Бух. наименованию»), варианты sub-strategy (exact→substring≥15+model→token-fuzzy), enrichWithVariants подтягивает characteristics для product-чеков с TTL-кэшем (variants-cache.ts LRU500/5min) |
| 0.10.23-24 | linked-ms также читает `attributes` product (не только characteristics модификации); clamp limit≤100 в МС /entity/retaildemand?expand= (HTTP 400 fix) |
| 0.10.25 | **Manual picker** (modal с indexed search по пулу + price-filter); **НДС override** (SettingKey.DefaultVatPercent default 12); pool-фильтр по ИКПУ; **package_code сделан опциональным** (E-014 только при неверном); **Возвраты** (refund) — full feature: миграция 008, /refund/:id, processRefund, Api.SendRefundReceipt, печать «ВОЗВРАТ»; Button text-color fix для WKWebView Dark Mode |
| 0.10.26 | **Sync reconcile** — сервер = источник правды: forceFull удаляет orphans + кнопка «Обновить с сервера» в Справочнике; bootstrap+periodic→forceFull (кэш самозалечивается) |
| 0.10.27 | **Unconsume retry** — closes критическую дыру «refund терял остаток»: listFiscalOk фильтрует op_type='confirm', retryUnconsumePending отдельный обработчик. Backend mytoolbox: POST /api/v1/inventory/unconsume атомарный+идемпотентный |
| 0.10.28 | Refund **привязка к оригиналу** (бириктирилган): поле `refundInfo` camelCase (оба варианта), `dateTime` нормализован к 14 цифрам; manual picker для **неподобранных** позиций (раньше только в warnings); карточка «Оригинал из МойСклад» в /refund |
| 0.10.29 | **AlreadyFiscalizedError** (блок повторной фискализации из Чеков, UI + defense-in-depth); **ShiftNotOpenError** (понятный баннер на ZREPORT_IS_NOT_OPEN); manual picker **cost floor** (строки-убытки серые + бейдж); **тюнинг matcher** (maxMultiItem 5→10, tolerance 100k→500k, отдельный maxBumpPerItemTiyin=10000 сум); UX-баннер «подобрано N/M» |
| 0.10.30 *(в работе)* | **Holistic matcher** — целостный подбор на сумму чека (фаза 1 greedy + фаза 2 DP exact-sum + bump delta), fallback при разреженном пуле; `SettingKey.MatcherMode` с дефолтом `'auto'`. **«Karta turi»** — модалка перед фискализацией при оплате картой (Jismoniy shaxs / Korporativ), печать на ленте, сохранение в `fiscal_receipts.card_kind` (migration 009) для refund/reprint. **Click/Payme exclude** — поле в Receipt.tsx позволяет исключить сумму электронной оплаты из ОФД; matcher пересобирает план на остаток через `targetSumOverrideTiyin`; `excluded_payment_tiyin` сохраняется в БД (migration 010) для аудита; при exclude=rd.sum кнопка меняется на «Отметить как не фискальный» (`ms_receipts.status='not_required'`) |

### 🔴 Что критично проверить на проде перед тегом

1. **Refund.привязка** — после 0.10.28 fix: refund в soliq.uz должен попадать в **«Бириктирилган»** (не «Бириктирилмаган»). Этот fix ещё **не подтверждён** реальной фискализацией.
2. **Двойная фискализация** — попробовать вернуться в уже-фискализированный чек: кнопка должна быть disabled + баннер.
3. **Возвраты end-to-end** — refund → unconsume → остаток в пул → SSE → другие магазины видят. Backend /unconsume на mytoolbox задеплоен (Railway), endpoint доступен.

### ⏳ Не сделано (Phase 2 / future)

- **Частичный refund** (qty picker для каждой позиции). Сейчас только full refund — UNIQUE constraint на `original_fiscal_id`. Снять constraint + добавить `qty_refunded` в match_items.
- **Авто-создание `retailreturn` в МС** при refund — сейчас МС-сторона не интегрирована (магазины оформляют возвраты в МС руками).
- **Polling `retailreturn` из МС** (вариант «А» — отдельный поллер на refund-сущность МС).
- **Refund EPS** (PAYME/CLICK/UZUM rollback) — refundEPS метод. Сейчас refund только cash/card.
- **Sidebar пункт «Возвраты»** (список всех `fiscal_refunds` глобально для админа).
- **Тег `v0.10.30`** для production раскатки на все магазины. Сейчас 4 магазина сидят на 0.10.18 — отстают на 12 версий.
- **Отчёт «Click/Payme за период»** — суммировать `fiscal_receipts.excluded_payment_tiyin` по датам. Сейчас поле сохраняется, отчёт — Phase 2.
- **Помечать `not_required` чеки в МС** — отдельным статусом или примечанием, чтобы бухгалтер видел что мы сознательно не фискализировали.

### 🔑 Безопасность (TODO)

- Сменить пароль БД mytoolbox Postgres на Railway — он несколько раз светился в диалогах разработки (Postgres → Variables → Reset).
- Бэкап minisign-ключа `~/.tauri/epos-fiscal.key` (живёт только на машине разработчика; если потеряем — auto-update сломается у всех клиентов).
