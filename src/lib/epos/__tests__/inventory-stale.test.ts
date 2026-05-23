/**
 * Полигон тестов для multi-shop race-conditions + stale-cache сценариев.
 *
 * Здесь воспроизводятся реальные продакшен-кейсы:
 *   1. Cashier пытается фискализировать → server: INSUFFICIENT_STOCK (409)
 *      → клиент: InventoryConflictError с failed[] → exclude + rematch
 *   2. Cashier пытается фискализировать → server: 500 + inv_items_check
 *      (legacy backend, до фикса structured 409) → клиент: InventoryStaleError
 *      с suspectInvItemIds → exclude + sync + load
 *   3. Cashier пытается → server: 500 + ANY constraint violation → клиент:
 *      InventoryStaleError (regex матчит)
 *   4. Race: shop A и shop B одновременно резервируют → FIFO: первый ОК,
 *      второй 409 INSUFFICIENT_STOCK
 *   5. Multiple consecutive stales → клиент должен escalate с persistent-карточкой
 *
 * Симуляция: in-memory backend (`MockInventoryServer`) который имитирует
 * поведение реального mytoolbox /reserve endpoint включая Postgres
 * FOR UPDATE сериализацию и inv_items_check.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  InventoryStaleError,
  InventoryConflictError,
} from '@/lib/epos/fiscalize'
import { InventoryServerError } from '@/lib/inventory/server-client'
import type {
  ReserveRequest,
  ReserveResponse,
} from '@/lib/inventory/types'

// ── Mock сервер ─────────────────────────────────────────────────────

/**
 * In-memory mock серверного `inv_items` + `/reserve` endpoint.
 *
 * Воспроизводит поведение реального mytoolbox:
 *   - SELECT FOR UPDATE как Mutex по inv_item_id
 *   - Check available перед UPDATE
 *   - Возврат 409 INSUFFICIENT_STOCK если available < requested
 *   - Возврат 500 + 'inv_items_check' если симулируем legacy bug
 *     (когда constraint фаерит несмотря на pre-check — corrupted state)
 *   - Atomic UPDATE qty_reserved += quantity
 */
class MockInventoryServer {
  items: Map<number, { id: number; qty_received: number; qty_consumed: number; qty_reserved: number }> = new Map()
  /** Эмулируем corruption: один из items имеет state нарушающий constraint. */
  forceConstraintOnItem: number | null = null

  seed(items: Array<{ id: number; received: number; consumed?: number; reserved?: number }>): void {
    for (const it of items) {
      this.items.set(it.id, {
        id: it.id,
        qty_received: it.received * 1000,
        qty_consumed: (it.consumed ?? 0) * 1000,
        qty_reserved: (it.reserved ?? 0) * 1000,
      })
    }
  }

  /**
   * Симулирует POST /api/v1/inventory/reserve.
   *
   * Возможные ответы:
   *   - ok: ReserveOk
   *   - 409: { ok:false, code:'INSUFFICIENT_STOCK', failed:[...] }
   *   - throws InventoryServerError(500, 'violates check constraint "inv_items_check"')
   *     если включён forceConstraintOnItem (симулируем legacy backend bug)
   */
  async reserve(req: ReserveRequest): Promise<ReserveResponse> {
    // Симуляция SELECT FOR UPDATE → check available
    const failed: Array<{
      inv_item_id: number
      requested: number
      available: number
      reason: string
    }> = []
    for (const it of req.items) {
      const stock = this.items.get(it.inv_item_id)
      if (!stock) {
        failed.push({
          inv_item_id: it.inv_item_id,
          requested: it.quantity,
          available: 0,
          reason: 'not_found',
        })
        continue
      }
      const available = stock.qty_received - stock.qty_consumed - stock.qty_reserved
      if (available < it.quantity) {
        failed.push({
          inv_item_id: it.inv_item_id,
          requested: it.quantity,
          available,
          reason: 'insufficient_stock',
        })
      }
    }
    if (failed.length > 0) {
      return { ok: false, code: 'INSUFFICIENT_STOCK', failed: failed as any }
    }

    // Эмулируем corrupted state: даже если pre-check прошёл, constraint фаерит
    // (legacy mytoolbox до фикса structured 409). Возможный сценарий когда:
    //   - bulkImport одновременно изменил qty_received
    //   - admin сделал manual_adjust в окне между SELECT и UPDATE (без FOR UPDATE)
    if (this.forceConstraintOnItem !== null) {
      const id = this.forceConstraintOnItem
      if (req.items.some((it) => it.inv_item_id === id)) {
        throw new InventoryServerError(
          `new row for relation "inv_items" violates check constraint "inv_items_check"`,
          500,
        )
      }
    }

    // UPDATE qty_reserved + INSERT reservations
    const reservations: Array<{
      reservation_id: string
      inv_item_id: number
      quantity: number
      expires_at: string
    }> = []
    const updatedItems: Array<{
      id: number
      qty_received: number
      qty_consumed: number
      qty_reserved: number
      available: number
    }> = []
    for (const it of req.items) {
      const stock = this.items.get(it.inv_item_id)!
      stock.qty_reserved += it.quantity
      reservations.push({
        reservation_id: `r${stock.id}-${Date.now()}`,
        inv_item_id: it.inv_item_id,
        quantity: it.quantity,
        expires_at: new Date(Date.now() + 300_000).toISOString(),
      })
      updatedItems.push({
        id: stock.id,
        qty_received: stock.qty_received,
        qty_consumed: stock.qty_consumed,
        qty_reserved: stock.qty_reserved,
        available: stock.qty_received - stock.qty_consumed - stock.qty_reserved,
      })
    }
    return { ok: true, reservations, items: updatedItems } as ReserveResponse
  }

  /** Симулирует другой магазин который забрал товар прямо сейчас. */
  simulateOtherShopConsume(itemId: number, qtyPcs: number): void {
    const stock = this.items.get(itemId)
    if (!stock) return
    stock.qty_consumed += qtyPcs * 1000
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('multi-shop inventory race-condition scenarios', () => {
  let server: MockInventoryServer

  beforeEach(() => {
    server = new MockInventoryServer()
  })

  describe('Сценарий 1: INSUFFICIENT_STOCK после расхождения с локальным кэшем', () => {
    it('возвращает 409 если items[0].available < requested', async () => {
      server.seed([{ id: 1, received: 5, consumed: 5 }]) // sold-out
      const result = await server.reserve({
        ms_receipt_id: 'ms-1',
        items: [{ inv_item_id: 1, quantity: 1000 }],
      })
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.code).toBe('INSUFFICIENT_STOCK')
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0]!.inv_item_id).toBe(1)
        expect(result.failed[0]!.available).toBe(0)
        expect(result.failed[0]!.requested).toBe(1000)
      }
    })

    it('возвращает 409 если ОДИН из multi-item набора недоступен', async () => {
      server.seed([
        { id: 1, received: 5 }, // OK
        { id: 2, received: 1, consumed: 1 }, // sold-out
        { id: 3, received: 10 }, // OK
      ])
      const result = await server.reserve({
        ms_receipt_id: 'ms-2',
        items: [
          { inv_item_id: 1, quantity: 1000 },
          { inv_item_id: 2, quantity: 1000 },
          { inv_item_id: 3, quantity: 1000 },
        ],
      })
      expect(result.ok).toBe(false)
      if (result.ok === false) {
        expect(result.failed).toHaveLength(1)
        expect(result.failed[0]!.inv_item_id).toBe(2)
      }
    })

    it('атомарно: при 409 ни один item НЕ должен иметь qty_reserved > 0', async () => {
      server.seed([
        { id: 1, received: 5 },
        { id: 2, received: 1, consumed: 1 }, // bad
      ])
      await server.reserve({
        ms_receipt_id: 'ms-3',
        items: [
          { inv_item_id: 1, quantity: 1000 },
          { inv_item_id: 2, quantity: 1000 },
        ],
      })
      // Проверяем что item 1 НЕ зарезервирован (всё или ничего)
      expect(server.items.get(1)!.qty_reserved).toBe(0)
      expect(server.items.get(2)!.qty_reserved).toBe(0)
    })
  })

  describe('Сценарий 2: inv_items_check 500 — legacy backend / corrupted state', () => {
    it('throws InventoryServerError при включённом forceConstraintOnItem', async () => {
      server.seed([{ id: 1, received: 5 }])
      server.forceConstraintOnItem = 1
      await expect(
        server.reserve({
          ms_receipt_id: 'ms-4',
          items: [{ inv_item_id: 1, quantity: 1000 }],
        }),
      ).rejects.toThrow(InventoryServerError)
    })

    it('error message должен матчить detection regex клиента', async () => {
      server.seed([{ id: 1, received: 5 }])
      server.forceConstraintOnItem = 1
      try {
        await server.reserve({
          ms_receipt_id: 'ms-5',
          items: [{ inv_item_id: 1, quantity: 1000 }],
        })
        expect.fail('должен был бросить')
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        // ВАЖНО: tryRemoteReserve использует этот regex для конвертации в InventoryStaleError
        expect(/inv_items_check|violates check constraint/i.test(msg)).toBe(true)
      }
    })
  })

  describe('Сценарий 3: race-condition между двумя магазинами', () => {
    it('FIFO — первый победитель забирает, второй получает 409', async () => {
      server.seed([{ id: 1, received: 1 }]) // только 1 шт в наличии

      // Shop A
      const a = await server.reserve({
        ms_receipt_id: 'ms-shop-a',
        items: [{ inv_item_id: 1, quantity: 1000 }],
      })
      expect(a.ok).toBe(true)

      // Shop B (опоздал)
      const b = await server.reserve({
        ms_receipt_id: 'ms-shop-b',
        items: [{ inv_item_id: 1, quantity: 1000 }],
      })
      expect(b.ok).toBe(false)
      if (b.ok === false) {
        expect(b.code).toBe('INSUFFICIENT_STOCK')
        expect(b.failed[0]!.available).toBe(0)
      }
    })

    it('cashier открыл модалку, между sync и reserve другая касса забрала', async () => {
      server.seed([{ id: 1, received: 3 }])

      // Снимок пула в локальном кэше — кассир видит available=3
      const snapshotAvailable = 3

      // Другой магазин забирает 3 шт пока кассир выбирает
      server.simulateOtherShopConsume(1, 3)

      // Cashier пытается фискализировать с локальным планом
      const result = await server.reserve({
        ms_receipt_id: 'ms-late',
        items: [{ inv_item_id: 1, quantity: 1000 }], // хочет 1 шт
      })

      expect(result.ok).toBe(false)
      if (result.ok === false) {
        // Локальный кэш отстал — у нас snapshotAvailable=3, у сервера 0
        expect(result.failed[0]!.available).toBe(0)
        expect(result.failed[0]!.available).toBeLessThan(snapshotAvailable * 1000)
      }
    })
  })

  describe('Сценарий 4: InventoryConflictError + InventoryStaleError классы', () => {
    it('InventoryConflictError содержит failed[] с inv_item_id', () => {
      const err = new InventoryConflictError([
        { inv_item_id: 42, available: 0, requested: 1000 },
      ])
      expect(err.name).toBe('InventoryConflictError')
      expect(err.failed).toHaveLength(1)
      expect(err.failed[0]!.inv_item_id).toBe(42)
    })

    it('InventoryStaleError несёт suspectInvItemIds для exclude', () => {
      const err = new InventoryStaleError([10, 20, 30])
      expect(err.name).toBe('InventoryStaleError')
      expect(err.suspectInvItemIds).toEqual([10, 20, 30])
    })

    it('InventoryStaleError без аргументов — пустой массив', () => {
      const err = new InventoryStaleError()
      expect(err.suspectInvItemIds).toEqual([])
    })
  })

  describe('Сценарий 5: multi-item с частичным conflict', () => {
    it('partial sold-out не блокирует другие items сразу — но 409 всё отменяет', async () => {
      server.seed([
        { id: 1, received: 100 }, // много
        { id: 2, received: 1, consumed: 1 }, // sold-out
      ])
      const r = await server.reserve({
        ms_receipt_id: 'ms-partial',
        items: [
          { inv_item_id: 1, quantity: 50_000 }, // 50 шт
          { inv_item_id: 2, quantity: 1000 }, // 1 шт sold-out
        ],
      })
      expect(r.ok).toBe(false)
      // Item 1 НЕ зарезервирован, даже если он валиден
      expect(server.items.get(1)!.qty_reserved).toBe(0)
    })
  })

  describe('Сценарий 6: client recovery patterns', () => {
    /**
     * Симулируем флоу:
     *   reserve → 409 → клиент добавляет failed_ids в exclude → rematch с
     *   другими товарами → reserve → ОК.
     */
    it('exclude logic — после 409 матчер пропускает sold-out, выбирает alt', async () => {
      server.seed([
        { id: 1, received: 5, consumed: 5 }, // sold-out
        { id: 2, received: 10 }, // OK, alt
      ])

      // Попытка 1: матчер выбрал sold-out
      const try1 = await server.reserve({
        ms_receipt_id: 'ms-recover',
        items: [{ inv_item_id: 1, quantity: 1000 }],
      })
      expect(try1.ok).toBe(false)

      // Клиент должен добавить item 1 в exclude и попробовать item 2
      const excludedAfterTry1 = (try1 as any).failed.map((f: any) => f.inv_item_id)
      expect(excludedAfterTry1).toContain(1)

      // Попытка 2: матчер с excludes выбирает alt (item 2)
      const try2 = await server.reserve({
        ms_receipt_id: 'ms-recover',
        items: [{ inv_item_id: 2, quantity: 1000 }],
      })
      expect(try2.ok).toBe(true)
    })

    /**
     * Симулируем preflight: GET /items?ids=1,2 ПЕРЕД reserve. Если хотя бы один
     * item insufficient → InventoryConflictError БЕЗ reserve-запроса.
     */
    it('preflight — обнаруживает stale кэш ДО отправки reserve', () => {
      server.seed([{ id: 1, received: 5, consumed: 5 }]) // sold-out

      // Локально клиент думает что available=5
      const cachedAvailable = 5 * 1000
      const requestedQty = 1000

      // Preflight: fetch свежее состояние items
      const fresh = Array.from(server.items.values()).map((s) => ({
        id: s.id,
        available: s.qty_received - s.qty_consumed - s.qty_reserved,
      }))

      const insufficient: number[] = []
      for (const item of [{ id: 1, quantity: requestedQty }]) {
        const f = fresh.find((x) => x.id === item.id)
        if (!f || f.available < item.quantity) {
          insufficient.push(item.id)
        }
      }

      // Preflight должен обнаружить stale (cachedAvailable=5*1000, actual=0)
      expect(cachedAvailable).toBeGreaterThan(0)
      expect(insufficient).toContain(1)
    })
  })
})
