import { getDb, now } from '@/lib/db'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export type LogSource =
  | 'app'
  | 'poller'
  | 'moysklad'
  | 'epos'
  | 'matcher'
  | 'fiscalize'
  | 'updater'
  | 'ui'

export interface LogRow {
  id: number
  ts: number
  level: LogLevel
  source: LogSource
  message: string
  details: string | null
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
