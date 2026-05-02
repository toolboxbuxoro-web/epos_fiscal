import { useEffect, useState } from 'react'
import {
  getAllSettings,
  listFiscalReceipts,
  SettingKey,
  type FiscalReceiptRow,
} from '@/lib/db'
import { formatDateTime } from '@/lib/format'
import {
  formatPrintDate,
  formatQtyForPrint,
  formatTiyinForPrint,
  printFiscalReceipt,
  type ReceiptData,
} from '@/lib/printer'
import { Button } from '@/components/ui/Button'

export default function History() {
  const [rows, setRows] = useState<FiscalReceiptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** id чека → сообщение результата перепечати (для inline-фидбека). */
  const [printMsg, setPrintMsg] = useState<Record<number, string>>({})
  /** id чека → busy-флаг (чтобы не дёргать дважды). */
  const [printing, setPrinting] = useState<Record<number, boolean>>({})

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const list = await listFiscalReceipts(200)
      setRows(list)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  /**
   * Перепечатать ранее фискализированный чек как копию ("Chek nusxasi").
   *
   * Реконструирует данные чека из request_json (это то что мы отправили
   * в Communicator — Items, ReceivedCash, ReceivedCard) + Settings
   * (реквизиты компании). Данные идентичны попавшим в ОФД, печатается
   * точная копия с QR.
   */
  async function reprintQr(receipt: FiscalReceiptRow) {
    setPrintMsg((m) => ({ ...m, [receipt.id]: '' }))
    setPrinting((p) => ({ ...p, [receipt.id]: true }))
    try {
      const settings = await getAllSettings()
      const printerName = settings[SettingKey.PrinterName]
      if (!printerName) {
        setPrintMsg((m) => ({
          ...m,
          [receipt.id]: '✗ Принтер не выбран в Настройках → Печать чека',
        }))
        return
      }

      const data = buildReceiptDataFromHistory(receipt, settings)
      const jobId = await printFiscalReceipt(printerName, data)
      setPrintMsg((m) => ({
        ...m,
        [receipt.id]: `✓ Копия отправлена (job #${jobId})`,
      }))
    } catch (e) {
      setPrintMsg((m) => ({
        ...m,
        [receipt.id]: `✗ ${e instanceof Error ? e.message : String(e)}`,
      }))
    } finally {
      setPrinting((p) => ({ ...p, [receipt.id]: false }))
    }
  }

  function parseFiscalDateTime(s: string): number {
    // Формат YYYYMMDDHHMMSS → epoch sec
    if (!/^\d{14}$/.test(s)) return 0
    const y = Number(s.slice(0, 4))
    const m = Number(s.slice(4, 6)) - 1
    const d = Number(s.slice(6, 8))
    const h = Number(s.slice(8, 10))
    const mi = Number(s.slice(10, 12))
    const se = Number(s.slice(12, 14))
    return Math.floor(Date.UTC(y, m, d, h, mi, se) / 1000)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">История</h1>
        <p className="mt-1 text-sm text-slate-500">
          Чеки, фискализированные через EPOS Communicator.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
        <table className="min-w-full divide-y divide-slate-200 text-sm">
          <thead className="bg-slate-50">
            <tr>
              <Th>Время</Th>
              <Th>Терминал</Th>
              <Th>№ чека</Th>
              <Th>Фискальный признак</Th>
              <Th>QR</Th>
              <Th>Печать</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={6}>
                  Загрузка…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={6}>
                  Пока нет ни одного фискализированного чека.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <Td>{formatDateTime(parseFiscalDateTime(r.fiscal_datetime) || r.fiscalized_at)}</Td>
                  <Td className="font-mono text-xs">{r.terminal_id}</Td>
                  <Td className="font-mono text-xs">{r.receipt_seq}</Td>
                  <Td className="font-mono text-xs">{r.fiscal_sign}</Td>
                  <Td>
                    <a
                      href={r.qr_code_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-slate-700 underline-offset-2 hover:underline"
                    >
                      открыть
                    </a>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void reprintQr(r)}
                        disabled={!!printing[r.id]}
                      >
                        {printing[r.id] ? '…' : 'Печать QR'}
                      </Button>
                      {printMsg[r.id] && (
                        <span
                          className={
                            printMsg[r.id]?.startsWith('✓')
                              ? 'text-xs text-emerald-700'
                              : 'text-xs text-red-700'
                          }
                        >
                          {printMsg[r.id]}
                        </span>
                      )}
                    </div>
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/**
 * Реконструировать данные чека для повторной печати из БД.
 *
 * Источник позиций — это `request_json`, тот самый JSON, который мы
 * отправили в EPOS Communicator. То есть распечатается ТОЧНАЯ копия
 * того, что попало в ОФД.
 *
 * Поддерживаются два формата request_json:
 *   - JSON-RPC (Api.SendSaleReceipt) — params.Receipt с PascalCase полями
 *   - Legacy /uzpos — на верхнем уровне `params.items` с camelCase полями
 */
function buildReceiptDataFromHistory(
  receipt: FiscalReceiptRow,
  settings: Record<string, string>,
): ReceiptData {
  // Парсим request_json с двумя возможными форматами.
  type RpcItem = {
    Price?: number
    VAT?: number
    Name?: string
    ClassCode?: string
    Amount?: number
    VATPercent?: number
  }
  type LegacyItem = {
    price?: number
    vat?: number
    name?: string
    classCode?: string
    amount?: number
    vatPercent?: number
  }

  let items: ReceiptData['items'] = []
  let receivedCash = 0
  let receivedCard = 0
  try {
    const parsed = JSON.parse(receipt.request_json) as Record<string, unknown>

    // JSON-RPC: { params: { Receipt: { Items: [...], ReceivedCash, ReceivedCard } } }
    const rpcReceipt = (
      parsed?.params as { Receipt?: unknown } | undefined
    )?.Receipt as
      | { Items?: RpcItem[]; ReceivedCash?: number; ReceivedCard?: number }
      | undefined
    if (rpcReceipt?.Items) {
      items = rpcReceipt.Items.map((it) => ({
        name: it.Name ?? '',
        class_code: it.ClassCode ?? '',
        qty_str: formatQtyForPrint(it.Amount ?? 1000),
        price_str: formatTiyinForPrint(it.Price ?? 0),
        vat_str: formatTiyinForPrint(it.VAT ?? 0),
        vat_percent: it.VATPercent ?? 12,
      }))
      receivedCash = rpcReceipt.ReceivedCash ?? 0
      receivedCard = rpcReceipt.ReceivedCard ?? 0
    } else {
      // Legacy /uzpos: { params: { items: [...], receivedCash, receivedCard } }
      const legacyParams = parsed?.params as
        | {
            items?: LegacyItem[]
            receivedCash?: number
            receivedCard?: number
          }
        | undefined
      if (legacyParams?.items) {
        items = legacyParams.items.map((it) => ({
          name: it.name ?? '',
          class_code: it.classCode ?? '',
          qty_str: formatQtyForPrint(it.amount ?? 1000),
          price_str: formatTiyinForPrint(it.price ?? 0),
          vat_str: formatTiyinForPrint(it.vat ?? 0),
          vat_percent: it.vatPercent ?? 12,
        }))
        receivedCash = legacyParams.receivedCash ?? 0
        receivedCard = legacyParams.receivedCard ?? 0
      }
    }
  } catch {
    // request_json повреждён — печатаем хотя бы шапку и QR.
  }

  const totalTiyin = receivedCash + receivedCard
  // Сумма НДС оригинальная — берём из items, чтобы не делать отдельных пересчётов.
  // VAT там уже посчитан под продажную цену.
  const totalVatTiyin = items.reduce((s, it) => {
    // it.vat_str — строка типа "1 234.56"; парсим обратно.
    const num = Number.parseFloat(it.vat_str.replace(/\s/g, '')) * 100
    return s + (Number.isFinite(num) ? Math.round(num) : 0)
  }, 0)

  return {
    is_copy: true,
    company: {
      name: settings[SettingKey.CompanyName] ?? '',
      address: settings[SettingKey.CompanyAddress] ?? '',
      phone: settings[SettingKey.CompanyPhone] ?? '',
      inn: settings[SettingKey.CompanyInn] ?? '',
    },
    receipt_seq: receipt.receipt_seq,
    date_str: formatPrintDate(receipt.fiscal_datetime),
    items,
    total_str: formatTiyinForPrint(totalTiyin),
    total_vat_str: formatTiyinForPrint(totalVatTiyin),
    cash_str: formatTiyinForPrint(receivedCash),
    card_str: formatTiyinForPrint(receivedCard),
    cashier: settings[SettingKey.MoyskladEmployeeName] ?? '',
    terminal_id: receipt.terminal_id,
    fiscal_sign: receipt.fiscal_sign,
    virtual_kassa: receipt.fiscal_datetime,
    qr_url: receipt.qr_code_url,
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>
}
