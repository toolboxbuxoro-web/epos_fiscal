/**
 * Настройки магазина → опции подбора.
 *
 * Вынесено отдельно, потому что подбор запускается уже из двух мест: обычной
 * кассы (чек из МойСклад) и чека по сумме (без МС). Правила ценообразования —
 * наценка, шаг округления, ставка НДС, допуск, режим подбора — должны быть у
 * них одни и те же. Держать два чтения настроек рядом значит однажды поправить
 * одно и забыть другое: чеки начнут собираться по-разному, и заметят это по
 * расхождению в отчётах, а не сразу.
 *
 * Ситуативные поля (`targetSumOverrideTiyin`, `excludeServerItemIds`) сюда не
 * входят — они зависят не от настроек, а от конкретного чека, и добавляются
 * вызывающим.
 */

import { getSetting, SettingKey } from '@/lib/db'
import type { MatcherOptions } from './types'

/**
 * Допуск подбора по умолчанию — 5000 сум.
 *
 * Было 1000: при округлении цен до 1000 и небогатом складе жёсткий допуск
 * почти не давал совпадений. В чек всё равно пишется сумма, которую заплатил
 * покупатель, поэтому расширение безопасно.
 */
export const DEFAULT_TOLERANCE_TIYIN = 500_000

/** Наценка по умолчанию, %. */
export const DEFAULT_MARKUP_PERCENT = 10

/** Шаг округления продажной цены по умолчанию, сум. */
export const DEFAULT_ROUND_UP_TO_SUM = 1000

/** Максимальная скидка на позицию при выравнивании суммы, сум. */
export const DEFAULT_MAX_DISCOUNT_PER_ITEM_SUM = 2000

/**
 * Ставка НДС по умолчанию — общий режим РУз.
 *
 * Переписывает ставку каждого прихода: `vat_percent` в ЭСФ — это ставка
 * ПОСТАВЩИКА (упрощенцы шлют 0%), а продаём мы по своей.
 */
export const DEFAULT_VAT_PERCENT = 12

/**
 * Потолок штук одного товара в строке чека.
 *
 * Без него подбор выедал дешёвые приходы лавиной: доходило до 560 штук
 * анкера в одном чеке, и склад за месяц остался без недорогих позиций,
 * которыми набираются мелкие суммы.
 */
export const DEFAULT_MAX_QTY_PER_LINE = 20

/** Имя характеристики МС для связки модификации с приходом. */
export const DEFAULT_LINK_CHARACTERISTIC = 'Бухгалтерское наименование'

/** Прочитать целое из настройки, вернув запасное значение для пустой/битой. */
async function intSetting(key: SettingKey, fallback: number): Promise<number> {
  const raw = await getSetting(key)
  if (raw == null || raw === '') return fallback
  return Number.parseInt(raw, 10) || 0
}

export async function loadMatcherOptionsFromSettings(): Promise<MatcherOptions> {
  const [tolerance, markupPercent, roundUpToSum, maxDiscountSum, defaultVatPercent] =
    await Promise.all([
      intSetting(SettingKey.MatchToleranceTiyin, DEFAULT_TOLERANCE_TIYIN),
      intSetting(SettingKey.MarkupPercent, DEFAULT_MARKUP_PERCENT),
      intSetting(SettingKey.RoundUpToSum, DEFAULT_ROUND_UP_TO_SUM),
      intSetting(SettingKey.MaxDiscountPerItemSum, DEFAULT_MAX_DISCOUNT_PER_ITEM_SUM),
      intSetting(SettingKey.DefaultVatPercent, DEFAULT_VAT_PERCENT),
    ])

  // Скидка для точной суммы включена по умолчанию. Сравнение с null важно:
  // у никогда не сохранённой настройки `null === 'true'` даёт false, и
  // выравнивание молча выключалось бы.
  const discRaw = await getSetting(SettingKey.DiscountForExactSum)
  const discountForExactSum = discRaw == null ? true : discRaw === 'true'

  const linkCharRaw = await getSetting(SettingKey.MsLinkCharacteristicName)
  const linkCharacteristicName =
    linkCharRaw && linkCharRaw.trim() ? linkCharRaw.trim() : DEFAULT_LINK_CHARACTERISTIC

  // Ноль или мусор в настройке означал бы «ни одной штуки в строке» и
  // остановил бы подбор целиком — трактуем как «без ограничения».
  const rawQty = await intSetting(SettingKey.MaxQtyPerLine, DEFAULT_MAX_QTY_PER_LINE)
  const maxQtyPerLine = rawQty > 0 ? rawQty : Number.POSITIVE_INFINITY

  const modeRaw = await getSetting(SettingKey.MatcherMode)
  const matcherMode =
    modeRaw === 'classic' || modeRaw === 'holistic' || modeRaw === 'off' ? modeRaw : 'auto'

  return {
    toleranceTiyin: tolerance,
    markupPercent,
    roundUpToSum,
    discountForExactSum,
    maxDiscountPerItemTiyin: maxDiscountSum * 100,
    linkCharacteristicName,
    defaultVatPercent,
    matcherMode,
    maxQtyPerLine,
  }
}
