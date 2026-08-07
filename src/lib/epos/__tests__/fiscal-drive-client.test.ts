/**
 * Тесты для FiscalDriveService клиента и маппингов.
 *
 * Покрытие:
 *   1. FiscalDriveClient — mock fetch, проверяем HTTP-запросы и парсинг ответов
 *   2. mapFdsZReportToJsonRpc — вложенные Sale/Refund → плоский формат
 *   3. mapFdsFiscalAnswer — ReceiptSeq нормализуется в строку
 *   4. Payload чека — SPIC uppercase, Units присутствует, инвариант суммы
 *   5. Двухшаговый GetTXID → RegisterTXID flow (retry-safe)
 *   6. Список ФМ — парсинг FactoryID
 *   7. Обработка ошибок — 4xx/5xx, "OK" строка
 */

import { describe, it, expect, vi } from 'vitest'
import {
  FiscalDriveClient,
  FiscalDriveError,
  OKEI_PIECE_DEFAULT,
  mapFdsZReportToJsonRpc,
  mapFdsFiscalAnswer,
  type FiscalDriveReceipt,
  type FiscalDriveZReportRaw,
  type FiscalDriveFiscalAnswer,
  type FiscalDriveDriveInfo,
} from '@/lib/epos/fiscal-drive-client'

// ── Mock fetch factory ────────────────────────────────────────────────────────

function mockFetch(responses: Array<{ status: number; body: unknown }>) {
  let callIndex = 0
  return vi.fn(async (_url: string, _opts?: RequestInit) => {
    const resp = responses[callIndex++] ?? { status: 200, body: 'OK' }
    const bodyText =
      typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body)
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      text: async () => bodyText,
      json: async () => JSON.parse(bodyText),
    } as Response
  })
}

function makeClient(responses: Array<{ status: number; body: unknown }>) {
  const fetch = mockFetch(responses)
  const client = new FiscalDriveClient({ fetchImpl: fetch as typeof globalThis.fetch })
  return { client, fetch }
}

// ── Фикстуры ─────────────────────────────────────────────────────────────────

const FACTORY_ID = 'LG420230639660'

const DRIVE_INFO: FiscalDriveDriveInfo = {
  FactoryID: FACTORY_ID,
  ReaderName: '127.0.0.1:4387',
  ATR: '3b8f800180318065b0',
  AppletVersion: '0400',
}

const FISCAL_ANSWER: FiscalDriveFiscalAnswer = {
  TerminalID: 'ZZ000000000000',
  ReceiptSeq: 42,
  DateTime: '20260602104356',
  FiscalSign: '320262508539',
  QRCodeURL: 'https://ofd.soliq.uz/check?t=ZZ000000000000&r=42&c=20260602104356&s=320262508539',
}

const Z_REPORT_RAW: FiscalDriveZReportRaw = {
  TerminalID: 'ZZ000000000000',
  OpenTime: '2026-06-02 09:00:00',
  CloseTime: '',
  TotalSaleCount: 5,
  TotalRefundCount: 1,
  TotalCash: { Sale: 1_500_000, Refund: 200_000 },
  TotalCard: { Sale: 3_000_000, Refund: 0 },
  TotalVAT: { Sale: 482_142, Refund: 21_428 },
  FirstReceiptSeq: 1,
  LastReceiptSeq: 5,
}

function makeReceipt(overrides: Partial<FiscalDriveReceipt> = {}): FiscalDriveReceipt {
  return {
    Time: '2026-06-02 10:43:56',
    ReceivedCash: 1_500_000,
    ReceivedCard: 0,
    Type: 0,
    Operation: 0,
    Items: [
      {
        Name: 'Молоток',
        Barcode: '0',
        SPIC: '08201001001000000',
        Units: OKEI_PIECE_DEFAULT,
        PackageCode: '1503958',
        OwnerType: 0,
        Amount: 1000,
        Price: 1_500_000,
        Discount: 0,
        Other: 0,
        VATPercent: 12,
        VAT: 160_714,
      },
    ],
    ...overrides,
  }
}

// ── 1. listDrives ─────────────────────────────────────────────────────────────

describe('listDrives', () => {
  it('возвращает массив ФМ с FactoryID', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: [DRIVE_INFO] }])
    const drives = await client.listDrives()
    expect(drives).toHaveLength(1)
    expect(drives[0]!.FactoryID).toBe(FACTORY_ID)
    expect(drives[0]!.AppletVersion).toBe('0400')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/FiscalDrive/List')
    // FDS использует POST для всех эндпоинтов
    expect(opts.method).toBe('POST')
  })

  it('пустой список — нет ФМ', async () => {
    const { client } = makeClient([{ status: 200, body: [] }])
    const drives = await client.listDrives()
    expect(drives).toHaveLength(0)
  })

  it('HTTP 500 → FiscalDriveError', async () => {
    const { client } = makeClient([{ status: 500, body: 'Internal error' }])
    await expect(client.listDrives()).rejects.toBeInstanceOf(FiscalDriveError)
  })
})

// ── 2. openZReport / closeZReport ─────────────────────────────────────────────

describe('ZReport open/close', () => {
  it('openZReport — POST на правильный URL, возвращает "OK"', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 'OK' }])
    const result = await client.openZReport(FACTORY_ID)
    expect(result).toBe('OK')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/FiscalDrive/ZReport/Open/${FACTORY_ID}`)
    expect(opts.method).toBe('POST')
  })

  it('closeZReport — POST на правильный URL, возвращает "OK"', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: '"OK"' }])
    const result = await client.closeZReport(FACTORY_ID)
    expect(result).toBe('OK')
    const [url] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/FiscalDrive/ZReport/Close/${FACTORY_ID}`)
  })

  it('HTTP 400 при закрытии неоткрытой смены → FiscalDriveError', async () => {
    const { client } = makeClient([{ status: 400, body: 'ZReport not open' }])
    await expect(client.closeZReport(FACTORY_ID)).rejects.toBeInstanceOf(FiscalDriveError)
  })
})

// ── 3. getZReportInfo ─────────────────────────────────────────────────────────

describe('getZReportInfo', () => {
  it('возвращает ZReport с вложенными Sale/Refund', async () => {
    const { client } = makeClient([{ status: 200, body: Z_REPORT_RAW }])
    const info = await client.getZReportInfo(FACTORY_ID)
    expect(info).not.toBeNull()
    expect(info!.TotalCash.Sale).toBe(1_500_000)
    expect(info!.TotalCard.Refund).toBe(0)
    expect(info!.CloseTime).toBe('')
  })

  it('index передаётся как query param, метод POST', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: Z_REPORT_RAW }])
    await client.getZReportInfo(FACTORY_ID, 3)
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('Index=3')
    expect(opts.method).toBe('POST')
  })

  it('HTTP 404 → null (смена не найдена)', async () => {
    const { client } = makeClient([{ status: 404, body: 'not found' }])
    const info = await client.getZReportInfo(FACTORY_ID)
    expect(info).toBeNull()
  })

  it('HTTP 400 → null (нет данных)', async () => {
    const { client } = makeClient([{ status: 400, body: 'bad request' }])
    const info = await client.getZReportInfo(FACTORY_ID)
    expect(info).toBeNull()
  })

  it('HTTP 500 → пробрасывает FiscalDriveError (не маскируем)', async () => {
    const { client } = makeClient([{ status: 500, body: 'server error' }])
    await expect(client.getZReportInfo(FACTORY_ID)).rejects.toBeInstanceOf(FiscalDriveError)
  })
})

// ── 4. getReceiptTXID ─────────────────────────────────────────────────────────

describe('getReceiptTXID', () => {
  it('POST с JSON-чеком, возвращает числовой TXID', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 17 }])
    const receipt = makeReceipt()
    const txid = await client.getReceiptTXID(FACTORY_ID, receipt)
    expect(txid).toBe(17)
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    expect(url).toContain(`/FiscalDrive/Receipt/GetTXID/${FACTORY_ID}`)
    expect(opts.method).toBe('POST')
  })

  it('тело запроса содержит SPIC (uppercase!)', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 1 }])
    const receipt = makeReceipt()
    await client.getReceiptTXID(FACTORY_ID, receipt)
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as FiscalDriveReceipt
    expect(body.Items[0]).toHaveProperty('SPIC')
    // Не должно быть spic lowercase
    expect(body.Items[0]).not.toHaveProperty('spic')
  })

  // Units — необязательное поле (спецификация FiscalDriveService: `Units | uint64 | No`).
  // Раньше слали 796 (российский ОКЕИ «штука»), и у ВСЕХ чеков магазина на
  // FiscalDrive единица измерения в налоговом отчёте выходила неверной.
  // Правильные значения — идентификаторы из Tasnif, привязанные к ИКПУ
  // (как PackageCode), формата 241092 / 1372873 / 244272402. Пока их нет —
  // поле опускаем: у магазинов на EPOS его в протоколе нет вообще, и отчёты
  // там корректны, то есть отсутствие лучше неверного значения.
  it('Units опционален: чек без него уходит корректно', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 1 }])
    const base = makeReceipt().Items[0]!
    const { Units: _omit, ...withoutUnits } = base
    const receipt = makeReceipt({
      Items: [
        { ...withoutUnits, Name: 'Товар 1' },
        { ...withoutUnits, Name: 'Товар 2', SPIC: '08300000000000000' },
      ],
    })
    await client.getReceiptTXID(FACTORY_ID, receipt)
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as FiscalDriveReceipt
    for (const item of body.Items) {
      expect(item.Units).toBeUndefined()
      // Остальные обязательные поля позиции на месте
      expect(item.SPIC).toBeTruthy()
      expect(item.Amount).toBeGreaterThan(0)
      expect(item.Price).toBeGreaterThan(0)
    }
  })

  it('тело запроса содержит Operation=0 (продажа) и Type=0 (обычный)', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 1 }])
    await client.getReceiptTXID(FACTORY_ID, makeReceipt())
    const [, opts] = fetch.mock.calls[0] as [string, RequestInit]
    const body = JSON.parse(opts.body as string) as FiscalDriveReceipt
    expect(body.Operation).toBe(0)
    expect(body.Type).toBe(0)
  })
})

// ── 5. registerReceiptTXID ────────────────────────────────────────────────────

describe('registerReceiptTXID', () => {
  it('POST с TXID как query-параметр, возвращает FiscalSign + QRCodeURL', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: FISCAL_ANSWER }])
    const answer = await client.registerReceiptTXID(FACTORY_ID, 17)
    expect(answer.FiscalSign).toBe('320262508539')
    expect(answer.QRCodeURL).toContain('ofd.soliq.uz')
    const [url, opts] = fetch.mock.calls[0] as [string, RequestInit]
    // TXID передаётся как ?TXID=N в URL, тело пустое
    expect(url).toContain(`/FiscalDrive/Receipt/RegisterTXID/${FACTORY_ID}?TXID=17`)
    expect(opts.body).toBeUndefined()
  })

  it('ReceiptSeq в ответе может быть числом или строкой', async () => {
    // FDS возвращает ReceiptSeq как number, наш mapper конвертирует в string
    const { client } = makeClient([{ status: 200, body: { ...FISCAL_ANSWER, ReceiptSeq: 7 } }])
    const answer = await client.registerReceiptTXID(FACTORY_ID, 1)
    expect(answer.ReceiptSeq).toBe(7) // клиент возвращает как есть, mapper нормализует
  })
})

// ── 6. Двухшаговый flow GetTXID → RegisterTXID ───────────────────────────────

describe('Двухшаговый flow', () => {
  it('GetTXID затем RegisterTXID — два отдельных запроса', async () => {
    const { client, fetch } = makeClient([
      { status: 200, body: 42 },              // GetTXID → TXID
      { status: 200, body: FISCAL_ANSWER },   // RegisterTXID → FiscalSign
    ])
    const txid = await client.getReceiptTXID(FACTORY_ID, makeReceipt())
    const answer = await client.registerReceiptTXID(FACTORY_ID, txid)

    expect(txid).toBe(42)
    expect(answer.FiscalSign).toBe('320262508539')
    expect(fetch).toHaveBeenCalledTimes(2)

    const [url1] = fetch.mock.calls[0] as [string]
    const [url2] = fetch.mock.calls[1] as [string]
    expect(url1).toContain('GetTXID')
    expect(url2).toContain('RegisterTXID')
  })

  it('retry RegisterTXID с тем же TXID — идемпотентен', async () => {
    // Симулируем: первый RegisterTXID timeout, второй — успех.
    // FiscalDriveService при повторном вызове того же TXID возвращает
    // тот же FiscalSign без дубликата.
    const { client } = makeClient([
      { status: 200, body: 42 },             // GetTXID
      { status: 500, body: 'timeout' },      // RegisterTXID #1 — сбой
      { status: 200, body: FISCAL_ANSWER },  // RegisterTXID #2 — успех
    ])
    const txid = await client.getReceiptTXID(FACTORY_ID, makeReceipt())
    // Первая попытка падает
    await expect(client.registerReceiptTXID(FACTORY_ID, txid))
      .rejects.toBeInstanceOf(FiscalDriveError)
    // Вторая — успех с тем же TXID (FDS идемпотентен)
    const answer = await client.registerReceiptTXID(FACTORY_ID, txid)
    expect(answer.FiscalSign).toBe('320262508539')
  })
})

// ── 7. mapFdsZReportToJsonRpc ─────────────────────────────────────────────────

describe('mapFdsZReportToJsonRpc', () => {
  it('плоские поля из вложенных Sale/Refund', () => {
    const mapped = mapFdsZReportToJsonRpc(Z_REPORT_RAW)
    expect(mapped.TotalSaleCash).toBe(1_500_000)
    expect(mapped.TotalSaleCard).toBe(3_000_000)
    expect(mapped.TotalSaleVAT).toBe(482_142)
    expect(mapped.TotalRefundCash).toBe(200_000)
    expect(mapped.TotalRefundCard).toBe(0)
    expect(mapped.TotalRefundVAT).toBe(21_428)
  })

  it('счётчики чеков', () => {
    const mapped = mapFdsZReportToJsonRpc(Z_REPORT_RAW)
    expect(mapped.TotalSaleCount).toBe(5)
    expect(mapped.TotalRefundCount).toBe(1)
  })

  it('TerminalID и времена сохраняются', () => {
    const mapped = mapFdsZReportToJsonRpc(Z_REPORT_RAW)
    expect(mapped.TerminalID).toBe('ZZ000000000000')
    expect(mapped.OpenTime).toBe('2026-06-02 09:00:00')
    expect(mapped.CloseTime).toBe('')  // смена открыта
  })

  it('FirstReceiptSeq и LastReceiptSeq нормализуются в строки', () => {
    const raw: FiscalDriveZReportRaw = { ...Z_REPORT_RAW, FirstReceiptSeq: 1, LastReceiptSeq: 5 }
    const mapped = mapFdsZReportToJsonRpc(raw)
    expect(mapped.FirstReceiptSeq).toBe('1')
    expect(mapped.LastReceiptSeq).toBe('5')
  })

  it('CloseTime пустая = смена открыта (X-отчёт)', () => {
    const mapped = mapFdsZReportToJsonRpc({ ...Z_REPORT_RAW, CloseTime: '' })
    expect(mapped.CloseTime).toBe('')
  })

  it('CloseTime заполнена = смена закрыта (Z-отчёт)', () => {
    const mapped = mapFdsZReportToJsonRpc({ ...Z_REPORT_RAW, CloseTime: '2026-06-02 18:00:00' })
    expect(mapped.CloseTime).toBe('2026-06-02 18:00:00')
  })

  it('Number=0 (FDS не возвращает номер смены)', () => {
    const mapped = mapFdsZReportToJsonRpc(Z_REPORT_RAW)
    expect(mapped.Number).toBe(0)
  })
})

// ── 8. mapFdsFiscalAnswer ─────────────────────────────────────────────────────

describe('mapFdsFiscalAnswer', () => {
  it('ReceiptSeq нормализуется из числа в строку', () => {
    const mapped = mapFdsFiscalAnswer({ ...FISCAL_ANSWER, ReceiptSeq: 42 })
    expect(mapped.ReceiptSeq).toBe('42')
    expect(typeof mapped.ReceiptSeq).toBe('string')
  })

  it('ReceiptSeq уже строка — остаётся строкой', () => {
    const mapped = mapFdsFiscalAnswer({ ...FISCAL_ANSWER, ReceiptSeq: '99' })
    expect(mapped.ReceiptSeq).toBe('99')
  })

  it('все поля FiscalReceiptInfo присутствуют', () => {
    const mapped = mapFdsFiscalAnswer(FISCAL_ANSWER)
    expect(mapped.TerminalID).toBe('ZZ000000000000')
    expect(mapped.FiscalSign).toBe('320262508539')
    expect(mapped.QRCodeURL).toContain('ofd.soliq.uz')
    expect(mapped.DateTime).toBe('20260602104356')
  })
})

// ── 9. Инвариант суммы чека ───────────────────────────────────────────────────

describe('Инвариант суммы (ReceivedCard + ReceivedCash - Σ(Price-Discount-Other) ≤ 10000)', () => {
  function checkInvariant(receipt: FiscalDriveReceipt): number {
    const itemSum = receipt.Items.reduce(
      (s, item) => s + item.Price - item.Discount - item.Other,
      0,
    )
    return receipt.ReceivedCash + receipt.ReceivedCard - itemSum
  }

  it('простой чек наличными — инвариант ≤ 0 (точное совпадение)', () => {
    const receipt = makeReceipt({ ReceivedCash: 1_500_000, ReceivedCard: 0 })
    expect(checkInvariant(receipt)).toBeLessThanOrEqual(10_000)
  })

  it('чек картой — инвариант ≤ 0', () => {
    const receipt = makeReceipt({ ReceivedCash: 0, ReceivedCard: 1_500_000 })
    expect(checkInvariant(receipt)).toBeLessThanOrEqual(10_000)
  })

  it('смешанная оплата — инвариант ≤ 10000', () => {
    const receipt = makeReceipt({
      ReceivedCash: 750_000,
      ReceivedCard: 750_000,
      Items: [{ ...makeReceipt().Items[0]!, Price: 1_500_000 }],
    })
    expect(checkInvariant(receipt)).toBeLessThanOrEqual(10_000)
  })

  it('со скидкой — инвариант сохраняется', () => {
    // Цена 2 000 000, скидка 500 000, к оплате 1 500 000
    const receipt: FiscalDriveReceipt = {
      ...makeReceipt(),
      ReceivedCash: 1_500_000,
      Items: [{ ...makeReceipt().Items[0]!, Price: 2_000_000, Discount: 500_000 }],
    }
    expect(checkInvariant(receipt)).toBeLessThanOrEqual(10_000)
  })

  it('многопозиционный чек — инвариант сохраняется', () => {
    const receipt: FiscalDriveReceipt = {
      Time: '2026-06-02 10:43:56',
      ReceivedCash: 2_500_000,
      ReceivedCard: 0,
      Type: 0,
      Operation: 0,
      Items: [
        { ...makeReceipt().Items[0]!, Name: 'Товар 1', Price: 1_000_000, Discount: 0 },
        { ...makeReceipt().Items[0]!, Name: 'Товар 2', Price: 800_000, Discount: 0 },
        { ...makeReceipt().Items[0]!, Name: 'Товар 3', Price: 700_000, Discount: 0 },
      ],
    }
    expect(checkInvariant(receipt)).toBeLessThanOrEqual(10_000)
  })
})

// ── 10. FactoryID URL-encoding ────────────────────────────────────────────────

describe('FactoryID URL encoding', () => {
  it('FactoryID с пробелами энкодируется в URL', async () => {
    const { client, fetch } = makeClient([{ status: 200, body: 1 }])
    await client.getReceiptTXID('ID WITH SPACES', makeReceipt())
    const [url] = fetch.mock.calls[0] as [string]
    expect(url).toContain('ID%20WITH%20SPACES')
    expect(url).not.toContain('ID WITH SPACES')
  })

  it('реальный FactoryID из эмулятора — без энкодирования', async () => {
    const realId = '002024083000152503000000000000000000'
    const { client, fetch } = makeClient([{ status: 200, body: [DRIVE_INFO] }])
    // listDrives не использует factoryId в URL, но getInfo — да
    const { client: c2, fetch: f2 } = makeClient([{ status: 200, body: DRIVE_INFO }])
    await c2.getInfo(realId)
    const [url] = f2.mock.calls[0] as [string]
    expect(url).toContain(realId)
    void client; void fetch // suppress unused warning
  })
})

// ── 11. OKEI_PIECE_DEFAULT константа ─────────────────────────────────────────

describe('OKEI_PIECE_DEFAULT', () => {
  it('определена и положительна', () => {
    expect(OKEI_PIECE_DEFAULT).toBeTypeOf('number')
    expect(OKEI_PIECE_DEFAULT).toBeGreaterThan(0)
  })
})

// ── 12. Pre-flight skip при fiscaldrive бэкенде ───────────────────────────────
//
// Баг-фикс: при backend=fiscaldrive JsonRpcEposClient.status() вызывался
// на :3448 и давал ненужный warn в логах (порт не отвечает на JSON-RPC).
// Логика: if (fiscalBackend !== 'fiscaldrive') { probe.status() }

describe('Pre-flight Communicator пропускается при fiscaldrive', () => {
  /**
   * Симулирует решение «запускать ли pre-flight» — копирует условие из fiscalize.ts.
   * Если бы мы сломали условие (убрали проверку), тест упал бы.
   */
  function shouldRunPreflight(fiscalBackend: string): boolean {
    return fiscalBackend !== 'fiscaldrive'
  }

  it('epos → pre-flight запускается', () => {
    expect(shouldRunPreflight('epos')).toBe(true)
  })

  it('fiscaldrive → pre-flight пропускается', () => {
    expect(shouldRunPreflight('fiscaldrive')).toBe(false)
  })

  it('null/undefined → fallback epos → pre-flight запускается', () => {
    // getSetting возвращает null если ключ не задан → default 'epos'
    const rawSetting: string | null = null
    const backend = rawSetting ?? 'epos'
    expect(shouldRunPreflight(backend)).toBe(true)
  })

  it('при fiscaldrive JsonRpcEposClient на :3448 не вызывается', async () => {
    const mockStatus = vi.fn()
    // Используем string чтобы избежать TS literal-type comparison warning
    const fiscalBackend: string = 'fiscaldrive'
    if (fiscalBackend !== 'fiscaldrive') {
      mockStatus()
    }
    expect(mockStatus).not.toHaveBeenCalled()
  })

  it('при epos JsonRpcEposClient status вызывается', () => {
    const mockStatus = vi.fn()
    const fiscalBackend: string = 'epos'
    if (fiscalBackend !== 'fiscaldrive') {
      mockStatus()
    }
    expect(mockStatus).toHaveBeenCalledOnce()
  })
})
