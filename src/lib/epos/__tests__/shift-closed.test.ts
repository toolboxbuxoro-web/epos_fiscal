/**
 * isShiftClosedError — распознавание «смена ККМ закрыта» по формулировкам
 * ОБОИХ фискальных протоколов (EPOS Communicator JSON-RPC и FiscalDriveService
 * REST). Используется в fiscalize.ts (продажа) и refund.ts (возврат, обе
 * ветки — EPOS и FDS, см. doc-comment isShiftClosedError в fiscalize.ts).
 *
 * Покрытие:
 *   - EPOS: jsonRpcCode 36909 (не зависит от текста)
 *   - EPOS: ERROR_ZREPORT_IS_NOT_OPEN в message
 *   - FDS: реальная строка HTTP 500 с телом Reason 9023
 *   - Паттерн только в `data` (не в message) — тоже матчится (haystack = оба)
 *   - Похожие, но НЕ те, формулировки → false (не перехватываем лишнее)
 *   - code=undefined + пустые message/data → false
 */
import { describe, expect, it } from 'vitest'
import { isShiftClosedError, isCardNotConnectedError } from '@/lib/epos/fiscalize'

describe('isShiftClosedError', () => {
  it('EPOS jsonRpcCode 36909 → true независимо от текста message/data', () => {
    expect(isShiftClosedError('что угодно', '', 36909)).toBe(true)
    expect(isShiftClosedError('', '', 36909)).toBe(true)
    expect(isShiftClosedError('unrelated text', 'unrelated data', 36909)).toBe(true)
  })

  it('ERROR_ZREPORT_IS_NOT_OPEN в message (EPOS Communicator) → true', () => {
    expect(isShiftClosedError('ERROR_ZREPORT_IS_NOT_OPEN', '', undefined)).toBe(true)
    // regex без ^$ якорей и с флагом i — подстрока и любой регистр тоже матчат
    expect(
      isShiftClosedError('rpc error: error_zreport_is_not_open (36909)', '', undefined),
    ).toBe(true)
  })

  it('реальная строка FiscalDriveService HTTP 500 с Reason 9023 → true', () => {
    const msg = 'FiscalDriveService HTTP 500: {"Reason":"9023 - ZREPORT_IS_ALREADY_CLOSED"}'
    expect(isShiftClosedError(msg, '', undefined)).toBe(true)
  })

  it('паттерн только в data, message не при чём → всё равно true (haystack = message + data)', () => {
    expect(
      isShiftClosedError('generic RPC error', 'ERROR_ZREPORT_IS_NOT_OPEN', undefined),
    ).toBe(true)
    expect(
      isShiftClosedError(
        'generic RPC error',
        '{"Reason":"9023 - ZREPORT_IS_ALREADY_CLOSED"}',
        undefined,
      ),
    ).toBe(true)
  })

  it('похожие, но НЕ те формулировки → false (не перехватываем лишнее)', () => {
    // ZReport просто недоступен/не найден — не то же самое что «закрыта».
    expect(isShiftClosedError('ZREPORT_INFO_UNAVAILABLE', '', undefined)).toBe(false)
    // Печать Z-отчёта упала — наш собственный ESC/POS код, не Communicator.
    expect(isShiftClosedError('failed to print zreport', '', undefined)).toBe(false)
    // Обычный сетевой таймаут — не про смену вообще.
    expect(isShiftClosedError('request timeout after 5000ms', '', undefined)).toBe(false)
    expect(isShiftClosedError('context deadline exceeded', '', undefined)).toBe(false)
  })

  it('code=undefined и пустые message/data → false', () => {
    expect(isShiftClosedError('', '', undefined)).toBe(false)
  })

  it('code задан, но НЕ 36909, и текст не матчит → false', () => {
    expect(isShiftClosedError('терминал не подключён', '', 36912)).toBe(false)
  })
})

describe('isCardNotConnectedError', () => {
  it('ловит реальный ответ Communicator', () => {
    expect(isCardNotConnectedError('cannot connect card', '')).toBe(true)
  })

  it('не зависит от регистра и лишних пробелов', () => {
    expect(isCardNotConnectedError('Cannot  Connect  Card', '')).toBe(true)
  })

  it('находит текст в data, а не только в message', () => {
    expect(isCardNotConnectedError('', '{"detail":"cannot connect card"}')).toBe(true)
  })

  it('НЕ срабатывает на посторонней ошибке с тем же кодом 65534', () => {
    // 65534 = 0xFFFE, дежурный «прочая ошибка» Communicator: под ним
    // приезжает что угодно, поэтому ловим только по тексту.
    expect(isCardNotConnectedError('printer is offline', '')).toBe(false)
    expect(isCardNotConnectedError('ZREPORT_IS_NOT_OPEN', '')).toBe(false)
  })

  it('не путается со смежной формулировкой про карту оплаты', () => {
    expect(isCardNotConnectedError('card payment declined', '')).toBe(false)
  })
})

describe('смена закрыта: ответ FiscalDriveService', () => {
  it('ловит реальный ответ FDS «9023 - ZREPORT_IS_ALREADY_CLOSED»', () => {
    // Ровно тот текст, что пришёл на кассе Хазрати Имом. Собственный регексп
    // пути FDS его не ловил — ждал «not ... open», а пришло «is already closed».
    const msg =
      'FiscalDriveService HTTP 500: {"Reason":"9023 - ZREPORT_IS_ALREADY_CLOSED",' +
      '"Type":"*applet0400.SWError"}'
    expect(isShiftClosedError(msg, '')).toBe(true)
  })

  it('прочая ошибка FDS смену не приплетает', () => {
    expect(
      isShiftClosedError('FiscalDriveService HTTP 500: {"Reason":"9010 - CARD_ERROR"}', ''),
    ).toBe(false)
  })
})
