import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import {
  getDb,
  getMsReceipt,
  getSetting,
  setMsReceiptStatus,
  SettingKey,
  now,
} from '@/lib/db'
import type { MsReceiptRow } from '@/lib/db/types'
import { buildMatch, type BuildMatchResult } from '@/lib/matcher'
import { fiscalize } from '@/lib/epos'
import { MoyskladClient, inlinePositions, type MsRetailDemand } from '@/lib/moysklad'
import { Button } from '@/components/ui/Button'
import {
  formatDateTime,
  milliQtyToDisplay,
  tiyinToSumDisplay,
  tiyinToSumDisplayPrecise,
} from '@/lib/format'

export default function Receipt() {
  const { id } = useParams<{ id: string }>()
  const nav = useNavigate()

  const [receipt, setReceipt] = useState<MsReceiptRow | null>(null)
  const [match, setMatch] = useState<BuildMatchResult | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [fiscalizing, setFiscalizing] = useState(false)

  const rd: MsRetailDemand | null = useMemo(() => {
    if (!receipt) return null
    try {
      return JSON.parse(receipt.raw_json) as MsRetailDemand
    } catch {
      return null
    }
  }, [receipt])

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

      // МойСклад в list-запросе не отдаёт inline positions.
      // Если их нет — делаем одиночный запрос с expand (там работает),
      // обновляем raw_json в БД, чтобы повторно не дёргать.
      if (!inlinePositions(parsed)) {
        const basic = await getSetting(SettingKey.MoyskladCredentials)
        const token = basic ? null : await getSetting(SettingKey.MoyskladToken)
        if (basic || token) {
          try {
            const client = new MoyskladClient(
              basic ? { basic } : { token: token! },
            )
            const full = await client.getRetailDemand(parsed.id)
            const db = await getDb()
            await db.execute(
              'UPDATE ms_receipts SET raw_json = $1, updated_at = $2 WHERE id = $3',
              [JSON.stringify(full), now(), r.id],
            )
            parsed = full
          } catch (fetchErr) {
            // Не критично — продолжим без позиций, покажем варнинг.
            console.warn('Не удалось дозагрузить позиции чека:', fetchErr)
          }
        }
      }

      const tolStr = (await getSetting(SettingKey.MatchToleranceTiyin)) ?? '0'
      const tolerance = Number.parseInt(tolStr, 10) || 0
      const result = await buildMatch(parsed, { toleranceTiyin: tolerance })
      setMatch(result)
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
      alert(
        `Чек фискализирован\n\nFiscal sign: ${result.fiscal.FiscalSign}\nQR: ${result.fiscal.QRCodeURL}`,
      )
      nav('/history')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      await setMsReceiptStatus(receipt.id, 'failed').catch(() => undefined)
    } finally {
      setFiscalizing(false)
    }
  }

  if (busy && !receipt) {
    return <div className="text-sm text-slate-500">Загрузка…</div>
  }

  if (error && !receipt) {
    return (
      <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
        {error}
      </div>
    )
  }

  if (!receipt || !rd || !match) return null

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            Сборка чека {receipt.ms_name ?? `#${receipt.id}`}
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            {formatDateTime(receipt.ms_moment)} · оригинал из МойСклад
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => nav('/')}>
            ← Назад
          </Button>
          <Button
            variant="primary"
            disabled={fiscalizing || match.positions.length === 0}
            onClick={doFiscalize}
          >
            {fiscalizing ? 'Отправка…' : 'Фискализировать через EPOS'}
          </Button>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Side title="Оригинал из МойСклад" sumTiyin={rd.sum}>
          <PositionsTable
            positions={match.positions.map((pm) => ({
              name: pm.source.name,
              quantity: pm.source.quantity,
              total: pm.source.totalTiyin,
              vatPercent: pm.source.vatPercent,
              meta: pm.source.classCode ?? '— нет ИКПУ —',
            }))}
          />
        </Side>

        <Side
          title={`Подбор (${strategyLabel(match.overallStrategy)})`}
          sumTiyin={match.matchedTotalTiyin}
          sumDiff={match.totalDiffTiyin}
        >
          <PositionsTable
            positions={match.positions.flatMap((pm) =>
              pm.candidates.map((c) => ({
                name: c.esfItem.name,
                quantity: c.quantity,
                total: c.priceTiyin,
                vatPercent: c.esfItem.vat_percent,
                meta: c.esfItem.class_code,
              })),
            )}
          />
        </Side>
      </div>

      {match.warnings.length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h3 className="mb-2 text-sm font-medium text-amber-900">Предупреждения</h3>
          <ul className="space-y-1 text-xs text-amber-900">
            {match.warnings.map((w, i) => (
              <li key={i}>• {w}</li>
            ))}
          </ul>
        </section>
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
  total: number
  vatPercent: number
  meta: string
}

function PositionsTable({ positions }: { positions: DisplayPosition[] }) {
  if (positions.length === 0) {
    return (
      <div className="px-4 py-6 text-center text-sm text-slate-500">
        Нет позиций
      </div>
    )
  }
  return (
    <table className="min-w-full divide-y divide-slate-200 text-sm">
      <thead className="bg-slate-50/80">
        <tr>
          <th className="px-3 py-2 text-left text-xs font-medium text-slate-600">
            Товар
          </th>
          <th className="px-3 py-2 text-right text-xs font-medium text-slate-600">
            Кол-во
          </th>
          <th className="px-3 py-2 text-right text-xs font-medium text-slate-600">
            Сумма
          </th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {positions.map((p, i) => (
          <tr key={i}>
            <td className="px-3 py-2">
              <div className="font-medium text-slate-900">{p.name}</div>
              <div className="font-mono text-xs text-slate-500">
                {p.meta} · НДС {p.vatPercent}%
              </div>
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {milliQtyToDisplay(p.quantity)}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">
              {tiyinToSumDisplayPrecise(p.total)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
    <section className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        <div className="text-right">
          <div className="text-xs text-slate-500">Итого</div>
          <div className="text-sm font-semibold tabular-nums">
            {tiyinToSumDisplay(sumTiyin)} сум
          </div>
          {sumDiff !== undefined && sumDiff !== 0 && (
            <div
              className={`text-xs tabular-nums ${
                sumDiff > 0 ? 'text-amber-600' : 'text-blue-600'
              }`}
            >
              {sumDiff > 0 ? '+' : ''}
              {tiyinToSumDisplayPrecise(sumDiff)}
            </div>
          )}
        </div>
      </header>
      {children}
    </section>
  )
}
