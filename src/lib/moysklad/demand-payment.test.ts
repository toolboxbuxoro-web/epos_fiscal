/**
 * Оплата отгрузки из связанных платежей.
 *
 * Главное, что проверяем:
 *   1) деньги по платежу относятся к отгрузке по linkedSum, а не по сумме
 *      всего платежа — один платёж часто закрывает несколько документов;
 *   2) поступление на счёт без привязки блокирует чек: угадывать тип
 *      оплаты нельзя, в ОФД уйдёт неверный;
 *   3) чек — это наличные плюс карта и не больше суммы отгрузки.
 */
import { describe, it, expect } from 'vitest'
import {
  idFromHref,
  toLinkedPayment,
  resolveDemandPayment,
  paymentBlocker,
  fiscalPortion,
  type AccountMapping,
  type LinkedPayment,
} from './demand-payment'
import type { MsPaymentDocument } from './types'

const API = 'https://api.moysklad.ru/api/remap/1.2'
const DEMAND = '0b9e2c31-7a1f-11ef-0a80-0c3a00aa0001'
const OTHER_DEMAND = '0b9e2c31-7a1f-11ef-0a80-0c3a00aa0002'
const ORG = 'fae3561a-2e58-11e6-8a84-bae50000004e'
const ACC_CARD = 'aaaaaaaa-1111-11ef-0a80-0c3a00000001'
const ACC_CLICK = 'bbbbbbbb-2222-11ef-0a80-0c3a00000002'
const ACC_UNKNOWN = 'cccccccc-3333-11ef-0a80-0c3a00000003'

const mapping: AccountMapping = {
  [ACC_CARD]: { type: 'card', label: 'Uzcard терминал' },
  [ACC_CLICK]: { type: 'exclude', label: 'Click' },
}

function paymentIn(sum: number, account: string | null, ops?: Array<[string, number]>, extra: Partial<MsPaymentDocument> = {}): MsPaymentDocument {
  return {
    meta: { href: `${API}/entity/paymentin/p-${sum}`, type: 'paymentin' },
    id: `p-${sum}`,
    name: `ВП-${sum}`,
    applicable: true,
    sum,
    organizationAccount: account
      ? { meta: { href: `${API}/entity/organization/${ORG}/accounts/${account}`, type: 'account' } }
      : undefined,
    operations: ops?.map(([id, linkedSum]) => ({ meta: { href: `${API}/entity/demand/${id}`, type: 'demand' }, linkedSum })),
    ...extra,
  }
}

function cashIn(sum: number, extra: Partial<MsPaymentDocument> = {}): MsPaymentDocument {
  return {
    meta: { href: `${API}/entity/cashin/c-${sum}`, type: 'cashin' },
    id: `c-${sum}`,
    name: `ПКО-${sum}`,
    applicable: true,
    sum,
    ...extra,
  }
}

const linked = (docs: MsPaymentDocument[]): LinkedPayment[] =>
  docs.map((d) => toLinkedPayment(d, DEMAND)).filter((p): p is LinkedPayment => p !== null)

describe('idFromHref', () => {
  it('берёт последний сегмент без параметров и в нижнем регистре', () => {
    expect(idFromHref(`${API}/entity/organization/${ORG}/accounts/${ACC_CARD.toUpperCase()}?expand=x`)).toBe(ACC_CARD)
    expect(idFromHref(`${API}/entity/demand/${DEMAND}/`)).toBe(DEMAND)
    expect(idFromHref(undefined)).toBeNull()
    expect(idFromHref('')).toBeNull()
  })
})

describe('toLinkedPayment', () => {
  it('сумма — linkedSum напротив нашей отгрузки, а не весь платёж', () => {
    // Платёж на 1 000 000 сум закрыл две отгрузки: нам 300 000, соседней 700 000.
    const p = toLinkedPayment(paymentIn(100_000_000, ACC_CARD, [[OTHER_DEMAND, 70_000_000], [DEMAND, 30_000_000]]), DEMAND)
    expect(p?.amountTiyin).toBe(30_000_000)
    expect(p?.accountId).toBe(ACC_CARD)
  })

  it('без строки про нашу отгрузку — сумма платежа целиком', () => {
    expect(toLinkedPayment(paymentIn(5_000_000, ACC_CARD), DEMAND)?.amountTiyin).toBe(5_000_000)
  })

  it('непроведённый платёж — черновик, денег ещё нет: пропускаем', () => {
    expect(toLinkedPayment(cashIn(1_000_000, { applicable: false }), DEMAND)).toBeNull()
  })

  it('расходные документы к оплате отгрузки не относятся', () => {
    const out = { ...cashIn(1_000_000), meta: { href: `${API}/entity/cashout/x`, type: 'cashout' } }
    expect(toLinkedPayment(out, DEMAND)).toBeNull()
  })

  it('у приходного ордера нет счёта — это наличные', () => {
    const p = toLinkedPayment(cashIn(2_000_000), DEMAND)
    expect(p).toMatchObject({ kind: 'cashin', accountId: null, amountTiyin: 2_000_000 })
  })

  it('отрицательные копейки МойСклад режем в ноль', () => {
    expect(toLinkedPayment(cashIn(-1), DEMAND)?.amountTiyin).toBe(0)
  })
})

describe('resolveDemandPayment', () => {
  it('приходный ордер — наличные, платёж на счёт терминала — карта', () => {
    const r = resolveDemandPayment(linked([cashIn(20_000_000), paymentIn(10_000_000, ACC_CARD)]), mapping)
    expect(r).toMatchObject({ cashTiyin: 20_000_000, cardTiyin: 10_000_000, excludedTiyin: 0, paidTiyin: 30_000_000 })
    expect(r.unmapped).toEqual([])
  })

  it('счёт Click — мимо ОФД', () => {
    const r = resolveDemandPayment(linked([paymentIn(15_000_000, ACC_CLICK)]), mapping)
    expect(r).toMatchObject({ cashTiyin: 0, cardTiyin: 0, excludedTiyin: 15_000_000 })
  })

  it('счёт без привязки попадает в неизвестные, а не угадывается', () => {
    const r = resolveDemandPayment(linked([paymentIn(7_000_000, ACC_UNKNOWN)]), mapping)
    expect(r.cardTiyin).toBe(0)
    expect(r.unmapped).toEqual([{ id: 'p-7000000', name: 'ВП-7000000', accountId: ACC_UNKNOWN, amountTiyin: 7_000_000 }])
    expect(r.paidTiyin).toBe(7_000_000)
  })

  it('входящий платёж без счёта — тоже неизвестный', () => {
    expect(resolveDemandPayment(linked([paymentIn(1_000_000, null)]), mapping).unmapped).toHaveLength(1)
  })

  it('привязку можно задать и как наличные — например, счёт кассы', () => {
    const r = resolveDemandPayment(linked([paymentIn(3_000_000, ACC_UNKNOWN)]), { [ACC_UNKNOWN]: { type: 'cash' } })
    expect(r.cashTiyin).toBe(3_000_000)
  })

  it('id счёта сравнивается без учёта регистра', () => {
    const upper: AccountMapping = { [ACC_CARD]: { type: 'card' } }
    const r = resolveDemandPayment([{ kind: 'paymentin', id: 'x', name: null, amountTiyin: 100, accountId: ACC_CARD.toUpperCase() }], upper)
    expect(r.cardTiyin).toBe(100)
  })
})

describe('paymentBlocker', () => {
  it('нет ни одного платежа — чек не пробиваем', () => {
    expect(paymentBlocker(resolveDemandPayment([], mapping))).toEqual({ kind: 'no_payments' })
  })

  it('неизвестный счёт важнее: деньги есть, но тип не знаем', () => {
    const r = resolveDemandPayment(linked([cashIn(1_000_000), paymentIn(2_000_000, ACC_UNKNOWN)]), mapping)
    expect(paymentBlocker(r)?.kind).toBe('unmapped')
  })

  it('всё известно — можно пробивать', () => {
    expect(paymentBlocker(resolveDemandPayment(linked([cashIn(1_000_000)]), mapping))).toBeNull()
  })

  it('только Click — не блокер: чек «не фискальный», это решает экран', () => {
    expect(paymentBlocker(resolveDemandPayment(linked([paymentIn(1_000_000, ACC_CLICK)]), mapping))).toBeNull()
  })
})

describe('fiscalPortion', () => {
  it('оплачено полностью наличными и картой — чек на всю отгрузку', () => {
    expect(fiscalPortion({ cashTiyin: 20_000_000, cardTiyin: 10_000_000 }, 30_000_000))
      .toEqual({ targetTiyin: 30_000_000, cashTiyin: 20_000_000, cardTiyin: 10_000_000 })
  })

  it('часть через Click — чек только на наличные и карту', () => {
    // Отгрузка 300 000: 150 000 наличными, 150 000 через Click.
    expect(fiscalPortion({ cashTiyin: 15_000_000, cardTiyin: 0 }, 30_000_000))
      .toEqual({ targetTiyin: 15_000_000, cashTiyin: 15_000_000, cardTiyin: 0 })
  })

  it('переплата не пробивается: доли сохраняются, сумма — как у отгрузки', () => {
    // Отгрузка 100 000, пришло 150 000 наличными и 50 000 картой.
    const r = fiscalPortion({ cashTiyin: 15_000_000, cardTiyin: 5_000_000 }, 10_000_000)
    expect(r.targetTiyin).toBe(10_000_000)
    expect(r.cashTiyin).toBe(7_500_000)
    expect(r.cardTiyin).toBe(2_500_000)
  })

  it('при округлении части всё равно сходятся тийин в тийин', () => {
    const r = fiscalPortion({ cashTiyin: 1, cardTiyin: 2 }, 2)
    expect(r.cashTiyin + r.cardTiyin).toBe(2)
    expect(r.targetTiyin).toBe(2)
  })

  it('отгрузка на ноль — пробивать нечего', () => {
    expect(fiscalPortion({ cashTiyin: 100, cardTiyin: 0 }, 0)).toEqual({ targetTiyin: 0, cashTiyin: 0, cardTiyin: 0 })
  })
})
