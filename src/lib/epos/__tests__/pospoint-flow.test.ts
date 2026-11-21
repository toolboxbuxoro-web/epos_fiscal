/**
 * Pospoint: полный путь чека и возврата.
 *
 * Настоящие fiscalize()/processRefund() и фоновая проверка против поддельной
 * кассы Pospoint (fetch по протоколу из документации: очередь «по одному»,
 * 14824 на повтор номера, пустой {} на поиск, ошибки массивом). Склад и БД —
 * в памяти. Главное, что проверяем: при любом исходе в ОФД уходит не больше
 * одного чека на документ, а у нас сохраняется ровно то, что ушло.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SettingKey } from '@/lib/db/types'

const H = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  logs: [] as Array<{ level: string; source: string; message: string; details?: any }>,
  fr: [] as any[],
  refunds: [] as any[],
  matches: [] as any[],
  ms: [] as any[],
  esf: [] as any[],
  pending: [] as any[],
  prints: [] as any[],
  inv: {
    calls: [] as Array<{ op: string; args: any }>,
    stock: new Map<number, { received: number; consumed: number; reserved: number }>(),
    resv: new Map<string, { inv_item_id: number; quantity: number; status: string; ms: string }>(),
    seq: 1,
    unconsumed: new Set<string>(),
    /** Сколько следующих release уронить (сеть). */
    failRelease: 0,
  },
  fetch: null as null | ((url: string, init?: any) => Promise<any>),
  /** Сколько следующих записей fiscal_receipts уронить (сбой БД). */
  failInserts: 0,
}))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: (u: string, i?: any) => H.fetch!(u, i) }))
vi.mock('@/lib/log', () => {
  const mk = (level: string) => async (source: string, message: string, details?: unknown) => {
    H.logs.push({ level, source, message, details })
  }
  return { log: { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') } }
})
vi.mock('@/lib/printer', () => ({
  formatPrintDate: (s: string) => s,
  formatQtyForPrint: (q: number) => String(q / 1000),
  formatTiyinForPrint: (t: number) => (t / 100).toFixed(2),
  printFiscalReceipt: async (_p: string, data: any) => {
    H.prints.push(data)
    return H.prints.length
  },
}))
vi.mock('@/lib/inventory', () => {
  const client = {
    listItems: async () => ({
      items: [...H.inv.stock.entries()].map(([id, s]) => ({
        id,
        qty_received: s.received,
        qty_consumed: s.consumed,
        qty_reserved: s.reserved,
      })),
    }),
    reserve: async ({ ms_receipt_id, items, ttl_seconds }: any) => {
      H.inv.calls.push({ op: 'reserve', args: { ms_receipt_id, items, ttl_seconds } })
      // Как сервер: есть активный резерв по документу — «повтор» одним id.
      const active = [...H.inv.resv.entries()].find(([, r]) => r.ms === ms_receipt_id && r.status === 'active')
      if (active) return { ok: true, idempotent_replay: true, reservation_id: active[0], expires_at: '' }
      const reservations = items.map((it: any) => {
        const id = `res-${H.inv.seq++}`
        H.inv.stock.get(it.inv_item_id)!.reserved += it.quantity
        H.inv.resv.set(id, { inv_item_id: it.inv_item_id, quantity: it.quantity, status: 'active', ms: ms_receipt_id })
        return { reservation_id: id, inv_item_id: it.inv_item_id, quantity: it.quantity, expires_at: '' }
      })
      return { ok: true, reservations, items: [] }
    },
    confirm: async ({ reservation_ids, fiscal_sign }: any) => {
      H.inv.calls.push({ op: 'confirm', args: { reservation_ids, fiscal_sign } })
      for (const id of ([] as string[]).concat(reservation_ids)) {
        const r = H.inv.resv.get(id)!
        if (r.status === 'released') return { ok: false, code: 'ALREADY_RELEASED' }
        if (r.status === 'active') {
          const s = H.inv.stock.get(r.inv_item_id)!
          s.reserved -= r.quantity
          s.consumed += r.quantity
          r.status = 'confirmed'
        }
      }
      return { ok: true, items: [] }
    },
    release: async ({ reservation_ids, reason }: any) => {
      H.inv.calls.push({ op: 'release', args: { reservation_ids, reason } })
      if (H.inv.failRelease > 0) {
        H.inv.failRelease--
        throw new Error('network error')
      }
      for (const id of reservation_ids) {
        const r = H.inv.resv.get(id)!
        if (r.status === 'active') {
          H.inv.stock.get(r.inv_item_id)!.reserved -= r.quantity
          r.status = 'released'
        }
      }
      return { ok: true }
    },
    unconsume: async ({ items, refund_fiscal_sign, idempotency_key }: any) => {
      H.inv.calls.push({ op: 'unconsume', args: { items, refund_fiscal_sign, idempotency_key } })
      if (H.inv.unconsumed.has(refund_fiscal_sign)) return { ok: true, idempotent_replay: true }
      H.inv.unconsumed.add(refund_fiscal_sign)
      for (const it of items) H.inv.stock.get(it.inv_item_id)!.consumed -= it.quantity
      return { ok: true }
    },
  }
  return {
    applyItemsUpdate: async () => {},
    deletePendingByReservations: async () => {},
    getInventoryClient: async () => client,
    loadInventoryConfig: async () => ({ serverUrl: 'https://inv.test', apiKey: 'k', shopSlug: 's' }),
    markFiscalOk: async () => {},
    recordReserved: async () => {},
  }
})
vi.mock('@/lib/db', async () => {
  const types = await vi.importActual<any>('@/lib/db/types')
  const nowSec = () => Math.floor(Date.now() / 1000)
  return {
    SettingKey: types.SettingKey,
    now: nowSec,
    getSetting: async (k: string) => H.settings.get(k) ?? null,
    setSetting: async (k: string, v: string) => {
      H.settings.set(k, v)
    },
    listEsfItems: async (o: any) => H.esf.slice(0, o?.limit ?? 5000),
    upsertMsReceipt: async (r: any) => {
      let row = H.ms.find((m) => m.ms_id === r.ms_id)
      if (!row) {
        row = { id: H.ms.length + 1, ...r, status: 'pending' }
        H.ms.push(row)
      }
      return row.id
    },
    getMsReceipt: async (id: number) => H.ms.find((m) => m.id === id) ?? null,
    setMsReceiptStatus: async (id: number, status: string) => {
      const m = H.ms.find((x) => x.id === id)
      if (m) m.status = status
    },
    createMatch: async (m: any) => {
      const id = H.matches.length + 1
      H.matches.push({ id, ...m })
      return id
    },
    getFiscalReceiptByMsId: async (msId: number) => H.fr.find((f) => f.ms_receipt_id === msId) ?? null,
    getFiscalReceiptBySign: async (sign: string) => H.fr.find((f) => f.fiscal_sign === sign) ?? null,
    insertFiscalReceipt: async (row: any) => {
      if (H.failInserts > 0) {
        H.failInserts--
        throw new Error('database is locked')
      }
      if (H.fr.some((f) => f.fiscal_sign === row.fiscal_sign)) {
        throw new Error('UNIQUE constraint failed: fiscal_receipts.fiscal_sign')
      }
      const id = H.fr.length + 1
      H.fr.push({ id, ...row, fiscalized_at: nowSec() })
      return id
    },
    listRefundsByOriginalFiscalId: async (id: number) => H.refunds.filter((r) => r.original_fiscal_id === id),
    getRefundByOriginalFiscalId: async (id: number) => H.refunds.find((r) => r.original_fiscal_id === id) ?? null,
    insertFiscalRefund: async (row: any) => {
      if (H.refunds.some((f) => f.fiscal_sign === row.fiscal_sign)) {
        throw new Error('UNIQUE constraint failed: fiscal_refunds.fiscal_sign')
      }
      const id = H.refunds.length + 1
      H.refunds.push({ id, ...row, refunded_at: nowSec() })
      return id
    },
    getDb: async () => ({
      select: async (sql: string, params: any[]) => {
        if (/FROM fiscal_receipts WHERE id = \$1/.test(sql)) return H.fr.filter((f) => f.id === params[0])
        if (/FROM match_items mi/.test(sql)) {
          const m = H.matches.find((x) => x.id === params[0])
          return (m?.items ?? []).map((mi: any) => ({
            esf_item_id: mi.esf_item_id,
            quantity: mi.quantity,
            server_item_id: H.esf.find((e) => e.id === mi.esf_item_id)?.server_item_id ?? null,
          }))
        }
        throw new Error('unexpected select: ' + sql)
      },
      execute: async (sql: string, params: any[]) => {
        if (/inv_pending_confirms/.test(sql)) {
          H.pending.push(params)
          return { rowsAffected: 1 }
        }
        throw new Error('unexpected execute: ' + sql)
      },
    }),
  }
})

// ── Поддельная касса Pospoint ───────────────────────────────────────────────

const TEST_KEY = '41192fcccd93a9097843057e60e1da1904798f9f'
const MX_A = '08467000001000000'
const MX_B = '08205000002000000'
const MX_C = '03926000003000000'

type Fault =
  | { kind: 'error'; codes: number[]; commit?: boolean }
  | { kind: 'hang' }
  | { kind: 'commit-hang' }
  | { kind: 'commit-reset' }
  | { kind: 'refused' }
  | { kind: 'slow'; ms: number }
  | { kind: 'result'; result: unknown; commit?: boolean }
  /** ФМ подписал чек (счётчики смены сдвинулись), а номер документа Pospoint не записал; ответа нет. */
  | { kind: 'phantom' }

interface TillReceipt {
  id: number
  kind: 'sale' | 'refund'
  payCheckNumber: string
  params: any
  answer: any
  shift: number
  refundOf?: number
}

class FakePospoint {
  key = 'REAL-KEY'
  nextId = 500
  receipts: TillReceipt[] = []
  shiftOpen = false
  shiftNo = 1
  unsent = 0
  ofdDown = false
  ofdNoProgress = false
  fmUnsentBlock = false
  fmNeedsSync = false
  fmConnected = true
  /**
   * Как настоящий ФМ: чек, пришедший при закрытой смене, Pospoint открывает
   * смену и отправляет в ту же секунду — ФМ отвергает его с 36888, смена
   * остаётся открытой и пустой.
   */
  timePastOnAutoOpen = false
  down = false
  strictRefundValue = false
  faults: Record<string, Fault[]> = {}
  calls: Array<{ method: string; params: any; t: number; served: boolean }> = []
  notes: string[] = []
  mxik: Record<string, Array<{ code: number; nameRu: string }>> = {}
  private chain: Promise<void> = Promise.resolve()

  inject(method: string, ...f: Fault[]) {
    ;(this.faults[method] ??= []).push(...f)
  }
  byPay(p: string) {
    return this.receipts.find((r) => r.payCheckNumber === p)
  }
  sales() {
    return this.receipts.filter((r) => r.kind === 'sale')
  }
  refundsOf(id: number) {
    return this.receipts.filter((r) => r.kind === 'refund' && r.refundOf === id)
  }
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length
  }

  fetch = (url: string, init?: any): Promise<any> => {
    const reply = (payload: unknown) => ({
      ok: true,
      status: 200,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
      json: async () => payload,
    })
    if (String(url).endsWith('/health')) {
      if (this.down) return Promise.reject(new Error('error sending request for url (http://127.0.0.1:6461/pospoint)'))
      return Promise.resolve(reply({ status: 'UP' }))
    }
    if (this.down) return Promise.reject(new Error('error sending request for url (http://127.0.0.1:6461/pospoint)'))
    const body = JSON.parse(String(init.body))
    const fault = this.faults[body.method]?.shift()
    if (fault?.kind === 'refused') {
      this.calls.push({ method: body.method, params: body.params, t: Date.now(), served: false })
      return Promise.reject(new Error('error sending request for url (http://127.0.0.1:6461/pospoint)'))
    }
    const signal: AbortSignal | undefined = init?.signal
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn: () => void) => {
        if (!settled) {
          settled = true
          fn()
        }
      }
      signal?.addEventListener('abort', () => finish(() => reject(new Error('Request cancelled'))))
      const run = async () => {
        if (fault?.kind === 'hang') {
          this.calls.push({ method: body.method, params: body.params, t: Date.now(), served: false })
          return
        }
        if (fault?.kind === 'phantom') {
          this.calls.push({ method: body.method, params: body.params, t: Date.now(), served: false })
          this.shiftOpen = true
          const rid = ++this.nextId
          this.receipts.push({ id: rid, kind: 'sale', payCheckNumber: `phantom-${rid}`, params: body.params, answer: this.answerFor(rid), shift: this.shiftNo })
          return
        }
        if (fault?.kind === 'slow') await new Promise((r) => setTimeout(r, fault.ms))
        let payload: any
        if (fault?.kind === 'error') {
          if (fault.commit) this.handle(body)
          else this.calls.push({ method: body.method, params: body.params, t: Date.now(), served: false })
          payload = { id: Number(body.id), error: fault.codes.map((c) => ({ code: c, message: `E${c}` })) }
        } else if (fault?.kind === 'result') {
          if (fault.commit) this.handle(body)
          else this.calls.push({ method: body.method, params: body.params, t: Date.now(), served: false })
          payload = { id: Number(body.id), result: fault.result }
        } else {
          payload = this.handle(body)
        }
        if (fault?.kind === 'commit-hang') return
        if (fault?.kind === 'commit-reset') {
          finish(() => reject(new Error('error sending request: connection closed before message completed')))
          return
        }
        finish(() => resolve(reply(payload)))
      }
      this.chain = this.chain.then(run, run)
    })
  }

  private money(label: string, v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      this.notes.push(`${label}: не число (${String(v)})`)
      return Number.NaN
    }
    const t = v * 100
    if (Math.abs(t - Math.round(t)) > 1e-6) this.notes.push(`${label}: больше 2 знаков (${v})`)
    return Math.round(t)
  }

  private answerFor(rid: number) {
    return {
      id: rid,
      fmNo: 'LG420230637667',
      kkmNo: 'KKM001',
      time: Date.now(),
      url: `https://ofd.soliq.uz/check?t=LG420230637667&r=${rid}`,
      fiscalSign: String(800_000_000_000 + rid),
    }
  }

  handle(b: any): any {
    this.calls.push({ method: b.method, params: b.params, t: Date.now(), served: true })
    const err = (id: number | null, ...codes: number[]) => ({ id, error: codes.map((c) => ({ code: c, message: `E${c}` })) })
    if (b.version !== '1.0.2') return err(0, 14801)
    if (!/^\d+$/.test(String(b.id))) return err(0, 14822)
    const isTest = b.key === TEST_KEY
    if (!isTest && b.key !== this.key) return err(0, 14800)
    const id = Number(b.id)
    const p = b.params ?? {}
    switch (b.method) {
      case 'registerSaleFull':
        return this.sale(id, p, isTest)
      case 'registerRefundFull':
        return this.refund(id, p, isTest)
      case 'getReceiptByPayCheckNumber': {
        if (!p.payCheckNumber) return err(0, 14809)
        if (isTest) return { id, result: this.answerFor(1 + Math.floor(Math.random() * 1000)) }
        const r = this.byPay(p.payCheckNumber)
        return { id, result: r ? r.answer : {} }
      }
      case 'getReceipt': {
        const r = this.receipts.find((x) => x.id === p.billId)
        return r ? { id, result: r.answer } : err(id, -18)
      }
      case 'getXReport': {
        if (!this.shiftOpen) return err(id, -14)
        const inShift = this.receipts.filter((r) => r.shift === this.shiftNo)
        const s = inShift.filter((r) => r.kind === 'sale')
        const rf = inShift.filter((r) => r.kind === 'refund')
        const t = (xs: TillReceipt[], k: 'byCash' | 'byCard') => xs.reduce((a, r) => a + Math.round(r.params[k] * 100), 0)
        return {
          id,
          result: {
            terminalId: 'LG420230637667',
            openTime: Date.now() - 3600_000,
            saleCount: s.length,
            saleCashTotal: t(s, 'byCash'),
            saleCardTotal: t(s, 'byCard'),
            refundCount: rf.length,
            refundCashTotal: t(rf, 'byCash'),
            refundCardTotal: t(rf, 'byCard'),
            totalVat: 0,
            // Настоящий Pospoint у пустой смены отдаёт 0, а не пустое значение.
            firstReceiptSeq: inShift[0]?.id ?? 0,
            lastReceiptSeq: inShift.at(-1)?.id ?? 0,
          },
        }
      }
      case 'openZReport':
        this.shiftOpen = true
        return { id, result: { success: true, time: Date.now() } }
      case 'closeZReport': {
        if (!this.shiftOpen) return err(id, 36909)
        const inShift = this.receipts.filter((r) => r.shift === this.shiftNo)
        if (inShift.length === 0) return err(id, 36907)
        this.shiftOpen = false
        this.shiftNo++
        return { id, result: { success: true, reportNumber: this.shiftNo - 1, terminalId: 'LG420230637667', closeTime: Date.now() } }
      }
      case 'checkFmStatus':
        return {
          id,
          result: { isConnected: this.fmConnected, terminalId: 'LG420230637667', serialNumber: 'S1', appletVersion: '400', unsentReceiptCount: this.unsent },
        }
      case 'syncWithOfd': {
        if (this.ofdDown) return err(id, -17)
        const sent = this.ofdNoProgress ? 0 : Math.min(32, this.unsent)
        this.unsent -= sent
        return { id, result: { terminalId: 'LG420230637667', sentCount: sent, unsentCount: this.unsent, zReportsSent: true } }
      }
      case 'syncFmState':
        this.fmNeedsSync = false
        return { id, result: { terminalId: 'LG420230637667', synced: true } }
      case 'getMxikInfo': {
        const pk = this.mxik[p.mxik]
        return { id, result: pk ? [{ mxik: p.mxik, name: 'X', packages: pk }] : [] }
      }
      default:
        return err(id, -32601)
    }
  }

  private sale(id: number, p: any, isTest: boolean): any {
    const err = (rid: number | null, ...codes: number[]) => ({ id: rid, error: codes.map((c) => ({ code: c, message: `E${c}` })) })
    if (p.type === undefined) return err(id, -32099)
    if (p.type !== 'SALE') return err(0, 14808)
    if (!Array.isArray(p.items) || p.items.length === 0) return err(0, 14810)
    let totalT = 0
    for (const [i, it] of p.items.entries()) {
      for (const f of ['name', 'mxik', 'unit', 'packageCode', 'ownerType', 'taxPercent']) {
        if (it[f] === undefined) this.notes.push(`items[${i}].${f} не передано`)
      }
      if (!Number.isInteger(it.packageCode) || it.packageCode <= 0) this.notes.push(`items[${i}].packageCode=${it.packageCode}`)
      if (typeof it.mxik !== 'string' || !/^\d{17}$/.test(it.mxik)) this.notes.push(`items[${i}].mxik=${JSON.stringify(it.mxik)}`)
      if (!(it.amount > 0)) return err(0, 14813)
      if (!(it.price > 0)) return err(0, 14812)
      if (![0, 6, 12].includes(it.taxPercent)) return err(0, 14814)
      const priceT = this.money(`items[${i}].price`, it.price)
      const discT = it.discount === undefined ? 0 : this.money(`items[${i}].discount`, it.discount)
      if (discT < 0 || discT > priceT * it.amount + 1e-6) return err(0, 14815)
      totalT += priceT * it.amount - discT
    }
    const cash = this.money('byCash', p.byCash)
    const card = this.money('byCard', p.byCard)
    if (cash < 0 || card < 0) return err(0, 14805)
    if (Math.abs(cash + card - totalT) > 5000) return err(0, 14807)
    if (isTest) return { id, result: this.answerFor(1 + Math.floor(Math.random() * 1000)) }
    if (p.payCheckNumber && this.byPay(p.payCheckNumber)) return err(id, 14824)
    if (this.fmNeedsSync) return err(id, 37008)
    if (this.fmUnsentBlock && this.unsent > 0) return err(id, 36889)
    if (!this.shiftOpen && this.timePastOnAutoOpen) {
      this.shiftOpen = true
      return err(id, 36888)
    }
    this.shiftOpen = true
    const rid = ++this.nextId
    const answer = this.answerFor(rid)
    this.receipts.push({ id: rid, kind: 'sale', payCheckNumber: p.payCheckNumber, params: structuredClone(p), answer, shift: this.shiftNo })
    this.unsent++
    return { id, result: answer }
  }

  private refund(id: number, p: any, isTest: boolean): any {
    const err = (rid: number | null, ...codes: number[]) => ({ id: rid, error: codes.map((c) => ({ code: c, message: `E${c}` })) })
    if (!Array.isArray(p.items) || p.items.length === 0) return err(0, 14810)
    if (isTest) return { id, result: this.answerFor(1 + Math.floor(Math.random() * 1000)) }
    const sale = this.receipts.find((r) => r.kind === 'sale' && r.id === p.idRefundReceipt)
    if (!sale) return err(id, 36872)
    if (p.payCheckNumber && this.byPay(p.payCheckNumber)) return err(id, 14824)
    const lines = sale.params.items as any[]
    const used = new Map<number, number>()
    let valueT = 0
    for (const it of p.items) {
      if (!(it.amount > 0)) return err(0, 14813)
      // Документация: позиция ищется в чеке продажи по mxik или barcode,
      // по name — только если ни один не передан. Модель: первая подходящая строка.
      let idx = -1
      if (it.mxik) idx = lines.findIndex((l) => l.mxik === it.mxik)
      else if (it.barcode) idx = lines.findIndex((l) => l.barcode === it.barcode)
      else idx = lines.findIndex((l) => l.name === it.name)
      if (idx < 0) return err(id, 14811)
      const u = (used.get(idx) ?? 0) + it.amount
      if (u > lines[idx].amount + 1e-9) return err(id, 14811)
      used.set(idx, u)
      const line = lines[idx]
      const priceT = this.money('refund price', it.price)
      if (priceT !== Math.round(line.price * 100)) this.notes.push(`цена возврата ${it.price} ≠ цене продажи ${line.price} («${it.name}»)`)
      const lineDiscT = Math.round((line.discount ?? 0) * 100)
      valueT += priceT * it.amount - (lineDiscT * it.amount) / line.amount
    }
    const cash = this.money('refund byCash', p.byCash)
    const card = this.money('refund byCard', p.byCard)
    const saleT = Math.round(sale.params.byCash * 100) + Math.round(sale.params.byCard * 100)
    if (cash + card > saleT) return err(id, 14807)
    if (cash + card > valueT + 1e-9) {
      this.notes.push(`сумма возврата ${cash + card} > стоимости позиций с учётом скидок ${valueT.toFixed(3)} (тийины)`)
      if (this.strictRefundValue) return err(id, 14807)
    }
    if (!this.shiftOpen && this.timePastOnAutoOpen) {
      this.shiftOpen = true
      return err(id, 36888)
    }
    this.shiftOpen = true
    const rid = ++this.nextId
    const answer = this.answerFor(rid)
    this.receipts.push({ id: rid, kind: 'refund', payCheckNumber: p.payCheckNumber, params: structuredClone(p), answer, shift: this.shiftNo, refundOf: sale.id })
    this.unsent++
    return { id, result: answer }
  }
}

// ── Модули под тестом (перезагружаемые — для «перезапуска программы») ─────

let M: any
async function loadModules() {
  const f = await import('../fiscalize')
  const r = await import('../refund')
  const pp = await import('../pospoint')
  const ppc = await import('../pospoint-client')
  const sync = await import('../pospoint-sync')
  M = { fiscalize: f.fiscalize, processRefund: r.processRefund, pp, ppc, sync, f, r }
}
await loadModules()

// ── Вспомогательное ─────────────────────────────────────────────────────────

let fake: FakePospoint
let urlSeq = 0

async function settle<T>(p: Promise<T>, maxMs = 60 * 60_000): Promise<any> {
  const t0 = Date.now()
  let out: any = null
  p.then(
    (value) => (out = { ok: true, value }),
    (error) => (out = { ok: false, error }),
  )
  while (!out && Date.now() - t0 < maxMs) await vi.advanceTimersByTimeAsync(250)
  if (!out) throw new Error(`не завершилось за ${maxMs} мс`)
  return { ...out, ms: Date.now() - t0 }
}

function esf(id: number, over: Record<string, unknown> = {}) {
  return {
    id,
    source: 'remote',
    external_id: null,
    name: `Товар-${id}`,
    barcode: null,
    class_code: MX_A,
    package_code: '1461415',
    vat_percent: 12,
    owner_type: 0,
    unit_price_tiyin: 500_000,
    qty_received: 100_000,
    qty_consumed: 0,
    received_at: 0,
    imported_at: 0,
    notes: null,
    server_item_id: 9000 + id,
    ...over,
  }
}
function cand(e: any, quantity: number, priceTiyin: number, discountTiyin = 0) {
  return {
    esfItem: e,
    quantity,
    priceTiyin,
    discountTiyin,
    vatTiyin: Math.round(((priceTiyin - discountTiyin) * e.vat_percent) / (100 + e.vat_percent)),
  }
}
let docSeq = 0
function mkBuild(lines: any[], docId?: string) {
  const id = docId ?? `0b6c1a2e-0000-4000-8000-${String(++docSeq).padStart(12, '0')}`
  const total = lines.reduce((s, c) => s + c.priceTiyin - c.discountTiyin, 0)
  return {
    receipt: { id, name: `Отгрузка ${id.slice(-4)}`, sum: total },
    positions: lines.map((c) => ({
      source: { name: 'МС ' + c.esfItem.name },
      candidates: [c],
      strategy: 'passthrough',
      diffTiyin: 0,
      warnings: [],
      swappable: false,
      alternatives: [],
    })),
    overallStrategy: 'passthrough',
    totalDiffTiyin: 0,
    originalTotalTiyin: total,
    matchedTotalTiyin: total,
    canAutoFiscalize: true,
    warnings: [],
    mode: 'classic',
  } as any
}
function register(b: any) {
  for (const pm of b.positions)
    for (const c of pm.candidates) {
      const e = c.esfItem
      if (!H.esf.some((x) => x.id === e.id)) H.esf.push(e)
      if (!H.inv.stock.has(e.server_item_id)) H.inv.stock.set(e.server_item_id, { received: 1_000_000, consumed: 0, reserved: 0 })
    }
}
function addMs(b: any) {
  const id = H.ms.length + 1
  H.ms.push({ id, ms_id: b.receipt.id, ms_name: b.receipt.name, status: 'pending', raw_json: '{}' })
  return id
}
async function sell(b: any, opts: any = {}) {
  register(b)
  const msReceiptId = opts.msReceiptId ?? addMs(b)
  const total = b.matchedTotalTiyin
  const res = await settle(M.fiscalize(b, { msReceiptId, payment: { cashTiyin: total, cardTiyin: 0 }, ...opts }))
  return { ...res, msReceiptId }
}
async function saleFor(lines: any[], payment: { cashTiyin: number; cardTiyin: number }, cardKind?: 'fiz' | 'corp') {
  const b = mkBuild(lines)
  const r = await sell(b, { payment, cardKind })
  if (!r.ok) throw r.error
  const row = H.fr.at(-1)
  const sale = fake.sales().at(-1)!
  return { b, row, sale }
}
const inv = (op: string) => H.inv.calls.filter((c) => c.op === op)
const errLogs = () => H.logs.filter((l) => l.level === 'error')
const alarms = () => H.logs.filter((l) => l.message.includes('🚨'))
const hang3 = (): Fault[] => [{ kind: 'hang' }, { kind: 'hang' }, { kind: 'hang' }]
const msg = (r: any) => (r.ok ? '' : String(r.error?.message ?? r.error))

beforeEach(() => {
  vi.useFakeTimers({
    now: new Date(2026, 10, 9, 10, 0, 0),
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  })
  H.settings.clear()
  H.logs.length = 0
  H.fr.length = 0
  H.refunds.length = 0
  H.matches.length = 0
  H.ms.length = 0
  H.esf.length = 0
  H.pending.length = 0
  H.prints.length = 0
  H.inv.calls.length = 0
  H.inv.stock.clear()
  H.inv.resv.clear()
  H.inv.unconsumed.clear()
  H.inv.failRelease = 0
  H.failInserts = 0
  fake = new FakePospoint()
  H.fetch = fake.fetch
  urlSeq++
  const nowSec = Math.floor(Date.now() / 1000)
  const set = (k: string, v: string) => H.settings.set(k, v)
  set(SettingKey.FiscalBackend, 'pospoint')
  set(SettingKey.PospointKey, 'REAL-KEY')
  // Кассир уже работал через Pospoint — фоновая проверка смотрит ФМ.
  set(SettingKey.PospointFmHandedOver, 'true')
  set(SettingKey.PospointUrl, `http://127.0.${Math.floor(urlSeq / 250)}.${(urlSeq % 250) + 1}:6461`)
  set(SettingKey.PrinterAutoPrint, 'true')
  set(SettingKey.PrinterName, 'XP-80')
  set(SettingKey.CompanyName, 'ООО Тулбокс')
  set(SettingKey.CompanyInn, '123456789')
  set(SettingKey.CompanyAddress, 'Бухара')
  set(SettingKey.MoyskladEmployeeName, 'Кассир')
  set(
    SettingKey.PospointUnitsCache,
    JSON.stringify({
      [MX_A]: { at: nowSec, packages: [{ code: 1461415, name: 'шт' }] },
      [MX_B]: { at: nowSec, packages: [{ code: 1461415, name: 'шт' }] },
      [MX_C]: { at: nowSec, packages: [{ code: 1461415, name: 'шт' }] },
    }),
  )
})
afterEach(() => {
  vi.useRealTimers()
})

const pendingNames = async () => (await M.pp.listPendingAttempts()).map(([n]: [string, unknown]) => n).sort()
const cash = (t: number) => ({ payment: { cashTiyin: t, cardTiyin: 0 } })

// ── Продажа ─────────────────────────────────────────────────────────────────

describe('продажа', () => {
  it('один чек, журнал пуст, лента — как ушло в ОФД, резерв на 20 минут', async () => {
    const b = mkBuild([cand(esf(1), 2000, 4_800_000), cand(esf(2, { class_code: MX_B }), 3000, 1_000_000)])
    const r = await sell(b, cash(5_800_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
    // 10 000 сум за 3 шт → 3 334 сум за штуку, излишек 2 сума — скидкой.
    expect(fake.sales()[0]!.params.items[1]).toMatchObject({ amount: 3, price: 3334, discount: 2 })
    expect(fake.notes).toEqual([])
    expect(await pendingNames()).toEqual([])
    expect(inv('reserve')[0]!.args.ttl_seconds).toBe(1200)
    expect(H.prints[0].items[1]).toMatchObject({ price_str: '10002.00', discount_str: '2.00' })
    expect(H.fr[0].request_json).not.toContain('REAL-KEY')
    expect(H.fr[0].response_json).not.toContain('REAL-KEY')
    expect(errLogs()).toEqual([])
  })

  it('тестовый ключ из документации — чек не отправляется и склад не трогается', async () => {
    H.settings.set(SettingKey.PospointKey, TEST_KEY)
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok).toBe(false)
    expect(msg(r)).toMatch(/тестовый ключ/)
    expect(fake.calls).toHaveLength(0)
    expect(inv('reserve')).toHaveLength(0)
  })

  it('ответа нет, но чек пробит — сохранён один раз, второй не отправлен', async () => {
    fake.inject('registerSaleFull', { kind: 'commit-hang' })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('registerSaleFull')).toBe(1)
    expect(H.fr).toHaveLength(1)
    expect(H.fr[0].fiscal_sign).toBe(fake.sales()[0]!.answer.fiscalSign)
    expect(await pendingNames()).toEqual([])
  })

  it('обрыв соединения после отправки — тоже ищем, а не считаем «не пробит»', async () => {
    fake.inject('registerSaleFull', { kind: 'commit-reset' })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
    expect(H.fr).toHaveLength(1)
  })

  it('ответа нет и чек не пробит — «нажмите ещё раз», повтор пробивает один чек', async () => {
    fake.inject('registerSaleFull', { kind: 'hang' })
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)])
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.ok).toBe(false)
    expect(r1.error).not.toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(msg(r1)).toMatch(/не пробит/)
    expect(await pendingNames()).toEqual([])
    expect(inv('release')).toHaveLength(1)
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
    expect(H.fr).toHaveLength(1)
  })

  it('Pospoint выключен в момент чека — «не отвечает», документ не блокируется; включили — один чек', async () => {
    // Хазрати Имом, 17.11.2026: сервер интеграции не поднялся, а отказ в
    // соединении приходит без причины в тексте — чек считался «исход
    // неизвестен» и блокировался до сверки.
    fake.down = true
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-off')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.ok).toBe(false)
    expect(r1.error).not.toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(msg(r1)).toMatch(/Pospoint не отвечает.*Чек не пробит/s)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
    expect(H.fr).toHaveLength(0)

    fake.down = false
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
    expect(H.fr).toHaveLength(1)
    expect(await pendingNames()).toEqual([])
  })

  it('исход неизвестен (касса молчит и на поиск) — повтор с другим подбором сохраняет ПРОШЛЫЙ чек', async () => {
    fake.inject('registerSaleFull', { kind: 'commit-hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const e1 = esf(1)
    const e2 = esf(2, { class_code: MX_B })
    const r1 = await sell(mkBuild([cand(e1, 1000, 2_400_000)], 'doc-D'), cash(2_400_000))
    expect(r1.ok).toBe(false)
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(H.fr).toHaveLength(0)
    expect(await pendingNames()).toEqual(['doc-D'])
    // error на сервер, но без 🚨: повтор кассира сам разберётся.
    expect(errLogs().some((l) => /неизвестно, пробит ли чек/.test(l.message))).toBe(true)
    expect(alarms()).toEqual([])

    // Кассир пересобрал чек другим товаром и нажал ещё раз.
    const r2 = await sell(mkBuild([cand(e2, 1000, 2_400_000)], 'doc-D'), { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.count('registerSaleFull')).toBe(1)
    expect(H.fr).toHaveLength(1)
    expect(H.fr[0].fiscal_sign).toBe(fake.sales()[0]!.answer.fiscalSign)
    expect(JSON.parse(H.fr[0].request_json).receipt.Items[0].SPIC).toBe(MX_A)
    expect(inv('reserve').at(-1)!.args.items).toEqual([{ inv_item_id: 9001, quantity: 1000 }])
    expect(inv('confirm')).toHaveLength(1)
    expect(H.ms[0].status).toBe('fiscalized')
    expect(await pendingNames()).toEqual([])
  })

  it('первый чек дня при закрытой смене — открываем смену сами и ждём; ФМ не отвергает чек', async () => {
    // Хонабод 20.11, Донбозор 21.11: Pospoint открывал смену сам и в ту же
    // секунду слал чек — ФМ отвечал 36888, документ блокировался до сверки.
    fake.timePastOnAutoOpen = true
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-morning'), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('openZReport')).toBe(1)
    expect(fake.count('registerSaleFull')).toBe(1)
    const open = fake.calls.find((c) => c.method === 'openZReport')!
    const sale = fake.calls.find((c) => c.method === 'registerSaleFull')!
    expect(sale.t - open.t).toBeGreaterThanOrEqual(1_000)
    expect(fake.sales()).toHaveLength(1)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
  })

  it('смена уже открыта — лишний раз не открываем', async () => {
    fake.shiftOpen = true
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('openZReport')).toBe(0)
  })

  it('ФМ ответил «время чека в прошлом» (36888) — чек не пробит: повтор через 2 сек, без блокировки', async () => {
    fake.shiftOpen = true
    fake.inject('registerSaleFull', { kind: 'error', codes: [36888] })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-tp'), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('registerSaleFull')).toBe(2)
    expect(fake.sales()).toHaveLength(1)
    expect(H.fr).toHaveLength(1)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
  })

  it('часы компьютера и правда отстают (36888 каждый раз) — «проверьте время», документ не блокируется', async () => {
    fake.shiftOpen = true
    fake.inject('registerSaleFull', { kind: 'error', codes: [36888] }, { kind: 'error', codes: [36888] })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-clock'), cash(2_400_000))
    expect(r.ok).toBe(false)
    expect(r.error).not.toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(msg(r)).toMatch(/Время на компьютере/)
    expect(fake.count('registerSaleFull')).toBe(2)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
  })

  it('смена закрыта и не открывается — понятная ошибка, чек не отправлен, документ не блокируется', async () => {
    fake.inject('openZReport', { kind: 'error', codes: [37011] })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-noopen'), cash(2_400_000))
    expect(r.ok).toBe(false)
    expect(msg(r)).toMatch(/открыть её не удалось.*Чек не пробит/s)
    expect(fake.count('registerSaleFull')).toBe(0)
    expect(await pendingNames()).toEqual([])
  })

  it('ФМ подписал чек, а Pospoint номер не записал — документ заблокирован до сверки', async () => {
    fake.inject('registerSaleFull', { kind: 'phantom' })
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-E')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(r1.error.fmMaySigned).toBe(true)
    const [[, entry]] = await M.pp.listPendingAttempts()
    expect(entry.fmMaySigned).toBe(true)
    expect(alarms().some((l) => /мог быть подписан/.test(l.message))).toBe(true)

    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(fake.count('registerSaleFull')).toBe(1)

    // Администратор сверил чек и снял попытку — теперь документ пробивается.
    await M.pp.clearPendingAttempt('doc-E')
    const r3 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r3.ok, msg(r3)).toBe(true)
    expect(fake.count('registerSaleFull')).toBe(2)
  })

  it('ФМ не найден (ридер отключён) — «проверьте ридер», документ не блокируется, повтор пробивает', async () => {
    // Без ФМ не читается и X-отчёт — раньше «сравнить не по чему» блокировало
    // документ до сверки, а «чек по сумме» после этого не давал пробить новый.
    const gone: Fault = { kind: 'error', codes: [4240] }
    fake.inject('getXReport', gone)
    fake.inject('registerSaleFull', gone)
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-FM')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).not.toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(msg(r1)).toMatch(/USB-ридер/)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])

    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
  })

  it('ФМ не ответил на чек, а X-отчёт прочитался со второй попытки — «нажмите ещё раз», без блокировки', async () => {
    fake.shiftOpen = true
    fake.inject('registerSaleFull', { kind: 'error', codes: [-13] })
    // X-отчёт: до чека читается, сразу после сбоя — нет, через пару секунд — да.
    fake.inject('getXReport', { kind: 'result', result: { saleCount: 0, refundCount: 0 } }, { kind: 'error', codes: [-13] })
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-FM2')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).not.toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(await pendingNames()).toEqual([])
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
  })

  it('журнал: одновременные правки не затирают друг друга', async () => {
    const a = (at: number) => ({ kind: 'sale' as const, inputFp: '', requestJson: '{}', snapshot: null, at })
    await M.pp.setPendingAttempt('doc-1', a(1))
    await Promise.all([
      M.pp.updatePendingAttempt('doc-1', { reportedAt: 5 }),
      M.pp.setPendingAttempt('doc-2', a(2)),
      M.pp.setPendingAttempt('doc-3', a(3)),
      M.pp.clearPendingAttempt('doc-1'),
    ])
    expect(await pendingNames()).toEqual(['doc-2', 'doc-3'])
  })

  it('БД занята на миг — запись чека повторяется, чек сохранён с первого нажатия', async () => {
    H.failInserts = 2
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(H.fr).toHaveLength(1)
    expect(await pendingNames()).toEqual([])
  })

  it('чек пробит, а в БД не записался — повтор сохраняет его без второго чека и второго списания', async () => {
    H.failInserts = 3
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-F')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.ok).toBe(false)
    expect(msg(r1)).toMatch(/database is locked/)
    expect(fake.sales()).toHaveLength(1)
    const [[n, entry]] = await M.pp.listPendingAttempts()
    expect(n).toBe('doc-F')
    expect(entry.reservations).toHaveLength(1)

    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(r2.value.recoveredPrior).toBe(true)
    expect(fake.count('registerSaleFull')).toBe(1)
    expect(H.fr).toHaveLength(1)
    expect(inv('reserve')).toHaveLength(1)
    // Повтор подтверждает тот же резерв (сервер отвечает «уже подтверждён»).
    expect(new Set(inv('confirm').flatMap((c) => c.args.reservation_ids)).size).toBe(1)
    expect(H.inv.stock.get(9001)!.consumed).toBe(1000)
    expect(await pendingNames()).toEqual([])
  })

  it('поиск не ответил, а счётчики смены сдвинулись — потом «не найден» не снимает блок', async () => {
    fake.inject('registerSaleFull', { kind: 'phantom' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-A1')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(r1.error.fmMaySigned).toBe(true)
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(fake.count('registerSaleFull')).toBe(1)
    expect(await pendingNames()).toEqual(['doc-A1'])
  })

  it('поиск не ответил, счётчики не сдвинулись — повтор пробивает чек один раз', async () => {
    fake.inject('registerSaleFull', { kind: 'hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-A1b')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(r1.error.fmMaySigned).toBe(false)
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.sales()).toHaveLength(1)
  })

  it('14824 «уже пробит», а поиск не ответил — потом «не найден» не снимает блок', async () => {
    fake.inject('registerSaleFull', { kind: 'error', codes: [14824] })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-14824')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(r1.error.fmMaySigned).toBe(true)
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(fake.count('registerSaleFull')).toBe(1)
  })

  it('резерв прошлой попытки не отпустился — повтор снимает его и резервирует заново', async () => {
    fake.inject('registerSaleFull', { kind: 'hang' })
    H.inv.failRelease = 1
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-replay')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.ok).toBe(false)
    expect([...H.inv.resv.values()].map((r) => r.status)).toEqual(['active'])
    const r2 = await sell(b, { ...cash(2_400_000), msReceiptId: r1.msReceiptId })
    expect(r2.ok, msg(r2)).toBe(true)
    expect([...H.inv.resv.values()].map((r) => r.status)).toEqual(['released', 'confirmed'])
    expect(H.inv.stock.get(9001)).toMatchObject({ consumed: 1000, reserved: 0 })
  })

  it('касса переключена с Pospoint, а по документу осталась попытка — другая программа его не пробьёт', async () => {
    await M.pp.setPendingAttempt('doc-left', { kind: 'sale', inputFp: '', requestJson: '{}', snapshot: null, at: Date.now() })
    H.settings.set(SettingKey.FiscalBackend, 'epos')
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-left'), cash(2_400_000))
    expect(r.ok).toBe(false)
    expect(msg(r)).toMatch(/попытка Pospoint с неизвестным исходом/)
    expect(inv('reserve')).toHaveLength(0)
  })

  it('два нажатия одновременно — один чек, одно списание, второй получает «уже фискализирован»', async () => {
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)])
    register(b)
    const msId = addMs(b)
    const opts = { msReceiptId: msId, ...cash(2_400_000) }
    const both = await settle(Promise.allSettled([M.fiscalize(b, opts), M.fiscalize(b, opts)]))
    const [s1, s2] = both.value as PromiseSettledResult<unknown>[]
    expect(s1!.status).toBe('fulfilled')
    expect(s2!.status).toBe('rejected')
    expect((s2 as PromiseRejectedResult).reason).toBeInstanceOf(M.f.AlreadyFiscalizedError)
    expect(fake.sales()).toHaveLength(1)
    expect(H.fr).toHaveLength(1)
    expect(H.inv.stock.get(9001)!.consumed).toBe(1000)
    expect(alarms()).toEqual([])
  })

  it('ФМ ждёт отправки старых чеков — досылаем и пробиваем с первого нажатия', async () => {
    fake.unsent = 5
    fake.fmUnsentBlock = true
    fake.inject('registerSaleFull', { kind: 'error', codes: [36889] })
    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('syncWithOfd')).toBeGreaterThan(0)
    expect(fake.sales()).toHaveLength(1)
  })
})

// ── Возврат ─────────────────────────────────────────────────────────────────

describe('возврат', () => {
  it('полный: один возврат, журнал пуст, остатки вернулись', async () => {
    const { row, sale } = await saleFor(
      [cand(esf(1), 2000, 4_800_000), cand(esf(2, { class_code: MX_B }), 3000, 1_000_000)],
      { cashTiyin: 3_000_000, cardTiyin: 2_800_000 },
      'corp',
    )
    const r = await settle(M.processRefund({ originalFiscalId: row.id }))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.refundsOf(sale.id)).toHaveLength(1)
    expect(fake.notes).toEqual([])
    expect(await pendingNames()).toEqual([])
    expect(inv('unconsume')).toHaveLength(1)
    expect(H.refunds[0].request_json).not.toContain('REAL-KEY')
  })

  it('возврат при закрытой смене — смену открываем сами, ФМ не отвергает возврат', async () => {
    const { row, sale } = await saleFor([cand(esf(1), 1000, 2_400_000)], { cashTiyin: 2_400_000, cardTiyin: 0 })
    // Смена закрылась (конец дня), возврат — утром.
    fake.shiftOpen = false
    fake.shiftNo++
    fake.timePastOnAutoOpen = true
    const opens = fake.count('openZReport')
    const r = await settle(M.processRefund({ originalFiscalId: row.id }))
    expect(r.ok, msg(r)).toBe(true)
    expect(fake.count('openZReport')).toBe(opens + 1)
    expect(fake.refundsOf(sale.id)).toHaveLength(1)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
  })

  it('строки с одним ИКПУ: касса находит именно выбранную строку', async () => {
    const { row, sale } = await saleFor(
      [cand(esf(1, { class_code: MX_B }), 2000, 800_000), cand(esf(2, { class_code: MX_B }), 1000, 700_000)],
      { cashTiyin: 1_500_000, cardTiyin: 0 },
    )
    const r = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 1, qtyMilli: 1000 }] }))
    expect(r.ok, msg(r)).toBe(true)
    const [ref] = fake.refundsOf(sale.id)
    expect(ref!.params.items).toEqual([{ name: 'Товар-2', amount: 1, price: 7000 }])
    // Касса сверяет цену со строкой, которую нашла: чужая строка дала бы расхождение.
    expect(fake.notes).toEqual([])
  })

  it('исход неизвестен — повтор с другим выбором сохраняет ПРОШЛЫЙ возврат', async () => {
    const { row, sale } = await saleFor(
      [cand(esf(1), 3000, 1_000_000), cand(esf(2, { class_code: MX_B }), 2000, 4_800_000)],
      { cashTiyin: 5_800_000, cardTiyin: 0 },
    )
    fake.inject('registerRefundFull', { kind: 'commit-hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const r1 = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 0, qtyMilli: 1000 }] }))
    expect(r1.ok).toBe(false)
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    expect(H.refunds).toHaveLength(0)

    const r2 = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 1, qtyMilli: 1000 }] }))
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.count('registerRefundFull')).toBe(1)
    expect(H.refunds).toHaveLength(1)
    expect(H.refunds[0].fiscal_sign).toBe(fake.refundsOf(sale.id)[0]!.answer.fiscalSign)
    expect(JSON.parse(H.refunds[0].refunded_items_snapshot)).toEqual([
      { originalItemIndex: 0, qtyMilli: 1000, refundTiyin: expect.any(Number) },
    ])
    expect(await pendingNames()).toEqual([])
  })

  it('два нажатия «Вернуть» одновременно — один возврат, без ложной тревоги', async () => {
    const { row, sale } = await saleFor([cand(esf(1), 1000, 2_400_000)], { cashTiyin: 2_400_000, cardTiyin: 0 })
    const both = await settle(
      Promise.allSettled([M.processRefund({ originalFiscalId: row.id }), M.processRefund({ originalFiscalId: row.id })]),
    )
    const statuses = (both.value as PromiseSettledResult<unknown>[]).map((x) => x.status)
    expect(statuses.sort()).toEqual(['fulfilled', 'rejected'])
    expect(fake.refundsOf(sale.id)).toHaveLength(1)
    expect(H.refunds).toHaveLength(1)
    expect(alarms()).toEqual([])
  })

  it('второй частичный возврат по чеку проходит, суммы по умолчанию — от оплаты продажи', async () => {
    const { row, sale } = await saleFor(
      [cand(esf(1), 2000, 4_800_000), cand(esf(2, { class_code: MX_B }), 1000, 1_000_000)],
      { cashTiyin: 2_900_000, cardTiyin: 2_900_000 },
      'fiz',
    )
    const r1 = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 0, qtyMilli: 1000 }] }))
    expect(r1.ok, msg(r1)).toBe(true)
    const defaults = await M.r.getDefaultRefundAmounts(row.id)
    expect(defaults).toMatchObject({ cash: 2_900_000, card: 2_900_000 })
    const r2 = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 1, qtyMilli: 1000 }] }))
    expect(r2.ok, msg(r2)).toBe(true)
    expect(fake.refundsOf(sale.id)).toHaveLength(2)
    expect(H.refunds.map((x) => x.is_partial)).toEqual([1, 1])
  })

  it('под номером продажи в Pospoint теперь другой чек — возврат не отправляется', async () => {
    const { row, sale } = await saleFor([cand(esf(1), 1000, 2_400_000)], { cashTiyin: 2_400_000, cardTiyin: 0 })
    sale.answer.fiscalSign = 'ДРУГОЙ'
    const r = await settle(M.processRefund({ originalFiscalId: row.id }))
    expect(r.ok).toBe(false)
    expect(msg(r)).toMatch(/теперь другой чек/)
    expect(fake.count('registerRefundFull')).toBe(0)
  })
})

// ── Фоновая проверка ────────────────────────────────────────────────────────

describe('фоновая проверка Pospoint', () => {
  afterEach(() => M.sync._resetPospointHealthForTests())
  const attempt = (at: number, over: Record<string, unknown> = {}) => ({
    kind: 'sale',
    inputFp: '',
    requestJson: '{}',
    snapshot: null,
    at,
    ...over,
  })

  it('непробитую попытку снимает, пробитую — 🚨 один раз, «ФМ мог подписать» — держит', async () => {
    const now = Date.now()
    const old = now - 11 * 60_000
    await M.pp.setPendingAttempt('doc-absent', attempt(old))
    await M.pp.setPendingAttempt('doc-signed', attempt(old, { fmMaySigned: true }))
    await M.pp.setPendingAttempt('doc-fresh', attempt(now))
    fake.receipts.push({
      id: 900,
      kind: 'sale',
      payCheckNumber: 'doc-found',
      params: {},
      answer: { id: 900, fiscalSign: 'S900', fmNo: 'LG', time: now, url: 'u' },
      shift: 1,
    })
    await M.pp.setPendingAttempt('doc-found', attempt(old))

    await settle(M.sync.runPospointFmOnce())
    expect(await pendingNames()).toEqual(['doc-found', 'doc-fresh', 'doc-signed'])
    expect(alarms().filter((l) => l.message.includes('doc-found'))).toHaveLength(1)
    expect(alarms().filter((l) => l.message.includes('doc-signed'))).toHaveLength(1)
    expect(M.sync.getPospointHealth().pending).toBe(3)

    await settle(M.sync.runPospointFmOnce())
    expect(alarms().filter((l) => l.message.includes('doc-found'))).toHaveLength(1)
    expect(alarms().filter((l) => l.message.includes('doc-signed'))).toHaveLength(1)
  })

  it('кассир не повторил чек с неизвестным исходом — проверка сохраняет его сама, без печати', async () => {
    fake.inject('registerSaleFull', { kind: 'commit-hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const b = mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-bg')
    const r1 = await sell(b, cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    const printsBefore = H.prints.length

    vi.setSystemTime(Date.now() + 11 * 60_000)
    await settle(M.sync.runPospointFmOnce())
    expect(fake.count('registerSaleFull')).toBe(1)
    expect(H.fr).toHaveLength(1)
    expect(H.fr[0].fiscal_sign).toBe(fake.sales()[0]!.answer.fiscalSign)
    expect(H.ms[0].status).toBe('fiscalized')
    expect(H.inv.stock.get(9001)!.consumed).toBe(1000)
    expect(H.prints.length).toBe(printsBefore)
    expect(await pendingNames()).toEqual([])
    expect(alarms()).toEqual([])
  })

  it('тестовый режим включили — найденную попытку фоном не «сохраняет» и ничего не печатает', async () => {
    fake.inject('registerSaleFull', { kind: 'commit-hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const r1 = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)], 'doc-test'), cash(2_400_000))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)
    H.settings.set(SettingKey.TestMode, 'true')
    const printsBefore = H.prints.length
    vi.setSystemTime(Date.now() + 11 * 60_000)
    await settle(M.sync.runPospointFmOnce())
    expect(await pendingNames()).toEqual(['doc-test'])
    expect(H.fr).toHaveLength(0)
    expect(H.prints.length).toBe(printsBefore)
    expect(H.logs.some((l) => /сохранён фоновой проверкой/.test(l.message))).toBe(false)
  })

  it('кассир не повторил возврат с неизвестным исходом — проверка сохраняет его сама', async () => {
    const { row, sale } = await saleFor([cand(esf(1), 2000, 4_800_000)], { cashTiyin: 4_800_000, cardTiyin: 0 })
    fake.inject('registerRefundFull', { kind: 'commit-hang' })
    fake.inject('getReceiptByPayCheckNumber', ...hang3())
    const r1 = await settle(M.processRefund({ originalFiscalId: row.id, selectedItems: [{ originalItemIndex: 0, qtyMilli: 1000 }] }))
    expect(r1.error).toBeInstanceOf(M.pp.PospointOutcomeUnknownError)

    vi.setSystemTime(Date.now() + 11 * 60_000)
    await settle(M.sync.runPospointFmOnce())
    expect(fake.count('registerRefundFull')).toBe(1)
    expect(H.refunds).toHaveLength(1)
    expect(H.refunds[0].fiscal_sign).toBe(fake.refundsOf(sale.id)[0]!.answer.fiscalSign)
    expect(H.refunds[0].is_partial).toBe(1)
    expect(await pendingNames()).toEqual([])
  })

  it('пока кассир пробивает чек, журнал не трогает', async () => {
    await M.pp.setPendingAttempt('doc-busy', attempt(Date.now() - 11 * 60_000))
    await M.pp.runPospointForeground(async () => {
      await settle(M.sync.runPospointFmOnce())
    })
    expect(await pendingNames()).toEqual(['doc-busy'])
  })

  it('кратковременный сбой связи не стирает известную проблему с ФМ из панели', async () => {
    fake.fmConnected = false
    await settle(M.sync.runPospointFmOnce())
    expect(M.sync.getPospointHealth().state).toBe('fm-disconnected')
    fake.down = true
    await settle(M.sync.runPospointHealthOnce())
    expect(M.sync.getPospointHealth().state).toBe('down')
    fake.down = false
    await settle(M.sync.runPospointHealthOnce())
    expect(M.sync.getPospointHealth().state).toBe('fm-disconnected')
  })

  it('число незавершённых попыток в панели обновляется каждую минуту', async () => {
    await M.pp.setPendingAttempt('doc-p', attempt(Date.now()))
    await settle(M.sync.runPospointHealthOnce())
    expect(M.sync.getPospointHealth().pending).toBe(1)
  })

  it('ключ не принят — состояние bad-key и error на сервер', async () => {
    fake.key = 'OTHER'
    await settle(M.sync.runPospointFmOnce())
    expect(M.sync.getPospointHealth().state).toBe('bad-key')
    expect(errLogs().some((l) => /не принял ключ/.test(l.message))).toBe(true)
  })

  it('сразу после переключения ФМ фоном не трогаем; после первого чека кассира — смотрим', async () => {
    H.settings.set(SettingKey.PospointFmHandedOver, '')
    await settle(M.sync.runPospointFmOnce())
    expect(fake.count('checkFmStatus')).toBe(0)
    expect(fake.count('syncWithOfd')).toBe(0)
    expect(M.sync.getPospointHealth().state).toBe('up')

    const r = await sell(mkBuild([cand(esf(1), 1000, 2_400_000)]), cash(2_400_000))
    expect(r.ok, msg(r)).toBe(true)
    await settle(M.sync.runPospointFmOnce())
    expect(fake.count('checkFmStatus')).toBe(1)
  })

  it('до передачи ФМ неверный ключ всё равно виден в панели', async () => {
    H.settings.set(SettingKey.PospointFmHandedOver, '')
    fake.key = 'OTHER'
    await settle(M.sync.runPospointFmOnce())
    expect(M.sync.getPospointHealth().state).toBe('bad-key')
    expect(fake.count('checkFmStatus')).toBe(0)
  })

  it('тестовый ключ — состояние test-key, касса не опрашивается', async () => {
    H.settings.set(SettingKey.PospointKey, TEST_KEY)
    await settle(M.sync.runPospointFmOnce())
    expect(M.sync.getPospointHealth().state).toBe('test-key')
    expect(fake.calls).toHaveLength(0)
  })

  it('неотправленные чеки: время, с которого висят, переживает перезапуск; через сутки — 🚨', async () => {
    fake.unsent = 3
    fake.ofdNoProgress = true
    await settle(M.sync.runPospointFmOnce())
    const since = Number(H.settings.get(SettingKey.PospointUnsentSince))
    expect(since).toBeGreaterThan(0)
    expect(M.sync.getPospointHealth()).toMatchObject({ state: 'up', unsent: 3, unsentSince: since })

    M.sync._resetPospointHealthForTests() // перезапуск программы
    vi.setSystemTime(Date.now() + 25 * 3600_000)
    await settle(M.sync.runPospointFmOnce())
    expect(Number(H.settings.get(SettingKey.PospointUnsentSince))).toBe(since)
    expect(alarms().some((l) => /больше суток/.test(l.message))).toBe(true)
  })

  it('программа закрыта — «не отвечает»; error на сервер только после трёх проверок подряд', async () => {
    fake.down = true
    await settle(M.sync.runPospointHealthOnce())
    await settle(M.sync.runPospointHealthOnce())
    expect(M.sync.getPospointHealth().state).toBe('down')
    expect(errLogs()).toEqual([])
    await settle(M.sync.runPospointHealthOnce())
    expect(errLogs().some((l) => /не отвечает/.test(l.message))).toBe(true)
  })
})

// ── Переключение программы фискализации ─────────────────────────────────────

describe('переключение кассы на другую программу', () => {
  let R: typeof import('../switch-readiness')
  beforeEach(async () => {
    R = await import('../switch-readiness')
  })

  const reply = (payload: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => payload,
  })

  function epos(state: { zOpen?: boolean; unsent?: number; down?: boolean; blank?: boolean }) {
    H.fetch = async (url: string, init?: any) => {
      if (state.down) throw new Error('error sending request for url (http://127.0.0.1:6461/pospoint)')
      const body = JSON.parse(String(init.body))
      if (body.method === 'Api.GetZReportInfo') {
        return reply({ jsonrpc: '2.0', id: body.id, result: state.blank
            ? { OpenTime: '', CloseTime: '', Number: 546 }
            : { OpenTime: '2026-11-09 09:00:00', CloseTime: state.zOpen ? '' : '2026-11-09 21:00:00', Number: 7 } })
      }
      if (body.method === 'Api.GetUnsentCount') {
        return reply({ jsonrpc: '2.0', id: body.id, result: { Count: state.unsent ?? 0, TerminalID: 'T' } })
      }
      throw new Error(`unexpected ${body.method} ${url}`)
    }
  }

  it('E-POS: смена закрыта, всё отправлено — можно', async () => {
    epos({})
    expect(await R.checkSwitchReadiness('epos', 'pospoint')).toEqual({ status: 'ready', notes: [] })
  })

  it('E-POS после закрытия отдаёт пустую запись смены (без времени) — это закрытая смена', async () => {
    epos({ blank: true })
    expect(await R.checkSwitchReadiness('epos', 'pospoint')).toEqual({ status: 'ready', notes: [] })
  })

  it('E-POS: открытая смена и неотправленные чеки — нельзя, с причинами', async () => {
    epos({ zOpen: true, unsent: 4 })
    const r = await R.checkSwitchReadiness('epos', 'pospoint')
    expect(r.status).toBe('blocked')
    expect((r as { reasons: string[] }).reasons.join(' ')).toMatch(/Закройте смену.*не отправлено в ОФД чеков: 4/s)
  })

  it('E-POS не отвечает — «не удалось проверить», решает кассир', async () => {
    epos({ down: true })
    expect((await R.checkSwitchReadiness('epos', 'pospoint')).status).toBe('unreachable')
  })

  it('FiscalDriveService: сначала отправляет накопленное, потом проверяет ФМ', async () => {
    H.settings.set(SettingKey.FiscalDriveFactoryId, 'LG4')
    const paths: string[] = []
    let memory = 6
    H.fetch = async (url: string) => {
      const path = new URL(url).pathname
      paths.push(path)
      if (path.includes('/Sync/FullReceipts')) {
        const sent = memory
        memory = 0
        return reply({ Items: new Array(sent).fill({}), SuccessfulsCount: sent })
      }
      if (path.includes('/Sync/ZReports')) return reply({ Items: [], SuccessfulsCount: 0 })
      if (path.includes('/ZReport/Info')) return reply({ CloseTime: '2026-11-09 21:00:00' })
      if (path.includes('/FiscalMemory/Info')) return reply({ ReceiptsCount: memory, ZReportsCount: 243 })
      throw new Error(`unexpected ${url}`)
    }
    const r = await R.checkSwitchReadiness('fiscaldrive', 'pospoint')
    expect(r.status).toBe('ready')
    expect((r as { notes: string[] }).notes.join(' ')).toMatch(/чеков 6/)
    expect(paths.findIndex((p) => p.includes('Sync'))).toBeLessThan(paths.findIndex((p) => p.includes('FiscalMemory')))
  })

  it('FiscalDriveService: в ФМ остались чеки — нельзя', async () => {
    H.settings.set(SettingKey.FiscalDriveFactoryId, 'LG4')
    H.fetch = async (url: string) => {
      const path = new URL(url).pathname
      if (path.includes('/Sync/')) return reply({ Items: [], SuccessfulsCount: 0 })
      if (path.includes('/ZReport/Info')) return reply({ CloseTime: '2026-11-09 21:00:00' })
      if (path.includes('/FiscalMemory/Info')) return reply({ ReceiptsCount: 2, ZReportsCount: 1 })
      throw new Error(`unexpected ${url}`)
    }
    const r = await R.checkSwitchReadiness('fiscaldrive', 'pospoint')
    expect(r.status).toBe('blocked')
    expect((r as { reasons: string[] }).reasons.join(' ')).toMatch(/чеки: 2/)
  })

  it('E-POS занят (не ответил вовремя) — «подождите», а не «выключен»', async () => {
    H.fetch = (_url: string, init?: any) =>
      new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('Request cancelled'))))
    const r = await settle(R.checkSwitchReadiness('epos', 'pospoint'))
    expect(r.value.status).toBe('blocked')
    expect(r.value.reasons.join(' ')).toMatch(/Подождите минуту/)
  })

  it('FiscalDriveService: сбой запроса смены — не «смена закрыта»', async () => {
    H.settings.set(SettingKey.FiscalDriveFactoryId, 'LG4')
    H.fetch = async (url: string) => {
      const path = new URL(url).pathname
      if (path.includes('/Sync/')) return reply({ Items: [], SuccessfulsCount: 0 })
      if (path.includes('/ZReport/Info')) return reply('Internal Server Error', 500)
      if (path.includes('/FiscalMemory/Info')) return reply({ ReceiptsCount: 0, ZReportsCount: 0 })
      throw new Error(`unexpected ${url}`)
    }
    expect((await R.checkSwitchReadiness('fiscaldrive', 'pospoint')).status).toBe('blocked')
  })

  it('E-POS отвечает ошибкой (так выглядит и отключённый) — проверить нельзя, решает кассир', async () => {
    H.fetch = async (_url: string, init?: any) => {
      const body = JSON.parse(String(init.body))
      return reply({ jsonrpc: '2.0', id: body.id, error: { code: 500, message: 'service disabled' } })
    }
    const r = await R.checkSwitchReadiness('epos', 'pospoint')
    expect(r.status).toBe('blocked')
    expect((r as { unverified?: string }).unverified).toMatch(/E-POS ответил ошибкой/)
  })

  it('E-POS: открытая смена — обхода нет', async () => {
    epos({ zOpen: true })
    const r = await R.checkSwitchReadiness('epos', 'pospoint')
    expect((r as { unverified?: string }).unverified).toBeUndefined()
  })

  it('обратно с Pospoint: есть попытки с неизвестным исходом — нельзя, даже если Pospoint выключен', async () => {
    await M.pp.setPendingAttempt('doc-x', { kind: 'sale', inputFp: '', requestJson: '{}', snapshot: null, at: Date.now() })
    fake.down = true
    const r = await R.checkSwitchReadiness('pospoint', 'epos')
    expect(r.status).toBe('blocked')
    expect((r as { reasons: string[] }).reasons.join(' ')).toMatch(/doc-x/)
  })

  it('обратно с Pospoint: открытая смена — нельзя', async () => {
    fake.shiftOpen = true
    const r = await R.checkSwitchReadiness('pospoint', 'epos')
    expect(r.status).toBe('blocked')
    expect((r as { reasons: string[] }).reasons.join(' ')).toMatch(/Закройте смену/)
  })
})
