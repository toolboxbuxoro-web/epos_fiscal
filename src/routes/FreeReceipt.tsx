import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banknote, CreditCard, ListPlus, Send, Split, Wand2 } from 'lucide-react'
import { loadMatcherPool, planHolistic } from '@/lib/matcher'
import { loadMatcherOptionsFromSettings } from '@/lib/matcher/options-from-settings'
import type { HolisticPlan, MatcherOptions } from '@/lib/matcher/types'
import {
  buildFreeMatchResult,
  buildSyntheticMsReceipt,
  resolvePayment,
  type FreePayKind,
} from '@/lib/free-receipt'
import { syncFromServer } from '@/lib/inventory'
import {
  fiscalize,
  CardNotConnectedError,
  InventoryConflictError,
  ShiftNotOpenError,
} from '@/lib/epos'
import { getSetting, SettingKey } from '@/lib/db'
import { formatErrorForUser } from '@/lib/error-message'
import { tiyinToSumDisplay } from '@/lib/format'
import { log } from '@/lib/log'
import { Badge, Button, Card, PageHeader, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import { ManualReceiptModal } from './Receipt/ManualReceiptModal'

/**
 * Чек по сумме — фискализация без документа в МойСклад.
 *
 * Зачем: продажа не всегда проходит через МС (разовая сделка, МС недоступен,
 * продажа мимо кассовой программы), а чек пробить всё равно нужно. Кассир
 * вводит сумму, товары подбираются по тем же правилам, что и обычно.
 *
 * Устроено поверх существующего: подбор — тот же `planHolistic`, ручная
 * правка — та же модалка «Собрать вручную», отправка — тот же `fiscalize`.
 * Своего здесь только синтетический чек МС (см. `lib/free-receipt.ts`),
 * благодаря которому история, возвраты и выгрузка продаж работают без правок.
 */
export default function FreeReceipt() {
  const navigate = useNavigate()

  const [sumInput, setSumInput] = useState('')
  const [payKind, setPayKind] = useState<FreePayKind>('cash')
  /** Наличная часть при смешанной оплате, в сумах (карта — остаток). */
  const [cashPartInput, setCashPartInput] = useState('')
  const [cardKind, setCardKind] = useState<'fiz' | 'corp'>('fiz')
  const [opts, setOpts] = useState<MatcherOptions>({})
  const [plan, setPlan] = useState<HolisticPlan | null>(null)
  /**
   * Идентификатор синтетического чека. Создаётся ОДИН раз на собранный план,
   * а не при каждом нажатии «Фискализировать».
   *
   * По нему идёт резерв остатков на сервере, и он же — ключ идемпотентности.
   * Генерируй мы его на каждый клик, двойное нажатие дало бы два разных чека
   * в ОФД на одну продажу: в обычной кассе от этого защищает привязка к чеку
   * МойСклад, а здесь её нет.
   */
  const [receiptUid, setReceiptUid] = useState<string | null>(null)
  const [planning, setPlanning] = useState(false)
  const [fiscalizing, setFiscalizing] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [testMode, setTestMode] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      setOpts(await loadMatcherOptionsFromSettings())
      setTestMode((await getSetting(SettingKey.TestMode)) === 'true')
    })()
  }, [])

  // Сумма вводится в сумах — так её называет кассир и так она написана на
  // ценнике. Внутри везде тийины.
  const targetTiyin = Math.round((Number.parseFloat(sumInput.replace(',', '.')) || 0) * 100)
  const sumValid = targetTiyin > 0

  /** Свежий пул: локальный кэш мог разойтись с сервером. */
  async function freshPool() {
    try {
      await syncFromServer({ forceFull: true })
    } catch {
      // Синк не удался — работаем с тем, что есть. Показать кассиру
      // устаревшие остатки лучше, чем не показать ничего.
    }
    return loadMatcherPool(opts)
  }

  async function autoPlan() {
    if (!sumValid) return
    setPlanning(true)
    setError(null)
    try {
      const pool = await freshPool()
      const outcome = planHolistic(targetTiyin, pool, opts)
      if (!outcome.ok) {
        setPlan(null)
        setError(rejectReason(outcome.reason, outcome.detail))
        return
      }
      setPlan(outcome.plan)
      setReceiptUid(crypto.randomUUID())
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setPlanning(false)
    }
  }

  async function doFiscalize() {
    if (!plan || !sumValid || !receiptUid || fiscalizing) return
    setFiscalizing(true)
    setError(null)
    try {
      const receipt = buildSyntheticMsReceipt({
        sumTiyin: plan.totalTiyin,
        payment,
        nowMs: Date.now(),
        uid: receiptUid,
      })

      await log.info('fiscalize', `Чек по сумме: ${tiyinToSumDisplay(plan.totalTiyin)}`, {
        lines: plan.lines.length,
        payKind,
        cash: payment.cashTiyin,
        card: payment.cardTiyin,
      })

      const result = await fiscalize(buildFreeMatchResult(receipt, plan), {
        receivedCash: payment.cashTiyin,
        receivedCard: payment.cardTiyin,
        cardKind: cardInvolved ? cardKind : undefined,
      })

      toast.success(
        testMode
          ? 'Тестовый режим: чек напечатан, в ОФД не отправлен'
          : `Чек пробит: ${result.fiscal.FiscalSign}`,
        { duration: 6000 },
      )
      navigate('/history')
    } catch (e) {
      if (e instanceof ShiftNotOpenError) {
        setError(e.message)
        toast.error('Смена ККМ не открыта', { duration: 6000 })
        return
      }
      if (e instanceof CardNotConnectedError) {
        setError(e.message)
        toast.error('Фискальная карта не отвечает — нажмите ещё раз', { duration: 8000 })
        return
      }
      if (e instanceof InventoryConflictError) {
        // Остатки разошлись, пока кассир собирал чек. План устарел —
        // пересобираем, иначе повтор упрётся в ту же нехватку.
        setPlan(null)
        setReceiptUid(null)
        setError('Остатки изменились — товар разобрали. Подберите заново.')
        return
      }
      setError(formatErrorForUser(e))
    } finally {
      setFiscalizing(false)
    }
  }

  const planTotal = plan?.totalTiyin ?? 0
  const diff = planTotal - targetTiyin

  const cashPartTiyin = Math.round(
    (Number.parseFloat(cashPartInput.replace(',', '.')) || 0) * 100,
  )
  const payment = resolvePayment(payKind, planTotal, cashPartTiyin)
  // Показ и смысл разведены намеренно.
  //
  // Селектор показываем сразу при выборе «Карта» или «Смешанная» — иначе он
  // появлялся бы только после сборки плана (до неё итог равен нулю, а значит и
  // карточная часть тоже), и кассир решил бы, что тип карты выбрать негде.
  //
  // А В ОФД тип уходит только когда карточная часть реально есть: при
  // смешанной оплате кассир может ввести всю сумму наличными, и тогда никакой
  // карты в чеке нет.
  const showCardKind = payKind === 'card' || payKind === 'mixed'
  const cardInvolved = payment.cardTiyin > 0

  return (
    <div className="space-y-4">
      <PageHeader
        title="Чек по сумме"
        subtitle="Фискализация без документа из МойСклад"
      />

      {testMode && (
        <Card>
          <Card.Body className="text-body text-warning">
            Тестовый режим включён — чек напечатается, но в ОФД не уйдёт.
          </Card.Body>
        </Card>
      )}

      <Card>
        <Card.Body className="space-y-4">
          <div>
            <label className="mb-1.5 block text-body font-medium">Сумма чека</label>
            <div className="flex items-center gap-2">
              <Input
                value={sumInput}
                onChange={(e) => {
                  setSumInput(e.target.value.replace(/[^\d.,]/g, ''))
                  setPlan(null)
                  setReceiptUid(null)
                }}
                placeholder="0"
                inputMode="decimal"
                className="max-w-[220px] text-right text-lg"
              />
              <span className="text-ink-muted">сум</span>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-body font-medium">Оплата</label>
            <div className="flex gap-2">
              <PayButton
                active={payKind === 'cash'}
                onClick={() => setPayKind('cash')}
                icon={<Banknote size={16} />}
                label="Наличные"
              />
              <PayButton
                active={payKind === 'card'}
                onClick={() => setPayKind('card')}
                icon={<CreditCard size={16} />}
                label="Карта"
              />
              <PayButton
                active={payKind === 'mixed'}
                onClick={() => setPayKind('mixed')}
                icon={<Split size={16} />}
                label="Смешанная"
              />
            </div>
          </div>

          {payKind === 'mixed' && (
            <div>
              <label className="mb-1.5 block text-body font-medium">
                Наличными
                <span className="ml-1 font-normal text-ink-muted">
                  — остальное спишется на карту
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={cashPartInput}
                  onChange={(e) => setCashPartInput(e.target.value.replace(/[^\d.,]/g, ''))}
                  placeholder="0"
                  inputMode="decimal"
                  className="max-w-[180px] text-right"
                />
                <span className="text-ink-muted">сум</span>
                {plan && (
                  <span className="text-body text-ink-muted">
                    → картой {tiyinToSumDisplay(payment.cardTiyin)}
                  </span>
                )}
              </div>
              {plan && cashPartTiyin > planTotal && (
                // Не блокируем: сумма чека могла уменьшиться при пересборе
                // плана, и переписывать введённое за кассира — хуже, чем
                // показать, что именно уйдёт в ОФД.
                <div className="mt-1.5 text-caption text-warning">
                  Больше итога чека — наличными уйдёт{' '}
                  {tiyinToSumDisplay(payment.cashTiyin)}, картой 0.
                </div>
              )}
            </div>
          )}

          {showCardKind && (
            <div>
              <label className="mb-1.5 block text-body font-medium">
                Тип карты
                <span className="ml-1 font-normal text-ink-muted">
                  — уходит в ОФД и печатается на чеке
                </span>
              </label>
              <div className="flex gap-2">
                <PayButton
                  active={cardKind === 'fiz'}
                  onClick={() => setCardKind('fiz')}
                  label="Шахсий (физлицо)"
                />
                <PayButton
                  active={cardKind === 'corp'}
                  onClick={() => setCardKind('corp')}
                  label="Корпоратив"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              onClick={autoPlan}
              loading={planning}
              disabled={!sumValid}
              icon={<Wand2 size={16} />}
            >
              Подобрать
            </Button>
            <Button
              variant="secondary"
              onClick={() => setManualOpen(true)}
              disabled={!sumValid || planning}
              icon={<ListPlus size={16} />}
            >
              Собрать вручную
            </Button>
          </div>
        </Card.Body>
      </Card>

      {error && (
        <Card>
          <Card.Body className="text-body text-danger">{error}</Card.Body>
        </Card>
      )}

      {plan && (
        <Card>
          <Card.Header>
            <Card.Title>
              Подобрано: {plan.lines.length} {plural(plan.lines.length)}
            </Card.Title>
            <Card.HeaderAction>
              <div className="flex items-center gap-2">
                <span className="text-body font-medium">{tiyinToSumDisplay(planTotal)}</span>
                {diff !== 0 && (
                  <Badge variant={diff > 0 ? 'warning' : 'danger'}>
                    {diff > 0 ? '+' : ''}
                    {tiyinToSumDisplay(diff)}
                  </Badge>
                )}
              </div>
            </Card.HeaderAction>
          </Card.Header>
          <Card.Body className="p-0">
            <table className="w-full text-body">
              <thead className="border-b border-line text-caption text-ink-muted">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">Товар</th>
                  <th className="px-4 py-2 text-right font-medium">Кол-во</th>
                  <th className="px-4 py-2 text-right font-medium">Сумма</th>
                </tr>
              </thead>
              <tbody>
                {plan.lines.map((line, i) => (
                  <tr key={i} className="border-b border-line/60 last:border-0">
                    <td className="px-4 py-2">
                      <div>{line.esfItem.name}</div>
                      <div className="text-caption text-ink-muted">
                        {line.esfItem.class_code || '— нет ИКПУ —'} · НДС{' '}
                        {line.esfItem.vat_percent}%
                      </div>
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {Math.round(line.quantity / 1000)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums">
                      {tiyinToSumDisplay(line.priceTiyin - line.discountTiyin)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card.Body>
          <Card.Footer>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                onClick={doFiscalize}
                loading={fiscalizing}
                icon={<Send size={16} />}
              >
                {testMode ? 'Напечатать (тест)' : 'Фискализировать'}
              </Button>
              {/* Что именно уйдёт в ОФД — видно до нажатия, а не после. */}
              <span className="text-body text-ink-muted">
                {payment.cashTiyin > 0 && `наличными ${tiyinToSumDisplay(payment.cashTiyin)}`}
                {payment.cashTiyin > 0 && payment.cardTiyin > 0 && ' · '}
                {payment.cardTiyin > 0 &&
                  `картой ${tiyinToSumDisplay(payment.cardTiyin)}` +
                    (cardKind === 'corp' ? ' (Корпоратив)' : ' (Шахсий)')}
              </span>
            </div>
          </Card.Footer>
        </Card>
      )}

      {manualOpen && sumValid && (
        <ManualReceiptModal
          targetTiyin={targetTiyin}
          loadPool={freshPool}
          opts={opts}
          initialLines={(plan?.lines ?? []).map((l) => ({
            esfItemId: l.esfItem.id,
            qtyPcs: Math.round(l.quantity / 1000),
          }))}
          onClose={() => setManualOpen(false)}
          onDone={(built) => {
            setPlan(built)
            setReceiptUid((prev) => prev ?? crypto.randomUUID())
            setManualOpen(false)
            toast.success(
              `Собрано вручную: ${built.lines.length} ${plural(built.lines.length)} на ` +
                tiyinToSumDisplay(built.totalTiyin),
              { duration: 4000 },
            )
          }}
        />
      )}
    </div>
  )
}

function PayButton(props: {
  active: boolean
  onClick: () => void
  label: string
  icon?: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        'flex items-center gap-2 rounded-lg border px-3 py-2 text-body transition',
        props.active
          ? 'border-primary bg-primary-soft text-primary'
          : 'border-line text-ink hover:bg-surface-muted',
      )}
    >
      {props.icon}
      {props.label}
    </button>
  )
}

function plural(n: number): string {
  return n === 1 ? 'товар' : 'товаров'
}

/** Человекочитаемая причина, почему подбор не сошёлся. */
function rejectReason(reason: string, detail: string): string {
  switch (reason) {
    case 'POOL_EMPTY':
      return 'На складе нет приходов с ИКПУ — подобрать не из чего. Проверьте Справочник.'
    case 'TARGET_TOO_SMALL':
      return 'Сумма меньше самого дешёвого товара на складе.'
    case 'INSUFFICIENT_POOL':
      return 'На складе не хватает товара на эту сумму. Уменьшите сумму или дозаполните приходы.'
    case 'TOO_MANY_LINES':
      return 'Чтобы набрать эту сумму, нужно слишком много позиций. Попробуйте собрать вручную.'
    default:
      return `Подбор не сошёлся (${reason}): ${detail}`
  }
}
