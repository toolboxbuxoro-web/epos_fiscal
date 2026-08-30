/**
 * Чек без МойСклад — фискализация по введённой сумме.
 *
 * Магазин не всегда продаёт через МС: продажа мимо кассовой программы,
 * МС недоступен, разовая сделка. Чек при этом пробить всё равно надо.
 * Этот режим даёт кассиру ввести сумму, а подбор товаров идёт по тем же
 * правилам, что и обычно: холистический план на сумму, минимальная
 * наценка, партии не смешиваются, ИКПУ обязателен.
 *
 * Ключевое решение — **синтетический чек МС**. Вместо отдельной ветки в
 * фискализации мы собираем `MsRetailDemand`, который выглядит как
 * настоящий, но без позиций. Дальше всё идёт общим путём: `fiscalize()`,
 * печать, история, возвраты, выгрузка продаж на сервер — ни одно из них
 * не знает, что чека в МС не было, и не требует правок.
 *
 * Почему не «просто передать сумму в fiscalize»: `BuildMatchResult`
 * завязан на `receipt`, а `persistMatch` пишет строку в `ms_receipts` и
 * ссылается на неё из `fiscal_receipts`. Синтетический чек закрывает обе
 * связи и сохраняет инвариант «у каждого фискального чека есть источник».
 */

import type { MsRetailDemand } from '@/lib/moysklad'
import type { BuildMatchResult, HolisticPlan } from '@/lib/matcher/types'

/**
 * Префикс идентификатора синтетического чека.
 *
 * По нему в истории и в выгрузке на сервер видно, что чек пробит без МС —
 * иначе бухгалтер при сверке искал бы в МойСклад документ, которого там
 * никогда не было.
 */
export const FREE_RECEIPT_PREFIX = 'free-'

/** Пробит ли чек в режиме «без МС» (по идентификатору источника). */
export function isFreeReceipt(msId: string | null | undefined): boolean {
  return typeof msId === 'string' && msId.startsWith(FREE_RECEIPT_PREFIX)
}

export interface FreeReceiptPayment {
  /** Наличными, тийины. */
  cashTiyin: number
  /** Картой, тийины. */
  cardTiyin: number
}

/**
 * Собрать синтетический чек МС на заданную сумму.
 *
 * `nowMs` и `uid` передаются снаружи, а не берутся из `Date.now()`, чтобы
 * функция оставалась чистой и проверяемой: тест задаёт их явно и получает
 * предсказуемый идентификатор.
 */
export function buildSyntheticMsReceipt(input: {
  sumTiyin: number
  payment: FreeReceiptPayment
  nowMs: number
  uid: string
}): MsRetailDemand {
  const { sumTiyin, payment, nowMs, uid } = input
  const moment = formatMsMoment(new Date(nowMs))

  return {
    // meta с типом retaildemand — вниз по потоку никто не ходит по ссылке,
    // но форма должна совпадать с настоящей, иначе типы разъезжаются.
    meta: {
      href: '',
      type: 'retaildemand',
      mediaType: 'application/json',
    },
    id: `${FREE_RECEIPT_PREFIX}${uid}`,
    accountId: '',
    updated: moment,
    // Имя видит кассир в истории и бухгалтер в админке — оно должно сразу
    // объяснять, почему документа нет в МойСклад.
    name: `Без МС ${formatHumanStamp(new Date(nowMs))}`,
    moment,
    applicable: true,
    printed: false,
    published: false,
    rate: { currency: { meta: { href: '', type: 'currency', mediaType: 'application/json' } } },
    sum: sumTiyin,
    vatSum: 0,
    vatEnabled: true,
    vatIncluded: true,
    // Раскладка оплаты — источник правды для determinePaymentFromMs и для
    // колонки «Оплата» в истории. Заполняем тем, что выбрал кассир.
    cashSum: payment.cashTiyin,
    noCashSum: payment.cardTiyin,
    qrSum: 0,
    retailShift: { meta: { href: '', type: 'retailshift', mediaType: 'application/json' } },
    retailStore: { meta: { href: '', type: 'retailstore', mediaType: 'application/json' } },
    organization: { meta: { href: '', type: 'organization', mediaType: 'application/json' } },
    agent: { meta: { href: '', type: 'counterparty', mediaType: 'application/json' } },
    // Позиций нет намеренно: подбор идёт целиком от суммы (planHolistic),
    // и «оригинала» для сравнения в этом режиме не существует. Пустой rows,
    // а не отсутствующее поле — `extractPositions` тогда честно вернёт [].
    positions: {
      meta: { href: '', type: 'retaildemandposition', mediaType: 'application/json' },
      rows: [],
    },
  }
}

/**
 * Обернуть готовый план подбора в `BuildMatchResult` — то, что ждёт
 * `fiscalize()`.
 *
 * Режим всегда `holistic`: фискальные строки берутся из плана, а
 * `positions` пуст, потому что сравнивать не с чем — покупатель не
 * приносил список товаров, он назвал сумму.
 */
export function buildFreeMatchResult(
  receipt: MsRetailDemand,
  plan: HolisticPlan,
): BuildMatchResult {
  return {
    receipt,
    positions: [],
    overallStrategy: 'price-bucket',
    totalDiffTiyin: plan.totalTiyin - receipt.sum,
    originalTotalTiyin: receipt.sum,
    matchedTotalTiyin: plan.totalTiyin,
    // Всегда требуем подтверждения кассира: сумму он ввёл руками, и
    // молча отправить такой чек в ОФД нельзя.
    canAutoFiscalize: false,
    mode: 'holistic',
    holistic: plan,
    warnings: plan.notes,
  }
}

/** Формат даты МойСклад: `YYYY-MM-DD HH:MM:SS.SSS`. */
function formatMsMoment(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
    `${p(d.getMilliseconds(), 3)}`
  )
}

/** Человекочитаемая метка для имени чека: `28.08 14:05`. */
function formatHumanStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`
}
