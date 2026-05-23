import {
  createMatch,
  getFiscalReceiptByMsId,
  insertFiscalReceipt,
  setMsReceiptStatus,
  upsertMsReceipt,
  getSetting,
  SettingKey,
} from '@/lib/db'
import { log } from '@/lib/log'
import type { BuildMatchResult, HolisticLine, MatchCandidate } from '@/lib/matcher/types'

/**
 * Унифицированный список «фискальных строк» из BuildMatchResult.
 *
 * - mode='classic'  → flat MatchCandidate'ы из всех positions
 * - mode='holistic' → holistic.lines напрямую
 *
 * Это позволяет коду фискализации/печати/реserve не знать про режим:
 * структура MatchCandidate и HolisticLine идентична (esfItem, quantity,
 * priceTiyin, discountTiyin, vatTiyin).
 */
type FiscalLine = MatchCandidate | HolisticLine

function getEffectiveLines(build: BuildMatchResult): FiscalLine[] {
  if (build.mode === 'holistic' && build.holistic) {
    return build.holistic.lines
  }
  return build.positions.flatMap((pm) => pm.candidates)
}
import {
  deletePendingByReservations,
  getInventoryClient,
  loadInventoryConfig,
  markFiscalOk,
  recordReserved,
  type ReservationInfo,
} from '@/lib/inventory'
import {
  formatPrintDate,
  formatQtyForPrint,
  formatTiyinForPrint,
  printFiscalReceipt,
  type ReceiptData,
} from '@/lib/printer'
import { JsonRpcEposClient, formatGoTime, type JsonRpcReceipt } from './jsonrpc-client'
import type { FiscalReceiptInfo } from './types'

export interface FiscalizeOptions {
  /** Использовать `fastSale` (без печати чека) — только для legacy /uzpos. */
  fast?: boolean
  staffName?: string
  clientTin?: string
  clientPinfl?: string
  cardType?: 1 | 2
  receivedCash?: number
  receivedCard?: number
  msReceiptId?: number
  /**
   * Тип карты для печати на ленте (НЕ уходит в ОФД — JSON-RPC такого
   * аргумента не имеет, см. epos-mobile-api.md).
   *
   * - `'fiz'`  → лента: «Karta turi: Jismoniy shaxs»
   * - `'corp'` → лента: «Karta turi: Korporativ»
   * - `undefined` → строка не печатается
   *
   * Выбирается кассиром в Receipt.tsx через модалку перед фискализацией,
   * только когда есть карточная оплата (`receivedCard > 0`).
   */
  cardKind?: 'fiz' | 'corp'
  /**
   * Сумма (тийины) которую исключить из фискализации как Click/Payme.
   *
   * Когда магазин принимает Click/Payme — эти оплаты НЕ идут в ОФД.
   * Кассир в Receipt.tsx вводит сумму, и фискальный чек строится на
   * `ms_sum − excludePaymentTiyin`. Эта сумма вычитается из noCashSum/qrSum
   * при распределении ReceivedCash/Card; cash не трогается.
   *
   * Сохраняется в `fiscal_receipts.excluded_payment_tiyin` для аудита.
   * Default = 0 (фискализируем всё, как раньше).
   */
  excludePaymentTiyin?: number
}

export interface FiscalizeResult {
  fiscal: FiscalReceiptInfo
  fiscalReceiptDbId: number
  matchDbId: number | null
}

/**
 * Главная функция фискализации.
 *
 * Авто-определяет протокол по URL Communicator:
 *   • URL содержит `/rpc/api` → новый JSON-RPC 2.0 (Api.SendSaleReceipt)
 *   • иначе → legacy /uzpos (sale/fastSale)
 *
 * Все денежные значения и количество приходят уже в правильных единицах
 * (тийины и тысячные).
 */
export async function fiscalize(
  build: BuildMatchResult,
  opts: FiscalizeOptions = {},
): Promise<FiscalizeResult> {
  const eposUrl =
    (await getSetting(SettingKey.EposCommunicatorUrl)) ??
    'http://localhost:3448/rpc/api'
  // EposToken больше не используется (legacy /uzpos удалён). Для JSON-RPC
  // токен не нужен. Поле в Settings оставлено только для обратной
  // совместимости БД старых установок и UI его не показывает.

  const effectiveLines = getEffectiveLines(build)
  if (effectiveLines.length === 0) {
    throw new Error('Нечего отправлять в Communicator: пустой план')
  }

  // ── Defense-in-depth: уже фискализирован? ──────────────────────────
  // UI (Receipt.tsx) уже дизейблит кнопку, но если кассир обойдёт UI
  // (старая вкладка, гонка двойного клика) — здесь жёстко блокируем
  // ДО отправки в Communicator. Двойная фискализация = двойной чек в
  // ОФД + двойное списание остатков + дубль в ГНК.
  if (opts.msReceiptId) {
    const existing = await getFiscalReceiptByMsId(opts.msReceiptId).catch(
      () => null,
    )
    if (existing) {
      throw new AlreadyFiscalizedError(
        existing.fiscal_sign,
        existing.receipt_seq,
      )
    }
  }
  // matchedTotal — сумма к оплате (с учётом скидок если они применены).
  // = sum(priceTiyin - discountTiyin). Совпадает с rd.sum если включена
  // discountForExactSum и хватает запаса по себестоимости.
  // В holistic-режиме — это totalTiyin плана (по конструкции = receipt.sum).
  const matchedTotal = effectiveLines.reduce(
    (s, c) => s + c.priceTiyin - c.discountTiyin,
    0,
  )

  // Тип оплаты — берём из МойСклад (cashSum / noCashSum / qrSum), сумму —
  // из подбора (matchedTotal, после наценки+НДС+округления). Так чек
  // в EPOS/ОФД сходится: сумма items = сумма оплат. Если кассир хочет
  // переопределить (через FiscalizeOptions) — opts.receivedCash/Card
  // выигрывают.
  //
  // opts.excludePaymentTiyin (Click/Payme) — вычитается из noCashSum+qrSum
  // ПЕРЕД пропорциональным split, иначе ReceivedCard был бы завышен
  // относительно фактической фискальной части.
  const excludePayment = Math.max(0, opts.excludePaymentTiyin ?? 0)
  const auto = determinePaymentFromMs(build.receipt, matchedTotal, excludePayment)
  const receivedCash = opts.receivedCash ?? auto.receivedCash
  const receivedCard = opts.receivedCard ?? auto.receivedCard

  // ── Тестовый режим (сухой прогон) ────────────────────────────
  // UI отрабатывает «как будто» фискализация прошла, но в Communicator
  // ничего не уходит, остатки не списываются, fiscal_receipt не создаётся.
  // ПЕЧАТЬ всё равно идёт (если включена авто-печать) — иначе тестовый
  // режим бесполезен для проверки шаблона чека и реквизитов. На ленте
  // вместо «Asli» будет «ТЕСТ — НЕ ФИСКАЛЬНЫЙ ЧЕК», подвал тоже
  // переключается на пометку «ничего не отправлено в ОФД».
  const testMode = (await getSetting(SettingKey.TestMode)) === 'true'
  if (testMode) {
    await log.info(
      'fiscalize',
      'ТЕСТОВЫЙ РЕЖИМ: пропускаю отправку в EPOS Communicator',
      {
        receipt: build.receipt.name,
        items: build.positions.length,
        matchedTotalTiyin: matchedTotal,
      },
    )
    const fakeFiscal: FiscalReceiptInfo = {
      TerminalID: 'TEST-MODE',
      ReceiptSeq: 'TEST',
      FiscalSign: `TEST-${Date.now()}`,
      QRCodeURL: 'тестовый режим: чек НЕ отправлен в ОФД',
      DateTime: formatTestDateTime(new Date()),
      AppletVersion: 'TEST',
    }
    // Печать всё равно отправляем — она не имеет побочных эффектов в ОФД.
    await maybePrintReceipt(
      build,
      fakeFiscal,
      receivedCash,
      receivedCard,
      false,
      true,
      opts.cardKind,
    )
    return { fiscal: fakeFiscal, fiscalReceiptDbId: 0, matchDbId: null }
  }

  // ── Жёсткий guard: ИКПУ обязателен на ВСЁМ пути ──
  // Без MXIK ОФД не начисляет покупателю кешбэк и ГНК штрафует магазин
  // на 1% от суммы (постановление ВМ-255 от 12.05.2022 п.20 ч.5).
  // E-POS Mobile API: `spic` (ИКПУ) — обязательное поле (ошибка E-013).
  //
  // package_code НЕ проверяем — он опциональный (epos-mobile-api.md стр.140
  // помечает packageCode ❌, E-014 только при НЕВЕРНОМ коде). Раньше guard
  // зря блокировал товары с валидным ИКПУ но без кода упаковки. Подтверждено
  // эмпирически: фискализация работала без package_code.
  // Применяется ДО любой работы с сервером (резерв, fiscalize) — иначе
  // потратим время и вернём резерв обратно при failure.
  const noIkpuItems: string[] = []
  for (const c of effectiveLines) {
    if (!c.esfItem.class_code || c.esfItem.class_code.trim() === '') {
      noIkpuItems.push(c.esfItem.name)
    }
  }
  if (noIkpuItems.length > 0) {
    throw new Error(
      `Нельзя фискализировать: у ${noIkpuItems.length} товаров отсутствует ИКПУ. ` +
        `Дозаполните в mytoolbox админке → Inventory → Приходы. ` +
        `Товары: ${noIkpuItems.slice(0, 3).join(', ')}` +
        (noIkpuItems.length > 3 ? ` и ещё ${noIkpuItems.length - 3}` : ''),
    )
  }

  // 1-2. Сохранить ms_receipt и match.
  const { msReceiptId, matchDbId } = await persistMatch(build, effectiveLines, opts)

  // ── Multi-shop: атомарная резервация на сервере ДО EPOS ──────────────
  // Если включён remote-режим (общий пул через mytoolbox), резервируем
  // все позиции на сервере. Это блокирует другие магазины от списания
  // тех же штук. Если 409 — кто-то опередил, кидаем ошибку для re-match.
  const reserveResult = await tryRemoteReserve(
    effectiveLines,
    build.receipt.id ?? msReceiptId.toString(),
  )
  // ────────────────────────────────────────────────────────────────────

  await log.info('fiscalize', `Отправляю чек ${build.receipt.name} в EPOS`, {
    eposUrl,
    items: effectiveLines.length,
    mode: build.mode,
    total: matchedTotal,
    remoteReserved: reserveResult.reservations?.length ?? 0,
  })

  // 3. Pre-flight: версия Communicator в логи (best-effort, не ломает sale).
  let communicatorVersion: string | null = null
  try {
    const probe = new JsonRpcEposClient({ url: eposUrl })
    const status = await probe.status()
    communicatorVersion = JSON.stringify(status).slice(0, 200)
    await log.info('fiscalize', `Communicator status: ${communicatorVersion}`, {
      eposUrl,
    })
  } catch (verErr) {
    const msg = verErr instanceof Error ? verErr.message : String(verErr)
    await log.warn(
      'fiscalize',
      `Не удалось получить статус Communicator (продолжаем sale): ${msg}`,
      { eposUrl },
    )
  }

  // 4. Фискализация — только JSON-RPC `/rpc/api`. Legacy /uzpos удалён в
  // 0.10.13 (актуальные Communicator 3.20+ legacy урезали, всё работает
  // через JSON-RPC). Auto-fallback тоже удалён за ненадобностью.
  let fiscal: FiscalReceiptInfo
  let requestJson: string
  try {
    const result = await fiscalizeJsonRpc(
      eposUrl,
      effectiveLines,
      receivedCash,
      receivedCard,
    )
    fiscal = result.fiscal
    requestJson = result.requestJson
  } catch (eposErr) {
    // Расширенный лог: всё что нужно понять «почему чек не пробился».
    // Сохраняется в БД, видно в Логах, можно прислать саппорту E-POS.
    const errMsg = eposErr instanceof Error ? eposErr.message : String(eposErr)
    const errStack = eposErr instanceof Error ? eposErr.stack : undefined
    const eposExtra = eposErr as { code?: number; data?: unknown }
    await log.error('fiscalize', `❌ Чек НЕ пробился: ${errMsg}`, {
      eposUrl,
      communicatorVersion,
      jsonRpcCode: eposExtra.code,
      jsonRpcData: eposExtra.data,
      errorMessage: errMsg,
      errorStack: errStack,
      itemsCount: effectiveLines.length,
      matcherMode: build.mode,
      matchedTotalTiyin: matchedTotal,
      receivedCash,
      receivedCard,
      // Первые 3 товара с их ИКПУ — для проверки данных
      sampleItems: effectiveLines.slice(0, 3).map((c) => ({
        name: c.esfItem.name,
        class_code: c.esfItem.class_code,
        package_code: c.esfItem.package_code,
        vat_percent: c.esfItem.vat_percent,
        priceTiyin: c.priceTiyin,
      })),
    })

    // EPOS не выдал FiscalSign — отпускаем резерв.
    await releaseRemote(reserveResult.reservations, 'epos-failed').catch(() => {})

    // Смена не открыта — Communicator вернул ERROR_ZREPORT_IS_NOT_OPEN
    // (jsonRpcCode 36909). Подменяем на типизированную ошибку, чтобы UI
    // показал понятное «откройте смену», а не сырой код.
    const dataStr =
      typeof eposExtra.data === 'string'
        ? eposExtra.data
        : JSON.stringify(eposExtra.data ?? '')
    if (
      eposExtra.code === 36909 ||
      /ZREPORT_IS_NOT_OPEN/i.test(errMsg) ||
      /ZREPORT_IS_NOT_OPEN/i.test(dataStr)
    ) {
      throw new ShiftNotOpenError()
    }
    throw eposErr
  }

  await log.info('fiscalize', `Чек фискализирован: ${fiscal.FiscalSign}`, {
    terminalId: fiscal.TerminalID,
    receiptSeq: fiscal.ReceiptSeq,
    qr: fiscal.QRCodeURL,
  })

  // 4. Confirm резерв → server переводит qty_reserved → qty_consumed.
  // Server is authoritative. SSE придёт обратно и обновит локальный кэш.
  await confirmRemote(reserveResult.reservations, fiscal.FiscalSign)

  // 5. Сохранить fiscal_receipt (включая card_kind для refund/reprint flow
  // и excluded_payment_tiyin для аудита Click/Payme).
  const fiscalReceiptDbId = await insertFiscalReceipt({
    ms_receipt_id: msReceiptId,
    match_id: matchDbId,
    terminal_id: fiscal.TerminalID,
    receipt_seq: fiscal.ReceiptSeq,
    fiscal_sign: fiscal.FiscalSign,
    qr_code_url: fiscal.QRCodeURL,
    fiscal_datetime: fiscal.DateTime,
    applet_version: fiscal.AppletVersion ?? null,
    request_json: requestJson,
    response_json: JSON.stringify(fiscal),
    // card_kind пишем только если оплата картой реально была. Для cash-only
    // чеков и тестового режима — null (строка «Karta turi» не печатается).
    card_kind: receivedCard > 0 ? (opts.cardKind ?? null) : null,
    excluded_payment_tiyin: excludePayment,
  })

  // 6. Статус.
  await setMsReceiptStatus(msReceiptId, 'fiscalized')

  // 7. Авто-печать на термопринтер, если включено в Settings.
  // Печать НЕ должна валить фискализацию — чек уже в ОФД, лента это
  // просто удобство для покупателя. Любая ошибка идёт в логи.
  await maybePrintReceipt(
    build,
    fiscal,
    receivedCash,
    receivedCard,
    false,
    false,
    opts.cardKind,
  )

  return { fiscal, fiscalReceiptDbId, matchDbId }
}

/**
 * Смена ККМ не открыта. Communicator отвечает ERROR_ZREPORT_IS_NOT_OPEN
 * (jsonRpcCode 36909) на любой sale/refund при закрытой смене. UI ловит
 * и показывает «Откройте смену» + кнопку в раздел Смена, вместо сырого кода.
 */
export class ShiftNotOpenError extends Error {
  constructor() {
    super(
      'Смена ККМ не открыта. Откройте смену в разделе «Смена» перед фискализацией.',
    )
    this.name = 'ShiftNotOpenError'
  }
}

/**
 * Чек уже был фискализирован ранее. Бросается defense-in-depth guard'ом
 * в `fiscalize()` если кассир обошёл UI-блокировку (старая вкладка,
 * двойной клик). UI ловит и показывает «уже фискализирован FiscalSign…».
 */
export class AlreadyFiscalizedError extends Error {
  constructor(
    public readonly fiscalSign: string,
    public readonly receiptSeq: string,
  ) {
    super(
      `Чек уже фискализирован (FiscalSign ${fiscalSign}, чек № ${receiptSeq}). ` +
        `Повторная фискализация запрещена.`,
    )
    this.name = 'AlreadyFiscalizedError'
  }
}

/**
 * Сервер вернул ошибку Postgres-инварианта `inv_items_check` (qty_consumed +
 * qty_reserved <= qty_received). Это значит локальный кэш справочника
 * рассинхронизирован с сервером — фактического остатка меньше чем мы думали.
 *
 * Отличается от `InventoryConflictError` тем что сервер не вернул `failed[]` —
 * мы не знаем какой конкретно товар «застрял». Поэтому UI делает полную
 * пересинхронизацию справочника + перематч, вместо exclude-логики.
 */
export class InventoryStaleError extends Error {
  constructor() {
    super(
      'Остатки на сервере изменились. Обновляем справочник и пересобираем чек…',
    )
    this.name = 'InventoryStaleError'
  }
}

/**
 * Многошаговая ошибка: «не хватило остатков на сервере».
 * UI ловит её и показывает «товар закончился, перематчите».
 */
export class InventoryConflictError extends Error {
  constructor(public readonly failed: Array<{ inv_item_id: number; available: number; requested: number }>) {
    super(
      `Недостаточно остатков на ${failed.length} позициях — кто-то опередил. ` +
        `Перезагрузите подбор и попробуйте снова.`,
    )
    this.name = 'InventoryConflictError'
  }
}

/**
 * Резервируем все позиции чека на сервере атомарно ДО фискализации.
 *
 * Remote-режим обязателен — другого пути в 0.10+ не существует. Если
 * inventory server не сконфигурирован, кидается понятная ошибка
 * (`InventoryNotConfiguredError`) — кассир увидит «настройте сервер».
 *
 * Если в кандидатах есть строка с `server_item_id = NULL` — она была
 * импортирована локально до миграции. Кидаем ошибку с подсказкой
 * сделать миграцию через Catalog → «Перенести в общий пул».
 *
 * При 409 от сервера (`INSUFFICIENT_STOCK`) — `InventoryConflictError`
 * с failed item_ids; UI ловит и автоматически перематчивает.
 */
async function tryRemoteReserve(
  effectiveLines: FiscalLine[],
  ms_receipt_id: string,
): Promise<{ reservations: ReservationInfo[] }> {
  const cfg = await loadInventoryConfig()
  if (!cfg) {
    throw new InventoryNotConfiguredError(
      'Inventory сервер не настроен. Откройте Настройки и подключитесь.',
    )
  }

  const client = await getInventoryClient()
  if (!client) {
    throw new InventoryNotConfiguredError(
      'Inventory клиент не инициализирован. Откройте Настройки.',
    )
  }

  // Собираем (server_item_id, quantity) пары. Локальные строки без
  // server_item_id блокируют — миграция через Catalog обязательна.
  // В holistic-режиме строки могут «дублироваться» по esfItem (если фаза 2 DP
  // подобрала несколько штук одного SKU + фаза 1 тоже взяла тот же SKU) —
  // server.reserve атомарно складывает их по inv_item_id, конфликта нет.
  const items: { inv_item_id: number; quantity: number }[] = []
  for (const c of effectiveLines) {
    const sid = c.esfItem.server_item_id
    if (sid == null) {
      throw new Error(
        `Приход «${c.esfItem.name}» импортирован локально (старый Excel-импорт). ` +
          `Откройте Справочник → «Перенести в общий пул» чтобы включить в общий пул.`,
      )
    }
    items.push({ inv_item_id: sid, quantity: c.quantity })
  }

  let resp
  try {
    resp = await client.reserve({ ms_receipt_id, items })
  } catch (e) {
    // Сервер может вернуть Postgres-инвариант inv_items_check (qty_consumed +
    // qty_reserved <= qty_received) сырым текстом если сам не успел проверить
    // available и UPDATE упал на constraint. Это значит локальный кэш
    // справочника разъехался с сервером. Конвертируем в InventoryStaleError
    // — UI сделает forceFull sync + перематчит.
    const msg = e instanceof Error ? e.message : String(e)
    if (/inv_items_check|violates check constraint/i.test(msg)) {
      throw new InventoryStaleError()
    }
    throw e
  }
  if (!resp.ok) {
    throw new InventoryConflictError(resp.failed)
  }

  // Записываем pending-confirms ДО EPOS — на случай падения программы
  // между reserve и EPOS, или между EPOS и confirm.
  for (const r of resp.reservations) {
    await recordReserved(r.reservation_id, ms_receipt_id).catch((e) => {
      log.warn('fiscalize', `recordReserved failed: ${e?.message ?? e}`).catch(() => {})
    })
  }
  return { reservations: resp.reservations }
}

/** Inventory server не сконфигурирован — UI показывает с deep-link на Настройки. */
export class InventoryNotConfiguredError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InventoryNotConfiguredError'
  }
}

/**
 * После успеха EPOS: confirm на сервере + удаление pending-записей.
 * Если confirm не дошёл — оставляем как 'fiscal-ok' в pending для retry
 * на следующем старте программы. Чек уже в ОФД, фискализация состоялась.
 */
async function confirmRemote(reservations: ReservationInfo[], fiscal_sign: string): Promise<void> {
  const ids = reservations.map((r) => r.reservation_id)
  // Сначала помечаем 'fiscal-ok' с подписью — чтобы retry-механизм знал
  // что эти резервации УЖЕ в ОФД и подтверждение обязательно.
  await markFiscalOk(ids, fiscal_sign).catch((e) =>
    log.warn('fiscalize', `markFiscalOk failed: ${e?.message ?? e}`).catch(() => {}),
  )

  const client = await getInventoryClient()
  if (!client) return

  try {
    const resp = await client.confirm({ reservation_ids: ids, fiscal_sign })
    if (resp.ok) {
      await deletePendingByReservations(ids).catch(() => {})
    } else {
      // Это плохой сценарий: фискальный чек в ОФД, но сервер inventory отказал.
      // Оставляем pending — админ разберёт. retry-механизм попробует ещё раз.
      await log.warn('fiscalize', `Inventory confirm failed (code=${resp.code})`, resp)
    }
  } catch (e) {
    // Сетевая ошибка — pending остаётся со status='fiscal-ok'. На старте
    // программы retry.runInventoryHousekeeping() переотправит.
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('fiscalize', `Inventory confirm threw: ${msg}`)
  }
}

/** Отпустить резервации (EPOS не выдал FiscalSign). Best-effort, не throw. */
async function releaseRemote(
  reservations: ReservationInfo[],
  reason: string,
): Promise<void> {
  const client = await getInventoryClient()
  if (!client) return
  const ids = reservations.map((r) => r.reservation_id)
  try {
    await client.release({ reservation_ids: ids, reason })
    await deletePendingByReservations(ids).catch(() => {})
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('fiscalize', `Inventory release threw: ${msg}`)
    // pending запись останется — на старте retry попробует освободить.
  }
}

/**
 * Определить тип оплаты по чеку МС.
 *
 * Логика:
 *   - Только `cashSum > 0` → всё в `ReceivedCash`
 *   - Только `noCashSum`/`qrSum` > 0 → всё в `ReceivedCard`
 *   - Смешанная (есть и нал, и безнал) → пропорция от matchedTotal:
 *       cashShare = cashSum / (cashSum + noCashSum + qrSum)
 *       receivedCash = round(matchedTotal × cashShare)
 *       receivedCard = matchedTotal - receivedCash  (остаток, чтобы суммы
 *                                                   совпадали тийин-в-тийин)
 *   - Все три = 0 (странный случай) → fallback на нал
 *
 * Сумму берём именно из подбора (после наценки+НДС+округления), а не
 * `rd.sum` — иначе сумма items не равна сумме оплат и Communicator/ОФД
 * могут отвергнуть чек как несбалансированный.
 *
 * Пример (смешанная):
 *   МС: cashSum=10000, noCashSum=5000 (15000 = 10к нал + 5к карта)
 *   matchedTotal=1800000 (18к сум продажной цены)
 *   cashShare = 10000/15000 = 0.667
 *   receivedCash = round(1800000 × 0.667) = 1200600
 *   receivedCard = 1800000 - 1200600 = 599400
 */
function determinePaymentFromMs(
  rd: import('@/lib/moysklad/types').MsRetailDemand,
  matchedTotal: number,
  excludeFromNonCash: number = 0,
): { receivedCash: number; receivedCard: number } {
  const cash = rd.cashSum ?? 0
  const rawCard = (rd.noCashSum ?? 0) + (rd.qrSum ?? 0)
  // excludeFromNonCash — это сумма Click/Payme которую кассир пометил как
  // НЕ фискализируется (она была в noCashSum/qrSum МС). Вычитаем её ИЗ карты:
  // оставшаяся часть rawCard − exclude фискализируется как ReceivedCard.
  // Cash не трогаем — клиент действительно дал нал, эта часть фискальная.
  // Если exclude > rawCard — кэп до rawCard (защита от отрицательной карты).
  const effectiveCardSrc = Math.max(0, rawCard - Math.max(0, excludeFromNonCash))
  const total = cash + effectiveCardSrc

  // Все нули — fallback на нал.
  if (total <= 0) {
    return { receivedCash: matchedTotal, receivedCard: 0 }
  }
  // Только нал (после вычета exclude из карты — карты не осталось).
  if (effectiveCardSrc === 0) {
    return { receivedCash: matchedTotal, receivedCard: 0 }
  }
  // Только безнал (карта/QR), нала не было.
  if (cash === 0) {
    return { receivedCash: 0, receivedCard: matchedTotal }
  }
  // Смешанная — пропорционально по cash/card соотношению ПОСЛЕ exclude.
  // Остаток уходит в карту чтобы тийины не потерялись при округлении.
  const receivedCash = Math.round((matchedTotal * cash) / total)
  const receivedCard = matchedTotal - receivedCash
  return { receivedCash, receivedCard }
}

/**
 * Формат DateTime в стиле YYYYMMDDHHMMSS — как у реальных фискальных ответов.
 * Используется только в тестовом режиме, чтобы UI History корректно
 * парсил «фейковый» чек (если он туда попадёт).
 */
function formatTestDateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  )
}

/**
 * Если в настройках включена авто-печать и выбран принтер — собрать
 * полные данные чека (реквизиты компании, позиции, итоги, фискальные
 * данные) и отправить на термопринтер. Ошибки логируются, но наверх
 * не пробрасываются: чек уже в ОФД, лента — это удобство для покупателя.
 *
 * Используется и при первой фискализации, и при перепечати из Истории.
 */
export async function maybePrintReceipt(
  build: BuildMatchResult,
  fiscal: FiscalReceiptInfo,
  receivedCash: number,
  receivedCard: number,
  isCopy: boolean,
  isTest: boolean = false,
  cardKind?: 'fiz' | 'corp',
): Promise<void> {
  try {
    const enabled = (await getSetting(SettingKey.PrinterAutoPrint)) === 'true'
    if (!enabled) {
      await log.info(
        'fiscalize',
        'Печать пропущена: авто-печать выключена в Настройках → Печать чека',
      )
      return
    }
    const printerName = await getSetting(SettingKey.PrinterName)
    if (!printerName) {
      await log.warn(
        'fiscalize',
        'Печать пропущена: авто-печать включена, но принтер не выбран',
      )
      return
    }

    const data = await buildReceiptData(
      build,
      fiscal,
      receivedCash,
      receivedCard,
      isCopy,
      isTest,
      cardKind,
    )
    const jobId = await printFiscalReceipt(printerName, data)
    await log.info('fiscalize', `Чек отправлен на печать (job #${jobId})`, {
      printer: printerName,
      isCopy,
      isTest,
    })
  } catch (err) {
    await log.error('fiscalize', 'Ошибка печати чека', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Собрать ReceiptData для термопринтера из match + ответа Communicator + Settings.
 * Все денежные значения форматируются в строки «1 234.56» под печать.
 */
async function buildReceiptData(
  build: BuildMatchResult,
  fiscal: FiscalReceiptInfo,
  receivedCash: number,
  receivedCard: number,
  isCopy: boolean,
  isTest: boolean,
  cardKind?: 'fiz' | 'corp',
): Promise<ReceiptData> {
  const company = await readCompanySettings()
  const cashier = (await getSetting(SettingKey.MoyskladEmployeeName)) ?? ''
  const effectiveLines = getEffectiveLines(build)

  // Все позиции — после подмены, по продажным ценам, со скидкой если есть.
  // На ленте: Price = до скидки, Discount = размер скидки (показывается
  // отдельной строкой на принтере если > 0).
  const items = effectiveLines.map((c) => ({
    name: c.esfItem.name,
    class_code: c.esfItem.class_code,
    qty_str: formatQtyForPrint(c.quantity),
    price_str: formatTiyinForPrint(c.priceTiyin),
    // Пустая строка если скидки нет — Rust пропустит строку «Skidka».
    discount_str:
      c.discountTiyin > 0 ? formatTiyinForPrint(c.discountTiyin) : '',
    vat_str: formatTiyinForPrint(c.vatTiyin),
    vat_percent: c.esfItem.vat_percent,
  }))

  // Итог = сумма (price - discount) по всем строкам — то что покупатель
  // реально платит и что должно совпасть с receivedCash + receivedCard.
  const totalTiyin = effectiveLines.reduce(
    (s, c) => s + c.priceTiyin - c.discountTiyin,
    0,
  )
  const totalVatTiyin = effectiveLines.reduce((s, c) => s + c.vatTiyin, 0)

  return {
    is_copy: isCopy,
    is_test: isTest,
    company: {
      name: company.name || '',
      address: company.address || '',
      phone: company.phone || '',
      inn: company.inn || '',
    },
    receipt_seq: fiscal.ReceiptSeq,
    date_str: formatPrintDate(fiscal.DateTime),
    items,
    total_str: formatTiyinForPrint(totalTiyin),
    total_vat_str: formatTiyinForPrint(totalVatTiyin),
    cash_str: formatTiyinForPrint(receivedCash),
    card_str: formatTiyinForPrint(receivedCard),
    // Печатается «Karta turi: …» только если кассир выбрал тип в модалке
    // и оплата картой реально была. Если receivedCard=0 — Rust всё равно
    // не вставит строку (доп. defensive check) благодаря пустому karta_turi.
    karta_turi: receivedCard > 0 ? (cardKind ?? '') : '',
    cashier,
    terminal_id: fiscal.TerminalID,
    fiscal_sign: fiscal.FiscalSign,
    virtual_kassa: fiscal.DateTime,
    qr_url: fiscal.QRCodeURL,
  }
}


// ── Реализация для нового JSON-RPC :3448/rpc/api ──────────────────────

async function fiscalizeJsonRpc(
  url: string,
  effectiveLines: FiscalLine[],
  receivedCash: number,
  receivedCard: number,
): Promise<{ fiscal: FiscalReceiptInfo; requestJson: string }> {
  // Guard ИКПУ перенесён на верхний уровень `fiscalize()` (см. там же,
  // он срабатывает ДО резервации). Здесь — точка построения JSON-RPC payload.
  // effectiveLines содержит либо все candidates из всех positions (classic),
  // либо holistic.lines напрямую — формат идентичный.

  const items = effectiveLines.map((c) => ({
    Price: c.priceTiyin,           // продажная сумма ДО скидки за всё quantity
    Discount: c.discountTiyin,     // размер скидки в тийинах (0 если без скидки)
    Barcode: c.esfItem.barcode ?? '0',
    Amount: c.quantity,
    // VAT уже пересчитан в matcher с учётом скидки = (price-discount) × % / (100+%)
    VAT: c.vatTiyin,
    Name: c.esfItem.name,
    Other: 0,
    // 🎯 ИМЯ ПОЛЕЙ ПОДТВЕРЖДЕНО реальной фискализацией с TerminalID
    // VG343420011189 в 0.10.12: spic = MXIK, packageCode = код упаковки.
    // Источник имени `spic`: docs.epos.uz/ru/mobile-api/receipts-sale.
    // НЕ менять без проверки — иначе MXIK перестанет доходить до ОФД.
    spic: c.esfItem.class_code,
    // package_code опционален: если его нет — шлём '' (E-POS трактует
    // отсутствие как «не задано», E-014 только при НЕВЕРНОМ коде).
    // null/undefined в JSON мог бы сериализоваться как `null` —
    // нормализуем к пустой строке.
    packageCode: c.esfItem.package_code || '',
    VATPercent: c.esfItem.vat_percent,
    OwnerType: c.esfItem.owner_type,
  }))

  const receipt: JsonRpcReceipt = {
    // Go-style "2026-05-01 15:30:00" с ПРОБЕЛОМ. ISO с T парсер
    // Communicator не понимает: "cannot parse \"T05:47:34\" as \" \"".
    // Локальное время (а не UTC) — Communicator работает в TZ терминала.
    Time: formatGoTime(new Date()),
    Items: items,
    ReceivedCash: receivedCash,
    ReceivedCard: receivedCard,
  }

  const client = new JsonRpcEposClient({ url })
  const requestJson = JSON.stringify({
    jsonrpc: '2.0',
    method: 'Api.SendSaleReceipt',
    params: { Receipt: receipt },
  })

  // Полный дамп ЗАПРОСА в логи — без этого ошибки от Communicator
  // («illegal argument» и т.п.) непонятно к какому полю относятся.
  await log.info('fiscalize', 'Отправляю Api.SendSaleReceipt в Communicator', {
    url,
    request: receipt,
    itemsCount: receipt.Items.length,
  })

  let answer
  try {
    answer = await client.sendSaleReceipt(receipt)
  } catch (e) {
    // При ошибке тоже дампим всё — request + текст ошибки + любой data из JSON-RPC.
    const eposError = e as { code?: number; data?: unknown; message?: string }
    await log.error('fiscalize', 'JSON-RPC EPOS вернул ошибку', {
      error: e instanceof Error ? e.message : String(e),
      url,
      jsonRpcCode: eposError.code,
      jsonRpcData: eposError.data,
      request: receipt,
      requestJson,
    })
    throw e
  }

  // Успех — полный ответ тоже в логи на уровне info, чтобы потом
  // можно было сравнить с тем что уехало в ОФД.
  await log.info('fiscalize', 'JSON-RPC EPOS успешно ответил', {
    response: answer,
  })

  const fiscal: FiscalReceiptInfo = {
    TerminalID: answer.TerminalID,
    ReceiptSeq: answer.ReceiptSeq,
    DateTime: typeof answer.DateTime === 'string'
      ? answer.DateTime
      : new Date(answer.DateTime).toISOString(),
    FiscalSign: answer.FiscalSign,
    AppletVersion: answer.AppletVersion,
    QRCodeURL: answer.QRCodeURL,
  }
  return { fiscal, requestJson }
}

// ── Helpers ────────────────────────────────────────────────────────

async function persistMatch(
  build: BuildMatchResult,
  effectiveLines: FiscalLine[],
  opts: FiscalizeOptions,
): Promise<{ msReceiptId: number; matchDbId: number | null }> {
  let msReceiptId: number
  if (opts.msReceiptId) {
    msReceiptId = opts.msReceiptId
  } else {
    msReceiptId = await upsertMsReceipt({
      ms_id: build.receipt.id,
      ms_name: build.receipt.name,
      ms_moment: 0,
      ms_sum_tiyin: build.receipt.sum,
      raw_json: JSON.stringify(build.receipt),
      fetched_at: Math.floor(Date.now() / 1000),
    })
  }

  // В match_items сохраняем сумму К ОПЛАТЕ (price - discount) — то что
  // покупатель реально заплатил по этой позиции. discount как отдельное
  // поле в схеме БД сейчас нет, но это фиксируется в request_json.
  // В holistic-режиме сохраняем именно фискальные строки (holistic.lines)
  // — они и есть то, что ушло в ОФД.
  const matchItems = effectiveLines.map((c) => ({
    esf_item_id: c.esfItem.id,
    quantity: c.quantity,
    price_tiyin: c.priceTiyin - c.discountTiyin,
    vat_tiyin: c.vatTiyin,
  }))

  // В holistic-режиме strategy на уровне match — это 'price-bucket' по сути
  // (подбор по цене с подменой ИКПУ), хотя реально это глобальный coin-change.
  // Чтобы не плодить новый enum в БД, помечаем как 'price-bucket' для
  // отчётности (см. MatchStrategy). UI знает истинный режим через
  // build.mode и показывает «holistic».
  const strategyForDb =
    build.mode === 'holistic' ? 'price-bucket' : build.overallStrategy

  const matchDbId =
    matchItems.length > 0
      ? await createMatch({
          ms_receipt_id: msReceiptId,
          strategy: strategyForDb,
          total_tiyin: build.matchedTotalTiyin,
          diff_tiyin: build.totalDiffTiyin,
          items: matchItems,
        })
      : null

  return { msReceiptId, matchDbId }
}

interface CompanySettings {
  name: string
  inn: string
  address: string
  phone: string | null
}

async function readCompanySettings(): Promise<CompanySettings> {
  const name = await getSetting(SettingKey.CompanyName)
  const inn = await getSetting(SettingKey.CompanyInn)
  const address = await getSetting(SettingKey.CompanyAddress)
  const phone = await getSetting(SettingKey.CompanyPhone)

  if (!name || !inn || !address) {
    throw new Error(
      'Реквизиты компании не заполнены (для legacy /uzpos API). Откройте «Настройки».',
    )
  }
  return { name, inn, address, phone }
}
