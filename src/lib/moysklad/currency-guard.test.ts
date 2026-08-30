/**
 * Защита от чека в чужой валюте.
 *
 * Проверяем два требования, которые важнее полноты покрытия:
 *   1) пока учёт в сумах — касса работает как раньше, проверка молчит;
 *   2) когда валюта чужая — чек НЕ уходит в ОФД, потому что заниженная
 *      сумма в налоговой хуже, чем непробитый чек.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  verifyReceiptCurrency,
  currencyIdFromRef,
  resetCurrencyCache,
  EXPECTED_CURRENCY,
} from './currency-guard'

const UZS_ID = 'f1a5d963-4c70-11ed-0a80-0784001a9248'
const USD_ID = '77d87aa9-5b74-11ed-0a80-042b00119142'

const refTo = (id: string) => ({
  meta: { href: `https://api.moysklad.ru/api/remap/1.2/entity/currency/${id}` },
})

const book = (base: string | null) => ({
  base,
  byId: new Map([[UZS_ID, 'UZS'], [USD_ID, 'USD']]),
})

beforeEach(() => resetCurrencyCache())

describe('пока учёт в сумах', () => {
  it('обычный сумовый чек проходит', () => {
    const v = verifyReceiptCurrency({ rate: { currency: refTo(UZS_ID) } }, book('UZS'))
    expect(v.ok).toBe(true)
    expect(v.currency).toBe('UZS')
  })

  it('чек без указанной валюты проходит — это обычная розница', () => {
    // У розничных чеков валюта часто не проставлена явно: подразумевается
    // валюта аккаунта. Блокировать такие — значит остановить торговлю.
    const v = verifyReceiptCurrency({ rate: { currency: { meta: {} } } } as never, book('UZS'))
    expect(v.ok).toBe(true)
  })

  it('незнакомая валюта в справочнике не блокирует', () => {
    // Валюту определить не удалось — это не повод останавливать кассу
    // сегодня ради события, которое ещё не наступило.
    const v = verifyReceiptCurrency(
      { rate: { currency: refTo('00000000-0000-0000-0000-000000000000') } },
      book('UZS'),
    )
    expect(v.ok).toBe(true)
  })
})

describe('когда валюта чужая', () => {
  it('долларовый чек не фискализируется', () => {
    const v = verifyReceiptCurrency({ rate: { currency: refTo(USD_ID) } }, book('UZS'))
    expect(v.ok).toBe(false)
    expect(v.currency).toBe('USD')
    expect(v.reason).toContain('только в сумах')
  })

  it('смена базовой валюты аккаунта останавливает фискализацию целиком', () => {
    // Это главный случай: база стала долларом, значит СУММЫ ВСЕХ документов
    // приходят в центах. Чек на 500 000 сум приедет числом ~4000, и если его
    // пробить — в налоговую уйдёт заниженная сумма.
    const v = verifyReceiptCurrency({ rate: { currency: refTo(UZS_ID) } }, book('USD'))
    expect(v.ok).toBe(false)
    expect(v.base).toBe('USD')
    expect(v.reason).toContain('обратитесь к администратору')
  })

  it('отказ объясняет причину словами кассира, а не кодом', () => {
    const v = verifyReceiptCurrency({ rate: { currency: refTo(USD_ID) } }, book('UZS'))
    expect(v.reason).toBeTruthy()
    expect(v.reason!.length).toBeGreaterThan(20)
    expect(v.reason).not.toMatch(/undefined|null|\[object/)
  })
})

describe('разбор ссылки на валюту', () => {
  it('достаёт идентификатор', () => {
    expect(currencyIdFromRef(refTo(USD_ID))).toBe(USD_ID)
  })

  it('не падает на пустой ссылке', () => {
    expect(currencyIdFromRef(undefined)).toBeNull()
    expect(currencyIdFromRef({ meta: {} })).toBeNull()
  })

  it('ожидаемая валюта — сум: фискальный чек в Узбекистане только в сумах', () => {
    expect(EXPECTED_CURRENCY).toBe('UZS')
  })
})
