/**
 * Оплата документа для экрана чека: сколько пробивать, как делить между
 * наличными и картой и можно ли пробивать вообще.
 *
 * Документ бывает двух видов:
 *   - отгрузка — оплата из связанных платежей и привязки счетов
 *     (см. `demand-payment.ts`);
 *   - старая розничная продажа — розницы больше нет, но в очереди могут
 *     остаться непробитые чеки. У них разбивка лежит прямо в документе.
 *
 * Модуль чистый: платежи дотягивает экран, сюда они приходят готовыми.
 * Все суммы в тийинах.
 */

import {
  fiscalPortion,
  idFromHref,
  paymentBlocker,
  resolveDemandPayment,
  toLinkedPayment,
  type AccountMapping,
  type DemandPayment,
  type LinkedPayment,
  type PaymentBlocker,
  type PaymentKind,
} from './demand-payment'
import type { MsDemand, MsPaymentDocument, MsRetailDemand, MsSaleDocument } from './types'

export type DocumentPaymentBlocker =
  | PaymentBlocker
  /** Отгрузку вывели из статуса «пробить», пока она ждала в очереди. */
  | { kind: 'state_changed' }
  /**
   * Оплачена не полностью. Пробить часть нельзя: отгрузка станет пробитой,
   * и доплату потом не пробить — защита от двойной фискализации не даст.
   */
  | { kind: 'underpaid'; paidTiyin: number; sumTiyin: number }
  /** Платежи не дотянулись из МойСклад — без них тип оплаты неизвестен. */
  | { kind: 'payments_unavailable'; message: string }

export interface DocumentPayment {
  source: 'demand' | 'retail'
  breakdown: DemandPayment
  /** Что пробиваем: сумма чека и её деление на наличные и карту. */
  portion: { targetTiyin: number; cashTiyin: number; cardTiyin: number }
  /**
   * Сколько из документа НЕ пробивается — Click и Payme. Ноль, если
   * пробивать нельзя: тогда сумма чека не посчитана.
   */
  excludedTiyin: number
  /** Сколько отгрузки не оплачено вовсе — показать кассиру. */
  unpaidTiyin: number
  blocker: DocumentPaymentBlocker | null
}

const EMPTY_BREAKDOWN: DemandPayment = {
  cashTiyin: 0,
  cardTiyin: 0,
  excludedTiyin: 0,
  unmapped: [],
  paidTiyin: 0,
}

/**
 * Привязка счетов из настроек кассы. Битый JSON или неожиданная форма —
 * пустая привязка: тогда любой входящий платёж окажется «неизвестным» и
 * чек заблокируется с понятной причиной, а не пробьётся наугад.
 */
export function parseAccountMapping(raw: string | null | undefined): AccountMapping {
  if (!raw) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
  const out: AccountMapping = {}
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    const type = typeof value === 'string' ? value : (value as { type?: unknown })?.type
    if (type !== 'cash' && type !== 'card' && type !== 'exclude') continue
    const label = (value as { label?: unknown })?.label
    out[id.toLowerCase()] = typeof label === 'string' && label ? { type: type as PaymentKind, label } : { type: type as PaymentKind }
  }
  return out
}

/**
 * Старая розничная продажа: наличные, карта и QR записаны в самом чеке.
 * QR считаем картой — так было и до перехода на отгрузки. Если все поля
 * пустые, как раньше, считаем чек наличным: розничный чек МС без оплаты
 * — это бонусы или скидка на всю сумму, и нулевые чеки опрос уже
 * отсекает.
 */
export function paymentFromRetail(doc: Pick<MsRetailDemand, 'sum' | 'cashSum' | 'noCashSum' | 'qrSum'>): DocumentPayment {
  let cash = Math.max(0, doc.cashSum ?? 0)
  const card = Math.max(0, (doc.noCashSum ?? 0) + (doc.qrSum ?? 0))
  if (cash + card === 0) cash = Math.max(0, doc.sum)
  const breakdown: DemandPayment = { ...EMPTY_BREAKDOWN, cashTiyin: cash, cardTiyin: card, paidTiyin: cash + card }
  const portion = fiscalPortion(breakdown, doc.sum)
  return {
    source: 'retail',
    breakdown,
    portion,
    excludedTiyin: Math.max(0, doc.sum - portion.targetTiyin),
    unpaidTiyin: Math.max(0, doc.sum - cash - card),
    blocker: null,
  }
}

/**
 * Отгрузка: разложить связанные платежи и решить, можно ли пробивать.
 *
 * Пробиваем только полностью оплаченную отгрузку. Частичную — нельзя: чек
 * на полученную часть пометил бы отгрузку пробитой, а доплату потом не дала
 * бы пробить защита от двойной фискализации, и эти деньги ушли бы мимо ОФД.
 * Оплатой считается всё пришедшее, включая Click и Payme: они мимо чека, но
 * это деньги.
 *
 * Порядок причин: сменился статус → счёт без привязки → нет платежей →
 * оплачено не всё. Первая мешает сильнее остальных.
 *
 * @param expectedStateId статус «пробить» из настроек кассы. Если отгрузку
 *   уже перевели в другой статус (передумали, отменили), пробивать её
 *   нельзя, даже если она ещё висит в очереди.
 */
export function paymentFromDemand(
  doc: Pick<MsDemand, 'id' | 'sum' | 'state'>,
  paymentDocs: MsPaymentDocument[],
  mapping: AccountMapping,
  expectedStateId: string | null,
): DocumentPayment {
  const linked = paymentDocs
    .map((p) => toLinkedPayment(p, doc.id))
    .filter((p): p is LinkedPayment => p !== null)
  const breakdown = resolveDemandPayment(linked, mapping)
  const unpaidTiyin = Math.max(0, doc.sum - breakdown.paidTiyin)

  const actualStateId = idFromHref(doc.state?.meta?.href)
  const stateChanged = !!expectedStateId && actualStateId !== expectedStateId.toLowerCase()
  const blocker: DocumentPaymentBlocker | null = stateChanged
    ? { kind: 'state_changed' }
    : paymentBlocker(breakdown) ??
      (unpaidTiyin > 0 ? { kind: 'underpaid', paidTiyin: breakdown.paidTiyin, sumTiyin: doc.sum } : null)

  if (blocker) {
    return {
      source: 'demand',
      breakdown,
      portion: { targetTiyin: 0, cashTiyin: 0, cardTiyin: 0 },
      excludedTiyin: 0,
      unpaidTiyin,
      blocker,
    }
  }
  const portion = fiscalPortion(breakdown, doc.sum)
  return {
    source: 'demand',
    breakdown,
    portion,
    excludedTiyin: Math.max(0, doc.sum - portion.targetTiyin),
    unpaidTiyin,
    blocker: null,
  }
}

/** Платежи не удалось получить — пробивать нельзя, но экран должен открыться. */
export function paymentUnavailable(doc: Pick<MsSaleDocument, 'sum'>, message: string): DocumentPayment {
  return {
    source: 'demand',
    breakdown: EMPTY_BREAKDOWN,
    portion: { targetTiyin: 0, cashTiyin: 0, cardTiyin: 0 },
    excludedTiyin: 0,
    unpaidTiyin: Math.max(0, doc.sum),
    blocker: { kind: 'payments_unavailable', message },
  }
}

/** Отгрузка это или старая розничная продажа — по типу в `meta`. */
export function isRetailDocument(doc: Pick<MsSaleDocument, 'meta'>): doc is MsRetailDemand {
  return doc.meta?.type === 'retaildemand'
}
