# План: поддержка FiscalDriveService (REST :3449)

## Зачем

Сейчас Toolbox Fiscal работает **только** с E-POS Communicator / `fiscal-drive-api`
(JSON-RPC на :3448/rpc/api). Магазин 1 (Хонабод) использует именно его.

Магазин 2 (Хазрати Имом) при установке получил **`fiscal-drive-service`**
(REST на :3449) — другую программу, которую наше приложение не понимает.

**Стратегически:** по официальной доке `FiscalDriveService приходит на замену
FiscalDriveAPI`, и `FiscalDriveAPI не будет поддерживать ФМ версии 0400`.
Значит `fiscal-drive-api` (3448) устаревает. Поддержка 3449 = future-proofing
для всех 4 магазинов.

## Архитектурное отличие двух бэкендов

| | E-POS Communicator (текущий) | FiscalDriveService (новый) |
|---|---|---|
| Порт | 3448 | 3449 |
| Протокол | JSON-RPC 2.0 | REST (path-based) |
| Endpoint | `POST /rpc/api`, method в body | `POST /FiscalDrive/...{FactoryID}` |
| Регистрация чека | 1 шаг: `Api.SendSaleReceipt` | **2 шага: `GetTXID` → `RegisterTXID`** |
| Идентификация ФМ | автоматом (внутри Communicator) | **FactoryID в URL** (= серийник ФМ) |
| Поле `Units` (OKEI) | не передаётся | **ОБЯЗАТЕЛЬНО** ⚠️ |
| Имя ИКПУ-поля | `spic` (lowercase) | `SPIC` (uppercase) |
| Ответ | `{TerminalID, ReceiptSeq, FiscalSign, QRCodeURL}` | **тот же формат** ✅ |
| Идемпотентность | UNIQUE fiscal_sign | RegisterTXID retry-safe (без дублей) ✅ |

Хорошая новость: **ответ идентичен** (`FiscalReceiptInfo`), refund-привязка
(`RefundInfo`) — те же поля. Печать/история/refund-логика переиспользуются.

## REST-методы FiscalDriveService (что нужно)

```
GET  /FiscalDrive/List                          → [{FactoryID,...}]  (найти серийник ФМ)
GET  /FiscalDrive/Info/{FactoryID}              → состояние ФМ (Locked?)
POST /FiscalDrive/ZReport/Open/{FactoryID}      → "OK"  (открыть смену)
POST /FiscalDrive/ZReport/Close/{FactoryID}     → "OK"  (закрыть смену)
GET  /FiscalDrive/ZReport/Info/{FactoryID}      → тоталы Z (для /zreport UI)
POST /FiscalDrive/Receipt/GetTXID/{FactoryID}   body=JsonReceipt → TXID
POST /FiscalDrive/Receipt/RegisterTXID/{FactoryID} body=TXID → {TerminalID,ReceiptSeq,FiscalSign,QRCodeURL}
```

Чек регистрируется в 2 шага:
1. `GetTXID` — записывает JSON-чек в БД сервиса, возвращает TXID
2. `RegisterTXID` — подписывает ФМ, возвращает FiscalSign+QR. **Retry-safe** —
   при сбое связи повторный вызов не создаёт дубликат.

## Формат JsonReceipt (FiscalDriveService)

```jsonc
{
  "Time": "2026-06-02 10:43:56",
  "ReceivedCash": 1500000, "ReceivedCard": 0,
  "Type": 0,        // 0=покупка, 1=аванс, 2=кредит
  "Operation": 0,   // 0=продажа, 1=возврат
  "Location": { "Latitude": 39.77, "Longitude": 64.42 },  // геолокация магазина
  "Items": [{
    "Name": "...", "Barcode": "0",
    "SPIC": "08204001001000000",   // ИКПУ (UPPERCASE!)
    "Units": 244272402,            // ⚠️ OKEI код единицы измерения — ОБЯЗАТЕЛЬНО
    "PackageCode": "1503958",
    "OwnerType": 0, "Amount": 2000,
    "Price": 1400000, "Discount": 0, "Other": 0,
    "VATPercent": 12, "VAT": 150000
  }],
  "ExtraInfo": { "CardType": 1 },  // 1=корп, 2=личная — наш card_kind
  "RefundInfo": { "TerminalID","ReceiptSeq","DateTime","FiscalSign" }  // только refund
}
```

Инвариант (тот же что EPOS): `ReceivedCard+ReceivedCash − Σ(Price−Discount−Other) ≤ 10000`.

## ⚠️ Главный технический риск: поле `Units` (OKEI)

FiscalDriveService **требует** `Units` (uint64, код единицы измерения по ОКЕИ)
для каждой позиции. **Сейчас мы его не храним и не передаём.** Варианты:

1. **Дефолт «штука»** — захардкодить OKEI-код штуки для всех позиций (быстро,
   но неточно для весовых товаров). Нужно узнать точный код штуки.
2. **Добавить колонку `units` в inv_items** — тянуть из ИКПУ-каталога при импорте.
3. **Запросить из каталога ИКПУ** на лету (как `getICPCPackage` для packageCode).

→ Решение для MVP: **дефолт «штука»** + TODO на точный источник. Узнать код у E-POS.

## План реализации (по фазам)

### Фаза 1 — клиент + типы (`src/lib/epos/fiscal-drive-client.ts`)
- `FiscalDriveClient` класс (REST на :3449)
- методы: `listDrives`, `getInfo`, `openZReport`, `closeZReport`, `getZReportInfo`,
  `getReceiptTXID`, `registerReceiptTXID`
- типы: `FiscalDriveJsonReceipt`, `FiscalDriveItem`, ответы
- **переиспользуем** `FiscalReceiptInfo` (ответ тот же)

### Фаза 2 — маппинг чека (`buildFiscalDriveReceipt`)
- наш `getEffectiveLines(build)` → `FiscalDriveItem[]`
- `spic`→`SPIC`, добавить `Units` (дефолт штука), `OwnerType`, payment split
- card_kind → `ExtraInfo.CardType`
- геолокация магазина из Settings (опционально, можно 0)

### Фаза 3 — переключатель бэкенда (`SettingKey.FiscalBackend`)
- `'epos'` (default) | `'fiscaldrive'`
- **авто-детект** (опционально): при старте пробуем :3448/rpc/api и :3449/FiscalDrive/List,
  ставим тот что ответил. Или явная настройка в UI.
- в `fiscalize.ts`: ветка — если `fiscaldrive`, двухшаговый GetTXID→RegisterTXID

### Фаза 4 — FactoryID
- получить из `GET /FiscalDrive/List` (серийник ФМ = `LG420230639660`)
- закэшировать в Settings (`SettingKey.FiscalDriveFactoryId`)

### Фаза 5 — смена (Zreport.tsx)
- ветка на FiscalDriveService ZReport endpoints когда backend=fiscaldrive
- маппинг `getZReportInfo` ответа в наш `JsonRpcZReportInfo` формат

### Фаза 6 — возврат (refund.ts)
- ветка: `Operation=1` + `RefundInfo` для FiscalDriveService
- двухшаговый GetTXID→RegisterTXID

### Фаза 7 — тесты
- mock FiscalDriveService сервер (vitest)
- GetTXID→RegisterTXID flow, маппинг, идемпотентность retry
- инвариант суммы (≤10000)
- backend-switch логика

## Что переиспользуется (не переписываем)

- ✅ matcher / подбор — без изменений
- ✅ inventory reserve/confirm/release — без изменений
- ✅ `FiscalReceiptInfo` / `fiscal_receipts` хранилка — тот же формат ответа
- ✅ печать (printer.rs) — тот же `ReceiptData`
- ✅ refund-привязка (RefundInfo поля те же)
- ✅ AlreadyFiscalizedError / preflight / все guard'ы

## Объём работ

| Фаза | Сложность | Время |
|---|---|---|
| 1 (клиент+типы) | средняя | 2-3 ч |
| 2 (маппинг) | средняя | 1-2 ч |
| 3 (переключатель) | низкая | 1 ч |
| 4 (FactoryID) | низкая | 0.5 ч |
| 5 (смена) | средняя | 1-2 ч |
| 6 (возврат) | средняя | 1-2 ч |
| 7 (тесты) | средняя | 2-3 ч |
| **Итого** | | **~10-14 ч** |

## Риски / открытые вопросы

1. **`Units` (OKEI)** — главный. Нужен источник кодов единиц. MVP = дефолт штука.
2. **TLS / POS-auth** — если ФМ заблокирован (`X-POS-Auth` заголовок). В basic-режиме
   не нужен, но прод может требовать. Уточнить у E-POS.
3. **Тестирование** — нужен реальный FiscalDriveService или его эмулятор ФМ
   (`fiscal-drive-service devtool` + режим эмулятора, есть в доке). Можно тестить
   на магазине 2 (у него `fiscal-drive-service` уже стоит на 3449).
4. **Геолокация** — `Location` обязателен? Уточнить (в примере есть, но может 0).

## Рекомендация по порядку

**Сейчас (быстро, 0 кода):** Вариант A — попросить E-POS поставить на магазин 2
`fiscal-drive-api` на 3448 (как на магазине 1) → заработает немедленно.

**Параллельно/потом (стратегически):** реализовать поддержку 3449 по этому плану —
тогда не зависим от того какую версию E-POS поставит, и готовы к ФМ версии 0400
когда `fiscal-drive-api` совсем отkey.
