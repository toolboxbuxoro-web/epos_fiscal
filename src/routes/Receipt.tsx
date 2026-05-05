import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  AlertCircle,
  ArrowLeft,
  Banknote,
  Check,
  CreditCard,
  QrCode,
  Send,
  SplitSquareHorizontal,
  TriangleAlert,
} from 'lucide-react'
import {
  getDb,
  getMsReceipt,
  getSetting,
  setMsReceiptStatus,
  SettingKey,
  now,
} from '@/lib/db'
import type { MsReceiptRow } from '@/lib/db/types'
import { buildMatch, extractPositions, type BuildMatchResult } from '@/lib/matcher'
import { fiscalize } from '@/lib/epos'
import { MoyskladClient, inlinePositions, type MsRetailDemand } from '@/lib/moysklad'
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
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fiscalizing, setFiscalizing] = useState(false)
  const [testMode, setTestMode] = useState(false)

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

  const matchedSourceIndexes = useMemo(() => {
    if (!match) return new Set<number>()
    return new Set(match.positions.map((pm) => pm.source.index))
  }, [match])

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
    void load()
  }, [id])

  async function load() {
    setBusy(true)
    setError(null)
    try {
      const r = await getMsReceipt(Number(id))
      if (!r) {
        setError('Чек не найден')
        return
      }
      setReceipt(r)

      let parsed = JSON.parse(r.raw_json) as MsRetailDemand

      // МС в list-запросе не отдаёт inline positions. Если их нет —
      // одиночный GET с expand, обновляем raw_json в БД.
      if (!inlinePositions(parsed)) {
        const basic = await getSetting(SettingKey.MoyskladCredentials)
        const token = basic ? null : await getSetting(SettingKey.MoyskladToken)
        if (basic || token) {
          try {
            const client = new MoyskladClient(
              basic ? { basic } : { token: token! },
            )
            const full = await client.getRetailDemand(parsed.id)
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
      }

      const DEFAULT_TOLERANCE_TIYIN = 100_000
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

      const result = await buildMatch(parsed, {
        toleranceTiyin: tolerance,
        markupPercent,
        roundUpToSum,
        discountForExactSum: discountEnabled,
        maxDiscountPerItemTiyin,
      })
      setMatch(result)

      const test = (await getSetting(SettingKey.TestMode)) === 'true'
      setTestMode(test)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function doFiscalize() {
    if (!match || !receipt) return
    setFiscalizing(true)
    setError(null)
    try {
      const result = await fiscalize(match, { msReceiptId: receipt.id })
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
      setError(e instanceof Error ? e.message : String(e))
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
            <Button
              variant="primary"
              loading={fiscalizing}
              disabled={fiscalizing || match.positions.length === 0}
              onClick={doFiscalize}
              icon={!fiscalizing ? <Send size={14} /> : undefined}
            >
              {testMode ? 'Тестовая фискализация' : 'Фискализировать'}
            </Button>
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

      {testMode && (
        <Card className="border-warning/20 bg-warning-soft">
          <Card.Body className="flex items-start gap-3">
            <TriangleAlert size={18} className="text-warning shrink-0 mt-0.5" />
            <div className="text-body text-ink">
              <strong className="text-warning">Тестовый режим включён.</strong>{' '}
              Фискализация будет имитирована, в ОФД ничего не уйдёт. Чтобы
              пробивать реально — выключите режим в{' '}
              <em className="not-italic font-medium">Admin → Настройки</em>.
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
          title={`Подбор: ${strategyLabel(match.overallStrategy)}`}
          sumTiyin={match.matchedTotalTiyin}
          sumDiff={match.totalDiffTiyin}
        >
          <PositionsTable
            positions={match.positions.flatMap((pm) =>
              pm.candidates.map((c) => ({
                name: c.esfItem.name,
                quantity: c.quantity,
                total: c.priceTiyin - c.discountTiyin,
                discount: c.discountTiyin > 0 ? c.discountTiyin : undefined,
                originalPrice: c.discountTiyin > 0 ? c.priceTiyin : undefined,
                vatPercent: c.esfItem.vat_percent,
                meta: c.esfItem.class_code,
                matched: true,
              })),
            )}
          />
        </Side>
      </div>

      {match.warnings.length > 0 && (
        <Card className="border-warning/20 bg-warning-soft">
          <Card.Header className="border-warning/20">
            <div className="flex items-center gap-2">
              <TriangleAlert size={16} className="text-warning" />
              <Card.Title className="text-warning">Предупреждения</Card.Title>
            </div>
          </Card.Header>
          <Card.Body>
            <ul className="space-y-1.5 text-body text-ink">
              {match.warnings.map((w, i) => (
                <li key={i} className="flex gap-2">
                  <span className="text-warning shrink-0">·</span>
                  <span>{w}</span>
                </li>
              ))}
            </ul>
          </Card.Body>
        </Card>
      )}
    </div>
  )
}

function strategyLabel(s: string): string {
  return (
    {
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
              <div className="font-medium text-ink">{p.name}</div>
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
