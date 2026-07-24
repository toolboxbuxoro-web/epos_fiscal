/**
 * parseRequestJsonReceipt — единый парсер fiscal_receipts.request_json.
 *
 * Регресс на прод-баг магазина Хазрати Имом (FDS :3449): UI-парсеры знали
 * только EPOS-формат params.Receipt → у FDS-чеков История показывала прочерки,
 * а Возврат — «0 позиций, сумма чека 0» и блокировался.
 */
import { describe, expect, it } from 'vitest'
import { parseRequestJsonReceipt } from '../request-json'

const EPOS_JSON = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'Api.SendSaleReceipt',
  params: {
    Receipt: {
      Time: '2026-07-24 17:19:00',
      ReceivedCash: 3500000,
      ReceivedCard: 20000000,
      Items: [
        {
          Name: 'Коронка алмазного сверления',
          Price: 23500000,
          Discount: 0,
          Amount: 1000,
          VAT: 2517857,
          VATPercent: 12,
          spic: '08207001007000000',
          packageCode: '1435794',
        },
      ],
    },
  },
})

const FDS_JSON = JSON.stringify({
  factoryId: 'FDS_FACTORY_1',
  receipt: {
    Time: '2026-07-24 17:19:00',
    ReceivedCash: 3500000,
    ReceivedCard: 20000000,
    Type: 0,
    Operation: 0,
    Items: [
      {
        Name: 'Коронка алмазного сверления',
        Barcode: '0',
        SPIC: '08207001007000000',
        Units: 796,
        PackageCode: '1435794',
        OwnerType: 0,
        Amount: 1000,
        Price: 23500000,
        Discount: 0,
        Other: 0,
        VATPercent: 12,
        VAT: 2517857,
      },
    ],
  },
})

describe('parseRequestJsonReceipt', () => {
  it('EPOS JSON-RPC: params.Receipt (spic camelCase)', () => {
    const r = parseRequestJsonReceipt(EPOS_JSON)
    expect(r).not.toBeNull()
    expect(r!.receivedCashTiyin).toBe(3500000)
    expect(r!.receivedCardTiyin).toBe(20000000)
    expect(r!.items).toHaveLength(1)
    expect(r!.items[0]).toEqual({
      name: 'Коронка алмазного сверления',
      classCode: '08207001007000000',
      amount: 1000,
      priceTiyin: 23500000,
      discountTiyin: 0,
      vatTiyin: 2517857,
      vatPercent: 12,
    })
  })

  it('FDS: {factoryId, receipt} (SPIC PascalCase) — регресс Хазрати Имом', () => {
    const r = parseRequestJsonReceipt(FDS_JSON)
    expect(r).not.toBeNull()
    expect(r!.receivedCashTiyin).toBe(3500000)
    expect(r!.receivedCardTiyin).toBe(20000000)
    expect(r!.items).toHaveLength(1)
    // SPIC (PascalCase) должен смаппиться в classCode
    expect(r!.items[0]!.classCode).toBe('08207001007000000')
    expect(r!.items[0]!.priceTiyin).toBe(23500000)
    // Сумма чека из позиций > 0 — Возврат больше не блокируется «суммой 0»
    const total = r!.items.reduce((s, it) => s + it.priceTiyin - it.discountTiyin, 0)
    expect(total).toBe(23500000)
  })

  it('битый JSON → null (UI показывает прочерк, не падает)', () => {
    expect(parseRequestJsonReceipt('{oops')).toBeNull()
    expect(parseRequestJsonReceipt('{}')).toBeNull()
    expect(parseRequestJsonReceipt('{"params":{}}')).toBeNull()
  })
})
