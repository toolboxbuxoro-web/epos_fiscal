/**
 * Чистая логика поиска по Истории чеков: нормализация, токенизация и сборка
 * WHERE. Вынесена из DAO, чтобы тестироваться без подключения к SQLite.
 *
 * Модель: ищем по денормализованной колонке `fiscal_receipts.search_text`
 * (migration 014), а не по `request_json` — там 5–50 КБ JSON на чек, и LIKE
 * по блобу читает всю таблицу на каждый введённый символ.
 */

import { parseRequestJsonReceipt } from '@/lib/epos/request-json'

/**
 * Привести строку к виду, в котором она хранится в `search_text` и в котором
 * сравнивается поисковый запрос.
 *
 * ⚠️ Нижний регистр обязателен на ОБЕИХ сторонах сравнения: SQLite LIKE
 * регистронезависим только для ASCII, кириллицу он не сворачивает (SQL-функция
 * lower() — тоже). Поэтому нормализуем в JS: `toLowerCase()` корректно
 * обрабатывает и кириллицу, и узбекскую латиницу.
 */
export function normalizeSearch(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Собрать `search_text` чека — всё, по чему кассир может его искать.
 *
 * Индексируем ОБА набора названий, и это принципиально:
 *   - `ms_item_names` — что покупатель реально купил («Дрель Makita»). Именно
 *     это кассир помнит и будет вводить в поиск.
 *   - имена и ИКПУ из `request_json` — что ушло в ОФД после подмены ИКПУ
 *     («Коронка алмазного сверления»). Нужно бухгалтеру при сверке с soliq.uz.
 * Искать только по второму набору бессмысленно: при стратегиях price-bucket /
 * multi-item подменённое имя вообще не связано с покупкой.
 *
 * Формат payload может быть и EPOS, и FiscalDriveService — parseRequestJsonReceipt
 * понимает оба.
 */
export function buildSearchText(input: {
  request_json: string
  receipt_seq: string
  fiscal_sign: string
  terminal_id: string
  /** Номер чека МойСклад («05401») — кассир чаще помнит именно его. */
  ms_name?: string | null
  /** Названия позиций как в чеке МойСклад (до подмены ИКПУ). */
  ms_item_names?: string[] | null
}): string {
  const parts: string[] = [
    input.receipt_seq,
    input.fiscal_sign,
    input.terminal_id,
    input.ms_name ?? '',
    ...(input.ms_item_names ?? []),
  ]
  const parsed = parseRequestJsonReceipt(input.request_json)
  if (parsed) {
    for (const it of parsed.items) {
      parts.push(it.name, it.classCode)
    }
  }
  return normalizeSearch(parts.join(' '))
}

/** Фильтры Истории. Пустые поля = «без ограничения». */
export interface HistoryFilters {
  /** Свободный текст: товар, ИКПУ, № чека, фискальный признак. */
  query?: string
  /** Начало периода включительно (epoch sec). */
  dateFrom?: number | null
  /** Конец периода включительно (epoch sec). */
  dateTo?: number | null
}

/** Максимум токенов в запросе — защита от «простыни» из 50 слов. */
const MAX_TOKENS = 6

/**
 * Разбить запрос на токены. Каждый ищется отдельным LIKE, все соединяются
 * через AND — поэтому «коронка 132» находит «Коронка алмазного сверления
 * 132*450» независимо от порядка слов.
 */
export function tokenizeQuery(query?: string): string[] {
  const norm = normalizeSearch(query ?? '')
  if (!norm) return []
  return norm.split(' ').filter(Boolean).slice(0, MAX_TOKENS)
}

/** Экранировать спецсимволы LIKE, чтобы «100%» искалось буквально. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`)
}

/**
 * Собрать WHERE + параметры из фильтров. Пустой `sql` (нет фильтров) —
 * запрос идёт прямо по индексу `idx_fiscal_receipts_fiscalized`.
 */
export function buildWhere(f: HistoryFilters): {
  sql: string
  params: unknown[]
} {
  const clauses: string[] = []
  const params: unknown[] = []
  for (const token of tokenizeQuery(f.query)) {
    params.push(`%${escapeLike(token)}%`)
    clauses.push(`search_text LIKE $${params.length} ESCAPE '\\'`)
  }
  if (f.dateFrom != null) {
    params.push(f.dateFrom)
    clauses.push(`fiscalized_at >= $${params.length}`)
  }
  if (f.dateTo != null) {
    params.push(f.dateTo)
    clauses.push(`fiscalized_at <= $${params.length}`)
  }
  return {
    sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '',
    params,
  }
}
