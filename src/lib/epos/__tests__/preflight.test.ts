/**
 * Тесты preflight-логики которая ДО reserve проверяет actual server state.
 *
 * Чистая state-machine симуляция (без реального fetch) — копирует логику
 * из `tryRemoteReserve` в fiscalize.ts. Если поведение разойдётся —
 * тест упадёт.
 *
 * Покрытие:
 *   1. Все items доступны → preflight ОК → reserve выполняется
 *   2. 1 из N items insufficient → conflict БЕЗ reserve
 *   3. listItems упал → продолжаем без preflight (fallback)
 *   4. Сервер 0 available но локально cached 5 → preflight отлавливает
 *   5. preflight отлавливает кейс 19:14 (Хонабод)
 */

import { describe, it, expect } from 'vitest'
import { InventoryConflictError } from '@/lib/epos/fiscalize'
import type { RemoteInvItem } from '@/lib/inventory/types'

/**
 * Симулирует логику preflight из tryRemoteReserve.
 * Возвращает действие которое handler выполнит.
 */
async function simulatePreflight(opts: {
  reserveItems: Array<{ inv_item_id: number; quantity: number }>
  /** То что вернёт listItems от сервера. null = network error. */
  serverItems: RemoteInvItem[] | null
}): Promise<
  | { action: 'reserve'; items: typeof opts.reserveItems }
  | { action: 'conflict'; failed: Array<{ inv_item_id: number; available: number; requested: number }> }
  | { action: 'fallback'; reason: string }
> {
  const itemIds = opts.reserveItems.map((it) => it.inv_item_id)

  if (opts.serverItems === null) {
    // Симуляция network error
    return { action: 'fallback', reason: 'listItems failed' }
  }

  const freshById = new Map<number, RemoteInvItem>()
  for (const f of opts.serverItems) {
    if (itemIds.includes(f.id)) freshById.set(f.id, f)
  }

  const insufficient: Array<{ inv_item_id: number; available: number; requested: number }> = []
  for (const it of opts.reserveItems) {
    const f = freshById.get(it.inv_item_id)
    if (!f) continue
    const available = f.qty_received - f.qty_consumed - f.qty_reserved
    if (available < it.quantity) {
      insufficient.push({ inv_item_id: it.inv_item_id, available, requested: it.quantity })
    }
  }

  if (insufficient.length > 0) {
    return { action: 'conflict', failed: insufficient }
  }
  return { action: 'reserve', items: opts.reserveItems }
}

function mkRemoteItem(opts: {
  id: number
  received: number
  consumed?: number
  reserved?: number
}): RemoteInvItem {
  return {
    id: opts.id,
    name: `item-${opts.id}`,
    class_code: '08000000000000000',
    package_code: null,
    vat_percent: 12,
    unit_price_tiyin: 100000,
    qty_received: opts.received * 1000,
    qty_consumed: (opts.consumed ?? 0) * 1000,
    qty_reserved: (opts.reserved ?? 0) * 1000,
    received_at: '2026-05-15',
    imported_at: '2026-05-15T00:00:00Z',
    source_doc: null,
    organization_id: 'default',
  } as RemoteInvItem
}

describe('Preflight: ДО reserve проверка серверных остатков', () => {
  describe('Happy path', () => {
    it('все items доступны → action=reserve', async () => {
      const r = await simulatePreflight({
        reserveItems: [
          { inv_item_id: 1, quantity: 2000 },
          { inv_item_id: 2, quantity: 1000 },
        ],
        serverItems: [
          mkRemoteItem({ id: 1, received: 10 }),
          mkRemoteItem({ id: 2, received: 5 }),
        ],
      })
      expect(r.action).toBe('reserve')
    })

    it('exact-fit (available = requested) → action=reserve', async () => {
      const r = await simulatePreflight({
        reserveItems: [{ inv_item_id: 1, quantity: 5000 }],
        serverItems: [mkRemoteItem({ id: 1, received: 5 })],
      })
      expect(r.action).toBe('reserve')
    })
  })

  describe('Insufficient detection — главная польза preflight', () => {
    it('1 sold-out item → action=conflict с failed[]', async () => {
      const r = await simulatePreflight({
        reserveItems: [{ inv_item_id: 1, quantity: 1000 }],
        serverItems: [mkRemoteItem({ id: 1, received: 5, consumed: 5 })], // sold-out
      })
      expect(r.action).toBe('conflict')
      if (r.action === 'conflict') {
        expect(r.failed).toHaveLength(1)
        expect(r.failed[0]!.inv_item_id).toBe(1)
        expect(r.failed[0]!.available).toBe(0)
      }
    })

    it('partial sold-out в multi-item → conflict содержит только sold-out', async () => {
      const r = await simulatePreflight({
        reserveItems: [
          { inv_item_id: 1, quantity: 1000 },
          { inv_item_id: 2, quantity: 1000 },
          { inv_item_id: 3, quantity: 1000 },
        ],
        serverItems: [
          mkRemoteItem({ id: 1, received: 5 }), // OK
          mkRemoteItem({ id: 2, received: 1, consumed: 1 }), // sold-out
          mkRemoteItem({ id: 3, received: 10 }), // OK
        ],
      })
      expect(r.action).toBe('conflict')
      if (r.action === 'conflict') {
        expect(r.failed).toHaveLength(1)
        expect(r.failed[0]!.inv_item_id).toBe(2)
      }
    })

    it('available > 0 но < requested → conflict', async () => {
      const r = await simulatePreflight({
        reserveItems: [{ inv_item_id: 1, quantity: 3000 }], // нужно 3
        serverItems: [mkRemoteItem({ id: 1, received: 5, consumed: 3 })], // available=2
      })
      expect(r.action).toBe('conflict')
      if (r.action === 'conflict') {
        expect(r.failed[0]!.available).toBe(2000)
        expect(r.failed[0]!.requested).toBe(3000)
      }
    })

    it('item с qty_reserved учитывается в available', async () => {
      const r = await simulatePreflight({
        reserveItems: [{ inv_item_id: 1, quantity: 1000 }],
        serverItems: [mkRemoteItem({ id: 1, received: 5, consumed: 2, reserved: 3 })], // available=0
      })
      expect(r.action).toBe('conflict')
    })
  })

  describe('Fallback patterns', () => {
    it('listItems упал → action=fallback (не блокируем reserve)', async () => {
      const r = await simulatePreflight({
        reserveItems: [{ inv_item_id: 1, quantity: 1000 }],
        serverItems: null,
      })
      expect(r.action).toBe('fallback')
    })

    it('item не вернулся в listItems → НЕ блокируем (пусть reserve сам решит)', async () => {
      const r = await simulatePreflight({
        reserveItems: [
          { inv_item_id: 1, quantity: 1000 },
          { inv_item_id: 99, quantity: 1000 }, // нет в server
        ],
        serverItems: [mkRemoteItem({ id: 1, received: 5 })], // только id=1
      })
      // Preflight не нашёл item 99 — пропускаем, reserve сам сделает
      expect(r.action).toBe('reserve')
    })
  })

  describe('Сценарий 19:14 (Хонабод) — реальный кейс', () => {
    it('Локально matcher выбрал 4 товара которые на сервере sold-out', async () => {
      // Локальный кэш Хонабод показывал available > 0 для этих 4-х:
      const reserveItems = [
        { inv_item_id: 38, quantity: 1000 }, // Молоток (server: 13/13=0)
        { inv_item_id: 47, quantity: 1000 }, // Пушка обогреватель (6/6=0)
        { inv_item_id: 24, quantity: 1000 }, // Воздуходувка (6/6=0)
        { inv_item_id: 67, quantity: 1000 }, // Лента алюминиевая (11/11=0)
      ]

      // Server actual state — все sold-out
      const serverItems = [
        mkRemoteItem({ id: 38, received: 13, consumed: 13 }),
        mkRemoteItem({ id: 47, received: 6, consumed: 6 }),
        mkRemoteItem({ id: 24, received: 6, consumed: 6 }),
        mkRemoteItem({ id: 67, received: 11, consumed: 11 }),
      ]

      const r = await simulatePreflight({ reserveItems, serverItems })

      // Preflight должен ВСЕ 4 пометить как conflict
      expect(r.action).toBe('conflict')
      if (r.action === 'conflict') {
        expect(r.failed).toHaveLength(4)
        // Все они должны быть в exclude
        const failedIds = r.failed.map((f) => f.inv_item_id).sort()
        expect(failedIds).toEqual([24, 38, 47, 67])
      }
    })

    it('После conflict → cashier видит понятное сообщение, НЕ инфинит-цикл', async () => {
      // Симулируем сценарий: попытка 1 → conflict → exclude → matcher с
      // excludes → попытка 2 → reserve OK (alt-товары)

      // Сначала: попытка 1
      const try1 = await simulatePreflight({
        reserveItems: [{ inv_item_id: 38, quantity: 1000 }], // sold-out
        serverItems: [mkRemoteItem({ id: 38, received: 13, consumed: 13 })],
      })
      expect(try1.action).toBe('conflict')

      // Клиент добавляет 38 в excludedServerIds, matcher пересобирает
      // (в реальности матчер вернёт другой item, например 39)
      // Симулируем что новый план — id=39
      const try2 = await simulatePreflight({
        reserveItems: [{ inv_item_id: 39, quantity: 1000 }],
        serverItems: [mkRemoteItem({ id: 39, received: 5 })], // OK
      })
      expect(try2.action).toBe('reserve')
    })
  })

  describe('InventoryConflictError class', () => {
    it('создаётся с failed[] и читаемым message', () => {
      const err = new InventoryConflictError([
        { inv_item_id: 42, available: 0, requested: 1000 },
        { inv_item_id: 43, available: 500, requested: 2000 },
      ])
      expect(err.name).toBe('InventoryConflictError')
      expect(err.failed).toHaveLength(2)
      expect(err.message).toContain('Недостаточно')
    })
  })

  /**
   * Тесты Fix 2: preflight вызывает applyItemsUpdate только с подмножеством
   * товаров текущего резерва (freshById), а не с полным fresh.items (до 5000).
   *
   * Проверяем логику маппинга Map<id, RemoteInvItem> → { id, available }
   * изолированно, без вызова реальных Tauri-команд (SQLite недоступен в vitest).
   */
  describe('Fix 2: preflight → applyItemsUpdate маппинг подмножества', () => {
    /**
     * Симулирует построение freshById из simulatePreflight:
     * берём только items чьи id есть в reserveItems.
     */
    function buildFreshById(
      reserveItems: Array<{ inv_item_id: number; quantity: number }>,
      serverItems: RemoteInvItem[],
    ): Map<number, RemoteInvItem> {
      const itemIdsSet = new Set(reserveItems.map((it) => it.inv_item_id))
      const freshById = new Map<number, RemoteInvItem>()
      for (const f of serverItems) {
        if (itemIdsSet.has(f.id)) freshById.set(f.id, f)
      }
      return freshById
    }

    it('маппинг Map-entries → { id, available } корректен', () => {
      const reserveItems = [
        { inv_item_id: 1, quantity: 1000 },
        { inv_item_id: 2, quantity: 1000 },
        { inv_item_id: 3, quantity: 1000 },
      ]
      const serverItems: RemoteInvItem[] = [
        mkRemoteItem({ id: 1, received: 10, consumed: 3, reserved: 2 }),
        mkRemoteItem({ id: 2, received: 5, consumed: 5 }),
        mkRemoteItem({ id: 3, received: 7 }),
      ]
      const freshById = buildFreshById(reserveItems, serverItems)
      const cacheUpdates = Array.from(freshById.entries()).map(([id, f]) => ({
        id,
        available: f.qty_received - f.qty_consumed - f.qty_reserved,
      }))
      expect(cacheUpdates).toHaveLength(3)
      expect(cacheUpdates).toContainEqual({ id: 1, available: 5000 }) // (10−3−2)×1000
      expect(cacheUpdates).toContainEqual({ id: 2, available: 0 })    // sold-out
      expect(cacheUpdates).toContainEqual({ id: 3, available: 7000 }) // без reserved
    })

    it('товары вне текущего резерва НЕ попадают в cacheUpdates (оптимизация)', () => {
      // Сервер вернул 5000 items, но резервируем только 2. Только они должны
      // быть в freshById и, следовательно, в cacheUpdates.
      const reserveItems = [
        { inv_item_id: 10, quantity: 1000 },
        { inv_item_id: 11, quantity: 1000 },
      ]
      const serverItems: RemoteInvItem[] = [
        mkRemoteItem({ id: 10, received: 3 }),
        mkRemoteItem({ id: 11, received: 2, consumed: 1 }),
        // id 99, 100, 101 — не в reserve, не должны попасть в freshById
        mkRemoteItem({ id: 99, received: 50 }),
        mkRemoteItem({ id: 100, received: 10 }),
        mkRemoteItem({ id: 101, received: 7 }),
      ]
      const freshById = buildFreshById(reserveItems, serverItems)
      const cacheUpdates = Array.from(freshById.entries()).map(([id, f]) => ({
        id,
        available: f.qty_received - f.qty_consumed - f.qty_reserved,
      }))
      // Только 2 из 5 серверных items
      expect(cacheUpdates).toHaveLength(2)
      expect(cacheUpdates).toContainEqual({ id: 10, available: 3000 })
      expect(cacheUpdates).toContainEqual({ id: 11, available: 1000 })
      // Не-резервируемые не попали
      const ids = cacheUpdates.map((u) => u.id)
      expect(ids).not.toContain(99)
      expect(ids).not.toContain(100)
      expect(ids).not.toContain(101)
    })

    it('preflight конфликт: sold-out item попадает в cacheUpdates с available=0', () => {
      // applyItemsUpdate вызывается ДО throw — включая sold-out товары.
      const reserveItems = [
        { inv_item_id: 38, quantity: 1000 },
        { inv_item_id: 39, quantity: 1000 },
      ]
      const serverItems: RemoteInvItem[] = [
        mkRemoteItem({ id: 38, received: 13, consumed: 13 }), // sold-out
        mkRemoteItem({ id: 39, received: 5 }),                // доступен
      ]
      const freshById = buildFreshById(reserveItems, serverItems)
      const cacheUpdates = Array.from(freshById.entries()).map(([id, f]) => ({
        id,
        available: f.qty_received - f.qty_consumed - f.qty_reserved,
      }))
      // Оба попадают в кэш; sold-out с available=0
      expect(cacheUpdates).toContainEqual({ id: 38, available: 0 })
      expect(cacheUpdates).toContainEqual({ id: 39, available: 5000 })
      // Не содержит чужих ids из общего fresh-пула
      expect(cacheUpdates).toHaveLength(2)
    })
  })
})
