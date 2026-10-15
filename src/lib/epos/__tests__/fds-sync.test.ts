/**
 * Отправка накопленных чеков FiscalDriveService в ОФД и выход из блокировки.
 *
 * Прод-случай (15.10.2026, Хазрати Имом): касса не давала FiscalDriveService
 * команды отправить чеки, они копились в фискальном модуле, и через двое
 * суток он перестал принимать новые — `9031 - SEND_ALL_RECEIPTS_FIRST`.
 * Касса встала с 10:26; заодно сбой карты `SCARD_W_UNRESPONSIVE_CARD`
 * показывался кассиру «Технической ошибкой» без повтора.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@/lib/log', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}))

const { sendPendingToOfd, unsentAgeHours } = await import('../fds-sync')
const { registerWithRecovery, isCardNotConnectedError, CardNotConnectedError, FiscalDriveSendFirstError } =
  await import('../fiscalize')
const { isFdsSendAllFirstError } = await import('../fiscal-drive-client')

const ANSWER = { FiscalSign: 'FS1', TerminalID: 'LG4', ReceiptSeq: 2030, DateTime: '', QRCodeURL: '' }
const err9031 = () =>
  new Error('FiscalDriveService HTTP 500: {"Reason":"9031 - SEND_ALL_RECEIPTS_FIRST","Type":"*applet0400.SWError"}')
const errCard = () =>
  new Error('FiscalDriveService HTTP 500: {"Reason":"SCARD_W_UNRESPONSIVE_CARD","Type":"*errors.errorString"}')

/** Отправка: по пачке на вызов, `batches` — сколько чеков отдаёт каждый вызов. */
function syncClient(batches: number[]) {
  let i = 0
  return {
    syncFullReceipts: vi.fn(async () => {
      const n = batches[i++] ?? 0
      return { Items: Array.from({ length: n }, () => ({ StatusText: 'Acknowledged' })), SuccessfulsCount: n }
    }),
    syncZReports: vi.fn(async () => ({ Items: [{}], SuccessfulsCount: 1 })),
  }
}

describe('sendPendingToOfd', () => {
  it('отправляет пачками по 32, пока сервис отдаёт полные пачки, и Z-отчёты', async () => {
    const client = syncClient([32, 32, 5])
    const r = await sendPendingToOfd(client as never, 'F1')
    expect(r).toEqual({ receipts: 69, zReports: 1 })
    expect(client.syncFullReceipts).toHaveBeenCalledTimes(3)
    expect(client.syncFullReceipts).toHaveBeenCalledWith('F1', 32)
  })

  it('нечего отправлять — один вызов', async () => {
    const client = syncClient([0])
    expect(await sendPendingToOfd(client as never, 'F1')).toEqual({ receipts: 0, zReports: 1 })
    expect(client.syncFullReceipts).toHaveBeenCalledTimes(1)
  })

  it('не зацикливается, даже если сервис всегда отдаёт полную пачку', async () => {
    const client = syncClient(Array(100).fill(32))
    await sendPendingToOfd(client as never, 'F1')
    expect(client.syncFullReceipts).toHaveBeenCalledTimes(20)
  })
})

describe('unsentAgeHours', () => {
  it('считает по часам ФМ: от первого неотправленного до последней операции', () => {
    expect(
      unsentAgeHours({
        ReceiptsCount: 120,
        FirstUnacknowledgedReceiptTime: '2026-10-13 10:00:00',
        LastOperationTime: '2026-10-15 10:26:09',
      }),
    ).toBeCloseTo(48.44, 1)
  })
  it('всё отправлено — null', () => {
    expect(unsentAgeHours({ ReceiptsCount: 0, FirstUnacknowledgedReceiptTime: '2026-10-13 10:00:00', LastOperationTime: '' })).toBeNull()
  })
})

describe('распознавание ошибок FiscalDriveService', () => {
  it('сбой карты FDS — как «cannot connect card» у Communicator', () => {
    expect(isCardNotConnectedError(errCard().message, '')).toBe(true)
    expect(isCardNotConnectedError('FiscalDriveService HTTP 404: {"Reason":"no card found"}', '')).toBe(true)
    expect(isCardNotConnectedError('cannot connect card', '')).toBe(true)
    expect(isCardNotConnectedError(err9031().message, '')).toBe(false)
  })
  it('9031 узнаётся и по коду, и по тексту', () => {
    expect(isFdsSendAllFirstError(err9031().message)).toBe(true)
    expect(isFdsSendAllFirstError(errCard().message)).toBe(false)
  })
})

describe('registerWithRecovery', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  function client(registerFails: Array<() => Error>, batches = [3]) {
    let reg = 0
    return {
      ...syncClient(batches),
      registerReceiptTXID: vi.fn(async () => {
        const f = registerFails[reg++]
        if (f) throw f()
        return ANSWER
      }),
    }
  }

  it('9031: отправляет старые чеки и регистрирует ТОТ ЖЕ TXID', async () => {
    const c = client([err9031])
    expect(await registerWithRecovery(c as never, 'F1', 2060)).toEqual(ANSWER)
    expect(c.syncFullReceipts).toHaveBeenCalled()
    expect(c.registerReceiptTXID).toHaveBeenNthCalledWith(2, 'F1', 2060)
  })

  it('9031 и после отправки — понятная ошибка для кассира', async () => {
    const c = client([err9031, err9031])
    await expect(registerWithRecovery(c as never, 'F1', 2060)).rejects.toBeInstanceOf(FiscalDriveSendFirstError)
  })

  it('9031, а ОФД не отвечает — тоже понятная ошибка, без второй регистрации', async () => {
    const c = client([err9031])
    c.syncFullReceipts.mockRejectedValueOnce(new Error('fetch failed'))
    await expect(registerWithRecovery(c as never, 'F1', 2060)).rejects.toBeInstanceOf(FiscalDriveSendFirstError)
    expect(c.registerReceiptTXID).toHaveBeenCalledTimes(1)
  })

  it('сбой карты: один повтор того же TXID', async () => {
    const c = client([errCard])
    expect(await registerWithRecovery(c as never, 'F1', 2060)).toEqual(ANSWER)
    expect(c.registerReceiptTXID).toHaveBeenCalledTimes(2)
  })

  it('прочие ошибки не трогаем', async () => {
    const c = client([() => new Error('9023 - ZREPORT_IS_ALREADY_CLOSED')])
    await expect(registerWithRecovery(c as never, 'F1', 2060)).rejects.toThrow(/ZREPORT/)
    expect(c.syncFullReceipts).not.toHaveBeenCalled()
  })
})

it('у ошибки блокировки текст для кассира', () => {
  expect(new FiscalDriveSendFirstError().message).toMatch(/интернет/)
  expect(new CardNotConnectedError().message).toMatch(/ещё раз/)
})
