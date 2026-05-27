/**
 * QA-полигон для partial refund (Phase 2).
 *
 * Покрывает pure-function helpers из refund.ts:
 *   - buildFullRefundItems  — копия оригинала, total = сумма items
 *   - buildPartialRefundItems — pro-rata Amount/Price/Discount/VAT
 *   - tiyinFmt             — форматирование тийинов
 *
 * Симулирует все edge cases которые могут привести к багу в проде:
 *   - duplicate originalItemIndex в selected[]
 *   - sel.qtyMilli = 0 (filtered)
 *   - sel.qtyMilli > original Amount (over-refund)
 *   - cumulative qty уже близок к original (previous partial blocks)
 *   - округление цены при ratio (floor/round/ceil)
 *   - детерминизм порядка (отсортирован по index)
 */

import { describe, it, expect } from 'vitest'
import {
  buildFullRefundItems,
  buildPartialRefundItems,
  tiyinFmt,
} from '@/lib/epos/refund'
import type { JsonRpcItem } from '@/lib/epos/jsonrpc-client'

// ── Test fixtures ──────────────────────────────────────────────────

function mkItem(overrides: Partial<JsonRpcItem> = {}): JsonRpcItem {
  return {
    Name: 'Тестовый товар',
    Price: 1_000_000, // 10 000 сум
    Discount: 0,
    Barcode: '0',
    Amount: 1000, // 1 шт
    VAT: 107143, // ~12% от Price
    Other: 0,
    spic: '08000000000000000',
    packageCode: '1503958',
    VATPercent: 12,
    OwnerType: 0,
    ...overrides,
  }
}

// Реальный чек 8243 из Хонабод 27.05.2026 — 4 позиции на 1 670 000 сум.
const HONABOD_8243_ITEMS: JsonRpcItem[] = [
  mkItem({
    Name: '1582 Выпрямительная машина',
    Price: 130_300_000,
    Amount: 1000,
    VAT: 13_960_714,
    spic: '08504003008000000',
  }),
  mkItem({
    Name: 'ФРЕЗЕР PEM006-С1',
    Price: 29_000_000,
    Amount: 1000,
    VAT: 3_107_143,
    spic: '08465001004000000',
  }),
  mkItem({
    Name: 'Сменная насадка для перфоратора',
    Price: 7_200_000,
    Amount: 9000, // 9 шт
    VAT: 771_429,
    spic: '08207001036000000',
  }),
  mkItem({
    Name: 'Насадки для Дреля',
    Price: 500_000,
    Amount: 1000,
    VAT: 53_571,
    spic: '08207001036000000',
  }),
]

const HONABOD_8243_TOTAL = HONABOD_8243_ITEMS.reduce(
  (s, it) => s + it.Price - it.Discount,
  0,
) // 167_000_000 = 1 670 000 сум

// ── tiyinFmt ───────────────────────────────────────────────────────

describe('tiyinFmt', () => {
  it('форматирует ноль', () => {
    expect(tiyinFmt(0)).toBe('0 сум')
  })

  it('форматирует тысячи сум с пробелом-разделителем (ru-RU)', () => {
    // 167_000_000 тийинов = 1 670 000 сум
    expect(tiyinFmt(167_000_000)).toMatch(/1[\s  ]670[\s  ]000 сум/)
  })

  it('форматирует дробные', () => {
    // 12_345 тийинов = 123.45 сум
    expect(tiyinFmt(12_345)).toBe('123,45 сум')
  })
})

// ── buildFullRefundItems ──────────────────────────────────────────

describe('buildFullRefundItems', () => {
  it('возвращает копию items оригинала «как есть»', () => {
    const r = buildFullRefundItems(HONABOD_8243_ITEMS)
    expect(r.refundItems).toEqual(HONABOD_8243_ITEMS)
    expect(r.refundItems).not.toBe(HONABOD_8243_ITEMS) // immutable copy
  })

  it('refundItemsTotal = сумма (Price - Discount) всех items', () => {
    const r = buildFullRefundItems(HONABOD_8243_ITEMS)
    expect(r.refundItemsTotal).toBe(HONABOD_8243_TOTAL)
  })

  it('snapshotEntries пустой массив (для full snapshot не нужен)', () => {
    const r = buildFullRefundItems(HONABOD_8243_ITEMS)
    expect(r.snapshotEntries).toEqual([])
  })

  it('пустой массив items → итог 0', () => {
    const r = buildFullRefundItems([])
    expect(r.refundItems).toEqual([])
    expect(r.refundItemsTotal).toBe(0)
  })

  it('учитывает Discount', () => {
    const items = [
      mkItem({ Price: 1_000_000, Discount: 100_000 }),
      mkItem({ Price: 500_000, Discount: 50_000 }),
    ]
    const r = buildFullRefundItems(items)
    expect(r.refundItemsTotal).toBe(1_350_000) // 900k + 450k
  })
})

// ── buildPartialRefundItems ───────────────────────────────────────

describe('buildPartialRefundItems', () => {
  describe('базовые случаи', () => {
    it('возврат 1 шт из чека с 4 позициями — только 1 item в refund', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 3, qtyMilli: 1000 }], // последняя позиция (Насадки)
        new Map(),
      )
      expect(r.refundItems).toHaveLength(1)
      expect(r.refundItems[0]!.Name).toBe('Насадки для Дреля')
      expect(r.refundItems[0]!.Amount).toBe(1000)
      expect(r.refundItemsTotal).toBe(500_000) // 5 000 сум
    })

    it('возврат 1 бура из 9 — Price/VAT пропорционально', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 1000 }], // 1 бур из 9
        new Map(),
      )
      const item = r.refundItems[0]!
      expect(item.Amount).toBe(1000)
      // Price 7_200_000 / 9 = 800_000
      expect(item.Price).toBe(800_000)
      // VAT 771_429 / 9 ≈ 85714
      expect(item.VAT).toBe(85_714)
      // refundItemsTotal = newPrice - newDiscount = 800_000
      expect(r.refundItemsTotal).toBe(800_000)
    })

    it('возврат всех 9 буров — должен совпасть с original Price', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 9000 }],
        new Map(),
      )
      const item = r.refundItems[0]!
      expect(item.Amount).toBe(9000)
      expect(item.Price).toBe(7_200_000) // полная цена
      expect(item.VAT).toBe(771_429) // полный VAT
    })

    it('snapshotEntries отражает выбор', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: 1000 },
          { originalItemIndex: 3, qtyMilli: 1000 },
        ],
        new Map(),
      )
      expect(r.snapshotEntries).toHaveLength(2)
      expect(r.snapshotEntries[0]).toEqual({
        originalItemIndex: 0,
        qtyMilli: 1000,
        refundTiyin: 130_300_000,
      })
      expect(r.snapshotEntries[1]).toEqual({
        originalItemIndex: 3,
        qtyMilli: 1000,
        refundTiyin: 500_000,
      })
    })

    it('детерминизм: items отсортированы по index независимо от порядка selected', () => {
      const r1 = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 3, qtyMilli: 1000 },
          { originalItemIndex: 0, qtyMilli: 1000 },
        ],
        new Map(),
      )
      const r2 = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: 1000 },
          { originalItemIndex: 3, qtyMilli: 1000 },
        ],
        new Map(),
      )
      expect(r1.refundItems).toEqual(r2.refundItems)
    })
  })

  describe('защита от over-refund', () => {
    it('throws если qty > original Amount', () => {
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [{ originalItemIndex: 0, qtyMilli: 2000 }], // 2 шт, но в оригинале 1
          new Map(),
        ),
      ).toThrow(/пытаетесь вернуть 2 шт.*но осталось доступно для возврата 1 шт/)
    })

    it('throws с учётом alreadyRefunded из previous partial', () => {
      // Original 9 буров, уже вернули 5 → осталось 4 → попытка вернуть 5 = over
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [{ originalItemIndex: 2, qtyMilli: 5000 }],
          new Map([[2, 5000]]), // already refunded 5
        ),
      ).toThrow(/пытаетесь вернуть 5 шт.*осталось доступно для возврата 4 шт/)
    })

    it('OK если cumulative ровно = original (вернуть оставшееся)', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 4000 }], // 4 шт
        new Map([[2, 5000]]), // already 5, итого 9 = original
      )
      expect(r.refundItems[0]!.Amount).toBe(4000)
    })

    it('throws на index которого нет в оригинале', () => {
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [{ originalItemIndex: 99, qtyMilli: 1000 }],
          new Map(),
        ),
      ).toThrow(/Позиция #100 не найдена/)
    })
  })

  describe('защита от дубликатов в selected[]', () => {
    it('aggregates duplicate indices — 2x по 1 шт = 2 шт', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 2, qtyMilli: 1000 },
          { originalItemIndex: 2, qtyMilli: 1000 },
        ],
        new Map(),
      )
      // Должен быть ОДИН item с aggregated qty = 2000
      expect(r.refundItems).toHaveLength(1)
      expect(r.refundItems[0]!.Amount).toBe(2000)
    })

    it('over-refund через дубликаты тоже ловится', () => {
      // 1 шт оригинал, 2 запроса по 1 → cumulative 2 > 1
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [
            { originalItemIndex: 0, qtyMilli: 1000 },
            { originalItemIndex: 0, qtyMilli: 1000 },
          ],
          new Map(),
        ),
      ).toThrow(/пытаетесь вернуть 2 шт.*осталось доступно для возврата 1 шт/)
    })

    it('дубликаты + previous partial вместе — корректное aggregation', () => {
      // 9 буров оригинал, уже вернули 3, сейчас попытка 2+3 = 5 → cumulative 8 < 9 OK
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 2, qtyMilli: 2000 },
          { originalItemIndex: 2, qtyMilli: 3000 },
        ],
        new Map([[2, 3000]]),
      )
      expect(r.refundItems[0]!.Amount).toBe(5000)
    })
  })

  describe('фильтрация qty=0', () => {
    it('skips qty=0 без throw', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: 0 },
          { originalItemIndex: 3, qtyMilli: 1000 },
        ],
        new Map(),
      )
      expect(r.refundItems).toHaveLength(1)
      expect(r.refundItems[0]!.Name).toBe('Насадки для Дреля')
    })

    it('throws если ВСЕ qty=0', () => {
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [
            { originalItemIndex: 0, qtyMilli: 0 },
            { originalItemIndex: 1, qtyMilli: 0 },
          ],
          new Map(),
        ),
      ).toThrow(/Не выбрано ни одной позиции/)
    })

    it('throws на пустой selected[]', () => {
      expect(() =>
        buildPartialRefundItems(HONABOD_8243_ITEMS, [], new Map()),
      ).toThrow(/Не выбрано ни одной позиции/)
    })

    it('negative qty трактуется как 0 (skip)', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: -100 },
          { originalItemIndex: 3, qtyMilli: 1000 },
        ],
        new Map(),
      )
      expect(r.refundItems).toHaveLength(1)
    })
  })

  describe('pro-rata math invariants', () => {
    it('refundItemsTotal = sum (Price - Discount) per item', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: 1000 },
          { originalItemIndex: 2, qtyMilli: 3000 }, // 3 бура
        ],
        new Map(),
      )
      const sum = r.refundItems.reduce(
        (s, it) => s + (it.Price - it.Discount),
        0,
      )
      expect(r.refundItemsTotal).toBe(sum)
    })

    it('refundItemsTotal сходится с снапшотом', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [
          { originalItemIndex: 0, qtyMilli: 1000 },
          { originalItemIndex: 2, qtyMilli: 5000 },
        ],
        new Map(),
      )
      const snapTotal = r.snapshotEntries.reduce(
        (s, e) => s + e.refundTiyin,
        0,
      )
      expect(snapTotal).toBe(r.refundItemsTotal)
    })

    it('частичный возврат скидки тоже масштабируется', () => {
      const items = [
        mkItem({
          Price: 1_000_000,
          Discount: 200_000, // 20% скидка
          Amount: 10_000, // 10 шт
          VAT: 85_714,
        }),
      ]
      const r = buildPartialRefundItems(
        items,
        [{ originalItemIndex: 0, qtyMilli: 3000 }], // 3 шт
        new Map(),
      )
      const it = r.refundItems[0]!
      expect(it.Amount).toBe(3000)
      // 30% от Price
      expect(it.Price).toBe(300_000)
      // 30% от Discount
      expect(it.Discount).toBe(60_000)
      // 30% от VAT
      expect(it.VAT).toBe(25_714)
      // Total = Price - Discount
      expect(r.refundItemsTotal).toBe(240_000)
    })

    it('Discount=undefined трактуется как 0', () => {
      const itemsWithoutDiscount = [
        // Конструируем напрямую без mkItem чтобы Discount был отсутствующим полем
        {
          Name: 'X',
          Price: 100_000,
          Amount: 1000,
          VAT: 10_714,
          Barcode: '0',
          Other: 0,
          spic: '0',
          packageCode: '0',
          VATPercent: 12,
          OwnerType: 0,
        } as JsonRpcItem,
      ]
      const r = buildPartialRefundItems(
        itemsWithoutDiscount,
        [{ originalItemIndex: 0, qtyMilli: 500 }],
        new Map(),
      )
      // ratio = 0.5, Price = 50000, Discount = 0
      expect(r.refundItems[0]!.Price).toBe(50_000)
      expect(r.refundItems[0]!.Discount).toBe(0)
    })
  })

  describe('реальный сценарий Хонабод 8243', () => {
    it('кассир пытается вернуть 1 насадку — это самая дешёвая (500к)', () => {
      const r = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 3, qtyMilli: 1000 }],
        new Map(),
      )
      expect(r.refundItemsTotal).toBe(500_000) // 5 000 сум
      // Это ≠ 120 000 (которые он хотел Payme), и нет товара точно на 120k
      // Подтверждение: для случая «случайно лишний Payme 120к» partial не помогает
    })

    it('последовательные частичные возвраты накапливают cumulative', () => {
      // День 1: возврат 3 буров из 9
      const r1 = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 3000 }],
        new Map(),
      )
      expect(r1.refundItems[0]!.Amount).toBe(3000)

      // День 2: возврат ещё 4 буров — alreadyRefunded={2:3000}
      const r2 = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 4000 }],
        new Map([[2, 3000]]),
      )
      expect(r2.refundItems[0]!.Amount).toBe(4000)

      // День 3: вернуть оставшиеся 2 — alreadyRefunded={2:7000}
      const r3 = buildPartialRefundItems(
        HONABOD_8243_ITEMS,
        [{ originalItemIndex: 2, qtyMilli: 2000 }],
        new Map([[2, 7000]]),
      )
      expect(r3.refundItems[0]!.Amount).toBe(2000)

      // День 4: попытка вернуть ещё 1 — должно упасть (cumulative=9, original=9)
      expect(() =>
        buildPartialRefundItems(
          HONABOD_8243_ITEMS,
          [{ originalItemIndex: 2, qtyMilli: 1000 }],
          new Map([[2, 9000]]),
        ),
      ).toThrow(/осталось доступно для возврата 0 шт/)
    })
  })

  describe('EPOS math tolerance check (10000 тийинов = 100 сум)', () => {
    it('full refund: refundItemsTotal должен ровно совпадать с original', () => {
      const r = buildFullRefundItems(HONABOD_8243_ITEMS)
      const origTotal = HONABOD_8243_ITEMS.reduce(
        (s, it) => s + (it.Price - it.Discount),
        0,
      )
      expect(r.refundItemsTotal).toBe(origTotal)
    })

    it('partial: pro-rata округление держится в 1 тийин (далеко от 10000 tolerance)', () => {
      // Создаём чек с фракционными ratio чтобы проверить worst case
      const items = [
        mkItem({ Price: 1_234_567, Amount: 7000, VAT: 132_275 }),
      ]
      // Возврат 3 из 7 → ratio = 3/7 = 0.428571...
      const r = buildPartialRefundItems(
        items,
        [{ originalItemIndex: 0, qtyMilli: 3000 }],
        new Map(),
      )
      // Идеал: 1234567 × 3/7 = 529100.14...
      // Math.round → 529100
      expect(r.refundItems[0]!.Price).toBe(529_100)
      // VAT идеал: 132275 × 3/7 = 56689.28...
      // Math.round → 56689
      expect(r.refundItems[0]!.VAT).toBe(56_689)
      // refundItemsTotal = Price (Discount=0) = 529100
      expect(r.refundItemsTotal).toBe(529_100)
    })
  })
})
