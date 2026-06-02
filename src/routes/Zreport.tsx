import { useEffect, useState } from 'react'
import {
  AlertCircle,
  Lock,
  PlayCircle,
  Printer,
  RefreshCw,
} from 'lucide-react'
import { Button, Card, EmptyState, PageHeader } from '@/components/ui'
import {
  JsonRpcEposClient,
  FiscalDriveClient,
  mapFdsZReportToJsonRpc,
  type JsonRpcZReportInfo,
} from '@/lib/epos'
import { getSetting, SettingKey } from '@/lib/db'
import { tiyinToSumDisplay } from '@/lib/format'
import { log } from '@/lib/log'
import {
  formatTiyinForPrint,
  printZReport,
  type ZReportPrintData,
} from '@/lib/printer'

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
  const [backend, setBackend] = useState<'epos' | 'fiscaldrive'>('epos')

  async function getEposClient() {
    const url =
      (await getSetting(SettingKey.EposCommunicatorUrl)) ??
      'http://localhost:3448/rpc/api'
    return new JsonRpcEposClient({ url })
  }

  async function getFdsClient() {
    const baseUrl =
      (await getSetting(SettingKey.FiscalDriveBaseUrl)) ?? 'http://localhost:3449'
    const factoryId = (await getSetting(SettingKey.FiscalDriveFactoryId)) ?? ''
    return { client: new FiscalDriveClient({ baseUrl }), factoryId }
  }

  /**
   * Получить данные текущей смены через FiscalDriveService.
   *
   * FDS хранит Z-отчёты в памяти НОВЕЙШИМ ПЕРВЫМ — index 0 = текущая смена.
   * Подтверждено реальными данными магазина: ZReportsCount=77, index=76 вернул
   * март (самый старый), значит index=0 = текущий (июнь).
   *
   * FiscalMemory/Info аккумуляторы — НЕ подходят: они накапливаются за всё
   * время жизни ФМ (не сбрасываются при закрытии смены).
   */
  async function getZReportInfoFds(): Promise<JsonRpcZReportInfo> {
    const { client, factoryId } = await getFdsClient()
    const raw = await client.getZReportInfo(factoryId, 0)
    if (!raw) throw new Error('FiscalDriveService: нет данных о смене. Откройте смену.')
    return mapFdsZReportToJsonRpc(raw)
  }

  async function refresh() {
    setLoading(true)
    setError(null)
    const backend = ((await getSetting(SettingKey.FiscalBackend)) ?? 'epos') as 'epos' | 'fiscaldrive'
    setBackend(backend)

    if (backend === 'fiscaldrive') {
      try {
        const data = await getZReportInfoFds()
        setInfo(data)
        setError(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
      return
    }

    // EPOS Communicator — retry до 3 раз (Communicator иногда занят отправкой
    // чека в ОФД и отвечает timeout; падение с первой попытки → юзер видит
    // «не открыта» и жмёт Open, что только ухудшит ситуацию).
    let lastErr: unknown = null
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const client = await getEposClient()
        const data = await client.getZReportInfo()
        setInfo(data)
        setError(null)
        setLoading(false)
        return
      } catch (e) {
        lastErr = e
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 300 * attempt * attempt))
        }
      }
    }
    setError(formatEposError(lastErr, 'getZReportInfo'))
    setLoading(false)
  }

  useEffect(() => {
    void refresh()
    const id = setInterval(() => void refresh(), 30_000)
    return () => clearInterval(id)
  }, [])

  async function openShift() {
    setBusy(true)
    setError(null)
    const backend = (await getSetting(SettingKey.FiscalBackend)) ?? 'epos'
    try {
      if (backend === 'fiscaldrive') {
        // Защита от двойного открытия через FDS
        const existing = await getZReportInfoFds().catch(() => null)
        if (existing && existing.CloseTime === '') {
          await log.info('epos', 'FDS: смена уже открыта — пропускаю openZReport')
          setInfo(existing)
          return
        }
        const { client, factoryId } = await getFdsClient()
        await client.openZReport(factoryId)
        await log.info('epos', 'FDS: смена открыта')
        await refresh()
        return
      }

      // EPOS Communicator — защита от двойного открытия
      const client = await getEposClient()
      const existing = await client.getZReportInfo()
      if (existing && existing.CloseTime === '') {
        await log.info(
          'epos',
          `Смена ${existing.Number} уже открыта — пропускаю openZReport`,
        )
        setInfo(existing)
        return
      }
      await client.openZReport()
      await log.info('epos', 'Смена открыта (X-отчёт стартовал)')
      await refresh()
    } catch (e) {
      const errMsg = formatEposError(e, 'openZReport')
      setError(`Не удалось открыть смену: ${errMsg}`)
      await log.error('epos', `openZReport failed: ${errMsg}`, {
        raw: e instanceof Error ? e.message : String(e),
        json: JSON.stringify(e),
      })
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
    const backend = (await getSetting(SettingKey.FiscalBackend)) ?? 'epos'
    try {
      // Сохраняем info ДО закрытия (после ФМ может вернуть пустой
      // или другую смену) — нам нужно для печати Z-отчёта с теми же тоталами.
      const closingInfo = info
      if (backend === 'fiscaldrive') {
        const { client, factoryId } = await getFdsClient()
        await client.closeZReport(factoryId)
        await log.info('epos', 'FDS: смена закрыта (Z-отчёт)')
        try { await printReport(true) } catch (printErr) {
          const msg = printErr instanceof Error ? printErr.message : String(printErr)
          await log.warn('epos', `Z-отчёт не распечатался: ${msg}`)
        }
        await refresh()
        return
      }
      const client = await getEposClient()
      await client.closeZReport()
      await log.info('epos', `Смена ${closingInfo.Number} закрыта (Z-отчёт)`, {
        zReportNumber: closingInfo.Number,
        receipts: closingInfo.TotalSaleCount,
        totalSale: closingInfo.TotalSaleCash + closingInfo.TotalSaleCard,
      })

      // Auto-печать Z-отчёта на термопринтер. Не ломаем закрытие если
      // печать упала — смена уже закрыта в ОФД, главное.
      try {
        await printReport(true)
      } catch (printErr) {
        const msg = printErr instanceof Error ? printErr.message : String(printErr)
        await log.warn('epos', `Z-отчёт не распечатался: ${msg}`)
      }

      await refresh()
    } catch (e) {
      const errMsg = formatEposError(e, 'closeZReport')
      setError(`Не удалось закрыть смену: ${errMsg}`)
      await log.error('epos', `closeZReport failed: ${errMsg}`, {
        raw: e instanceof Error ? e.message : String(e),
        json: JSON.stringify(e),
      })
    } finally {
      setBusy(false)
    }
  }

  /**
   * Достать максимум информации из ошибки Communicator. Если у JSON-RPC
   * ответа поле `message` пустое — возвращаем `code: N, data: <...>` чтобы
   * в UI и логах была видна хоть какая-то идентификация.
   */
  function formatEposError(e: unknown, ctx: string): string {
    if (!(e instanceof Error)) return String(e) || `${ctx}: неизвестная ошибка`
    const parts: string[] = []
    if (e.message) parts.push(e.message)
    const x = e as { code?: number; data?: unknown }
    if (typeof x.code === 'number') parts.push(`code=${x.code}`)
    if (x.data != null) parts.push(`data=${JSON.stringify(x.data)}`)
    if (parts.length === 0) return `${ctx}: пустой ответ от Communicator`
    return parts.join(' · ')
  }

  /** "DD.MM.YYYY HH:MM:SS" текущее локальное время — для close_time если ФМ не вернул */
  function formatNowUz(): string {
    const d = new Date()
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  /**
   * Распечатать X- или Z-отчёт на термопринтере магазина.
   *
   * Communicator JSON-RPC API НЕ имеет метода печати X-отчёта (проверено
   * curl'ом 4 кандидатов: Api.PrintXReport / PrintZReport / PrintCurrentZReport /
   * PrintZReportInfo — все вернули NO_SUCH_METHOD). Поэтому формируем
   * ESC/POS байты сами через нашу Rust-команду `print_z_report`.
   *
   * @param close `true` = Z-отчёт (после закрытия смены), `false` = X-отчёт.
   */
  async function printReport(close: boolean) {
    if (!info) return
    setBusy(true)
    setError(null)
    try {
      const printerName = (await getSetting(SettingKey.PrinterName)) ?? ''
      if (!printerName) {
        throw new Error(
          'Не настроен принтер чеков. Настройки → Печать чека → Принтер.',
        )
      }
      const company = {
        name: (await getSetting(SettingKey.CompanyName)) ?? '',
        address: (await getSetting(SettingKey.CompanyAddress)) ?? '',
        phone: (await getSetting(SettingKey.CompanyPhone)) ?? '',
        inn: (await getSetting(SettingKey.CompanyInn)) ?? '',
      }
      const totalSaleSum = info.TotalSaleCash + info.TotalSaleCard
      const totalRefundSum = info.TotalRefundCash + info.TotalRefundCard
      const data: ZReportPrintData = {
        is_close: close,
        company,
        city: (await getSetting(SettingKey.MoyskladRetailStoreName)) ?? '',
        report_number: info.Number,
        terminal_id: info.TerminalID,
        open_time: info.OpenTime,
        close_time: close ? info.CloseTime || formatNowUz() : '',
        total_count: info.TotalSaleCount + info.TotalRefundCount,
        sale_count: info.TotalSaleCount,
        refund_count: info.TotalRefundCount,
        first_seq: info.FirstReceiptSeq || '',
        last_seq: info.LastReceiptSeq || '',
        sale_cash_str: formatTiyinForPrint(info.TotalSaleCash),
        sale_card_str: formatTiyinForPrint(info.TotalSaleCard),
        sale_sum_str: formatTiyinForPrint(totalSaleSum),
        sale_vat_str: formatTiyinForPrint(info.TotalSaleVAT),
        refund_cash_str: formatTiyinForPrint(info.TotalRefundCash),
        refund_card_str: formatTiyinForPrint(info.TotalRefundCard),
        refund_sum_str: formatTiyinForPrint(totalRefundSum),
        refund_vat_str: formatTiyinForPrint(info.TotalRefundVAT),
        total_cash_str: formatTiyinForPrint(info.TotalSaleCash - info.TotalRefundCash),
        total_card_str: formatTiyinForPrint(info.TotalSaleCard - info.TotalRefundCard),
        total_sum_str: formatTiyinForPrint(totalSaleSum - totalRefundSum),
        total_vat_str: formatTiyinForPrint(info.TotalSaleVAT - info.TotalRefundVAT),
      }
      await printZReport(printerName, data)
      await log.info(
        'epos',
        `${close ? 'Z' : 'X'}-отчёт распечатан (смена ${info.Number})`,
      )
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(`Не удалось распечатать ${close ? 'Z' : 'X'}-отчёт: ${msg}`)
      await log.error('epos', `printZReport failed: ${msg}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Смена ККМ"
        subtitle={backend === 'fiscaldrive' ? 'Текущий X/Z-отчёт от FiscalDriveService' : 'Текущий X/Z-отчёт от EPOS Communicator'}
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
              onClick={() => void printReport(false)}
              disabled={busy}
              icon={<Printer size={18} />}
              title="Распечатать X-отчёт"
              aria-label="Распечатать X-отчёт"
            >
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
