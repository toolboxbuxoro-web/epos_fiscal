import { useState } from 'react'
import {
  buildImportPlan,
  importExcelFile,
  readExcelAllRows,
  readExcelPreview,
  type ColumnMapping,
  type EsfField,
  type ImportPreview,
  type ImportResult,
  type RawRow,
} from '@/lib/esf'
import { Button } from './ui/Button'
import { Select } from './ui/Select'

const FIELD_LABELS: Record<EsfField, { label: string; required: boolean }> = {
  name: { label: 'Наименование', required: true },
  classCode: { label: 'ИКПУ', required: true },
  packageCode: { label: 'Код упаковки', required: true },
  unitPriceTiyin: { label: 'Цена (сумы)', required: true },
  qtyReceived: { label: 'Количество', required: true },
  vatPercent: { label: 'НДС, %', required: false },
  ownerType: { label: 'Тип владения', required: false },
  barcode: { label: 'Штрих-код', required: false },
  receivedAt: { label: 'Дата прихода', required: false },
  externalId: { label: 'Внешний ID (ЭСФ)', required: false },
  notes: { label: 'Примечание', required: false },
}

interface Props {
  onClose: () => void
  onImported: (result: ImportResult) => void
}

export function ExcelImportDialog({ onClose, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [allRows, setAllRows] = useState<RawRow[]>([])
  const [mapping, setMapping] = useState<ColumnMapping>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [planResult, setPlanResult] = useState<ImportResult | null>(null)

  async function onFileSelected(f: File) {
    setBusy(true)
    setError(null)
    setPreview(null)
    setPlanResult(null)
    try {
      const [p, rows] = await Promise.all([readExcelPreview(f), readExcelAllRows(f)])
      setFile(f)
      setPreview(p)
      setAllRows(rows)
      setMapping(p.guessedMapping)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  function recomputePlan(nextMapping: ColumnMapping) {
    if (!preview) return
    const result = buildImportPlan(nextMapping, allRows)
    setPlanResult(result)
  }

  function setField(field: EsfField, column: string) {
    const next = { ...mapping }
    if (column === '') {
      delete next[field]
    } else {
      next[field] = column
    }
    setMapping(next)
    recomputePlan(next)
  }

  async function doImport() {
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      const result = await importExcelFile(file, mapping)
      onImported(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const requiredMissing = (Object.entries(FIELD_LABELS) as [EsfField, { required: boolean }][])
    .filter(([, info]) => info.required)
    .filter(([field]) => !mapping[field])
    .map(([field]) => field)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-6">
      <div className="w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-200 px-6 py-4">
          <h2 className="text-lg font-semibold">Импорт приходов из Excel</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Закрыть
          </Button>
        </div>

        <div className="space-y-4 p-6">
          {!preview && (
            <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                disabled={busy}
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void onFileSelected(f)
                }}
                className="block w-full text-sm"
              />
              <p className="mt-3 text-xs text-slate-500">
                Поддерживаются форматы .xlsx, .xls, .csv
              </p>
            </div>
          )}

          {error && (
            <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          {preview && (
            <>
              <div className="text-sm text-slate-600">
                Файл: <span className="font-medium text-slate-900">{file?.name}</span>
                {' · '}
                Строк: <span className="font-medium text-slate-900">{preview.totalRows}</span>
                {' · '}
                Колонок: <span className="font-medium text-slate-900">{preview.columns.length}</span>
              </div>

              <section>
                <h3 className="mb-2 text-sm font-medium text-slate-700">Сопоставление колонок</h3>
                <div className="grid grid-cols-2 gap-3">
                  {(Object.keys(FIELD_LABELS) as EsfField[]).map((field) => {
                    const info = FIELD_LABELS[field]
                    return (
                      <label key={field} className="text-sm">
                        <span className="mb-1 block text-xs text-slate-600">
                          {info.label}
                          {info.required && <span className="ml-1 text-red-500">*</span>}
                        </span>
                        <Select
                          value={mapping[field] ?? ''}
                          onChange={(e) => setField(field, e.target.value)}
                        >
                          <option value="">— не использовать —</option>
                          {preview.columns.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </Select>
                      </label>
                    )
                  })}
                </div>
              </section>

              <section>
                <h3 className="mb-2 text-sm font-medium text-slate-700">Превью (первые 5 строк)</h3>
                <div className="overflow-x-auto rounded-md border border-slate-200">
                  <table className="min-w-full divide-y divide-slate-200 text-xs">
                    <thead className="bg-slate-50">
                      <tr>
                        {preview.columns.map((c) => (
                          <th key={c} className="px-2 py-2 text-left font-medium text-slate-600">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 bg-white">
                      {preview.sample.slice(0, 5).map((row, i) => (
                        <tr key={i}>
                          {preview.columns.map((c) => (
                            <td key={c} className="whitespace-nowrap px-2 py-1 text-slate-700">
                              {row[c] === null ? '' : String(row[c])}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              {planResult && (
                <section>
                  <h3 className="mb-2 text-sm font-medium text-slate-700">Готовность</h3>
                  <div className="grid grid-cols-3 gap-3 text-sm">
                    <div className="rounded-md bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Всего</div>
                      <div className="text-lg font-semibold">{planResult.totalRows}</div>
                    </div>
                    <div className="rounded-md bg-emerald-50 p-3">
                      <div className="text-xs text-emerald-700">Готовы к импорту</div>
                      <div className="text-lg font-semibold text-emerald-700">{planResult.successRows}</div>
                    </div>
                    <div className="rounded-md bg-amber-50 p-3">
                      <div className="text-xs text-amber-700">С проблемами</div>
                      <div className="text-lg font-semibold text-amber-700">{planResult.problems.length}</div>
                    </div>
                  </div>
                  {planResult.problems.length > 0 && (
                    <ul className="mt-3 max-h-40 overflow-y-auto rounded-md bg-amber-50 p-3 text-xs text-amber-800">
                      {planResult.problems.slice(0, 50).map((p, i) => (
                        <li key={i}>
                          Строка {p.rowIndex}: {p.message}
                        </li>
                      ))}
                      {planResult.problems.length > 50 && (
                        <li className="mt-1 italic text-amber-700">
                          и ещё {planResult.problems.length - 50}…
                        </li>
                      )}
                    </ul>
                  )}
                </section>
              )}
            </>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-6 py-3">
          <div className="text-xs text-slate-500">
            {requiredMissing.length > 0 && preview
              ? `Не сопоставлены: ${requiredMissing.map((f) => FIELD_LABELS[f].label).join(', ')}`
              : ''}
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button
              variant="primary"
              disabled={busy || !preview || requiredMissing.length > 0}
              onClick={doImport}
            >
              {busy ? 'Импорт…' : 'Импортировать'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
