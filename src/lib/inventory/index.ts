/**
 * Multi-shop inventory клиент. Барак-точка для всего модуля.
 *
 * Файлы:
 *   - types.ts            — DTO для общения с сервером
 *   - server-client.ts    — fetch-обёртка над reserve/confirm/release/items/extend
 *   - sse.ts              — подписка на /events с reconnect
 *   - sync.ts             — pull /items в локальный кэш + конфиг
 *   - pending-confirms.ts — DAO над таблицей retry-очереди
 *   - retry.ts            — функции которые гоняем на старте app + по таймеру
 */

export * from './types'
export { InventoryServerClient, InventoryServerError } from './server-client'
export { subscribeToInventoryEvents } from './sse'
export type { SseEvent } from './sse'
export {
  loadInventoryConfig,
  getInventoryClient,
  syncFromServer,
  syncShopConfig,
  upsertRemoteItem,
  applyItemsUpdate,
} from './sync'
export {
  recordReserved,
  markFiscalOk,
  deletePendingByReservations,
  recordAttemptFailure,
  listFiscalOk,
  listStaleReserved,
  listAll as listAllPendingConfirms,
  markFailed,
} from './pending-confirms'
export type { PendingConfirmRow, PendingConfirmStatus } from './pending-confirms'
export {
  retryFiscalOkPending,
  releaseStaleReserved,
  runInventoryHousekeeping,
} from './retry'
export {
  ensureInventoryRuntime,
  stopInventoryRuntime,
  getInventorySseStatus,
} from './runtime'
export { signInWithMs, signOut, hasActiveSession } from './login'
export type { LoginErrorCode, LoginSuccess, LoginFailure } from './login'
