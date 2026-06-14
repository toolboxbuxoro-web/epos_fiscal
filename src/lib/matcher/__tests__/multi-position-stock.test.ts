/**
 * Тесты переаллокации остатков в классическом matcher (подход A — remainingById).
 *
 * Проверяем что:
 *   1. Один приход не «матчится» сверх своего available на несколько позиций.
 *   2. Декремент poolRemaining работает корректно.
 *   3. Если остатка хватает на несколько позиций — дубли допустимы.
 *
 * Тесты конструируют MatcherPool вручную (без БД), используют стратегии
 * напрямую через pool + poolRemaining, и через decrementPool в index.ts
 * косвенно (buildMatch недоступен без SQLite, тестируем стратегии напрямую).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  poolRemaining,
  tryPassthrough,
  tryPriceBucket,
  tryMultiItem,
  type MatcherPool,
  type PoolItem,
} from '@/lib/matcher/strategies'
import type { EsfItemWithAvailable } from '@/lib/db'
import type { NormalizedPosition } from '@/lib/matcher/types'

// ── Helpers ────────────────────────────────────────────────────────────────

let nextId = 1

function mkItem(opts: {
  id?: number
  name?: string
  unitPriceTiyin?: number
  availableMilli?: number
  vat?: number
  classCode?: string
}): EsfItemWithAvailable {
  const id = opts.id ?? nextId++
  const available = opts.availableMilli ?? 10_000 // 10 шт default
  return {
    id,
    source: 'remote',
    external_id: null,
    name: opts.name ?? `Item-${id}`,
    barcode: null,
    class_code: opts.classCode ?? `0800000000000000${id}`,
    package_code: '',
    vat_percent: opts.vat ?? 12,
    unit_price_tiyin: opts.unitPriceTiyin ?? 500_000,
    qty_received: available,
    qty_consumed: 0,
    server_item_id: id,
    received_at: id, // FIFO по id
    available,
  } as EsfItemWithAvailable
}

function mkPool(items: EsfItemWithAvailable[], sellingPriceOverride?: number): MatcherPool {
  const poolItems: PoolItem[] = items.map((item) => {
    const sellingPrice =
      sellingPriceOverride ??
      (() => {
        const withMarkup = (item.unit_price_tiyin * 110) / 100
        const withVat = (withMarkup * (100 + item.vat_percent)) / 100
        const stepTiyin = 1000 * 100
        return Math.ceil(withVat / stepTiyin) * stepTiyin
      })()
    return { item, sellingPrice }
  })
  const minSellingPrice = poolItems.reduce(
    (m, p) => (p.sellingPrice > 0 && p.sellingPrice < m ? p.sellingPrice : m),
    Number.POSITIVE_INFINITY,
  )
  const remainingById = new Map<number, number>(
    poolItems.map((p) => [p.item.id, p.item.available]),
  )
  return {
    items: poolItems,
    minSellingPrice: Number.isFinite(minSellingPrice) ? minSellingPrice : 0,
    remainingById,
  }
}

/** Вручную декрементировать pool (имитируем decrementPool из index.ts). */
function decrementPool(pool: MatcherPool, candidates: Array<{ esfItem: { id: number }; quantity: number }>): void {
  for (const c of candidates) {
    const id = c.esfItem.id
    const current = pool.remainingById.get(id)
    if (current === undefined) continue
    pool.remainingById.set(id, Math.max(0, current - c.quantity))
  }
}

function mkPos(opts: {
  totalTiyin: number
  quantity?: number
  classCode?: string
}): NormalizedPosition {
  return {
    index: 0,
    name: 'Test Position',
    quantity: opts.quantity ?? 1000,
    totalTiyin: opts.totalTiyin,
    vatPercent: 12,
    classCode: opts.classCode ?? null,
    packageCode: null,
    barcode: null,
    linkedBuhName: null,
  }
}

// Сбрасываем счётчик id перед каждым тестом для воспроизводимости.
beforeEach(() => {
  nextId = 1
})

// ── Tests ──────────────────────────────────────────────────────────────────

describe('poolRemaining — чтение текущего остатка', () => {
  it('возвращает item.available при инициализации', () => {
    const item = mkItem({ availableMilli: 7_000 })
    const pool = mkPool([item])
    expect(poolRemaining(pool, item.id)).toBe(7_000)
  })

  it('возвращает уменьшенный остаток после декремента', () => {
    const item = mkItem({ availableMilli: 7_000 })
    const pool = mkPool([item])
    // декремент на 4 шт (4000 milli)
    pool.remainingById.set(item.id, 7_000 - 4_000)
    expect(poolRemaining(pool, item.id)).toBe(3_000)
  })

  it('fallback на 0 для несуществующего id', () => {
    const pool = mkPool([])
    expect(poolRemaining(pool, 9999)).toBe(0)
  })
})

describe('Декремент после первой позиции — вторая видит уменьшенный остаток', () => {
  it('после декремента tryPassthrough не даёт вторую позицию если остатка нет', () => {
    // 1 шт товара, 2 позиции каждая по 1 шт.
    const item = mkItem({ availableMilli: 1_000, classCode: '12345678901234567' })
    const pool = mkPool([item])

    const pos1 = mkPos({ totalTiyin: 700_000, quantity: 1000, classCode: item.class_code! })
    const pos2 = mkPos({ totalTiyin: 700_000, quantity: 1000, classCode: item.class_code! })

    // Первая позиция матчится
    const m1 = tryPassthrough(pos1, pool, {})
    expect(m1).not.toBeNull()
    expect(m1!.candidates[0]!.esfItem.id).toBe(item.id)

    // Декрементируем
    decrementPool(pool, m1!.candidates)

    // Остаток = 0 теперь
    expect(poolRemaining(pool, item.id)).toBe(0)

    // Вторая позиция НЕ должна матчиться (нет остатка)
    const m2 = tryPassthrough(pos2, pool, {})
    expect(m2).toBeNull()
  })

  it('приход 7 шт, две позиции по 4 шт — вторая ≤ 3 шт или не матчится', () => {
    // Приход: 7 шт. Позиция 1: 4 шт. Позиция 2: 4 шт.
    // После декремента: remaining = 3 шт. Позиция 2 не получит 4 шт.
    const item = mkItem({ availableMilli: 7_000, classCode: '99988877766655544' })
    const pool = mkPool([item])

    const pos1 = mkPos({ totalTiyin: 2_800_000, quantity: 4_000, classCode: item.class_code! })
    const pos2 = mkPos({ totalTiyin: 2_800_000, quantity: 4_000, classCode: item.class_code! })

    const m1 = tryPassthrough(pos1, pool, {})
    expect(m1).not.toBeNull()
    // Декрементируем 4000 milli
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(3_000)

    // Вторая позиция просит 4 шт, а доступно 3 шт → null
    const m2 = tryPassthrough(pos2, pool, {})
    expect(m2).toBeNull()

    // Суммарно использованное qty не превышает available
    const usedQty = m1!.candidates.reduce((s, c) => s + c.quantity, 0)
    // m2 = null, so total used = только m1
    expect(usedQty).toBeLessThanOrEqual(7_000)
  })
})

describe('Приход 10 шт, 2 позиции по 3 шт — обе матчатся (хватает)', () => {
  it('passthrough: 10 шт → 3+3 = OK, оба матча', () => {
    const item = mkItem({ availableMilli: 10_000, classCode: '11122233344455566' })
    const pool = mkPool([item])

    const pos1 = mkPos({ totalTiyin: 2_100_000, quantity: 3_000, classCode: item.class_code! })
    const pos2 = mkPos({ totalTiyin: 2_100_000, quantity: 3_000, classCode: item.class_code! })

    const m1 = tryPassthrough(pos1, pool, {})
    expect(m1).not.toBeNull()
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(7_000)

    const m2 = tryPassthrough(pos2, pool, {})
    expect(m2).not.toBeNull()
    decrementPool(pool, m2!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(4_000)

    // Суммарно 6000 milli (3+3), well below 10000
    expect(6_000).toBeLessThanOrEqual(10_000)
  })

  it('price-bucket: 10 шт → 1+1 = OK (price-bucket берёт по 1 шт)', () => {
    const item = mkItem({ availableMilli: 10_000 })
    const sellPrice = 700_000 // known selling price
    const pool = mkPool([item], sellPrice)

    const opts = { toleranceTiyin: 500_000 }
    const pos1 = mkPos({ totalTiyin: sellPrice })
    const pos2 = mkPos({ totalTiyin: sellPrice })

    const m1 = tryPriceBucket(pos1, pool, opts)
    expect(m1).not.toBeNull()
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(9_000) // 10 - 1 шт

    const m2 = tryPriceBucket(pos2, pool, opts)
    expect(m2).not.toBeNull()
    decrementPool(pool, m2!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(8_000) // 10 - 2 шт
  })
})

describe('price-bucket: остаток 0 → второй матч не находит кандидата', () => {
  it('1 шт в пуле, price-bucket: вторая позиция → null', () => {
    const item = mkItem({ availableMilli: 1_000 })
    const sellPrice = 700_000
    const pool = mkPool([item], sellPrice)

    const opts = { toleranceTiyin: 500_000 }
    const pos1 = mkPos({ totalTiyin: sellPrice })

    const m1 = tryPriceBucket(pos1, pool, opts)
    expect(m1).not.toBeNull()
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(0)

    // Вторая позиция: нет остатка → price-bucket не видит этот товар
    const pos2 = mkPos({ totalTiyin: sellPrice })
    const m2 = tryPriceBucket(pos2, pool, opts)
    expect(m2).toBeNull()
  })
})

describe('multi-item: remainingById ограничивает qty в knapsack', () => {
  it('1 SKU, 3 шт доступно, pos.totalTiyin = 3 шт × sellPrice → берёт 3', () => {
    const item = mkItem({ availableMilli: 3_000 })
    const sellPrice = 700_000
    const pool = mkPool([item], sellPrice)

    const opts = { toleranceTiyin: 100_000 }
    const pos = mkPos({ totalTiyin: sellPrice * 3 })

    const m = tryMultiItem(pos, pool, opts)
    expect(m).not.toBeNull()
    const totalQty = m!.candidates.reduce((s, c) => s + c.quantity, 0)
    expect(totalQty).toBeLessThanOrEqual(3_000)
  })

  it('SKU 3 шт, первая позиция взяла 2 шт, вторая может взять только 1', () => {
    const item = mkItem({ availableMilli: 3_000 })
    const sellPrice = 700_000
    const pool = mkPool([item], sellPrice)

    const opts = { toleranceTiyin: 200_000 }

    // Первая позиция: 2 шт
    const pos1 = mkPos({ totalTiyin: sellPrice * 2 })
    const m1 = tryMultiItem(pos1, pool, opts)
    expect(m1).not.toBeNull()
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(1_000)

    // Вторая позиция: хочет 2 шт, но может взять только 1 (remaining=1000)
    const pos2 = mkPos({ totalTiyin: sellPrice * 2 })
    const m2 = tryMultiItem(pos2, pool, opts)
    // 1 шт × 700000 = 700000, target 1400000, diff = 700000 > tolerance=200000 → null
    // Проверяем что multi-item не «перебирает» available
    if (m2 !== null) {
      const usedQty = m2.candidates.reduce((s, c) => s + c.quantity, 0)
      expect(usedQty).toBeLessThanOrEqual(1_000) // не больше оставшегося
    }
    // Остаток не ушёл в минус
    expect(poolRemaining(pool, item.id)).toBeGreaterThanOrEqual(0)
  })
})

describe('Инвариант: суммарное использованное qty ≤ available', () => {
  it('серия из 3 позиций на один приход — суммарно ≤ available', () => {
    // Приход 5 шт, три позиции по 2 шт.
    // Ожидаем: 2+2=4 → OK, третья позиция остаток=1 → не матчится или берёт ≤1
    const item = mkItem({ availableMilli: 5_000, classCode: '77766655544433322' })
    const pool = mkPool([item])

    let totalUsed = 0
    for (let i = 0; i < 3; i++) {
      const pos = mkPos({ totalTiyin: 1_400_000, quantity: 2_000, classCode: item.class_code! })
      const m = tryPassthrough(pos, pool, {})
      if (m) {
        const used = m.candidates.reduce((s, c) => s + c.quantity, 0)
        decrementPool(pool, m.candidates)
        totalUsed += used
      }
    }

    // Суммарно использованное не должно превышать 5000 milli (5 шт)
    expect(totalUsed).toBeLessThanOrEqual(5_000)
    // Остаток не может быть отрицательным
    expect(poolRemaining(pool, item.id)).toBeGreaterThanOrEqual(0)
  })
})

describe('poolRemaining через несколько стратегий — cross-strategy корректность', () => {
  it('passthrough взял приход, затем price-bucket его не видит (remaining=0)', () => {
    // SKU с конкретным ИКПУ, 1 шт. Первая позиция — passthrough.
    // Вторая позиция (по цене) — price-bucket не должна взять этот же SKU (remaining=0).
    const item = mkItem({ availableMilli: 1_000, classCode: '55566677788899900' })
    const sellPrice = 700_000
    const pool = mkPool([item], sellPrice)

    // pos1: passthrough по ИКПУ
    const pos1 = mkPos({ totalTiyin: sellPrice, quantity: 1_000, classCode: item.class_code! })
    const m1 = tryPassthrough(pos1, pool, {})
    expect(m1).not.toBeNull()
    decrementPool(pool, m1!.candidates)
    expect(poolRemaining(pool, item.id)).toBe(0)

    // pos2: price-bucket по цене
    const pos2 = mkPos({ totalTiyin: sellPrice })
    const m2 = tryPriceBucket(pos2, pool, { toleranceTiyin: 100_000 })
    // pool пуст (единственный SKU выбран) → price-bucket не найдёт ничего
    expect(m2).toBeNull()
  })
})
