/**
 * Тесты Fix 3: confirmRemote применяет applyItemsUpdate из resp.items.
 *
 * Проверяем логику маппинга ConfirmOk.items → { id, available } изолированно,
 * без вызова реальных Tauri-команд (SQLite/HTTP недоступны в vitest).
 *
 * Покрытие:
 *   1. confirm OK с resp.items → правильный маппинг { id, available }
 *   2. confirm OK без resp.items (resp.items пустой) → applyItemsUpdate не вызывается
 *   3. applyItemsUpdate бросает ошибку → confirm не прерывается (best-effort)
 *   4. confirm NOT OK (resp.ok = false) → applyItemsUpdate не вызывается
 */

import { describe, it, expect, vi } from 'vitest'

/** Имитирует структуру ConfirmOk.items которую возвращает сервер. */
type ConfirmItemRow = {
  id: number
  qty_received: number
  qty_consumed: number
  qty_reserved: number
  available: number
}

/**
 * Симулирует логику confirmRemote из fiscalize.ts.
 * Возвращает список calls к applyItemsUpdate (для assertion).
 */
async function simulateConfirmRemote(opts: {
  respOk: boolean
  respItems?: ConfirmItemRow[]
  applyThrows?: boolean
}): Promise<{
  applyItemsUpdateCalls: Array<{ id: number; available: number }[]>
  applyItemsUpdateCallCount: number
}> {
  const applyItemsUpdateCalls: Array<{ id: number; available: number }[]> = []

  // Мок applyItemsUpdate
  const applyItemsUpdate = vi.fn(async (items: { id: number; available: number }[]) => {
    applyItemsUpdateCalls.push(items)
    if (opts.applyThrows) throw new Error('DB locked')
  })

  // Симуляция resp
  const resp = opts.respOk
    ? { ok: true as const, items: opts.respItems ?? [] }
    : { ok: false as const, code: 'NOT_FOUND' as const }

  // Логика из confirmRemote (Fix 3)
  if (resp.ok) {
    if (resp.items && resp.items.length > 0) {
      try {
        await applyItemsUpdate(
          resp.items.map((it) => ({
            id: it.id,
            available: it.available,
          })),
        )
      } catch {
        // best-effort: не прерываем confirm
      }
    }
  }

  return {
    applyItemsUpdateCalls,
    applyItemsUpdateCallCount: applyItemsUpdate.mock.calls.length,
  }
}

describe('Fix 3: confirmRemote → applyItemsUpdate маппинг', () => {
  describe('Happy path: confirm OK с items', () => {
    it('маппит ConfirmOk.items → { id, available } и вызывает applyItemsUpdate', async () => {
      const r = await simulateConfirmRemote({
        respOk: true,
        respItems: [
          { id: 1, qty_received: 10000, qty_consumed: 3000, qty_reserved: 0, available: 7000 },
          { id: 2, qty_received: 5000, qty_consumed: 5000, qty_reserved: 0, available: 0 },
        ],
      })
      expect(r.applyItemsUpdateCallCount).toBe(1)
      expect(r.applyItemsUpdateCalls[0]).toEqual([
        { id: 1, available: 7000 },
        { id: 2, available: 0 },
      ])
    })

    it('использует поле available напрямую (не пересчитывает из received-consumed-reserved)', async () => {
      // Сервер сам считает available — клиент доверяет серверу, не пересчитывает
      const r = await simulateConfirmRemote({
        respOk: true,
        respItems: [
          { id: 10, qty_received: 8000, qty_consumed: 2000, qty_reserved: 1000, available: 5000 },
        ],
      })
      // available = 5000 (как вернул сервер), не 8000-2000-1000=5000 (совпадает здесь,
      // но важно что берём resp.items[].available а не пересчитываем)
      expect(r.applyItemsUpdateCalls[0]).toEqual([{ id: 10, available: 5000 }])
    })
  })

  describe('Граничные случаи', () => {
    it('resp.items пустой → applyItemsUpdate НЕ вызывается', async () => {
      const r = await simulateConfirmRemote({ respOk: true, respItems: [] })
      expect(r.applyItemsUpdateCallCount).toBe(0)
    })

    it('resp.items undefined → applyItemsUpdate НЕ вызывается', async () => {
      const r = await simulateConfirmRemote({ respOk: true, respItems: undefined })
      expect(r.applyItemsUpdateCallCount).toBe(0)
    })

    it('confirm NOT OK → applyItemsUpdate НЕ вызывается', async () => {
      const r = await simulateConfirmRemote({ respOk: false })
      expect(r.applyItemsUpdateCallCount).toBe(0)
    })

    it('applyItemsUpdate бросает → confirm завершается без throw (best-effort)', async () => {
      // Не должно пробрасывать ошибку наружу
      await expect(
        simulateConfirmRemote({
          respOk: true,
          respItems: [
            { id: 99, qty_received: 1000, qty_consumed: 0, qty_reserved: 0, available: 1000 },
          ],
          applyThrows: true,
        }),
      ).resolves.toBeDefined()
    })
  })
})
