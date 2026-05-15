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

import { getDb } from '@/lib/db/client'
import { log } from '@/lib/log'
import {
  deletePendingByIds,
  deletePendingByReservations,
  listFiscalOk,
  listStaleReserved,
  listUnconsumePending,
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
 * Догнать отвисшие /unconsume после refund.
 *
 * Когда refund прошёл в ОФД но `/unconsume` на сервер не доставился
 * (endpoint не задеплоен / сеть) — `refund.ts` кладёт строки в
 * inv_pending_confirms с op_type='unconsume', ms_receipt_id=`refund-<id>`,
 * fiscal_sign = FiscalSign возврата. Здесь добиваем.
 *
 * Items реконструируем из локальной БД (источник правды для этого —
 * оригинальный продажный чек): fiscal_refunds → fiscal_receipts.match_id
 * → match_items → esf_items.server_item_id. То же что считал refund.ts,
 * но устойчиво к рестарту (не зависит от того что лежало в pending-строке).
 *
 * Идемпотентность: сервер дедупит по refund_fiscal_sign — повторный
 * вызов = no-op replay, поэтому слать безопасно даже если предыдущая
 * попытка на самом деле дошла но ответ потерялся.
 */
export async function retryUnconsumePending(): Promise<{
  unconsumed: number
  failed: number
}> {
  const client = await getInventoryClient()
  if (!client) return { unconsumed: 0, failed: 0 }

  const pending = await listUnconsumePending()
  if (pending.length === 0) return { unconsumed: 0, failed: 0 }

  // Группируем по refund (ms_receipt_id = `refund-<refundDbId>`).
  const byRefund = new Map<number, { rowIds: number[]; fiscalSign: string }>()
  for (const row of pending) {
    const m = /^refund-(\d+)$/.exec(row.ms_receipt_id)
    if (!m || !row.fiscal_sign) continue
    const refundDbId = parseInt(m[1]!, 10)
    const g = byRefund.get(refundDbId) ?? {
      rowIds: [],
      fiscalSign: row.fiscal_sign,
    }
    g.rowIds.push(row.id)
    byRefund.set(refundDbId, g)
  }

  const db = await getDb()
  let unconsumed = 0
  let failed = 0

  for (const [refundDbId, g] of byRefund.entries()) {
    try {
      // Реконструируем items из match_items оригинального чека.
      const items = await db.select<
        Array<{ inv_item_id: number; quantity: number }>
      >(
        `SELECT ei.server_item_id AS inv_item_id, mi.quantity AS quantity
           FROM fiscal_refunds fr
           JOIN fiscal_receipts orig ON orig.id = fr.original_fiscal_id
           JOIN match_items mi       ON mi.match_id = orig.match_id
           JOIN esf_items ei         ON ei.id = mi.esf_item_id
          WHERE fr.id = $1 AND ei.server_item_id IS NOT NULL`,
        [refundDbId],
      )
      if (items.length === 0) {
        // Нечего возвращать (legacy excel / нет match) — снимаем из очереди.
        await deletePendingByIds(g.rowIds)
        await log.info(
          'inventory.retry',
          `unconsume refund-${refundDbId}: 0 items (нет server_item_id), снято с очереди`,
        )
        continue
      }

      const resp = await client.unconsume({
        items,
        refund_fiscal_sign: g.fiscalSign,
        idempotency_key: `refund-${refundDbId}`,
      })

      if (resp.ok) {
        await deletePendingByIds(g.rowIds)
        unconsumed += g.rowIds.length
        await log.info(
          'inventory.retry',
          `unconsume OK refund-${refundDbId} (${items.length} позиций)` +
            (resp.code === 'ALREADY_UNCONSUMED' ? ' [replay]' : ''),
        )
      } else {
        failed += g.rowIds.length
        for (const id of g.rowIds) {
          // recordAttemptFailure ожидает reservation_id; у нас синтетический.
          // Пишем по нему — у unconsume-строк reservation_id уникален.
          await db
            .execute(
              `UPDATE inv_pending_confirms
                 SET attempts = attempts + 1, last_error = $1, updated_at = $2
               WHERE id = $3`,
              [`unconsume code=${resp.code}`, Math.floor(Date.now() / 1000), id],
            )
            .catch(() => {})
        }
        await log.warn(
          'inventory.retry',
          `unconsume refund-${refundDbId} failed code=${resp.code}`,
        )
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      failed += g.rowIds.length
      // 404 = endpoint всё ещё не задеплоен на сервере. Не спамим error —
      // это ожидаемо пока backend не выкатили. info-уровень.
      const notDeployed =
        msg.includes('404') || (e as { status?: number }).status === 404
      await log[notDeployed ? 'info' : 'warn'](
        'inventory.retry',
        `unconsume refund-${refundDbId} ${notDeployed ? 'endpoint не задеплоен (404), оставляю в очереди' : `threw: ${msg}`}`,
      )
    }
  }

  return { unconsumed, failed }
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
    await retryUnconsumePending()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `retryUnconsumePending: ${msg}`)
  }
  try {
    await releaseStaleReserved()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.housekeeping', `releaseStaleReserved: ${msg}`)
  }
}
