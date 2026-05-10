import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Lock,
  PlayCircle,
  Printer,
  RefreshCw,
} from 'lucide-react'
import { Button, Card, EmptyState, PageHeader } from '@/components/ui'
import { JsonRpcEposClient, type JsonRpcZReportInfo } from '@/lib/epos'
import { getSetting, SettingKey } from '@/lib/db'
import { tiyinToSumDisplay } from '@/lib/format'
import { log } from '@/lib/log'

/**
 * Раздел «Смена ККМ» — данные текущего X/Z-отчёта от Communicator.
 *
 * UI повторяет стиль E-POS Cashdesk: 4 блока в сетке 2×2 (Z-отчёт/ФМ
 * слева сверху, чеки справа сверху, продажи слева снизу, возвраты справа
 * снизу) + большая кнопка «Закрыть смену» с кнопкой печати X-отчёта.
 *
 * Источник истины — Communicator (`Api.GetZReportInfo`). Поэтому здесь
 * мы НЕ дублируем счётчики в локальной DB — просто читаем live с ФМ
 * каждые 30 сек.
 *
 * Все денежные суммы приходят от Communicator в тийинах (× 100 от бумажного).
 */
export default function Zreport() {
  const [info, setInfo] = useState<JsonRpcZReportInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function getClient() {
    const url =
      (await getSetting(SettingKey.EposCommunicatorUrl)) ??
      'http://localhost:3448/rpc/api'
    return new JsonRpcEposClient({ url })
  }

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const client = await getClient()
      const data = await client.getZReportInfo()
      setInfo(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(id)
  }, [])

  async function openShift() {
    setBusy(true)
    setError(null)
    try {
      const client = await getClient()
      await client.openZReport()
      await log.info('epos', 'Смена открыта (X-отчёт стартовал)')
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Не удалось открыть смену: ${msg}`)
      await log.error('epos', `openZReport failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  async function closeShift() {
    if (!info) return
    const totalSum =
      info.TotalSaleCash +
      info.TotalSaleCard -
      info.TotalRefundCash -
      info.TotalRefundCard
    const ok = confirm(
      `Закрыть смену? Будет напечатан Z-отчёт и отправлен в ОФД.\n\n` +
        `Чеков: ${info.TotalSaleCount} продаж, ${info.TotalRefundCount} возвратов\n` +
        `Сумма: ${tiyinToSumDisplay(totalSum)} сум\n\n` +
        `Открыть новую смену можно потом кнопкой «Открыть смену».`,
    )
    if (!ok) return

    setBusy(true)
    setError(null)
    try {
      const client = await getClient()
      await client.closeZReport()
      await log.info('epos', `Смена ${info.Number} закрыта (Z-отчёт)`, {
        zReportNumber: info.Number,
        receipts: info.TotalSaleCount,
        totalSale: info.TotalSaleCash + info.TotalSaleCard,
      })
      await refresh()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Не удалось закрыть смену: ${msg}`)
      await log.error('epos', `closeZReport failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  async function printXReport() {
    setBusy(true)
    setError(null)
    try {
      const client = await getClient()
      await client.printXReport()
      await log.info('epos', `X-отчёт распечатан (смена ${info?.Number})`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Не удалось распечатать X-отчёт: ${msg}`)
      await log.error('epos', `printXReport failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Смена ККМ"
        subtitle="Текущий X/Z-отчёт от EPOS Communicator"
        action={
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            icon={<RefreshCw size={14} className={loading ? 'animate-spin' : ''} />}
          >
            Обновить
          </Button>
        }
      />

      {error && (
        <Card className="border-danger/20 bg-danger-soft">
          <Card.Body className="flex items-start gap-3">
            <AlertCircle size={18} className="text-danger shrink-0 mt-0.5" />
            <div className="text-body text-danger">{error}</div>
          </Card.Body>
        </Card>
      )}

      {/* Смена не открыта */}
      {!loading && !info && !error && (
        <Card>
          <Card.Body>
            <EmptyState
              icon={<Lock size={48} />}
              title="Смена не открыта"
              description="Чтобы пробивать чеки — откройте смену. Communicator зарегистрирует X-отчёт, после чего фискализация заработает."
              action={
                <Button
                  variant="primary"
                  onClick={() => void openShift()}
                  loading={busy}
                  icon={!busy ? <PlayCircle size={16} /> : undefined}
                >
                  Открыть смену
                </Button>
              }
            />
          </Card.Body>
        </Card>
      )}

      {/* Смена открыта — дашборд */}
      {info && (
        <>
          {/* Заголовок-баннер */}
          <div className="text-center py-2">
            <h2 className="text-heading text-ink">
              Смена открыта{' '}
              <span className="font-medium">{formatHeaderDate(info.OpenTime)}</span>
            </h2>
          </div>

          {/* Сетка 2×2: инфо | чеки / продажи | возвраты */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {/* Информация о смене */}
            <Card>
              <Card.Body className="space-y-3">
                <Row label="Номер текущего Z-отчёта" value={info.Number.toString()} bold />
                <Row label="Номер фискального модуля" value={info.TerminalID} mono />
                <Row label="Время открытия смены" value={formatRowDate(info.OpenTime)} />
                <Row
                  label="Время закрытия смены"
                  value={info.CloseTime ? formatRowDate(info.CloseTime) : '—'}
                  muted={!info.CloseTime}
                />
              </Card.Body>
            </Card>

            {/* Чеки */}
            <Card>
              <Card.Header>
                <div className="flex items-center justify-between">
                  <Card.Title>Чеки</Card.Title>
                  <span className="text-heading font-semibold text-ink tabular-nums">
                    {info.TotalSaleCount + info.TotalRefundCount}
                  </span>
                </div>
              </Card.Header>
              <Card.Body className="space-y-3">
                <Row
                  label="Номер первого чека"
                  value={info.FirstReceiptSeq || '—'}
                  mono
                />
                <Row
                  label="Номер последнего чека"
                  value={info.LastReceiptSeq || '—'}
                  mono
                />
                <Row
                  label="Количество возвращённых чеков"
                  value={info.TotalRefundCount.toString()}
                />
              </Card.Body>
            </Card>

            {/* Продажи */}
            <Card>
              <Card.Header>
                <div className="flex items-center justify-between">
                  <Card.Title>Продажи</Card.Title>
                  <span className="text-heading font-semibold text-ink tabular-nums">
                    {info.TotalSaleCount}
                  </span>
                </div>
              </Card.Header>
              <Card.Body className="space-y-3">
                <Row
                  label="Общая сумма (наличные)"
                  value={`${tiyinToSumDisplay(info.TotalSaleCash)} сум`}
                />
                <Row
                  label="Общая сумма (карта)"
                  value={`${tiyinToSumDisplay(info.TotalSaleCard)} сум`}
                />
                <div className="border-t border-border pt-3">
                  <Row
                    label="Общая сумма"
                    value={`${tiyinToSumDisplay(info.TotalSaleCash + info.TotalSaleCard)} сум`}
                    bold
                  />
                </div>
                <Row
                  label="Общая сумма НДС"
                  value={`${tiyinToSumDisplay(info.TotalSaleVAT)} сум`}
                  muted
                />
              </Card.Body>
            </Card>

            {/* Возвраты */}
            <Card>
              <Card.Header>
                <div className="flex items-center justify-between">
                  <Card.Title>Возвраты</Card.Title>
                  <span className="text-heading font-semibold text-ink tabular-nums">
                    {info.TotalRefundCount}
                  </span>
                </div>
              </Card.Header>
              <Card.Body className="space-y-3">
                <Row
                  label="Общая сумма (наличные)"
                  value={`${tiyinToSumDisplay(info.TotalRefundCash)} сум`}
                />
                <Row
                  label="Общая сумма (карта)"
                  value={`${tiyinToSumDisplay(info.TotalRefundCard)} сум`}
                />
                <div className="border-t border-border pt-3">
                  <Row
                    label="Общая сумма"
                    value={`${tiyinToSumDisplay(info.TotalRefundCash + info.TotalRefundCard)} сум`}
                    bold
                  />
                </div>
                <Row
                  label="Общая сумма НДС"
                  value={`${tiyinToSumDisplay(info.TotalRefundVAT)} сум`}
                  muted
                />
              </Card.Body>
            </Card>
          </div>

          {/* Кнопки внизу — большая «Закрыть смену» + иконка принтера */}
          <div className="flex items-center gap-3 pt-2">
            <Button
              variant="primary"
              size="lg"
              className="flex-1"
              onClick={() => void closeShift()}
              loading={busy}
            >
              Закрыть смену
            </Button>
            <Button
              variant="secondary"
              size="lg"
              onClick={() => void printXReport()}
              disabled={busy}
              icon={<Printer size={18} />}
              title="Распечатать X-отчёт"
              aria-label="Распечатать X-отчёт"
            >
              {/* только иконка */}
              <span className="sr-only">Распечатать X-отчёт</span>
            </Button>
          </div>

          <div className="text-caption text-ink-muted text-center">
            Данные обновляются каждые 30 сек напрямую из Communicator.
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Строка-таблица: «label …………… value» с tabular-nums для денежных чисел.
 */
function Row({
  label,
  value,
  bold = false,
  muted = false,
  mono = false,
}: {
  label: string
  value: string
  bold?: boolean
  muted?: boolean
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className={`text-body ${muted ? 'text-ink-muted' : 'text-ink-muted'}`}>
        {label}
      </span>
      <span
        className={`text-body tabular-nums ${
          mono ? 'font-mono text-caption' : ''
        } ${bold ? 'font-semibold text-ink' : muted ? 'text-ink-subtle' : 'text-ink'}`}
      >
        {value}
      </span>
    </div>
  )
}

/**
 * "2026-05-10 08:57:23" → "10 мая 2026 08:57"
 */
function formatHeaderDate(s: string): string {
  if (!s) return '—'
  const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!m) return s
  const [, y, mm, dd, h, min] = m
  const months = [
    'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
  ]
  const monthIdx = parseInt(mm!, 10) - 1
  return `${parseInt(dd!, 10)} ${months[monthIdx]} ${y} ${h}:${min}`
}

/**
 * "2026-05-10 08:57:23" → "10.05.2026 08:57" (для блока с инфо).
 */
function formatRowDate(s: string): string {
  if (!s) return '—'
  const m = s.match(/(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/)
  if (!m) return s
  const [, y, mm, dd, h, min] = m
  return `${dd}.${mm}.${y} ${h}:${min}`
}
