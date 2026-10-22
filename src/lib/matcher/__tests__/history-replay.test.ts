/**
 * Прогон реальной истории продаж через целостный подбор (holistic).
 *
 * Не обычный тест: запускается только с выгрузкой истории с сервера и нужен,
 * чтобы сравнивать варианты подбора на настоящих чеках и настоящем складе, а
 * не на придуманных примерах. Данных в репозитории нет — репозиторий
 * публичный, а в истории себестоимость приходов.
 *
 *   HISTORY_DIR=/путь/к/выгрузке npx vitest run history-replay
 *
 * Выгрузка — четыре JSON-файла прямыми SELECT-ами из mytoolbox (только
 * чтение: `PGOPTIONS='-c default_transaction_read_only=on' psql -At -c …`):
 *
 *   items.json — select coalesce(json_agg(t),'[]') from (select id, name,
 *     class_code, vat_percent, unit_price_tiyin::bigint unit_price_tiyin,
 *     qty_received, qty_consumed, qty_reserved, qty_written_off,
 *     extract(epoch from received_at)::bigint received_at from inv_items) t
 *   events.json — … (select inv_item_id, shop_id, type, quantity,
 *     extract(epoch from created_at)::float8 ts from inv_events where type in
 *     ('admin_manual_insert','admin_manual_adjust','admin_writeoff',
 *     'admin_writeoff_undo','admin_delete','admin_manual_delete','confirmed',
 *     'unconsumed') order by created_at, id) t
 *   sales.json — … (select id, shop_id, extract(epoch from fiscal_datetime)
 *     ::float8 ts, total_tiyin::bigint total_tiyin from inv_sales) t
 *   sale_items.json — … (select sale_id, line_no, inv_item_id, qty_milli,
 *     price_tiyin::bigint price_tiyin, discount_tiyin::bigint discount_tiyin
 *     from inv_sale_items) t
 *
 * Склад на начало периода восстанавливается от
 * текущих остатков назад по журналу inv_events; дальше чеки идут по времени,
 * каждый вариант подбора списывает со СВОЕЙ копии склада. Приходы, правки и
 * списания админа применяются в те же моменты, что и в жизни.
 *
 * Если вариант не собрал чек, списывается то, что ушло в ОФД на самом деле
 * (так в жизни поступает кассир — собирает руками), чтобы склад не
 * «копился» у неудачного варианта.
 */

import { describe, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { planHolistic } from '@/lib/matcher/holistic'
import { calculateSellingPrice, type MatcherPool, type PoolItem } from '@/lib/matcher/strategies'
import type { MatcherOptions } from '@/lib/matcher/types'
import type { EsfItemWithAvailable } from '@/lib/db/esf-items'

const DIR = process.env.HISTORY_DIR
const FROM = Date.parse(process.env.HISTORY_FROM ?? '2026-09-01T00:00:00+05:00') / 1000
const ONLY = process.env.HISTORY_VARIANTS?.split(',')

interface Item {
  id: number
  name: string
  class_code: string
  vat_percent: number
  unit_price_tiyin: number
  qty_received: number
  qty_consumed: number
  qty_reserved: number
  received_at: number
}
interface Ev {
  inv_item_id: number | null
  type: string
  quantity: number
  ts: number
}
interface Sale {
  id: number
  shop_id: number
  ts: number
  total_tiyin: number
}
interface SaleItem {
  sale_id: number
  inv_item_id: number | null
  qty_milli: number
  price_tiyin: number
  discount_tiyin: number
}

const MARKUP = 10
const STEP = 1000
const VAT = 12
/** «Мелочь» — то, о чём спрашивает владелец: продажная цена до 10 000 сум. */
const SMALL = 1_000_000
const BUCKETS: Array<[string, number]> = [
  ['≤10k', 1_000_000],
  ['10-20k', 2_000_000],
  ['20-50k', 5_000_000],
  ['>50k', Number.POSITIVE_INFINITY],
]
const bucketOf = (sell: number) => BUCKETS.find(([, max]) => sell <= max)![0]

const SIGN: Record<string, number> = {
  admin_manual_insert: 1,
  admin_manual_adjust: 1,
  admin_writeoff: 1,
  admin_writeoff_undo: 1,
  admin_delete: 1,
  admin_manual_delete: 1,
  confirmed: -1,
  unconsumed: 1,
}

function load<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DIR!, `${name}.json`), 'utf8')) as T
}

export interface Variant {
  name: string
  opts: MatcherOptions
}

/**
 * Что сравниваем с жизнью: текущий код подбора и, по желанию, его же с
 * другими опциями — `HISTORY_OPTS='{"maxQtyPerLine":10}'`.
 */
export const VARIANTS: Variant[] = [
  { name: 'подбор', opts: {} },
  ...(process.env.HISTORY_OPTS
    ? [{ name: 'с опциями', opts: JSON.parse(process.env.HISTORY_OPTS) as MatcherOptions }]
    : []),
]

interface Stats {
  receipts: number
  ok: number
  fail: Record<string, number>
  lines: number
  units: Record<string, number>
  value: Record<string, number>
  cost: number
  bump: number
  discount: number
  linesOver5: number
  smallReceipts: number
  smallOk: number
  /** Чеков, где мелочь закрыла больше 10 000 сум. */
  heavyFill: number
  /** Чеков, где есть хоть одна строка мелочи. */
  withSmall: number
  /** Сколько дней на складе не было ни одной позиции мелочи. */
  daysNoSmall: number
  /** Позиций мелочи с остатком на конец периода. */
  smallSkuEnd: number
  smallUnitsEnd: number
  /** Партии мелочи, пришедшие за период: сколько дней прожили (null — ещё на складе). */
  smallLife: Array<{ id: number; days: number | null; pcs: number }>
}

function emptyStats(): Stats {
  return {
    receipts: 0,
    ok: 0,
    fail: {},
    lines: 0,
    units: Object.fromEntries(BUCKETS.map(([b]) => [b, 0])),
    value: Object.fromEntries(BUCKETS.map(([b]) => [b, 0])),
    cost: 0,
    bump: 0,
    discount: 0,
    linesOver5: 0,
    smallReceipts: 0,
    smallOk: 0,
    heavyFill: 0,
    withSmall: 0,
    daysNoSmall: 0,
    smallSkuEnd: 0,
    smallUnitsEnd: 0,
    smallLife: [],
  }
}

describe.skipIf(!DIR)('история продаж через holistic', () => {
  it('сравнение вариантов', () => {
    const items = new Map(load<Item[]>('items').map((i) => [i.id, i]))
    const events = load<Ev[]>('events')
    const sales = load<Sale[]>('sales').filter((s) => s.ts >= FROM)
    const saleItems = new Map<number, SaleItem[]>()
    for (const si of load<SaleItem[]>('sale_items')) {
      const list = saleItems.get(si.sale_id) ?? []
      list.push(si)
      saleItems.set(si.sale_id, list)
    }
    const sell = new Map<number, number>()
    for (const it of items.values()) {
      sell.set(it.id, calculateSellingPrice(it.unit_price_tiyin, VAT, MARKUP, STEP))
    }

    // Склад на начало периода: текущий остаток минус всё, что случилось после.
    const start = new Map<number, number>()
    for (const it of items.values()) start.set(it.id, it.qty_received - it.qty_consumed - it.qty_reserved)
    for (const e of events) {
      if (e.inv_item_id == null || e.ts <= FROM || !start.has(e.inv_item_id)) continue
      start.set(e.inv_item_id, start.get(e.inv_item_id)! - (SIGN[e.type] ?? 0) * e.quantity)
    }

    // Лента событий периода: действия админа + чеки, по времени.
    type Step = { ts: number; ev?: Ev; sale?: Sale }
    const timeline: Step[] = [
      ...events
        .filter((e) => e.ts > FROM && e.inv_item_id != null && e.type !== 'confirmed' && e.type !== 'unconsumed')
        .map((ev) => ({ ts: ev.ts, ev })),
      ...sales.map((sale) => ({ ts: sale.ts, sale })),
    ].sort((a, b) => a.ts - b.ts)

    // Как было в жизни — для сверки симуляции с реальностью.
    const actual = emptyStats()
    for (const s of sales) {
      actual.receipts++
      let small = 0
      for (const si of saleItems.get(s.id) ?? []) {
        if (si.inv_item_id == null) continue
        const b = bucketOf(sell.get(si.inv_item_id) ?? 0)
        actual.lines++
        actual.units[b]! += si.qty_milli / 1000
        actual.value[b]! += si.price_tiyin - si.discount_tiyin
        if (si.qty_milli > 5000) actual.linesOver5++
        actual.cost += ((items.get(si.inv_item_id)?.unit_price_tiyin ?? 0) * (si.qty_milli / 1000) * (100 + VAT)) / 100
        if ((sell.get(si.inv_item_id) ?? 0) <= SMALL) small += si.price_tiyin - si.discount_tiyin
      }
      if (small > SMALL) actual.heavyFill++
      if (small > 0) actual.withSmall++
    }

    const report: Record<string, Stats> = { 'в жизни': actual }
    for (const v of VARIANTS.filter((v) => !ONLY || ONLY.includes(v.name))) {
      const st = emptyStats()
      const avail = new Map(start)
      let day = -1
      const arrived = new Map<number, number>()
      const goneAt = new Map<number, number>()
      const consume = (id: number, milli: number) => {
        const left = Math.max(0, (avail.get(id) ?? 0) - milli)
        avail.set(id, left)
        if (left < 1000 && arrived.has(id) && !goneAt.has(id)) goneAt.set(id, curTs)
      }
      let curTs = FROM

      for (const step of timeline) {
        const d = Math.floor((step.ts + 5 * 3600) / 86400)
        if (d !== day) {
          day = d
          const anySmall = [...avail].some(([id, q]) => q >= 1000 && (sell.get(id) ?? 0) <= SMALL)
          if (!anySmall) st.daysNoSmall++
        }
        curTs = step.ts
        if (step.ev) {
          const { ev } = step
          const id = ev.inv_item_id!
          if (ev.type === 'admin_manual_insert') {
            avail.set(id, (avail.get(id) ?? 0) + ev.quantity)
            if ((sell.get(id) ?? 0) <= SMALL && ev.quantity >= 1000) arrived.set(id, ev.ts)
          }
          else if (ev.type === 'admin_manual_adjust') avail.set(id, Math.max(0, (avail.get(id) ?? 0) + ev.quantity))
          else if (ev.type === 'admin_writeoff' || ev.type === 'admin_delete' || ev.type === 'admin_manual_delete')
            avail.set(id, 0)
          continue
        }
        const sale = step.sale!
        st.receipts++
        const isSmall = sale.total_tiyin <= 5_000_000
        if (isSmall) st.smallReceipts++

        const poolItems: PoolItem[] = []
        for (const [id, q] of avail) {
          if (q < 1000) continue
          const it = items.get(id)
          if (!it || !it.class_code) continue
          const sp = sell.get(id) ?? 0
          if (sp <= 0) continue
          poolItems.push({
            item: {
              id,
              source: 'remote',
              external_id: null,
              name: it.name,
              barcode: null,
              class_code: it.class_code,
              package_code: '',
              vat_percent: VAT,
              owner_type: 0,
              unit_price_tiyin: it.unit_price_tiyin,
              qty_received: it.qty_received,
              qty_consumed: 0,
              received_at: it.received_at,
              imported_at: 0,
              notes: null,
              server_item_id: id,
              available: q,
            } as EsfItemWithAvailable,
            sellingPrice: sp,
          })
        }
        const pool: MatcherPool = {
          items: poolItems,
          minSellingPrice: poolItems.reduce((m, p) => Math.min(m, p.sellingPrice), Number.POSITIVE_INFINITY),
          remainingById: new Map(poolItems.map((p) => [p.item.id, p.item.available])),
          chosenBatchByProduct: new Map(),
        }

        const r = planHolistic(sale.total_tiyin, pool, {
          markupPercent: MARKUP,
          roundUpToSum: STEP,
          defaultVatPercent: VAT,
          ...v.opts,
        })
        if (!r.ok) {
          st.fail[r.reason] = (st.fail[r.reason] ?? 0) + 1
          for (const si of saleItems.get(sale.id) ?? []) if (si.inv_item_id != null) consume(si.inv_item_id, si.qty_milli)
          continue
        }
        st.ok++
        if (isSmall) st.smallOk++
        let small = 0
        for (const l of r.plan.lines) {
          const sp = sell.get(l.esfItem.id) ?? 0
          const b = bucketOf(sp)
          const pcs = l.quantity / 1000
          st.lines++
          st.units[b]! += pcs
          st.value[b]! += l.priceTiyin - l.discountTiyin
          st.cost += (l.esfItem.unit_price_tiyin * pcs * (100 + VAT)) / 100
          st.bump += Math.max(0, l.priceTiyin - sp * pcs)
          st.discount += l.discountTiyin
          if (pcs > 5) st.linesOver5++
          if (sp <= SMALL) small += l.priceTiyin - l.discountTiyin
          consume(l.esfItem.id, l.quantity)
        }
        if (small > SMALL) st.heavyFill++
        if (small > 0) st.withSmall++
      }
      for (const [id, q] of avail) {
        if (q >= 1000 && (sell.get(id) ?? 0) <= SMALL) {
          st.smallSkuEnd++
          st.smallUnitsEnd += Math.floor(q / 1000)
        }
      }
      for (const [id, ts] of arrived) {
        const end = goneAt.get(id)
        st.smallLife.push({
          id,
          days: end === undefined ? null : (end - ts) / 86400,
          pcs: (items.get(id)?.qty_received ?? 0) / 1000,
        })
      }
      report[v.name] = st
    }

    const som = (t: number) => Math.round(t / 100).toLocaleString('ru-RU')
    const rows = Object.entries(report).map(([name, s]) => ({
      вариант: name,
      чеков: s.receipts,
      собрано: s.receipts ? `${s.ok || s.receipts}` : '',
      отказ: Object.entries(s.fail).map(([k, n]) => `${k}:${n}`).join(' '),
      'строк/чек': (s.lines / Math.max(1, s.ok || s.receipts)).toFixed(2),
      'мелочь шт': Math.round(s.units['≤10k']!),
      'мелочь сум': som(s.value['≤10k']!),
      '10-20k шт': Math.round(s.units['10-20k']!),
      '20-50k шт': Math.round(s.units['20-50k']!),
      '>50k шт': Math.round(s.units['>50k']!),
      'строк >5шт': s.linesOver5,
      'чеков с мелочью': s.withSmall,
      'мелочь>10k/чек': s.heavyFill,
      'себест. млн': (s.cost / 100 / 1e6).toFixed(1),
      'надбавка сум': som(s.bump),
      'скидка сум': som(s.discount),
      'мелкие чеки ok': s.smallReceipts ? `${s.smallOk}/${s.smallReceipts}` : '',
      'дней без мелочи': s.daysNoSmall,
      'мелочь на конец': s.receipts && name !== 'в жизни' ? `${s.smallSkuEnd} поз / ${s.smallUnitsEnd} шт` : '',
    }))
    console.table(rows)
    if (process.env.HISTORY_OUT) fs.writeFileSync(process.env.HISTORY_OUT, JSON.stringify(report, null, 2))
  }, 600_000)
})
