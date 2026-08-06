// Типы соответствуют схеме SQLite (см. src-tauri/migrations/001_initial.sql).
//
// Конвенции:
//   * Все суммы в тийинах (1 сум = 100 тийинов) — `Tiyin`
//   * Количество в тысячных долях (1000 = 1 шт) — `MilliQty`
//   * Все timestamp — секунды с epoch — `EpochSec`

export type Tiyin = number
export type MilliQty = number
export type EpochSec = number

// ── settings ─────────────────────────────────────────────────────

export interface SettingRow {
  key: string
  value: string
  updated_at: EpochSec
}

/** Известные ключи настроек. */
export const SettingKey = {
  /** Bearer-токен МойСклад (старый способ, fallback). */
  MoyskladToken: 'moysklad.token',
  /**
   * Basic-credentials МойСклад (base64 от "login:password").
   * Современный способ авторизации — отправляется в каждом запросе
   * как `Authorization: Basic <это>`. Хранится как plaintext base64,
   * это не шифрование. БД лежит в Application Support, доступ к ней
   * у других программ ограничен ОС.
   */
  MoyskladCredentials: 'moysklad.credentials',
  /** Email/логин текущего залогиненного пользователя МойСклад (для UI). */
  MoyskladLogin: 'moysklad.login',
  /** ID выбранной точки продаж МойСклад. */
  MoyskladRetailStoreId: 'moysklad.retailstore_id',
  /** Имя выбранной точки продаж (для UI). */
  MoyskladRetailStoreName: 'moysklad.retailstore_name',
  /** ID выбранного кассира. */
  MoyskladEmployeeId: 'moysklad.employee_id',
  /** ФИО кассира (печатается в `staffName` чека EPOS). */
  MoyskladEmployeeName: 'moysklad.employee_name',
  /** Интервал поллинга МойСклад в секундах */
  MoyskladPollIntervalSec: 'moysklad.poll_interval_sec',
  /** Адрес EPOS Communicator (обычно http://localhost:8347/uzpos) */
  EposCommunicatorUrl: 'epos.communicator_url',
  /** Токен EPOS — фиксированный, см. universal-communicator.md */
  EposToken: 'epos.token',
  /** Реквизиты компании (печатаются на чеке) */
  CompanyName: 'company.name',
  CompanyInn: 'company.inn',
  CompanyAddress: 'company.address',
  CompanyPhone: 'company.phone',
  /** Ширина ленты принтера: 58 или 80 */
  PrinterSize: 'printer.size',
  /**
   * Имя выбранного термопринтера (точное system_name из ОС).
   * Если пусто — печать чеков отключена даже при PrinterAutoPrint=true.
   */
  PrinterName: 'printer.name',
  /**
   * Автоматически печатать чек после успешной фискализации.
   * 'true' / 'false'. По умолчанию — false (печатать только по кнопке).
   */
  PrinterAutoPrint: 'printer.auto_print',
  /** Допуск по сумме при подборе чека (в тийинах) */
  MatchToleranceTiyin: 'matcher.tolerance_tiyin',
  /**
   * Процент наценки на приходную цену (целое число).
   * Применяется ДО НДС. По умолчанию 10.
   * Формула продажной цены: round_up(price * (1+markup/100) * (1+vat/100), step).
   */
  MarkupPercent: 'pricing.markup_percent',
  /**
   * Шаг округления продажной цены вверх, в сумах.
   * По умолчанию 1000 — то есть 15500 → 16000, 667450 → 668000.
   * 1 = без округления, 100 = до сотен сум, 1000 = до тысяч сум.
   */
  RoundUpToSum: 'pricing.round_up_to_sum',
  /**
   * Принудительная ставка НДС для продаж (в процентах). По умолчанию **12**.
   *
   * Используется чтобы переопределить `inv_item.vat_percent` (который
   * приходит из ЭСФ поставщика — у упрощенцев = 0) на ставку магазина.
   *
   * Если магазин на общем режиме НО (default в РУз для всех ИП/ООО кроме
   * упрощёнки), он обязан **продавать** все товары с НДС 12% независимо
   * от того что указал поставщик при поставке. Этот параметр применяется:
   *
   *   1. К `calculateSellingPrice` — расчёт продажной цены всегда × 1.12
   *   2. К `makeCandidate` — НДС в фискальном чеке всегда 12%
   *   3. К payload Communicator (`VATPercent: 12` для каждой позиции)
   *
   * Дефолт `'12'`. Поменять в Настройках если магазин на упрощёнке (0)
   * или если ставка изменится (например с 12 на 15 — было такое в 2019).
   */
  DefaultVatPercent: 'pricing.default_vat_percent',
  /**
   * Включить ли распределение скидок чтобы итоговая сумма подбора совпала
   * 1-в-1 с суммой чека МойСклад. 'true' / 'false'. По умолчанию 'true'.
   */
  DiscountForExactSum: 'pricing.discount_for_exact_sum',
  /**
   * Максимум скидки на одну позицию, в сумах. По умолчанию 2000.
   * Дополнительный лимит к ограничению по себестоимости (нельзя ниже).
   */
  MaxDiscountPerItemSum: 'pricing.max_discount_per_item_sum',
  /**
   * Тестовый режим («сухой прогон»). Если 'true' — фискализация работает
   * как обычно по UI (подбор виден, кнопка работает), но запрос в EPOS
   * Communicator НЕ уходит, остатки НЕ списываются, fiscal_receipt НЕ
   * создаётся. Чек остаётся в очереди со статусом 'pending'.
   *
   * Используется для проверки настройки matcher / ценообразования /
   * принтера без реальных записей в ОФД ГНК.
   */
  TestMode: 'app.test_mode',
  /** Включён ли режим автоматической фискализации */
  AutoFiscalize: 'matcher.auto_fiscalize',
  /** Включён ли режим подмены ИКПУ для товаров без приходов */
  ReplacementEnabled: 'matcher.replacement_enabled',
  // ── Multi-shop inventory (общий пул приходов через mytoolbox) ──
  /**
   * Использовать удалённый inventory server (mytoolbox) для общего пула
   * приходов между магазинами. 'true' / 'false'. По умолчанию false —
   * legacy локальный режим (esf_items только локально).
   *
   * Когда включено — приходы синхронизируются с сервера через
   * GET /items, а consumeEsfItem заменяется на reserve→confirm flow.
   */
  InventoryRemoteEnabled: 'inventory.remote_enabled',
  /** Базовый URL inventory server (например https://mytoolbox-backend.up.railway.app). */
  InventoryServerUrl: 'inventory.server_url',
  /** Slug магазина в inv_shops (например 'toolbox-honabod'). */
  InventoryShopSlug: 'inventory.shop_slug',
  /**
   * API key магазина для аутентификации в inventory server.
   * Хранится plaintext в БД магазина — это секрет, доступный только
   * процессу нашей программы. Ротация — через админку mytoolbox.
   */
  InventoryShopApiKey: 'inventory.shop_api_key',
  /** Unix-timestamp последнего успешного sync /items?since=. */
  InventoryLastSyncTs: 'inventory.last_sync_ts',
  /**
   * Хеш PIN администратора (PBKDF2-SHA256 100k итераций + соль).
   * Формат: `<saltBase64>:<hashBase64>`. Проверяется при разблокировке
   * dev-режима в Settings (login=admin + password=admin + PIN).
   */
  AdminPinHash: 'admin.pin_hash',
  /**
   * Имя характеристики **модификации** в МойСкладе, куда бухгалтер пишет
   * «бухгалтерское наименование» (= точное имя как в нашей `esf_items`).
   *
   * По умолчанию `'Бухгалтерское наименование'`. Если бухгалтер назвал
   * характеристику иначе — поменять здесь.
   *
   * Применяется в `matcher/extract.ts` при парсинге чека МС: для каждой
   * позиции читается `assortment.characteristics`, ищется характеристика
   * с этим именем (substring + case-insensitive), её значение попадает в
   * `NormalizedPosition.linkedBuhName`. Далее `matcher/strategies.ts::
   * tryLinkedMsVariant` использует это значение для smart-search в пуле
   * приходов.
   */
  MsLinkCharacteristicName: 'matcher.ms_link_characteristic_name',
  /**
   * Режим matcher'а — как подбирать товары на сумму чека.
   *
   * Значения:
   *   - `'auto'`    (default) — сначала classic per-position, при провале
   *                 fallback на holistic (целостный подбор на сумму чека)
   *   - `'classic'` — только classic per-position (старое поведение до 0.10.30)
   *   - `'holistic'` — всегда holistic, classic пропускается
   *   - `'off'`     — оба автоматических режима выключены, только manual picker
   *
   * `holistic` решает задачу так: target = rd.sum, пул = inv_items с остатками,
   * жадно набираем крупное под резерв филлеров + DP exact-sum на остаток.
   * Применяется когда per-position не сошлось (sparse pool) — собирает чек
   * как целое, без жёсткой привязки фискальных строк к МС-позициям.
   * См. `src/lib/matcher/holistic.ts`.
   */
  MatcherMode: 'matcher.mode',
  /**
   * Отправлять ли error-логи на mytoolbox-сервер для централизованного
   * debugging'а. 'true' / 'false'. По умолчанию 'true'.
   *
   * Что шлётся:
   *   - level='error' (включая 🚨 CRITICAL refund-в-ОФД-но-не-сохранён)
   *   - PII (tin, pinfl, clientName, phoneNumber) предварительно убирается
   *     через `scrubPii` в `src/lib/telemetry.ts`
   *   - Батч до 50 строк раз в 30 сек
   *
   * Что НЕ шлётся: debug, info, warn — остаются локально.
   *
   * Магазин может отключить если беспокоится о приватности (Настройки →
   * «Отправлять логи об ошибках на сервер»).
   */
  TelemetryEnabled: 'telemetry.enabled',
  /**
   * Бэкенд фискализации.
   *   - `'epos'`        (default) — E-POS Communicator JSON-RPC на :3448/rpc/api
   *   - `'fiscaldrive'` — FiscalDriveService REST на :3449 (двухшаговый GetTXID→RegisterTXID)
   *
   * Магазин 1 (Хонабод) = 'epos'. Магазин 2 (Хазрати Имом) = 'fiscaldrive'.
   */
  FiscalBackend: 'fiscal.backend',
  /**
   * FactoryID фискального модуля (серийник ФМ-карты) для FiscalDriveService.
   * Получается из GET /FiscalDrive/List → первый элемент → FactoryID.
   * Пример: 'LG420230639660' или '002024083000152503000000000000000000'.
   * Кэшируется в Settings чтобы не делать /List при каждой фискализации.
   */
  FiscalDriveFactoryId: 'fiscal.drive_factory_id',
  /**
   * Базовый URL FiscalDriveService.
   * По умолчанию 'http://localhost:3449'.
   * Аналог EposCommunicatorUrl для нового бэкенда.
   */
  FiscalDriveBaseUrl: 'fiscal.drive_base_url',
} as const

export type SettingKey = (typeof SettingKey)[keyof typeof SettingKey]

// ── esf_items ────────────────────────────────────────────────────

export type EsfSource = 'excel' | 'e-faktura' | 'didox' | 'remote'
export type OwnerType = 0 | 1 | 2 // 0=перепродажа, 1=производитель, 2=услуга

export interface EsfItemRow {
  id: number
  source: EsfSource
  external_id: string | null
  name: string
  barcode: string | null
  class_code: string
  package_code: string
  vat_percent: number
  owner_type: OwnerType
  unit_price_tiyin: Tiyin
  qty_received: MilliQty
  qty_consumed: MilliQty
  received_at: EpochSec
  imported_at: EpochSec
  notes: string | null
  /**
   * id строки на удалённом inventory server (mytoolbox).
   * Заполнено когда строка пришла через sync (source='remote').
   * NULL для legacy локальных импортов из Excel/ЭСФ.
   *
   * При фискализации в remote-режиме именно этот id отправляется в
   * /reserve как `inv_item_id`.
   */
  server_item_id: number | null
}

export type NewEsfItem = Omit<
  EsfItemRow,
  'id' | 'qty_consumed' | 'imported_at' | 'server_item_id'
> & {
  /** Опционально: id строки на mytoolbox-сервере, если импорт из remote sync. */
  server_item_id?: number | null
}

// ── ms_receipts ──────────────────────────────────────────────────

export type MsReceiptStatus =
  | 'pending'
  | 'matched'
  | 'fiscalized'
  | 'failed'
  | 'manual'
  | 'skipped'
  /**
   * Чек полностью оплачен через Click/Payme/QR — фискальный чек не выдаётся
   * (магазин ведёт такие оплаты отдельно от ОФД). Кассир жмёт «Отметить как
   * не фискальный» когда поле «Сумма через Click/Payme» = rd.sum (вся сумма
   * исключена). Чек остаётся в Истории как notFiscal, не блокирует поллинг.
   */
  | 'not_required'

export interface MsReceiptRow {
  id: number
  ms_id: string
  ms_name: string | null
  ms_moment: EpochSec
  ms_sum_tiyin: Tiyin
  raw_json: string
  status: MsReceiptStatus
  fetched_at: EpochSec
  updated_at: EpochSec
}

export type NewMsReceipt = Omit<MsReceiptRow, 'id' | 'updated_at' | 'status'> & {
  status?: MsReceiptStatus
}

// ── matches & match_items ────────────────────────────────────────

export type MatchStrategy =
  | 'linked-ms'        // через «Бухгалтерское наименование» в характеристике модификации МС
  | 'passthrough'      // ИКПУ из атрибутов МС совпал с inv_item.class_code
  | 'price-bucket'     // подобрано по цене (с подменой ИКПУ)
  | 'multi-item'       // набор товаров на сумму
  | 'manual'

export interface MatchRow {
  id: number
  ms_receipt_id: number
  strategy: MatchStrategy
  total_tiyin: Tiyin
  diff_tiyin: Tiyin
  created_at: EpochSec
  approved_at: EpochSec | null
}

export interface MatchItemRow {
  id: number
  match_id: number
  esf_item_id: number
  quantity: MilliQty
  price_tiyin: Tiyin
  vat_tiyin: Tiyin
}

// ── fiscal_receipts ──────────────────────────────────────────────

export interface FiscalReceiptRow {
  id: number
  ms_receipt_id: number
  match_id: number | null
  terminal_id: string
  receipt_seq: string
  fiscal_sign: string
  qr_code_url: string
  fiscal_datetime: string // YYYYMMDDHHMMSS
  applet_version: string | null
  request_json: string
  response_json: string
  fiscalized_at: EpochSec
  /**
   * Тип карты, выбранный кассиром при первичной фискализации
   * (для печати на ленте). `null` для оплат чисто наличкой и для
   * legacy-чеков до миграции 009.
   *   'fiz'  → «Karta turi: Jismoniy shaxs»
   *   'corp' → «Karta turi: Korporativ»
   * В ОФД не отправляется. Используется на печать в History.tsx и
   * при печати refund-чека (Refund.tsx).
   */
  card_kind: 'fiz' | 'corp' | null
  /**
   * Сумма (тийины) которая была исключена из фискализации как Click/Payme/
   * иной не-фискализируемый электронный платёж. См. migration 010.
   *
   * Чек МойСклад пришёл на сумму X, кассир пометил часть Y как Click/Payme,
   * и в ОФД ушло X − Y. Это поле = Y. Для всех чеков до миграции 010 = 0.
   *
   * Используется для аудита и отчётов «сколько за день было Click/Payme».
   * В refund / reprint не влияет — refund работает с фискальным итогом.
   */
  excluded_payment_tiyin: Tiyin
  /**
   * Денормализованная строка для поиска в Истории (migration 014): имена
   * товаров + ИКПУ + номера чека + фискальный признак, всё в НИЖНЕМ регистре.
   *
   * `null` — чек ещё не прошёл разовый backfill (`backfillSearchText`).
   * Заполняется автоматически при вставке новых чеков.
   */
  search_text: string | null
  /**
   * Отправлен ли чек на mytoolbox через `POST /api/v1/inventory/sales`
   * (migration 015). 0 — ещё нет, 1 — отправлен. См. `src/lib/sales-sync.ts`.
   */
  synced_to_server: number
}

// ── replacement_log ──────────────────────────────────────────────

export interface ReplacementLogRow {
  id: number
  ms_receipt_id: number
  fiscal_receipt_id: number | null
  original_items_json: string
  fiscalized_items_json: string
  reason: string | null
  created_at: EpochSec
}

// ── fiscal_refunds ───────────────────────────────────────────────

/**
 * Чек возврата, отправленный в Communicator + ОФД.
 *
 * Один продажный чек (fiscal_receipts.id) может породить только ОДИН refund
 * на MVP — UNIQUE constraint в БД. В Phase 2 уберём, чтобы можно было
 * возвращать частично несколько раз.
 *
 * Денежные суммы (refund_cash_tiyin, refund_card_tiyin, refund_qr_tiyin) —
 * сколько кассир выдал покупателю. Сумма всех трёх = сумма возврата.
 *
 * items_json — снапшот позиций возврата (структура совпадает с match_items,
 * но это денормализация для аудита, чтобы изменения в match_items не сдвинули
 * этот снапшот).
 */
export interface FiscalRefundRow {
  id: number
  original_fiscal_id: number
  ms_return_id: number | null
  terminal_id: string
  receipt_seq: string
  fiscal_sign: string
  qr_code_url: string
  fiscal_datetime: string // YYYYMMDDHHMMSS
  applet_version: string | null
  items_json: string
  refund_cash_tiyin: Tiyin
  refund_card_tiyin: Tiyin
  refund_qr_tiyin: Tiyin
  request_json: string
  response_json: string
  reason: string | null
  cashier_name: string | null
  refunded_at: EpochSec
  /**
   * 0 = полный возврат всего чека, 1 = частичный (выбраны конкретные товары/qty).
   * Старые refund'ы до миграции 013 = 0.
   */
  is_partial: number
  /**
   * JSON-snapshot выбранных позиций для partial refund.
   * Формат: `[{ originalItemIndex: number, qtyMilli: number, refundTiyin: number }]`
   * NULL для full refund (там items_json содержит ВСЕ items оригинала).
   */
  refunded_items_snapshot: string | null
  /**
   * Отправлен ли возврат на mytoolbox через `POST /api/v1/inventory/sales`
   * (вложенным в `sales[].refunds[]` родительского чека, migration 015).
   * 0 — ещё нет, 1 — отправлен. См. `src/lib/sales-sync.ts`.
   */
  synced_to_server: number
}

/**
 * Состояние возврата по конкретному чеку — для UI History badge + блокировки
 * кнопки «Возврат» когда чек уже полностью возвращён.
 *
 *   - 'none'    — refund'ов нет, можно делать новый
 *   - 'partial' — есть partial refund'ы, можно ещё (qty осталось)
 *   - 'full'    — полностью возвращён, новый refund невозможен
 */
export type RefundState = 'none' | 'partial' | 'full'
