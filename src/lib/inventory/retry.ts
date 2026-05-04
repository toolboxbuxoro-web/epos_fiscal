/**
 * Retry-логика для pending confirms.
 *
 * Если приложение упало / сеть отвалилась между EPOS success и /confirm —
 * запись остаётся со status='fiscal-ok'. На старте программы прогоняем
 * `retryFiscalOkPending()` и пытаемся подтвердить. Также можно вызывать
 * периодически (раз в N минут) на случай долгих сетевых проблем.
 *
 * Идемпотентность гарантируется сервером:
 *   - `/confirm` повторно для уже confirmed → возвращает ok без double-spend
 *   - для expired со свежим запасом → переводит в confirmed (фискальный
 *     чек уже в ОФД, мы знаем что списание было легитимным)
 */

import { log } from '@/lib/log'
import {
  deletePendingByReservations,
  listFiscalOk,
  listStaleReserved,
  markFailed,
  recordAttemptFailure,
} from './pending-confirms'
import { getInventoryClient } from './sync'

const STALE_RESERVED_TIMEOUT_SEC = 600 // 10 минут

/**
 * Пройтись по записям 'fiscal-ok' и попытаться отправить /confirm на сервер.
 * Удачные — DELETE'аем. Неудачные оставляем для следующего вызова.
 *
 * Возвращает количество подтверждённых.
 */
export async function retryFiscalOkPending(): Promise<{
  confirmed: number
  failed: number
}> {
  const client = await getInventoryClient()
  if (!client) return { confirmed: 0, failed: 0 }

  const pending = await listFiscalOk()
  if (pending.length === 0) return { confirmed: 0, failed: 0 }

  // Группируем по fiscal_sign — один чек = один fiscal_sign + N reservation_ids.
  // Сервер принимает массив reservation_ids в одном /confirm.
  const groups = new Map<string, string[]>()
  for (const row of pending) {
    if (!row.fiscal_sign) continue // не должно случиться, но защитимся
    const list = groups.get(row.fiscal_sign) ?? []
    list.push(row.reservation_id)
    groups.set(row.fiscal_sign, list)
  }

  let confirmed = 0
  let failed = 0
  for (const [fiscal_sign, reservation_ids] of groups.entries()) {
    try {
      const resp = await client.confirm({ reservation_ids, fiscal_sign })
      if (resp.ok) {
        await deletePendingByReservations(reservation_ids)
        confirmed += reservation_ids.length
        await log.info(
          'inventory.retry',
          `Confirmed ${reservation_ids.length} pending (fiscal=${fiscal_sign.slice(0, 8)}…)`,
        )
      } else {
        // ALREADY_RELEASED / EXPIRED_AND_INSUFFICIENT — записать в last_error
        // и оставить запись для разбора админом.
        for (const rid of reservation_ids) {
          await recordAttemptFailure(rid, `confirm code=${resp.code}`)
        }
        failed += reservation_ids.length
        await log.warn(
          'inventory.retry',
          `Confirm failed (code=${resp.code}) for ${reservation_ids.length} reservations`,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      for (const rid of reservation_ids) {
        await recordAttemptFailure(rid, msg)
      }
      failed += reservation_ids.length
      await log.warn('inventory.retry', `Confirm threw: ${msg}`)
    }
  }
  return { confirmed, failed }
}

/**
 * Пройтись по записям 'reserved' старше STALE_RESERVED_TIMEOUT_SEC.
 * Это значит «зарезервировали но EPOS даже не начал» — вероятно сбой,
 * освобождаем резерв чтобы товар вернулся в общий пул.
 *
 * NB: на сервере всё равно через 5 мин истечёт TTL, но мы это сделаем
 * раньше + явно (audit trail).
 */
export async function releaseStaleReserved(): Promise<{ released: number }> {
  const client = await getInventoryClient()
  if (!client) return { released: 0 }

  const stale = await listStaleReserved(STALE_RESERVED_TIMEOUT_SEC)
  if (stale.length === 0) return { released: 0 }

  let released = 0
  for (const row of stale) {
    try {
      await client.release({
        reservation_ids: row.reservation_id,
        reason: 'stale-on-client',
      })
      await markFailed(row.reservation_id, 'stale-on-client')
      released++
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await recordAttemptFailure(row.reservation_id, `release threw: ${msg}`)
    }
  }
  if (released > 0) {
    await log.info(
      'inventory.retry',
      `Released ${released} stale reservations on client startup`,
    )
  }
  return { released }
}

/**
 * Полный housekeeping pass — запускаем на старте приложения и можно по таймеру.
 * Не кидает ошибки наружу — все логируются.
 *
 * Порядок:
 *   1. syncShopConfig() — подтянуть МС-creds от админа (если remote вкл)
 *   2. retryFiscalOkPending() — догнать отвисшие confirm после рестарта
 *   3. releaseStaleReserved() — освободить зависшие 'reserved' (>10 мин)
 */
export async function runInventoryHousekeeping(): Promise<void> {
  // 1. Sync магазинной конфигурации (МС-creds от админа)
  try {
    const { syncShopConfig } = await import('./sync')
    await syncShopConfig()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `syncShopConfig: ${msg}`)
  }

  try {
    await retryFiscalOkPending()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `retryFiscalOkPending: ${msg}`)
  }
  try {
    await releaseStaleReserved()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `releaseStaleReserved: ${msg}`)
  }
}
