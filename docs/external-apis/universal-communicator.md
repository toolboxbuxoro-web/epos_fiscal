# Universal Communicator API

> Локальный HTTP-сервис фискализации от E-POS Systems. Часть установки E-POS Cashdesk на Windows-кассе, работает с физическим USB-фискальным модулем (смарт-карта). Принимает чеки от внешних POS-систем, подписывает фискальным модулем, отправляет в ОФД ГНК (`ofd.soliq.uz`).
>
> **Источник:** Postman-коллекция, предоставленная пользователем (документация поставщика, не публичная).

---

## 1. Базовые сведения

### Endpoint
- **Локально:** `http://localhost:8347/uzpos`
- **По сети (тестовый/демо):** `http://integration.epos.uz:8347/uzpos`
- **В проде:** `http://<IP_кассы_в_LAN>:8347/uzpos` — Communicator слушает только LAN/localhost.

Все методы — `POST`, `Content-Type: application/json`. Метод определяется полем `method` в теле запроса.

### Авторизация
Фиксированный токен в каждом запросе:

```json
{ "token": "DXJFX32CN1296678504F2", "method": "..." }
```

Документация: «Он никогда не меняется (старый способ авторизации)». То есть токен **не идентифицирует магазин/кассу** — это просто маркер совместимости. Идентификация кассы идёт через привязку Communicator к фискальному модулю на той же машине.

### Конвенции единиц измерения

| Поле | Единица | Пример |
|---|---|---|
| `price`, `discount`, `vat`, `other`, `receivedCash`, `receivedCard`, `cashedOutFromCard` | **тийины** (1 сум = 100 тийинов) | 500000 = 5000 сум |
| `amount` (количество) | **тысячные доли** | 1000 = 1 шт; 2500 = 2.5 кг |
| `stateDuty`, `fineAmount`, `contractSum`, `discountCard.*` | **сумы** (строка) | "16500000" = 16 500 000 сум |
| `dateTime` в refundInfo | `YYYYMMDDHHMMSS`, без разделителей | "20250621142311" |
| `vatPercent` | проценты | 0, 12, 15 |

### Стандартный формат ответа

Успех:
```json
{ "error": false, "message": "..." | { ... } }
```

Ошибка:
```json
{ "error": true, "message": "EN: CODE \n Ru: текст ошибки" }
```

---

## 2. Эндпоинты

### 2.1 Управление сменой (Z-отчёт)

| Метод | Назначение | Ответ |
|---|---|---|
| `openZreport` | Открыть смену | `{error:false, message:"SUCCESS"}` или `error:true` если уже открыта |
| `closeZreport` | Закрыть смену | `{error:false, message:"SUCCESS", leftZreportCount:436}` |
| `getZreportInfo` | Текущий Z-отчёт (id=0 = текущий) | Может вернуть «Отчёт Z ещё не открыт!» |
| `getZReportInfoByNumber` | Z-отчёт по номеру (с PDF чека base64) | `{paycheck: <base64 PDF>, openTime, closeTime, totalSaleCash, totalSaleCard, totalSaleVAT, terminalID, ...}` |
| `getZReportCount` | Кол-во Z-отчётов на ФМ | |
| `getZReportsStats` | Кол-во закрытых/неотправленных в ОФД + 16 первых номеров неотправленных | |
| `getZReportsStatus` | То же, status-вариант | |
| `sendZReportByNumber` | Ручная отправка Z в ОФД | `{number: 3}` — для теста |

Пример `openZreport`:
```bash
curl -X POST http://integration.epos.uz:8347/uzpos -d '{
  "token": "DXJFX32CN1296678504F2",
  "method": "openZreport"
}'
```

### 2.2 Продажа (`sale`, `fastSale`)

`sale` — с печатью бумажного чека на принтере, `fastSale` — без печати (только фискализация). Структура тела идентична.

#### Корневой объект
| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `token` | string | ✅ | `DXJFX32CN1296678504F2` |
| `method` | string | ✅ | `sale` / `fastSale` |
| `companyName` | string | ✅ | Название компании (печатается) |
| `companyAddress` | string | ✅ | Адрес компании (печатается) |
| `companyINN` | string | ✅ | ИНН компании (печатается) |
| `staffName` | string | ❌ | Имя кассира |
| `printerSize` | int | ✅ | Ширина ленты: 58 или 80 (мм) |
| `phoneNumber` | string | ❌ | Телефон кассира/клиента |
| `companyPhoneNumber` | string | ❌ | Контактный номер компании |
| `params` | object | ✅ | Данные чека |
| `epsInfo` | object | ❌ | `{transactionId: ""}` — для EPS-связки |
| `extraInfo` | object | ✅ | Доп. данные о клиенте/транзакции |

#### `params`
| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `items` | array | ✅ | Минимум одна позиция |
| `paycheckNumber` | string | ❌ | Номер чека для печати; иначе сгенерируется |
| `paymentNumber` | string | ❌ | "Shartnoma #" — номер договора |
| `note` | string | ❌ | Комментарий к чеку |
| `stateDuty` | string | ❌ | Госпошлина (сумы) |
| `fineAmount` | string | ❌ | Штраф (сумы) |
| `contractSum` | string | ❌ | Сумма по договору (сумы) |
| `clientName` | string | ❌ | ФИО клиента |
| `discountCard` | object | ❌ | Бонусная карта |
| `receivedCash` | int | ❌ | Принято наличными (тийины) |
| `receivedCard` | int | ❌ | Принято картой (тийины) |
| `extraInfos` | object | ❌ | Сведения о ЦОТУ и кассе |

#### `params.items[]`
| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `price` | int | ✅ | Цена с учётом количества (тийины) |
| `discount` | int | ✅ | Скидка позиции с учётом количества (тийины) |
| `barcode` | string | ✅ | Штрихкод |
| `amount` | int | ✅ | Кол-во: 1000 = 1 шт |
| `vatPercent` | int | ✅ | Ставка НДС (%) |
| `vat` | int | ✅ | Сумма НДС (тийины) |
| `name` | string | ✅ | Название товара |
| `label` | string | ❌ | Код маркировки (если есть) |
| `classCode` | string | ✅ | **ИКПУ** с tasnif.soliq.uz |
| `packageCode` | string | ✅ | **Код упаковки** ИКПУ |
| `commissionTIN` | string\|int | ❌ | ИНН комитента |
| `other` | int | ✅ | Прочие скидки (тийины) |
| `ownerType` | int | ✅ | 0=перепродажа, 1=производитель, 2=услуга |

#### `params.discountCard`
| Поле | Тип | Описание |
|---|---|---|
| `available` | string | Баланс до операции (сумы) |
| `addition` | string | Начислено (сумы) |
| `subtraction` | string | Списано (сумы) |
| `remainder` | string | Баланс после (сумы) |

#### `params.extraInfos`
Объект с произвольными ключами (на русском!). Печатается на чеке. Стандартные ключи:
- `"ЦОТУ"` — название обслуживающей компании
- `"Модель виртуальной кассы"` — например `"E-POS"`

#### `extraInfo` (на верхнем уровне корня)
| Поле | Тип | Обяз. | Описание |
|---|---|---|---|
| `tin` | string | ❌ | ИНН клиента |
| `pinfl` | string | ❌ | ПИНФЛ клиента |
| `phoneNumber` | string | ❌ | Телефон клиента |
| `carNumber` | string | ❌ | Г/н авто (выездная торговля) |
| `cashedOutFromCard` | int | ❌ | Сумма обналички с карты (тийины) |
| `cardType` | int | ✅ | 1=корпоративная, 2=физлицо |
| `pptid` | string | ❌ | Номер транзакции терминала/пинпада |

#### Пример (sale)
```json
{
  "token": "DXJFX32CN1296678504F2",
  "method": "sale",
  "companyName": "E-POS Systems MCHJ",
  "companyAddress": "Toshkent Sh., Yangi Olmazor, 51",
  "companyINN": "123456789",
  "staffName": "Abdulazizov Shakhboz",
  "printerSize": 58,
  "phoneNumber": "+998331234567",
  "companyPhoneNumber": "+998711234567",
  "params": {
    "items": [
      {
        "price": 500000,
        "discount": 250000,
        "barcode": "9973150582171",
        "amount": 1000,
        "vatPercent": 12,
        "vat": 16071,
        "name": "Red bull Железная банка 0,25 л",
        "label": "",
        "classCode": "02202003001002001",
        "packageCode": "1254782",
        "commissionTIN": "20052332112345",
        "other": 100000,
        "ownerType": 0
      }
    ],
    "paycheckNumber": "A9/00000447",
    "paymentNumber": "OTA00004534 от 10.10.2022",
    "note": "За ноябрь",
    "clientName": "Khamidov Iskander",
    "receivedCash": 150000,
    "receivedCard": 650000,
    "extraInfos": {
      "ЦОТУ": "E-POS Systems LLC",
      "Модель виртуальной кассы": "E-POS"
    }
  },
  "epsInfo": { "transactionId": "" },
  "extraInfo": {
    "tin": "915673415",
    "pinfl": "12345678901234",
    "phoneNumber": "998991234567",
    "cardType": 2,
    "pptid": "1212322112"
  }
}
```

### 2.3 Возврат (`refund`)

Структура body **идентична** `sale`, плюс обязательный блок `refundInfo` для ссылки на оригинальный чек:

```json
"refundInfo": {
  "terminalId": "NA000000009499",
  "receiptSeq": "3840",
  "dateTime": "20250621142311",
  "fiscalSign": "043092179461"
}
```

Эти поля берутся из ответа на оригинальный `sale` (см. `getLastRegisteredReceipt` ниже).

### 2.4 Кредит / Аванс (`credit`, `advance`)

Структура идентична `sale`. Отличие — `method`. Используется для оплаты в кредит и аванса по договору.

### 2.5 EPS — электронные платежи (PAYME / CLICK / UZUM)

#### `epsPayment` — снять деньги через EPS
```json
{
  "token": "DXJFX32CN1296678504F2",
  "method": "epsPayment",
  "type": 0,
  "amount": 10000,
  "qrToken": "50504030881338965424"
}
```
- `type`: **0=PAYME, 1=CLICK, 2=UZUM**
- `qrToken`: QR-токен из приложения клиента

#### `epsPaymentCancel` — отмена платежа
```json
{
  "token": "DXJFX32CN1296678504F2",
  "method": "epsPaymentCancel",
  "transactionId": "685acc794a8322c06ed97bbd"
}
```

#### `saleEPS` — фискальная продажа с EPS-оплатой
Похож на `sale`, но добавляются поля `payType`, `qrToken`, и в `params` появляется `receivedEps`:
```json
{
  "token": "DXJFX32CN1296678504F2",
  "method": "saleEPS",
  "qrToken": "880489909320056382",
  "payType": 1,
  "params": {
    "items": [{ ... }],
    "receivedCash": 0,
    "receivedCard": 0,
    "receivedEps": 100000
  }
}
```
**Важно:** длина `qrToken` — от 69 до 72 символов.

#### `refundEPS` — возврат EPS-чека
Аналогично `refund` + `params.receivedEps` + `refundInfo`.

### 2.6 Валидация маркировки

| Метод | Назначение |
|---|---|
| `validationMarking` | Проверка кода маркировки (одна позиция) — `{marking, classCode}` |
| `onlineLabelValidation` | Онлайн-валидация на сервере ASL Belgisi — `{marking, classCode, packageCode, commitentTin?, ownerTin?}` |
| `validationMultipleMarking` | Пакетная валидация — массив `markings: [{marking, classCode}, ...]` |

### 2.7 Информационные / служебные

| Метод | Назначение | Что возвращает |
|---|---|---|
| `checkStatus` | Статус Communicator | OK/error |
| `getVersion` | Версия | `"Communicator--3.19.1"` |
| `getDeviceId` | Уникальный ID устройства | для регистрации в E-POS |
| `setCashNumber` | Регистрационный номер ключа | |
| `printLastPaycheck` | Перепечатать последний чек | |
| `getLastRegisteredReceipt` | Последний фискализированный чек (JSON-RPC v2 ответ) | **`{TerminalID, ReceiptSeq, DateTime, FiscalSign, AppletVersion, QRCodeURL}`** |
| `getReceiptInfo` | Состав чека (только суммы) по `number` (порядковому в ФМ) | |
| `getReceiptInfoByNumber` | Чек из локальной БД по номеру | `{number: 626}` |
| `getReceiptInfoByFiscalSign` | Чек из локальной БД по фискальному признаку | `{fiscalSign: "..."}` |
| `getReceiptsInfoByDate` | Чеки за период | `{startDate, endDate}` в формате `YYYYMMDDHHMMSS` |
| `getReceiptCount` | Кол-во неотправленных чеков в ФМ | |
| `getUnsentCount` | Кол-во неотправленных файлов в БД (ждут отправки в ОФД) | |
| `getFiscalsList` | Список фискальных модулей | |
| `acknowledge` | Подтверждение получения чека ОФД (служебное) | `{Errors, AppletVersion, SuccessCount, ErrorCount}` |
| `rescanReceipts` | Пересчёт памяти ФМ, дата первого неотправленного | |
| `resendUnsent` | Принудительная отправка в ОФД | |
| `getICPCPackage` | Допустимые packageCode и единицы измерения для ИКПУ | `{classCode}` |

### 2.8 Структура успешного фискального ответа

После `sale` / `refund` / `advance` / `credit` Communicator возвращает (можно дернуть `getLastRegisteredReceipt` сразу после):

```json
{
  "error": false,
  "message": {
    "TerminalID": "UZ210317222049",
    "ReceiptSeq": "630",
    "DateTime": "20250710135256",
    "FiscalSign": "220862352158",
    "AppletVersion": "0324",
    "QRCodeURL": "https://ofd.soliq.uz/check?t=UZ210317222049&r=630&c=20250710135256&s=220862352158"
  }
}
```

Это **именно те поля, которые надо сохранять у нас в БД** и (опционально) подкладывать в МойСклад как кастомные атрибуты.

`getReceiptsInfoByDate` дополнительно возвращает суммы:
```json
{
  "terminalId": "UZ210317222049",
  "receiptSeq": 630,
  "fiscalSign": "220862352158",
  "qrCodeURL": "...",
  "amount": "800000",
  "card": "650000",
  "cash": "150000",
  "service": null,
  "chequeNumber": null,
  "dateTime": "2025-07-10 13:52:56.0"
}
```

---

## 3. Известные ошибки

| Условие | Ответ |
|---|---|
| Z-отчёт уже открыт | `{error:true, message:" EN: ERROR_ZREPORT_IS_ALREADY_OPEN \n Ru: Z отчет уже открыт"}` |
| Z-отчёт ещё не открыт | `{error:true, message:"Отчет Z еще не открыт!"}` |
| Чек по фискальному признаку не найден | `{error:true, message:"Введённого вами фискального признака нет в базе данных!"}` |

Из этого виден паттерн: ошибки текстовые, иногда с `EN:` / `Ru:` префиксами. Парсить надо именно `error: true` булеан.

---

## 4. Подводные камни и замечания для интеграции

1. **Тийины везде**. Малейшая путаница с разрядами — и НДС/итоги поедут. В нашем коде все денежные значения держим в **тийинах как BigInt/integer**, конвертация в сумы только для UI и для строковых полей (`stateDuty` и т. д.).

2. **Кол-во в тысячных**. Для штучного товара всегда `amount: 1000`. Для весового — фактический вес в тысячных (1 кг 250 г → 1250).

3. **ИКПУ + packageCode обязательны для каждой позиции**. Это и есть точка кейса «товар без прихода» — нужна валидная пара. Можно подтягивать через `getICPCPackage` для проверки.

4. **VAT нужно считать самим**. ФМ не пересчитает — мы передаём готовое `vat` в тийинах. Формула: `vat = round(price * vatPercent / (100 + vatPercent))` (НДС включён в цену), либо `price * vatPercent / 100` (НДС сверху) — зависит от учётной политики магазина. **Уточнить у бухгалтера.**

5. **Скидка считается на позицию целиком, а не на единицу**. Поле `discount` — это уже скидка с учётом `amount`.

6. **`paycheckNumber` можно не передавать** — Communicator сгенерит сам. Если у нас будет свой счётчик (напр., синхронный с МойСклад), передаём свой.

7. **`extraInfo.cardType` помечен обязательным**, но в большинстве случаев = 2 (физлицо).

8. **`epsInfo.transactionId`** — пустая строка для обычных чеков. Используется только в связке EPS-флоу.

9. **Кириллические ключи в `extraInfos`** (`"ЦОТУ"`, `"Модель виртуальной кассы"`). Сериализатор должен корректно отдавать UTF-8.

10. **Сетевая модель**: Communicator слушает локально на машине с USB-картой. Если наш сервис на другом сервере — нужен либо туннель (VPN, ngrok), либо открытие порта в LAN. Рекомендованная схема: наш сервис тоже на этой же Windows-машине, либо в той же локальной сети.

11. **Отправка в ОФД асинхронная**. `sale` возвращает фискальный признак сразу, но в ОФД чек уйдёт по таймеру или по `resendUnsent`. Для нас это значит: возможны кейсы, когда фискальный признак есть, но `getUnsentCount > 0` — это норма.

12. **Возврат требует ссылку на оригинал** (`refundInfo` — terminalId, receiptSeq, dateTime, fiscalSign). Эти данные **обязательно сохраняем** в нашей БД при каждом sale.

13. **PDF чека в base64**. `getZReportInfoByNumber` возвращает `paycheck` как base64 PDF — можно сохранять как архив.

14. **Нет lookup по нашему ID**. Communicator использует `receiptSeq` (сквозной счётчик ФМ) и `fiscalSign`. Связь с нашим внутренним ID (например, retaildemand id из МойСклад) надо хранить **у нас**.

15. **`paymentNumber`** печатается как «Shartnoma #» (договор) — туда удобно класть номер чека МойСклад для cross-reference на бумаге.

---

## 5. Сводка эндпоинтов

```
POST http://localhost:8347/uzpos
{ "token": "DXJFX32CN1296678504F2", "method": "<METHOD>", ...payload }

Жизненный цикл смены:
  openZreport → [sale | refund | advance | credit | saleEPS | refundEPS]+ → closeZreport

Информация:
  getLastRegisteredReceipt  → последний фискализированный чек
  getReceiptsInfoByDate     → выгрузка за период
  getReceiptInfoByNumber    → по номеру
  getReceiptInfoByFiscalSign → по фискальному признаку
  getZReportInfoByNumber    → Z-отчёт + PDF base64
  getUnsentCount            → сколько чеков ждут отправки в ОФД

Служебное:
  checkStatus, getVersion, getDeviceId, setCashNumber, acknowledge,
  rescanReceipts, resendUnsent, sendZReportByNumber

Маркировка:
  validationMarking, onlineLabelValidation, validationMultipleMarking

EPS (PAYME / CLICK / UZUM):
  epsPayment, epsPaymentCancel, saleEPS, refundEPS

Справочники:
  getICPCPackage  (по classCode → допустимые packageCode + единицы измерения)
```
