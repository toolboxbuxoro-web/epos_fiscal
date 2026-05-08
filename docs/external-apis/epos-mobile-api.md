# E-POS Mobile API

> Локальный HTTP-мост между приложением пользователя и фискальным модулем,
> встроенным в Android-устройство с приложением **EPOS Mobile**.
> Превращает Android-смартфон/планшет в полноценную онлайн-ККМ Узбекистана.
>
> **Это НЕ тот API что мы используем в Toolbox Fiscal.** У нас Communicator
> JSON-RPC `:3448/rpc/api` (см. `universal-communicator.md`). Документация
> ниже сохранена потому что:
>
> 1. Имена полей в Mobile API и Communicator JSON-RPC **унифицированы**
>    производителем (`spic`, `packageCode`, и т.д.) — это и есть источник
>    правильного имени `spic` для нашего payload.
> 2. Communicator desktop API документация ещё `coming soon`. Mobile API
>    — наше единственное звено между официальной документацией и нашим
>    реверс-инженером.
> 3. Если завтра выйдет публичная Communicator-документация с другими
>    именами полей — у нас будет с чем сравнить.
>
> **Источник:** https://docs.epos.uz/ru/mobile-api/ — официальная
> документация E-POS Systems.
> **Версия API:** 1.0.2 (на 2026-05-08).
> **Снимок сделан:** 2026-05-08 после успешной фискализации с MXIK
> (TerminalID `VG343420011189`, Toolbox Fiscal 0.10.12).

---

## Связь с Communicator JSON-RPC (важно)

| Mobile API | Communicator JSON-RPC | Совпадает? |
|---|---|---|
| Endpoint: `POST http://localhost:8765/receipts` | `POST http://localhost:3448/rpc/api` метод `Api.SendSaleReceipt` | ✗ разные |
| Header: `X-API-Key: <token>` | без авторизации | ✗ разные |
| Поле `spic` (ИКПУ / MXIK) | `spic` | ✅ |
| Поле `packageCode` | `packageCode` | ✅ |
| Поле `units` (OKEI код) | (статус неизвестен — мы не передаём) | ❓ |
| Поле `name` (название) | `Name` (PascalCase) | ⚠️ регистр |
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
1. GET  /status              — проверка готовности
2. POST /z-report/open       — открытие смены
3. POST /receipts            — создание чека(ов)   ← N раз
4. POST /z-report/close      — закрытие смены
5. POST /receipts/send-unsent — переотправка при ошибках ОФД (если ofdSent=false)
6. POST /z-report/send-unsent — переотправка Z-отчёта при необходимости
```

### Типы чеков

- `sale` — продажа (`/receipts-sale`)
- `refund` — возврат (`/receipts-refund`)
- `advance` — аванс (`/receipts-advance`)
- `credit` — кредит (`/receipts-credit`)

---

## 2. `POST /receipts` — продажа (`type: "sale"`)

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

## 3. `POST /receipts` — возврат (`type: "refund"`)

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

---

## 4. `GET /status`

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

## 5. Z-report endpoints

Полная спецификация в публичной документации не раскрыта (только структура навигации). Ориентировочно (по аналогии с Communicator):

| Endpoint | Назначение |
|---|---|
| `POST /z-report/open` | Открытие смены |
| `POST /z-report/close` | Закрытие смены (генерирует Z-отчёт) |
| `GET /z-report/current` | Текущий Z-отчёт |
| `POST /z-report/send-unsent` | Переотправка неотправленных Z-отчётов в ОФД |

---

## 6. Правила валидации (E-001 — E-018)

При создании чека API возвращает `400` с JSON ошибкой:

```json
{
  "code": "E-013",
  "rule": "spic",
  "message": "Код ИКПУ не найден в справочнике",
  "details": { "spic": "00000000000000000" }
}
```

### Валидация чека

| Код | Условие |
|---|---|
| `E-005` | Неверный тип чека (допустимы: `sale`, `refund`, `advance`, `credit`) |
| `E-006` | Пустой список товаров |
| `E-007` | Отсутствие `refundInfo` для чека возврата |
| `E-008` | Отрицательная сумма оплаты |
| `E-009` | Сумма оплаты превышает сумму позиций (>`+100` тийинов) |
| `E-010` | Несовпадение `totalVAT` с суммой НДС по позициям |

### Валидация товара

| Код | Условие |
|---|---|
| `E-003` | Запрет на наличные платежи для определённого товара (cashSale=0) |
| `E-011` | Пустое наименование |
| `E-012` | Цена ≤ 0 |
| `E-013` | `spic` не найден в справочнике tasnif.soliq.uz |
| `E-014` | `packageCode` не валиден для этого `spic` |
| `E-015` | НДС не 0% и не 12% |
| `E-016` | Неверная сумма НДС (расчётная и переданная отличаются > 100 тийинов) |

### Валидация маркировки

| Код | Условие |
|---|---|
| `E-004` | Отсутствие кодов маркировки для маркируемого товара |
| `E-017` | Длина `labels[]` ≠ `amount / 1000` |
| `E-018` | Минимальное количество маркируемого товара — 1 шт (`amount ≥ 1000`) |

---

## Что мы используем в Toolbox Fiscal

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

## Заметки

- **`units` (OKEI)** в Mobile API обязательное, в Communicator JSON-RPC мы
  его не передаём и оно работает. Возможно Communicator берёт его из
  справочника по `spic`+`packageCode` сам, или мы получаем какое-то
  дефолтное значение. **Если завтра ОФД начнёт ругаться на `units` — наша
  гипотеза будет: добавить `units: <ОКЕИ-код>` в payload.** Где взять код:
  через `tasnif.soliq.uz` API endpoint `POST /integration-mxik/unit/count`.

- **Маркировка (label / labels)** — для маркируемых товаров (алкоголь,
  лекарства, одежда). В нашем кейсе (стройинструмент) пока не нужна.

- **`E-016` валидация НДС** — формула: `vat = price × vatPercent / (100 + vatPercent)`
  ± 100 тийинов. У нас в matcher это уже посчитано через `vatIncluded()`.

- **Endpoints `/z-report/*`** в Mobile API не задокументированы детально
  (на 2026-05-08). У Communicator JSON-RPC аналоги: `Api.OpenZReport` /
  `Api.CloseZReport`.
