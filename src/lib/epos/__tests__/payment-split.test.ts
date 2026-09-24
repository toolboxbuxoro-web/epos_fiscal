/**
 * Разбивка оплаты нал/карта.
 *
 * Регресс на прод-баг (14.08.2026, Хазрати Имом): МойСклад отдал
 * `cashSum = −1` тийин (артефакт округления), пропорция дала отрицательный
 * ReceivedCash, и FiscalDriveService отверг чек целиком:
 * `HTTP 400 json: cannot unmarshal number -1 into Go struct field
 * Receipt.ReceivedCash`. Касса не могла пробить продажу.
 *
 * Тогда разбивка бралась из розничной продажи, теперь — из платежей
 * отгрузки, но инвариант тот же: обе части ВСЕГДА ≥ 0 и в сумме дают ровно
 * matchedTotal (иначе чек не сойдётся с позициями).
 */
import { describe, expect, it } from 'vitest'
import { splitPayment } from '../fiscalize'

describe('splitPayment', () => {
  it('отрицательные наличные не дают отрицательной оплаты (прод-баг)', () => {
    const r = splitPayment({ cashTiyin: -1, cardTiyin: 418_000_000 }, 418_000_000)
    expect(r.receivedCash).toBe(0)
    expect(r.receivedCard).toBe(418_000_000)
    expect(r.receivedCash + r.receivedCard).toBe(418_000_000)
  })

  it('отрицательная карта тоже режется в ноль', () => {
    const r = splitPayment({ cashTiyin: 100_000, cardTiyin: -5 }, 100_000)
    expect(r.receivedCash).toBeGreaterThanOrEqual(0)
    expect(r.receivedCard).toBeGreaterThanOrEqual(0)
    expect(r.receivedCash + r.receivedCard).toBe(100_000)
  })

  it('только карта', () => {
    expect(splitPayment({ cashTiyin: 0, cardTiyin: 50_000 }, 50_000)).toEqual({ receivedCash: 0, receivedCard: 50_000 })
  })

  it('только наличные', () => {
    expect(splitPayment({ cashTiyin: 30_000, cardTiyin: 0 }, 30_000)).toEqual({ receivedCash: 30_000, receivedCard: 0 })
  })

  it('смешанная: пропорция, сумма сходится точно', () => {
    expect(splitPayment({ cashTiyin: 30_000, cardTiyin: 70_000 }, 100_000)).toEqual({ receivedCash: 30_000, receivedCard: 70_000 })
  })

  it('сумма чека из подбора отличается от платежей — делим в той же пропорции', () => {
    // Платили 100 000 наличными и 50 000 картой, подбор собрался на 180 000.
    expect(splitPayment({ cashTiyin: 10_000_000, cardTiyin: 5_000_000 }, 18_000_000))
      .toEqual({ receivedCash: 12_000_000, receivedCard: 6_000_000 })
  })

  it('остаток округления уходит в карту', () => {
    const r = splitPayment({ cashTiyin: 1, cardTiyin: 2 }, 100)
    expect(r.receivedCash + r.receivedCard).toBe(100)
    expect(r.receivedCash).toBe(33)
  })

  it('обе части ≥ 0 при любом мусоре на входе', () => {
    for (const c of [-1000, -1, 0, 7]) {
      for (const n of [-1000, -1, 0, 7]) {
        const r = splitPayment({ cashTiyin: c, cardTiyin: n }, 10_000)
        expect(r.receivedCash).toBeGreaterThanOrEqual(0)
        expect(r.receivedCard).toBeGreaterThanOrEqual(0)
        expect(r.receivedCash + r.receivedCard).toBe(10_000)
      }
    }
  })
})
