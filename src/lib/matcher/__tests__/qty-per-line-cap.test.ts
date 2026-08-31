/**
 * Потолок штук одного товара в строке чека.
 *
 * Реальный случай, из-за которого правило появилось: забивной анкер с
 * приходом 175 сум после округления цены вверх до шага 1000 превращается в
 * товар по 1000 сум с идеальной кратностью. Подбор добивал им любую сумму —
 * дошло до 560 штук в одном чеке на 572 000 сум. За месяц так ушло 10 306
 * штук дешёвых товаров: склад остался без «мелочи», и мелкие чеки стало не
 * из чего собирать.
 *
 * Ограничение намеренно МЯГКОЕ. Неправдоподобный чек хуже красивого, но
 * непробитый чек хуже обоих: если план с потолком не сходится, подбор
 * повторяется без него.
 */

import { describe, it, expect } from 'vitest'
import { planHolistic } from '@/lib/matcher/holistic'
import type { MatcherPool, PoolItem } from '@/lib/matcher/strategies'
import type { EsfItemWithAvailable } from '@/lib/db/esf-items'

let nextId = 1

function mkItem(name: string, unitPriceTiyin: number, availablePcs: number): EsfItemWithAvailable {
  const id = nextId++
  return {
    id,
    source: 'remote',
    external_id: null,
    name,
    barcode: null,
    class_code: `0800000000000${String(id).padStart(4, '0')}`,
    package_code: '',
    vat_percent: 12,
    owner_type: 0,
    unit_price_tiyin: unitPriceTiyin,
    qty_received: availablePcs * 1000,
    qty_consumed: 0,
    received_at: id,
    imported_at: 0,
    notes: null,
    server_item_id: id,
    available: availablePcs * 1000,
  } as EsfItemWithAvailable
}

function mkPool(items: PoolItem[]): MatcherPool {
  const min = items.reduce(
    (m, p) => (p.sellingPrice > 0 && p.sellingPrice < m ? p.sellingPrice : m),
    Number.POSITIVE_INFINITY,
  )
  return {
    items,
    minSellingPrice: Number.isFinite(min) ? min : 0,
    remainingById: new Map(items.map((p) => [p.item.id, p.item.available])),
    chosenBatchByProduct: new Map<string, number>(),
  }
}

/** Дешёвый товар — тот самый «наполнитель»: приход 175 сум, продажа 1000. */
function anchor(availablePcs: number): PoolItem {
  return { item: mkItem('Забивной анкер (цанга)', 17_500, availablePcs), sellingPrice: 100_000 }
}

const maxQty = (plan: { lines: { quantity: number }[] }) =>
  Math.max(...plan.lines.map((l) => l.quantity / 1000))

describe('потолок штук в строке', () => {
  it('не берёт сотни штук одного товара, когда есть чем заменить', () => {
    // 500 000 сум: без потолка ушло бы 500 анкеров одной строкой.
    const pool = mkPool([
      anchor(1000),
      { item: mkItem('Круг абразивный 230', 646_200, 200), sellingPrice: 800_000 },
      { item: mkItem('Диск алмазный 125', 1_817_400, 100), sellingPrice: 2_500_000 },
    ])
    const r = planHolistic(50_000_000, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(maxQty(r.plan)).toBeLessThanOrEqual(20)
  })

  it('уважает заданный потолок, когда сумма в него укладывается', () => {
    const pool = mkPool([
      anchor(1000),
      { item: mkItem('Круг абразивный', 646_200, 200), sellingPrice: 800_000 },
    ])
    // 44 000 сум = 5 кругов по 8000 + 4 анкера по 1000: в потолок 5 влезает.
    const r = planHolistic(4_400_000, pool, { maxQtyPerLine: 5 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(maxQty(r.plan)).toBeLessThanOrEqual(5)
    expect(r.plan.totalTiyin).toBe(4_400_000)
  })

  it('сумма плана сходится с целью, несмотря на потолок', () => {
    const pool = mkPool([
      anchor(500),
      { item: mkItem('Круг абразивный', 646_200, 300), sellingPrice: 800_000 },
      { item: mkItem('Зажим для троса', 86_000, 400), sellingPrice: 200_000 },
    ])
    const target = 30_000_000
    const r = planHolistic(target, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.totalTiyin).toBe(target)
  })

  it('ПРОДАЖУ НЕ БЛОКИРУЕТ: если иначе не собрать — потолок снимается', () => {
    // Склад из одних анкеров. С потолком 20 набрать 200 000 сум невозможно,
    // но отказать кассиру нельзя — берём больше и предупреждаем.
    const pool = mkPool([anchor(1000)])
    const r = planHolistic(20_000_000, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(maxQty(r.plan)).toBeGreaterThan(20)
    expect(r.plan.notes.join(' ')).toMatch(/снято/i)
  })

  it('снятие потолка объясняет причину — чтобы владелец знал, что дозаполнить', () => {
    const pool = mkPool([anchor(1000)])
    const r = planHolistic(20_000_000, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.notes.join(' ')).toMatch(/склад|недорог/i)
  })

  it('когда потолок не мешал — лишних предупреждений нет', () => {
    const pool = mkPool([
      { item: mkItem('Диск алмазный', 1_817_400, 50), sellingPrice: 2_500_000 },
    ])
    const r = planHolistic(5_000_000, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.plan.notes.join(' ')).not.toMatch(/снято/i)
  })

  it('пустой склад отвергается по своей причине, а не из-за потолка', () => {
    const r = planHolistic(1_000_000, mkPool([]), {})
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toBe('POOL_EMPTY')
  })

  it('остаток на складе меньше потолка — берём сколько есть', () => {
    const pool = mkPool([
      anchor(3),
      { item: mkItem('Круг абразивный', 646_200, 50), sellingPrice: 800_000 },
    ])
    const r = planHolistic(8_000_000, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const line = r.plan.lines.find((l) => l.esfItem.name.includes('анкер'))
    if (line) expect(line.quantity / 1000).toBeLessThanOrEqual(3)
  })
})
