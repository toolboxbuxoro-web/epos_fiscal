import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Check,
  ChevronLeft,
  ChevronRight,
  CreditCard,
  QrCode,
  Send,
  SplitSquareHorizontal,
  TriangleAlert,
} from 'lucide-react'
import {
  getDb,
  getFiscalReceiptByMsId,
  getMsReceipt,
  getSetting,
  setMsReceiptStatus,
  SettingKey,
  now,
} from '@/lib/db'
import type { FiscalReceiptRow, MsReceiptRow } from '@/lib/db/types'
import {
  buildMatch,
  extractPositions,
  loadMatcherPool,
  recalculateAfterSwap,
  type BuildMatchResult,
} from '@/lib/matcher'
import type { HolisticPlan, MatcherOptions } from '@/lib/matcher/types'
import { ManualReceiptModal } from './Receipt/ManualReceiptModal'
import {
  fiscalize,
  AlreadyFiscalizedError,
  InventoryConflictError,
  InventoryStaleError,
  ShiftNotOpenError,
} from '@/lib/epos'
import { syncFromServer } from '@/lib/inventory'
import {
  MoyskladClient,
  enrichWithVariants,
  getCachedVariants,
  inlinePositions,
  type MsRetailDemand,
} from '@/lib/moysklad'
import { log } from '@/lib/log'
import { formatErrorForUser } from '@/lib/error-message'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  toast,
} from '@/components/ui'
import {
  formatDateTime,
  milliQtyToDisplay,
  tiyinToSumDisplay,
  tiyinToSumDisplayPrecise,
} from '@/lib/format'
import { cn } from '@/lib/cn'

export default function Receipt() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()

  const [receipt, setReceipt] = useState<MsReceiptRow | null>(null)
  const [match, setMatch] = useState<BuildMatchResult | null>(null)
  // Сохраняем опции последнего вызова buildMatch — нужны при swap
  // (recalculateAfterSwap вызывает distribute с теми же лимитами).
  const [matcherOpts, setMatcherOpts] = useState<MatcherOptions>({})
  // Открыта ли модалка ручной сборки чека целиком. Пул товаров модалка
  // грузит сама на open (свежий снимок), чтобы не работать со stale-данными.
  const [manualModalOpen, setManualModalOpen] = useState(false)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fiscalizing, setFiscalizing] = useState(false)
  const [testMode, setTestMode] = useState(false)
  /**
   * Если этот ms_receipt УЖЕ фискализирован — храним фискальный чек.
   * Блокирует повторную фискализацию (двойной чек в ОФД = двойное
   * списание + дубль в ГНК). Кассир приходит сюда из Чеков → внутрь.
   */
  const [alreadyFiscalized, setAlreadyFiscalized] =
    useState<FiscalReceiptRow | null>(null)
  /** Communicator сказал «смена не открыта» — баннер с кнопкой в /zreport. */
  const [shiftNotOpen, setShiftNotOpen] = useState(false)
  /**
   * Счётчик подряд-stale-ошибок сервера. 1-я → тихий sync+rebuild;
   * 2-я+ → показываем persistent карточку с подсказкой «Собрать вручную»,
   * потому что авто-подбор зацикливается на распроданных товарах
   * (сервер возвращает inv_items_check каждый раз → мы синкаем →
   * matcher снова берёт те же товары → снова inv_items_check).
   * Без этого кассир жал бы «Фискализировать» и видел один и тот же
   * тост бесконечно. Используем ref чтобы не пересоздавать обработчик.
   */
  const staleErrorCountRef = useRef(0)
  const [staleErrorPersistent, setStaleErrorPersistent] = useState(false)
  /**
   * Debounce stale-toast: метка времени последнего показанного тоста (ms).
   * Если в течение 5 сек прилетел второй stale — НЕ показываем второй
   * toast (только инкрементим счётчик). Без этого busy-shop в race-heavy
   * момент засыпал бы кассира одинаковыми сообщениями.
   *
   * 5 сек — компромисс: достаточно чтобы кассир увидел первый toast и
   * понял что происходит, но недостаточно чтобы пропустить новую вспышку
   * stale через минуту (после следующего sync).
   */
  const lastStaleToastTsRef = useRef(0)
  /**
   * server_item_id'ы которые сервер отказал на reserve (другой магазин
   * успел забрать). При rematch matcher их игнорирует — иначе сразу
   * предложил бы те же товары и снова получил 409.
   */
  const excludedServerIdsRef = useRef<number[]>([])
  /**
   * Открыта ли модалка «Karta turi». Появляется при клике «Фискализировать»
   * когда оплата картой/QR/mixed (cardSum > 0). Кассир выбирает «Jismoniy
   * shaxs» / «Korporativ» — этот выбор печатается на ленте (в ОФД не идёт).
   *
   * Модалка показывается ОДИН раз за сессию открытия чека. После выбора
   * doFiscalize() запускается с переданным cardKind.
   */
  const [cardKindModal, setCardKindModal] = useState(false)
  /**
   * Сумма (тийины) которую кассир пометил как Click/Payme — НЕ фискализируется.
   *
   * Эффективный фискальный target = rd.sum − excludeTiyin. Поле редактируется
   * в мини-карточке над сравнительными колонками; при изменении matcher
   * перезапускается (debounced 400ms) и пересобирает план на новую сумму.
   *
   * Default = 0 — поведение идентично текущему (фискализируется вся ms_sum).
   * Если excludeTiyin = rd.sum (или больше) — фискализировать нечего, кнопка
   * «Фискализировать» меняется на «Отметить как не фискальный».
   */
  const [excludeTiyin, setExcludeTiyin] = useState(0)
  /**
   * Текстовый ввод поля «Сумма через Click/Payme» (в сумах, для UX).
   * Хранится отдельно от excludeTiyin чтобы пользователь мог печатать
   * частично («10», «100», «1000») без преждевременного парсинга.
   */
  const [excludeInputStr, setExcludeInputStr] = useState('')

  const rd: MsRetailDemand | null = useMemo(() => {
    if (!receipt) return null
    try {
      return JSON.parse(receipt.raw_json) as MsRetailDemand
    } catch {
      return null
    }
  }, [receipt])

  const sourcePositions = useMemo(() => {
    if (!rd) return []
    return extractPositions(rd)
  }, [rd])

  /**
   * Список товаров в подборе у которых пустой ИКПУ.
   *
   * Без MXIK ОФД не начисляет покупателю кешбэк и магазин рискует штрафом
   * 1% от суммы (постановление ВМ-255 от 12.05.2022 п.20 ч.5). Поэтому
   * фискализацию таких чеков мы блокируем — кассир должен дозаполнить
   * ИКПУ в админке mytoolbox. package_code НЕ требуем (опционален,
   * см. epos-mobile-api.md стр.140 — E-014 только при НЕВЕРНОМ коде).
   *
   * Считаем уникальные имена чтобы баннер не дублировал товары когда
   * один и тот же выбран в multi-item / split.
   */
  const itemsWithoutIkpu = useMemo(() => {
    if (!match) return [] as string[]
    const names = new Set<string>()
    // В holistic-режиме источник правды — match.holistic.lines (плоский
    // список фискальных строк), в classic — match.positions.candidates.
    const lines =
      match.mode === 'holistic' && match.holistic
        ? match.holistic.lines
        : match.positions.flatMap((pm) => pm.candidates)
    for (const c of lines) {
      // Только ИКПУ обязателен. package_code опционален (E-POS Mobile API
      // помечает его ❌, E-014 только при НЕВЕРНОМ коде, не при пустом).
      if (!c.esfItem.class_code || c.esfItem.class_code.trim() === '') {
        names.add(c.esfItem.name)
      }
    }
    return Array.from(names)
  }, [match])

  const matchedSourceIndexes = useMemo(() => {
    if (!match) return new Set<number>()
    return new Set(match.positions.map((pm) => pm.source.index))
  }, [match])

  /**
   * Есть ли позиция которую matcher не смог подобрать (пустой candidates[]).
   * Такие теперь рисуются в таблице с кнопкой «Подобрать вручную», но
   * фискализацию блокируем — чек неполный, сумма не сойдётся пока кассир
   * не закроет позицию руками.
   */
  const hasUnmatched = useMemo(() => {
    if (!match) return false
    // В holistic-режиме «unmatched» по позициям не блокирует — план собран
    // целостно на сумму чека, фискальные строки берутся из match.holistic.
    if (match.mode === 'holistic') return false
    return match.positions.some((pm) => pm.candidates.length === 0)
  }, [match])

  /**
   * «Грязный» excludeTiyin — введённый кассиром, но matcher ещё не успел
   * пересобрать план (debounce 400ms). Блокируем «Фискализировать»: иначе
   * matchedTotal в match и payment split в fiscalize() считались бы на
   * разных target → Communicator отвергнет чек как несбалансированный
   * (сырьём «illegal argument»). Сравниваем applied (то с чем последний
   * раз буился match) и expected (то что в поле сейчас).
   */
  const excludeDirty = useMemo(() => {
    if (!rd || !match) return false
    const applied = matcherOpts.targetSumOverrideTiyin ?? rd.sum
    const expected = Math.max(0, rd.sum - excludeTiyin)
    return applied !== expected
  }, [rd, match, matcherOpts.targetSumOverrideTiyin, excludeTiyin])

  /**
   * Тип оплаты из МойСклад — для бейджа над заголовком.
   * См. подробное описание правил в коммитах прошлых релизов.
   */
  const paymentKind = useMemo<
    null | 'cash' | 'card' | 'qr' | 'mixed'
  >(() => {
    if (!rd) return null
    const cash = rd.cashSum ?? 0
    const card = rd.noCashSum ?? 0
    const qr = rd.qrSum ?? 0
    const hasCard = card > 0 || qr > 0
    if (cash > 0 && hasCard) return 'mixed'
    if (qr > 0) return 'qr'
    if (card > 0) return 'card'
    if (cash > 0) return 'cash'
    return null
  }, [rd])

  useEffect(() => {
    excludedServerIdsRef.current = []
    staleErrorCountRef.current = 0
    lastStaleToastTsRef.current = 0
    setStaleErrorPersistent(false)
    void load({ excludeServerItemIds: [] })
  }, [id])

  /**
   * Debounced rebuild при изменении excludeTiyin.
   *
   * Когда кассир редактирует поле «Сумма через Click/Payme» — ждём 400ms
   * после последнего нажатия и перезапускаем `load()`. matcher пересоберёт
   * план с новым `effectiveTarget = rd.sum − excludeTiyin`.
   *
   * Skip первый рендер (когда excludeTiyin=0 — это default, чек только что
   * загрузился через основной useEffect выше). Skip пока match не загружен.
   */
  useEffect(() => {
    if (!match) return
    // Защита: не пересобирать если excludeTiyin не меняется (например при
    // первом монтировании когда default=0 совпадает с тем что было). Сравним
    // с тем что matcher уже использовал.
    const lastOverride = matcherOpts.targetSumOverrideTiyin
    const expected = (rd?.sum ?? 0) - excludeTiyin
    if (lastOverride === expected) return
    const t = setTimeout(() => {
      void load()
    }, 400)
    return () => clearTimeout(t)
    // load() сам подхватит свежий excludeTiyin через замыкание.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [excludeTiyin])

  function rememberExcludedServerIds(ids: number[]): number[] {
    if (ids.length === 0) return excludedServerIdsRef.current
    const next = [...new Set([...excludedServerIdsRef.current, ...ids])]
    excludedServerIdsRef.current = next
    return next
  }

  async function load(overrides?: { excludeServerItemIds?: number[] }) {
    setBusy(true)
    setError(null)
    try {
      const r = await getMsReceipt(Number(id))
      if (!r) {
        setError('Чек не найден')
        return
      }
      setReceipt(r)

      // Уже фискализирован? Проверяем ДО построения подбора — баннер +
      // дизейбл кнопки. Защита от повторной фискализации (двойной чек ОФД).
      const existingFiscal = await getFiscalReceiptByMsId(r.id).catch(() => null)
      if (existingFiscal || r.status === 'fiscalized') {
        setAlreadyFiscalized(existingFiscal ?? null)
      } else {
        setAlreadyFiscalized(null)
      }

      let parsed = JSON.parse(r.raw_json) as MsRetailDemand

      // МС в list-запросе не отдаёт inline positions. Если их нет —
      // одиночный GET с expand, обновляем raw_json в БД.
      // Также используем тот же client для enrichWithVariants ниже.
      const basic = await getSetting(SettingKey.MoyskladCredentials)
      const token = basic ? null : await getSetting(SettingKey.MoyskladToken)
      const msClient =
        basic || token
          ? new MoyskladClient(basic ? { basic } : { token: token! })
          : null

      if (!inlinePositions(parsed) && msClient) {
        try {
          const full = await msClient.getRetailDemand(parsed.id)
          const newRawJson = JSON.stringify(full)
          const db = await getDb()
          await db.execute(
            'UPDATE ms_receipts SET raw_json = $1, updated_at = $2 WHERE id = $3',
            [newRawJson, now(), r.id],
          )
          parsed = full
          setReceipt({ ...r, raw_json: newRawJson })
        } catch (fetchErr) {
          console.warn('Не удалось дозагрузить позиции чека:', fetchErr)
        }
      }

      // Обогащение characteristics из модификаций (linked-ms fallback).
      // Если в чеке базовый товар (product) без characteristics — пытаемся
      // найти его модификации и взять characteristics единственной модификации.
      // С TTL-кэшем (5 мин) повторные чеки с тем же товаром не делают
      // лишних HTTP-запросов к МС.
      if (msClient && inlinePositions(parsed)) {
        try {
          const { enrichedCount, productsChecked } = await enrichWithVariants(
            parsed,
            (productId) =>
              getCachedVariants(productId, (id: string) =>
                msClient.listVariantsByProduct(id),
              ),
          )
          if (enrichedCount > 0) {
            await log.info(
              'matcher',
              `[linked-ms] обогащено ${enrichedCount} из ${productsChecked} product-позиций characteristics модификации`,
            )
          }
        } catch (enrichErr) {
          console.warn('enrichWithVariants failed:', enrichErr)
        }
      }

      // Дефолт 500k тийинов (5000 сум), было 100k (1000 сум). Жёсткий
      // ±1000 при округлении цен до 1000 и редком складе почти не давал
      // совпадений. ±5000 + distributeBump закрывает остаток. В чек всё
      // равно пишется pos.totalTiyin (что заплатил клиент), так что
      // расширение безопасно. Меняется через Настройки если нужно.
      const DEFAULT_TOLERANCE_TIYIN = 500_000
      const tolStr = await getSetting(SettingKey.MatchToleranceTiyin)
      const tolerance =
        tolStr != null && tolStr !== ''
          ? Number.parseInt(tolStr, 10) || 0
          : DEFAULT_TOLERANCE_TIYIN

      const markupStr = await getSetting(SettingKey.MarkupPercent)
      const markupPercent =
        markupStr != null && markupStr !== ''
          ? Number.parseInt(markupStr, 10) || 0
          : 10
      const roundStr = await getSetting(SettingKey.RoundUpToSum)
      const roundUpToSum =
        roundStr != null && roundStr !== ''
          ? Number.parseInt(roundStr, 10) || 0
          : 1000

      const discRaw = await getSetting(SettingKey.DiscountForExactSum)
      const discountEnabled = discRaw == null ? true : discRaw === 'true'
      const maxDiscStr = await getSetting(SettingKey.MaxDiscountPerItemSum)
      const maxDiscountSum =
        maxDiscStr != null && maxDiscStr !== ''
          ? Number.parseInt(maxDiscStr, 10) || 0
          : 2000
      const maxDiscountPerItemTiyin = maxDiscountSum * 100

      // Имя характеристики модификации МС для связки с приходом
      // (см. matcher/extract.ts::readLinkedBuhName). Default —
      // 'Бухгалтерское наименование'. Бухгалтер может назвать иначе через
      // Settings → «Имя характеристики связки».
      const linkCharRaw = await getSetting(SettingKey.MsLinkCharacteristicName)
      const linkCharacteristicName =
        linkCharRaw && linkCharRaw.trim() ? linkCharRaw.trim() : 'Бухгалтерское наименование'

      // Принудительная ставка НДС для продаж (default 12% — общий режим
      // в РУз). Override на уровне пула: vat_percent каждого инв.прихода
      // переписывается на это значение, чтобы расчёт продажной цены и
      // фискальный чек всегда использовали 12% независимо от того что
      // указал поставщик в ЭСФ (упрощенцы шлют 0%).
      const vatRaw = await getSetting(SettingKey.DefaultVatPercent)
      const defaultVatPercent =
        vatRaw != null && vatRaw !== ''
          ? Number.parseInt(vatRaw, 10) || 0
          : 12

      // Режим matcher'а: 'auto' (default) пробует classic, при провале
      // включает holistic. См. SettingKey.MatcherMode.
      const modeRaw = await getSetting(SettingKey.MatcherMode)
      const matcherMode = ((): 'auto' | 'classic' | 'holistic' | 'off' => {
        if (modeRaw === 'classic' || modeRaw === 'holistic' || modeRaw === 'off') {
          return modeRaw
        }
        return 'auto'
      })()

      // Click/Payme: если кассир пометил часть оплаты как электронную —
      // matcher работает с уменьшенной таргет-суммой. Передаём через override,
      // не мутируя parsed.sum (его читает ещё Refund.tsx, history и т.д.).
      const effectiveTarget = Math.max(0, parsed.sum - excludeTiyin)
      const activeExcludedServerIds =
        overrides?.excludeServerItemIds ?? excludedServerIdsRef.current

      const opts: MatcherOptions = {
        toleranceTiyin: tolerance,
        markupPercent,
        roundUpToSum,
        discountForExactSum: discountEnabled,
        maxDiscountPerItemTiyin,
        linkCharacteristicName,
        defaultVatPercent,
        matcherMode,
        excludeServerItemIds:
          activeExcludedServerIds.length > 0
            ? activeExcludedServerIds
            : undefined,
        // Если excludeTiyin > 0 — matcher собирает план на rd.sum − exclude.
        // Если excludeTiyin = 0 — override не передаём (matcher работает по rd.sum
        // как всегда). Это сохраняет старое поведение для чеков без Click/Payme.
        targetSumOverrideTiyin:
          excludeTiyin > 0 && effectiveTarget >= 0 ? effectiveTarget : undefined,
      }
      const result = await buildMatch(parsed, opts)
      setMatch(result)
      setMatcherOpts(opts)
      // Пул для модалки ручной сборки больше не кэшируем тут — модалка
      // сама грузит свежий снимок при открытии (см. HIGH #6 review).
      const test = (await getSetting(SettingKey.TestMode)) === 'true'
      setTestMode(test)
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Пометить чек как «не фискальный» — вся сумма прошла через Click/Payme
   * (или иные не-фискализируемые электронные платежи). В ОФД ничего не
   * отправляется, ms_receipt получает status='not_required'.
   *
   * Условие активации этой кнопки: excludeTiyin >= rd.sum.
   */
  async function markNotRequired(): Promise<void> {
    if (!receipt || !rd) return
    setFiscalizing(true)
    setError(null)
    try {
      await setMsReceiptStatus(receipt.id, 'not_required')
      void log.info(
        'fiscalize',
        `Чек ${receipt.ms_name} помечен как не фискальный (Click/Payme)`,
        { msReceiptId: receipt.id, msSum: rd.sum, excludeTiyin },
      )
      toast.success('Чек помечен как не фискальный (Click/Payme)', {
        duration: 4000,
      })
      nav('/history')
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setFiscalizing(false)
    }
  }

  /**
   * Свап товара через стрелки `←`/`→` на swappable-позиции (price-bucket).
   *
   * `recalculateAfterSwap` может ОТКЛОНИТЬ свап (анти-микс: другая позиция
   * чека уже держит тот же товар из другой партии) — в этом случае она
   * возвращает `result` с ТЕМИ ЖЕ positions (selectedAlternativeIndex не
   * меняется), но с добавленным warning'ом в `warnings[]`. Без явного
   * тоста кассир видел бы что стрелка «не сработала» без объяснения —
   * warning есть, но лежит в свёрнутом по умолчанию блоке «Предупреждения»
   * внизу экрана, легко не заметить сразу после клика. Поэтому здесь
   * дополнительно детектим этот случай (selectedAlternativeIndex не
   * изменился хотя мы просили другой) и кидаем toast с причиной.
   */
  function applySwap(positionIndex: number, newAlternativeIndex: number): void {
    if (!match) return
    const before = match.positions[positionIndex]
    const result = recalculateAfterSwap(match, positionIndex, newAlternativeIndex, matcherOpts)
    const after = result.positions[positionIndex]
    const swapRejected =
      before &&
      after &&
      after.selectedAlternativeIndex === before.selectedAlternativeIndex &&
      after.selectedAlternativeIndex !== newAlternativeIndex
    if (swapRejected) {
      const reason = result.warnings.find((w) => w.startsWith('Свап отклонён'))
      toast.error(reason ?? 'Свап отклонён: нельзя смешивать партии одного товара', {
        duration: 6000,
      })
    }
    setMatch(result)
  }

  /**
   * Клик «Фискализировать»: если оплата чисто наличкой — сразу фискализируем.
   * Иначе — открываем модалку выбора типа карты, фискализация запустится
   * после клика «Jismoniy shaxs» / «Korporativ» в модалке.
   *
   * `paymentKind` уже посчитан выше через useMemo:
   *   'cash'  → нет карты, модалка не нужна
   *   'card' / 'qr' / 'mixed' → карта есть, спрашиваем тип
   *   null    → fallback (rd.sum=0 и т.п.) — модалку не показываем
   */
  function onFiscalizeClick(): void {
    if (paymentKind === 'card' || paymentKind === 'qr' || paymentKind === 'mixed') {
      setCardKindModal(true)
      return
    }
    void doFiscalize()
  }

  async function doFiscalize(cardKind?: 'fiz' | 'corp'): Promise<void> {
    if (!match || !receipt) return
    setFiscalizing(true)
    setError(null)
    setShiftNotOpen(false)
    try {
      const result = await fiscalize(match, {
        msReceiptId: receipt.id,
        cardKind,
        // Click/Payme exclude — пробрасываем в fiscalize чтобы:
        // 1. determinePaymentFromMs вычел из noCashSum/qrSum
        // 2. сохранилось в fiscal_receipts.excluded_payment_tiyin для аудита
        excludePaymentTiyin: excludeTiyin > 0 ? excludeTiyin : undefined,
      })
      if (testMode) {
        const total = match.matchedTotalTiyin / 100
        const itemsCount = match.positions.reduce(
          (s, p) => s + p.candidates.length,
          0,
        )
        toast.success(
          `Тестовый режим: подбор готов на ${total.toLocaleString('ru-RU')} сум, ${itemsCount} позиций`,
          { duration: 5000 },
        )
        return
      }
      toast.success(`Чек фискализирован: ${result.fiscal.FiscalSign}`)
      nav('/history')
    } catch (e) {
      // Multi-shop конфликт: другой магазин успел забрать товар.
      // НЕ ставим status='failed' — чек не failed, просто нужно перематчить
      // с другим товаром. Добавляем отказанные server_item_id в exclude
      // и автоматом перерендериваем match (matcher их пропустит).
      if (e instanceof InventoryConflictError) {
        const newExcludes = rememberExcludedServerIds(
          e.failed.map((f) => f.inv_item_id),
        )
        toast.error(
          `Товар закончился — другой магазин опередил. Подбираю замену...`,
          { duration: 4000 },
        )
        // Re-build match с новым excludes — сначала синхронизируем SQLite-кэш
        // с сервером, чтобы rematch видел свежие остатки, а не stale данные
        // которые только что вызвали конфликт. Прямой await (не IIFE) чтобы
        // finally сработал только после завершения sync, а не во время него
        // (иначе кнопка ре-энейблится пока sync ещё идёт → риск двойного клика).
        try {
          await syncFromServer({ forceFull: true })
        } catch {
          // best-effort: продолжаем с тем что есть
        }
        void load({ excludeServerItemIds: newExcludes })
        return
      }
      // Уже фискализирован (обошли UI-блок) — НЕ failed, просто
      // показываем баннер и перезагружаем чтобы alreadyFiscalized встал.
      if (e instanceof AlreadyFiscalizedError) {
        toast.error(e.message, { duration: 6000 })
        void load()
        return
      }
      // Сервер вернул Postgres-инвариант inv_items_check — кэш справочника
      // разъехался с реальностью.
      //
      // Стратегия восстановления зависит от типа плана:
      //
      // 1. **Ручной план** (match.manuallyBuilt) — кассир уже потратил время
      //    на ручную сборку. НЕ перетираем его авто-подбором. Делаем sync +
      //    показываем КОНКРЕТНО какие товары закончились (по suspectIds из
      //    ошибки) → кассир сам открывает модалку и меняет именно их.
      //
      // 2. **Авто-план** (canAutoFiscalize или auto-holistic) — добавляем
      //    suspect inv_item_ids в excludedServerIds (matcher их пропустит)
      //    и пересобираем. Это разрывает цикл «matcher → те же sold-out →
      //    inv_items_check → ...».
      //
      // 3. **2+ ошибки подряд** (счётчик не ресетится при открытии модалки —
      //    важно!) — persistent-карточка «Собрать вручную». Только пользователь
      //    в модалке видит свежие остатки и может выбрать новые товары.
      //    Снимается с persistent только кнопкой «Закрыть» или после успешной
      //    фискализации (re-mount компонента при навигации).
      if (e instanceof InventoryStaleError) {
        staleErrorCountRef.current += 1

        // Debounce: показываем toast не чаще раза в 5 сек. Если кассир в
        // race-heavy момент нажимает Фискализировать несколько раз — он
        // не утонет в одинаковых сообщениях.
        const now = Date.now()
        const STALE_TOAST_DEBOUNCE_MS = 5000
        const shouldShowToast =
          now - lastStaleToastTsRef.current >= STALE_TOAST_DEBOUNCE_MS
        if (shouldShowToast) lastStaleToastTsRef.current = now

        // Suspect ids → excludedServerIds (для будущих авто-подборов).
        const newExcludes = rememberExcludedServerIds(e.suspectInvItemIds)

        // forceFull sync — обязательно ДО всех веток ниже.
        try {
          await syncFromServer({ forceFull: true })
        } catch {
          // Если sync упал — продолжаем; load всё равно пересмотрит локальный кэш.
        }

        // 2+ ошибки подряд → persistent (одинаково для manual/auto)
        if (staleErrorCountRef.current >= 2) {
          setStaleErrorPersistent(true)
          if (shouldShowToast) {
            toast.error(
              'Остатки повторно разошлись. Откройте «Собрать вручную» — ' +
                'там свежие данные.',
              { duration: 8000 },
            )
          }
          return
        }

        // Ручной план — сохраняем, не пересобираем
        if (match?.manuallyBuilt) {
          if (shouldShowToast) {
            const conflictCount = e.suspectInvItemIds.length
            toast.error(
              conflictCount === 1
                ? '1 товар из ручного выбора закончился на сервере. ' +
                    'Откройте «Собрать вручную» — там обновлённые остатки.'
                : `${conflictCount} товара из ручного выбора закончились на ` +
                  'сервере. Откройте «Собрать вручную» — там обновлённые остатки.',
              { duration: 7000 },
            )
          }
          // План в state не трогаем — кассир увидит подсказку и сам решит
          return
        }

        // Авто-план — стандартный путь: sync уже сделан, перезагружаем match
        // с обновлённым excludedServerIds (matcher пропустит suspect ids).
        if (shouldShowToast) {
          toast.error('Остатки изменились, подбираю замены…', { duration: 4000 })
        }
        setTimeout(() => void load({ excludeServerItemIds: newExcludes }), 300)
        return
      }
      // Смена не открыта — НЕ failed (чек валиден, просто нет смены).
      // Показываем баннер с кнопкой перехода в раздел Смена.
      if (e instanceof ShiftNotOpenError) {
        setShiftNotOpen(true)
        toast.error(e.message, { duration: 6000 })
        return
      }
      setError(formatErrorForUser(e))
      await setMsReceiptStatus(receipt.id, 'failed').catch(() => undefined)
    } finally {
      setFiscalizing(false)
    }
  }

  if (busy && !receipt) {
    return (
      <Card>
        <Card.Body>
          <div className="text-body text-ink-muted">Загрузка чека…</div>
        </Card.Body>
      </Card>
    )
  }

  if (error && !receipt) {
    return (
      <Card>
        <Card.Body>
          <EmptyState
            icon={<AlertCircle size={36} />}
            title="Чек не найден"
            description={error}
            action={
              <Button onClick={() => nav('/')} icon={<ArrowLeft size={14} />}>
                К списку
              </Button>
            }
          />
        </Card.Body>
      </Card>
    )
  }

  if (!receipt || !rd || !match) return null

  return (
    <div className="space-y-6">
      <PageHeader
        title={`Чек ${receipt.ms_name ?? `#${receipt.id}`}`}
        subtitle={`${formatDateTime(receipt.ms_moment)} · оригинал из МойСклад`}
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => nav('/')}
              icon={<ArrowLeft size={14} />}
            >
              Назад
            </Button>
            {/* Ручная сборка чека целиком — кассир сам набирает товары на
                сумму. Недоступно если чек уже фискализирован. Пул модалка
                загружает сама на open (свежий снимок), отсюда pool не передаём. */}
            <Button
              variant="secondary"
              onClick={() => setManualModalOpen(true)}
              disabled={!!alreadyFiscalized || fiscalizing}
              title="Собрать чек вручную: добавить/убрать товары, дособрать остаток"
            >
              Собрать вручную
            </Button>
            {/* Если кассир пометил всю сумму как Click/Payme — фискализировать
                нечего. Кнопка меняется на «Отметить как не фискальный»: ставим
                ms_receipt.status='not_required', в ОФД ничего не уходит. */}
            {excludeTiyin >= rd.sum && rd.sum > 0 ? (
              <Button
                variant="secondary"
                loading={fiscalizing}
                disabled={fiscalizing || !!alreadyFiscalized}
                onClick={markNotRequired}
                title="Вся сумма прошла через Click/Payme — фискальный чек не выдаётся"
              >
                {alreadyFiscalized
                  ? 'Уже фискализирован'
                  : 'Отметить как не фискальный'}
              </Button>
            ) : (
              <Button
                variant="primary"
                loading={fiscalizing}
                disabled={
                  fiscalizing ||
                  match.positions.length === 0 ||
                  itemsWithoutIkpu.length > 0 ||
                  hasUnmatched ||
                  excludeDirty ||
                  !!alreadyFiscalized
                }
                onClick={onFiscalizeClick}
                icon={!fiscalizing ? <Send size={14} /> : undefined}
                title={
                  alreadyFiscalized
                    ? 'Чек уже фискализирован — повторная фискализация запрещена'
                    : excludeDirty
                      ? 'Пересобираю план под новую сумму Click/Payme — подождите секунду'
                      : hasUnmatched
                        ? 'Есть неподобранные позиции — подберите их вручную'
                        : itemsWithoutIkpu.length > 0
                          ? `Невозможно фискализировать: ${itemsWithoutIkpu.length} товаров без ИКПУ`
                          : undefined
                }
              >
                {alreadyFiscalized
                  ? 'Уже фискализирован'
                  : testMode
                    ? 'Тестовая фискализация'
                    : 'Фискализировать'}
              </Button>
            )}
          </div>
        }
      />

      {/* Payment badge — отдельной строкой */}
      {paymentKind && (
        <div>
          <PaymentBadge
            kind={paymentKind}
            cashSum={rd.cashSum ?? 0}
            cardSum={rd.noCashSum ?? 0}
            qrSum={rd.qrSum ?? 0}
          />
        </div>
      )}

      {shiftNotOpen && (
        <Card className="border-warning/30 bg-warning-soft">
          <Card.Body className="flex items-start gap-3">
            <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-body font-medium text-warning">
                Смена ККМ не открыта
              </div>
              <div className="mt-1 text-caption text-ink">
                Communicator отказал: фискализация невозможна без открытой
                смены. Откройте смену в разделе «Смена», затем повторите
                фискализацию.
              </div>
              <div className="mt-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => nav('/zreport')}
                >
                  Перейти в Смену
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Persistent-карточка когда InventoryStaleError повторяется подряд —
          авто-подбор зацикливается на распроданных товарах, единственный
          выход — ручная сборка где модалка грузит свежий снимок пула. */}
      {staleErrorPersistent && (
        <Card className="border-danger/30 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-body font-medium text-danger">
                Авто-подбор зацикливается
              </div>
              <div className="mt-1 text-caption text-ink">
                Сервер уже несколько раз отказал в резерве — matcher
                выбирает товары, которые на сервере уже распроданы (кэш
                разъехался). Авто-обновление не помогает. Используйте{' '}
                <strong>«Собрать вручную»</strong>: модалка покажет реально
                доступные остатки, кассир выберет сам или нажмёт «Дособрать
                оставшееся».
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setManualModalOpen(true)
                    // Только снимаем persistent-карточку. Счётчик НЕ ресетим —
                    // если ручной выбор тоже упадёт со stale, это всё ещё
                    // продолжение того же эпизода race-condition.
                    setStaleErrorPersistent(false)
                  }}
                >
                  Открыть «Собрать вручную»
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStaleErrorPersistent(false)
                    staleErrorCountRef.current = 0
                  }}
                >
                  Закрыть
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>
      )}

      {alreadyFiscalized && (
        <Card className="border-danger/30 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-body font-medium text-danger">
                Этот чек уже фискализирован
              </div>
              <div className="mt-1 text-caption text-ink">
                FiscalSign{' '}
                <span className="font-mono">
                  {alreadyFiscalized.fiscal_sign}
                </span>{' '}
                · чек № {alreadyFiscalized.receipt_seq} ·{' '}
                {formatDateTime(alreadyFiscalized.fiscalized_at)}. Повторная
                фискализация запрещена (был бы двойной чек в ОФД). Если нужно
                вернуть товар — оформите возврат.
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => nav('/history')}
                >
                  В Историю
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => nav(`/refund/${alreadyFiscalized.id}`)}
                >
                  Оформить возврат
                </Button>
              </div>
            </div>
          </Card.Body>
        </Card>
      )}


      {error && (
        <Card className="border-danger/20 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="text-body text-danger">{error}</div>
          </Card.Body>
        </Card>
      )}

      {/* Блокировка фискализации: товары без ИКПУ → ОФД отказал бы в кешбэке +
          ГНК штрафанула бы магазин на 1% (постановление ВМ-255 от 12.05.2022).
          Кассир видит баннер и список товаров, кнопка «Фискализировать»
          выше disabled. Дозаполнить нужно в админке mytoolbox. */}
      {itemsWithoutIkpu.length > 0 && (
        <Card className="border-danger/30 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="flex-1">
              <div className="text-body font-medium text-danger">
                Невозможно фискализировать: {itemsWithoutIkpu.length}{' '}
                {itemsWithoutIkpu.length === 1 ? 'товар без ИКПУ' : 'товаров без ИКПУ'}
              </div>
              <div className="mt-1 text-caption text-ink">
                Без MXIK ОФД не начислит покупателю кешбэк, а ГНК штрафует
                магазин на 1% от суммы. Дозаполните ИКПУ в{' '}
                <em className="not-italic font-medium">mytoolbox → Inventory → Приходы</em>{' '}
                и обновите чек.
              </div>
              <ul className="mt-2 space-y-0.5 text-caption text-ink">
                {itemsWithoutIkpu.map((name, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-danger shrink-0">·</span>
                    <span className="font-mono truncate">{name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </Card.Body>
        </Card>
      )}

      {/* Click/Payme exclude — мини-карточка. При вводе суммы matcher
          пересобирает план на rd.sum - exclude (debounced 400ms).
          В ОФД ничего не отправляется, на ленте упоминаний Click/Payme нет.
          Только фискализируется уменьшенная сумма + сохраняется
          excluded_payment_tiyin в БД для аудита.

          Показывается ТОЛЬКО когда в чеке есть карточная/QR/смешанная оплата.
          Click/Payme — электронный платёж, он всегда в безналичной части МС
          (noCashSum/qrSum). Для чеков чисто наличкой исключать нечего —
          поле было бы лишним. paymentKind считается выше через useMemo. */}
      {(paymentKind === 'card' ||
        paymentKind === 'qr' ||
        paymentKind === 'mixed') && (
      <Card>
        <Card.Body className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="text-body font-medium text-ink">
                Сумма через Click / Payme
              </div>
              <div className="mt-0.5 text-caption text-ink-muted">
                Введите сумму электронной оплаты которая НЕ фискализируется.
                Фискальный чек будет на оставшуюся сумму{' '}
                <span className="font-mono">
                  ({tiyinToSumDisplay(rd.sum)} сум) − введённая
                </span>
                .
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                placeholder="0"
                className="w-40 rounded-md border border-border bg-canvas px-3 py-2 text-right font-mono text-body text-ink focus:border-primary focus:outline-none"
                value={excludeInputStr}
                onChange={(e) => {
                  // Принимаем цифры, пробелы, запятую. Парсим в целые сум.
                  const raw = e.target.value
                  setExcludeInputStr(raw)
                  const cleaned = raw.replace(/[^\d]/g, '')
                  const sumValue = cleaned === '' ? 0 : Number.parseInt(cleaned, 10) || 0
                  // Ограничиваем 0 ≤ value ≤ rd.sum (в тийинах ×100)
                  const tiyinValue = Math.max(
                    0,
                    Math.min(sumValue * 100, rd.sum),
                  )
                  setExcludeTiyin(tiyinValue)
                }}
                aria-label="Сумма через Click/Payme (не фискализируется)"
              />
              <span className="text-body text-ink-muted">сум</span>
              {excludeTiyin > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setExcludeInputStr('')
                    setExcludeTiyin(0)
                  }}
                  title="Сбросить — фискализировать всю сумму"
                >
                  Сбросить
                </Button>
              )}
            </div>
          </div>
          {excludeTiyin > 0 && (
            <div className="rounded-md bg-warning-soft p-3 text-caption text-ink space-y-1">
              <div>
                <strong className="text-warning">Внимание:</strong> МС-чек на{' '}
                <span className="font-mono">
                  {tiyinToSumDisplay(rd.sum)} сум
                </span>
                , фискализируется только{' '}
                <span className="font-mono font-semibold">
                  {tiyinToSumDisplay(Math.max(0, rd.sum - excludeTiyin))} сум
                </span>{' '}
                (исключено{' '}
                <span className="font-mono">
                  {tiyinToSumDisplay(excludeTiyin)} сум
                </span>{' '}
                как Click/Payme).
              </div>
              {excludeTiyin >= rd.sum && (
                <div className="text-warning font-medium">
                  Вся сумма электронная — фискальный чек не выдаётся. Нажмите
                  «Отметить как не фискальный».
                </div>
              )}
              {/* Sanity-check: exclude больше чем безналичная часть МС. Не блок,
                  только информация — кассир знает что делает. */}
              {excludeTiyin > (rd.noCashSum ?? 0) + (rd.qrSum ?? 0) && (
                <div className="text-ink-muted">
                  Примечание: введённая сумма больше безналичной части по МС
                  ({tiyinToSumDisplay((rd.noCashSum ?? 0) + (rd.qrSum ?? 0))}{' '}
                  сум). Проверьте.
                </div>
              )}
            </div>
          )}
        </Card.Body>
      </Card>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Side title="Оригинал из МойСклад" sumTiyin={rd.sum}>
          <PositionsTable
            positions={sourcePositions.map((pos) => ({
              name: pos.name,
              quantity: pos.quantity,
              total: pos.totalTiyin,
              vatPercent: pos.vatPercent,
              meta: pos.classCode ?? '— нет ИКПУ —',
              matched: matchedSourceIndexes.has(pos.index),
            }))}
          />
        </Side>

        <Side
          title={
            match.mode === 'holistic'
              ? 'Подбор: holistic (на сумму чека)'
              : `Подбор: ${strategyLabel(match.overallStrategy)}`
          }
          sumTiyin={match.matchedTotalTiyin}
          sumDiff={match.totalDiffTiyin}
        >
          {match.mode === 'holistic' && match.holistic ? (
            // Holistic: плоский список фискальных строк, без manual/swap/split.
            // План построен целостно на сумму, отдельных «позиций» нет.
            <PositionsTable
              positions={match.holistic.lines.map((line): DisplayPosition => ({
                name: line.esfItem.name,
                quantity: line.quantity,
                total: line.priceTiyin - line.discountTiyin,
                vatPercent: line.esfItem.vat_percent,
                meta: line.esfItem.class_code || '— нет ИКПУ —',
                matched: true,
              }))}
            />
          ) : (
          <PositionsTable
            positions={match.positions.flatMap((pm, posIdx): DisplayPosition[] => {
              // Не подобрано (matcher ничего не нашёл) — одна строка-заглушка.
              // Ручной подбор убран: при разреженном пуле срабатывает holistic
              // (Настройки → Режим подбора). Если и он не справился — нужно
              // дозаполнить склад. Фискализация блокируется через hasUnmatched.
              if (pm.candidates.length === 0) {
                return [
                  {
                    name: pm.source.name,
                    quantity: pm.source.quantity,
                    total: pm.source.totalTiyin,
                    vatPercent: pm.source.vatPercent,
                    meta: pm.source.classCode ?? '— не подобрано —',
                    matched: false,
                  },
                ]
              }
              return pm.candidates.map((c, candIdx) => {
                // Стрелки swap рисуем только на ПЕРВОМ candidate в группе.
                const isFirstCand = candIdx === 0
                const swap =
                  pm.swappable &&
                  isFirstCand &&
                  pm.alternatives.length > 1
                    ? {
                        altIndex: pm.selectedAlternativeIndex,
                        altCount: pm.alternatives.length,
                        onPrev:
                          pm.selectedAlternativeIndex > 0
                            ? () => applySwap(posIdx, pm.selectedAlternativeIndex - 1)
                            : undefined,
                        onNext:
                          pm.selectedAlternativeIndex < pm.alternatives.length - 1
                            ? () => applySwap(posIdx, pm.selectedAlternativeIndex + 1)
                            : undefined,
                      }
                    : undefined
                return {
                  name: c.esfItem.name,
                  quantity: c.quantity,
                  total: c.priceTiyin - c.discountTiyin,
                  discount: c.discountTiyin > 0 ? c.discountTiyin : undefined,
                  originalPrice: c.discountTiyin > 0 ? c.priceTiyin : undefined,
                  vatPercent: c.esfItem.vat_percent,
                  meta: c.esfItem.class_code,
                  matched: true,
                  swap,
                }
              })
            })}
          />
          )}
        </Side>
      </div>

      {(() => {
        // В holistic-режиме «N подобранных» по позициям не применимо —
        // план собран целостно на сумму, баннер с подсчётом был бы вреден.
        if (match.mode === 'holistic') return null
        const totalPos = sourcePositions.length
        const matchedPos = match.positions.filter(
          (pm) => pm.candidates.length > 0,
        ).length
        const shortfall =
          match.totalDiffTiyin < 0 ? -match.totalDiffTiyin : 0
        if (matchedPos >= totalPos && shortfall === 0) return null
        return (
          <Card className="border-warning/30 bg-warning-soft">
            <Card.Body className="flex items-start gap-3">
              <TriangleAlert
                size={18}
                className="text-warning shrink-0 mt-0.5"
              />
              <div className="flex-1">
                <div className="text-body font-medium text-warning">
                  Подбор неполный: {matchedPos} из {totalPos} позиций
                  {shortfall > 0 &&
                    `, не хватает ${tiyinToSumDisplay(shortfall)} сум`}
                </div>
                <div className="mt-1 text-caption text-ink">
                  Склад не покрывает сумму автоматически. Что делать:
                </div>
                <ul className="mt-1 space-y-0.5 text-caption text-ink">
                  <li className="flex gap-2">
                    <span className="text-warning shrink-0">·</span>
                    <span>
                      Проверьте <strong>Режим подбора</strong> в Настройках —
                      «Авто» включит holistic-подбор на сумму чека
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-warning shrink-0">·</span>
                    <span>
                      Дозаполнить склад в mytoolbox (больше приходов с
                      разными ценами)
                    </span>
                  </li>
                  <li className="flex gap-2">
                    <span className="text-warning shrink-0">·</span>
                    <span>
                      Поднять «допуск по сумме» в Настройках если такое
                      часто
                    </span>
                  </li>
                </ul>
              </div>
            </Card.Body>
          </Card>
        )
      })()}

      {/* Holistic-режим — компактный сворачиваемый блок внизу. Свёрнут по
          умолчанию (одна строка), кассир разворачивает за деталями. Сами
          фискальные строки и так видны в правой колонке. */}
      {match.mode === 'holistic' && match.holistic && (() => {
        const isManual = match.holistic.notes.some((n) =>
          n.includes('вручную'),
        )
        const lineCount = match.holistic.lines.length
        const sumStr = (match.matchedTotalTiyin / 100).toLocaleString('ru-RU')
        return (
          <details className="rounded-md border border-warning/20 bg-warning-soft px-3 py-2">
            <summary className="flex cursor-pointer select-none items-center gap-2 text-caption text-warning">
              <TriangleAlert size={13} className="shrink-0" />
              {isManual
                ? 'Чек собран вручную'
                : 'Чек собран совокупно (holistic)'}
            </summary>
            <div className="mt-2 text-caption text-ink">
              {isManual ? (
                <>
                  Кассир собрал чек вручную: {lineCount}{' '}
                  {lineCount === 1 ? 'товар' : 'товаров'} на{' '}
                  <span className="font-mono">{sumStr} сум</span>. Список
                  фискальных строк — справа.
                </>
              ) : (
                <>
                  Подбор «позиция-в-позицию» не сошёлся ({' '}
                  {
                    match.positions.filter(
                      (p) => p.candidates.length === 0,
                    ).length
                  }{' '}
                  из {match.positions.length} не нашлось индивидуально).
                  Matcher собрал чек целиком на сумму{' '}
                  <span className="font-mono">{sumStr} сум</span> из{' '}
                  {lineCount} {lineCount === 1 ? 'товара' : 'товаров'}.
                  Список фискальных строк — справа.
                </>
              )}
            </div>
          </details>
        )
      })()}

      {/* Предупреждения — компактный сворачиваемый блок. Свёрнут по умолчанию
          (одна строка), кассир разворачивает только если интересны детали. */}
      {match.warnings.length > 0 && (
        <details className="rounded-md border border-warning/20 bg-warning-soft px-3 py-2">
          <summary className="flex cursor-pointer select-none items-center gap-2 text-caption text-warning">
            <TriangleAlert size={13} className="shrink-0" />
            Предупреждения ({match.warnings.length})
          </summary>
          <ul className="mt-2 space-y-1 text-caption text-ink">
            {match.warnings.map((w, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-warning shrink-0">·</span>
                <span>{w}</span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Модалка «Karta turi» — выбор типа карты перед фискализацией.
          Появляется когда есть карточная/QR/смешанная оплата (paymentKind !== 'cash').
          Выбор НЕ уходит в ОФД (JSON-RPC не принимает) — печатается только
          на ленте, как «Karta turi: Korporativ» / «Karta turi: Jismoniy shaxs»
          в блоке «To'lov Turi», см. printer.rs::build_receipt. */}
      {cardKindModal && (
        <CardKindModal
          cashTiyin={rd.cashSum ?? 0}
          cardTiyin={(rd.noCashSum ?? 0) + (rd.qrSum ?? 0)}
          onCancel={() => setCardKindModal(false)}
          onPick={(kind) => {
            setCardKindModal(false)
            void doFiscalize(kind)
          }}
        />
      )}

      {/* Модалка ручной сборки чека целиком. Стартует планом программы,
          кассир правит, «Дособрать» добивает остаток через holistic,
          «Готово» → результат становится holistic-планом чека.
          loadPool — модалка грузит свежий снимок справочника сама. */}
      {manualModalOpen && (
        <ManualReceiptModal
          targetTiyin={Math.max(0, rd.sum - excludeTiyin)}
          loadPool={async () => {
            // ВАЖНО: перед загрузкой пула делаем forceFull-синк с сервера.
            // loadMatcherPool читает локальную SQLite-таблицу esf_items —
            // если кэш разъехался с реальностью (товар на сервере
            // распродан, локально ещё available>0), модалка покажет
            // призрачный товар → «Готово» → reserve в ОФД упадёт на
            // inv_items_check. forceFull-синк гарантирует что локальная
            // БД отражает СЕРВЕРНЫЕ остатки. Модалка показывает loader
            // пока идёт синк (~1-3 сек на сети + БД).
            try {
              await syncFromServer({ forceFull: true })
            } catch {
              // Если sync упал — всё равно грузим pool из того что есть.
              // Лучше показать кассиру stale данные чем вообще ничего.
            }
            return loadMatcherPool({
              ...matcherOpts,
              excludeServerItemIds:
                excludedServerIdsRef.current.length > 0
                  ? excludedServerIdsRef.current
                  : matcherOpts.excludeServerItemIds,
            })
          }}
          opts={{
            ...matcherOpts,
            excludeServerItemIds:
              excludedServerIdsRef.current.length > 0
                ? excludedServerIdsRef.current
                : matcherOpts.excludeServerItemIds,
          }}
          initialLines={(match.mode === 'holistic' && match.holistic
            ? match.holistic.lines
            : match.positions.flatMap((pm) => pm.candidates)
          ).map((c) => ({
            esfItemId: c.esfItem.id,
            qtyPcs: Math.round(c.quantity / 1000),
          }))}
          onClose={() => setManualModalOpen(false)}
          onDone={(plan: HolisticPlan) => {
            // Ручной план становится фискальным — holistic-режим. fiscalize()
            // и печать уже умеют обрабатывать match.holistic.
            //
            // Флаг `manuallyBuilt: true` критичен — при InventoryStaleError
            // мы НЕ перетираем выбор кассира авто-подбором, а сохраняем план
            // и просим кассира открыть модалку повторно. Без флага load()
            // вернёт авто-collection и кассир потеряет работу.
            const target = Math.max(0, rd.sum - excludeTiyin)
            setMatch({
              ...match,
              mode: 'holistic',
              holistic: plan,
              matchedTotalTiyin: plan.totalTiyin,
              totalDiffTiyin: plan.totalTiyin - target,
              canAutoFiscalize: false,
              manuallyBuilt: true,
            })
            setManualModalOpen(false)
            toast.success(
              `Чек собран вручную: ${plan.lines.length} ` +
                `${plan.lines.length === 1 ? 'товар' : 'товаров'} на ` +
                `${(plan.totalTiyin / 100).toLocaleString('ru-RU')} сум`,
              { duration: 4000 },
            )
          }}
        />
      )}
    </div>
  )
}

/**
 * Минимальная модалка для выбора типа карты перед фискализацией.
 *
 * Не выносим в отдельный файл — компонент очень специфичен (используется
 * только здесь, ~30 строк), и так держать ближе к месту использования
 * понятнее. Стиль матчится с ManualPickerModal — overlay + central card.
 */
function CardKindModal(props: {
  cashTiyin: number
  cardTiyin: number
  onCancel: () => void
  onPick: (kind: 'fiz' | 'corp') => void
}): JSX.Element {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={props.onCancel}
    >
      <div
        className="w-full max-w-md mx-4 rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-border px-5 py-4">
          <div className="text-h4 font-medium text-ink">Тип карты для печати</div>
          <div className="mt-1 text-caption text-ink-muted">
            Кассир выбирает тип, который напечатается на ленте в блоке «To‘lov
            shakli» (как в чеке E-POS Cashdesk). В ОФД не отправляется.
          </div>
          {(props.cashTiyin > 0 || props.cardTiyin > 0) && (
            <div className="mt-3 space-y-0.5 text-caption text-ink-muted font-mono">
              {props.cashTiyin > 0 && (
                <div>Naqd: {tiyinToSumDisplay(props.cashTiyin)} сум</div>
              )}
              {props.cardTiyin > 0 && (
                <div>
                  Bank kartasi: {tiyinToSumDisplay(props.cardTiyin)} сум
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col gap-2 p-5">
          <Button
            variant="primary"
            onClick={() => props.onPick('fiz')}
            className="justify-start"
          >
            Jismoniy shaxs (физлицо)
          </Button>
          <Button
            variant="secondary"
            onClick={() => props.onPick('corp')}
            className="justify-start"
          >
            Korporativ (корпоративная)
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={props.onCancel}
            className="mt-2"
          >
            Отмена
          </Button>
        </div>
      </div>
    </div>
  )
}

function strategyLabel(s: string): string {
  return (
    {
      'linked-ms': '🔗 связка из МС',
      passthrough: 'как есть',
      'price-bucket': 'замена по цене',
      'multi-item': 'набор из нескольких',
      manual: 'ручной',
    }[s] ?? s
  )
}

interface DisplayPosition {
  name: string
  quantity: number
  /** К оплате после скидки. */
  total: number
  /** Размер скидки в тийинах, если применена. */
  discount?: number
  /** Цена ДО скидки — для отображения «было/стало». */
  originalPrice?: number
  vatPercent: number
  meta: string
  matched: boolean
  /**
   * Контрол для замены товара на другой по той же цене.
   *
   * Включается только для price-bucket позиций (где matcher выбрал товар
   * по близости цены, а не по точному ИКПУ). Кассир может переключаться
   * через `←` `→` чтобы выбрать другой товар на ту же сумму.
   *
   * `altIndex` / `altCount` — для счётчика «2 / 10» в UI.
   * Колбеки `onPrev`/`onNext` undefined на крайних индексах (=> кнопка disabled).
   */
  swap?: {
    altIndex: number
    altCount: number
    onPrev?: () => void
    onNext?: () => void
  }
}

function PositionsTable({ positions }: { positions: DisplayPosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="px-5 py-8 text-center text-body text-ink-muted">
        Нет позиций
      </div>
    )
  }
  return (
    <table className="w-full text-body">
      <thead className="border-b border-border bg-canvas">
        <tr>
          <th className="w-10 px-3 py-2.5"></th>
          <th className="px-3 py-2.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wide">
            Товар
          </th>
          <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
            Кол-во
          </th>
          <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
            Сумма
          </th>
        </tr>
      </thead>
      <tbody>
        {positions.map((p, i) => (
          <tr
            key={i}
            className={cn(
              'border-b border-border last:border-0',
              !p.matched && 'bg-warning-soft/40',
            )}
          >
            <td className="w-10 px-3 py-3 text-center align-top">
              <MatchIcon matched={p.matched} />
            </td>
            <td className="px-3 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                {p.swap && <SwapControl swap={p.swap} />}
                <div className="font-medium text-ink">{p.name}</div>
              </div>
              <div className="font-mono text-caption text-ink-subtle mt-0.5">
                {p.meta} · НДС {p.vatPercent}%
              </div>
            </td>
            <td className="px-3 py-3 text-right tabular-nums text-ink-muted">
              {milliQtyToDisplay(p.quantity)}
            </td>
            <td className="px-3 py-3 text-right tabular-nums">
              {p.discount && p.originalPrice ? (
                <div className="space-y-0.5">
                  <div className="text-caption text-ink-subtle line-through">
                    {tiyinToSumDisplayPrecise(p.originalPrice)}
                  </div>
                  <div className="text-caption text-danger">
                    −{tiyinToSumDisplayPrecise(p.discount)}
                  </div>
                  <div className="font-medium text-ink">
                    {tiyinToSumDisplayPrecise(p.total)}
                  </div>
                </div>
              ) : (
                <span className="text-ink">{tiyinToSumDisplayPrecise(p.total)}</span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/**
 * Контрол `← 2 / 10 →` для переключения товара на альтернативу той же цены.
 *
 * Появляется рядом с названием товара только для price-bucket позиций
 * (matcher выбрал товар по близости цены, не по точному ИКПУ — значит
 * есть свобода выбора другого товара).
 */
function SwapControl({
  swap,
}: {
  swap: {
    altIndex: number
    altCount: number
    onPrev?: () => void
    onNext?: () => void
  }
}) {
  return (
    <div className="inline-flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={swap.onPrev}
        disabled={!swap.onPrev}
        title="Предыдущий товар той же цены"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <ChevronLeft size={14} />
      </button>
      <span className="text-caption text-ink-muted tabular-nums w-12 text-center select-none">
        {swap.altIndex + 1} / {swap.altCount}
      </span>
      <button
        type="button"
        onClick={swap.onNext}
        disabled={!swap.onNext}
        title="Следующий товар той же цены"
        className={cn(
          'inline-flex h-6 w-6 items-center justify-center rounded-md border border-border',
          'hover:bg-surface-hover transition-colors',
          'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent',
        )}
      >
        <ChevronRight size={14} />
      </button>
    </div>
  )
}

/** Иконка статуса подбора позиции — заменяет ✓/✗. */
function MatchIcon({ matched }: { matched: boolean }) {
  if (matched) {
    return (
      <span
        className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-success-soft text-success"
        title="Подобрано"
      >
        <Check size={12} strokeWidth={3} />
      </span>
    )
  }
  return (
    <span
      className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-warning-soft text-warning"
      title="Не подобрано"
    >
      <TriangleAlert size={11} />
    </span>
  )
}

interface SideProps {
  title: string
  sumTiyin: number
  sumDiff?: number
  children: React.ReactNode
}

function Side({ title, sumTiyin, sumDiff, children }: SideProps) {
  return (
    <Card className="overflow-hidden">
      <Card.Header className="bg-canvas">
        <Card.Title className="text-body">{title}</Card.Title>
        <Card.HeaderAction>
          <div className="text-right">
            <div className="text-caption text-ink-muted">Итого</div>
            <div className="text-body font-semibold tabular-nums text-ink">
              {tiyinToSumDisplay(sumTiyin)} сум
            </div>
            {sumDiff !== undefined && sumDiff !== 0 && (
              <div
                className={cn(
                  'text-caption tabular-nums',
                  sumDiff > 0 ? 'text-warning' : 'text-info',
                )}
              >
                {sumDiff > 0 ? '+' : ''}
                {tiyinToSumDisplayPrecise(sumDiff)}
              </div>
            )}
          </div>
        </Card.HeaderAction>
      </Card.Header>
      {children}
    </Card>
  )
}

/**
 * Бейдж типа оплаты — рядом с заголовком чека. Показывает суммы по каналам.
 */
function PaymentBadge({
  kind,
  cashSum,
  cardSum,
  qrSum,
}: {
  kind: 'cash' | 'card' | 'qr' | 'mixed'
  cashSum: number
  cardSum: number
  qrSum: number
}) {
  const config = {
    cash: { Icon: Banknote, variant: 'success' as const },
    card: { Icon: CreditCard, variant: 'info' as const },
    qr: { Icon: QrCode, variant: 'info' as const },
    mixed: { Icon: SplitSquareHorizontal, variant: 'warning' as const },
  }[kind]

  const parts: string[] = []
  if (kind === 'mixed') {
    if (cashSum > 0) parts.push(`нал ${tiyinToSumDisplay(cashSum)}`)
    if (cardSum > 0) parts.push(`карта ${tiyinToSumDisplay(cardSum)}`)
    if (qrSum > 0) parts.push(`QR ${tiyinToSumDisplay(qrSum)}`)
  } else if (kind === 'cash') {
    parts.push(`Наличные ${tiyinToSumDisplay(cashSum)}`)
  } else if (kind === 'card') {
    parts.push(`Карта ${tiyinToSumDisplay(cardSum)}`)
  } else if (kind === 'qr') {
    parts.push(`QR ${tiyinToSumDisplay(qrSum)}`)
  }

  return (
    <Badge
      variant={config.variant}
      icon={<config.Icon size={14} />}
      className="text-body py-1 px-2.5"
    >
      <span className="tabular-nums">{parts.join(' + ')} сум</span>
    </Badge>
  )
}
