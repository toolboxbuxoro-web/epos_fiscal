/**
 * In-memory кэш модификаций товаров МС.
 *
 * Используется в `enrichWithVariants` для linked-ms flow: когда чек МС
 * содержит позицию с базовым товаром (product), мы тянем его модификации
 * через `GET /entity/variant?filter=productid=<id>`. Если за короткое
 * время несколько чеков покажут один и тот же товар — кэш экономит N-1
 * HTTP-запросов.
 *
 * Дизайн:
 *   - Module-level Map (живёт всю сессию приложения)
 *   - TTL 5 минут — модификации редко меняются, 5 мин достаточно для
 *     актуальности и при этом покрывает пик загрузки 10-20 чеков подряд
 *   - LRU-эвикшен при размере >500 (защита от утечки памяти при долгой
 *     работе магазина с большим каталогом)
 *   - Errors не кэшируются — следующий вызов попробует снова
 *
 * НЕ персистится в SQLite — модификации могут меняться, локальный кэш
 * сильно усложнит invalidation. In-memory достаточно для практики.
 */

import type { MsVariant } from './types'

interface CacheEntry {
  variants: MsVariant[]
  timestamp: number
}

const TTL_MS = 5 * 60 * 1000 // 5 минут
const MAX_ENTRIES = 500       // LRU-эвикшен

const cache = new Map<string, CacheEntry>()

/**
 * Получить модификации товара с кэшированием.
 *
 * @param productId UUID товара МС
 * @param fetcher функция тянущая модификации (обычно `client.listVariantsByProduct`)
 */
export async function getCachedVariants(
  productId: string,
  fetcher: (productId: string) => Promise<MsVariant[]>,
): Promise<MsVariant[]> {
  const now = Date.now()
  const hit = cache.get(productId)
  if (hit && now - hit.timestamp < TTL_MS) {
    // LRU touch — переносим в конец Map (Map сохраняет порядок вставки)
    cache.delete(productId)
    cache.set(productId, hit)
    return hit.variants
  }

  const variants = await fetcher(productId)
  cache.set(productId, { variants, timestamp: now })

  // LRU-эвикшен: убираем самые старые если превысили лимит
  if (cache.size > MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }

  return variants
}

/**
 * Очистить кэш — для тестов или явной инвалидации (например после
 * редактирования модификации в админ-UI).
 */
export function clearVariantsCache(): void {
  cache.clear()
}

/** Статистика кэша — для дебага через console / Settings. */
export function getVariantsCacheStats(): { size: number; ttlMs: number; maxEntries: number } {
  return { size: cache.size, ttlMs: TTL_MS, maxEntries: MAX_ENTRIES }
}
