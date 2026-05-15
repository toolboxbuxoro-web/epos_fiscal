/**
 * Модальное окно ручного подбора прихода.
 *
 * Открывается при клике «Подобрать вручную» на позиции чека.
 * Показывает поиск + список приходов с ценами и остатками.
 *
 * UX:
 *   - Текстовый поиск с debounce 200ms (AND-логика по токенам)
 *   - Дополнительный фильтр «цена ≈ X сум ±N сум» — найти товары с
 *     расчётной продажной ценой близкой к указанной (например к сумме
 *     позиции из чека МС)
 *   - Чекбокс «только с остатком» (по умолчанию вкл)
 *   - Top-100 результатов с ранжированием
 *   - На каждой строке: название, ИКПУ, партия, цена прихода,
 *     расчётная продажная, остаток
 *   - Клик на строку = выбрать → onPick(item) → закрытие модалки
 *
 * Performance:
 *   - Search index — это просто pool из state Receipt.tsx (один раз загружен)
 *   - searchPool — substring + score, ≤15ms для 5000 строк
 *   - Топ-100 в DOM — нет необходимости в виртуализации
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Search, X } from 'lucide-react'
import { Button } from '@/components/ui'
import { tiyinToSumDisplay, milliQtyToDisplay } from '@/lib/format'
import type { MatcherPool } from '@/lib/matcher'
import { searchPool, type SearchResult } from '@/lib/matcher/search'

interface Props {
  /** Уже загруженный pool из Receipt.tsx (переиспользуем — экономия запроса). */
  pool: MatcherPool
  /** Заголовок: имя позиции к которой подбираем. */
  positionName: string
  /** Сумма позиции из чека МС (тийины) — для quick-filter «по цене». */
  targetPriceTiyin: number
  /** Колбэк выбора товара. */
  onPick: (result: SearchResult) => void
  /** Закрытие без выбора. */
  onClose: () => void
}

const DEBOUNCE_MS = 200

export function ManualPickerModal({
  pool,
  positionName,
  targetPriceTiyin,
  onPick,
  onClose,
}: Props) {
  const [rawQuery, setRawQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  // Pre-fill price filter с суммой позиции из чека — кассир сразу видит товары
  // близкие к нужной цене. Пустая строка если targetPriceTiyin = 0.
  const [priceFilterSum, setPriceFilterSum] = useState(() =>
    targetPriceTiyin > 0 ? Math.round(targetPriceTiyin / 100).toString() : '',
  )
  const [priceFilterTolerance, setPriceFilterTolerance] = useState('5000') // ±5000 сум
  const [onlyAvailable, setOnlyAvailable] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  // Автофокус на input при открытии
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Debounced query
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(rawQuery), DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [rawQuery])

  // ESC = закрыть
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Результаты поиска (мемо — пересчитывается только при изменении query/filters)
  const results = useMemo<SearchResult[]>(() => {
    let baseResults = searchPool(
      pool,
      debouncedQuery,
      { onlyAvailable },
      500, // широкий cap для после price-filter
    )

    // Опциональный фильтр по сумме: показываем только товары с
    // sellingPrice в окне [target - tolerance, target + tolerance]
    const priceSum = priceFilterSum.replace(/\s/g, '').trim()
    const tolSum = priceFilterTolerance.replace(/\s/g, '').trim()
    if (priceSum && /^\d+$/.test(priceSum)) {
      const targetTiyin = parseInt(priceSum, 10) * 100
      const tolTiyin =
        tolSum && /^\d+$/.test(tolSum)
          ? parseInt(tolSum, 10) * 100
          : 500_000 // 5000 сум default
      baseResults = baseResults.filter(
        (r) =>
          r.sellingPrice >= targetTiyin - tolTiyin &&
          r.sellingPrice <= targetTiyin + tolTiyin,
      )
      // Сортируем по близости к target
      baseResults.sort(
        (a, b) =>
          Math.abs(a.sellingPrice - targetTiyin) -
          Math.abs(b.sellingPrice - targetTiyin),
      )
    }

    return baseResults.slice(0, 100)
  }, [pool, debouncedQuery, onlyAvailable, priceFilterSum, priceFilterTolerance])

  // Готовый «найти по сумме чека» — заполнение targetPriceTiyin
  function applyChecksum() {
    const targetSum = Math.round(targetPriceTiyin / 100).toString()
    setPriceFilterSum(targetSum)
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(15,23,42,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 100,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-surface rounded-lg shadow-xl"
        style={{
          width: 'min(960px, 95vw)',
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div
          className="border-b border-border"
          style={{ padding: '16px 20px', display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <Search size={18} className="text-ink-muted" />
          <div style={{ flex: 1 }}>
            <h2 className="text-heading text-ink">Подобрать вручную</h2>
            <div className="text-caption text-ink-muted">
              для позиции: {positionName}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-muted hover:text-ink"
            style={{ padding: 4 }}
            aria-label="Закрыть"
          >
            <X size={20} />
          </button>
        </div>

        {/* Filters */}
        <div
          className="border-b border-border"
          style={{ padding: '12px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          <input
            ref={inputRef}
            type="text"
            placeholder="Поиск по названию, ИКПУ, коду партии…"
            value={rawQuery}
            onChange={(e) => setRawQuery(e.target.value)}
            className="bg-canvas border border-border rounded-md text-ink"
            style={{ padding: '8px 12px', fontSize: 14, outline: 'none', width: '100%' }}
          />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="text-caption text-ink-muted">Цена ≈</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="сум"
              value={priceFilterSum}
              onChange={(e) => setPriceFilterSum(e.target.value)}
              className="bg-canvas border border-border rounded-md text-ink"
              style={{ padding: '6px 10px', fontSize: 13, outline: 'none', width: 130 }}
            />
            <span className="text-caption text-ink-muted">±</span>
            <input
              type="text"
              inputMode="numeric"
              placeholder="5000"
              value={priceFilterTolerance}
              onChange={(e) => setPriceFilterTolerance(e.target.value)}
              className="bg-canvas border border-border rounded-md text-ink"
              style={{ padding: '6px 10px', fontSize: 13, outline: 'none', width: 80 }}
            />
            <span className="text-caption text-ink-muted">сум</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={applyChecksum}
              title="Подставить сумму позиции из чека МС"
            >
              По сумме чека ({tiyinToSumDisplay(targetPriceTiyin)} сум)
            </Button>
            {(priceFilterSum || priceFilterTolerance !== '5000') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPriceFilterSum('')
                  setPriceFilterTolerance('5000')
                }}
              >
                Сбросить
              </Button>
            )}
            <div style={{ flex: 1 }} />
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
              className="text-caption text-ink-muted"
            >
              <input
                type="checkbox"
                checked={onlyAvailable}
                onChange={(e) => setOnlyAvailable(e.target.checked)}
              />
              Только с остатком
            </label>
          </div>
        </div>

        {/* Results */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {results.length === 0 ? (
            <div
              className="text-ink-muted"
              style={{ padding: 32, textAlign: 'center' }}
            >
              {debouncedQuery || priceFilterSum
                ? 'Ничего не найдено. Уточните запрос.'
                : 'Введите запрос или фильтр по сумме.'}
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead
                style={{
                  position: 'sticky',
                  top: 0,
                  background: '#f8fafc',
                  zIndex: 1,
                }}
              >
                <tr style={{ textAlign: 'left' }}>
                  <th style={th}>Название</th>
                  <th style={th}>ИКПУ</th>
                  <th style={th}>Партия</th>
                  <th style={{ ...th, textAlign: 'right' }}>Приход</th>
                  <th style={{ ...th, textAlign: 'right' }}>Продажа</th>
                  <th style={{ ...th, textAlign: 'right' }}>Остаток</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => {
                  const available = r.item.qty_received - r.item.qty_consumed
                  return (
                    <tr
                      key={r.item.id}
                      onClick={() => onPick(r)}
                      style={{
                        cursor: 'pointer',
                        borderTop: '1px solid #e2e8f0',
                      }}
                      className="hover:bg-surface-hover"
                    >
                      <td style={td}>
                        <div className="text-ink" style={{ fontWeight: 500 }}>
                          {r.item.name}
                        </div>
                      </td>
                      <td style={{ ...td, fontFamily: 'monospace', fontSize: 11 }}>
                        {r.item.class_code}
                      </td>
                      <td style={{ ...td, fontSize: 11, color: '#64748b' }}>
                        {r.item.notes ?? '—'}
                      </td>
                      <td
                        style={{
                          ...td,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                        }}
                      >
                        {tiyinToSumDisplay(r.item.unit_price_tiyin)}
                      </td>
                      <td
                        style={{
                          ...td,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          fontWeight: 600,
                        }}
                      >
                        {tiyinToSumDisplay(r.sellingPrice)}
                      </td>
                      <td
                        style={{
                          ...td,
                          textAlign: 'right',
                          fontVariantNumeric: 'tabular-nums',
                          color: available <= 0 ? '#dc2626' : '#0f172a',
                        }}
                      >
                        {milliQtyToDisplay(available)} шт
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer */}
        <div
          className="border-t border-border"
          style={{
            padding: '10px 20px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <span className="text-caption text-ink-muted">
            Найдено: {results.length}
            {results.length === 100 && ' (показаны топ 100)'}
          </span>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Отмена (Esc)
          </Button>
        </div>
      </div>
    </div>
  )
}

const th: React.CSSProperties = {
  padding: '8px 12px',
  fontWeight: 500,
  color: '#475569',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.3,
}
const td: React.CSSProperties = { padding: '10px 12px', verticalAlign: 'middle' }
