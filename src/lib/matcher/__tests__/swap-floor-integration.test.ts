/**
 * Интеграционные тесты recalculateAfterSwap + manual floor-логика.
 *
 * Проверяем end-to-end что после ручного swap товара (стрелки ←/→):
 *   1. below-floor warning ПОЯВЛЯЕТСЯ если новый приход продаётся ниже +5%
 *   2. below-floor warning ИСЧЕЗАЕТ если свапнули обратно на нормальный
 *   3. цены без тийинов (distributeDiscount/Bump округляют)
 *   4. сумма сходится на target
 *
 * Плюс pure-проверка manual floor-логики (та что в ManualReceiptModal.done()).
 */

import { describe, it, expect } from 'vitest'
import { recalculateAfterSwap } from '@/lib/matcher'
import { priceFloorTiyin, TIYIN_PER_SUM } from '@/lib/matcher/strategies'
import type {
  BuildMatchResult,
  MatchCandidate,
  PositionMatch,
} from '@/lib/matcher/types'
import type { EsfItemRow } from '@/lib/db'
import type { MsRetailDemand } from '@/lib/moysklad/types'

function mkItem(unitPrice: number, name: string, vat = 12): EsfItemRow {
  return {
    id: Math.floor(unitPrice / 1000),
    source: 'remote',
    external_id: null,
    name,
    barcode: null,
    class_code: '08000000000000000',
    package_code: '',
    vat_percent: vat,
    unit_price_tiyin: unitPrice,
    qty_received: 100_000,
    qty_consumed: 0,
    server_item_id: Math.floor(unitPrice / 1000),
    received_at: 0,
  } as EsfItemRow
}

function mkCand(item: EsfItemRow, priceTiyin: number): MatchCandidate {
  return { esfItem: item, quantity: 1000, priceTiyin, discountTiyin: 0, vatTiyin: 0 }
}

/** BuildMatchResult с одной swappable-позицией и 2 альтернативами. */
function mkSwappableResult(opts: {
  currentItem: EsfItemRow
  currentPrice: number
  altItem: EsfItemRow
  altPrice: number
  receiptSum: number
}): BuildMatchResult {
  const current = mkCand(opts.currentItem, opts.currentPrice)
  const alt = mkCand(opts.altItem, opts.altPrice)
  const pos: PositionMatch = {
    source: {
      index: 0,
      name: 'pos',
      quantity: 1000,
      totalTiyin: opts.receiptSum,
      vatPercent: 12,
      classCode: null,
      packageCode: null,
      barcode: null,
      linkedBuhName: null,
    },
    candidates: [current],
    strategy: 'price-bucket',
    diffTiyin: 0,
    warnings: [],
    swappable: true,
    alternatives: [current, alt],
    selectedAlternativeIndex: 0,
    splitLevel: 1,
    canSplitMore: false,
    splittable: true,
  } as PositionMatch
  return {
    receipt: { id: 'r1', sum: opts.receiptSum } as MsRetailDemand,
    positions: [pos],
    overallStrategy: 'price-bucket',
    totalDiffTiyin: 0,
    originalTotalTiyin: opts.receiptSum,
    matchedTotalTiyin: opts.currentPrice,
    canAutoFiscalize: false,
    warnings: [],
    mode: 'classic',
  }
}

describe('recalculateAfterSwap — floor warning после swap', () => {
  it('swap на дорогой приход (ниже +5%) → warning появляется', () => {
    // Текущий: дешёвый приход 500k (floor 588k), продаём за 700k — OK.
    // Альтернатива: дорогой приход 850k (floor 999600), но клиент платит 700k.
    const current = mkItem(500_000, 'Дешёвый')
    const alt = mkItem(850_000, 'Дорогой')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 700_000, // та же цена (клиент заплатил столько), но дорогой приход
      receiptSum: 700_000,
    })
    // Изначально нет warning
    expect(result.warnings.filter((w) => w.includes('минимальной цены'))).toHaveLength(0)

    // Swap на альтернативу (индекс 1 = дорогой приход)
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    // floor дорогого 999600 > 700000 → warning
    const floorAlt = priceFloorTiyin(850_000, 12, 1000)
    expect(floorAlt).toBe(999_600)
    const floorWarnings = swapped.warnings.filter((w) =>
      w.includes('ниже минимальной цены'),
    )
    expect(floorWarnings.length).toBeGreaterThan(0)
    expect(floorWarnings[0]).toContain('Дорогой')
  })

  it('swap обратно на дешёвый → warning исчезает', () => {
    const current = mkItem(850_000, 'Дорогой') // стартуем с дорогого
    const alt = mkItem(500_000, 'Дешёвый')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 700_000,
      receiptSum: 700_000,
    })
    // Swap на дешёвый (индекс 1)
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    // Дешёвый floor 588000 < 700000 → нет warning
    const floorWarnings = swapped.warnings.filter((w) =>
      w.includes('ниже минимальной цены'),
    )
    expect(floorWarnings).toHaveLength(0)
  })

  it('после swap цены без тийинов', () => {
    const current = mkItem(500_000, 'A')
    const alt = mkItem(600_000, 'B')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 800_000,
      receiptSum: 700_000,
    })
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    for (const m of swapped.positions) {
      for (const c of m.candidates) {
        const effective = c.priceTiyin - c.discountTiyin
        expect(effective % TIYIN_PER_SUM).toBe(0) // без тийинов
      }
    }
  })

  it('невалидный индекс позиции → no-op', () => {
    const result = mkSwappableResult({
      currentItem: mkItem(500_000, 'A'),
      currentPrice: 700_000,
      altItem: mkItem(600_000, 'B'),
      altPrice: 800_000,
      receiptSum: 700_000,
    })
    expect(recalculateAfterSwap(result, 99, 0, {})).toBe(result)
  })
})

// ── Manual modal floor-логика (pure copy из done()) ─────────────────

/**
 * Копия floor-проверки из ManualReceiptModal.done(). Возвращает имена
 * позиций ниже floor (для toast-warning).
 */
function manualBelowFloor(
  selected: Array<{ unitPrice: number; vat: number; sellingPrice: number; qty: number; name: string }>,
): string[] {
  const out: string[] = []
  for (const s of selected) {
    if (s.qty <= 0) continue
    const quantityMilli = s.qty * 1000
    const priceTiyin = s.sellingPrice * s.qty
    const floor = priceFloorTiyin(s.unitPrice, s.vat, quantityMilli)
    if (priceTiyin > 0 && priceTiyin < floor) out.push(s.name)
  }
  return out
}

describe('ManualReceiptModal floor-логика', () => {
  it('markup 10% — sellingPrice выше floor, нет warning', () => {
    // unit 500000, markup 10%, vat 12 → selling = round_up(500000×1.10×1.12)=700000
    // floor = 588000. 700000 > 588000 → OK.
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1, name: 'A' },
    ])
    expect(below).toHaveLength(0)
  })

  it('markup 0% (упрощёнка) — selling = себестоимость, НИЖЕ floor → warning', () => {
    // unit 500000, markup 0 → selling ≈ round_up(560000) = 600000.
    // floor = 588000. 600000 > 588000 на самом деле OK из-за округления вверх.
    // Возьмём кейс где округление не спасает: unit 1000000.
    // markup 0 → selling round_up(1000000×1.12=1120000, 1000сум) = 1120000.
    // floor = round(1120000×1.05) ceilToSum = 1176000. 1120000 < 1176000 → warning.
    const below = manualBelowFloor([
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1, name: 'Упрощёнка' },
    ])
    expect(below).toContain('Упрощёнка')
  })

  it('qty масштабирует floor пропорционально', () => {
    // 3 шт: selling 700000×3=2100000, floor 588000×3=1764000 → OK
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 3, name: 'A' },
    ])
    expect(below).toHaveLength(0)
  })

  it('qty=0 игнорируется', () => {
    const below = manualBelowFloor([
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 0, name: 'X' },
    ])
    expect(below).toHaveLength(0)
  })

  it('несколько товаров — только ниже floor в списке', () => {
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1, name: 'OK' },
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1, name: 'BAD' },
    ])
    expect(below).toEqual(['BAD'])
  })
})
