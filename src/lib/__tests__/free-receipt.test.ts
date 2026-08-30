import { describe, it, expect } from 'vitest'
import {
  buildFreeMatchResult,
  buildSyntheticMsReceipt,
  isFreeReceipt,
  FREE_RECEIPT_PREFIX,
} from '../free-receipt'
import { extractPositions } from '../matcher/extract'
import type { HolisticPlan } from '../matcher/types'

const NOW = new Date('2026-08-29T14:05:09.123').getTime()

function receipt(sumTiyin: number, cash = sumTiyin, card = 0) {
  return buildSyntheticMsReceipt({
    sumTiyin,
    payment: { cashTiyin: cash, cardTiyin: card },
    nowMs: NOW,
    uid: 'abc123',
  })
}

describe('синтетический чек', () => {
  it('несёт введённую сумму и раскладку оплаты', () => {
    const rd = receipt(1_300_000, 1_300_000, 0)
    expect(rd.sum).toBe(1_300_000)
    expect(rd.cashSum).toBe(1_300_000)
    expect(rd.noCashSum).toBe(0)
  })

  it('карточная оплата попадает в безналичную часть — от неё зависит тип карты и сплит', () => {
    const rd = receipt(500_000, 0, 500_000)
    expect(rd.cashSum).toBe(0)
    expect(rd.noCashSum).toBe(500_000)
  })

  it('идентификатор помечен префиксом — иначе бухгалтер искал бы документ в МойСклад', () => {
    expect(receipt(100).id).toBe(`${FREE_RECEIPT_PREFIX}abc123`)
    expect(isFreeReceipt(receipt(100).id)).toBe(true)
  })

  it('обычный чек МС префиксом не считается', () => {
    expect(isFreeReceipt('7a1f0c2e-5b74-11ed-0a80-042b00119142')).toBe(false)
    expect(isFreeReceipt(null)).toBe(false)
    expect(isFreeReceipt(undefined)).toBe(false)
  })

  it('имя объясняет кассиру происхождение чека', () => {
    expect(receipt(100).name).toBe('Без МС 29.08 14:05')
  })

  it('дата в формате МойСклад — её парсят и поллер, и история', () => {
    expect(receipt(100).moment).toBe('2026-08-29 14:05:09.123')
  })

  it('позиций нет: подбор идёт от суммы, сравнивать не с чем', () => {
    expect(extractPositions(receipt(1_000_000))).toEqual([])
  })
})

describe('обёртка плана в результат подбора', () => {
  const plan: HolisticPlan = {
    lines: [],
    totalTiyin: 1_300_000,
    notes: ['собрано вручную'],
  } as unknown as HolisticPlan

  it('режим holistic — фискальные строки берутся из плана', () => {
    const r = buildFreeMatchResult(receipt(1_300_000), plan)
    expect(r.mode).toBe('holistic')
    expect(r.holistic).toBe(plan)
    expect(r.positions).toEqual([])
  })

  it('сумма плана сходится с введённой — расхождения нет', () => {
    const r = buildFreeMatchResult(receipt(1_300_000), plan)
    expect(r.matchedTotalTiyin).toBe(1_300_000)
    expect(r.totalDiffTiyin).toBe(0)
  })

  it('расхождение видно, если план не добрал до суммы', () => {
    const r = buildFreeMatchResult(receipt(1_500_000), plan)
    expect(r.totalDiffTiyin).toBe(-200_000)
  })

  it('автофискализация запрещена — сумму ввёл человек, нужно подтверждение', () => {
    expect(buildFreeMatchResult(receipt(1_300_000), plan).canAutoFiscalize).toBe(false)
  })
})
