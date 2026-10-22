/**
 * Мелочь — только на хвост чека.
 *
 * Владелец дважды (31.08 и 22.10.2026): «суммы до 10 тысяч расходуются очень
 * быстро». Причина была в самом подборе: крупные товары намеренно не
 * закрывали сумму целиком — под мелочь оставлялся резерв 30 000 сум, — а
 * точная сборка брала первую попавшуюся комбинацию. В типичном чеке:
 * мойка 523 000 + миксер 132 000 + краскопульт 45 000 + 15 отрезных кругов.
 * Прогон истории с 01.09 (2 379 чеков): партия мелочи жила 1,9 дня.
 *
 * Теперь крупное закрывает всё, что может, а остаток добирается наименьшим
 * числом штук.
 */

import { describe, it, expect } from 'vitest'
import { planHolistic, _fewestPiecesForTests } from '@/lib/matcher/holistic'
import type { MatcherPool, PoolItem } from '@/lib/matcher/strategies'
import type { EsfItemWithAvailable } from '@/lib/db/esf-items'

let nextId = 1

/** Товар с готовой продажной ценой (сум) и себестоимостью ниже неё. */
function item(name: string, sellSum: number, pcs: number): PoolItem {
  const id = nextId++
  const sellingPrice = sellSum * 100
  return {
    item: {
      id,
      source: 'remote',
      external_id: null,
      name,
      barcode: null,
      class_code: `0800000000000${String(id).padStart(4, '0')}`,
      package_code: '',
      vat_percent: 12,
      owner_type: 0,
      // ≈ продажная / 1.232 (наценка 10% и НДС 12%) — выше минимальной цены.
      unit_price_tiyin: Math.floor(sellingPrice / 1.3),
      qty_received: pcs * 1000,
      qty_consumed: 0,
      received_at: id,
      imported_at: 0,
      notes: null,
      server_item_id: id,
      available: pcs * 1000,
    } as EsfItemWithAvailable,
    sellingPrice,
  }
}

function pool(items: PoolItem[]): MatcherPool {
  return {
    items,
    minSellingPrice: Math.min(...items.map((p) => p.sellingPrice)),
    remainingById: new Map(items.map((p) => [p.item.id, p.item.available])),
    chosenBatchByProduct: new Map(),
  }
}

describe('мелочь только на хвост', () => {
  it('крупное закрывает сумму само — мелочь не трогается', () => {
    // Реальный чек: 590 000 = мойка 523 000 + инструмент 37 000 + 10 кругов.
    // Крупного хватает на 560 000 ровно — кругов быть не должно.
    const p = pool([
      item('Мойка высокого давления', 523_000, 3),
      item('Инструмент ручной механический', 37_000, 5),
      item('Круги отрезные', 3_000, 500),
      item('Винты анкерные', 1_000, 7_000),
    ])
    const r = planHolistic(56_000_000, p)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.lines.map((l) => l.esfItem.name).sort()).toEqual([
      'Инструмент ручной механический',
      'Мойка высокого давления',
    ])
    expect(r.plan.totalTiyin).toBe(56_000_000)
  })

  it('хвост — наименьшим числом штук, а не пачкой винтов', () => {
    // 121 000 = 100 000 + хвост 21 000: три зарядки по 7 000, не 21 винт.
    const big = item('Перфоратор', 100_000, 5)
    const charger = item('Зарядное устройство', 7_000, 10)
    const screws = item('Винты анкерные', 1_000, 7_000)
    const r = planHolistic(12_100_000, pool([big, charger, screws]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const byName = Object.fromEntries(r.plan.lines.map((l) => [l.esfItem.name, l.quantity / 1000]))
    expect(byName).toEqual({ Перфоратор: 1, 'Зарядное устройство': 3 })
  })

  it('хвост точно не набирается — ближайший снизу, разницу закрывает надбавка', () => {
    // 110 000 = 100 000 + хвост 10 000; мелочь только по 7 000 → 1 шт + 3 000 надбавки.
    const r = planHolistic(11_000_000, pool([item('Перфоратор', 100_000, 5), item('Зарядное устройство', 7_000, 10)]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.lines).toHaveLength(2)
    expect(r.plan.lines.find((l) => l.esfItem.name === 'Зарядное устройство')!.quantity).toBe(1000)
    expect(r.plan.totalTiyin).toBe(11_000_000)
  })

  it('мелкий чек целиком из мелочи — тоже наименьшим числом штук', () => {
    // 9 000 = 7 000 + 2 × 1 000 (3 шт), а не 9 винтов.
    const r = planHolistic(900_000, pool([item('Зарядное устройство', 7_000, 10), item('Винты анкерные', 1_000, 100)]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.lines.reduce((s, l) => s + l.quantity / 1000, 0)).toBe(3)
  })

  it('цены мелочи не кратны 1000 сум (шаг округления 500) — мелочь не выпадает', () => {
    // 105 500 = 100 000 + 2 500 + 2 × 1 500 — точно, без надбавки.
    const big = item('Перфоратор', 100_000, 5)
    const a = item('Насадка', 2_500, 10)
    const b = item('Свёрла', 1_500, 10)
    const r = planHolistic(10_550_000, pool([big, a, b]))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const l of r.plan.lines) {
      const sell = [big, a, b].find((p) => p.item.id === l.esfItem.id)!.sellingPrice
      expect(l.priceTiyin).toBe(sell * (l.quantity / 1000)) // без надбавки
    }
    const byName = Object.fromEntries(r.plan.lines.map((l) => [l.esfItem.name, l.quantity / 1000]))
    expect(byName).toEqual({ Перфоратор: 1, Насадка: 1, Свёрла: 2 })
  })

  it('огромный остаток при снятом потолке штук не подвешивает подбор', () => {
    // Только винты, 10 000 шт, чек на 5 000 000 сум: с потолком 20 шт не
    // собирается, повтор без потолка берёт 5 000 шт. Неправдоподобно, но
    // лучше, чем непробитый чек, — и считается мгновенно.
    const started = Date.now()
    const r = planHolistic(500_000_000, pool([item('Винты анкерные', 1_000, 10_000)]))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(r.ok).toBe(true)
  })
})

describe('добор мелочи: наименьшее число штук (сверка с полным перебором)', () => {
  function brute(target: number, fillers: Array<{ sellingPrice: number; qty: number }>) {
    let bestSum = 0
    let bestPieces = 0
    const walk = (i: number, sum: number, pieces: number) => {
      if (sum > target) return
      if (i === fillers.length) {
        if (sum > bestSum || (sum === bestSum && pieces < bestPieces)) {
          bestSum = sum
          bestPieces = pieces
        }
        return
      }
      for (let q = 0; q <= fillers[i]!.qty; q++) walk(i + 1, sum + q * fillers[i]!.sellingPrice, pieces + q)
    }
    walk(0, 0, 0)
    return { bestSum, bestPieces }
  }

  it('совпадает с перебором на 500 случайных примерах', () => {
    let seed = 42
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2 ** 31
      return seed % n
    }
    const prices = [1, 2, 3, 5, 7, 12, 15].map((s) => s * 100_000)
    for (let t = 0; t < 500; t++) {
      const fillers = Array.from({ length: 1 + rnd(4) }, () => ({
        sellingPrice: prices[rnd(prices.length)]!,
        qty: 1 + rnd(5),
      })).sort((a, b) => b.sellingPrice - a.sellingPrice)
      const target = (1 + rnd(40)) * 100_000
      const picks = _fewestPiecesForTests(target, fillers)
      const sum = picks.reduce((s, p) => s + p.qty * fillers[p.index]!.sellingPrice, 0)
      const pieces = picks.reduce((s, p) => s + p.qty, 0)
      for (const p of picks) expect(p.qty).toBeLessThanOrEqual(fillers[p.index]!.qty)
      const want = brute(target, fillers)
      expect({ sum, pieces }).toEqual({ sum: want.bestSum, pieces: want.bestPieces })
    }
  })
})
