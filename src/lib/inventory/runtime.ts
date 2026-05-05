/**
 * Runtime для multi-shop inventory: SSE-подписка + housekeeping + periodic sync.
 *
 * Запускается один раз на всё приложение из App.tsx (`ensureInventoryRuntime`).
 * Если конфиг сервера отсутствует (apiKey/serverUrl пусто) — тихо ничего не
 * делает (но AppGate в этом случае и не пустит в приложение).
 *
 * Что внутри:
 *   1. **Housekeeping на старте** — `runInventoryHousekeeping`:
 *      sync МС-creds от админа, retry зависших confirm, release stale reserved.
 *   2. **SSE-подписка** на `/api/v1/inventory/events` — live-обновления остатков.
 *   3. **Periodic sync** — fallback каждые 5 мин (если SSE отвалился).
 *   4. **Periodic housekeeping** — каждые 10 мин retry pending confirms.
 */

import { log } from '@/lib/log'
import {
  applyItemsUpdate,
  loadInventoryConfig,
  runInventoryHousekeeping,
  subscribeToInventoryEvents,
  syncFromServer,
} from './index'
import type { SseEvent } from './sse'

// ── Singleton state ─────────────────────────────────────────────────

let started = false
let stopSse: (() => void) | null = null
let syncTimer: ReturnType<typeof setInterval> | null = null
let housekeepingTimer: ReturnType<typeof setInterval> | null = null
let sseStatus: 'connected' | 'disconnected' | 'connecting' | 'idle' = 'idle'

// ── Public API ──────────────────────────────────────────────────────

/**
 * Запустить inventory runtime один раз. Если remote-режим выключен или
 * не сконфигурирован — никаких побочных эффектов.
 *
 * Idempotent: повторные вызовы возвращают сразу.
 */
export async function ensureInventoryRuntime(): Promise<void> {
  if (started) return
  started = true

  const cfg = await loadInventoryConfig()
  if (!cfg) {
    await log.info(
      'inventory.sync',
      'Remote inventory выключен или не сконфигурирован — runtime не запускаю',
    )
    return
  }

  await log.info(
    'inventory.sync',
    `Inventory runtime: server=${cfg.serverUrl}, shop=${cfg.shopSlug}`,
  )

  // 1. Housekeeping на старте — синхронно ждём, чтобы МС-creds приехали ДО
  // запуска МС-поллера. Это гарантирует что поллер сразу возьмёт правильные
  // creds (а не запустится с пустыми и упадёт с 401).
  try {
    await runInventoryHousekeeping()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `startup pass failed: ${msg}`)
  }

  // 2. Bootstrap full sync приходов в кэш (если ещё не было).
  try {
    const r = await syncFromServer()
    await log.info(
      'inventory.sync',
      `Bootstrap sync: ${r.synced} items, ${r.errors} errors`,
    )
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.sync', `Bootstrap sync failed: ${msg}`)
  }

  // 3. SSE подписка на live-обновления остатков.
  stopSse = subscribeToInventoryEvents({
    serverUrl: cfg.serverUrl,
    apiKey: cfg.apiKey,
    onEvent: handleSseEvent,
    onStatusChange: (status) => {
      sseStatus = status
      void log.info('inventory.sse', `SSE status: ${status}`)
    },
  })

  // 4. Periodic incremental sync (fallback если SSE отвалился — догоним).
  syncTimer = setInterval(
    () => {
      void syncFromServer().catch((e) =>
        log
          .warn(
            'inventory.sync',
            `periodic sync failed: ${e instanceof Error ? e.message : String(e)}`,
          )
          .catch(() => {}),
      )
    },
    5 * 60 * 1000,
  )

  // 5. Periodic housekeeping — на случай долгой сетевой проблемы.
  housekeepingTimer = setInterval(
    () => {
      void runInventoryHousekeeping().catch(() => {})
    },
    10 * 60 * 1000,
  )
}

/**
 * Остановить runtime (на размонтировании App или при переключении remote-режима).
 * После stop повторный `ensureInventoryRuntime` снова поднимется.
 */
export function stopInventoryRuntime(): void {
  if (!started) return
  started = false
  if (stopSse) {
    stopSse()
    stopSse = null
  }
  if (syncTimer) {
    clearInterval(syncTimer)
    syncTimer = null
  }
  if (housekeepingTimer) {
    clearInterval(housekeepingTimer)
    housekeepingTimer = null
  }
  sseStatus = 'idle'
}

/** Текущий статус SSE-подписки. Используется в UI-индикаторах. */
export function getInventorySseStatus(): typeof sseStatus {
  return sseStatus
}

// ── SSE event handler ───────────────────────────────────────────────

interface ItemsUpdatedPayload {
  /** Массив строк с новым available после reserve/confirm/release/expired. */
  items?: Array<{
    id: number
    qty_received?: number
    qty_consumed?: number
    qty_reserved?: number
    available: number
  }>
  // Ключ-в-ключ как сервер прислал (mytoolbox/services/inventory/sse.js).
}

async function handleSseEvent(e: SseEvent): Promise<void> {
  // Сервер шлёт два типа событий:
  //   - 'connected' — handshake (data: {shop: 'slug'})
  //   - 'inv.items.updated' — массив items с новым available
  if (e.type === 'connected') return
  if (e.type !== 'inv.items.updated') {
    // Неизвестное событие — лог для будущей расширяемости.
    await log.info('inventory.sse', `Unknown SSE event: ${e.type}`).catch(() => {})
    return
  }

  // Сервер шлёт data как массив (не объект). См. sse.broadcast в reservations.js
  // → broadcast('inv.items.updated', updatedItems) где updatedItems = массив.
  const items = Array.isArray(e.data)
    ? (e.data as ItemsUpdatedPayload['items'])
    : (e.data as ItemsUpdatedPayload | null)?.items
  if (!items || items.length === 0) return

  try {
    await applyItemsUpdate(items)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await log.warn('inventory.sse', `applyItemsUpdate failed: ${msg}`).catch(() => {})
  }
}
