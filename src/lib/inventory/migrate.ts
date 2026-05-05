/**
 * Migration tool: локальные `esf_items` → общий пул на mytoolbox-сервере.
 *
 * Используется ОДНОКРАТНО магазинами которые до 0.9.x работали с локальной
 * SQLite (импортировали Excel вручную). После миграции они переезжают на
 * общий пул, дальнейшие приходы загружает бухгалтер через mytoolbox админку.
 *
 * Безопасность:
 *   - Серверный `bulkImport` дедупит по (org, class_code, name, received_at,
 *     source_doc) — повторный запуск не создаёт дубликаты
 *   - Если ту же позицию уже импортнул другой магазин, наш локальный
 *     `server_item_id` будет указывать на ИХ существующую строку — это OK,
 *     именно так multi-shop pool и должен работать
 *
 * Edge cases:
 *   - qty_consumed > 0 локально → отправляем `qty_received - qty_consumed`
 *     как новый qty_received, чтобы фактический available совпал
 *   - >5000 приходов → чанкуем по 1000
 *   - Сетевая ошибка в середине → уже мигрированные строки имеют
 *     server_item_id, продолжать можно с того же места
 */

import {
  countLocalUnmigrated,
  listLocalUnmigrated,
  setServerItemId,
  type EsfItemRow,
} from '@/lib/db'
import { log } from '@/lib/log'
import { loadInventoryConfig, syncFromServer } from './sync'

const CHUNK_SIZE = 1000

export interface MigrationProgress {
  total: number
  processed: number
  inserted: number
  skipped: number
  errors: number
}

export interface MigrationResult extends MigrationProgress {
  ok: boolean
  errorMessage?: string
}

/** Прелюдия для UI: показать счётчики до начала. */
export async function getMigrationStats(): Promise<{
  unmigratedCount: number
}> {
  const c = await countLocalUnmigrated()
  return { unmigratedCount: c }
}

/**
 * Главная функция. Вызывается из Catalog UI.
 *
 * onProgress (опц) — колбэк после каждого чанка для прогрессбара.
 *
 * Не throws — возвращает {ok: false, errorMessage} на любой сбой
 * (UI отрендерит как ошибку).
 */
export async function migrateLocalToServer(
  onProgress?: (p: MigrationProgress) => void,
): Promise<MigrationResult> {
  const cfg = await loadInventoryConfig()
  if (!cfg) {
    return {
      ok: false,
      total: 0,
      processed: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
      errorMessage:
        'Inventory сервер не сконфигурирован. Включите remote-режим и подключитесь в Настройках.',
    }
  }

  const items = await listLocalUnmigrated()
  if (items.length === 0) {
    return {
      ok: true,
      total: 0,
      processed: 0,
      inserted: 0,
      skipped: 0,
      errors: 0,
    }
  }

  await log.info('inventory.sync', `Starting migration: ${items.length} items`)

  const progress: MigrationProgress = {
    total: items.length,
    processed: 0,
    inserted: 0,
    skipped: 0,
    errors: 0,
  }
  onProgress?.(progress)

  // Чанкуем для устойчивости к сетевым обрывам.
  for (let i = 0; i < items.length; i += CHUNK_SIZE) {
    const chunk = items.slice(i, i + CHUNK_SIZE)
    const rows = chunk.map(localToMigrateRow)

    let response
    try {
      response = await postMigrate(cfg.serverUrl, cfg.apiKey, rows)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await log.warn('inventory.sync', `Migration chunk failed: ${msg}`)
      return {
        ok: false,
        ...progress,
        errorMessage: `Сетевая ошибка на ${i + 1}-м приходе: ${msg}. Уже перенесено: ${progress.processed}. Можно безопасно повторить миграцию.`,
      }
    }

    // Применяем results: для каждого inserted/skipped с id — UPDATE
    // локальной строки `server_item_id`.
    for (const r of response.results) {
      const local = chunk[r.index]
      if (!local) continue
      if ((r.status === 'inserted' || r.status === 'skipped') && r.id) {
        try {
          await setServerItemId(local.id, r.id)
          if (r.status === 'inserted') progress.inserted++
          else progress.skipped++
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          await log.warn(
            'inventory.sync',
            `Migration: failed to set server_item_id local=${local.id} server=${r.id}: ${msg}`,
          )
          progress.errors++
        }
      } else {
        progress.errors++
        await log.warn(
          'inventory.sync',
          `Migration: row ${local.name} (id=${local.id}) failed: ${r.reason ?? r.status}`,
        )
      }
      progress.processed++
    }
    onProgress?.(progress)
  }

  await log.info(
    'inventory.sync',
    `Migration done: ${progress.inserted} inserted, ${progress.skipped} skipped (already on server), ${progress.errors} errors`,
  )

  // После миграции — pull свежий снимок остатков с сервера, чтобы
  // qty_received локальных строк соответствовал серверной правде.
  try {
    await syncFromServer({ forceFull: true })
  } catch (e) {
    // не критично, при следующем периодическом sync догонит
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.sync', `post-migration sync failed: ${msg}`)
  }

  return { ok: true, ...progress }
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Конвертация локальной строки в формат серверного `bulkImport`.
 *
 * Ключевая логика: `qty_received` отправляем как (received - consumed),
 * чтобы фактический available на сервере совпал с локальным available
 * на момент миграции. Иначе сервер думал бы что есть полный qty_received
 * и магазин начинал бы перепродавать уже проданное.
 */
function localToMigrateRow(item: EsfItemRow): MigrateRow {
  const available = item.qty_received - item.qty_consumed
  return {
    name: item.name,
    class_code: item.class_code,
    package_code: item.package_code || null,
    vat_percent: item.vat_percent,
    unit_price_tiyin: item.unit_price_tiyin,
    qty_received: available, // ← фактический остаток
    received_at: new Date(item.received_at * 1000).toISOString(),
    source_doc: item.external_id || null,
    client_ref: item.id, // для маппинга обратно
  }
}

interface MigrateRow {
  name: string
  class_code: string
  package_code: string | null
  vat_percent: number
  unit_price_tiyin: number
  qty_received: number
  received_at: string
  source_doc: string | null
  client_ref: number
}

interface MigrateResponse {
  results: Array<{
    index: number
    status: 'inserted' | 'skipped' | 'error'
    id?: number
    reason?: string
    client_ref?: number | null
  }>
  summary: { inserted: number; skipped: number; errors: number }
}

async function postMigrate(
  serverUrl: string,
  apiKey: string,
  rows: MigrateRow[],
): Promise<MigrateResponse> {
  const { fetch } = await import('@tauri-apps/plugin-http')
  const res = await fetch(
    `${serverUrl.replace(/\/$/, '')}/api/v1/inventory/items/migrate`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ rows }),
    },
  )
  const text = await res.text()
  if (!res.ok) {
    const msg = (() => {
      try {
        const j = JSON.parse(text)
        return j.error ?? `HTTP ${res.status}`
      } catch {
        return `HTTP ${res.status}: ${text.slice(0, 200)}`
      }
    })()
    throw new Error(msg)
  }
  return JSON.parse(text) as MigrateResponse
}
