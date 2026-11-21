/**
 * Pospoint («мобильная касса») — замена E-POS Communicator.
 *
 * Проверяем то, на чём интеграция ломается молча: формат запроса (id только
 * цифрами, версия 1.0.2, ошибки массивом), что считать «чек мог уйти»,
 * перевод наших сумм в цену за единицу целыми сумами, защиту от двойного
 * пробития, возврат строк с одинаковым ИКПУ и понятные кассиру сообщения.
 * Полный путь fiscalize()/processRefund() — в pospoint-flow.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))
const settings = new Map<string, string>()
vi.mock('@/lib/db', () => ({
  getSetting: vi.fn(async (k: string) => settings.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void settings.set(k, v)),
  SettingKey: {
    PospointKey: 'fiscal.pospoint_key',
    PospointUrl: 'fiscal.pospoint_url',
    PospointUnitsCache: 'fiscal.pospoint_units',
    PospointPending: 'fiscal.pospoint_pending',
  },
}))

const client = await import('../pospoint-client')
const pp = await import('../pospoint')
const { parseRequestJsonReceipt } = await import('../request-json')
const {
  PospointClient,
  PospointError,
  PospointNoAnswerError,
  PospointUnavailableError,
  PospointBadResponseError,
  normalizePospointBaseUrl,
} = client

type FetchCall = { url: string; body: Record<string, unknown> | null }

const isHealth = (url: unknown) => String(url).endsWith('/health')
const healthUp = () => new Response(JSON.stringify({ status: 'UP' }), { status: 200 })

/**
 * Программа запущена: на /health отвечает «UP» (клиент спрашивает его перед
 * каждым запросом), остальное — как задано в тесте.
 */
function alive<A extends [string, RequestInit?]>(impl: (...a: A) => Promise<Response>): typeof fetch {
  return ((...a: A) => (isHealth(a[0]) ? Promise.resolve(healthUp()) : impl(...a))) as unknown as typeof fetch
}

/** fetch, который отвечает заранее заданными телами и запоминает запросы. */
function fakeFetch(responses: Array<unknown | ((body: Record<string, unknown>) => unknown)>) {
  const calls: FetchCall[] = []
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    if (isHealth(url)) return healthUp()
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null
    calls.push({ url, body })
    const next = responses.shift()
    const payload = typeof next === 'function' ? (next as (b: Record<string, unknown>) => unknown)(body!) : next
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status: 200 })
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

let urlSeq = 0
/** Свой адрес на каждый клиент — у каждого адреса своя очередь запросов. */
const freshUrl = () => `http://127.0.0.${++urlSeq}:6461`

const line = (over: Partial<{ q: number; price: number; discount: number; vat: number; pkg: string | null; mxik: string; name: string; barcode: string | null }> = {}) => ({
  esfItem: {
    name: over.name ?? 'Дрель ударная',
    class_code: over.mxik ?? '08467000001000000',
    package_code: over.pkg === undefined ? '1461415' : over.pkg,
    owner_type: 0,
    vat_percent: over.vat ?? 12,
    barcode: over.barcode === undefined ? '4780000000017' : over.barcode,
  },
  quantity: over.q ?? 1000,
  priceTiyin: over.price ?? 2_400_000,
  discountTiyin: over.discount ?? 0,
})
const unit = { packageCode: 1461415, unit: 'шт' }

beforeEach(() => {
  settings.clear()
})

describe('сверка счётчиков смены после сбоя (xMoved)', () => {
  const snap = (saleCount: number, refundCount: number, lastReceiptSeq: number) => ({ saleCount, refundCount, lastReceiptSeq })

  it('смена была закрыта, Pospoint открыл её, а чек ФМ отверг (пустая смена, номер 0) — не сдвинулись', () => {
    // Хонабод 20.11, Донбозор 21.11: так выглядел X-отчёт после 36888.
    expect(pp.xMoved('closed', snap(0, 0, 0), 'sale')).toBe(false)
    expect(pp.xMoved('closed', snap(0, 0, 0), 'refund')).toBe(false)
  })

  it('смена была закрыта, а в ней появился чек — сдвинулись', () => {
    expect(pp.xMoved('closed', snap(1, 0, 1), 'sale')).toBe(true)
    expect(pp.xMoved('closed', snap(0, 1, 1), 'refund')).toBe(true)
    expect(pp.xMoved('closed', snap(0, 0, 7), 'sale')).toBe(true)
  })

  it('смена осталась закрытой — не сдвинулись; X-отчёт не прочитан — сравнить не по чему', () => {
    expect(pp.xMoved('closed', 'closed', 'sale')).toBe(false)
    expect(pp.xMoved('closed', null, 'sale')).toBe(null)
    expect(pp.xMoved(null, snap(0, 0, 0), 'sale')).toBe(null)
  })

  it('открытая смена: сравнение счётчиков', () => {
    expect(pp.xMoved(snap(3, 0, 3), snap(3, 0, 3), 'sale')).toBe(false)
    expect(pp.xMoved(snap(3, 0, 3), snap(4, 0, 4), 'sale')).toBe(true)
    expect(pp.xMoved(snap(3, 0, 3), 'closed', 'sale')).toBe(null)
  })
})

describe('клиент: формат запроса и ответа', () => {
  it('POST /pospoint: id только цифрами, версия 1.0.2, ключ кассы', async () => {
    const f = fakeFetch([{ id: 1, result: { id: 77, fiscalSign: 'FS' } }])
    const c = new PospointClient({ baseUrl: 'http://127.0.0.1:6461/pospoint/', key: 'K1', fetchImpl: f.impl })
    const r = await c.registerSaleFull({ items: [], byCash: 1, byCard: 0, type: 'SALE', payCheckNumber: 'A' })
    expect(r.id).toBe(77)
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:6461/pospoint')
    const body = f.calls[0]!.body!
    expect(body).toMatchObject({ method: 'registerSaleFull', key: 'K1', version: '1.0.2' })
    expect(String(body.id)).toMatch(/^\d{1,9}$/)
  })

  it.each([
    ['', 'http://127.0.0.1:6461'],
    ['127.0.0.1', 'http://127.0.0.1:6461'],
    ['127.0.0.1:6461/pospoint', 'http://127.0.0.1:6461'],
    ['http://192.168.1.5:7000/', 'http://192.168.1.5:7000'],
    ['  localhost  ', 'http://localhost:6461'],
  ])('адрес «%s» → %s', (raw, expected) => {
    expect(normalizePospointBaseUrl(raw)).toBe(expected)
  })

  it('ошибки приходят массивом — все попадают в PospointError', async () => {
    const f = fakeFetch([{ id: 0, error: [{ code: 14812, message: 'ITEM_WRONG_PRICE' }, { code: 14813, message: 'ITEM_WRONG_AMOUNT' }] }])
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: f.impl })
    const err = await c.getXReport().catch((e) => e)
    expect(err).toBeInstanceOf(PospointError)
    expect(err.codes).toEqual([14812, 14813])
    expect(err.has(14813)).toBe(true)
  })

  it('запросы идут строго по одному', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => (releaseFirst = r))
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = JSON.parse(String(init!.body)).method as string
      order.push(`start ${method}`)
      if (method === 'syncWithOfd') await firstGate
      order.push(`end ${method}`)
      return new Response(JSON.stringify({ id: 1, result: {} }), { status: 200 })
    })
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: alive(impl) })
    const a = c.syncWithOfd()
    const b = c.checkFmStatus()
    await new Promise((r) => setTimeout(r, 10))
    expect(order).toEqual(['start syncWithOfd'])
    releaseFirst()
    await Promise.all([a, b])
    expect(order).toEqual(['start syncWithOfd', 'end syncWithOfd', 'start checkFmStatus', 'end checkFmStatus'])
  })

  it('чек кассира идёт раньше ждущих фоновых запросов', async () => {
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const impl = vi.fn(async (_url: string, init?: RequestInit) => {
      const method = JSON.parse(String(init!.body)).method as string
      order.push(method)
      if (order.length === 1) await gate
      return new Response(JSON.stringify({ id: 1, result: { id: 1, fiscalSign: 'F', isConnected: true } }), { status: 200 })
    })
    const url = freshUrl()
    const fg = new PospointClient({ baseUrl: url, key: 'K', fetchImpl: alive(impl) })
    const bg = new PospointClient({ baseUrl: url, key: 'K', background: true, fetchImpl: alive(impl) })
    const first = bg.syncWithOfd() // уже выполняется — его не обогнать
    await new Promise((r) => setTimeout(r, 5))
    const waitingBg = bg.checkFmStatus()
    const sale = fg.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'S' })
    release()
    await Promise.all([first, waitingBg, sale])
    expect(order).toEqual(['syncWithOfd', 'registerSaleFull', 'checkFmStatus'])
  })

  it('ошибка одного запроса не ломает очередь', async () => {
    const f = fakeFetch([{ id: 1, error: [{ code: -10, message: 'Cashbox not Active' }] }, { id: 2, result: { isConnected: true } }])
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: f.impl })
    await expect(c.getXReport()).rejects.toBeInstanceOf(PospointError)
    await expect(c.checkFmStatus()).resolves.toEqual({ isConnected: true })
  })

  it('программа выключена — PospointUnavailableError, запрос с чеком не уходит', async () => {
    // Так reqwest сообщает об отказе в соединении на кассе: причины в тексте нет.
    const urls: string[] = []
    const impl = vi.fn(async (url: string) => {
      urls.push(url)
      throw new Error('error sending request for url (http://127.0.0.1:6461/health)')
    })
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: impl as unknown as typeof fetch })
    const e = await c.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'X' }).catch((x) => x)
    expect(e).toBeInstanceOf(PospointUnavailableError)
    expect(client.isPospointOutcomeUnknown(e)).toBe(false)
    expect(urls.every((u) => u.endsWith('/health'))).toBe(true)
  })

  it('программа жива, но запрос оборвался без причины в тексте — исход неизвестен', async () => {
    const impl = vi.fn(async () => {
      throw new Error('error sending request for url (http://127.0.0.1:6461/pospoint)')
    })
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: alive(impl) })
    const e = await c.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'X' }).catch((x) => x)
    expect(e).toBeInstanceOf(PospointNoAnswerError)
    expect(client.isPospointOutcomeUnknown(e)).toBe(true)
  })

  it('соединение оборвалось после отправки — исход неизвестен', async () => {
    const impl = vi.fn(async () => {
      throw new Error('error sending request: connection closed before message completed')
    })
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: alive(impl) })
    const e = await c.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'X' }).catch((x) => x)
    expect(e).toBeInstanceOf(PospointNoAnswerError)
    expect(client.isPospointOutcomeUnknown(e)).toBe(true)
  })

  it.each([
    ['пустое тело', ''],
    ['не JSON', '<html>502</html>'],
    ['пустой список ошибок', { id: 1, error: [] }],
    ['нет result', { id: 1 }],
    ['чек без фискального признака', { id: 1, result: { id: 5 } }],
  ])('непонятный ответ на чек (%s) — исход неизвестен', async (_label, payload) => {
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: fakeFetch([payload]).impl })
    const e = await c.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'X' }).catch((x) => x)
    expect(e).toBeInstanceOf(PospointBadResponseError)
    expect(client.isPospointOutcomeUnknown(e)).toBe(true)
  })

  it('openZReport: success:false — ошибка, а не «смена открыта»', async () => {
    const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: fakeFetch([{ id: 1, result: { success: false } }]).impl })
    await expect(c.openZReport()).rejects.toBeInstanceOf(PospointError)
  })

  describe('таймаут', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('ответа на чек нет 90 секунд — PospointNoAnswerError (результат неизвестен)', async () => {
      const impl = vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(new Error('aborted')))),
      )
      const c = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: alive(impl) })
      const p = c.registerSaleFull({ items: [], byCash: 0, byCard: 0, type: 'SALE', payCheckNumber: 'X' }).catch((e) => e)
      await vi.advanceTimersByTimeAsync(89_000)
      await vi.advanceTimersByTimeAsync(2_000)
      const err = await p
      expect(err).toBeInstanceOf(PospointNoAnswerError)
      expect(client.isPospointOutcomeUnknown(err)).toBe(true)
    })
  })

  it('health: {"status":"UP"} — жив, иначе нет', async () => {
    const ok = new PospointClient({ baseUrl: freshUrl(), key: 'K', fetchImpl: fakeFetch([{ status: 'UP' }]).impl })
    expect(await ok.health()).toBe(true)
    const down = new PospointClient({
      baseUrl: freshUrl(),
      key: 'K',
      fetchImpl: (async () => {
        throw new Error('refused')
      }) as unknown as typeof fetch,
    })
    expect(await down.health()).toBe(false)
  })

  it('getReceiptByPayCheckNumber: пустой result — чека нет', async () => {
    const c = new PospointClient({
      baseUrl: freshUrl(),
      key: 'K',
      fetchImpl: fakeFetch([{ id: 1, result: {} }, { id: 2, result: { id: 5, fiscalSign: 'F' } }]).impl,
    })
    expect(await c.getReceiptByPayCheckNumber('A')).toBeNull()
    expect(await c.getReceiptByPayCheckNumber('A')).toMatchObject({ id: 5 })
  })
})

describe('перевод строки в позицию Pospoint', () => {
  it('сумма делится на количество — цена за штуку без скидки', () => {
    const { item, stored } = pp.toPospointItem(line({ q: 2000, price: 4_800_000 }), unit)
    expect(item).toMatchObject({ amount: 2, price: 24000, taxPercent: 12, unit: 'шт', packageCode: 1461415, ownerType: 0 })
    expect(item.discount).toBeUndefined()
    expect(stored).toMatchObject({ Amount: 2000, Price: 4_800_000, Discount: 0, SPIC: '08467000001000000' })
  })

  it('не делится — цена вверх до целого сума, излишек скидкой, сумма та же', () => {
    // 10 000 сум за 3 шт = 3 333,33… сум за штуку → 3 334 сум, скидка 2 сума.
    const { item, stored } = pp.toPospointItem(line({ q: 3000, price: 1_000_000 }), unit)
    expect(item.price).toBe(3334)
    expect(item.discount).toBe(2)
    expect(item.price * 3 - item.discount!).toBe(10_000)
    expect(stored).toMatchObject({ Price: 1_000_200, Discount: 200 })
    expect(stored.Price - stored.Discount).toBe(1_000_000)
  })

  it('своя скидка строки сохраняется и складывается с излишком', () => {
    const { item, stored } = pp.toPospointItem(line({ q: 3000, price: 1_000_000, discount: 50_000 }), unit)
    expect(stored.Price - stored.Discount).toBe(950_000)
    expect(item.discount).toBe(502)
  })

  it('весовой товар: цена за кг целыми сумами, сумма строки не меньше подбора', () => {
    const { item, stored } = pp.toPospointItem(line({ q: 1500, price: 1_000_000 }), unit)
    expect(item).toMatchObject({ amount: 1.5, price: 6667 })
    expect(Number.isInteger(item.price)).toBe(true)
    expect(stored.Price - stored.Discount).toBe(1_000_000)
    expect(stored.Discount).toBeGreaterThanOrEqual(0)
  })

  it('цена за единицу на ленте никогда не дробная (1 000 случайных строк)', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
    for (let i = 0; i < 1000; i++) {
      const q = (1 + Math.floor(rnd() * 12)) * 1000
      const price = (1 + Math.floor(rnd() * 400_000)) * 100
      const discount = Math.floor(rnd() * price * 0.2)
      const { item, stored } = pp.toPospointItem(line({ q, price, discount }), unit)
      expect(Number.isInteger(item.price)).toBe(true)
      expect(stored.Price - stored.Discount).toBe(price - discount)
      expect(stored.Discount).toBeLessThanOrEqual(stored.Price)
    }
  })

  it.each([
    ['ставка НДС не из 0/6/12', { vat: 15 }],
    ['ИКПУ не из 17 цифр', { mxik: '0846700000' }],
    ['нулевое количество', { q: 0 }],
    ['нулевая цена', { price: 0 }],
    ['скидка больше цены', { price: 1000, discount: 2000 }],
  ])('%s — понятная ошибка, чек не собирается', (_label, over) => {
    expect(() => pp.toPospointItem(line(over), unit)).toThrow(pp.PospointUserError)
  })
})

describe('чек продажи', () => {
  const build = (over: Partial<Parameters<typeof pp.buildPospointSale>[0]> = {}) =>
    pp.buildPospointSale({
      lines: [line({ q: 2000, price: 4_800_000 }), line({ q: 3000, price: 1_000_000 })],
      unitOf: () => unit,
      receivedCash: 3_000_000,
      receivedCard: 2_800_000,
      cardKind: 'corp',
      payCheckNumber: 'demand-uuid-1',
      now: new Date('2026-11-09T10:00:00'),
      ...over,
    })

  it('оплата в сумах, тип SALE, печатаем сами, тип карты корпоративная', () => {
    const { params } = build()
    expect(params).toMatchObject({ byCash: 30000, byCard: 28000, type: 'SALE', print: false, cardType: 1, payCheckNumber: 'demand-uuid-1' })
  })

  it('без карты тип карты не передаётся', () => {
    const { params } = build({ receivedCash: 5_800_000, receivedCard: 0 })
    expect(params.cardType).toBeUndefined()
  })

  it('сумма позиций ≠ оплате — чек не отправляется', () => {
    expect(() => build({ receivedCash: 100 })).toThrow(/≠ оплате/)
  })

  it('request_json: без ключа кассы, читается общим парсером Истории и синка', () => {
    settings.set('fiscal.pospoint_key', 'SECRET-KEY')
    const { requestJson, stored } = build()
    expect(requestJson).not.toContain('SECRET-KEY')
    expect(pp.fiscalFormatOf(requestJson)).toBe('pospoint')
    const parsed = parseRequestJsonReceipt(requestJson)!
    expect(parsed.receivedCashTiyin).toBe(3_000_000)
    expect(parsed.receivedCardTiyin).toBe(2_800_000)
    expect(parsed.items.reduce((s, i) => s + i.priceTiyin - i.discountTiyin, 0)).toBe(5_800_000)
    expect(parsed.items[1]).toMatchObject({ amount: 3000, classCode: '08467000001000000', vatPercent: 12, priceTiyin: 1_000_200 })
    expect(pp.storedItemsOf(requestJson)).toEqual(stored)
  })

  it('форматы других программ определяются верно', () => {
    expect(pp.fiscalFormatOf(JSON.stringify({ params: { Receipt: { Items: [] } } }))).toBe('epos')
    expect(pp.fiscalFormatOf(JSON.stringify({ factoryId: 'F', receipt: { Items: [] } }))).toBe('fiscaldrive')
    expect(pp.fiscalFormatOf('не json')).toBe('unknown')
  })
})

describe('единица измерения', () => {
  const cache = { '08467000001000000': { at: 0, packages: [{ code: 1461415, name: 'шт' }, { code: 1461416, name: 'комплект' }] } }

  it('код из прихода, название из справочника', () => {
    expect(pp.pickUnit(cache, '08467000001000000', '1461416')).toEqual({ packageCode: 1461416, unit: 'комплект' })
  })
  it('кода из прихода нет в справочнике — код наш, «шт», это ошибка данных', () => {
    expect(pp.pickUnit(cache, '08467000001000000', '999')).toMatchObject({ packageCode: 999, unit: 'шт', bad: true })
  })
  it('кода в приходе нет — «шт» из справочника', () => {
    expect(pp.pickUnit(cache, '08467000001000000', null)).toMatchObject({ packageCode: 1461415, unit: 'шт', note: expect.any(String) })
  })
  it('ничего нет — код 0 и «шт», это ошибка данных', () => {
    expect(pp.pickUnit({}, '1', '')).toMatchObject({ packageCode: 0, unit: 'шт', bad: true })
  })

  describe('справочник', () => {
    const mxik = '08467000001000000'
    const fakeUnitsClient = (impl: (m: string) => Promise<unknown>) =>
      ({ getMxikInfo: vi.fn(impl) }) as unknown as InstanceType<typeof PospointClient>

    it('берём только точное совпадение ИКПУ — чужие единицы хуже, чем никаких', async () => {
      const c = fakeUnitsClient(async () => [{ mxik: '08467000001000099', packages: [{ code: 5, nameRu: 'кг' }] }])
      const cache2 = await pp.ensureUnits(c, [mxik])
      expect(cache2[mxik]).toMatchObject({ packages: [], miss: true })
    })

    it('промах справочника не спрашиваем снова в течение суток', async () => {
      const c = fakeUnitsClient(async () => [])
      await pp.ensureUnits(c, [mxik])
      await pp.ensureUnits(c, [mxik])
      expect(c.getMxikInfo).toHaveBeenCalledTimes(1)
    })

    it('касса не отвечает — дальше не спрашиваем (stopOnOutage)', async () => {
      const c = fakeUnitsClient(async () => {
        throw new PospointNoAnswerError('getMxikInfo', 8000)
      })
      await pp.ensureUnits(c, ['1', '2', '3'], { stopOnOutage: true })
      expect(c.getMxikInfo).toHaveBeenCalledTimes(1)
    })
  })
})

describe('ключ кассы', () => {
  it('тестовый ключ из документации как боевой не принимаем', async () => {
    settings.set('fiscal.pospoint_key', client.POSPOINT_TEST_KEY)
    await expect(pp.getPospointClient()).rejects.toThrow(/тестовый ключ/)
  })
  it('без ключа — понятная ошибка', async () => {
    await expect(pp.getPospointClient()).rejects.toThrow(/Не задан ключ/)
  })
})

describe('защита от двойного пробития (sendWithRecovery)', () => {
  const answer = { id: 9, fiscalSign: 'FS9', fmNo: 'LG4', time: Date.parse('2026-11-09T10:00:00'), url: 'u' }
  const x = (saleCount: number, refundCount = 0, lastReceiptSeq: number = saleCount + refundCount) => ({
    saleCount,
    refundCount,
    lastReceiptSeq,
  })
  type FakeClient = Record<'getReceiptByPayCheckNumber' | 'syncWithOfd' | 'syncFmState' | 'getXReport', ReturnType<typeof vi.fn>>
  function fakeClient(over: Partial<FakeClient> = {}) {
    return {
      getReceiptByPayCheckNumber: over.getReceiptByPayCheckNumber ?? vi.fn(async () => null),
      syncWithOfd: over.syncWithOfd ?? vi.fn(async () => ({ sentCount: 3, unsentCount: 0 })),
      syncFmState: over.syncFmState ?? vi.fn(async () => ({ synced: true })),
      getXReport: over.getXReport ?? vi.fn(async () => x(5)),
    } as unknown as InstanceType<typeof PospointClient> & FakeClient
  }
  const err = (...codes: number[]) => new PospointError('registerSaleFull', codes.map((code) => ({ code, message: '' })))
  const noAnswer = () => new PospointNoAnswerError('registerSaleFull', 90_000)

  beforeEach(() => pp.setPospointApplet('0400'))

  it('успех — ответ кассы как есть', async () => {
    const r = await pp.sendWithRecovery(fakeClient(), 'sale', 'N1', async () => answer)
    expect(r).toEqual({ answer, recovered: false })
  })

  it('14824 «уже пробит» — берём чек поиском по номеру', async () => {
    const c = fakeClient({ getReceiptByPayCheckNumber: vi.fn(async () => answer) })
    const r = await pp.sendWithRecovery(c, 'sale', 'N1', async () => {
      throw err(14824)
    })
    expect(r).toEqual({ answer, recovered: true })
  })

  it('14824, но поиск чека не находит — блок, ФМ мог подписать', async () => {
    const e = await pp
      .sendWithRecovery(fakeClient(), 'sale', 'N1', async () => {
        throw err(14824)
      })
      .catch((z) => z)
    expect(e).toBeInstanceOf(pp.PospointOutcomeUnknownError)
    expect(e.fmMaySigned).toBe(true)
  })

  it('ответа нет, но чек пробит — успех, повторно не пробиваем', async () => {
    const call = vi.fn(async () => {
      throw noAnswer()
    })
    const c = fakeClient({ getReceiptByPayCheckNumber: vi.fn(async () => answer) })
    expect(await pp.sendWithRecovery(c, 'sale', 'N1', call)).toEqual({ answer, recovered: true })
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('ответа нет, чека нет, счётчики смены не сдвинулись — «не пробит, нажмите ещё раз»', async () => {
    const c = fakeClient()
    const e = await pp
      .sendWithRecovery(c, 'sale', 'N1', async () => {
        throw noAnswer()
      }, { before: x(5) })
      .catch((z) => z)
    expect(e).toBeInstanceOf(pp.PospointUserError)
    expect(e).not.toBeInstanceOf(pp.PospointOutcomeUnknownError)
    expect(e.message).toMatch(/не пробит/)
  })

  it('ответа нет, чека нет, но счётчики сдвинулись — блок, повтор запрещён', async () => {
    const c = fakeClient({ getXReport: vi.fn(async () => x(6)) })
    const e = await pp
      .sendWithRecovery(c, 'sale', 'N1', async () => {
        throw noAnswer()
      }, { before: x(5) })
      .catch((z) => z)
    expect(e).toBeInstanceOf(pp.PospointOutcomeUnknownError)
    expect(e.fmMaySigned).toBe(true)
  })

  it('ответа нет, чека нет, X-отчёт до отправки не узнали — тоже блок', async () => {
    const e = await pp
      .sendWithRecovery(fakeClient(), 'sale', 'N1', async () => {
        throw noAnswer()
      }, { before: null as never })
      .catch((z) => z)
    expect(e).toBeInstanceOf(pp.PospointOutcomeUnknownError)
  })

  it('поиск чека не отвечает — исход неизвестен, повтор позже', async () => {
    const c = fakeClient({
      getReceiptByPayCheckNumber: vi.fn(async () => {
        throw new PospointBadResponseError('getReceiptByPayCheckNumber', 'чек без признака')
      }),
    })
    const e = await pp
      .sendWithRecovery(c, 'sale', 'N1', async () => {
        throw noAnswer()
      }, { before: x(5) })
      .catch((z) => z)
    expect(e).toBeInstanceOf(pp.PospointOutcomeUnknownError)
    expect(e.fmMaySigned).toBe(false)
  })

  it('ФМ ждёт отправки старых чеков — досылаем в ОФД и повторяем', async () => {
    const call = vi.fn().mockRejectedValueOnce(err(36889)).mockResolvedValueOnce(answer)
    const c = fakeClient()
    expect(await pp.sendWithRecovery(c, 'sale', 'N1', call, { before: x(5) })).toEqual({ answer, recovered: false })
    expect(c.syncWithOfd).toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('досылка ничего не отправила — не повторяем, кассиру понятное сообщение', async () => {
    const call = vi.fn().mockRejectedValue(err(36889))
    const c = fakeClient({ syncWithOfd: vi.fn(async () => ({ sentCount: 0, unsentCount: 7 })) })
    const e = await pp.sendWithRecovery(c, 'sale', 'N1', call, { before: x(5) }).catch((z) => z)
    expect(e.message).toMatch(/не ушли старые/)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it('ФМ требует синхронизации — синхронизируем и повторяем', async () => {
    const call = vi.fn().mockRejectedValueOnce(err(37008)).mockResolvedValueOnce(answer)
    const c = fakeClient()
    expect((await pp.sendWithRecovery(c, 'sale', 'N1', call, { before: x(5) })).answer).toBe(answer)
    expect(c.syncFmState).toHaveBeenCalled()
  })

  it('повтор после лечения только один', async () => {
    const call = vi.fn().mockRejectedValue(err(36889))
    const c = fakeClient()
    await expect(pp.sendWithRecovery(c, 'sale', 'N1', call, { before: x(5) })).rejects.toBeInstanceOf(pp.PospointUserError)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it('возврат: 36872 «нет чека продажи» — ответ, а не сбой, поиск не нужен', async () => {
    const c = fakeClient()
    const e = await pp
      .sendWithRecovery(c, 'refund', 'N1-R1', async () => {
        throw err(36872)
      })
      .catch((z) => z)
    expect(e.message).toMatch(/только на кассе, где пробита продажа/)
    expect(c.getReceiptByPayCheckNumber).not.toHaveBeenCalled()
  })

  it('возврат на апплете 3: 36913 — мало продаж в смене, ОФД не дёргаем', async () => {
    pp.setPospointApplet('0300')
    const call = vi.fn().mockRejectedValue(err(36913))
    const c = fakeClient()
    const e = await pp.sendWithRecovery(c, 'refund', 'N1-R1', call, { before: x(5, 0) }).catch((z) => z)
    expect(e.message).toMatch(/больше, чем продано в этой смене/)
    expect(c.syncWithOfd).not.toHaveBeenCalled()
  })
})

describe('отправка накопленного в ОФД', () => {
  it('останавливается, как только отправка не продвигается', async () => {
    const sync = vi
      .fn()
      .mockResolvedValueOnce({ sentCount: 32, unsentCount: 40 })
      .mockResolvedValueOnce({ sentCount: 0, unsentCount: 40 })
      .mockResolvedValue({ sentCount: 32, unsentCount: 8 })
    const c = { syncWithOfd: sync } as unknown as InstanceType<typeof PospointClient>
    expect(await pp.flushOfd(c, 5)).toBe(32)
    expect(sync).toHaveBeenCalledTimes(2)
  })
})

describe('сообщения кассиру', () => {
  const err = (code: number) => new PospointError('m', [{ code, message: '' }])
  beforeEach(() => pp.setPospointApplet('0400'))

  it.each([
    [14800, 'sale', /ключ кассы/],
    [-12, 'sale', /фискальный режим/],
    [-15, 'sale', /УП-246/],
    [36872, 'refund', /только на кассе, где пробита продажа/],
    [36917, 'refund', /больше, чем продано в этой смене/],
    [36911, 'sale', /Смена переполнена/],
    [14807, 'refund', /Уменьшите сумму/],
    [36888, 'sale', /Время на компьютере/],
  ] as const)('код %s (%s)', (code, op, re) => {
    expect(pp.toUserError(err(code), op).message).toMatch(re)
  })
  it('программа не отвечает — подсказка про «Режим интеграции»', () => {
    expect(pp.toUserError(new PospointUnavailableError('m', 'refused'), 'sale').message).toMatch(/Режим интеграции/)
  })
  it('смена: нет ответа — «обновите экран», а не «чек не пробит»', () => {
    const m = pp.toUserError(new PospointNoAnswerError('closeZReport', 90_000), 'shift').message
    expect(m).toMatch(/Обновите экран/)
    expect(m).not.toMatch(/чек/)
  })
  it('апплет 3: 36897 при закрытии смены — часы, а не «смена не открыта»', () => {
    pp.setPospointApplet('0300')
    expect(pp.toUserError(err(36897), 'shift').message).toMatch(/Время закрытия смены/)
    expect(pp.isPospointShiftClosed(err(36897))).toBe(false)
  })
  it('апплет 4: 36897 — смена не открыта', () => {
    expect(pp.isPospointShiftClosed(err(36897))).toBe(true)
  })
  it('неизвестный код остаётся технической ошибкой', () => {
    const e = err(14812)
    expect(pp.toUserError(e, 'sale')).toBe(e)
  })
})

describe('возврат', () => {
  const sale = pp.buildPospointSale({
    lines: [
      line({ q: 3000, price: 1_000_000 }),
      // Два товара с одним ИКПУ (15 % реальных чеков) — касса по ИКПУ взяла бы первый.
      line({ q: 1000, price: 500_000, mxik: '08205000002000000', name: 'Сверло 6 мм', barcode: null }),
      line({ q: 2000, price: 800_000, mxik: '08205000002000000', name: 'Сверло 8 мм', barcode: '4780000000024' }),
    ],
    unitOf: () => unit,
    receivedCash: 0,
    receivedCard: 2_300_000,
    cardKind: 'fiz',
    payCheckNumber: 'demand-uuid-2',
  })
  const items = pp.storedItemsOf(sale.requestJson)
  const asRefundLine = (i: number, amount = items[i]!.Amount) => ({
    Name: items[i]!.Name,
    spic: items[i]!.SPIC,
    Barcode: items[i]!.Barcode,
    Amount: amount,
    Price: Math.round((items[i]!.Price * amount) / items[i]!.Amount),
    Discount: Math.round((items[i]!.Discount * amount) / items[i]!.Amount),
  })

  it('по номеру чека Pospoint, свой номер документа, цена за штуку как в продаже', () => {
    const { params } = pp.buildPospointRefund({
      originalRequestJson: sale.requestJson,
      originalReceiptSeq: '123',
      lines: [asRefundLine(0, 1000)],
      originalIndexes: [0],
      refundCash: 0,
      refundCard: 333_333,
      cardKind: 'fiz',
      refundIndex: 1,
    })
    expect(params).toMatchObject({ idRefundReceipt: 123, payCheckNumber: 'demand-uuid-2-R1', cardType: 2 })
    expect(params.items[0]).toMatchObject({ amount: 1, price: 3334, mxik: '08467000001000000' })
  })

  it('ИКПУ у двух строк один — шлём штрихкод, а если его нет — только название', () => {
    const { params, ambiguous } = pp.buildPospointRefund({
      originalRequestJson: sale.requestJson,
      originalReceiptSeq: '123',
      lines: [asRefundLine(1), asRefundLine(2)],
      originalIndexes: [1, 2],
      refundCash: 0,
      refundCard: 1_300_000,
      refundIndex: 1,
    })
    expect(params.items[0]).toEqual({ name: 'Сверло 6 мм', amount: 1, price: 5000 })
    expect(params.items[1]).toMatchObject({ name: 'Сверло 8 мм', barcode: '4780000000024' })
    expect(params.items[1]).not.toHaveProperty('mxik')
    expect(ambiguous).toEqual([])
  })

  it('тийины округления сверх стоимости товаров урезаются, крупный перебор — ошибка', () => {
    const base = {
      originalRequestJson: sale.requestJson,
      originalReceiptSeq: '123',
      lines: [asRefundLine(0, 1000)],
      originalIndexes: [0],
      refundCash: 0,
      refundIndex: 1,
    }
    // Стоимость 1 шт: 3334 − 2/3 сума скидки = 3333,33 сума.
    const ok = pp.buildPospointRefund({ ...base, refundCard: 333_334 })
    expect(ok.refundCard).toBe(333_333)
    expect(ok.params.byCard).toBe(3333.33)
    expect(() => pp.buildPospointRefund({ ...base, refundCard: 340_000 })).toThrow(/больше стоимости/)
  })

  it('чек другой программы через Pospoint не возвращается', () => {
    expect(() =>
      pp.buildPospointRefund({
        originalRequestJson: JSON.stringify({ params: { Receipt: { Items: [] } } }),
        originalReceiptSeq: '55',
        lines: [],
        originalIndexes: [],
        refundCash: 1,
        refundCard: 0,
        refundIndex: 1,
      }),
    ).toThrow(pp.PospointUserError)
  })
})

describe('журнал попыток', () => {
  it('нет записи — разбирать нечего, касса не спрашивается', async () => {
    settings.set('fiscal.pospoint_key', 'K')
    const http = await import('@tauri-apps/plugin-http')
    vi.mocked(http.fetch).mockClear()
    await expect(pp.resolvePendingAttempt('N1', 'sale')).resolves.toEqual({ status: 'none' })
    expect(http.fetch).not.toHaveBeenCalled()
  })

  it('ключ проверяется до всего остального — без ключа понятная ошибка', async () => {
    await expect(pp.resolvePendingAttempt('N1', 'sale')).rejects.toThrow(/Не задан ключ/)
  })

  it('отпечаток не зависит от времени — только строки и оплата', () => {
    expect(pp.inputFingerprint({ a: [1, 2], cash: 3 })).toBe(pp.inputFingerprint({ a: [1, 2], cash: 3 }))
    expect(pp.inputFingerprint({ a: [1, 2], cash: 3 })).not.toBe(pp.inputFingerprint({ a: [1, 2], cash: 4 }))
  })

  it('пока кассир пробивает, фоновая проверка знает, что касса занята', async () => {
    let inside = false
    await pp.runPospointForeground(async () => {
      inside = pp.isPospointForegroundBusy()
    })
    expect(inside).toBe(true)
    expect(pp.isPospointForegroundBusy()).toBe(false)
  })
})

describe('X-отчёт', () => {
  it('суммы X-отчёта уже в тийинах, НДС — в продажи', () => {
    const info = pp.mapPospointXReport({
      terminalId: 'LG4',
      openTime: Date.parse('2026-11-09T09:00:05'),
      saleCount: 15,
      saleCashTotal: 90_000_000,
      saleCardTotal: 50_000_000,
      refundCount: 2,
      refundCashTotal: 3_000_000,
      refundCardTotal: 2_000_000,
      totalVat: 14_200_000,
      firstReceiptSeq: 101,
      lastReceiptSeq: 118,
    })
    expect(info).toMatchObject({
      TerminalID: 'LG4',
      Number: 0,
      OpenTime: '2026-11-09 09:00:05',
      CloseTime: '',
      TotalSaleCash: 90_000_000,
      TotalRefundCard: 2_000_000,
      TotalSaleVAT: 14_200_000,
      TotalRefundVAT: 0,
      FirstReceiptSeq: '101',
      LastReceiptSeq: '118',
    })
  })

  it('Z-отчёт: суммы в сумах переводятся в тийины, номер отчёта сохраняется', () => {
    const info = pp.mapPospointZReport({
      reportNumber: 5,
      terminalId: 'LG4',
      openTime: Date.parse('2026-11-09T09:00:00'),
      closeTime: Date.parse('2026-11-09T21:00:00'),
      saleCount: 25,
      saleCashTotal: 1_500_000,
      saleCardTotal: 800_000.5,
      refundCount: 2,
      refundCashTotal: 50_000,
      refundCardTotal: 30_000,
      saleVat: 230_000,
      refundVat: 8_000,
    })
    expect(info).toMatchObject({
      Number: 5,
      CloseTime: '2026-11-09 21:00:00',
      TotalSaleCash: 150_000_000,
      TotalSaleCard: 80_000_050,
      TotalSaleVAT: 23_000_000,
      TotalRefundVAT: 800_000,
    })
  })

  it('смена не открыта: -14 у X-отчёта', () => {
    expect(pp.isPospointShiftClosed(new PospointError('getXReport', [{ code: -14, message: 'Z-report not opened' }]))).toBe(true)
  })
})
