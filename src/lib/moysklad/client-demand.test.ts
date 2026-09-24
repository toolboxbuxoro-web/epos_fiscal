/**
 * Запросы клиента МойСклад для отгрузок.
 *
 * Проверяем то, что ломается молча: фильтр по складу и статусу (без него
 * касса увидит чужие отгрузки), лимит не больше 100 (иначе МойСклад молча
 * отбросит раскрытие позиций и подбор потеряет ИКПУ), и что платежи
 * дотягиваются по своим ссылкам.
 */
import { describe, it, expect, vi } from 'vitest'
import { MoyskladClient } from './client'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const API = 'https://api.moysklad.ru/api/remap/1.2'
const STORE = '1d2c9a4e-5b6f-11ef-0a80-0c3a00112233'
const STATE = '7e8f9a0b-5b6f-11ef-0a80-0c3a00445566'

function fakeFetch(responses: Record<string, unknown>) {
  const calls: string[] = []
  const impl = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    calls.push(u)
    const key = Object.keys(responses).find((k) => u.includes(k))
    const body = key ? responses[key] : { rows: [] }
    return new Response(JSON.stringify(body), { status: 200 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

describe('listRecentDemands', () => {
  it('фильтрует по складу, статусу и курсору, раскрывает позиции', async () => {
    const { impl, calls } = fakeFetch({ '/entity/demand?': { rows: [{ id: 'd1' }] } })
    const client = new MoyskladClient({ basic: 'x', fetchImpl: impl })
    const rows = await client.listRecentDemands(1_700_000_000, STORE, STATE, 500)
    expect(rows).toEqual([{ id: 'd1' }])

    const url = new URL(String(calls[0]))
    const filter = url.searchParams.get('filter') ?? ''
    expect(filter).toContain(`store=${API}/entity/store/${STORE}`)
    expect(filter).toContain(`state=${API}/entity/demand/metadata/states/${STATE}`)
    expect(filter).toMatch(/updated>\d{4}-\d{2}-\d{2} /)
    expect(url.searchParams.get('expand')).toBe('positions.assortment')
    expect(url.searchParams.get('order')).toBe('updated,asc')
  })

  it('лимит не больше 100 — иначе МойСклад молча не раскроет позиции', async () => {
    const { impl, calls } = fakeFetch({})
    await new MoyskladClient({ basic: 'x', fetchImpl: impl }).listRecentDemands(0, STORE, STATE, 500)
    expect(new URL(String(calls[0])).searchParams.get('limit')).toBe('100')
  })
})

describe('getSaleDocument', () => {
  it('отгрузку тянет как demand, старую розничную продажу — как retaildemand', async () => {
    const { impl, calls } = fakeFetch({ '/entity/': { id: 'x' } })
    const client = new MoyskladClient({ basic: 'x', fetchImpl: impl })
    await client.getSaleDocument({ id: 'd1', meta: { href: '', type: 'demand' } })
    await client.getSaleDocument({ id: 'r1', meta: { href: '', type: 'retaildemand' } })
    expect(calls[0]).toContain('/entity/demand/d1')
    expect(calls[1]).toContain('/entity/retaildemand/r1')
  })
})

describe('listDemandPayments', () => {
  it('каждый платёж дотягивается по своей ссылке', async () => {
    const cashHref = `${API}/entity/cashin/c1`
    const payHref = `${API}/entity/paymentin/p1`
    const { impl, calls } = fakeFetch({
      '/entity/cashin/c1': { id: 'c1', sum: 100, meta: { href: cashHref, type: 'cashin' } },
      '/entity/paymentin/p1': { id: 'p1', sum: 200, meta: { href: payHref, type: 'paymentin' } },
    })
    const client = new MoyskladClient({ basic: 'x', fetchImpl: impl })
    const docs = await client.listDemandPayments({
      payments: [{ meta: { href: cashHref, type: 'cashin' } }, { meta: { href: payHref, type: 'paymentin' } }],
    })
    expect(docs.map((d) => d.id)).toEqual(['c1', 'p1'])
    expect(calls).toEqual([cashHref, payHref])
  })

  it('без платежей — ни одного запроса', async () => {
    const { impl, calls } = fakeFetch({})
    const docs = await new MoyskladClient({ basic: 'x', fetchImpl: impl }).listDemandPayments({})
    expect(docs).toEqual([])
    expect(calls).toEqual([])
  })
})

describe('справочники для настроек', () => {
  it('счета всех юрлиц одним списком, с названием юрлица; архивные юрлица пропускаем', async () => {
    const { impl } = fakeFetch({
      '/entity/organization': {
        rows: [
          { id: 'o1', name: 'ООО Тулбокс', accounts: { meta: {}, rows: [{ id: 'a1', accountNumber: '2020 8000' }] } },
          { id: 'o2', name: 'Старое ИП', archived: true, accounts: { meta: {}, rows: [{ id: 'a2', accountNumber: '1' }] } },
          { id: 'o3', name: 'Без счетов', accounts: { meta: { href: 'x' } } },
        ],
      },
    })
    const accounts = await new MoyskladClient({ basic: 'x', fetchImpl: impl }).listOrganizationAccounts()
    expect(accounts).toEqual([{ id: 'a1', accountNumber: '2020 8000', organizationName: 'ООО Тулбокс' }])
  })

  it('статусы отгрузок — из метаданных', async () => {
    const { impl, calls } = fakeFetch({ '/entity/demand/metadata': { states: [{ id: 's1', name: 'Оплачено' }] } })
    const states = await new MoyskladClient({ basic: 'x', fetchImpl: impl }).listDemandStates()
    expect(states).toEqual([{ id: 's1', name: 'Оплачено' }])
    expect(calls[0]).toBe(`${API}/entity/demand/metadata`)
  })

  it('склады без архивных', async () => {
    const { impl } = fakeFetch({
      '/entity/store': { rows: [{ id: 's1', name: 'Основной' }, { id: 's2', name: 'Старый', archived: true }] },
    })
    const stores = await new MoyskladClient({ basic: 'x', fetchImpl: impl }).listStores()
    expect(stores.map((s) => s.id)).toEqual(['s1'])
  })
})
