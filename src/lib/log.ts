import { getDb, now } from '@/lib/db'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource =
  | 'app'
  | 'poller'
  | 'moysklad'
  | 'epos'
  | 'matcher'
  | 'fiscalize'
  | 'refund'
  | 'updater'
  | 'ui'
  | 'esf-import'
  | 'inventory.sync'
  | 'inventory.sse'
  | 'inventory.retry'
  | 'inventory.housekeeping'
  | 'sales-sync'

export interface LogRow {
  id: number
  ts: number
  level: LogLevel
  source: LogSource
  message: string
  details: string | null
  /**
   * Отправлен ли лог на mytoolbox-сервер (телеметрия для centralized
   * debugging). 0 — ещё нет, 1 — отправлен. Заполняется только для
   * level='error' (см. src/lib/telemetry.ts). info/debug/warn остаются
   * локальными — на сервер не шлём чтобы не засорять трафик.
   */
  sent_to_server?: number
}

/**
 * Записать строку в лог. В debug-режиме также пишем в console.
 * Никогда не throw — лог не должен ронять основной поток.
 */
async function write(
  level: LogLevel,
  source: LogSource,
  message: string,
  details?: unknown,
): Promise<void> {
  // console-зеркало (видно в DevTools и в выводе Tauri)
  const consoleFn =
    level === 'error'
      ? console.error
      : level === 'warn'
        ? console.warn
        : console.log
  consoleFn(`[${source}] ${message}`, details ?? '')

  try {
    const db = await getDb()
    await db.execute(
      `INSERT INTO logs (ts, level, source, message, details) VALUES ($1,$2,$3,$4,$5)`,
      [
        now(),
        level,
        source,
        message,
        details === undefined
          ? null
          : typeof details === 'string'
            ? details
            : JSON.stringify(details, replacer),
      ],
    )
  } catch (e) {
    console.error('Failed to write log to DB:', e)
  }
}

/** Приватный JSON-replacer: вырезаем огромные поля и обрабатываем Error. */
function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack }
  }
  if (typeof value === 'string' && value.length > 2000) {
    return value.slice(0, 2000) + '… (truncated)'
  }
  return value
}

export const log = {
  debug: (source: LogSource, message: string, details?: unknown) =>
    write('debug', source, message, details),
  info: (source: LogSource, message: string, details?: unknown) =>
    write('info', source, message, details),
  warn: (source: LogSource, message: string, details?: unknown) =>
    write('warn', source, message, details),
  error: (source: LogSource, message: string, details?: unknown) =>
    write('error', source, message, details),
}

export interface ListLogsFilter {
  level?: LogLevel | LogLevel[]
  source?: LogSource | LogSource[]
  /** Unix-секунды — вернёт только логи с ts >= since. */
  since?: number
  limit?: number
  offset?: number
}

export async function listLogs(filter: ListLogsFilter = {}): Promise<LogRow[]> {
  const db = await getDb()
  const where: string[] = []
  const params: unknown[] = []
  let n = 1

  if (filter.level) {
    const arr = Array.isArray(filter.level) ? filter.level : [filter.level]
    where.push(`level IN (${arr.map(() => `$${n++}`).join(', ')})`)
    params.push(...arr)
  }
  if (filter.source) {
    const arr = Array.isArray(filter.source) ? filter.source : [filter.source]
    where.push(`source IN (${arr.map(() => `$${n++}`).join(', ')})`)
    params.push(...arr)
  }
  if (typeof filter.since === 'number') {
    where.push(`ts >= $${n++}`)
    params.push(filter.since)
  }

  const limit = filter.limit ?? 200
  const offset = filter.offset ?? 0
  const sql = `
    SELECT id, ts, level, source, message, details
    FROM logs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ts DESC, id DESC
    LIMIT $${n++} OFFSET $${n}
  `
  params.push(limit, offset)
  return db.select<LogRow[]>(sql, params)
}

export async function clearLogs(): Promise<void> {
  const db = await getDb()
  await db.execute('DELETE FROM logs')
}

/** Удалить логи старше N дней (для самоочистки). */
export async function vacuumOldLogs(daysToKeep = 7): Promise<void> {
  const db = await getDb()
  const cutoff = now() - daysToKeep * 24 * 3600
  await db.execute('DELETE FROM logs WHERE ts < $1', [cutoff])
}

// ── Телеметрия: централизованный сбор error на mytoolbox ──────────────

/**
 * Выбрать unsent error-логи для отправки на сервер.
 *
 * Только level='error' — info/debug/warn оставляем локальными чтобы
 * не засорять сетевой трафик и хранилище. Сортировка по ts ASC чтобы
 * сначала отправить старые (FIFO порядок для админа на сервере).
 *
 * Лимит — батч-размер flusher'а (по умолчанию 50). Если ошибок
 * накопилось больше — flusher пройдёт несколько итераций.
 */
export async function listUnsentLogsForServer(limit = 50): Promise<LogRow[]> {
  const db = await getDb()
  return db.select<LogRow[]>(
    `SELECT id, ts, level, source, message, details, sent_to_server
     FROM logs
     WHERE sent_to_server = 0
       AND level IN ('error')
     ORDER BY ts ASC, id ASC
     LIMIT $1`,
    [limit],
  )
}

/**
 * Пометить логи как отправленные на сервер. Вызывается после успешного
 * POST /api/v1/telemetry/logs. Идемпотентно — повторный UPDATE на
 * sent_to_server=1 безопасен.
 */
export async function markLogsSentToServer(ids: number[]): Promise<void> {
  if (ids.length === 0) return
  const db = await getDb()
  // Параметризованные плейсхолдеры — защита от SQL-injection даже если
  // id'ы вдруг прилетят откуда-то снаружи.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
  await db.execute(
    `UPDATE logs SET sent_to_server = 1 WHERE id IN (${placeholders})`,
    ids,
  )
}
