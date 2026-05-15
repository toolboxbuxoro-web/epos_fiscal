/**
 * Поиск приходов по тексту для ручного picker'а.
 *
 * Архитектура:
 *   - **In-memory индекс**, строится один раз на выборку `MatcherPool`
 *   - Substring matching по name + class_code + source_doc
 *   - AND-логика: каждый токен запроса должен встретиться в haystack
 *   - Score-ранжирование: exact name >> prefix >> substring middle
 *   - Special: query из 14-17 цифр → exact ИКПУ lookup
 *   - Cap: 100 результатов (виртуализация не нужна — DOM держит 100 строк
 *     без лагов; если нужно больше — пользователь уточнит запрос)
 *
 * Сложность:
 *   - Build index: O(N) с одним проходом по pool
 *   - Search: O(N × K) где K = число query-токенов. Для 5000 items и
 *     2-3 токенов ≈ 5-15 ms — мгновенно для UI.
 *
 * Не используем регэкспы / NLP / fuzzy в этой ветке — это manual-picker
 * для **точного** выбора. Auto-suggest по сходству есть в основном matcher.
 */

import type { EsfItemWithAvailable } from '@/lib/db'
import type { MatcherPool, PoolItem } from './strategies'

export interface SearchResult {
  item: EsfItemWithAvailable
  /** Расчётная продажная цена (тийины). Берём из pool — он уже посчитан. */
  sellingPrice: number
  /** 0..100, чем выше — тем релевантнее. */
  score: number
}

export interface SearchFilters {
  /** Показывать только записи с qty_received - qty_consumed > 0. */
  onlyAvailable?: boolean
  /** Точное совпадение по notes (код партии «1382Vт»). */
  sourceDoc?: string
}

/**
 * Нормализатор: lowercase + ё→е + multi-space → single space + trim.
 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

/**
 * Разобрать query на минимально-значимые токены:
 *   - Длина >= 2 (исключаем «и», «в» и т.п.)
 *   - Сохраняем как есть (без удаления знаков препинания — модели типа
 *     `HR-2470` и `HR 2470` пользователь должен искать одинаково,
 *     но `2470` тоже валиден сам по себе).
 *
 * Также вычищаем пунктуацию-разделители (`,`, `.`, `;`).
 */
function tokenizeQuery(q: string): string[] {
  return normalize(q)
    .replace(/[,.;:()«»"']+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2)
}

/**
 * Главная функция: отфильтровать pool по query+filters и вернуть top-K
 * результатов с score'ами.
 *
 * @param pool       MatcherPool (уже подсчитанный sellingPrice — переиспользуем)
 * @param query      Строка поиска (может быть пустой — вернёт top по индексу)
 * @param filters    Опциональные фильтры
 * @param limit      Сколько вернуть (default 100)
 */
export function searchPool(
  pool: MatcherPool,
  query: string,
  filters: SearchFilters = {},
  limit = 100,
): SearchResult[] {
  // Сначала применяем фильтры
  let candidates: PoolItem[] = pool.items
  if (filters.onlyAvailable !== false) {
    // По default включено: показываем только с остатком
    candidates = candidates.filter(
      (p) => p.item.qty_received - p.item.qty_consumed >= 1000,
    )
  }
  if (filters.sourceDoc) {
    const sd = filters.sourceDoc.toLowerCase().trim()
    candidates = candidates.filter(
      (p) => (p.item.notes ?? '').toLowerCase().trim() === sd,
    )
  }

  const q = normalize(query)

  // Special case 1: пустой query — вернём первые `limit` (отсортированных
  // по received_at DESC чтобы свежие сверху).
  if (!q) {
    return candidates
      .slice()
      .sort((a, b) => b.item.received_at - a.item.received_at)
      .slice(0, limit)
      .map((p) => ({ item: p.item, sellingPrice: p.sellingPrice, score: 0 }))
  }

  // Special case 2: query это 14-17 цифр → exact ИКПУ
  if (/^\d{14,17}$/.test(q)) {
    return candidates
      .filter((p) => p.item.class_code === q.padStart(17, '0'))
      .slice(0, limit)
      .map((p) => ({ item: p.item, sellingPrice: p.sellingPrice, score: 100 }))
  }

  // Main path: AND-поиск по токенам с score
  const queryTokens = tokenizeQuery(query)
  if (queryTokens.length === 0) {
    return candidates
      .slice(0, limit)
      .map((p) => ({ item: p.item, sellingPrice: p.sellingPrice, score: 0 }))
  }

  type Scored = { p: PoolItem; score: number }
  const scored: Scored[] = []

  for (const p of candidates) {
    const haystack = normalize(
      `${p.item.name} ${p.item.class_code ?? ''} ${p.item.notes ?? ''} ${p.item.external_id ?? ''}`,
    )

    // Все токены должны встретиться (AND-логика)
    let matched = true
    let score = 0

    // Бонус за полный exact-match имени (после нормализации)
    if (normalize(p.item.name) === q) {
      score = 100
    } else {
      for (const t of queryTokens) {
        const idx = haystack.indexOf(t)
        if (idx < 0) {
          matched = false
          break
        }
        // Score: чем ближе к началу haystack, тем лучше
        if (idx === 0) score += 30 // prefix-match имени
        else if (haystack[idx - 1] === ' ') score += 20 // на границе слова
        else score += 10 // в середине слова
        // Бонус за длину совпадения (длинный токен = специфичный)
        score += Math.min(t.length, 10)
      }
    }

    if (matched) {
      scored.push({ p, score })
    }
  }

  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => ({
    item: s.p.item,
    sellingPrice: s.p.sellingPrice,
    score: s.score,
  }))
}
