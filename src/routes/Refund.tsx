/**
 * Экран оформления возврата (полный refund на MVP).
 *
 * Flow:
 *   1. URL `/refund/:fiscalReceiptId` → load оригинального чека
 *   2. Показываем список позиций (read-only, в Phase 2 будет qty picker)
 *   3. Поля cash/card/qr пред-заполнены = как было оплачено
 *      (UI позволяет менять — например магазин выдаёт наличкой даже если
 *      оригинал был картой)
 *   4. Reason (текст) — для аудита
 *   5. Подтверждение → processRefund() → refund-чек в ОФД → печать
 *   6. Toast «Возврат FiscalSign» → редирект на /history
 *
 * Защиты UI:
 *   - Если чек уже возвращён → показываем баннер «Этот чек возвращён DD.MM»
 *   - Сумма возврата не может быть > суммы оригинала (UI maxes)
 *   - Reason обязателен (хотя в БД nullable — лучше всегда заполнять)
 *   - Кнопка «Вернуть» disabled пока сумма = 0
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { formatErrorForUser } from '@/lib/error-message'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft, TriangleAlert, Undo2 } from 'lucide-react'
import {
  getDb,
  getMsReceipt,
  getRefundByOriginalFiscalId,
  getRefundState,
  listRefundsByOriginalFiscalId,
  type FiscalReceiptRow,
  type FiscalRefundRow,
  type RefundState,
} from '@/lib/db'
import {
  getDefaultRefundAmounts,
  processRefund,
  RefundAlreadyExistsError,
  ShiftNotOpenError,
} from '@/lib/epos'
import { extractPositions } from '@/lib/matcher'
import { parseRequestJsonReceipt } from '@/lib/epos/request-json'
import type { MsRetailDemand } from '@/lib/moysklad'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  toast,
} from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { formatDateTime, tiyinToSumDisplay } from '@/lib/format'

interface OriginalItem {
  name: string
  classCode: string
  qty: number
  price: number
  discount: number
  vatTiyin: number
  vatPercent: number
}

export default function Refund() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()
  const fiscalId = Number(id)

  const [fiscalReceipt, setFiscalReceipt] = useState<FiscalReceiptRow | null>(null)
  const [items, setItems] = useState<OriginalItem[]>([])
  // Позиции оригинального чека из МойСклад (что покупатель реально купил
  // по кассе МС — до подмены ИКПУ). Кассир сверяет: вернулся именно этот товар.
  const [msPositions, setMsPositions] = useState<
    Array<{ name: string; quantity: number; total: number }>
  >([])
  const [msName, setMsName] = useState<string | null>(null)
  const [existing, setExisting] = useState<FiscalRefundRow | null>(null)
  const [refundState, setRefundState] = useState<RefundState>('none')
  /**
   * Map<originalItemIndex, totalRefundedQtyMilli> — сколько уже вернули
   * по каждой позиции за все предыдущие partial refund'ы.
   * Используется чтобы:
   *   - Сделать cap qty input: max = originalQty - alreadyRefunded
   *   - Показать кассиру badge «уже возвращено N»
   *   - НЕ дать сделать over-refund
   */
  const [alreadyRefundedByIndex, setAlreadyRefundedByIndex] = useState<
    Map<number, number>
  >(new Map())
  const [defaultCash, setDefaultCash] = useState(0)
  const [defaultCard, setDefaultCard] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  // Смена ККМ закрыта — тот же баннер что в Receipt.tsx при фискализации
  // продажи. Отдельно от `error`, чтобы показать понятный баннер с кнопкой
  // «Перейти в Смену» вместо generic-текста formatErrorForUser.
  const [shiftNotOpen, setShiftNotOpen] = useState(false)
  /**
   * Режим возврата:
   *   - 'full' — возвращаем ВСЕ позиции оригинала (default если refund'ов ещё нет)
   *   - 'partial' — кассир выбирает qty по каждой позиции
   *
   * Если есть предыдущие partial refund'ы → автоматически 'partial' (full
   * запрещён в processRefund — нельзя смешивать).
   */
  const [refundMode, setRefundMode] = useState<'full' | 'partial'>('full')
  /**
   * Map<originalItemIndex, qtyMilli> — выбранные qty при partial refund.
   * 0 / отсутствие в map → этот item НЕ возвращаем.
   * Cap (max value) для каждого = originalQty - alreadyRefunded[index].
   */
  const [partialQtyMap, setPartialQtyMap] = useState<Map<number, number>>(
    new Map(),
  )
  /**
   * Синхронный lock против двойного клика «Подтвердить возврат».
   * `setSubmitting(true)` асинхронен — между двумя быстрыми кликами оба
   * обработчика стартуют ДО того как `submitting` стало true. UNIQUE на
   * `original_fiscal_id` в БД защищает локально, НО Communicator получит
   * два refund-запроса параллельно — двойной refund в ОФД, реальная потеря
   * денег. Ref проверяется СИНХРОННО в самом начале doRefund.
   */
  const submitLockRef = useRef(false)

  // Поля формы
  const [refundCashStr, setRefundCashStr] = useState('')
  const [refundCardStr, setRefundCardStr] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    if (!Number.isFinite(fiscalId) || fiscalId <= 0) {
      setError('Некорректный id чека')
      setBusy(false)
      return
    }
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fiscalId])

  async function load() {
    setBusy(true)
    setError(null)
    try {
      // 1. Грузим оригинал.
      const db = await getDb()
      const rows = await db.select<FiscalReceiptRow[]>(
        `SELECT * FROM fiscal_receipts WHERE id = $1 LIMIT 1`,
        [fiscalId],
      )
      const fr = rows[0]
      if (!fr) {
        setError(`Чек id=${fiscalId} не найден`)
        return
      }
      setFiscalReceipt(fr)

      // 2. Парсим request_json чтобы достать items (что ушло в ОФД).
      const parsedItems = parseItemsFromRequestJson(fr.request_json)
      setItems(parsedItems)

      // 2b. Оригинальный чек МойСклад — что покупатель купил по кассе МС
      // (до подмены). Кассир видит исходные позиции и сверяет возврат.
      if (fr.ms_receipt_id) {
        try {
          const msr = await getMsReceipt(fr.ms_receipt_id)
          if (msr) {
            setMsName(msr.ms_name ?? null)
            const rd = JSON.parse(msr.raw_json) as MsRetailDemand
            const pos = extractPositions(rd)
            setMsPositions(
              pos.map((p) => ({
                name: p.name,
                quantity: p.quantity,
                total: p.totalTiyin,
              })),
            )
          }
        } catch {
          // Не критично — просто не покажем оригинал-МС блок.
        }
      }

      // 3. Проверка состояния refund'ов и previous partial-snapshots.
      const state = await getRefundState(fiscalId)
      setRefundState(state)
      const allRefunds = await listRefundsByOriginalFiscalId(fiscalId)
      // FullRefund блокирует UI полностью.
      const fullExisting = allRefunds.find((r) => r.is_partial === 0) ?? null
      setExisting(fullExisting)
      // Подсчёт cumulative qty по предыдущим partial-refund'ам.
      const cumulativeQty = new Map<number, number>()
      for (const r of allRefunds) {
        if (!r.refunded_items_snapshot) continue
        try {
          const snap = JSON.parse(r.refunded_items_snapshot) as Array<{
            originalItemIndex: number
            qtyMilli: number
          }>
          for (const s of snap) {
            cumulativeQty.set(
              s.originalItemIndex,
              (cumulativeQty.get(s.originalItemIndex) ?? 0) + s.qtyMilli,
            )
          }
        } catch {
          /* битый JSON — пропускаем */
        }
      }
      setAlreadyRefundedByIndex(cumulativeQty)
      // Если уже были partial refund'ы → форс-режим partial.
      if (state === 'partial') setRefundMode('partial')

      // 4. Дефолты сумм возврата (= как было оплачено).
      const def = await getDefaultRefundAmounts(fiscalId)
      setDefaultCash(def.cash)
      setDefaultCard(def.card)
      // Пред-заполняем строки в UI — в сумах (не тийинах), для удобства ввода.
      setRefundCashStr(def.cash > 0 ? Math.round(def.cash / 100).toString() : '')
      setRefundCardStr(def.card > 0 ? Math.round(def.card / 100).toString() : '')
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setBusy(false)
    }
  }

  // Парсим суммы из формы в тийины.
  const parsedCash = useMemo(
    () => parseSumToTiyin(refundCashStr),
    [refundCashStr],
  )
  const parsedCard = useMemo(
    () => parseSumToTiyin(refundCardStr),
    [refundCardStr],
  )
  const totalRefundTiyin = parsedCash + parsedCard
  /**
   * Сумма к возврату по выбранным позициям.
   * Full mode: вся сумма оригинала.
   * Partial mode: Σ(item.unit_price × selectedQty / item.originalQty).
   */
  const itemsRefundTotalTiyin = useMemo(() => {
    if (refundMode === 'full') {
      return items.reduce((s, it) => s + it.price - it.discount, 0)
    }
    // partial — пересчёт по qty
    let sum = 0
    items.forEach((it, idx) => {
      const qtySelected = partialQtyMap.get(idx) ?? 0
      if (qtySelected <= 0) return
      const ratio = qtySelected / it.qty
      sum += Math.round((it.price - it.discount) * ratio)
    })
    return sum
  }, [items, partialQtyMap, refundMode])

  // Авто-перезаполнение поля cash/card при изменении itemsRefundTotalTiyin
  // в partial-режиме (чтобы кассиру не приходилось вручную пересчитывать).
  // Применяется только при инициализации partial — после ручного ввода
  // юзер контролирует сам.
  const [partialAmountsManuallyEdited, setPartialAmountsManuallyEdited] =
    useState(false)
  useEffect(() => {
    if (refundMode !== 'partial' || partialAmountsManuallyEdited) return
    // Пропорциональный split: cash = origCash * (refundTotal / origTotal)
    const origTotal = defaultCash + defaultCard
    if (origTotal <= 0 || itemsRefundTotalTiyin <= 0) {
      setRefundCashStr('')
      setRefundCardStr('')
      return
    }
    const ratio = itemsRefundTotalTiyin / origTotal
    const cashTiyin = Math.round(defaultCash * ratio)
    const cardTiyin = itemsRefundTotalTiyin - cashTiyin
    setRefundCashStr(cashTiyin > 0 ? Math.round(cashTiyin / 100).toString() : '')
    setRefundCardStr(cardTiyin > 0 ? Math.round(cardTiyin / 100).toString() : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsRefundTotalTiyin, refundMode])

  const sumMismatch = Math.abs(totalRefundTiyin - itemsRefundTotalTiyin) > 100
  const overRefund = totalRefundTiyin > itemsRefundTotalTiyin
  const noRefund = totalRefundTiyin <= 0 || itemsRefundTotalTiyin <= 0

  async function doRefund() {
    if (!fiscalReceipt) return
    // СИНХРОННЫЙ lock против двойного клика — отрабатывает до любого await,
    // когда setSubmitting ещё не успел зафиксироваться в React state.
    // Без него два клика подряд → два refund в ОФД (реальная потеря денег).
    if (submitLockRef.current) return
    submitLockRef.current = true
    setSubmitting(true)
    setError(null)
    setShiftNotOpen(false)
    try {
      // TOCTOU-защита: между загрузкой страницы и кликом мог пройти большой
      // промежуток времени — другой пользователь/сессия могла оформить refund.
      // Перечитываем существующий refund СИНХРОННО до Communicator. Если упало
      // (БД locked) — не глотаем, абортим: не уверены = не шлём refund.
      let fresh: FiscalRefundRow | null
      try {
        fresh = await getRefundByOriginalFiscalId(fiscalReceipt.id)
      } catch (checkErr) {
        setError(
          'Не удалось проверить существующий возврат: ' +
            formatErrorForUser(checkErr) +
            ' Попробуйте ещё раз.',
        )
        return
      }
      if (fresh) {
        setExisting(fresh)
        toast.error(
          `Этот чек уже был возвращён ранее (FiscalSign ${fresh.fiscal_sign}). ` +
            `Повторный refund запрещён.`,
          { duration: 6000 },
        )
        return
      }
      // Собираем selectedItems если partial-режим (для full передаём undefined).
      const selectedItems =
        refundMode === 'partial'
          ? Array.from(partialQtyMap.entries())
              .filter(([, q]) => q > 0)
              .map(([originalItemIndex, qtyMilli]) => ({
                originalItemIndex,
                qtyMilli,
              }))
          : undefined
      if (refundMode === 'partial' && (!selectedItems || selectedItems.length === 0)) {
        setError('Не выбрана ни одна позиция для возврата. Укажите qty.')
        return
      }
      const res = await processRefund({
        originalFiscalId: fiscalReceipt.id,
        refundCashTiyin: parsedCash,
        refundCardTiyin: parsedCard,
        refundQrTiyin: 0,
        reason: reason.trim() || undefined,
        selectedItems,
      })
      toast.success(`Возврат ${res.fiscal.FiscalSign} проведён`, { duration: 5000 })
      nav('/history')
    } catch (e) {
      if (e instanceof RefundAlreadyExistsError) {
        // Перезагружаем чтобы UI отразил уже-существующий возврат.
        await load()
        toast.error(e.message, { duration: 5000 })
        return
      }
      // Смена не открыта — НЕ generic-ошибка. Раньше (до isShiftClosedError)
      // сюда прилетал сырой JsonRpcEposError с code=36909, и formatEposError
      // (error-message.ts) сам превращал его в понятный текст. Теперь
      // fiscalize.ts/refund.ts бросают типизированный ShiftNotOpenError,
      // который formatErrorForUser не узнаёт и заворачивает в generic
      // «Техническая ошибка: …» fallback — регресс относительно старого
      // поведения. Ловим отдельно, как в Receipt.tsx.
      if (e instanceof ShiftNotOpenError) {
        setShiftNotOpen(true)
        toast.error(e.message, { duration: 6000 })
        return
      }
      setError(formatErrorForUser(e))
    } finally {
      setSubmitting(false)
      submitLockRef.current = false
    }
  }

  if (busy && !fiscalReceipt) {
    return (
      <Card>
        <Card.Body>
          <div className="text-body text-ink-muted">Загрузка чека…</div>
        </Card.Body>
      </Card>
    )
  }

  if (error && !fiscalReceipt) {
    return (
      <Card>
        <Card.Body>
          <EmptyState
            icon={<AlertCircle size={36} />}
            title="Чек не найден"
            description={error}
            action={
              <Button
                onClick={() => nav('/history')}
                icon={<ArrowLeft size={14} />}
              >
                К списку
              </Button>
            }
          />
        </Card.Body>
      </Card>
    )
  }

  if (!fiscalReceipt) return null

  return (
    <div className="space-y-4">
      <PageHeader
        title={`Возврат по чеку №${fiscalReceipt.receipt_seq}`}
        subtitle={`Оригинал · ${formatDateTime(parseFiscalDateTime(fiscalReceipt.fiscal_datetime) || fiscalReceipt.fiscalized_at)} · FiscalSign ${fiscalReceipt.fiscal_sign}`}
        action={
          <div className="flex gap-2">
            <Button
              variant="ghost"
              onClick={() => nav('/history')}
              icon={<ArrowLeft size={14} />}
            >
              Назад
            </Button>
            <Button
              variant="danger"
              icon={<Undo2 size={14} />}
              loading={submitting}
              disabled={
                !!existing ||
                submitting ||
                noRefund ||
                overRefund ||
                items.length === 0
              }
              onClick={doRefund}
            >
              Подтвердить возврат
            </Button>
          </div>
        }
      />

      {existing && (
        <Card className="border-warning/30 bg-warning-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="text-body text-ink">
              <strong className="text-warning">Этот чек уже был возвращён.</strong>{' '}
              {formatDateTime(existing.refunded_at)}. FiscalSign возврата:{' '}
              <span className="font-mono">{existing.fiscal_sign}</span>.
              Повторный возврат невозможен (один продажный чек — один refund).
            </div>
          </Card.Body>
        </Card>
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
                Communicator отказал: возврат невозможен без открытой смены.
                Откройте смену в разделе «Смена», затем повторите возврат.
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

      {error && (
        <Card className="border-danger/20 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="text-body text-danger">{error}</div>
          </Card.Body>
        </Card>
      )}

      {/* Оригинальный чек из МойСклад — что покупатель реально купил
          по кассе МС (до подмены ИКПУ). Кассир сверяет: тот ли товар. */}
      {msPositions.length > 0 && (
        <Card>
          <Card.Header>
            <Card.Title>
              Оригинал из МойСклад{msName ? ` · чек ${msName}` : ''}
            </Card.Title>
            <Card.HeaderAction>
              <Badge variant="info">{msPositions.length} позиций</Badge>
            </Card.HeaderAction>
          </Card.Header>
          <table className="w-full text-body">
            <thead className="border-b border-border bg-canvas">
              <tr>
                <th className="px-3 py-2.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wide">
                  Товар (как в МойСклад)
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
              {msPositions.map((p, i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2.5 text-ink">{p.name}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                    {p.quantity / 1000}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                    {tiyinToSumDisplay(p.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Позиции что реально ушли в ОФД (после подмены) — их и возвращаем */}
      <Card>
        <Card.Header>
          <Card.Title>Что возвращаем (фискальные позиции)</Card.Title>
          <Card.HeaderAction>
            <div className="flex items-center gap-2">
              <Badge variant="info">{items.length} позиций</Badge>
              {/* Toggle режима — disable если уже был partial (нельзя смешивать) */}
              <div className="inline-flex rounded-md border border-border bg-canvas p-0.5 text-caption">
                <button
                  type="button"
                  onClick={() => {
                    setRefundMode('full')
                    setPartialQtyMap(new Map())
                    setPartialAmountsManuallyEdited(false)
                  }}
                  disabled={refundState === 'partial' || !!existing}
                  className={
                    refundMode === 'full'
                      ? 'rounded px-2.5 py-1 bg-primary text-on-primary font-medium'
                      : 'rounded px-2.5 py-1 text-ink-muted hover:text-ink disabled:opacity-40'
                  }
                  title={
                    refundState === 'partial'
                      ? 'Полный возврат недоступен — есть частичные возвраты'
                      : 'Вернуть весь чек целиком'
                  }
                >
                  Полный
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRefundMode('partial')
                    // По дефолту партиал начинает с qty=0 для всех — кассир сам выбирает.
                    setPartialQtyMap(new Map())
                    setPartialAmountsManuallyEdited(false)
                  }}
                  disabled={!!existing}
                  className={
                    refundMode === 'partial'
                      ? 'rounded px-2.5 py-1 bg-primary text-on-primary font-medium'
                      : 'rounded px-2.5 py-1 text-ink-muted hover:text-ink disabled:opacity-40'
                  }
                  title="Выбрать конкретные товары для возврата"
                >
                  Частичный
                </button>
              </div>
            </div>
          </Card.HeaderAction>
        </Card.Header>
        <table className="w-full text-body">
          <thead className="border-b border-border bg-canvas">
            <tr>
              <th className="px-3 py-2.5 text-left text-caption font-medium text-ink-muted uppercase tracking-wide">
                Товар
              </th>
              <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
                {refundMode === 'partial' ? 'Возврат (шт)' : 'Кол-во'}
              </th>
              <th className="px-3 py-2.5 text-right text-caption font-medium text-ink-muted uppercase tracking-wide">
                Сумма
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => {
              const origQtyMilli = it.qty
              const alreadyRefunded = alreadyRefundedByIndex.get(i) ?? 0
              const remainingMilli = Math.max(0, origQtyMilli - alreadyRefunded)
              const selectedQty = partialQtyMap.get(i) ?? 0
              const isFullMode = refundMode === 'full'
              // При partial считаем сумму по qty (пропорционально к unit_price)
              const itemRefundTiyin = isFullMode
                ? it.price - it.discount
                : Math.round(((it.price - it.discount) * selectedQty) / origQtyMilli)

              return (
                <tr key={i} className="border-b border-border last:border-0">
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-ink">{it.name}</div>
                    <div className="font-mono text-caption text-ink-subtle">
                      {it.classCode} · НДС {it.vatPercent}%
                    </div>
                    {alreadyRefunded > 0 && (
                      <div className="mt-0.5 inline-block text-caption text-warning">
                        Уже возвращено: {(alreadyRefunded / 1000).toString()} шт
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums">
                    {isFullMode ? (
                      <span className="text-ink-muted">{it.qty / 1000}</span>
                    ) : (
                      <div className="flex flex-col items-end gap-1">
                        <Input
                          type="number"
                          min={0}
                          max={remainingMilli / 1000}
                          step="any"
                          value={selectedQty > 0 ? selectedQty / 1000 : ''}
                          onChange={(e) => {
                            const v = parseFloat(e.target.value)
                            const milli = isFinite(v)
                              ? Math.round(Math.max(0, v) * 1000)
                              : 0
                            const capped = Math.min(milli, remainingMilli)
                            const next = new Map(partialQtyMap)
                            if (capped <= 0) next.delete(i)
                            else next.set(i, capped)
                            setPartialQtyMap(next)
                            setPartialAmountsManuallyEdited(false)
                          }}
                          disabled={!!existing || remainingMilli <= 0}
                          className="w-24 text-right"
                          placeholder={remainingMilli <= 0 ? '—' : '0'}
                        />
                        <span className="text-caption text-ink-subtle">
                          из {remainingMilli / 1000}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">
                    {it.discount > 0 ? (
                      <div className="space-y-0.5">
                        <div className="text-caption text-ink-subtle line-through">
                          {tiyinToSumDisplay(it.price)}
                        </div>
                        <div className="text-caption text-danger">
                          −{tiyinToSumDisplay(it.discount)}
                        </div>
                        <div className="font-medium">
                          {tiyinToSumDisplay(itemRefundTiyin)}
                        </div>
                      </div>
                    ) : (
                      <span className={isFullMode ? '' : 'font-medium'}>
                        {tiyinToSumDisplay(itemRefundTiyin)}
                      </span>
                    )}
                  </td>
                </tr>
              )
            })}
            <tr className="bg-canvas">
              <td className="px-3 py-2.5 text-right font-medium" colSpan={2}>
                {refundMode === 'partial' ? 'Итого к возврату:' : 'Итого:'}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-ink">
                {tiyinToSumDisplay(itemsRefundTotalTiyin)} сум
              </td>
            </tr>
          </tbody>
        </table>
      </Card>

      {/* Возврат денег */}
      <Card>
        <Card.Header>
          <Card.Title>Возврат денег</Card.Title>
          <Card.HeaderAction>
            <span className="text-caption text-ink-muted">
              По дефолту = как было оплачено
            </span>
          </Card.HeaderAction>
        </Card.Header>
        <Card.Body className="space-y-3">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-caption font-medium text-ink-muted mb-1">
                Наличными, сум
              </label>
              <Input
                type="number"
                min={0}
                value={refundCashStr}
                onChange={(e) => {
                  setRefundCashStr(e.target.value)
                  setPartialAmountsManuallyEdited(true)
                }}
                disabled={!!existing}
              />
              <div className="mt-1 text-xs text-ink-muted">
                Оригинал: {tiyinToSumDisplay(defaultCash)} сум
              </div>
            </div>
            <div>
              <label className="block text-caption font-medium text-ink-muted mb-1">
                На карту (терминал/QR), сум
              </label>
              <Input
                type="number"
                min={0}
                value={refundCardStr}
                onChange={(e) => {
                  setRefundCardStr(e.target.value)
                  setPartialAmountsManuallyEdited(true)
                }}
                disabled={!!existing}
              />
              <div className="mt-1 text-xs text-ink-muted">
                Оригинал: {tiyinToSumDisplay(defaultCard)} сум
              </div>
            </div>
          </div>

          {/* Итог возврата с проверкой суммы */}
          <div className="rounded-md bg-canvas p-3">
            <div className="flex items-center justify-between text-body">
              <span className="text-ink-muted">Итого к возврату:</span>
              <span
                className={`font-semibold tabular-nums ${
                  sumMismatch ? 'text-warning' : 'text-ink'
                }`}
              >
                {tiyinToSumDisplay(totalRefundTiyin)} сум
              </span>
            </div>
            {sumMismatch && (
              <div className="mt-1 text-caption text-warning">
                {overRefund
                  ? `⚠️ Сумма возврата ${tiyinToSumDisplay(totalRefundTiyin)} превышает сумму чека ${tiyinToSumDisplay(itemsRefundTotalTiyin)}. Уменьшите.`
                  : `⚠️ Сумма возврата ${tiyinToSumDisplay(totalRefundTiyin)} меньше суммы чека ${tiyinToSumDisplay(itemsRefundTotalTiyin)} — недовозврат.`}
              </div>
            )}
          </div>

          {/* Причина */}
          <div>
            <label className="block text-caption font-medium text-ink-muted mb-1">
              Причина возврата (опционально, для аудита)
            </label>
            <Input
              type="text"
              placeholder="брак, не подошёл, передумал…"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={!!existing}
            />
          </div>
        </Card.Body>
      </Card>
    </div>
  )
}

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Позиции оригинального фискального чека из request_json. Через единый
 * парсер (@/lib/epos/request-json) — понимает и EPOS (params.Receipt),
 * и FiscalDriveService ({factoryId, receipt}). Раньше знал только EPOS —
 * у FDS-магазинов возврат показывал «0 позиций, сумма чека 0» и блокировался.
 */
function parseItemsFromRequestJson(json: string): OriginalItem[] {
  const norm = parseRequestJsonReceipt(json)
  if (!norm) return []
  return norm.items.map((it) => ({
    name: it.name,
    classCode: it.classCode,
    qty: it.amount,
    price: it.priceTiyin,
    discount: it.discountTiyin,
    vatTiyin: it.vatTiyin,
    vatPercent: it.vatPercent,
  }))
}

function parseSumToTiyin(s: string): number {
  const cleaned = s.replace(/\s/g, '').replace(',', '.').trim()
  if (!cleaned) return 0
  const n = Number.parseFloat(cleaned)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.round(n * 100)
}

function parseFiscalDateTime(s: string): number {
  if (!/^\d{14}$/.test(s)) return 0
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6)) - 1
  const d = Number(s.slice(6, 8))
  const h = Number(s.slice(8, 10))
  const mi = Number(s.slice(10, 12))
  const se = Number(s.slice(12, 14))
  // ВАЖНО: Communicator возвращает время в локальной TZ магазина (Asia/Tashkent
  // +5). Раньше использовали Date.UTC(...) — это интерпретировало строку как
  // UTC, что давало смещение в 5 часов (продажа в 14:00 показывалась как 09:00).
  // Используем локальный конструктор Date — он трактует поля как локальное время.
  return Math.floor(new Date(y, m, d, h, mi, se).getTime() / 1000)
}
