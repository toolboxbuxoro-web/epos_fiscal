import { describe, it, expect, vi, beforeEach } from 'vitest'
import { sendSaleWithCardRetry } from '../fiscalize'

vi.mock('@/lib/log', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

const RECEIPT = { Items: [], ReceivedCash: 0, ReceivedCard: 0, Time: '' } as never
const ANSWER = { FiscalSign: 'FS1', TerminalID: 'T1', ReceiptSeq: '1' }

function cardError() {
  return Object.assign(new Error('cannot connect card'), { code: 65534 })
}

/** Клиент, у которого первые `failCount` вызовов падают заданной ошибкой. */
function makeClient(failCount: number, err: () => Error) {
  let calls = 0
  return {
    calls: () => calls,
    sendSaleReceipt: vi.fn(async () => {
      calls += 1
      if (calls <= failCount) throw err()
      return ANSWER
    }),
  }
}

describe('sendSaleWithCardRetry', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))

  it('повторяет один раз и возвращает успех', async () => {
    const client = makeClient(1, cardError)
    const answer = await sendSaleWithCardRetry(client as never, RECEIPT, 'url')
    expect(answer).toEqual(ANSWER)
    expect(client.calls()).toBe(2)
  })

  it('повторяет РОВНО один раз — второй срыв пробрасывается', async () => {
    const client = makeClient(99, cardError)
    await expect(sendSaleWithCardRetry(client as never, RECEIPT, 'url')).rejects.toThrow(
      /cannot connect card/,
    )
    expect(client.calls()).toBe(2)
  })

  it('НЕ повторяет посторонние ошибки — вслепую повторять фискализацию нельзя', async () => {
    const client = makeClient(99, () => new Error('ZREPORT_IS_NOT_OPEN'))
    await expect(sendSaleWithCardRetry(client as never, RECEIPT, 'url')).rejects.toThrow(
      /ZREPORT/,
    )
    expect(client.calls()).toBe(1)
  })

  it('не трогает успешный путь — при успехе ровно один вызов', async () => {
    const client = makeClient(0, cardError)
    await sendSaleWithCardRetry(client as never, RECEIPT, 'url')
    expect(client.calls()).toBe(1)
  })
})
