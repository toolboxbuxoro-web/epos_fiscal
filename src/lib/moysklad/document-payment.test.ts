/**
 * Что экран чека узнаёт об оплате: сумму чека, деление на наличные и карту
 * и причину, по которой пробивать нельзя.
 */
import { describe, it, expect } from 'vitest'
import {
  parseAccountMapping,
  paymentFromDemand,
  paymentFromRetail,
  paymentUnavailable,
  isRetailDocument,
} from './document-payment'
import type { MsPaymentDocument } from './types'

const API = 'https://api.moysklad.ru/api/remap/1.2'
const DEMAND = '0b9e2c31-7a1f-11ef-0a80-0c3a00aa0001'
const STATE_PAID = '7e8f9a0b-5b6f-11ef-0a80-0c3a00445566'
const STATE_OTHER = '7e8f9a0b-5b6f-11ef-0a80-0c3a00449999'
const ORG = 'fae3561a-2e58-11e6-8a84-bae50000004e'
const ACC_CARD = 'aaaaaaaa-1111-11ef-0a80-0c3a00000001'
const ACC_CLICK = 'bbbbbbbb-2222-11ef-0a80-0c3a00000002'

const mapping = parseAccountMapping(JSON.stringify({ [ACC_CARD]: { type: 'card', label: 'Uzcard' }, [ACC_CLICK]: 'exclude' }))

const stateRef = (id: string) => ({ meta: { href: `${API}/entity/demand/metadata/states/${id}`, type: 'state' } })

function demand(sum: number, stateId = STATE_PAID) {
  return { id: DEMAND, sum, state: stateRef(stateId) }
}

const cashIn = (sum: number): MsPaymentDocument => ({
  meta: { href: `${API}/entity/cashin/c${sum}`, type: 'cashin' },
  id: `c${sum}`,
  applicable: true,
  sum,
})

const paymentIn = (sum: number, account: string): MsPaymentDocument => ({
  meta: { href: `${API}/entity/paymentin/p${sum}`, type: 'paymentin' },
  id: `p${sum}`,
  applicable: true,
  sum,
  organizationAccount: { meta: { href: `${API}/entity/organization/${ORG}/accounts/${account}`, type: 'account' } },
})

describe('parseAccountMapping', () => {
  it('принимает строку и объект, id приводит к нижнему регистру', () => {
    expect(parseAccountMapping(JSON.stringify({ [ACC_CARD.toUpperCase()]: 'card' }))).toEqual({ [ACC_CARD]: { type: 'card' } })
  })
  it('битые данные — пустая привязка, а не падение', () => {
    expect(parseAccountMapping('не json')).toEqual({})
    expect(parseAccountMapping('[1,2]')).toEqual({})
    expect(parseAccountMapping(null)).toEqual({})
  })
  it('неизвестный тип оплаты отбрасывается', () => {
    expect(parseAccountMapping(JSON.stringify({ [ACC_CARD]: 'crypto' }))).toEqual({})
  })
})

describe('paymentFromDemand', () => {
  it('наличные и карта полностью — чек на всю отгрузку', () => {
    const r = paymentFromDemand(demand(30_000_000), [cashIn(20_000_000), paymentIn(10_000_000, ACC_CARD)], mapping, STATE_PAID)
    expect(r.blocker).toBeNull()
    expect(r.portion).toEqual({ targetTiyin: 30_000_000, cashTiyin: 20_000_000, cardTiyin: 10_000_000 })
    expect(r.excludedTiyin).toBe(0)
    expect(r.unpaidTiyin).toBe(0)
  })

  it('часть через Click — мимо чека, но учитывается как «не пробито»', () => {
    const r = paymentFromDemand(demand(30_000_000), [cashIn(15_000_000), paymentIn(15_000_000, ACC_CLICK)], mapping, STATE_PAID)
    expect(r.portion.targetTiyin).toBe(15_000_000)
    expect(r.excludedTiyin).toBe(15_000_000)
    expect(r.unpaidTiyin).toBe(0)
  })

  it('оплачена частично — пробивать нельзя: доплату потом не пробить', () => {
    const r = paymentFromDemand(demand(30_000_000), [cashIn(10_000_000)], mapping, STATE_PAID)
    expect(r.blocker).toEqual({ kind: 'underpaid', paidTiyin: 10_000_000, sumTiyin: 30_000_000 })
    expect(r.unpaidTiyin).toBe(20_000_000)
    expect(r.portion.targetTiyin).toBe(0)
  })

  it('Click тоже оплата: наличные + Click на всю сумму — пробиваем наличную часть', () => {
    const r = paymentFromDemand(demand(30_000_000), [cashIn(10_000_000), paymentIn(20_000_000, ACC_CLICK)], mapping, STATE_PAID)
    expect(r.blocker).toBeNull()
    expect(r.portion.targetTiyin).toBe(10_000_000)
  })

  it('Click частично, остальное не оплачено — тоже блокер, а не «не фискальный»', () => {
    const r = paymentFromDemand(demand(30_000_000), [paymentIn(10_000_000, ACC_CLICK)], mapping, STATE_PAID)
    expect(r.blocker?.kind).toBe('underpaid')
  })

  it('переплата не блокирует', () => {
    const r = paymentFromDemand(demand(10_000_000), [cashIn(15_000_000)], mapping, STATE_PAID)
    expect(r.blocker).toBeNull()
    expect(r.portion.targetTiyin).toBe(10_000_000)
  })

  it('неизвестный счёт важнее недоплаты', () => {
    const unknown = 'dddddddd-4444-11ef-0a80-0c3a00000004'
    const r = paymentFromDemand(demand(30_000_000), [paymentIn(1_000_000, unknown)], mapping, STATE_PAID)
    expect(r.blocker?.kind).toBe('unmapped')
  })

  it('только Click — пробивать нечего, но это не блокер: экран предложит «не фискальный»', () => {
    const r = paymentFromDemand(demand(5_000_000), [paymentIn(5_000_000, ACC_CLICK)], mapping, STATE_PAID)
    expect(r.blocker).toBeNull()
    expect(r.portion.targetTiyin).toBe(0)
    expect(r.excludedTiyin).toBe(5_000_000)
  })

  it('нет платежей — блокер, и сумма чека не считается', () => {
    const r = paymentFromDemand(demand(5_000_000), [], mapping, STATE_PAID)
    expect(r.blocker).toEqual({ kind: 'no_payments' })
    expect(r.excludedTiyin).toBe(0)
    expect(r.portion.targetTiyin).toBe(0)
  })

  it('платёж на непривязанный счёт — блокер со списком', () => {
    const unknown = 'dddddddd-4444-11ef-0a80-0c3a00000004'
    const r = paymentFromDemand(demand(5_000_000), [paymentIn(5_000_000, unknown)], mapping, STATE_PAID)
    expect(r.blocker?.kind).toBe('unmapped')
  })

  it('отгрузку вывели из статуса «пробить» — пробивать нельзя, даже при оплате', () => {
    const r = paymentFromDemand(demand(5_000_000, STATE_OTHER), [cashIn(5_000_000)], mapping, STATE_PAID)
    expect(r.blocker).toEqual({ kind: 'state_changed' })
  })

  it('статус без учёта регистра', () => {
    const r = paymentFromDemand(demand(5_000_000, STATE_PAID.toUpperCase()), [cashIn(5_000_000)], mapping, STATE_PAID)
    expect(r.blocker).toBeNull()
  })

  it('без статуса в настройках его не проверяем', () => {
    const r = paymentFromDemand(demand(5_000_000, STATE_OTHER), [cashIn(5_000_000)], mapping, null)
    expect(r.blocker).toBeNull()
  })
})

describe('paymentFromRetail — старые розничные чеки', () => {
  it('наличные, карта и QR из самого чека; QR — это карта', () => {
    const r = paymentFromRetail({ sum: 30_000_000, cashSum: 10_000_000, noCashSum: 15_000_000, qrSum: 5_000_000 })
    expect(r.source).toBe('retail')
    expect(r.portion).toEqual({ targetTiyin: 30_000_000, cashTiyin: 10_000_000, cardTiyin: 20_000_000 })
    expect(r.blocker).toBeNull()
  })

  it('все поля пустые — как раньше, наличными на всю сумму', () => {
    const r = paymentFromRetail({ sum: 5_000_000 })
    expect(r.portion).toEqual({ targetTiyin: 5_000_000, cashTiyin: 5_000_000, cardTiyin: 0 })
  })

  it('отрицательные копейки МойСклад не ломают расчёт', () => {
    const r = paymentFromRetail({ sum: 5_000_000, cashSum: -1, noCashSum: 5_000_000 })
    expect(r.portion.cashTiyin).toBe(0)
    expect(r.portion.cardTiyin).toBe(5_000_000)
  })
})

describe('paymentUnavailable и isRetailDocument', () => {
  it('платежи не дотянулись — блокер с текстом ошибки', () => {
    const r = paymentUnavailable({ sum: 100 }, 'нет связи')
    expect(r.blocker).toEqual({ kind: 'payments_unavailable', message: 'нет связи' })
  })

  it('розничный документ узнаётся по meta.type', () => {
    expect(isRetailDocument({ meta: { href: '', type: 'retaildemand' } })).toBe(true)
    expect(isRetailDocument({ meta: { href: '', type: 'demand' } })).toBe(false)
  })
})
