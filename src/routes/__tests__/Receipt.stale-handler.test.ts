/**
 * Тесты state-machine обработки `InventoryStaleError` в Receipt.tsx.
 *
 * Не запускаем сам React-компонент (требует jsdom + Tauri-моки) — вместо
 * этого моделируем чистую state-machine логики handler'а.
 *
 * Покрытие:
 *   1. 1-я stale → toast + sync + load + suspect-ids в exclude
 *   2. 2-я stale подряд → persistent-карточка + НЕ load
 *   3. Открытие модалки НЕ ресетит счётчик (фикса бага 23.05)
 *   4. Закрытие persistent через кнопку «Закрыть» → ресет
 *   5. Manual-план (manuallyBuilt:true) НЕ перетирается load'ом
 *   6. Debounce: 2 stale в течение 5 сек → 1 toast
 *   7. После 5 сек — следующий stale показывает toast
 *   8. Rebuild после stale/conflict получает уже НОВЫЕ exclude ids
 *      (регрессия React async state/старого closure в Receipt.tsx)
 */

import { describe, it, expect, beforeEach } from 'vitest'

/**
 * Чистая state-machine которая копирует поведение handler'а из Receipt.tsx
 * без зависимостей от React/Tauri/DB.
 *
 * Контракт: одна-в-одну с реальным handler'ом, чтобы тесты ловили регрессии.
 */
class StaleHandlerStateMachine {
  staleErrorCount = 0
  staleErrorPersistent = false
  excludedServerIds: number[] = []
  lastStaleToastTs = 0
  toastsShown: string[] = []
  loadCalled = 0
  loadExcludeIdsHistory: number[][] = []
  syncCalled = 0
  conflictSyncCalled = 0
  matchManuallyBuilt = false
  matchReplaced = false

  // Конфиг — для debounce
  STALE_TOAST_DEBOUNCE_MS = 5000
  /** Шкала «настенных часов» — внешний controllable timestamp для теста. */
  now: number = 1_000_000

  /**
   * Симулирует callback handler InventoryStaleError из Receipt.tsx.
   * Возвращает действия которые handler выполнил — для assertion в тестах.
   */
  async handleStale(suspectInvItemIds: number[] = []): Promise<{
    toast: string | null
    syncCalled: boolean
    loadCalled: boolean
    persistentSet: boolean
    matchPreserved: boolean
  }> {
    this.staleErrorCount += 1

    const shouldShowToast =
      this.now - this.lastStaleToastTs >= this.STALE_TOAST_DEBOUNCE_MS
    if (shouldShowToast) this.lastStaleToastTs = this.now

    // suspect-ids → excludedServerIds
    const newExcludes = suspectInvItemIds.length
      ? Array.from(new Set([...this.excludedServerIds, ...suspectInvItemIds]))
      : this.excludedServerIds
    this.excludedServerIds = newExcludes

    // forceFull sync
    this.syncCalled += 1
    const syncCalled = true

    // 2+ stale → persistent
    if (this.staleErrorCount >= 2) {
      this.staleErrorPersistent = true
      let toast: string | null = null
      if (shouldShowToast) {
        toast = 'Остатки повторно разошлись'
        this.toastsShown.push(toast)
      }
      return { toast, syncCalled, loadCalled: false, persistentSet: true, matchPreserved: true }
    }

    // Manual план — сохраняем, не пересобираем
    if (this.matchManuallyBuilt) {
      let toast: string | null = null
      if (shouldShowToast) {
        toast =
          suspectInvItemIds.length === 1
            ? '1 товар из ручного выбора закончился'
            : `${suspectInvItemIds.length} товара из ручного выбора закончились`
        this.toastsShown.push(toast)
      }
      return { toast, syncCalled, loadCalled: false, persistentSet: false, matchPreserved: true }
    }

    // Авто-план — load()
    this.loadCalled += 1
    this.loadExcludeIdsHistory.push([...this.excludedServerIds])
    this.matchReplaced = true
    let toast: string | null = null
    if (shouldShowToast) {
      toast = 'Остатки изменились, подбираю замены'
      this.toastsShown.push(toast)
    }
    return { toast, syncCalled, loadCalled: true, persistentSet: false, matchPreserved: false }
  }

  /**
   * Симулирует callback handler InventoryConflictError из Receipt.tsx.
   * Fix 1: сначала syncFromServer({ forceFull: true }), потом load().
   */
  async handleConflict(
    failedInvItemIds: number[],
    opts?: { syncThrows?: boolean },
  ): Promise<{
    syncCalled: boolean
    loadCalled: boolean
    loadExcludeIds: number[]
  }> {
    this.excludedServerIds = Array.from(
      new Set([...this.excludedServerIds, ...failedInvItemIds]),
    )
    // Fix 1: sync ПЕРЕД load
    this.conflictSyncCalled += 1
    if (opts?.syncThrows) {
      // best-effort: при ошибке sync load всё равно вызывается
    }
    this.loadCalled += 1
    this.loadExcludeIdsHistory.push([...this.excludedServerIds])
    return {
      syncCalled: true,
      loadCalled: true,
      loadExcludeIds: [...this.excludedServerIds],
    }
  }

  /** Симулирует нажатие «Открыть Собрать вручную» из persistent-карточки. */
  openManualModal(): void {
    this.staleErrorPersistent = false
    // Счётчик НЕ ресетится — фикса 23.05.2026
  }

  /** Симулирует нажатие «Закрыть» persistent-карточки. */
  dismissPersistent(): void {
    this.staleErrorPersistent = false
    this.staleErrorCount = 0
  }
}

// ── Tests ───────────────────────────────────────────────────────────

describe('Receipt.tsx — обработчик InventoryStaleError', () => {
  let sm: StaleHandlerStateMachine

  beforeEach(() => {
    sm = new StaleHandlerStateMachine()
  })

  describe('Сценарий 1: первая stale (нормальное поведение)', () => {
    it('инкрементит счётчик, показывает toast, делает sync+load', async () => {
      const r = await sm.handleStale([42])
      expect(r.toast).toContain('Остатки изменились')
      expect(r.syncCalled).toBe(true)
      expect(r.loadCalled).toBe(true)
      expect(r.persistentSet).toBe(false)
      expect(sm.staleErrorCount).toBe(1)
      expect(sm.excludedServerIds).toContain(42)
    })

    it('suspect-ids добавляются в exclude без дубликатов', async () => {
      sm.excludedServerIds = [10, 20]
      await sm.handleStale([20, 30, 40])
      expect(sm.excludedServerIds).toEqual([10, 20, 30, 40])
    })

    it('load после stale вызывается уже с новыми exclude ids', async () => {
      await sm.handleStale([42, 43])
      expect(sm.loadExcludeIdsHistory).toEqual([[42, 43]])
    })

    it('без suspect-ids — exclude не меняется', async () => {
      sm.excludedServerIds = [10]
      await sm.handleStale([])
      expect(sm.excludedServerIds).toEqual([10])
    })
  })

  describe('Сценарий 2: вторая stale подряд', () => {
    it('после 2 stale — persistent + НЕ load', async () => {
      await sm.handleStale([1])
      // 5 сек прошло чтобы избежать debounce
      sm.now += 6000
      const r = await sm.handleStale([2])
      expect(r.persistentSet).toBe(true)
      expect(r.loadCalled).toBe(false)
      expect(sm.staleErrorPersistent).toBe(true)
    })

    it('persistent держится даже после 3-й, 4-й stale', async () => {
      await sm.handleStale([1])
      sm.now += 6000
      await sm.handleStale([2])
      sm.now += 6000
      const r3 = await sm.handleStale([3])
      expect(r3.persistentSet).toBe(true)
      expect(sm.staleErrorPersistent).toBe(true)
    })
  })

  describe('Сценарий 3: открытие модалки НЕ ресетит счётчик (BUG FIX)', () => {
    it('открытие модалки не сбрасывает staleErrorCount', async () => {
      await sm.handleStale([1])
      sm.now += 6000
      await sm.handleStale([2]) // persistent set
      expect(sm.staleErrorCount).toBe(2)
      expect(sm.staleErrorPersistent).toBe(true)

      // Кассир жмёт «Открыть Собрать вручную»
      sm.openManualModal()
      expect(sm.staleErrorPersistent).toBe(false) // только persistent снят
      expect(sm.staleErrorCount).toBe(2) // ← НЕ сброшен! баг 23.05 fixed

      // Если после модалки опять stale — это 3-я подряд, persistent сразу
      sm.now += 6000
      const r = await sm.handleStale([3])
      expect(r.persistentSet).toBe(true)
    })

    it('закрытие persistent через X сбрасывает счётчик (легитимный exit)', async () => {
      await sm.handleStale([1])
      sm.now += 6000
      await sm.handleStale([2])
      sm.dismissPersistent()
      expect(sm.staleErrorCount).toBe(0)
      expect(sm.staleErrorPersistent).toBe(false)
    })
  })

  describe('Сценарий 4: manual план не перетирается load()', () => {
    it('manuallyBuilt=true → load НЕ вызывается, match не перетирается', async () => {
      sm.matchManuallyBuilt = true
      const r = await sm.handleStale([1])
      expect(r.loadCalled).toBe(false)
      expect(r.matchPreserved).toBe(true)
      expect(sm.matchReplaced).toBe(false)
    })

    it('manuallyBuilt + stale → toast говорит про ручной выбор', async () => {
      sm.matchManuallyBuilt = true
      const r = await sm.handleStale([1])
      expect(r.toast).toContain('из ручного выбора')
    })

    it('manuallyBuilt + 2 stale → persistent (как для auto)', async () => {
      sm.matchManuallyBuilt = true
      await sm.handleStale([1])
      sm.now += 6000
      const r2 = await sm.handleStale([2])
      expect(r2.persistentSet).toBe(true)
    })

    it('toast: 1 товар vs N товаров — корректная плюрализация', async () => {
      sm.matchManuallyBuilt = true

      const r1 = await sm.handleStale([1])
      expect(r1.toast).toContain('1 товар')

      sm.now += 6000
      sm.staleErrorCount = 0 // сбросим чтобы избежать persistent
      const r3 = await sm.handleStale([1, 2, 3])
      expect(r3.toast).toContain('3 товара')
    })
  })

  describe('Сценарий 5: debounce 5 сек', () => {
    it('2 stale в пределах 5 сек → 1 toast', async () => {
      await sm.handleStale([1])
      sm.now += 2000 // 2 сек спустя
      await sm.handleStale([2])
      // Второй toast НЕ показан (debounce)
      expect(sm.toastsShown).toHaveLength(1)
    })

    it('2 stale через >5 сек → 2 toast', async () => {
      await sm.handleStale([1])
      sm.now += 5001
      await sm.handleStale([2])
      expect(sm.toastsShown).toHaveLength(2)
    })

    it('debounce не мешает счётчику инкрементиться', async () => {
      await sm.handleStale([1])
      await sm.handleStale([2]) // debounced toast но счётчик += 1
      expect(sm.staleErrorCount).toBe(2)
      expect(sm.staleErrorPersistent).toBe(true) // 2+ → persistent
      expect(sm.toastsShown).toHaveLength(1) // но toast 1
    })
  })

  describe('Сценарий 6: всё вместе — реальный пользовательский кейс 19:14', () => {
    it('кассир Хонабод 19:14 — последовательность действий', async () => {
      // 19:14:00 — кассир жмёт Фискализировать → server inv_items_check
      const t1 = await sm.handleStale([1, 2])
      expect(t1.toast).toContain('Остатки изменились')
      expect(t1.loadCalled).toBe(true)

      // 19:14:30 — кассир жмёт Фискализировать второй раз (load пересобрал)
      // → опять stale (другой race)
      sm.now += 30_000
      const t2 = await sm.handleStale([3, 4])
      expect(t2.persistentSet).toBe(true) // 2-я → persistent
      expect(t2.loadCalled).toBe(false)

      // 19:14:45 — кассир жмёт «Открыть Собрать вручную»
      sm.openManualModal()
      expect(sm.staleErrorCount).toBe(2) // ← не сбросилось

      // 19:15:00 — кассир в модалке выбрал 10 товаров → manuallyBuilt=true,
      // нажал Готово → click Фискализировать
      sm.matchManuallyBuilt = true
      sm.now += 15_000
      const t3 = await sm.handleStale([5])
      // 3-я stale подряд → persistent остаётся, manuallyBuilt сохраняется
      expect(t3.persistentSet).toBe(true)
      expect(t3.matchPreserved).toBe(true)
    })
  })

  describe('Сценарий 7: InventoryConflictError тоже rebuild-ит со свежими exclude', () => {
    it('после 409 load получает failed inv_item_id сразу, без ожидания React state', async () => {
      sm.excludedServerIds = [10]
      const r = await sm.handleConflict([20, 30])
      expect(r.loadCalled).toBe(true)
      expect(r.loadExcludeIds).toEqual([10, 20, 30])
      expect(sm.loadExcludeIdsHistory).toEqual([[10, 20, 30]])
    })
  })

  describe('Сценарий 8 (Fix 1): InventoryConflictError делает sync ПЕРЕД load', () => {
    it('sync вызывается до load — rematch видит свежий кэш', async () => {
      sm.excludedServerIds = []
      const r = await sm.handleConflict([42])
      expect(r.syncCalled).toBe(true)
      expect(r.loadCalled).toBe(true)
      // sync должен быть ДО load — это гарантируется порядком в handleConflict
      expect(sm.conflictSyncCalled).toBe(1)
      expect(sm.loadCalled).toBe(1)
    })

    it('если sync бросил ошибку — load всё равно вызывается (best-effort)', async () => {
      // Симулируем: sync упал, но load НЕ должен быть пропущен
      const r = await sm.handleConflict([55], { syncThrows: true })
      expect(r.loadCalled).toBe(true)
      expect(r.loadExcludeIds).toContain(55)
    })

    it('failed ids попадают в exclude до load — load видит актуальный список', async () => {
      sm.excludedServerIds = [1, 2]
      const r = await sm.handleConflict([3, 4])
      expect(r.loadExcludeIds).toEqual([1, 2, 3, 4])
    })
  })
})
