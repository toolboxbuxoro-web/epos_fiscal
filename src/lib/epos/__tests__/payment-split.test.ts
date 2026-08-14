/**
 * Разбивка оплаты нал/карта.
 *
 * Регресс на прод-баг (14.08.2026, Хазрати Имом): МойСклад отдал
 * `cashSum = −1` тийин (артефакт округления), пропорция дала отрицательный
 * ReceivedCash, и FiscalDriveService отверг чек целиком:
 * `HTTP 400 json: cannot unmarshal number -1 into Go struct field
 * Receipt.ReceivedCash`. Касса не могла пробить продажу.
 *
 * Инвариант, который здесь закрепляется: обе части ВСЕГДА ≥ 0 и в сумме
 * дают ровно matchedTotal (иначе чек не сойдётся с позициями).
 */
import { describe, expect, it } from 'vitest'
import { determinePaymentFromMs } from '../fiscalize'
import type { MsRetailDemand } from '@/lib/moysklad/types'

const rd = (p: Partial<MsRetailDemand>): MsRetailDemand =>
  ({ id: 'x', name: '1', sum: 0, ...p }) as MsRetailDemand

describe('determinePaymentFromMs', () => {
  it('отрицательный cashSum из МС не даёт отрицательной оплаты (прод-баг)', () => {
    const r = determinePaymentFromMs(rd({ cashSum: -1, noCashSum: 418_000_000 }), 418_000_000)
    expect(r.receivedCash).toBe(0)
    expect(r.receivedCard).toBe(418_000_000)
    expect(r.receivedCash + r.receivedCard).toBe(418_000_000)
  })

  it('отрицательный безнал тоже клампится', () => {
    const r = determinePaymentFromMs(rd({ cashSum: 100_000, noCashSum: -5 }), 100_000)
    expect(r.receivedCash).toBeGreaterThanOrEqual(0)
    expect(r.receivedCard).toBeGreaterThanOrEqual(0)
    expect(r.receivedCash + r.receivedCard).toBe(100_000)
  })

  it('только карта', () => {
    const r = determinePaymentFromMs(rd({ cashSum: 0, noCashSum: 50_000 }), 50_000)
    expect(r).toEqual({ receivedCash: 0, receivedCard: 50_000 })
  })

  it('только наличные', () => {
    const r = determinePaymentFromMs(rd({ cashSum: 30_000, noCashSum: 0 }), 30_000)
    expect(r).toEqual({ receivedCash: 30_000, receivedCard: 0 })
  })

  it('смешанная: пропорция, остаток в карту, сумма сходится точно', () => {
    const r = determinePaymentFromMs(rd({ cashSum: 30_000, noCashSum: 70_000 }), 100_000)
    expect(r.receivedCash).toBe(30_000)
    expect(r.receivedCard).toBe(70_000)
  })

  it('Click/Payme съел весь безнал → чек становится наличным', () => {
    const r = determinePaymentFromMs(rd({ cashSum: 40_000, noCashSum: 60_000 }), 40_000, 60_000)
    expect(r).toEqual({ receivedCash: 40_000, receivedCard: 0 })
  })

  it('обе части ≥ 0 при любом мусоре на входе', () => {
    for (const c of [-1000, -1, 0, 7]) {
      for (const n of [-1000, -1, 0, 7]) {
        const r = determinePaymentFromMs(rd({ cashSum: c, noCashSum: n }), 10_000)
        expect(r.receivedCash).toBeGreaterThanOrEqual(0)
        expect(r.receivedCard).toBeGreaterThanOrEqual(0)
        expect(r.receivedCash + r.receivedCard).toBe(10_000)
      }
    }
  })
})
