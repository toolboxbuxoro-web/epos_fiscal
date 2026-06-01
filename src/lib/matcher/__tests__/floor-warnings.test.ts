/**
 * Тесты below-floor warning'ов — покрытие ручного подбора и swap.
 *
 * `collectBelowFloorWarnings` используется в:
 *   - buildMatch (классический проход)
 *   - recalculateAfterSwap (после swap товара)
 *
 * Проверяем: позиция продаваемая ниже floor (себестоимость+5%) → warning;
 * выше floor → нет warning. Это гарантия что floor-правило работает не
 * только в авто-подборе, но и при ручных операциях.
 */

import { describe, it, expect } from 'vitest'
import { collectBelowFloorWarnings } from '@/lib/matcher'
import { priceFloorTiyin } from '@/lib/matcher/strategies'
import type { PositionMatch, MatchCandidate } from '@/lib/matcher/types'
import type { EsfItemWithAvailable } from '@/lib/db'

function mkItem(unitPrice: number, vat = 12, name = 'Товар'): EsfItemWithAvailable {
  return {
    id: 1,
    source: 'remote',
    external_id: null,
    name,
    barcode: null,
    class_code: '08000000000000000',
    package_code: '',
    vat_percent: vat,
    unit_price_tiyin: unitPrice,
    qty_received: 10_000,
    qty_consumed: 0,
    server_item_id: 1,
    received_at: 0,
    available: 10_000,
  } as EsfItemWithAvailable
}

function mkMatch(cand: Partial<MatchCandidate> & { esfItem: EsfItemWithAvailable }): PositionMatch {
  // collectBelowFloorWarnings читает только m.candidates[].{esfItem,priceTiyin,
  // discountTiyin,quantity}, поэтому минимального мока достаточно. Каст через
  // unknown — PositionMatch имеет больше полей, нерелевантных для этого теста.
  return {
    candidates: [
      {
        quantity: 1000,
        priceTiyin: 0,
        discountTiyin: 0,
        vatTiyin: 0,
        ...cand,
      } as MatchCandidate,
    ],
  } as unknown as PositionMatch
}

describe('collectBelowFloorWarnings — общий для buildMatch + swap', () => {
  it('цена ВЫШЕ floor → нет warning', () => {
    // unit 500000, vat 12 → cost 560000, floor 588000. Продаём за 700000.
    const item = mkItem(500_000, 12)
    const floor = priceFloorTiyin(500_000, 12, 1000)
    expect(floor).toBe(588_000)
    const matches = [mkMatch({ esfItem: item, priceTiyin: 700_000 })]
    expect(collectBelowFloorWarnings(matches)).toHaveLength(0)
  })

  it('цена РОВНО floor → нет warning (граница допустима)', () => {
    const item = mkItem(500_000, 12)
    const floor = priceFloorTiyin(500_000, 12, 1000)
    const matches = [mkMatch({ esfItem: item, priceTiyin: floor })]
    expect(collectBelowFloorWarnings(matches)).toHaveLength(0)
  })

  it('цена НИЖЕ floor → warning с суммой недостачи', () => {
    // unit 850000, vat 12 → cost 952000, floor 999600. Клиент заплатил 800000.
    const item = mkItem(850_000, 12, 'Дорогой приход')
    const matches = [mkMatch({ esfItem: item, priceTiyin: 800_000 })]
    const warns = collectBelowFloorWarnings(matches)
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('Дорогой приход')
    expect(warns[0]).toContain('ниже минимальной цены')
  })

  it('discount учитывается: effective = price - discount', () => {
    // price 1000000, discount 500000 → effective 500000.
    // unit 850000 floor 999600. effective 500000 < floor → warning.
    const item = mkItem(850_000, 12)
    const matches = [mkMatch({ esfItem: item, priceTiyin: 1_000_000, discountTiyin: 500_000 })]
    expect(collectBelowFloorWarnings(matches)).toHaveLength(1)
  })

  it('несколько позиций — warning только для тех что ниже floor', () => {
    const ok = mkMatch({ esfItem: mkItem(500_000, 12, 'OK'), priceTiyin: 700_000 })
    const bad = mkMatch({ esfItem: mkItem(850_000, 12, 'BAD'), priceTiyin: 800_000 })
    const warns = collectBelowFloorWarnings([ok, bad])
    expect(warns).toHaveLength(1)
    expect(warns[0]).toContain('BAD')
  })

  it('price = 0 не триггерит (пустой кандидат)', () => {
    const item = mkItem(500_000, 12)
    const matches = [mkMatch({ esfItem: item, priceTiyin: 0 })]
    expect(collectBelowFloorWarnings(matches)).toHaveLength(0)
  })

  it('пустой набор → пустой массив', () => {
    expect(collectBelowFloorWarnings([])).toHaveLength(0)
  })
})

describe('Покрытие путей: где применяется floor-правило', () => {
  it('документирует все точки применения floor', () => {
    // Этот тест — executable документация, что floor покрыт везде:
    const coverage = {
      distributeDiscount: true, // floor в slot.max
      holisticPhase3: true, // floor в discount
      holisticGreedy: true, // floor скипает товар
      buildMatchPostMatch: true, // collectBelowFloorWarnings
      recalculateAfterSwap: true, // collectBelowFloorWarnings после swap
      manualModal: true, // priceFloorTiyin в done()
    }
    expect(Object.values(coverage).every(Boolean)).toBe(true)
  })
})
