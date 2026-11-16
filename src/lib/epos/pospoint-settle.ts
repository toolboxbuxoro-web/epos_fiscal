/**
 * Разобрать одну попытку Pospoint с неизвестным исходом — по кнопке кассира
 * или администратора; фоновая проверка делает то же раз в 10 минут.
 *
 *   - пробита — сохраняем её из журнала (план и оплата той попытки, без
 *     печати: покупатель, скорее всего, ушёл);
 *   - точно не пробита — снимаем запись;
 *   - ФМ мог подписать чек мимо Pospoint — оставляем до сверки человеком;
 *   - касса не ответила — ничего не меняем.
 */

import { AlreadyFiscalizedError, completePospointSale } from './fiscalize'
import { clearPendingAttempt, getPendingAttempt, getPospointClient } from './pospoint'
import type { PospointReceiptAnswer } from './pospoint-client'
import { completePospointRefund, RefundAlreadyExistsError } from './refund'

export type SettleResult =
  | { status: 'none' }
  | { status: 'saved'; fiscalSign: string }
  | { status: 'cleared' }
  /** ФМ мог подписать мимо Pospoint — снимать только после сверки. */
  | { status: 'blocked' }
  /** Касса не ответила на поиск — разберём позже. */
  | { status: 'unknown' }
  /** Пробита, но сохранить не удалось — запись остаётся. */
  | { status: 'failed'; fiscalSign: string; error: string }

export async function settlePendingAttempt(
  payCheckNumber: string,
  opts: { background?: boolean } = {},
): Promise<SettleResult> {
  const pending = await getPendingAttempt(payCheckNumber)
  if (!pending) return { status: 'none' }
  const client = await getPospointClient({ background: opts.background })
  let found: PospointReceiptAnswer | null
  try {
    found = await client.getReceiptByPayCheckNumber(payCheckNumber)
  } catch {
    return { status: 'unknown' }
  }
  if (found) {
    const fiscalSign = found.fiscalSign ?? ''
    try {
      const r =
        pending.kind === 'sale' ? await completePospointSale(payCheckNumber) : await completePospointRefund(payCheckNumber)
      return r ? { status: 'saved', fiscalSign } : { status: 'failed', fiscalSign, error: 'в журнале нет данных попытки' }
    } catch (e) {
      const savedSign =
        e instanceof AlreadyFiscalizedError
          ? e.fiscalSign
          : e instanceof RefundAlreadyExistsError
            ? e.existing.fiscal_sign
            : null
      // Этот самый чек уже сохранён — запись больше не нужна.
      if (savedSign !== null && savedSign === fiscalSign) {
        await clearPendingAttempt(payCheckNumber)
        return { status: 'saved', fiscalSign }
      }
      return { status: 'failed', fiscalSign, error: e instanceof Error ? e.message : String(e) }
    }
  }
  if (pending.fmMaySigned) return { status: 'blocked' }
  await clearPendingAttempt(payCheckNumber)
  return { status: 'cleared' }
}

/** Понятный кассиру итог разбора. */
export function describeSettleResult(r: SettleResult): string {
  switch (r.status) {
    case 'none':
      return 'Попытка уже разобрана.'
    case 'saved':
      return `Касса успела пробить этот чек (признак ${r.fiscalSign}) — он сохранён в программе.`
    case 'cleared':
      return 'Касса этот чек не пробила — попытка снята, можно пробивать заново.'
    case 'blocked':
      return 'Фискальный модуль мог подписать чек без записи в Pospoint. Сверьте последний чек в Pospoint и в кабинете soliq.uz, затем снимите попытку в Настройки → Pospoint.'
    case 'unknown':
      return 'Pospoint не ответил — проверить не удалось. Повторите позже.'
    case 'failed':
      return `Касса пробила чек (признак ${r.fiscalSign}), но сохранить его не удалось: ${r.error}`
  }
}
