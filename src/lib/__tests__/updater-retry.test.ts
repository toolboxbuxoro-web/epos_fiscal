import { describe, it, expect, vi, beforeEach } from 'vitest'

const checkMock = vi.fn()

vi.mock('@tauri-apps/plugin-updater', () => ({ check: () => checkMock() }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

const { checkForUpdate } = await import('../updater')
const { log } = await import('@/lib/log')


/**
 * Дождаться результата, прокручивая виртуальное время: между попытками стоят
 * паузы 2 и 6 секунд, и по-настоящему ждать их в тесте незачем.
 */
async function settle<T>(p: Promise<T>): Promise<T> {
  const done = p.then(
    (v) => ({ ok: true as const, v }),
    (e) => ({ ok: false as const, e }),
  )
  await vi.advanceTimersByTimeAsync(20_000)
  const r = await done
  if (r.ok) return r.v
  throw r.e
}

const UPDATE = { version: '0.11.30', body: '', date: '' }
const netFail = () => new Error('error sending request for url (https://github.com/...)')

describe('проверка обновлений переживает моргание канала', () => {
  beforeEach(() => {
    checkMock.mockReset()
    vi.mocked(log.warn).mockClear()
    vi.mocked(log.error).mockClear()
    vi.useFakeTimers()
  })

  it('со второй попытки находит обновление', async () => {
    // Ровно тот случай, из-за которого кассы неделю сидели на старой версии:
    // на версиях без фоновой проверки одна осечка означала пропуск обновления
    // за всю сессию.
    checkMock.mockRejectedValueOnce(netFail()).mockResolvedValueOnce(UPDATE)
    await expect(settle(checkForUpdate())).resolves.toEqual(UPDATE)
    expect(checkMock).toHaveBeenCalledTimes(2)
  })

  it('пробует три раза и только потом сдаётся', async () => {
    checkMock.mockRejectedValue(netFail())
    await expect(settle(checkForUpdate())).rejects.toThrow(/error sending request/)
    expect(checkMock).toHaveBeenCalledTimes(3)
  })

  it('когда связь есть — лишних запросов не делает', async () => {
    checkMock.mockResolvedValueOnce(UPDATE)
    await settle(checkForUpdate())
    expect(checkMock).toHaveBeenCalledTimes(1)
  })

  it('одиночный срыв не поднимает тревогу — канал магазина моргает постоянно', async () => {
    checkMock.mockRejectedValue(netFail())
    await settle(checkForUpdate()).catch(() => {})
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalled()
  })

  it('затяжной отказ доходит до телеметрии — магазин перестал получать версии', async () => {
    checkMock.mockRejectedValue(netFail())
    await settle(checkForUpdate()).catch(() => {})
    await settle(checkForUpdate()).catch(() => {})
    await settle(checkForUpdate()).catch(() => {})
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(vi.mocked(log.error).mock.calls[0]?.[1]).toMatch(/не получает новые версии/)
  })

  it('успех сбрасывает счётчик — следующая осечка снова тихая', async () => {
    checkMock.mockRejectedValue(netFail())
    await settle(checkForUpdate()).catch(() => {})
    await settle(checkForUpdate()).catch(() => {})
    checkMock.mockReset()
    checkMock.mockResolvedValueOnce(UPDATE)
    await settle(checkForUpdate())

    checkMock.mockReset()
    checkMock.mockRejectedValue(netFail())
    vi.mocked(log.error).mockClear()
    await settle(checkForUpdate()).catch(() => {})
    expect(log.error).not.toHaveBeenCalled()
  })
})
