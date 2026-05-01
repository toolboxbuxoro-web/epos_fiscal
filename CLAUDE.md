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
| Дата для JSON-RPC | ISO без миллисекунд | `2026-05-01T15:30:00` |

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

## Релизы и Auto-update

```
git push origin main
git tag v0.X.Y
git push origin v0.X.Y
   │
   ▼ ~10–15 мин
GitHub Actions (4 платформы параллельно)
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

`src-tauri/capabilities/default.json` — **не сужать**. Сейчас разрешено:
- `localhost:*` (любой порт — Communicator может быть на 8347/3448)
- `127.0.0.1:*`
- `192.168.*:*` / `10.*:*` (LAN, если Communicator на другом ПК)
- `https://api.moysklad.ru/*`

Прошлая версия с whitelist'ом конкретных портов **молча блокировала**
запросы к новым портам без понятных ошибок. Урок: не делать строгий
whitelist, делать broad по нашим use case.

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
  Cargo.toml              ← features: tauri-plugin-http["gzip"]
  tauri.conf.json         ← bundle.createUpdaterArtifacts: true (для подписи)
  capabilities/default.json ← НЕ сужать allow-list
  migrations/
    001_initial.sql       ← 7 таблиц (settings, esf_items, ms_receipts, ...)
    002_logs.sql          ← логи диагностики
src/
  lib/
    db/                   ← SQLite, типы и DAO
    moysklad/             ← клиент + поллер с фильтром по retailStore
    esf/                  ← Excel импорт с автомаппингом колонок
    matcher/              ← 3 стратегии подбора
    epos/
      client.ts           ← LEGACY /uzpos
      jsonrpc-client.ts   ← НОВЫЙ /rpc/api  ← фискализация идёт через него
      fiscalize.ts        ← главный flow + auto-detect протокола
    log.ts                ← запись в logs таблицу
    updater.ts            ← autoApplyOnStartup
  routes/                 ← 5 экранов: Dashboard / Receipt / Catalog / History / Logs / Settings
docs/
  external-apis/universal-communicator.md  ← API legacy /uzpos (Postman)
.github/workflows/release.yml  ← CI: 4 платформы, releaseDraft:false
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
4. Справочник → Импорт Excel с приходами от бухгалтерии.
5. Очередь — приходят чеки из МС. Открыть чек → проверить подбор → Фискализировать.

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

## Открытые вопросы

- **Формат ИКПУ в JSON-RPC**: декомпиляция GBS Market не показывает поле ИКПУ в `Item`. Возможно у новой версии Communicator оно нужно — добавили опционально как `ClassCode`/`PackageCode` в ItemRequest. Если сервер игнорирует — будет ошибка штрафа от ГНК.
- **VAT-формула**: по умолчанию `vat = total * percent / (100 + percent)` (НДС включён в цену). Если у магазина НДС начисляется сверху — нужно поменять `vatIncluded` → `vatAddedOn` в `matcher/strategies.ts`.
- **Ключи подписи**: `~/.tauri/epos-fiscal.key` живёт только на одной машине разработчика. Если потеряем — нужно перевыпустить и заново публиковать клиентам (auto-update сломается). Бэкап ключа — обязательно.

## Текущее состояние (на 2026-05-01)

- ✅ MVP функционально полный
- ✅ Auto-update работает с подписью
- ✅ Multi-shop архитектура (фильтр по точке продаж)
- ✅ JSON-RPC поддержка для актуального Communicator
- ⏳ Реальная фискализация end-to-end ещё не проверена (ждём пробный чек)
- ⏳ Реверс-инжиниринг точного формата `Receipt` для JSON-RPC API
