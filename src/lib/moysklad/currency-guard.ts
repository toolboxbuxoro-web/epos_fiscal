/**
 * Защита от чека в чужой валюте.
 *
 * ЗАЧЕМ. МойСклад отдаёт сумму документа в минорных единицах БАЗОВОЙ валюты
 * аккаунта. Пока база — сум, `rd.sum` это тийины, и касса права, считая их
 * тийинами. Владелец переводит учёт на аккаунт с базовой валютой доллар
 * (сентябрь 2026) — и те же поля начнут означать центы.
 *
 * Чек на 500 000 сум приедет числом ~4000. Дальше два исхода, и оба плохие:
 * либо касса откажется собирать чек (это ещё повезло), либо для товаров с
 * прописанным ИКПУ соберёт и отправит в ОФД заниженную сумму. Второе — уже
 * расхождение с налоговой, а не сбой в работе.
 *
 * ЧТО ДЕЛАЕМ. Не пересчитываем. Пересчёт по курсу дал бы третью сумму, не
 * совпадающую ни с кассой, ни с учётом, и спрятал бы проблему под правдоподобной
 * цифрой. Вместо этого чек в чужой валюте помечается и НЕ фискализируется:
 * кассир видит внятную причину, а не молча пробитый неверный чек.
 *
 * ПОКА БАЗА — СУМ, ЭТОТ МОДУЛЬ НИЧЕГО НЕ МЕНЯЕТ. Он только сверяет и молчит.
 */
import type { MoyskladClient } from './client'
import type { MsCurrency, MsRetailDemand } from './types'

/** Валюта, в которой касса умеет работать. Фискальный чек в Узбекистане обязан быть в сумах. */
export const EXPECTED_CURRENCY = 'UZS'

const TTL_MS = 60 * 60 * 1000

let cache: { at: number; base: string | null; byId: Map<string, string> } | null = null

/** Идентификатор валюты из ссылки вида .../entity/currency/<uuid>. */
export function currencyIdFromRef(ref?: { meta?: { href?: string } }): string | null {
  const href = ref?.meta?.href
  if (!href) return null
  const m = /currency\/([0-9a-f-]{36})/i.exec(href)
  return m?.[1] ?? null
}

/** Справочник валют аккаунта. Валют единицы, меняются почти никогда — держим час. */
export async function loadCurrencies(
  client: MoyskladClient,
  opts: { fresh?: boolean } = {},
): Promise<{ base: string | null; byId: Map<string, string> }> {
  if (!opts.fresh && cache && Date.now() - cache.at < TTL_MS) return cache

  const rows: MsCurrency[] = await client.listCurrencies()
  const byId = new Map<string, string>()
  let base: string | null = null
  for (const c of rows) {
    const iso = c.isoCode ? String(c.isoCode).toUpperCase() : null
    if (c.id && iso) byId.set(c.id, iso)
    if (c.default === true && iso) base = iso
  }
  cache = { at: Date.now(), base, byId }
  return cache
}

export function resetCurrencyCache(): void {
  cache = null
}

export interface CurrencyVerdict {
  /** Можно ли фискализировать этот чек. */
  ok: boolean
  /** Валюта документа, если удалось определить. */
  currency: string | null
  /** Базовая валюта аккаунта — в её минорных единицах приходит сумма. */
  base: string | null
  /** Причина отказа, понятная кассиру. */
  reason?: string
}

/**
 * Можно ли фискализировать чек.
 *
 * Осторожность в обе стороны: если валюту определить НЕ удалось (справочник
 * не ответил, ссылка непривычная), мы НЕ блокируем чек. Касса не должна
 * вставать из-за недоступности справочника — сегодня это означало бы
 * остановку торговли ради защиты от события, которое ещё не наступило.
 * Блокируем только когда точно знаем, что валюта чужая.
 */
export function verifyReceiptCurrency(
  rd: Pick<MsRetailDemand, 'rate'>,
  currencies: { base: string | null; byId: Map<string, string> },
): CurrencyVerdict {
  const { base, byId } = currencies

  // Базовая валюта аккаунта сменилась — суммы всех документов теперь в других
  // единицах, независимо от валюты конкретного чека.
  if (base && base !== EXPECTED_CURRENCY) {
    return {
      ok: false,
      currency: null,
      base,
      reason:
        `Учёт в МойСклад ведётся в ${base}, а фискальный чек должен быть в сумах. ` +
        `Суммы придут в других единицах — фискализация остановлена, обратитесь к администратору.`,
    }
  }

  const id = currencyIdFromRef(rd.rate?.currency)
  const iso = id ? byId.get(id) ?? null : null

  if (iso && iso !== EXPECTED_CURRENCY) {
    return {
      ok: false,
      currency: iso,
      base,
      reason: `Чек выписан в ${iso}. Фискальный чек оформляется только в сумах.`,
    }
  }

  return { ok: true, currency: iso ?? EXPECTED_CURRENCY, base }
}
