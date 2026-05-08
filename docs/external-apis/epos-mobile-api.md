# E-POS Mobile API — полный snapshot

> Локальный HTTP-мост между приложением пользователя и фискальным модулем,
> встроенным в Android-устройство с приложением **EPOS Mobile**.
> Превращает Android-смартфон/планшет в полноценную онлайн-ККМ Узбекистана.
>
> **Это НЕ тот API что мы используем в Toolbox Fiscal.** У нас Communicator
> JSON-RPC `:3448/rpc/api` (см. `universal-communicator.md`). Документация
> ниже сохранена потому что:
>
> 1. Имена полей в Mobile API и Communicator JSON-RPC **унифицированы**
>    производителем (`spic`, `packageCode`) — это и есть источник
>    правильного имени `spic` для нашего payload.
> 2. Communicator desktop API документация ещё `coming soon`. Mobile API
>    — наше единственное звено между официальной документацией и нашим
>    реверс-инженером.
> 3. Если завтра выйдет публичная Communicator-документация с другими
>    именами полей — у нас будет с чем сравнить.
>
> **Источник:** https://docs.epos.uz/ru/mobile-api/ (15 страниц).
> **Версия API:** 1.0.2 (на 2026-05-08).
> **Снимок сделан:** 2026-05-08 после успешной фискализации с MXIK
> (TerminalID `VG343420011189`, Toolbox Fiscal 0.10.12).
>
> **Все 15 страниц этого snapshot:** introduction, status, errors,
> receipts-sale, receipts-refund, receipts-advance, receipts-credit,
> receipts-validation, receipts-unsent, zreport-open, zreport-close,
> zreport-current, zreport-unsent (+ navigation).

---

## Связь с Communicator JSON-RPC (важно)

| Mobile API | Communicator JSON-RPC | Совпадает? |
|---|---|---|
| Endpoint: `POST http://localhost:8765/receipts` | `POST http://localhost:3448/rpc/api` метод `Api.SendSaleReceipt` | ✗ разные |
| Header: `X-API-Key: <token>` | без авторизации | ✗ разные |
| Поле `spic` (ИКПУ / MXIK) | `spic` | ✅ **camelCase оба!** |
| Поле `packageCode` | `packageCode` | ✅ **camelCase оба!** |
| Поле `units` (OKEI код) | (статус неизвестен — мы не передаём, работает) | ❓ |
| Поле `name` (название) | `Name` | ⚠️ регистр |
| Поле `price` (тийины) | `Price` | ⚠️ регистр |
| Поле `amount` (миллидоли) | `Amount` | ⚠️ регистр |
| Поле `vatPercent` | `VATPercent` | ⚠️ регистр |
| Поле `vat` | `VAT` | ⚠️ регистр |
| Поле `discount` | `Discount` | ⚠️ регистр |

**Ключевой вывод:** в Communicator JSON-RPC бóльшая часть полей —
PascalCase, **но `spic` и `packageCode` — camelCase** (как в Mobile API).
Это и сбило нас в 0.10.5–0.10.11 когда мы пробовали PascalCase для всех.

---

## 1. Базовые сведения

### Endpoint
```
http://localhost:8765
```
API работает локально на устройстве с установленным приложением EPOS Mobile.

### Аутентификация

**Получение токена:**
1. Запустить приложение EPOS Mobile
2. Активировать кассу и авторизоваться
3. Профиль → Локальный сервер → скопировать токен

**Использование:**
```
X-API-Key: <ваш токен>
```

### Единицы измерения

| Что | Единица | Пример |
|---|---|---|
| Деньги | **тийины** (1 сум = 100) | 50 000 сум = `5000000` |
| Количество | **миллидоли** (1 шт = 1000) | 2 шт = `2000`, 0.5 кг = `500` |
| `dateTime` (refundInfo) | `YYYYMMDDTHHmmss` | `"20260405T100000"` |
| `transactionTime` (response) | epoch миллисекунды | `1743858622000` |

### Стандартный flow

```
1. GET  /status                — проверка готовности
2. POST /z-report/open         — открытие смены
3. POST /receipts              — создание чека(ов)   ← N раз
4. POST /z-report/close        — закрытие смены (генерирует Z-отчёт)
5. POST /receipts/send-unsent  — переотправка при ошибках ОФД (если ofdSent=false)
6. POST /z-report/send-unsent  — переотправка Z-отчёта при необходимости
```

### Типы чеков

- `sale` — продажа
- `refund` — возврат
- `advance` — аванс
- `credit` — кредит

### Все endpoints

```
POST /receipts                  — создать чек (любой type)
POST /receipts/send-unsent      — переотправить неотправленные
POST /z-report/open             — открыть смену
POST /z-report/close            — закрыть смену
GET  /z-report/current          — текущий Z-отчёт
POST /z-report/send-unsent      — переотправить неотправленные Z-отчёты
GET  /status                    — статус сервера/ФМ
```

---

## 2. `POST /receipts` (`type: "sale"`) — продажа

### Корневой объект

| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `type` | string | ✅ | `"sale"` |
| `items` | array | ✅ | Список товаров (минимум 1) |
| `received` | object | ✅ | Информация об оплате |

### `items[]`

| Поле | Тип | Обяз. | Описание | Валидация |
|---|---|---|---|---|
| `name` | string | ✅ | Наименование товара | E-011: не пустое |
| `spic` | string | ✅ | **ИКПУ код** (17 цифр из tasnif.soliq.uz) | E-013: в справочнике Tasnif |
| `units` | number | ✅ | Код единицы измерения (узб. ОКЕИ) | — |
| `price` | number | ✅ | Цена за единицу (тийины) | E-012: > 0 |
| `amount` | number | ✅ | Количество × 1000 (1 шт = 1000) | E-018: ≥ 1000 для маркируемых |
| `vatPercent` | number | ✅ | Процент НДС | E-015: 0 или 12 |
| `vat` | number | ✅ | Сумма НДС (тийины) | E-016: `price × vat / (100+vat)` ±100 |
| `barcode` | string | ❌ | Штрих-код EAN | — |
| `label` | string | ❌ | Маркировка GS1 DataMatrix | E-004: обязательно для маркируемых |
| `labels` | string[] | ❌ | Массив маркировок (если несколько штук) | E-017: длина = `amount / 1000` |
| `discount` | number | ❌ | Скидка (тийины) | — |
| `packageCode` | string | ❌ | **Код упаковки** | E-014: должен быть в `packages` для этого ИКПУ |

### `received`

| Поле | Тип | Описание | Валидация |
|---|---|---|---|
| `cash` | number | Наличные (тийины) | E-003: 0 если cashSale=0 |
| `card` | number | Карта (тийины) | E-008: ≥ 0; E-009: не превышает «итого + 100» |

### Пример запроса

```json
{
  "type": "sale",
  "items": [
    {
      "name": "Pepsi 0.5л",
      "barcode": "4607116440012",
      "label": "010460466101809921RCX3nmR",
      "spic": "10202001002000000",
      "units": 1372873,
      "price": 800000,
      "amount": 1000,
      "vatPercent": 12,
      "vat": 85714,
      "discount": 0
    }
  ],
  "received": {
    "cash": 800000,
    "card": 0
  }
}
```

### Успешный ответ (`200 OK`)

```json
{
  "success": true,
  "receipt": {
    "terminalId": "LG230110007836",
    "receiptSeq": 44,
    "fiscalSign": "ABC123DEF456",
    "qrUrl": "https://ofd.soliq.uz/check?t=LG230110007836&r=44&c=20260405143022&s=ABC123DEF456",
    "transactionTime": 1743858622000
  },
  "receiptHtml": "<html>...</html>",
  "ofdSent": true
}
```

| Поле | Тип | Описание |
|---|---|---|
| `success` | boolean | Статус операции |
| `receipt.terminalId` | string | ID терминала (фискального модуля) |
| `receipt.receiptSeq` | number | Порядковый номер чека в ФМ |
| `receipt.fiscalSign` | string | Фискальный признак (12-13 цифр) |
| `receipt.qrUrl` | string | Полный URL для QR-кода в чек |
| `receipt.transactionTime` | number | Время транзакции (epoch ms) |
| `receiptHtml` | string | HTML-представление бумажного чека |
| `ofdSent` | boolean | `true` если ушло в ОФД, `false` если только локально |

### Ответ при недоступности ОФД (всё ещё `200 OK`)

```json
{
  "success": true,
  "receipt": { ... },
  "receiptHtml": "<html>...</html>",
  "ofdSent": false,
  "ofdError": "All OFD servers failed"
}
```

Чек пробит на ФМ, но не отправлен в ОФД. Нужен ручной retry через `POST /receipts/send-unsent`.

---

## 3. `POST /receipts` (`type: "refund"`) — возврат

Структура **идентична** sale, плюс обязательный блок `refundInfo`. Без него — `E-007`.

### `refundInfo`

| Поле | Тип | Описание |
|---|---|---|
| `terminalId` | string | ID терминала из оригинального чека |
| `receiptSeq` | number | Порядковый номер оригинального чека |
| `dateTime` | string | Временная метка `YYYYMMDDTHHmmss` |
| `fiscalSign` | string | Фискальный признак оригинала |

### Пример

```json
{
  "type": "refund",
  "items": [
    {
      "name": "Хлеб белый",
      "spic": "10202001002000000",
      "units": 1372873,
      "price": 350000,
      "amount": 1000,
      "vatPercent": 0,
      "vat": 0
    }
  ],
  "received": {
    "cash": 350000,
    "card": 0
  },
  "refundInfo": {
    "terminalId": "LG230110007836",
    "receiptSeq": 44,
    "dateTime": "20260405T100000",
    "fiscalSign": "ABC123DEF456"
  }
}
```

Формат успешного ответа идентичен ответу для операции продажи.

---

## 4. `POST /receipts` (`type: "advance"`) — аванс

Чек аванса используется для **фиксации предоплаты** (например по договору
на поставку, до момента передачи товара).

Структура идентична sale (нет refundInfo).

### Пример

```json
{
  "type": "advance",
  "items": [
    {
      "name": "Предоплата за услугу",
      "spic": "10202001002000000",
      "units": 1372873,
      "price": 5000000,
      "amount": 1000,
      "vatPercent": 12,
      "vat": 535714
    }
  ],
  "received": {
    "cash": 0,
    "card": 5000000
  }
}
```

---

## 5. `POST /receipts` (`type: "credit"`) — кредит

Чек кредита используется для **продажи в кредит** (товар передан, оплата
поступит частями позже).

Структура идентична sale (нет refundInfo).

### Пример

```json
{
  "type": "credit",
  "items": [
    {
      "name": "Холодильник Samsung",
      "spic": "10202001002000000",
      "units": 1372873,
      "price": 850000000,
      "amount": 1000,
      "vatPercent": 12,
      "vat": 91071428
    }
  ],
  "received": {
    "cash": 0,
    "card": 850000000
  }
}
```

---

## 6. `POST /receipts/send-unsent` — переотправка чеков в ОФД

Используется когда `ofdSent: false` после создания чека (ОФД был
недоступен). Чек пробит на ФМ локально, но не доехал до ОФД — этот
endpoint пытается переотправить.

### Request
Без тела (system берёт неотправленные сам).

### Response

```json
{
  "success": true,
  "total": 3,
  "sent": 3,
  "failed": 0,
  "errors": []
}
```

| Поле | Тип | Описание |
|---|---|---|
| `success` | boolean | Статус выполнения |
| `total` | number | Всего неотправленных |
| `sent` | number | Успешно отправлено |
| `failed` | number | Не удалось отправить |
| `errors` | array | Детали ошибок с кодами |

Может быть частичный успех (`failed > 0`) — некоторые чеки доехали,
другие нет. Нужен повторный вызов.

---

## 7. `POST /z-report/open` — открытие смены

Смена должна быть открыта перед пробитием чеков.

### Request
Без тела.

### Response (успех)
```json
{ "success": true }
```

### Ошибки
- Если смена уже открыта — `F-002` или подобная (повторный вызов вернёт ошибку).

---

## 8. `POST /z-report/close` — закрытие смены

Закрытие смены в конце рабочего дня. **Z-отчёт автоматически отправляется
в ОФД.** Если ОФД недоступен — переотправить через `/z-report/send-unsent`.

### Request
Без тела.

### Response

```json
{
  "success": true,
  "zReport": {
    "number": 5,
    "closeTime": "20260405T180000"
  },
  "ofdSent": true
}
```

| Поле | Тип | Описание |
|---|---|---|
| `zReport.number` | number | Номер Z-отчёта |
| `zReport.closeTime` | string | Когда закрылась смена |
| `ofdSent` | boolean | Отправлен ли Z-отчёт в ОФД |

---

## 9. `GET /z-report/current` — текущий Z-отчёт

Данные открытой смены (текущей).

### Request
```
GET /z-report/current
```

### Response

```json
{
  "Header": {
    "TerminalID": "LG230110007836",
    "Number": 5,
    "OpenTime": "2026-04-05 09:00:00",
    "CloseTime": ""
  },
  "TotalSaleCash": 5000000,
  "TotalSaleCard": 3000000,
  "TotalSaleVAT": 960000,
  "TotalSaleCount": 15,
  "TotalRefundCash": 200000,
  "TotalRefundCard": 0,
  "TotalRefundVAT": 24000,
  "TotalRefundCount": 1
}
```

| Поле | Описание |
|---|---|
| `Header.TerminalID` | ID терминала |
| `Header.Number` | Номер текущей смены |
| `Header.OpenTime` | Время открытия смены |
| `Header.CloseTime` | Пусто пока смена открыта |
| `TotalSaleCash` | Итого продаж наличными (тийины) |
| `TotalSaleCard` | Итого продаж картой (тийины) |
| `TotalSaleVAT` | Итого НДС по продажам (тийины) |
| `TotalSaleCount` | Кол-во чеков продаж |
| `TotalRefundCash` | Итого возвратов наличными |
| `TotalRefundCard` | Итого возвратов картой |
| `TotalRefundVAT` | Итого НДС по возвратам |
| `TotalRefundCount` | Кол-во чеков возвратов |

---

## 10. `POST /z-report/send-unsent` — переотправка Z-отчётов

Аналогично `/receipts/send-unsent`, но для Z-отчётов.

### Request
Без тела.

### Response

```json
{
  "success": true,
  "total": 2,
  "sent": 2,
  "failed": 0,
  "errors": []
}
```

---

## 11. `GET /status` — статус сервера

Проверка готовности API и состояния фискального модуля.

### Response

```json
{
  "app": "EPOS",
  "version": "1.0.2",
  "systemVersion": "1.0.0",
  "port": 8765,
  "fmInitialized": true,
  "activated": true,
  "subscriptionState": "active"
}
```

| Поле | Тип | Значение |
|---|---|---|
| `app` | string | Название приложения |
| `version` | string | Версия приложения |
| `systemVersion` | string | Версия системы |
| `port` | number | Порт сервера |
| `fmInitialized` | boolean | Фискальный модуль инициализирован |
| `activated` | boolean | Касса активирована |
| `subscriptionState` | string | Состояние подписки (`active` / etc) |

---

## 12. Правила валидации

### Формат ошибки валидации

```json
{
  "success": false,
  "error": {
    "code": "E-011",
    "rule": "ITEM_NAME_EMPTY",
    "message": "Наименование товара не может быть пустым",
    "details": {
      "itemIndex": 0,
      "itemName": ""
    }
  }
}
```

### Валидация чека (E-005 — E-010)

| Код | Правило | Описание |
|---|---|---|
| `E-005` | RECEIPT_TYPE_INVALID | Неверный тип чека. Допустимо: sale, refund, advance, credit |
| `E-006` | RECEIPT_ITEMS_EMPTY | Пустой список товаров |
| `E-007` | RECEIPT_REFUND_INFO_REQUIRED | `refundInfo` обязателен для чека возврата |
| `E-008` | RECEIPT_SUM_NEGATIVE | Сумма оплаты не может быть отрицательной |
| `E-009` | RECEIPT_SUM_EXCEEDS_TOTAL | Сумма оплаты превышает сумму по позициям |
| `E-010` | RECEIPT_TOTAL_VAT_MISMATCH | `totalVAT` не совпадает с суммой `vat` по позициям |

### Валидация товара (E-011 — E-016)

| Код | Правило | Описание |
|---|---|---|
| `E-003` | ITEM_CASH_FORBIDDEN_CASH_SALE_ZERO | Оплата наличными запрещена для данного товара |
| `E-011` | ITEM_NAME_EMPTY | Наименование товара не может быть пустым |
| `E-012` | ITEM_PRICE_INVALID | Цена товара должна быть больше нуля |
| `E-013` | ITEM_SPIC_NOT_IN_TASNIF | Код ИКПУ не найден в справочнике Tasnif |
| `E-014` | ITEM_PACKAGE_CODE_NOT_IN_TASNIF | Код упаковки не найден в `packages` ИКПУ |
| `E-015` | ITEM_VAT_PERCENT_INVALID | Допустимые значения НДС: 0% или 12% |
| `E-016` | ITEM_VAT_AMOUNT_INVALID | Сумма НДС не соответствует расчёту (`price × 12 / 112 ±100`) |

### Валидация маркировки (E-004, E-017, E-018)

| Код | Правило | Описание |
|---|---|---|
| `E-004` | ITEM_LABELS_REQUIRED_FOR_LABELED | Товар подлежит маркировке, коды маркировки не указаны |
| `E-017` | ITEM_LABELS_COUNT_MISMATCH | Количество маркировок не совпадает с количеством товара |
| `E-018` | ITEM_AMOUNT_BELOW_MIN_FOR_LABELED | Маркируемый товар: минимальное количество — 1 штука |

---

## 13. Все коды ошибок (28 штук)

Документация явно указывает что коды НЕ от E-001 до E-099, а в 4 категориях по префиксу.

### Формат error response

**Простая ошибка:**
```json
{
  "success": false,
  "error": {
    "code": "F-002",
    "message": "Z-отчёт не открыт. Откройте смену перед продажей"
  }
}
```

**Ошибка валидации** — см. раздел 12 (с полем `rule` и `details`).

### Категория `E-` (EPOS / валидация) — 18 кодов

| Код | Описание |
|---|---|
| `E-001` | Касса не активирована |
| `E-002` | Подписка истекла |
| `E-003` — `E-018` | Различные проблемы валидации товаров и чеков (см. раздел 12) |

### Категория `F-` (Fiscal / фискальный модуль) — 4 кода

| Код | Описание |
|---|---|
| `F-001` | Фискальный модуль не инициализирован |
| `F-002` | Z-отчёт не открыт. Откройте смену перед продажей |
| `F-003` | Проблема с фискальным модулем |
| `F-005` | Проблема с фискальным модулем |

### Категория `S-` (Server / API сервер) — 4 кода

| Код | Описание |
|---|---|
| `S-001` — `S-004` | Проблемы API-сервера |

### Категория `T-` (Transport / соединение с ОФД) — 2 кода

| Код | Описание |
|---|---|
| `T-001`, `T-003` | Ошибки соединения с ОФД |

**Итого: 28 кодов ошибок.**

---

## 14. Что мы используем в Toolbox Fiscal

В нашем Communicator JSON-RPC payload (см. `src/lib/epos/jsonrpc-client.ts`)
используются **те же имена** для критичных полей:

```ts
{
  spic: "06804001002000000",       // ⭐ как в Mobile API
  packageCode: "1343508",          // ⭐ как в Mobile API
  // Остальные поля — PascalCase (отличается от Mobile API):
  Name, Price, Amount, VAT, VATPercent, Discount, Barcode, Other, OwnerType
}
```

**`spic` и `packageCode` ВСЕГДА camelCase** — это конвенция E-POS для всех
их продуктов (Mobile API + Communicator + Cashdesk). Не менять.

---

## 15. Заметки и потенциальные риски

- **`units` (OKEI)** в Mobile API обязательное, в Communicator JSON-RPC мы
  его не передаём и оно работает. Возможно Communicator берёт его из
  справочника по `spic`+`packageCode` сам, или мы получаем какое-то
  дефолтное значение. **Если завтра ОФД начнёт ругаться на `units` — наша
  гипотеза будет: добавить `units: <ОКЕИ-код>` в payload.** Где взять код:
  через `tasnif.soliq.uz` API endpoint `POST /integration-mxik/unit/count`.

- **Маркировка (label / labels)** — для маркируемых товаров (алкоголь,
  лекарства, одежда). В нашем кейсе (стройинструмент) пока не нужна.
  Если магазин начнёт продавать маркируемый товар — не забыть добавить
  поле `label` (строка) или `labels` (массив = `amount / 1000` штук).

- **`E-016` валидация НДС** — формула: `vat = price × vatPercent / (100 + vatPercent)`
  ± 100 тийинов. У нас в matcher это уже посчитано через `vatIncluded()`.

- **`E-009` сумма оплаты не превышает «итого + 100»** — значит можно
  принять чуть больше чем сумма позиций (max +100 тийинов = 1 сум). Мы
  это соблюдаем потому что `receivedCash + receivedCard` всегда = сумме
  позиций после `distributeDiscount`/`Bump`.

- **Коды T- (transport)** — означают проблемы с интернетом / ОФД. Если
  получаем — чек пробит на ФМ, нужен `/send-unsent`. У нас в коде это
  fallback должен сработать (логи + retry).

- **Коды F- (fiscal)** — критичные. F-002 «Z-отчёт не открыт» означает
  что magaz не открыл смену в МС/E-POS. У нас уже есть проверка статуса
  через poller / SystemStatusPanel. F-001/F-003/F-005 — проблема с самим
  USB-ФМ, ничего сделать в коде не получится — нужно физически
  переподключить кассу или связаться с E-POS.
