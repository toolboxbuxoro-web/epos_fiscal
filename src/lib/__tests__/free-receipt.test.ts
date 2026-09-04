import { describe, it, expect } from 'vitest'
import {
  buildFreeMatchResult,
  buildSyntheticMsReceipt,
  isFreeReceipt,
  FREE_RECEIPT_PREFIX,
  resolvePayment,
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

describe('раскладка оплаты', () => {
  const TOTAL = 1_300_000

  it('наличными — всё в наличные', () => {
    expect(resolvePayment('cash', TOTAL, 0)).toEqual({ cashTiyin: TOTAL, cardTiyin: 0 })
  })

  it('картой — всё на карту', () => {
    expect(resolvePayment('card', TOTAL, 0)).toEqual({ cashTiyin: 0, cardTiyin: TOTAL })
  })

  it('смешанная — карта берёт остаток', () => {
    expect(resolvePayment('mixed', TOTAL, 500_000)).toEqual({
      cashTiyin: 500_000,
      cardTiyin: 800_000,
    })
  })

  it('сумма частей ВСЕГДА равна итогу — иначе Communicator откажет', () => {
    for (const cash of [0, 1, 7, 499_999, 650_000, TOTAL - 1, TOTAL]) {
      const p = resolvePayment('mixed', TOTAL, cash)
      expect(p.cashTiyin + p.cardTiyin).toBe(TOTAL)
    }
  })

  it('наличная часть больше итога — карта не уходит в минус', () => {
    // Бывает после пересборки плана: сумма уменьшилась, а введённое осталось.
    expect(resolvePayment('mixed', TOTAL, 9_000_000)).toEqual({
      cashTiyin: TOTAL,
      cardTiyin: 0,
    })
  })

  it('отрицательный ввод не ломает раскладку', () => {
    expect(resolvePayment('mixed', TOTAL, -5000)).toEqual({
      cashTiyin: 0,
      cardTiyin: TOTAL,
    })
  })

  it('вся сумма наличными в смешанном режиме — карточной части нет', () => {
    // Тип карты в этом случае в ОФД не уходит: карты в чеке нет.
    expect(resolvePayment('mixed', TOTAL, TOTAL).cardTiyin).toBe(0)
  })

  it('нулевой итог не даёт отрицательных частей', () => {
    expect(resolvePayment('mixed', 0, 100)).toEqual({ cashTiyin: 0, cardTiyin: 0 })
    expect(resolvePayment('cash', 0, 0)).toEqual({ cashTiyin: 0, cardTiyin: 0 })
  })

  it('дробный ввод округляется, инвариант держится', () => {
    const p = resolvePayment('mixed', TOTAL, 333_333.7)
    expect(p.cashTiyin + p.cardTiyin).toBe(TOTAL)
    expect(Number.isInteger(p.cashTiyin)).toBe(true)
  })
})

describe('синтетический чек со смешанной оплатой', () => {
  it('раскладка попадает в чек — по ней считается сплит и колонка «Оплата»', () => {
    const p = resolvePayment('mixed', 1_300_000, 500_000)
    const rd = buildSyntheticMsReceipt({
      sumTiyin: 1_300_000,
      payment: p,
      nowMs: NOW,
      uid: 'mix1',
    })
    expect(rd.cashSum).toBe(500_000)
    expect(rd.noCashSum).toBe(800_000)
    expect((rd.cashSum ?? 0) + (rd.noCashSum ?? 0)).toBe(rd.sum)
  })
})

describe('распознавание ручного чека в Истории', () => {
  it('чек по сумме опознаётся по идентификатору источника', () => {
    // В Истории нет колонки с названием чека, поэтому отличить ручной чек от
    // чека МойСклад можно только по этому признаку.
    const rd = receipt(195_000)
    expect(isFreeReceipt(rd.id)).toBe(true)
  })

  it('чек из МойСклад ручным не считается', () => {
    expect(isFreeReceipt('7a1f0c2e-5b74-11ed-0a80-042b00119142')).toBe(false)
  })

  it('отсутствие источника не ломает признак', () => {
    // LEFT JOIN может не найти запись чека МС — строка Истории должна
    // отрисоваться, а не упасть.
    expect(isFreeReceipt(null)).toBe(false)
    expect(isFreeReceipt(undefined)).toBe(false)
  })

  it('имя чека годится для поиска — по нему кассир и ищет', () => {
    expect(receipt(195_000).name).toMatch(/^Без МС /)
  })
})
