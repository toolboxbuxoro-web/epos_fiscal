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
Matcher (3 стратегии: passthrough / price-bucket / multi-item)
       │  ↑
       │  └── читает esf_items (приходы с ИКПУ из Excel или ЭСФ)
       ▼
matches + match_items (план: чем подменить)
       │
       ▼
fiscalize() → JsonRpcEposClient.sendSaleReceipt (Api.SendSaleReceipt)
       │
       ▼
fiscal_receipts (TerminalID, ReceiptSeq, FiscalSign, QRCodeURL)
       │
       ▼
printer.rs::print_fiscal_receipt (ESC/POS на Xprinter)

Параллельная ветка — смена ККМ (роут /zreport):
   getZReportInfo (раз в 30 сек) → UI данные
   openShift → Api.OpenZReport
   closeShift → Api.CloseZReport → printer.rs::print_z_report (Z auto)
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
    003_inventory_sync.sql ← inventory remote-конфиг (mytoolbox)
    004_drop_legacy_items.sql ← очистка legacy excel_items таблицы
    005_drop_legacy_epos_url.sql ← сброс старого uzpos URL
    006_revert_legacy_url.sql ← (откат после прерывания 0.10.8)
    007_force_jsonrpc_url.sql ← форсим http://localhost:3448/rpc/api
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
      jsonrpc-client.ts   ← /rpc/api + formatGoTime + JsonRpcZReportInfo
                            методы: SendSaleReceipt, OpenZReport, CloseZReport,
                            GetZReportInfo, GetReceiptCount, GetUnsentCount, Status
      fiscalize.ts        ← главный flow + payment split + spic поле
    printer/              ← JS-обёртка: printFiscalReceipt + printZReport
                            + ZReportPrintData (mirror Rust-структуры)
    log.ts                ← запись в logs таблицу
    updater.ts            ← autoApplyOnStartup
  routes/                 ← 7 экранов:
                            Dashboard / Receipt / Zreport / History
                            / Catalog / Logs / Settings
  components/
    Layout.tsx            ← sidebar: 6 пунктов (Касса/Смена/Чеки/Справочник/
                            Настройки/Логи) — пункт «Смена» с ClipboardList
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

## Открытые вопросы

- **VAT-формула**: по умолчанию `vat = total * percent / (100 + percent)` (НДС включён в цену). Если у магазина НДС начисляется сверху — нужно поменять `vatIncluded` → `vatAddedOn` в `matcher/strategies.ts`.
- **Ключи подписи**: `~/.tauri/epos-fiscal.key` живёт только на одной машине разработчика. Если потеряем — нужно перевыпустить и заново публиковать клиентам (auto-update сломается). Бэкап ключа — обязательно.

## Текущее состояние (на 2026-05-12, версия 0.10.18)

- ✅ MVP функционально полный
- ✅ Auto-update работает с подписью (Win + Mac)
- ✅ Multi-shop архитектура (фильтр по точке продаж)
- ✅ **MXIK доходит до ОФД** — поле `spic` в JSON-RPC payload, подтверждено реальным чеком и кешбэком клиенту (0.10.12)
- ✅ Legacy /uzpos удалён в 0.10.13 — остался только JSON-RPC `/rpc/api`
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
- ✅ **Z-отчёт ККМ** — раздел `/zreport` в стиле E-POS Cashdesk, открытие/закрытие смены через Communicator, X/Z-печать своя (ESC/POS), auto-print Z при закрытии (0.10.14–0.10.16)
- ✅ **Retry+guard для Communicator** — `refresh()` ретраит при timeout, `openShift()` не дублирует открытие если смена уже есть (0.10.18)
- ✅ Полная документация в `docs/external-apis/` — Communicator API, E-POS Mobile API, FiscalDriveService
- ✅ CI 7–10 мин (Win + Mac, без Linux)
- ⏳ Реальная фискализация end-to-end **проверена** (MXIK + кешбэк ✅), но edge cases с возвратами и mixed-payment ещё не тестировались на проде
