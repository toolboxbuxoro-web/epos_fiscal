import { useEffect, useState } from 'react'
import {
  countEsfItems,
  listEsfItems,
  type EsfItemWithAvailable,
} from '@/lib/db'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { ExcelImportDialog } from '@/components/ExcelImportDialog'
import {
  formatDate,
  milliQtyToDisplay,
  tiyinToSumDisplay,
} from '@/lib/format'

export default function Catalog() {
  const [items, setItems] = useState<EsfItemWithAvailable[]>([])
  const [total, setTotal] = useState(0)
  const [search, setSearch] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [rows, count] = await Promise.all([
        listEsfItems({ search: search || undefined, limit: 200 }),
        countEsfItems(),
      ])
      setItems(rows)
      setTotal(count)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [search])

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Справочник приходов</h1>
          <p className="mt-1 text-sm text-slate-500">
            Товары с налоговыми приходами. Из них Matcher собирает чеки для отправки в EPOS.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setShowImport(true)}>
            Импорт Excel
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <Input
          placeholder="Поиск по названию или штрих-коду…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-md"
        />
        <span className="text-xs text-slate-500">Всего записей: {total}</span>
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
              <Th>Наименование</Th>
              <Th>ИКПУ</Th>
              <Th>Цена</Th>
              <Th>Получено</Th>
              <Th>Доступно</Th>
              <Th>НДС</Th>
              <Th>Дата</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={7}>
                  Загрузка…
                </td>
              </tr>
            ) : items.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-slate-500" colSpan={7}>
                  {search
                    ? 'По запросу ничего не найдено.'
                    : 'Справочник пуст. Импортируйте приходы из Excel.'}
                </td>
              </tr>
            ) : (
              items.map((item) => (
                <tr key={item.id} className="hover:bg-slate-50">
                  <Td>
                    <div className="font-medium text-slate-900">{item.name}</div>
                    {item.barcode && (
                      <div className="text-xs text-slate-500">{item.barcode}</div>
                    )}
                  </Td>
                  <Td className="font-mono text-xs">{item.class_code}</Td>
                  <Td className="text-right">{tiyinToSumDisplay(item.unit_price_tiyin)}</Td>
                  <Td className="text-right">{milliQtyToDisplay(item.qty_received)}</Td>
                  <Td className="text-right">
                    <span
                      className={
                        item.available > 0 ? 'text-emerald-700 font-medium' : 'text-slate-400'
                      }
                    >
                      {milliQtyToDisplay(item.available)}
                    </span>
                  </Td>
                  <Td className="text-center">{item.vat_percent}%</Td>
                  <Td className="text-xs text-slate-600">{formatDate(item.received_at)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {showImport && (
        <ExcelImportDialog
          onClose={() => setShowImport(false)}
          onImported={() => {
            setShowImport(false)
            void load()
          }}
        />
      )}
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
