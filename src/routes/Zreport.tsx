import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Banknote,
  CreditCard,
  Lock,
  PlayCircle,
  RefreshCw,
  Send,
} from 'lucide-react'
import { Button, Card, EmptyState, PageHeader, StatusBadge } from '@/components/ui'
import { JsonRpcEposClient, type JsonRpcZReportInfo } from '@/lib/epos'
import { getSetting, SettingKey } from '@/lib/db'
import { tiyinToSumDisplay } from '@/lib/format'
import { log } from '@/lib/log'

/**
 * Раздел «Смена ККМ» — данные текущего X/Z-отчёта от Communicator.
 *
 * Источник истины — Communicator (`Api.GetZReportInfo`). Поэтому здесь
 * мы НЕ дублируем счётчики в локальной DB — просто читаем live с ФМ
 * каждые 30 сек.
 *
 * Если смена закрыта (CloseTime непустой или метод вернул null) —
 * показываем баннер «Откройте смену» с одной кнопкой.
 *
 * Все денежные суммы приходят от Communicator в тийинах (× 100 от бумажного).
 */
export default function Zreport() {
  const [info, setInfo] = useState<JsonRpcZReportInfo | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function refresh() {
    setLoading(true)
    setError(null)
    try {
      const url =
        (await getSetting(SettingKey.EposCommunicatorUrl)) ??
        'http://localhost:3448/rpc/api'
      const client = new JsonRpcEposClient({ url })
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
    // Обновляем каждые 30 сек чтобы цифры не протухали
    const id = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(id)
  }, [])

  async function openShift() {
    setBusy(true)
    setError(null)
    try {
      const url =
        (await getSetting(SettingKey.EposCommunicatorUrl)) ??
        'http://localhost:3448/rpc/api'
      const client = new JsonRpcEposClient({ url })
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
    const totalSum = info.TotalSaleCash + info.TotalSaleCard - info.TotalRefundCash - info.TotalRefundCard
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
      const url =
        (await getSetting(SettingKey.EposCommunicatorUrl)) ??
        'http://localhost:3448/rpc/api'
      const client = new JsonRpcEposClient({ url })
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

  return (
    <div className="space-y-4">
      <PageHeader
        title="Смена ККМ"
        subtitle="Данные текущего X/Z-отчёта от EPOS Communicator"
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

      {/* Смена не открыта — кнопка открытия */}
      {!loading && !info && !error && (
        <Card>
          <Card.Body>
            <EmptyState
              icon={<Lock size={48} />}
              title="Смена не открыта"
              description={
                'Чтобы пробивать чеки — откройте смену. Communicator зарегистрирует ' +
                'X-отчёт, после чего фискализация заработает.'
              }
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

      {/* Смена открыта — полный дашборд */}
      {info && (
        <>
          <Card>
            <Card.Header>
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <div className="flex items-center gap-2">
                    <StatusBadge status="success">Смена открыта</StatusBadge>
                    <span className="text-caption text-ink-muted">
                      X-отчёт № {info.Number}
                    </span>
                  </div>
                  <div className="mt-2 text-caption text-ink-muted space-y-0.5">
                    <div>
                      <span className="text-ink-subtle">TerminalID:</span>{' '}
                      <span className="font-mono">{info.TerminalID}</span>
                    </div>
                    <div>
                      <span className="text-ink-subtle">Открыта:</span>{' '}
                      {info.OpenTime}
                    </div>
                    {info.FirstReceiptSeq && (
                      <div>
                        <span className="text-ink-subtle">Чеки №:</span>{' '}
                        {info.FirstReceiptSeq} — {info.LastReceiptSeq}
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  variant="danger"
                  onClick={() => void closeShift()}
                  loading={busy}
                  icon={!busy ? <Send size={14} /> : undefined}
                >
                  Закрыть смену
                </Button>
              </div>
            </Card.Header>
          </Card>

          {/* Сводка по продажам */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <Card>
              <Card.Header>
                <Card.Title>Продажи</Card.Title>
                <Card.Description>За текущую смену</Card.Description>
              </Card.Header>
              <Card.Body className="space-y-3">
                <Stat
                  label="Чеков"
                  value={info.TotalSaleCount.toString()}
                />
                <Stat
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Banknote size={14} /> Наличные
                    </span>
                  }
                  value={`${tiyinToSumDisplay(info.TotalSaleCash)} сум`}
                />
                <Stat
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <CreditCard size={14} /> Карта
                    </span>
                  }
                  value={`${tiyinToSumDisplay(info.TotalSaleCard)} сум`}
                />
                <div className="border-t border-border pt-3">
                  <Stat
                    label={<span className="font-medium">ИТОГО</span>}
                    value={
                      <span className="font-semibold text-lg">
                        {tiyinToSumDisplay(info.TotalSaleCash + info.TotalSaleCard)} сум
                      </span>
                    }
                  />
                </div>
                <Stat
                  label={<span className="text-ink-muted">в т.ч. НДС</span>}
                  value={
                    <span className="text-ink-muted">
                      {tiyinToSumDisplay(info.TotalSaleVAT)} сум
                    </span>
                  }
                />
              </Card.Body>
            </Card>

            {/* Возвраты */}
            <Card>
              <Card.Header>
                <Card.Title>Возвраты</Card.Title>
                <Card.Description>За текущую смену</Card.Description>
              </Card.Header>
              <Card.Body className="space-y-3">
                <Stat
                  label="Чеков"
                  value={info.TotalRefundCount.toString()}
                />
                <Stat
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <Banknote size={14} /> Наличные
                    </span>
                  }
                  value={`${tiyinToSumDisplay(info.TotalRefundCash)} сум`}
                />
                <Stat
                  label={
                    <span className="inline-flex items-center gap-1.5">
                      <CreditCard size={14} /> Карта
                    </span>
                  }
                  value={`${tiyinToSumDisplay(info.TotalRefundCard)} сум`}
                />
                <div className="border-t border-border pt-3">
                  <Stat
                    label={<span className="font-medium">ИТОГО</span>}
                    value={
                      <span className="font-semibold text-lg">
                        {tiyinToSumDisplay(info.TotalRefundCash + info.TotalRefundCard)} сум
                      </span>
                    }
                  />
                </div>
                <Stat
                  label={<span className="text-ink-muted">в т.ч. НДС</span>}
                  value={
                    <span className="text-ink-muted">
                      {tiyinToSumDisplay(info.TotalRefundVAT)} сум
                    </span>
                  }
                />
              </Card.Body>
            </Card>
          </div>

          {/* Чистая выручка */}
          <Card className="bg-canvas">
            <Card.Body>
              <Stat
                label={<span className="font-medium text-body">Чистая выручка за смену</span>}
                value={
                  <span className="font-semibold text-heading text-success">
                    {tiyinToSumDisplay(
                      info.TotalSaleCash +
                        info.TotalSaleCard -
                        info.TotalRefundCash -
                        info.TotalRefundCard,
                    )}{' '}
                    сум
                  </span>
                }
              />
            </Card.Body>
          </Card>

          <div className="text-caption text-ink-muted text-center">
            Данные автоматически обновляются каждые 30 секунд от Communicator.
          </div>
        </>
      )}
    </div>
  )
}

function Stat({
  label,
  value,
}: {
  label: React.ReactNode
  value: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-body text-ink-muted">{label}</span>
      <span className="text-body text-ink tabular-nums">{value}</span>
    </div>
  )
}
