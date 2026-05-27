/**
 * Тесты state-machine refund flow.
 *
 * Не запускаем processRefund напрямую (требует БД + EPOS моков), вместо
 * этого моделируем КЛЮЧЕВЫЕ решения чистой state-machine которая
 * копирует логику processRefund 1-к-1.
 *
 * Покрытие:
 *   - Full refund разрешён если previous=[] (первый)
 *   - Full refund запрещён если есть full в previous
 *   - Full refund запрещён если есть partial в previous (микс-блок)
 *   - Partial refund разрешён если previous=[]
 *   - Partial разрешён если есть partial в previous (cumulative qty)
 *   - Partial запрещён если есть full в previous (нечего возвращать)
 *   - cash/card split: явный override > пропорция > 1-к-1 как оригинал
 *   - sanity check 100 сум tolerance
 */

import { describe, it, expect } from 'vitest'

type Mode = 'full' | 'partial'

interface RefundDecision {
  allowed: boolean
  reason?: string
  mode: Mode
}

/**
 * Pure state-machine копия из processRefund.
 * Возвращает решение: можно ли refund сделать и в каком режиме.
 */
function decideRefund(
  hasSelectedItems: boolean,
  previousRefunds: Array<{ is_partial: 0 | 1 }>,
): RefundDecision {
  const fullExisting = previousRefunds.find((r) => r.is_partial === 0)
  if (fullExisting) {
    return {
      allowed: false,
      reason: 'RefundAlreadyExistsError',
      mode: 'full',
    }
  }
  const isPartial = hasSelectedItems
  // Full запрещён если уже есть partial
  if (!isPartial && previousRefunds.length > 0) {
    return {
      allowed: false,
      reason: 'partial_blocks_full',
      mode: 'full',
    }
  }
  return { allowed: true, mode: isPartial ? 'partial' : 'full' }
}

/**
 * Pure cash/card split (как в processRefund).
 *
 * Priority:
 *  1) Если есть явный override (cash/card !== undefined) — используем как есть
 *  2) Иначе при partial — пропорция к origTotal
 *  3) Иначе full — = original suma
 */
function computeRefundAmounts(
  refundItemsTotal: number,
  origCash: number,
  origCard: number,
  isPartial: boolean,
  overrideCash?: number,
  overrideCard?: number,
): { cash: number; card: number } {
  if (overrideCash !== undefined || overrideCard !== undefined) {
    return { cash: overrideCash ?? 0, card: overrideCard ?? 0 }
  }
  if (isPartial) {
    const origTotal = origCash + origCard
    if (origTotal <= 0) {
      return { cash: refundItemsTotal, card: 0 }
    }
    const ratio = refundItemsTotal / origTotal
    const cash = Math.round(origCash * ratio)
    const card = refundItemsTotal - cash
    return { cash, card }
  }
  // full без override
  return { cash: origCash, card: origCard }
}

// ── decideRefund ───────────────────────────────────────────────────

describe('decideRefund: режим refund', () => {
  describe('первый refund (previous=[])', () => {
    it('full разрешён', () => {
      const d = decideRefund(false, [])
      expect(d.allowed).toBe(true)
      expect(d.mode).toBe('full')
    })

    it('partial разрешён', () => {
      const d = decideRefund(true, [])
      expect(d.allowed).toBe(true)
      expect(d.mode).toBe('partial')
    })
  })

  describe('previous = [full]', () => {
    it('full запрещён', () => {
      const d = decideRefund(false, [{ is_partial: 0 }])
      expect(d.allowed).toBe(false)
      expect(d.reason).toBe('RefundAlreadyExistsError')
    })

    it('partial тоже запрещён (full уже всё)', () => {
      const d = decideRefund(true, [{ is_partial: 0 }])
      expect(d.allowed).toBe(false)
      expect(d.reason).toBe('RefundAlreadyExistsError')
    })
  })

  describe('previous = [partial]', () => {
    it('full запрещён (нельзя смешивать)', () => {
      const d = decideRefund(false, [{ is_partial: 1 }])
      expect(d.allowed).toBe(false)
      expect(d.reason).toBe('partial_blocks_full')
    })

    it('partial разрешён (можно довозвратить)', () => {
      const d = decideRefund(true, [{ is_partial: 1 }])
      expect(d.allowed).toBe(true)
      expect(d.mode).toBe('partial')
    })
  })

  describe('previous = [partial, partial]', () => {
    it('partial разрешён', () => {
      const d = decideRefund(true, [{ is_partial: 1 }, { is_partial: 1 }])
      expect(d.allowed).toBe(true)
    })

    it('full запрещён', () => {
      const d = decideRefund(false, [{ is_partial: 1 }, { is_partial: 1 }])
      expect(d.allowed).toBe(false)
    })
  })

  describe('previous = [partial, full] — сломанные данные', () => {
    it('any refund запрещён (full побеждает)', () => {
      const d = decideRefund(true, [{ is_partial: 1 }, { is_partial: 0 }])
      expect(d.allowed).toBe(false)
      expect(d.reason).toBe('RefundAlreadyExistsError')
    })
  })
})

// ── computeRefundAmounts ──────────────────────────────────────────

describe('computeRefundAmounts: cash/card split', () => {
  describe('full refund без override', () => {
    it('возвращает оригинальные суммы как есть', () => {
      const r = computeRefundAmounts(167_000_000, 155_000_000, 12_000_000, false)
      expect(r.cash).toBe(155_000_000)
      expect(r.card).toBe(12_000_000)
    })
  })

  describe('partial refund без override (пропорция)', () => {
    it('сценарий Хонабод 8243: refund 1 насадки (500к) из 1670к чека', () => {
      const r = computeRefundAmounts(
        500_000,
        155_000_000,
        12_000_000,
        true,
      )
      // ratio = 500000 / 167000000 ≈ 0.002994
      // cash = 155000000 × 0.002994 ≈ 463942
      // card = 500000 - 463942 = 36058
      expect(r.cash + r.card).toBe(500_000) // ровно итог
      // Пропорция сохранена: cash:card ≈ 13:1 (как 155:12)
      expect(r.cash).toBeGreaterThan(r.card * 10)
    })

    it('original только cash → весь partial cash', () => {
      const r = computeRefundAmounts(50_000, 100_000, 0, true)
      expect(r.cash).toBe(50_000)
      expect(r.card).toBe(0)
    })

    it('original только card → весь partial card', () => {
      const r = computeRefundAmounts(50_000, 0, 100_000, true)
      expect(r.cash).toBe(0)
      expect(r.card).toBe(50_000)
    })

    it('origTotal=0 (defensive): весь refund в cash', () => {
      const r = computeRefundAmounts(50_000, 0, 0, true)
      expect(r.cash).toBe(50_000)
      expect(r.card).toBe(0)
    })
  })

  describe('явный override', () => {
    it('cash=X, card=Y используются как есть, игнорируя оригинал', () => {
      const r = computeRefundAmounts(
        500_000,
        155_000_000,
        12_000_000,
        true,
        500_000,
        0,
      )
      expect(r.cash).toBe(500_000)
      expect(r.card).toBe(0)
    })

    it('override.card=0 явно (всё налом)', () => {
      const r = computeRefundAmounts(100_000, 50_000, 50_000, true, 100_000, 0)
      expect(r.cash).toBe(100_000)
      expect(r.card).toBe(0)
    })

    it('частичный override (только cash) — card по умолчанию 0', () => {
      const r = computeRefundAmounts(100_000, 50_000, 50_000, true, 100_000)
      expect(r.cash).toBe(100_000)
      expect(r.card).toBe(0)
    })
  })

  describe('full с явным override (для UX когда возвращают другим способом)', () => {
    it('магазин выдаёт всё налом даже если оригинал был картой', () => {
      const r = computeRefundAmounts(
        100_000,
        0,
        100_000, // оригинал картой
        false,
        100_000, // override: всё налом
        0,
      )
      expect(r.cash).toBe(100_000)
      expect(r.card).toBe(0)
    })
  })
})

// ── EPOS math tolerance sanity check ────────────────────────────────

describe('EPOS math tolerance (100 сум = 10000 тийин)', () => {
  function withinTolerance(refundTotal: number, itemsTotal: number): boolean {
    return Math.abs(refundTotal - itemsTotal) <= 10000
  }

  it('ровно совпадают', () => {
    expect(withinTolerance(500_000, 500_000)).toBe(true)
  })

  it('разница 50 тийин — OK', () => {
    expect(withinTolerance(500_000, 499_950)).toBe(true)
  })

  it('разница 100 сум (10000 тийин) — на границе, OK', () => {
    expect(withinTolerance(500_000, 490_000)).toBe(true)
  })

  it('разница 101 сум (10100 тийин) — превышает', () => {
    expect(withinTolerance(500_000, 489_900)).toBe(false)
  })

  it('сценарий Хонабод 8243: 12M refund vs 167M items → far over tolerance', () => {
    expect(withinTolerance(12_000_000, 167_000_000)).toBe(false)
  })
})
