import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (...a: unknown[]) => fetchMock(...a) }))

import { fetchWithTimeout, RequestTimeoutError } from '../http'

/**
 * Регрессия на реальную поломку: `fetch` без таймаута висел, из-за чего
 * флашер продаж залипал навсегда и магазин молча выпадал из синхронизации.
 */
describe('fetchWithTimeout', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.useFakeTimers()
  })
  afterEach(() => vi.useRealTimers())

  it('возвращает ответ, если сервер ответил вовремя', async () => {
    const res = { status: 200 } as Response
    fetchMock.mockResolvedValue(res)
    await expect(fetchWithTimeout('http://x/y', {}, 1000, 'GET /y')).resolves.toBe(res)
  })

  it('бросает RequestTimeoutError, если ответа нет — а не висит вечно', async () => {
    // Запрос, который сам по себе не завершится никогда: ровно тот случай,
    // что месяц держал очередь Хонабода.
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const p = fetchWithTimeout('http://x/y', {}, 5000, 'POST /sales')
    const assertion = expect(p).rejects.toBeInstanceOf(RequestTimeoutError)
    await vi.advanceTimersByTimeAsync(5001)
    await assertion
  })

  it('в тексте ошибки виден запрос и лимит — чтобы лог читался без раскопок', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const p = fetchWithTimeout('http://x/y', {}, 60_000, 'POST /inventory/sales')
    const assertion = expect(p).rejects.toThrow(/POST \/inventory\/sales.*60 сек/)
    await vi.advanceTimersByTimeAsync(60_001)
    await assertion
  })

  it('прокидывает abort извне как есть, не подменяя его таймаутом', async () => {
    const external = new AbortController()
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_r, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('external abort')))
        }),
    )
    const p = fetchWithTimeout('http://x/y', { signal: external.signal }, 60_000, 'GET /y')
    external.abort()
    await expect(p).rejects.toThrow('external abort')
  })

  it('отменяет запрос на Rust-стороне: в fetch уходит signal', async () => {
    fetchMock.mockResolvedValue({ status: 200 } as Response)
    await fetchWithTimeout('http://x/y', { method: 'POST' }, 1000, 'POST /y')
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(init.method).toBe('POST')
  })

  it('сетевую ошибку отдаёт как есть, не выдавая её за таймаут', async () => {
    fetchMock.mockRejectedValue(new Error('network unreachable'))
    await expect(fetchWithTimeout('http://x/y', {}, 1000, 'GET /y')).rejects.toThrow(
      'network unreachable',
    )
  })
})
