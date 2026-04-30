import { useEffect, useState } from 'react'
import {
  listFiscalReceipts,
  type FiscalReceiptRow,
} from '@/lib/db'
import { formatDateTime } from '@/lib/format'

export default function History() {
  const [rows, setRows] = useState<FiscalReceiptRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

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
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={5}>
                  Загрузка…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={5}>
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
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
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
