/**
 * Тесты округления в distributeDiscount/distributeBump.
 *
 * Эти функции — internal в index.ts (mutate PositionMatch in-place), поэтому
 * тестируем чистую симуляцию-зеркало их whole-sum алгоритма. Если реальный
 * алгоритм изменится — симуляцию обновить синхронно.
 *
 * Инварианты которые проверяем:
 *   1. Все скидки/надбавки кратны 1 суму (100 тийинов)
 *   2. Финальная цена (price - discount) или (price + bump) без тийинов
 *   3. Для whole-sum target — сумма сходится ТОЧНО
 *   4. Скидка не опускает ниже floor
 */

import { describe, it, expect } from 'vitest'
import {
  ceilToSum,
  floorToSum,
  priceFloorTiyin,
  calculateSellingPrice,
  TIYIN_PER_SUM,
} from '@/lib/matcher/strategies'

interface Cand {
  unitPrice: number
  vat: number
  qty: number // milli
  priceTiyin: number // selling за всё qty
  discountTiyin: number
}

/** Зеркало distributeDiscount whole-sum распределения из index.ts. */
function simulateDiscount(
  cands: Cand[],
  targetSum: number,
  maxPerItem = 200_000,
): { matched: number; remaining: number } {
  const totalSelling = cands.reduce((s, c) => s + c.priceTiyin, 0)
  let remaining = totalSelling - targetSum
  if (remaining <= 0) return { matched: totalSelling, remaining: 0 }

  const slots = cands.map((c) => {
    const floor = priceFloorTiyin(c.unitPrice, c.vat, c.qty)
    const maxBySelfCost = Math.max(0, c.priceTiyin - floor)
    return { c, max: Math.min(maxBySelfCost, maxPerItem) }
  })

  let toRemove = floorToSum(remaining)
  const N = slots.length
  const perItem = ceilToSum(toRemove / N)
  for (const s of slots) {
    if (toRemove <= 0) break
    const take = Math.min(perItem, s.max, toRemove)
    s.c.discountTiyin = take
    toRemove -= take
  }
  if (toRemove > 0) {
    for (const s of slots) {
      if (toRemove <= 0) break
      const left = s.max - s.c.discountTiyin
      if (left <= 0) continue
      const take = Math.min(left, toRemove)
      s.c.discountTiyin += take
      toRemove -= take
    }
  }
  remaining = toRemove + (remaining - floorToSum(remaining))
  const matched = cands.reduce((s, c) => s + c.priceTiyin - c.discountTiyin, 0)
  return { matched, remaining }
}

/** Зеркало distributeBump whole-sum распределения. */
function simulateBump(
  cands: Cand[],
  targetSum: number,
  maxPerItem = 1_000_000,
): { matched: number; remaining: number } {
  const totalNet = cands.reduce((s, c) => s + c.priceTiyin - c.discountTiyin, 0)
  let remaining = targetSum - totalNet
  if (remaining <= 0) return { matched: totalNet, remaining: 0 }

  const maxPerItemSum = floorToSum(maxPerItem)
  const slots = cands.map((c) => ({ c, bumped: 0 }))
  let toAdd = floorToSum(remaining)
  const N = slots.length
  const perItem = ceilToSum(toAdd / N)
  for (const s of slots) {
    if (toAdd <= 0) break
    const take = Math.min(perItem, maxPerItemSum, toAdd)
    s.bumped = take
    toAdd -= take
  }
  if (toAdd > 0) {
    for (const s of slots) {
      if (toAdd <= 0) break
      const left = maxPerItemSum - s.bumped
      if (left <= 0) continue
      const take = Math.min(left, toAdd)
      s.bumped += take
      toAdd -= take
    }
  }
  for (const s of slots) s.c.priceTiyin += s.bumped
  remaining = toAdd + (remaining - floorToSum(remaining))
  const matched = cands.reduce((s, c) => s + c.priceTiyin - c.discountTiyin, 0)
  return { matched, remaining }
}

/** Построить кандидата из реального прихода (selling по формуле). */
function mkCand(unitPrice: number, vat: number, qtyPcs = 1): Cand {
  const priceTiyin = calculateSellingPrice(unitPrice, vat, 10, 1000) * qtyPcs
  return { unitPrice, vat, qty: qtyPcs * 1000, priceTiyin, discountTiyin: 0 }
}

// Реальные приходы Xonabod
const ITEMS: Array<[number, number]> = [
  [60_000, 12],
  [106_200, 12],
  [200_000, 12],
  [500_000, 12],
  [1_600_000, 12],
  [2_000_000, 12],
]

// ── distributeDiscount ──────────────────────────────────────────────

describe('distributeDiscount: округление до целых сум', () => {
  it('скидка делает все цены без тийинов (whole-sum target)', () => {
    const cands = [mkCand(500_000, 12), mkCand(1_600_000, 12), mkCand(2_000_000, 12)]
    const totalSelling = cands.reduce((s, c) => s + c.priceTiyin, 0)
    // target = на 3000 сум меньше → скидка нужна
    const target = totalSelling - 300_000
    const { matched, remaining } = simulateDiscount(cands, target)
    // Все скидки кратны 1 суму
    for (const c of cands) {
      expect(c.discountTiyin % TIYIN_PER_SUM).toBe(0)
      // Финальная цена без тийинов
      expect((c.priceTiyin - c.discountTiyin) % TIYIN_PER_SUM).toBe(0)
    }
    // Для whole-sum target сумма сходится точно
    expect(remaining).toBe(0)
    expect(matched).toBe(target)
  })

  it('скидка не опускает ниже floor (+5%)', () => {
    const cands = [mkCand(2_000_000, 12)]
    const floor = priceFloorTiyin(2_000_000, 12, 1000)
    // огромная скидка которую floor должен ограничить
    const target = floor // хотим срезать до floor
    simulateDiscount(cands, target, 100_000_000)
    const effective = cands[0]!.priceTiyin - cands[0]!.discountTiyin
    expect(effective).toBeGreaterThanOrEqual(floor)
  })

  it('все реальные приходы парами — нет тийинов', () => {
    for (let i = 0; i < ITEMS.length - 1; i++) {
      const cands = [
        mkCand(ITEMS[i]![0], ITEMS[i]![1]),
        mkCand(ITEMS[i + 1]![0], ITEMS[i + 1]![1]),
      ]
      const totalSelling = cands.reduce((s, c) => s + c.priceTiyin, 0)
      const target = totalSelling - 100_000 // 1000 сум скидки
      simulateDiscount(cands, target)
      for (const c of cands) {
        expect((c.priceTiyin - c.discountTiyin) % TIYIN_PER_SUM).toBe(0)
      }
    }
  })
})

// ── distributeBump ──────────────────────────────────────────────────

describe('distributeBump: округление до целых сум', () => {
  it('надбавка делает все цены без тийинов (whole-sum target)', () => {
    const cands = [mkCand(500_000, 12), mkCand(1_600_000, 12)]
    const totalSelling = cands.reduce((s, c) => s + c.priceTiyin, 0)
    const target = totalSelling + 500_000 // +5000 сум надбавки
    const { matched, remaining } = simulateBump(cands, target)
    for (const c of cands) {
      expect(c.priceTiyin % TIYIN_PER_SUM).toBe(0)
    }
    expect(remaining).toBe(0)
    expect(matched).toBe(target)
  })

  it('надбавка ограничена cap (maxBumpPerItem)', () => {
    const cands = [mkCand(500_000, 12)]
    const totalSelling = cands[0]!.priceTiyin
    // запрашиваем гигантскую надбавку > cap
    const target = totalSelling + 50_000_000
    const { remaining } = simulateBump(cands, target, 1_000_000)
    // cap 1M (10000 сум) — остаток должен быть > 0
    expect(remaining).toBeGreaterThan(0)
    // но цена всё равно без тийинов
    expect(cands[0]!.priceTiyin % TIYIN_PER_SUM).toBe(0)
  })
})

// ── Совместный сценарий: реальный чек ───────────────────────────────

describe('Реальный чек: 3 товара, точная сумма без тийинов', () => {
  it('discount-путь: matched = target, ноль тийинов', () => {
    // Чек на 3 товара. selling = 700k + 2000k + 2500k = 5200k.
    // Клиент заплатил 5150k (скидка 50k = 500 сум).
    const cands = [
      mkCand(500_000, 12), // selling 700000
      mkCand(1_600_000, 12), // selling 2000000
      mkCand(2_000_000, 12), // selling 2500000
    ]
    const target = 5_150_000
    const { matched, remaining } = simulateDiscount(cands, target)
    expect(matched).toBe(target)
    expect(remaining).toBe(0)
    const allWholeSum = cands.every(
      (c) => (c.priceTiyin - c.discountTiyin) % TIYIN_PER_SUM === 0,
    )
    expect(allWholeSum).toBe(true)
  })
})
