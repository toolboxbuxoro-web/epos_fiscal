/**
 * Синхронизация локального кэша `esf_items` с удалённым inventory server.
 *
 * Стратегия:
 *   - Bootstrap: при первом включении remote режима — full pull, заливаем
 *     ВСЕ серверные приходы как новые строки с `server_item_id`.
 *   - Incremental: GET /items?updated_since=<last_sync_ts> → upsert по
 *     `server_item_id` (UPDATE если есть, INSERT если новый).
 *   - Live: SSE-канал шлёт `inv.items.updated` с массивом обновлённых
 *     items → upsert тех же полей. Local cache всегда отражает свежие
 *     qty_consumed / qty_reserved (через server's available счёт).
 *
 * **Важно:** локально храним только qty_received с сервера, а qty_consumed
 * локально оставляем 0 (потому что списание идёт через сервер атомарно,
 * а не через локальный consumeEsfItem). Доступность определяется как:
 *   local_available = remote.available — то есть берём с сервера готовое
 *   значение через snapshot колонок qty_received - qty_consumed - qty_reserved.
 *
 * Чтобы matcher это понимал, держим в локальной строке:
 *   - qty_received = remote.available (а не remote.qty_received!)
 *   - qty_consumed = 0
 * Это маленький хак но он позволяет НЕ менять matcher — он сам
 * считает available = qty_received - qty_consumed = remote.available.
 *
 * При фискализации в remote-режиме НЕ вызываем `consumeEsfItem` локально
 * (см. fiscalize.ts dual-mode), вместо этого ждём SSE/refresh от сервера
 * чтобы увидеть новые qty_consumed/qty_reserved.
 */

import { getDb, now } from '@/lib/db/client'
import { getSetting, setSetting } from '@/lib/db/settings'
import { SettingKey } from '@/lib/db/types'
import { log } from '@/lib/log'
import { InventoryServerClient } from './server-client'
import type { RemoteInvItem } from './types'

/**
 * Прочитать конфиг из настроек. Если remote режим выключен или нет
 * url/key — возвращает null.
 */
export async function loadInventoryConfig(): Promise<{
  serverUrl: string
  apiKey: string
  shopSlug: string
} | null> {
  const enabled = (await getSetting(SettingKey.InventoryRemoteEnabled)) === 'true'
  if (!enabled) return null
  const serverUrl = await getSetting(SettingKey.InventoryServerUrl)
  const apiKey = await getSetting(SettingKey.InventoryShopApiKey)
  const shopSlug = (await getSetting(SettingKey.InventoryShopSlug)) ?? ''
  if (!serverUrl || !apiKey) return null
  return { serverUrl, apiKey, shopSlug }
}

/** Создать клиент или вернуть null если конфиг не валиден. */
export async function getInventoryClient(): Promise<InventoryServerClient | null> {
  const cfg = await loadInventoryConfig()
  if (!cfg) return null
  return new InventoryServerClient(cfg)
}

/**
 * Полная синхронизация: fetch всех приходов с сервера, upsert в локальный
 * кэш. На первом запуске в remote-режиме это full-import; на последующих —
 * delta через `updated_since`.
 *
 * Возвращает {synced, errors} для UI.
 */
export async function syncFromServer(opts: {
  forceFull?: boolean
} = {}): Promise<{ synced: number; errors: number }> {
  const client = await getInventoryClient()
  if (!client) return { synced: 0, errors: 0 }

  const lastSyncStr = opts.forceFull
    ? null
    : await getSetting(SettingKey.InventoryLastSyncTs)
  const since = lastSyncStr ? new Date(parseInt(lastSyncStr, 10) * 1000).toISOString() : undefined

  let synced = 0
  let errors = 0
  let offset = 0
  const limit = 1000

  // Запоминаем server_time от первого ответа — это будет наш cursor
  // для следующего delta-sync. Ставим до начала цикла, чтобы не пропустить
  // изменения произошедшие во время самого sync.
  let firstServerTime: string | null = null

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let resp
    try {
      resp = await client.listItems({
        updated_since: since,
        limit,
        offset,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await log.warn('inventory.sync', `listItems failed: ${msg}`)
      throw e
    }

    if (!firstServerTime) firstServerTime = resp.server_time
    if (resp.items.length === 0) break

    for (const remote of resp.items) {
      try {
        await upsertRemoteItem(remote)
        synced++
      } catch (e) {
        errors++
        const msg = e instanceof Error ? e.message : String(e)
        await log.warn(
          'inventory.sync',
          `upsert id=${remote.id} (${remote.name}): ${msg}`,
        )
      }
    }

    if (resp.items.length < limit) break
    offset += limit
  }

  if (firstServerTime) {
    // Стораджим как unix-сек чтобы согласовываться с другими timestamp'ами в БД.
    const epochSec = Math.floor(new Date(firstServerTime).getTime() / 1000)
    await setSetting(SettingKey.InventoryLastSyncTs, String(epochSec))
  }

  await log.info(
    'inventory.sync',
    `Sync complete: ${synced} items, ${errors} errors`,
  )
  return { synced, errors }
}

/**
 * Upsert одной серверной записи в локальный кэш.
 *
 * Маппинг:
 *   - server.qty_received → local.qty_received? Нет — мы пишем `available`
 *     как qty_received, а qty_consumed=0. Это позволяет существующему
 *     matcher'у работать без изменений (он считает available =
 *     qty_received − qty_consumed).
 *   - server.id → local.server_item_id (NEW колонка из миграции 003)
 *   - source = 'remote' (новый источник)
 */
export async function upsertRemoteItem(remote: RemoteInvItem): Promise<void> {
  const db = await getDb()
  const ts = now()
  const receivedAtSec = Math.floor(new Date(remote.received_at).getTime() / 1000)

  // Проверим — есть ли локальная строка по server_item_id?
  const existing = await db.select<Array<{ id: number }>>(
    `SELECT id FROM esf_items WHERE server_item_id = $1 LIMIT 1`,
    [remote.id],
  )

  if (existing.length > 0) {
    await db.execute(
      `UPDATE esf_items
         SET name = $1,
             class_code = $2,
             package_code = $3,
             vat_percent = $4,
             unit_price_tiyin = $5,
             qty_received = $6,
             qty_consumed = 0,
             received_at = $7,
             imported_at = $8
       WHERE server_item_id = $9`,
      [
        remote.name,
        remote.class_code,
        remote.package_code ?? '',
        remote.vat_percent,
        remote.unit_price_tiyin,
        remote.available, // ← qty_received локально = remote.available
        receivedAtSec,
        ts,
        remote.id,
      ],
    )
  } else {
    await db.execute(
      `INSERT INTO esf_items
         (source, external_id, name, barcode, class_code, package_code,
          vat_percent, owner_type, unit_price_tiyin, qty_received, qty_consumed,
          received_at, imported_at, notes, server_item_id)
       VALUES ('remote', NULL, $1, NULL, $2, $3, $4, 0, $5, $6, 0, $7, $8, NULL, $9)`,
      [
        remote.name,
        remote.class_code,
        remote.package_code ?? '',
        remote.vat_percent,
        remote.unit_price_tiyin,
        remote.available,
        receivedAtSec,
        ts,
        remote.id,
      ],
    )
  }
}

/**
 * Подтянуть конфиг магазина (МС-creds + точка продаж + кассир) с сервера
 * и записать в локальный SettingKey.* — те же поля, что юзер вводит в
 * Settings.tsx при ручной настройке.
 *
 * Вызывается:
 *   - На старте программы если remote-режим включён (App.tsx)
 *   - При нажатии «Применить настройки от админа» в Settings UI
 *   - Опционально по таймеру (раз в N минут) для подхвата новых creds
 *
 * Если магазин на сервере не сконфигурирован (нет МС-creds) — log.warn
 * и Settings остаются как были (null поля не пишем — UI Settings.tsx
 * сам покажет «нет привязки, обратитесь к админу»).
 */
export async function syncShopConfig(): Promise<{
  applied: boolean
  reason?: string
}> {
  const client = await getInventoryClient()
  if (!client) return { applied: false, reason: 'remote disabled' }

  let me
  try {
    me = await client.getShopMe()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.sync', `getShopMe failed: ${msg}`)
    return { applied: false, reason: msg }
  }

  // Если на сервере МС не привязан — не перетираем то что уже есть локально.
  // Кассир мог вручную настроить, ждём пока админ внесёт в админке.
  if (!me.moysklad.basic_credentials) {
    await log.warn(
      'inventory.sync',
      `Shop ${me.shop.slug} не имеет МС-привязки в админке — пропускаю sync creds`,
    )
    return { applied: false, reason: 'shop_not_configured_in_admin' }
  }

  const updates: Partial<Record<SettingKey, string>> = {
    [SettingKey.MoyskladCredentials]: me.moysklad.basic_credentials,
  }
  if (me.moysklad.login) updates[SettingKey.MoyskladLogin] = me.moysklad.login
  if (me.moysklad.retailstore_id)
    updates[SettingKey.MoyskladRetailStoreId] = me.moysklad.retailstore_id
  if (me.moysklad.retailstore_name)
    updates[SettingKey.MoyskladRetailStoreName] = me.moysklad.retailstore_name
  if (me.moysklad.employee_id)
    updates[SettingKey.MoyskladEmployeeId] = me.moysklad.employee_id
  if (me.moysklad.employee_name)
    updates[SettingKey.MoyskladEmployeeName] = me.moysklad.employee_name

  const db = await getDb()
  const ts = now()
  for (const [key, value] of Object.entries(updates)) {
    if (value == null) continue
    await db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, ts],
    )
  }

  await log.info(
    'inventory.sync',
    `Shop config synced from admin: shop=${me.shop.slug}, ms_login=${me.moysklad.login ?? '?'}, store=${me.moysklad.retailstore_name ?? '?'}`,
  )
  return { applied: true }
}

/**
 * Применить SSE-событие к локальному кэшу.
 * Сервер пушит `inv.items.updated` с массивом обновлённых записей.
 * Каждая запись содержит id, qty_received, qty_consumed, qty_reserved, available.
 *
 * В нашей модели local.qty_received хранит *available* — поэтому здесь
 * просто UPDATE qty_received = available для существующих server_item_id.
 */
export async function applyItemsUpdate(
  items: Array<{ id: number; available: number }>,
): Promise<void> {
  if (!Array.isArray(items) || items.length === 0) return
  const db = await getDb()
  const ts = now()
  for (const it of items) {
    try {
      await db.execute(
        `UPDATE esf_items
           SET qty_received = $1, qty_consumed = 0, imported_at = $2
         WHERE server_item_id = $3`,
        [it.available, ts, it.id],
      )
    } catch (e) {
      // не критично — если не нашли локальный server_item_id, просто скипнем.
      // На следующем `syncFromServer` догоним.
    }
  }
}
