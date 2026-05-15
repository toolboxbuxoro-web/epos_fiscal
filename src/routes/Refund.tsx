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

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { AlertCircle, ArrowLeft, Undo2 } from 'lucide-react'
import {
  getDb,
  getRefundByOriginalFiscalId,
  type FiscalReceiptRow,
  type FiscalRefundRow,
} from '@/lib/db'
import {
  getDefaultRefundAmounts,
  processRefund,
  RefundAlreadyExistsError,
} from '@/lib/epos'
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
  const [existing, setExisting] = useState<FiscalRefundRow | null>(null)
  const [defaultCash, setDefaultCash] = useState(0)
  const [defaultCard, setDefaultCard] = useState(0)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

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

      // 2. Парсим request_json чтобы достать items.
      const parsedItems = parseItemsFromRequestJson(fr.request_json)
      setItems(parsedItems)

      // 3. Проверка: уже был возврат?
      const ex = await getRefundByOriginalFiscalId(fiscalId)
      setExisting(ex)

      // 4. Дефолты сумм возврата (= как было оплачено).
      const def = await getDefaultRefundAmounts(fiscalId)
      setDefaultCash(def.cash)
      setDefaultCard(def.card)
      // Пред-заполняем строки в UI — в сумах (не тийинах), для удобства ввода.
      setRefundCashStr(def.cash > 0 ? Math.round(def.cash / 100).toString() : '')
      setRefundCardStr(def.card > 0 ? Math.round(def.card / 100).toString() : '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
  const originalTotalTiyin = useMemo(
    () => items.reduce((s, it) => s + it.price - it.discount, 0),
    [items],
  )

  const sumMismatch = totalRefundTiyin !== originalTotalTiyin
  const overRefund = totalRefundTiyin > originalTotalTiyin
  const noRefund = totalRefundTiyin <= 0

  async function doRefund() {
    if (!fiscalReceipt) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await processRefund({
        originalFiscalId: fiscalReceipt.id,
        refundCashTiyin: parsedCash,
        refundCardTiyin: parsedCard,
        refundQrTiyin: 0,
        reason: reason.trim() || undefined,
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
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
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

      {error && (
        <Card className="border-danger/20 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="text-body text-danger">{error}</div>
          </Card.Body>
        </Card>
      )}

      {/* Позиции оригинала */}
      <Card>
        <Card.Header>
          <Card.Title>Что возвращаем</Card.Title>
          <Card.HeaderAction>
            <Badge variant="info">{items.length} позиций</Badge>
          </Card.HeaderAction>
        </Card.Header>
        <table className="w-full text-body">
          <thead className="border-b border-border bg-canvas">
            <tr>
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
            {items.map((it, i) => (
              <tr key={i} className="border-b border-border last:border-0">
                <td className="px-3 py-2.5">
                  <div className="font-medium text-ink">{it.name}</div>
                  <div className="font-mono text-caption text-ink-subtle">
                    {it.classCode} · НДС {it.vatPercent}%
                  </div>
                </td>
                <td className="px-3 py-2.5 text-right tabular-nums text-ink-muted">
                  {it.qty / 1000}
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
                        {tiyinToSumDisplay(it.price - it.discount)}
                      </div>
                    </div>
                  ) : (
                    tiyinToSumDisplay(it.price)
                  )}
                </td>
              </tr>
            ))}
            <tr className="bg-canvas">
              <td className="px-3 py-2.5 text-right font-medium" colSpan={2}>
                Итого:
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums font-semibold text-ink">
                {tiyinToSumDisplay(originalTotalTiyin)} сум
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
                onChange={(e) => setRefundCashStr(e.target.value)}
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
                onChange={(e) => setRefundCardStr(e.target.value)}
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
                  ? `⚠️ Сумма возврата ${tiyinToSumDisplay(totalRefundTiyin)} превышает сумму чека ${tiyinToSumDisplay(originalTotalTiyin)}. Уменьшите.`
                  : `⚠️ Сумма возврата ${tiyinToSumDisplay(totalRefundTiyin)} меньше суммы чека ${tiyinToSumDisplay(originalTotalTiyin)} — недовозврат.`}
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

interface RpcReceiptShape {
  Items?: Array<{
    Name?: string
    spic?: string
    ClassCode?: string
    Amount?: number
    Price?: number
    Discount?: number
    VAT?: number
    VATPercent?: number
  }>
  ReceivedCash?: number
  ReceivedCard?: number
}

function parseItemsFromRequestJson(json: string): OriginalItem[] {
  try {
    const parsed = JSON.parse(json) as { params?: { Receipt?: RpcReceiptShape } }
    const receipt = parsed?.params?.Receipt
    if (!receipt?.Items) return []
    return receipt.Items.map((it) => ({
      name: it.Name ?? '',
      classCode: it.spic ?? it.ClassCode ?? '',
      qty: it.Amount ?? 1000,
      price: it.Price ?? 0,
      discount: it.Discount ?? 0,
      vatTiyin: it.VAT ?? 0,
      vatPercent: it.VATPercent ?? 0,
    }))
  } catch {
    return []
  }
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
  return Math.floor(Date.UTC(y, m, d, h, mi, se) / 1000)
}
