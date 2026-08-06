/**
 * sales-sync — чистые функции сборки payload для POST /api/v1/inventory/sales.
 *
 * Не трогаем БД/сеть — только маппинг данных, по тому же принципу что
 * `src/lib/db/__tests__` тестируют `receipt-search.ts` без SQLite.
 */
import { describe, expect, it } from 'vitest'
import {
  buildMsItems,
  buildRefundPayload,
  buildSaleEntry,
  buildSaleItems,
  toIso,
  type EsfJoinInfo,
} from '../sales-sync'
import { parseRequestJsonReceipt } from '@/lib/epos/request-json'
import type { FiscalReceiptRow, FiscalRefundRow } from '@/lib/db/types'
import type { MsRetailDemand } from '@/lib/moysklad/types'

// ── Фикстуры request_json (те же форматы что и в epos/__tests__/request-json.test.ts) ──

const EPOS_JSON = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'Api.SendSaleReceipt',
  params: {
    Receipt: {
      Time: '2026-07-24 17:19:00',
      ReceivedCash: 3500000,
      ReceivedCard: 20000000,
      Items: [
        {
          Name: 'Коронка алмазного сверления',
          Price: 23500000,
          Discount: 1000000,
          Amount: 1000,
          VAT: 2517857,
          VATPercent: 12,
          spic: '08207001007000000',
          packageCode: '1435794',
        },
      ],
    },
  },
})

const FDS_JSON = JSON.stringify({
  factoryId: 'FDS_FACTORY_1',
  receipt: {
    Time: '2026-07-24 17:19:00',
    ReceivedCash: 3500000,
    ReceivedCard: 20000000,
    Type: 0,
    Operation: 0,
    Items: [
      {
        Name: 'Коронка алмазного сверления',
        Barcode: '0',
        SPIC: '08207001007000000',
        Units: 796,
        PackageCode: '1435794',
        OwnerType: 0,
        Amount: 1000,
        Price: 23500000,
        Discount: 0,
        Other: 0,
        VATPercent: 12,
        VAT: 2517857,
      },
    ],
  },
})

// Два товара в чеке — используем для проверки сопоставления по порядку.
const EPOS_JSON_TWO_ITEMS = JSON.stringify({
  params: {
    Receipt: {
      Time: '2026-07-24 17:19:00',
      ReceivedCash: 1000000,
      ReceivedCard: 0,
      Items: [
        {
          Name: 'Товар A',
          Price: 600000,
          Discount: 0,
          Amount: 1000,
          VAT: 64286,
          VATPercent: 12,
          spic: '11111111111111111',
          packageCode: 'PKG-A',
        },
        {
          Name: 'Товар B',
          Price: 400000,
          Discount: 0,
          Amount: 2000,
          VAT: 42857,
          VATPercent: 12,
          spic: '22222222222222222',
          packageCode: 'PKG-B',
        },
      ],
    },
  },
})

// Чеки, пробитые ДО 0.10.13 через legacy `/uzpos` — верхний уровень
// `{token, method, params:{items, receivedCash, receivedCard}, extraInfo}`
// вместо `params.Receipt`. `parseRequestJsonReceipt` этот формат не знает
// (ищет только `params.Receipt` / `receipt`) → возвращает null. Раньше это
// приводило к тому что `buildSaleEntry` тоже отдавал null и чек навсегда
// зависал в очереди (BLOCKER, см. buildSaleEntry regression-тесты ниже).
// `extraInfo` содержит ПД клиента (`tin`/`pinfl`) — специально включены
// узнаваемые значения, чтобы тест мог убедиться что они НЕ попадают в payload.
const LEGACY_UZPOS_JSON = JSON.stringify({
  token: 'legacy-fixed-token',
  method: 'sale',
  params: {
    items: [
      {
        name: 'Товар легаси (до 0.10.13)',
        classCode: '08207001007000000',
        amount: 1000,
        price: 500000,
        discount: 0,
        vat: 53571,
        vatPercent: 12,
      },
    ],
    receivedCash: 500000,
    receivedCard: 0,
  },
  extraInfo: {
    tin: '987654321',
    pinfl: '11122233344455',
    cardType: 2,
  },
})

describe('toIso', () => {
  // Ожидания зафиксированы СТРОКОЙ (через тот же `new Date(y, m-1, d, ...).
  // toISOString()`, каким должна пользоваться реализация для локальных
  // форматов), а не через getHours()/getMonth(). Раньше тесты проверяли
  // только компоненты после round-trip обратно в Date — это проходило бы
  // одинаково что для `new Date(y, m-1, ...)` (локальное время), что для
  // `Date.UTC(...)` (что было бы БАГОМ), если TZ ранера случайно = UTC:
  // getHours() их бы не отличил. Сравнение полной ISO-строки различает
  // реализации в любом TZ, а Z-суффикс тесты ниже вообще не зависят от TZ
  // ранера (абсолютное время) — это прямой регресс-тест на баг «Z тихо
  // отбрасывается нежаякоренным regex'ом».
  it('14 цифр YYYYMMDDHHMMSS → ISO, парсится как ЛОКАЛЬНОЕ время', () => {
    const iso = toIso('20260516095418', 0)
    expect(iso).toBe(new Date(2026, 4, 16, 9, 54, 18).toISOString())
  })

  it('Go-style "YYYY-MM-DD HH:MM:SS" (с пробелом) → ISO, локальное время', () => {
    const iso = toIso('2026-05-16 09:54:18', 0)
    expect(iso).toBe(new Date(2026, 4, 16, 9, 54, 18).toISOString())
  })

  it('ISO с разделителем T тоже распознаётся, локальное время', () => {
    const iso = toIso('2026-05-16T09:54:18', 0)
    expect(iso).toBe(new Date(2026, 4, 16, 9, 54, 18).toISOString())
  })

  it('ISO с миллисекундами без зоны — тоже локальное время', () => {
    const iso = toIso('2026-05-16T09:54:18.123', 0)
    expect(iso).toBe(new Date(2026, 4, 16, 9, 54, 18).toISOString())
  })

  // Регресс на баг: раньше нежаякоренный regex матчил префикс
  // "2026-05-16T04:54:18" и тихо отбрасывал ".000Z" — UTC-время
  // трактовалось как локальное (ошибка в несколько часов). Строка с Z —
  // АБСОЛЮТНОЕ время, ожидание не зависит от TZ ранера.
  it('строка с Z-суффиксом → парсится как UTC через Date.parse, НЕ как локальное', () => {
    const iso = toIso('2026-05-16T04:54:18.000Z', 0)
    expect(iso).toBe('2026-05-16T04:54:18.000Z')
  })

  it('строка с offset ±HH:MM → парсится с учётом смещения', () => {
    const iso = toIso('2026-05-16T09:54:18+05:00', 0)
    // 09:54:18 +05:00 = 04:54:18 UTC
    expect(iso).toBe('2026-05-16T04:54:18.000Z')
  })

  it('нераспознанный формат → fallback на epoch секунды', () => {
    const fallbackSec = 1_700_000_000
    const iso = toIso('garbage', fallbackSec)
    expect(iso).toBe(new Date(fallbackSec * 1000).toISOString())
  })

  it('null/undefined → fallback', () => {
    const fallbackSec = 1_700_000_000
    expect(toIso(null, fallbackSec)).toBe(new Date(fallbackSec * 1000).toISOString())
    expect(toIso(undefined, fallbackSec)).toBe(new Date(fallbackSec * 1000).toISOString())
  })
})

describe('buildSaleItems — маппинг request_json (EPOS/FDS) в items[]', () => {
  it('EPOS формат: name/class_code/qty/price/discount/vat берутся из request_json', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON)
    expect(parsed).not.toBeNull()

    const items = buildSaleItems(parsed!.items, [], new Map(), 'passthrough')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      name: 'Коронка алмазного сверления',
      class_code: '08207001007000000',
      qty_milli: 1000,
      price_tiyin: 23500000,
      discount_tiyin: 1000000,
      vat_tiyin: 2517857,
      vat_percent: 12,
      strategy: 'passthrough',
      ms_name: null,
      ms_price_tiyin: null,
    })
  })

  it('FDS формат (SPIC PascalCase) → class_code смаппился так же как EPOS', () => {
    const parsed = parseRequestJsonReceipt(FDS_JSON)
    expect(parsed).not.toBeNull()

    const items = buildSaleItems(parsed!.items, [], new Map(), null)

    expect(items).toHaveLength(1)
    expect(items[0]!.class_code).toBe('08207001007000000')
    expect(items[0]!.price_tiyin).toBe(23500000)
    expect(items[0]!.strategy).toBeNull()
    // Без match_items join — обогащение esf_items недоступно.
    expect(items[0]!.package_code).toBeNull()
    expect(items[0]!.inv_item_id).toBeNull()
    expect(items[0]!.unit_cost_tiyin).toBeNull()
  })
})

describe('buildSaleItems — сопоставление match_items с позициями по порядку', () => {
  it('количество совпало → обогащение по индексу (match_items.id ASC ↔ items[i])', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON_TWO_ITEMS)
    expect(parsed).not.toBeNull()

    const matchItemsOrdered = [{ esfItemId: 101 }, { esfItemId: 202 }]
    const esfInfo = new Map<number, EsfJoinInfo>([
      [101, { serverItemId: 9001, unitPriceTiyin: 500000, packageCode: 'ESF-PKG-101' }],
      [202, { serverItemId: 9002, unitPriceTiyin: 300000, packageCode: 'ESF-PKG-202' }],
    ])

    const items = buildSaleItems(parsed!.items, matchItemsOrdered, esfInfo, 'multi-item')

    expect(items).toHaveLength(2)
    // Товар A (индекс 0) ↔ esfItemId 101
    expect(items[0]).toMatchObject({
      name: 'Товар A',
      inv_item_id: 9001,
      unit_cost_tiyin: 500000,
      package_code: 'ESF-PKG-101',
    })
    // Товар B (индекс 1) ↔ esfItemId 202
    expect(items[1]).toMatchObject({
      name: 'Товар B',
      inv_item_id: 9002,
      unit_cost_tiyin: 300000,
      package_code: 'ESF-PKG-202',
    })
  })

  it('esf_item_id из match_items не найден в карте (удалён/soft-void) → null поля для этой позиции', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON_TWO_ITEMS)
    const matchItemsOrdered = [{ esfItemId: 101 }, { esfItemId: 999 }] // 999 отсутствует в карте
    const esfInfo = new Map<number, EsfJoinInfo>([
      [101, { serverItemId: 9001, unitPriceTiyin: 500000, packageCode: 'ESF-PKG-101' }],
    ])

    const items = buildSaleItems(parsed!.items, matchItemsOrdered, esfInfo, 'multi-item')

    expect(items[0]!.inv_item_id).toBe(9001)
    expect(items[1]!.inv_item_id).toBeNull()
    expect(items[1]!.unit_cost_tiyin).toBeNull()
    expect(items[1]!.package_code).toBeNull()
  })
})

describe('buildSaleItems — поведение при несовпадении количества строк', () => {
  it('match_items короче чем items[] (manual picker / ручная замена без записи match_items) → все esf-поля null, но сами позиции не теряются', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON_TWO_ITEMS)
    const matchItemsOrdered = [{ esfItemId: 101 }] // только 1 из 2

    const items = buildSaleItems(
      parsed!.items,
      matchItemsOrdered,
      new Map<number, EsfJoinInfo>([[101, { serverItemId: 1, unitPriceTiyin: 1, packageCode: 'X' }]]),
      'multi-item',
    )

    expect(items).toHaveLength(2)
    for (const it of items) {
      expect(it.inv_item_id).toBeNull()
      expect(it.unit_cost_tiyin).toBeNull()
      expect(it.package_code).toBeNull()
    }
    // Позиции (имя/цена/скидка/ндс) всё равно на месте — просто без обогащения.
    expect(items[0]!.name).toBe('Товар A')
    expect(items[1]!.name).toBe('Товар B')
  })

  it('match_items длиннее чем items[] (расхождение после swap) → тоже все esf-поля null', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON) // 1 позиция
    const matchItemsOrdered = [{ esfItemId: 101 }, { esfItemId: 202 }] // 2 строки

    const items = buildSaleItems(
      parsed!.items,
      matchItemsOrdered,
      new Map<number, EsfJoinInfo>([
        [101, { serverItemId: 1, unitPriceTiyin: 1, packageCode: 'X' }],
        [202, { serverItemId: 2, unitPriceTiyin: 2, packageCode: 'Y' }],
      ]),
      'multi-item',
    )

    expect(items).toHaveLength(1)
    expect(items[0]!.inv_item_id).toBeNull()
  })

  it('пустой match_items при непустых items[] (match_id=null, passthrough без записи) → esf-поля null', () => {
    const parsed = parseRequestJsonReceipt(EPOS_JSON)
    const items = buildSaleItems(parsed!.items, [], new Map(), 'passthrough')
    expect(items).toHaveLength(1)
    expect(items[0]!.inv_item_id).toBeNull()
  })
})

describe('buildMsItems', () => {
  function makeRd(overrides?: Partial<MsRetailDemand>): MsRetailDemand {
    return {
      meta: { href: 'https://api.moysklad.ru/entity/retaildemand/1', type: 'retaildemand' },
      id: 'ms-uuid-1',
      accountId: 'acc-1',
      updated: '2026-01-01 00:00:00.000',
      name: '00001',
      moment: '2026-01-01 00:00:00.000',
      applicable: true,
      printed: false,
      published: false,
      rate: { currency: { meta: { href: '', type: 'currency' } } },
      sum: 1000000,
      vatSum: 0,
      vatEnabled: false,
      vatIncluded: false,
      retailShift: { meta: { href: '', type: 'retailshift' } },
      retailStore: { meta: { href: '', type: 'retailstore' } },
      organization: { meta: { href: '', type: 'organization' } },
      agent: { meta: { href: '', type: 'counterparty' } },
      positions: {
        meta: {
          href: '',
          type: 'retaildemandposition',
          mediaType: 'application/json',
        },
        rows: [
          {
            meta: { href: '', type: 'retaildemandposition' },
            id: 'pos-1',
            accountId: 'acc-1',
            quantity: 2,
            price: 500000,
            discount: 0,
            vat: 12,
            vatEnabled: true,
            assortment: {
              meta: { href: '', type: 'product' },
              id: 'prod-1',
              name: 'Дрель Makita',
            },
          },
        ],
      },
      ...overrides,
    }
  }

  it('извлекает name/qty_milli/total_tiyin из raw_json (через extractPositions)', () => {
    const rd = makeRd()
    const items = buildMsItems(JSON.stringify(rd))
    expect(items).toEqual([{ name: 'Дрель Makita', qty_milli: 2000, total_tiyin: 1000000 }])
  })

  it('битый JSON → пустой массив, не бросает', () => {
    expect(buildMsItems('{not valid json')).toEqual([])
  })

  it('null/undefined raw_json → пустой массив', () => {
    expect(buildMsItems(null)).toEqual([])
    expect(buildMsItems(undefined)).toEqual([])
  })
})

describe('buildRefundPayload', () => {
  function makeRefund(overrides?: Partial<FiscalRefundRow>): FiscalRefundRow {
    return {
      id: 1,
      original_fiscal_id: 42,
      ms_return_id: null,
      terminal_id: 'VG343420011189',
      receipt_seq: '123',
      fiscal_sign: 'REFUND-SIGN-1',
      qr_code_url: 'https://ofd.soliq.uz/check?...',
      fiscal_datetime: '20260516095418',
      applet_version: null,
      items_json: '[]',
      refund_cash_tiyin: 100000,
      refund_card_tiyin: 50000,
      refund_qr_tiyin: 0,
      request_json: '{}',
      response_json: '{}',
      reason: 'Брак',
      cashier_name: 'Иванов',
      refunded_at: 1_700_000_000,
      is_partial: 0,
      refunded_items_snapshot: null,
      synced_to_server: 0,
      ...overrides,
    }
  }

  it('full refund: is_partial=false, total = cash+card+qr, items_snapshot=null', () => {
    const payload = buildRefundPayload(makeRefund())
    expect(payload.is_partial).toBe(false)
    expect(payload.cash_tiyin).toBe(100000)
    expect(payload.card_tiyin).toBe(50000)
    expect(payload.total_tiyin).toBe(150000)
    expect(payload.items_snapshot).toBeNull()
    expect(payload.reason).toBe('Брак')
  })

  it('partial refund: is_partial=true, items_snapshot распарсен из JSON-строки в объект', () => {
    const snapshot = [{ originalItemIndex: 0, qtyMilli: 1000, refundTiyin: 50000 }]
    const payload = buildRefundPayload(
      makeRefund({ is_partial: 1, refunded_items_snapshot: JSON.stringify(snapshot) }),
    )
    expect(payload.is_partial).toBe(true)
    expect(payload.items_snapshot).toEqual(snapshot)
  })

  it('битый refunded_items_snapshot → items_snapshot=null, не бросает', () => {
    const payload = buildRefundPayload(makeRefund({ refunded_items_snapshot: '{broken' }))
    expect(payload.items_snapshot).toBeNull()
  })

  it('fiscal_datetime конвертируется в ISO (через toIso)', () => {
    const payload = buildRefundPayload(makeRefund())
    expect(payload.fiscal_datetime).toBe(toIso('20260516095418', 1_700_000_000))
  })
})

describe('buildSaleEntry', () => {
  function makeReceipt(overrides?: Partial<FiscalReceiptRow>): FiscalReceiptRow {
    return {
      id: 7,
      ms_receipt_id: 3,
      match_id: null,
      terminal_id: 'VG343420011189',
      receipt_seq: '456',
      fiscal_sign: 'SALE-SIGN-1',
      qr_code_url: 'https://ofd.soliq.uz/check?...',
      fiscal_datetime: '20260516095418',
      applet_version: null,
      request_json: EPOS_JSON,
      response_json: '{}',
      fiscalized_at: 1_700_000_000,
      card_kind: null,
      excluded_payment_tiyin: 0,
      search_text: null,
      synced_to_server: 0,
      ...overrides,
    }
  }

  it('битый/неизвестный request_json → деградированная запись (НЕ null), суммы нулевые без match_id', () => {
    const entry = buildSaleEntry({
      receipt: makeReceipt({ request_json: '{"oops": true}' }), // match_id: null по дефолту
      msReceipt: null,
      matchStrategy: null,
      matchTotalTiyin: null,
      matchItemsOrdered: [],
      esfInfoByLocalId: new Map(),
      refunds: [],
    })
    expect(entry).not.toBeNull()
    expect(entry.items).toEqual([])
    expect(entry.raw_request).toBeNull()
    expect(entry.total_tiyin).toBe(0)
    expect(entry.cash_tiyin).toBe(0)
    expect(entry.card_tiyin).toBe(0)
    expect(entry.vat_tiyin).toBe(0)
  })

  it('собирает total/cash/card/vat из request_json + прокидывает ms_receipt/card_kind/excluded_payment', () => {
    const entry = buildSaleEntry({
      receipt: makeReceipt({ card_kind: 'fiz', excluded_payment_tiyin: 200000 }),
      msReceipt: { ms_id: 'ms-uuid-9', ms_name: '05401', ms_sum_tiyin: 24500000, raw_json: '{}' },
      matchStrategy: 'passthrough',
      matchTotalTiyin: 23500000,
      matchItemsOrdered: [],
      esfInfoByLocalId: new Map(),
      refunds: [],
    })

    expect(entry).not.toBeNull()
    expect(entry.cash_tiyin).toBe(3500000)
    expect(entry.card_tiyin).toBe(20000000)
    expect(entry.total_tiyin).toBe(23500000)
    expect(entry.vat_tiyin).toBe(2517857)
    expect(entry.ms_receipt_id).toBe('ms-uuid-9')
    expect(entry.ms_receipt_name).toBe('05401')
    expect(entry.ms_total_tiyin).toBe(24500000)
    expect(entry.card_kind).toBe('fiz')
    expect(entry.excluded_payment_tiyin).toBe(200000)
    expect(entry.matcher_strategy).toBe('passthrough')
    expect(entry.is_test).toBe(false)
    expect(entry.raw_request).toEqual(JSON.parse(EPOS_JSON))
  })

  it('fiscalized_at (epoch-секунды) конвертируется в ISO', () => {
    const entry = buildSaleEntry({
      receipt: makeReceipt({ fiscalized_at: 1_700_000_000 }),
      msReceipt: null,
      matchStrategy: null,
      matchTotalTiyin: null,
      matchItemsOrdered: [],
      esfInfoByLocalId: new Map(),
      refunds: [],
    })
    expect(entry.fiscalized_at).toBe(new Date(1_700_000_000 * 1000).toISOString())
  })

  describe('legacy /uzpos формат (BLOCKER regression — см. buildSaleEntry doc-comment)', () => {
    it('НИКОГДА не возвращает null — отдаёт деградированную запись с items:[] и raw_request:null', () => {
      const entry = buildSaleEntry({
        receipt: makeReceipt({ request_json: LEGACY_UZPOS_JSON, match_id: 55 }),
        msReceipt: null,
        matchStrategy: 'passthrough',
        matchTotalTiyin: 500000,
        matchItemsOrdered: [],
        esfInfoByLocalId: new Map(),
        refunds: [],
      })

      expect(entry).not.toBeNull()
      expect(entry).toBeDefined()
      expect(entry.items).toEqual([])
      expect(entry.raw_request).toBeNull()
      // Выручка — из matches.total_tiyin. А сплит нал/карта из legacy-блоба
      // не восстановить, поэтому нули: выдумывать способ оплаты нельзя,
      // иначе отчёт «нал/карта» соврёт. Админка покажет «—».
      expect(entry.total_tiyin).toBe(500000)
      expect(entry.cash_tiyin).toBe(0)
      expect(entry.card_tiyin).toBe(0)
      expect(entry.matcher_strategy).toBe('passthrough')
    })

    it('без match_id (matchTotalTiyin=null) → суммы 0, ничего не выдумываем', () => {
      const entry = buildSaleEntry({
        receipt: makeReceipt({ request_json: LEGACY_UZPOS_JSON, match_id: null }),
        msReceipt: null,
        matchStrategy: null,
        matchTotalTiyin: null,
        matchItemsOrdered: [],
        esfInfoByLocalId: new Map(),
        refunds: [],
      })
      expect(entry.total_tiyin).toBe(0)
      expect(entry.cash_tiyin).toBe(0)
      expect(entry.card_tiyin).toBe(0)
    })

    it('ПД клиента (tin/pinfl из extraInfo) НЕ попадает в payload ни в каком виде', () => {
      const entry = buildSaleEntry({
        receipt: makeReceipt({ request_json: LEGACY_UZPOS_JSON, match_id: 55 }),
        msReceipt: null,
        matchStrategy: 'passthrough',
        matchTotalTiyin: 500000,
        matchItemsOrdered: [],
        esfInfoByLocalId: new Map(),
        refunds: [],
      })

      const serialized = JSON.stringify(entry)
      // Конкретные ПД-значения из фикстуры не должны просочиться никуда —
      // ни в raw_request (он null), ни в items (пустой массив), ни куда-либо
      // ещё в payload.
      expect(serialized).not.toContain('987654321') // tin
      expect(serialized).not.toContain('11122233344455') // pinfl
      expect(serialized).not.toContain('legacy-fixed-token') // token
      expect(serialized).not.toContain('extraInfo')
    })
  })
})
