/**
 * Поиск по Истории чеков: нормализация, токенизация, сборка WHERE.
 */
import { describe, expect, it } from 'vitest'
import {
  buildSearchText,
  buildWhere,
  escapeLike,
  normalizeSearch,
  tokenizeQuery,
} from '../receipt-search'

const EPOS_JSON = JSON.stringify({
  params: {
    Receipt: {
      ReceivedCash: 3500000,
      ReceivedCard: 0,
      Items: [
        {
          Name: 'Коронка алмазного сверления 132*450 мм',
          Price: 23500000,
          Amount: 1000,
          VAT: 2517857,
          VATPercent: 12,
          spic: '08207001007000000',
        },
      ],
    },
  },
})

const FDS_JSON = JSON.stringify({
  factoryId: 'FDS_1',
  receipt: {
    ReceivedCash: 0,
    ReceivedCard: 1000000,
    Items: [
      {
        Name: 'Зубило канальное SDS-Plus',
        SPIC: '08205100001000000',
        Amount: 1000,
        Price: 1000000,
        VAT: 107143,
        VATPercent: 12,
      },
    ],
  },
})

describe('normalizeSearch', () => {
  it('приводит к нижнему регистру, включая кириллицу', () => {
    // Ключевой момент: SQLite LIKE не сворачивает кириллицу сам, поэтому
    // регистр обязан схлопываться здесь — иначе «коронка» не найдёт «Коронка».
    expect(normalizeSearch('Коронка АЛМАЗНАЯ')).toBe('коронка алмазная')
  })

  it('схлопывает пробелы и обрезает края', () => {
    expect(normalizeSearch('  Зубило   SDS \n Plus ')).toBe('зубило sds plus')
  })
})

describe('buildSearchText', () => {
  const base = {
    receipt_seq: '8317',
    fiscal_sign: '260038118524',
    terminal_id: 'VG343420011185',
  }

  it('EPOS-чек: имя товара, ИКПУ, номера — всё в нижнем регистре', () => {
    const s = buildSearchText({ ...base, request_json: EPOS_JSON, ms_name: '05401' })
    expect(s).toContain('коронка алмазного сверления 132*450 мм')
    expect(s).toContain('08207001007000000') // ИКПУ
    expect(s).toContain('8317') // № чека ФМ
    expect(s).toContain('260038118524') // фискальный признак
    expect(s).toContain('05401') // № чека МойСклад
    expect(s).toBe(s.toLowerCase())
  })

  it('FDS-чек (магазин на :3449) индексируется так же', () => {
    const s = buildSearchText({ ...base, request_json: FDS_JSON })
    expect(s).toContain('зубило канальное sds-plus')
    expect(s).toContain('08205100001000000')
  })

  it('битый request_json не роняет индексацию — остаются номера', () => {
    const s = buildSearchText({ ...base, request_json: '{oops' })
    expect(s).toContain('8317')
    expect(s).toContain('260038118524')
  })

  it('индексирует и МС-названия (что купили), и ИКПУ-имена (что ушло в ОФД)', () => {
    // Суть подмены ИКПУ: покупатель купил «Дрель Makita», в ОФД уехала
    // «Коронка алмазного сверления». Кассир помнит первое — по нему и ищет,
    // бухгалтер сверяет второе. В индексе обязаны быть оба.
    const s = buildSearchText({
      ...base,
      request_json: EPOS_JSON,
      ms_item_names: ['Дрель аккумуляторная Makita', 'Бур по бетону 8 мм'],
    })
    expect(s).toContain('дрель аккумуляторная makita')
    expect(s).toContain('бур по бетону 8 мм')
    expect(s).toContain('коронка алмазного сверления')
  })
})

describe('tokenizeQuery', () => {
  it('пустой запрос → нет токенов (фильтр не применяется)', () => {
    expect(tokenizeQuery('')).toEqual([])
    expect(tokenizeQuery('   ')).toEqual([])
    expect(tokenizeQuery(undefined)).toEqual([])
  })

  it('несколько слов → отдельные токены в нижнем регистре', () => {
    expect(tokenizeQuery('Коронка 132')).toEqual(['коронка', '132'])
  })

  it('ограничивает число токенов (защита от простыни)', () => {
    expect(tokenizeQuery('a b c d e f g h i')).toHaveLength(6)
  })
})

describe('buildWhere', () => {
  it('без фильтров — пустой WHERE (идём по индексу fiscalized_at)', () => {
    const { sql, params } = buildWhere({})
    expect(sql).toBe('')
    expect(params).toEqual([])
  })

  it('токены соединяются через AND — порядок слов не важен', () => {
    const { sql, params } = buildWhere({ query: 'коронка 132' })
    expect(sql).toBe(
      "WHERE search_text LIKE $1 ESCAPE '\\' AND search_text LIKE $2 ESCAPE '\\'",
    )
    expect(params).toEqual(['%коронка%', '%132%'])
  })

  it('диапазон дат добавляется к текстовому фильтру', () => {
    const { sql, params } = buildWhere({
      query: 'зубило',
      dateFrom: 1000,
      dateTo: 2000,
    })
    expect(sql).toContain('fiscalized_at >= $2')
    expect(sql).toContain('fiscalized_at <= $3')
    expect(params).toEqual(['%зубило%', 1000, 2000])
  })

  it('только период, без текста', () => {
    const { sql, params } = buildWhere({ dateFrom: 500, dateTo: null })
    expect(sql).toBe('WHERE fiscalized_at >= $1')
    expect(params).toEqual([500])
  })

  it('спецсимволы LIKE экранируются — «100%» ищется буквально', () => {
    expect(escapeLike('100%')).toBe('100\\%')
    expect(escapeLike('a_b')).toBe('a\\_b')
    const { params } = buildWhere({ query: '100%' })
    expect(params).toEqual(['%100\\%%'])
  })

  it('нумерация плейсхолдеров сквозная и совпадает с порядком params', () => {
    const { sql, params } = buildWhere({ query: 'a b c', dateFrom: 1, dateTo: 2 })
    // 3 токена + 2 даты = $1..$5, каждый ровно один раз
    for (let i = 1; i <= 5; i++) {
      expect(sql.split(`$${i}`).length - 1).toBe(1)
    }
    expect(params).toHaveLength(5)
  })
})

describe('префикс таблицы для запроса с JOIN', () => {
  it('без префикса SQL прежний — счётчик ходит без JOIN', () => {
    const { sql } = buildWhere({ query: 'насос', dateFrom: null, dateTo: null })
    expect(sql).toContain('search_text LIKE')
    expect(sql).not.toContain('f.search_text')
  })

  it('с префиксом колонки квалифицированы', () => {
    // История подтягивает чек-источник LEFT JOIN'ом: без квалификации
    // одноимённая колонка в ms_receipts сделала бы запрос неоднозначным.
    const { sql } = buildWhere(
      { query: 'насос', dateFrom: 100, dateTo: 200 },
      'f.',
    )
    expect(sql).toContain('f.search_text LIKE')
    expect(sql).toContain('f.fiscalized_at >=')
    expect(sql).toContain('f.fiscalized_at <=')
  })

  it('параметры от префикса не меняются', () => {
    const a = buildWhere({ query: 'насос', dateFrom: 5, dateTo: null })
    const b = buildWhere({ query: 'насос', dateFrom: 5, dateTo: null }, 'f.')
    expect(b.params).toEqual(a.params)
  })

  it('пустой фильтр остаётся пустым и с префиксом', () => {
    expect(buildWhere({ query: '', dateFrom: null, dateTo: null }, 'f.').sql).toBe('')
  })
})
