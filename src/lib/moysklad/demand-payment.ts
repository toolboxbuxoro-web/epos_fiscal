/**
 * Оплата отгрузки: сколько пришло наличными, сколько картой и сколько мимо
 * ОФД (Click, Payme).
 *
 * У розничной продажи МойСклад сам делил сумму на `cashSum` / `noCashSum` /
 * `qrSum`. У отгрузки такой разбивки нет: деньги — это связанные документы.
 *
 *   - Приходный ордер (`cashin`) — всегда наличные.
 *   - Входящий платёж (`paymentin`) — тип зависит от расчётного счёта, на
 *     который пришли деньги. Какой счёт что означает, настраивают один раз:
 *     «счёт терминала Uzcard → карта», «счёт Click → не пробивать».
 *
 * Модуль чистый: не ходит в сеть и не трогает базу. Платежи дотягивает
 * экран чека, здесь только арифметика и правила — чтобы их можно было
 * проверить тестами на граничных случаях.
 *
 * Все суммы в тийинах.
 */

import type { MsPaymentDocument } from './types'

/** Как считать поступление на расчётный счёт. */
export type PaymentKind = 'cash' | 'card' | 'exclude'

export interface AccountBinding {
  type: PaymentKind
  /** Номер счёта и банк — только для показа людям. */
  label?: string
}

/** Привязка счетов: { id расчётного счёта: тип оплаты }. */
export type AccountMapping = Record<string, AccountBinding>

/** Платёж в том виде, в каком он нужен для расчёта одной отгрузки. */
export interface LinkedPayment {
  kind: 'cashin' | 'paymentin'
  id: string
  name: string | null
  /** Сколько из этого платежа пришлось именно на эту отгрузку. */
  amountTiyin: number
  /** Расчётный счёт юрлица. У приходного ордера его нет. */
  accountId: string | null
}

export interface UnmappedPayment {
  id: string
  name: string | null
  accountId: string | null
  amountTiyin: number
}

export interface DemandPayment {
  cashTiyin: number
  cardTiyin: number
  /** Click, Payme и прочее, что в ОФД не идёт. */
  excludedTiyin: number
  /** Поступления на счета без привязки: тип неизвестен, пробивать нельзя. */
  unmapped: UnmappedPayment[]
  /** Всё, что пришло по связанным платежам, включая неизвестные. */
  paidTiyin: number
}

/** Причина, по которой чек пробивать нельзя. */
export type PaymentBlocker =
  | { kind: 'no_payments' }
  | { kind: 'unmapped'; payments: UnmappedPayment[] }

/**
 * Последний сегмент ссылки МойСклад без параметров:
 * `…/organization/X/accounts/Y?expand=…` → `Y`.
 */
export function idFromHref(href: string | undefined | null): string | null {
  if (!href) return null
  const path = (href.split('?')[0] ?? '').replace(/\/+$/, '')
  const last = path.slice(path.lastIndexOf('/') + 1)
  return last ? last.toLowerCase() : null
}

/**
 * Превратить платёж МойСклад в поступление по конкретной отгрузке.
 *
 * Сумма — `linkedSum` из `operations` напротив этой отгрузки: один платёж
 * часто закрывает несколько документов сразу, и `sum` платежа отнёс бы
 * чужие деньги к нашему чеку. Если строки про отгрузку нет (так бывает у
 * платежа, привязанного через «Связанные документы» без распределения),
 * берём сумму платежа целиком.
 *
 * Непроведённый платёж — черновик, денег по нему ещё нет. Такие
 * пропускаем: иначе чек пробился бы на сумму, которую никто не получал.
 * Прочие документы (расходный ордер, исходящий платёж) к оплате
 * отгрузки не относятся — тоже пропускаем.
 */
export function toLinkedPayment(doc: MsPaymentDocument, demandId: string): LinkedPayment | null {
  const kind = doc.meta?.type
  if (kind !== 'cashin' && kind !== 'paymentin') return null
  if (doc.applicable === false) return null

  const target = demandId.toLowerCase()
  const op = doc.operations?.find((o) => idFromHref(o.meta?.href) === target)
  const raw = op && typeof op.linkedSum === 'number' ? op.linkedSum : doc.sum
  return {
    kind,
    id: doc.id,
    name: doc.name ?? null,
    // МойСклад изредка отдаёт отрицательные копейки (артефакт округления) —
    // фискальные бэкенды на них падают, поэтому режем в ноль.
    amountTiyin: Math.max(0, Math.round(raw || 0)),
    accountId: kind === 'paymentin' ? idFromHref(doc.organizationAccount?.meta?.href) : null,
  }
}

/** Разложить поступления по типам оплаты. */
export function resolveDemandPayment(payments: LinkedPayment[], mapping: AccountMapping): DemandPayment {
  const out: DemandPayment = { cashTiyin: 0, cardTiyin: 0, excludedTiyin: 0, unmapped: [], paidTiyin: 0 }
  for (const p of payments) {
    const amount = Math.max(0, Math.round(p.amountTiyin || 0))
    out.paidTiyin += amount
    if (p.kind === 'cashin') {
      out.cashTiyin += amount
      continue
    }
    const binding = p.accountId ? mapping[p.accountId.toLowerCase()] : undefined
    if (!binding) {
      out.unmapped.push({ id: p.id, name: p.name, accountId: p.accountId, amountTiyin: amount })
      continue
    }
    if (binding.type === 'cash') out.cashTiyin += amount
    else if (binding.type === 'card') out.cardTiyin += amount
    else out.excludedTiyin += amount
  }
  return out
}

/**
 * Можно ли пробивать чек по этой оплате.
 *
 * Неизвестный счёт важнее отсутствия платежей: если деньги пришли, но мы не
 * знаем, наличные это или карта, угадывать нельзя — в ОФД уйдёт неверный
 * тип оплаты.
 */
export function paymentBlocker(p: DemandPayment): PaymentBlocker | null {
  if (p.unmapped.length > 0) return { kind: 'unmapped', payments: p.unmapped }
  if (p.paidTiyin <= 0) return { kind: 'no_payments' }
  return null
}

/**
 * Какую часть отгрузки пробивать и как её делить.
 *
 * Чек — это деньги, полученные наличными и картой. Click и Payme в него не
 * входят, неоплаченный остаток отгрузки тоже. Поэтому сумма чека — это
 * наличные плюс карта, но не больше суммы отгрузки: переплату (аванс,
 * платёж с запасом) пробивать нечем, товаров на неё нет.
 *
 * Если платежей больше суммы отгрузки, наличные и карту уменьшаем
 * пропорционально, чтобы их доли сохранились. Остаток округления уходит в
 * карту — так части всегда сходятся с суммой тийин в тийин.
 */
export function fiscalPortion(
  p: Pick<DemandPayment, 'cashTiyin' | 'cardTiyin'>,
  documentSumTiyin: number,
): { targetTiyin: number; cashTiyin: number; cardTiyin: number } {
  const cash = Math.max(0, Math.round(p.cashTiyin))
  const card = Math.max(0, Math.round(p.cardTiyin))
  const docSum = Math.max(0, Math.round(documentSumTiyin))
  const paid = cash + card
  if (paid <= docSum) return { targetTiyin: paid, cashTiyin: cash, cardTiyin: card }
  if (docSum === 0) return { targetTiyin: 0, cashTiyin: 0, cardTiyin: 0 }
  const scaledCash = Math.min(docSum, Math.round((docSum * cash) / paid))
  return { targetTiyin: docSum, cashTiyin: scaledCash, cardTiyin: docSum - scaledCash }
}
