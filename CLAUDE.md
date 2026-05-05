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
МойСклад API ──────HTTPS──────► EPOS Fiscal (наша программа на Win)
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
Matcher (3 стратегии: passthrough / price-bucket / multi-item)
       │  ↑
       │  └── читает esf_items (приходы с ИКПУ из Excel или ЭСФ)
       ▼
matches + match_items (план: чем подменить)
       │
       ▼
fiscalize() → EposClient (legacy /uzpos) ИЛИ JsonRpcEposClient (rpc/api)
       │
       ▼
fiscal_receipts (TerminalID, ReceiptSeq, FiscalSign, QRCodeURL)
```

## Multi-shop

Каждый магазин = своя Win-машина = свой USB-фискальный модуль = своя
инсталляция нашей программы. БД у каждой своя, в `%APPDATA%`. Между
магазинами — никакого общего состояния.

Если все 4 магазина под **одним МС-аккаунтом** — поллер фильтрует по
точке продаж (`SettingKey.MoyskladRetailStoreId`), иначе магазин 1
фискализировал бы чеки магазина 3 через свою USB.

## EPOS Communicator: ДВА API

E-POS Communicator на Win одновременно слушает на двух портах с разными
протоколами. Это **критически важно понять**:

### Legacy `:8347/uzpos`
- Документация: `docs/external-apis/universal-communicator.md` (Postman от E-POS).
- Формат запроса: плоский `{token, method, ...сразу поля чека}`.
- Token фиксированный: `DXJFX32CN1296678504F2`.
- На **новых установках** Communicator у этого endpoint **урезан набор методов** — отвечает `NO_SUCH_METHOD_AVAILABLE` на большинство.
- В нашем коде: `src/lib/epos/client.ts`.

### JSON-RPC `:3448/rpc/api` (актуальный)
- Открыт через reverse-engineering декомпилированного F-Lab Market 6 (`izzatbek1988/TestMarket`).
- Формат JSON-RPC 2.0: `{jsonrpc, id, method, params}`.
- Методы: `Api.OpenZReport`, `Api.CloseZReport`, `Api.SendSaleReceipt`, `Api.SendRefundReceipt`, `Api.GetReceiptCount`, `Api.GetUnsentCount`, `Api.Status`.
- Token не нужен.
- Возвращает `Api.Status` со связью с ОФД, terminalId, кол-вом отправленных файлов.
- В нашем коде: `src/lib/epos/jsonrpc-client.ts`.

### Авто-выбор протокола
В `fiscalize.ts`:
```ts
const isJsonRpc = /\/rpc\/?(?:api)?$/i.test(eposUrl) || eposUrl.includes(':3448')
```
Если URL с `:3448` или содержит `/rpc/` → JSON-RPC. Иначе legacy.

Settings показывает оба URL как hint, по умолчанию ставится `:3448/rpc/api`.

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
| Дата для EPOS sale | `YYYYMMDDHHMMSS` без разделителей | `refundInfo.dateTime` |
| Дата для JSON-RPC | **Go-style с пробелом**, локальное время | `2026-05-04 15:30:00` |

Любой числовой расчёт с деньгами — в тийинах. Конвертация только на
вход (Excel) и UI-форматирование (`format.ts`).

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

## Matcher: цена и три стратегии

### Формула продажной цены

`selling = round_up(unit_price × (1 + markup/100) × (1 + vat/100), step)` —
**последовательно**, не суммой 22%. Дефолты: markup 10%, step 1000 сум.

Пример: приход 5959.28 сум, markup 10%, НДС 12%, шаг 1000 →
`5959.28 × 1.10 × 1.12 = 7341.63` → округление вверх → **8000 сум**.

Себестоимость с НДС (пол скидки): `unit_price × (1 + vat/100)` × quantity —
**без** наценки. Это нижняя граница для `distributeDiscount`.

### Стратегии (по очереди для каждой позиции)

1. **passthrough** — есть приход с тем же ИКПУ и достаточным остатком →
   фискализируем «как есть». Цена = расчётная продажная.
2. **price-bucket** — нет ИКПУ или нет остатка → ищем товар, у которого
   расчётная цена близка к `pos.totalTiyin` в пределах `toleranceTiyin`.
   **В чек пишем `pos.totalTiyin` (не calculated)** — клиент заплатил
   эту сумму, фискализируем именно её. Calc цена использовалась только
   для матчинга. Это убирает систематический микро-минус -1000.
3. **multi-item** — greedy knapsack по убыванию цены, набираем N товаров
   на сумму ± tolerance. Лимит N — `maxMultiItem` (default 5).

### Финальное выравнивание суммы

После основного цикла (если флаг `discountForExactSum=true`):

- `distributeDiscount` — matched > target → срезаем скидкой. Cap
  `maxDiscountPerItemTiyin` (default 200_000 = 2000 сум). Floor — себестоимость
  с НДС (нельзя продавать в убыток).
- `distributeBump` — matched < target → надбавка к цене. Cap тот же.
  Floor не нужен (повышение наценки всегда легально).

Один флаг → точное совпадение в обе стороны. По дефолту флаг **включён**
(в Receipt.tsx fallback `null → true`).

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
  migrations/
    001_initial.sql       ← 7 таблиц (settings, esf_items, ms_receipts, ...)
    002_logs.sql          ← логи диагностики
src/
  lib/
    db/                   ← SQLite, типы и DAO (SettingKey enum)
    moysklad/             ← клиент + поллер с фильтром по retailStore
    esf/                  ← Excel импорт с автомаппингом колонок
    matcher/
      extract.ts          ← service-фильтр + нормализация
      strategies.ts       ← 3 стратегии + pricing + cost-with-VAT
      index.ts            ← buildMatch + distributeDiscount + distributeBump
      types.ts            ← MatchCandidate (price/discount/vat) + MatcherOptions
    epos/
      client.ts           ← LEGACY /uzpos
      jsonrpc-client.ts   ← НОВЫЙ /rpc/api + formatGoTime  ← фискализация идёт через него
      fiscalize.ts        ← главный flow + auto-detect протокола + payment split
    printer/              ← JS-обёртка над Tauri-командой print_receipt
    log.ts                ← запись в logs таблицу
    updater.ts            ← autoApplyOnStartup
  routes/                 ← 6 экранов: Dashboard / Receipt / Catalog / History / Logs / Settings
docs/
  external-apis/universal-communicator.md  ← API legacy /uzpos (Postman)
.github/workflows/release.yml  ← CI: Win+Mac (без Linux), releaseDraft:false
```

## Чек-лист первого запуска у магазина

1. На Win-машине запустить: `irm https://raw.githubusercontent.com/toolboxbuxoro-web/epos_fiscal/main/scripts/setup-windows.ps1 | iex` (если разработка) или скачать `.exe` из GitHub Releases.
2. Установить EPOS Cashdesk + USB-фискальный модуль (если ещё нет — это E-POS делает).
3. Открыть EPOS Fiscal → Настройки:
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
5. Очередь — приходят чеки из МС. Открыть чек → проверить подбор → Фискализировать.
6. Когда тест прошёл успешно (печать корректна, суммы совпадают) — выключить тестовый режим в Настройках. Дальше всё уходит в ОФД реально.

## Известные подводные камни

| Симптом | Причина | Решение |
|---|---|---|
| HTTP 415 на `/security/token` | Нет `Accept-Encoding: gzip` | Включена feature `gzip` в reqwest, не трогать |
| HTTP 400 на `/security/token` | Tauri http странно шлёт POST body | Используем Basic Auth напрямую на каждый запрос |
| `Body is disturbed or locked` | Двойной `res.json()` после fail `res.text()` | Читаем `text()` один раз, потом `JSON.parse` |
| `NO_SUCH_METHOD_AVAILABLE` на legacy | У этой установки только JSON-RPC API | URL должен быть `http://localhost:3448/rpc/api` |
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

## Открытые вопросы

- **Формат ИКПУ в JSON-RPC**: декомпиляция GBS Market не показывает поле ИКПУ в `Item`. Возможно у новой версии Communicator оно нужно — добавили опционально как `ClassCode`/`PackageCode` в ItemRequest. Если сервер игнорирует — будет ошибка штрафа от ГНК.
- **VAT-формула**: по умолчанию `vat = total * percent / (100 + percent)` (НДС включён в цену). Если у магазина НДС начисляется сверху — нужно поменять `vatIncluded` → `vatAddedOn` в `matcher/strategies.ts`.
- **Ключи подписи**: `~/.tauri/epos-fiscal.key` живёт только на одной машине разработчика. Если потеряем — нужно перевыпустить и заново публиковать клиентам (auto-update сломается). Бэкап ключа — обязательно.

## Текущее состояние (на 2026-05-04)

- ✅ MVP функционально полный
- ✅ Auto-update работает с подписью (Win + Mac)
- ✅ Multi-shop архитектура (фильтр по точке продаж)
- ✅ JSON-RPC поддержка для актуального Communicator + Go-style date format
- ✅ Импорт Excel: per-row try/catch вместо broken-транзакции (819 из 819 строк)
- ✅ Matcher по дефолту vatStrict=false + tolerance 100k тийинов (без этого 0 матчей на реальных чеках)
- ✅ Pricing-формула markup×VAT (последовательно, не суммой 22%)
- ✅ `distributeDiscount` (matched > target) + `distributeBump` (matched < target) → точное совпадение суммы в обе стороны
- ✅ price-bucket пишет `pos.totalTiyin` (что заплатил клиент), не расчётную цену
- ✅ Скейл позиций при частичной оплате бонусами + skip фискализации при `rd.sum=0`
- ✅ Фильтр услуг (`assortment.meta.type === 'service'`)
- ✅ Авто-определение оплаты cash/card/QR/mixed из МС
- ✅ Печать QR на термопринтер Xprinter XP-80 (CP866, ESC/POS native QR)
- ✅ Тестовый режим без отправки в ОФД (но с печатью «ТЕСТ»)
- ✅ Перформанс matcher: один пул на чек вместо N×5000 запросов
- ✅ CI 7–10 мин (Win + Mac, без Linux)
- ⏳ Реальная фискализация end-to-end ещё не проверена (ждём пробный чек)
- ⏳ Реверс-инжиниринг точного формата `Receipt` для JSON-RPC API
