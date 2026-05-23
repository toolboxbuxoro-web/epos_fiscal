/**
 * Module-level event bus для трансляции inventory-обновлений UI-компонентам.
 *
 * Зачем: SSE приходит в `runtime.ts::handleEvent` → `applyItemsUpdate`
 * (UPDATE SQLite). После этого нужно сообщить UI-компонентам (например
 * открытой `ManualReceiptModal`), что их локальный snapshot пула устарел.
 *
 * Архитектура — простой singleton с Set<listener>. Без React Context чтобы
 * подписчики могли быть в любом месте дерева, и без сторонних либ.
 *
 * Usage:
 *   useEffect(() => {
 *     const off = onItemsUpdated((items) => { ... обновить pool ... })
 *     return off
 *   }, [])
 *
 *   // В runtime.ts после applyItemsUpdate:
 *   emitItemsUpdated(items)
 */

export interface ItemsUpdatedPayload {
  /** id товара (esf_items.id, который = server inv_items.id) */
  id: number
  /** Новое значение available в миллидолях (qty_received - consumed - reserved) */
  available: number
}

type Listener = (items: ItemsUpdatedPayload[]) => void

const listeners = new Set<Listener>()

/**
 * Подписаться на обновления товаров. Возвращает функцию-отписку.
 * Слушатель НЕ должен throw'ить — каждый вызов в try/catch.
 */
export function onItemsUpdated(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Раздать событие всем подписчикам. Вызывается из `runtime.ts` после
 * успешного `applyItemsUpdate` (SQLite-апдейта).
 */
export function emitItemsUpdated(items: ItemsUpdatedPayload[]): void {
  if (items.length === 0) return
  for (const cb of listeners) {
    try {
      cb(items)
    } catch {
      // Слушатель упал — не ломаем других. Лог не пишем (телеметрия зашумится).
    }
  }
}
