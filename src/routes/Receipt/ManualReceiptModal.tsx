import { useMemo, useState } from 'react'
import { Minus, Plus, RotateCcw, Wand2, X } from 'lucide-react'
import { planHolistic } from '@/lib/matcher'
import {
  costWithVat,
  vatIncluded,
  type MatcherPool,
  type PoolItem,
} from '@/lib/matcher/strategies'
import type { HolisticLine, HolisticPlan, MatcherOptions } from '@/lib/matcher/types'
import { tiyinToSumDisplay } from '@/lib/format'
import { Button, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'

/** Одна строка стартового плана (то что подобрала программа). */
export interface ManualReceiptInitialLine {
  esfItemId: number
  qtyPcs: number
}

interface Props {
  /** Целевая сумма чека (rd.sum − Click/Payme exclude), тийины. */
  targetTiyin: number
  /** Пул товаров справочника (с предрасчитанными продажными ценами). */
  pool: MatcherPool
  /** Стартовый набор — план который собрала программа. */
  initialLines: ManualReceiptInitialLine[]
  /** Опции matcher — для planHolistic в «Дособрать оставшееся». */
  opts: MatcherOptions
  onClose: () => void
  /** Кассир нажал «Готово» — отдаём собранный holistic-план. */
  onDone: (plan: HolisticPlan) => void
}

/** Сколько штук товара доступно на складе (available в миллидолях → штуки). */
function availablePcs(pi: PoolItem): number {
  return Math.floor(pi.item.available / 1000)
}

/** Человекочитаемая причина отказа planHolistic для тоста. */
function rejectMessage(reason: string): string {
  switch (reason) {
    case 'INSUFFICIENT_POOL':
      return 'на складе не хватает товара на эту сумму'
    case 'TARGET_TOO_SMALL':
      return 'остаток меньше самого дешёвого товара'
    case 'POOL_EMPTY':
      return 'в справочнике нет подходящих товаров'
    case 'TOO_MANY_LINES':
      return 'получилось слишком много строк'
    case 'BELOW_COST':
      return 'не сходится по себестоимости'
    default:
      return 'не удалось подобрать комбинацию'
  }
}

/**
 * Модалка ручной сборки чека ЦЕЛИКОМ.
 *
 * Кассир открывает с планом который собрала программа, дальше:
 *   - меняет количество (+/−), удаляет, добавляет товары из справочника
 *   - видит «Собрано / Осталось» в реальном времени
 *   - «Дособрать оставшееся» — holistic добивает остаток до точной суммы
 *   - «Сброс» — возврат к плану программы
 *   - «Готово» — собранный набор становится фискальным планом (holistic-режим)
 *
 * Результат — `HolisticPlan`, тот же формат что у авто-holistic. Фискализация,
 * печать, refund, история уже умеют его обрабатывать.
 */
export function ManualReceiptModal(props: Props) {
  const { targetTiyin, pool, initialLines, opts, onClose, onDone } = props

  // Индекс пула по id товара — для быстрого lookup при рендере карточек.
  const poolById = useMemo(() => {
    const m = new Map<number, PoolItem>()
    for (const pi of pool.items) m.set(pi.item.id, pi)
    return m
  }, [pool])

  /** Построить стартовый Map<esfItemId, qtyPcs> из плана программы. */
  function buildInitialSelected(): Map<number, number> {
    const m = new Map<number, number>()
    for (const ln of initialLines) {
      const pi = poolById.get(ln.esfItemId)
      if (!pi) continue // товара больше нет в пуле — пропускаем
      const cap = availablePcs(pi)
      const q = Math.min((m.get(ln.esfItemId) ?? 0) + ln.qtyPcs, cap)
      if (q > 0) m.set(ln.esfItemId, q)
    }
    return m
  }

  // selected: esfItemId → количество штук.
  const [selected, setSelected] = useState<Map<number, number>>(buildInitialSelected)
  const [search, setSearch] = useState('')

  // ── Расчёты ───────────────────────────────────────────────────────
  const selectedTotal = useMemo(() => {
    let sum = 0
    selected.forEach((qty, id) => {
      const pi = poolById.get(id)
      if (pi) sum += pi.sellingPrice * qty
    })
    return sum
  }, [selected, poolById])

  const remaining = targetTiyin - selectedTotal

  // ── Мутации набора ────────────────────────────────────────────────
  function setQty(id: number, qty: number) {
    const pi = poolById.get(id)
    if (!pi) return
    const clamped = Math.max(0, Math.min(qty, availablePcs(pi)))
    const next = new Map(selected)
    if (clamped <= 0) next.delete(id)
    else next.set(id, clamped)
    setSelected(next)
  }

  function addOne(id: number) {
    setQty(id, (selected.get(id) ?? 0) + 1)
  }

  function removeItem(id: number) {
    const next = new Map(selected)
    next.delete(id)
    setSelected(next)
  }

  /** «Дособрать оставшееся» — holistic добивает остаток до точной суммы. */
  function autofill() {
    if (remaining <= 0) return
    // Пул с учётом уже выбранного: уменьшаем available на занятые штуки,
    // чтобы holistic не «взял» то что кассир уже добавил.
    const subPool: MatcherPool = {
      minSellingPrice: pool.minSellingPrice,
      items: pool.items.map((pi) => {
        const usedPcs = selected.get(pi.item.id) ?? 0
        if (usedPcs <= 0) return pi
        return {
          ...pi,
          item: {
            ...pi.item,
            available: Math.max(0, pi.item.available - usedPcs * 1000),
          },
        }
      }),
    }
    const r = planHolistic(remaining, subPool, opts)
    if (!r.ok) {
      toast.error(`Не удалось дособрать: ${rejectMessage(r.reason)}`, {
        duration: 5000,
      })
      return
    }
    const next = new Map(selected)
    for (const line of r.plan.lines) {
      const id = line.esfItem.id
      const addPcs = Math.round(line.quantity / 1000)
      next.set(id, (next.get(id) ?? 0) + addPcs)
    }
    setSelected(next)
    toast.success('Остаток дособран', { duration: 2500 })
  }

  /** «Сброс» — вернуть набор к плану программы. */
  function reset() {
    setSelected(buildInitialSelected())
  }

  /** «Готово» — собрать HolisticPlan и отдать наверх. */
  function done() {
    const lines: HolisticLine[] = []
    let totalTiyin = 0
    let totalCostTiyin = 0
    selected.forEach((qty, id) => {
      const pi = poolById.get(id)
      if (!pi || qty <= 0) return
      const quantityMilli = qty * 1000
      const priceTiyin = pi.sellingPrice * qty
      const vatTiyin = vatIncluded(priceTiyin, pi.item.vat_percent)
      lines.push({
        esfItem: pi.item,
        quantity: quantityMilli,
        priceTiyin,
        discountTiyin: 0,
        vatTiyin,
      })
      totalTiyin += priceTiyin
      totalCostTiyin += costWithVat(
        pi.item.unit_price_tiyin,
        pi.item.vat_percent,
        quantityMilli,
      )
    })
    if (lines.length === 0) {
      toast.error('Добавьте хотя бы один товар', { duration: 4000 })
      return
    }
    onDone({
      lines,
      totalTiyin,
      totalCostTiyin,
      notes: ['Чек собран вручную кассиром'],
    })
  }

  // ── Список справочника (фильтр по поиску) ─────────────────────────
  const catalogResults = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = q
      ? pool.items.filter(
          (pi) =>
            pi.item.name.toLowerCase().includes(q) ||
            pi.item.class_code.toLowerCase().includes(q),
        )
      : pool.items
    // Лимит 60 строк — UI не тормозит, кассир уточняет поиском.
    return filtered.slice(0, 60)
  }, [search, pool])

  // Карточки выбранных товаров.
  const selectedCards = useMemo(() => {
    const arr: { pi: PoolItem; qty: number }[] = []
    selected.forEach((qty, id) => {
      const pi = poolById.get(id)
      if (pi) arr.push({ pi, qty })
    })
    return arr
  }, [selected, poolById])

  const remainingLabel =
    remaining > 0
      ? `Осталось ${tiyinToSumDisplay(remaining)} сум`
      : remaining < 0
        ? `Перебор ${tiyinToSumDisplay(-remaining)} сум`
        : 'Сумма сошлась точно'
  const remainingColor =
    remaining > 0 ? 'text-warning' : remaining < 0 ? 'text-danger' : 'text-success'

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Шапка: цель / собрано / осталось ── */}
        <div className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-h4 font-medium text-ink">Ручная сборка чека</div>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-caption">
                <span className="text-ink-muted">
                  Цель:{' '}
                  <span className="font-mono text-ink">
                    {tiyinToSumDisplay(targetTiyin)} сум
                  </span>
                </span>
                <span className="text-ink-muted">
                  Собрано:{' '}
                  <span className="font-mono text-ink">
                    {tiyinToSumDisplay(selectedTotal)} сум
                  </span>
                </span>
                <span className={cn('font-medium', remainingColor)}>
                  {remainingLabel}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
              aria-label="Закрыть"
            >
              <X size={18} />
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<Wand2 size={14} />}
              disabled={remaining <= 0}
              onClick={autofill}
              title={
                remaining <= 0
                  ? 'Нечего дособирать — сумма уже набрана'
                  : 'Holistic добьёт остаток до точной суммы'
              }
            >
              Дособрать оставшееся
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon={<RotateCcw size={14} />}
              onClick={reset}
              title="Вернуть набор к тому что подобрала программа"
            >
              Сброс к плану программы
            </Button>
          </div>
        </div>

        {/* ── Тело: выбранные + справочник ── */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {/* Выбранные товары */}
          <div>
            <div className="mb-2 text-caption font-medium text-ink-muted uppercase tracking-wide">
              Выбранные товары ({selectedCards.length})
            </div>
            {selectedCards.length === 0 ? (
              <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-caption text-ink-muted">
                Пусто — добавьте товары из справочника ниже.
              </div>
            ) : (
              <div className="space-y-2">
                {selectedCards.map(({ pi, qty }) => {
                  const cap = availablePcs(pi)
                  const lineTotal = pi.sellingPrice * qty
                  return (
                    <div
                      key={pi.item.id}
                      className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body font-medium text-ink">
                          {pi.item.name}
                        </div>
                        <div className="text-caption text-ink-subtle">
                          {tiyinToSumDisplay(pi.sellingPrice)} сум/шт · остаток{' '}
                          {cap} шт · НДС {pi.item.vat_percent}%
                        </div>
                      </div>
                      {/* qty − N + */}
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          onClick={() => setQty(pi.item.id, qty - 1)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-surface-hover"
                          title="Уменьшить"
                        >
                          <Minus size={13} />
                        </button>
                        <span className="w-8 text-center font-medium tabular-nums text-ink select-none">
                          {qty}
                        </span>
                        <button
                          type="button"
                          onClick={() => addOne(pi.item.id)}
                          disabled={qty >= cap}
                          className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-border hover:bg-surface-hover disabled:opacity-40 disabled:cursor-not-allowed"
                          title={qty >= cap ? 'Достигнут остаток склада' : 'Увеличить'}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                      <div className="w-28 shrink-0 text-right font-mono text-body text-ink">
                        {tiyinToSumDisplay(lineTotal)}
                      </div>
                      <button
                        type="button"
                        onClick={() => removeItem(pi.item.id)}
                        className="shrink-0 rounded-md p-1 text-ink-muted hover:bg-danger-soft hover:text-danger"
                        title="Убрать из чека"
                      >
                        <X size={15} />
                      </button>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* Справочник */}
          <div>
            <div className="mb-2 text-caption font-medium text-ink-muted uppercase tracking-wide">
              Добавить из справочника
            </div>
            <Input
              placeholder="Поиск по названию или ИКПУ…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="mb-2"
            />
            <div className="space-y-1.5">
              {catalogResults.length === 0 ? (
                <div className="px-3 py-6 text-center text-caption text-ink-muted">
                  Ничего не найдено.
                </div>
              ) : (
                catalogResults.map((pi) => {
                  const cap = availablePcs(pi)
                  const inCart = selected.get(pi.item.id) ?? 0
                  return (
                    <div
                      key={pi.item.id}
                      className="flex items-center gap-3 rounded-md border border-border bg-surface px-3 py-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-body text-ink">
                          {pi.item.name}
                        </div>
                        <div className="text-caption text-ink-subtle">
                          {tiyinToSumDisplay(pi.sellingPrice)} сум/шт · остаток{' '}
                          {cap} шт
                          {inCart > 0 && (
                            <span className="text-primary"> · в чеке {inCart}</span>
                          )}
                        </div>
                      </div>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Plus size={13} />}
                        disabled={inCart >= cap}
                        onClick={() => addOne(pi.item.id)}
                      >
                        {inCart >= cap ? 'Нет остатка' : 'Добавить'}
                      </Button>
                    </div>
                  )
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Подвал: Готово / Отмена ── */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-5 py-4">
          <div className="text-caption text-ink-muted">
            Чек уйдёт в ОФД на{' '}
            <span className="font-mono font-medium text-ink">
              {tiyinToSumDisplay(selectedTotal)} сум
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Отмена
            </Button>
            <Button
              variant="primary"
              onClick={done}
              disabled={selectedCards.length === 0}
            >
              Готово
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
