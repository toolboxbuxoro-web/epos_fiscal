import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertCircle, Loader2, Minus, Plus, RotateCcw, Wand2, X } from 'lucide-react'
import { planHolistic } from '@/lib/matcher'
import {
  costWithVat,
  priceFloorTiyin,
  vatIncluded,
  type MatcherPool,
  type PoolItem,
} from '@/lib/matcher/strategies'
import type { HolisticLine, HolisticPlan, MatcherOptions } from '@/lib/matcher/types'
import { tiyinToSumDisplay } from '@/lib/format'
import { Button, toast } from '@/components/ui'
import { Input } from '@/components/ui/Input'
import { cn } from '@/lib/cn'
import { onItemsUpdated } from '@/lib/inventory/event-bus'

/** Одна строка стартового плана (то что подобрала программа). */
export interface ManualReceiptInitialLine {
  esfItemId: number
  qtyPcs: number
}

interface OuterProps {
  /** Целевая сумма чека (rd.sum − Click/Payme exclude), тийины. */
  targetTiyin: number
  /**
   * Колбек который грузит СВЕЖИЙ пул товаров с уже-предрасчитанными
   * продажными ценами. Вызывается при открытии модалки. Раньше pool
   * передавался один раз из Receipt.tsx::load() — за время сессии
   * (модалка открыта 10+ минут) SSE мог обновить qty_received, и
   * pool разъезжался с реальностью. «Готово» → reserve упирался в
   * inv_items_check на сервере. Теперь модалка ВСЕГДА работает со
   * свежим снимком пула.
   */
  loadPool: () => Promise<MatcherPool>
  /** Стартовый набор — план который собрала программа. */
  initialLines: ManualReceiptInitialLine[]
  /** Опции matcher — для planHolistic в «Дособрать оставшееся». */
  opts: MatcherOptions
  onClose: () => void
  /** Кассир нажал «Готово» — отдаём собранный holistic-план. */
  onDone: (plan: HolisticPlan) => void
}

/** Внутренние props body — после того как pool уже загружен (не-null). */
interface BodyProps extends Omit<OuterProps, 'loadPool'> {
  pool: MatcherPool
  /**
   * Сколько раз SSE приносил апдейт. 0 — нет апдейтов. Показывается в
   * шапке модалки как «🔄 Остатки обновились». Тело не пересоздаёт useState,
   * только рендерит индикатор и (через useEffect) clamp'ит selected.
   */
  liveUpdateCount: number
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
 * Внешний компонент — грузит свежий пул и рендерит loading/error/body.
 * При открытии модалки делает `loadPool()`, показывает спиннер, потом
 * передаёт пул в `ManualReceiptModalBody`. Если pool не загрузился —
 * показывает ошибку, не даёт собирать чек на устаревших данных.
 */
export function ManualReceiptModal(props: OuterProps) {
  const [pool, setPool] = useState<MatcherPool | null>(null)
  const [poolError, setPoolError] = useState<string | null>(null)
  /**
   * Сколько раз SSE присылал апдейт за время сессии модалки.
   * Показывается в UI как «🔄 Остатки обновились N раз». 0 — скрыто.
   * Без этого кассир не знает что под капотом пул меняется.
   */
  const [liveUpdateCount, setLiveUpdateCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const fresh = await props.loadPool()
        if (!cancelled) setPool(fresh)
      } catch (e) {
        if (!cancelled) {
          setPoolError(e instanceof Error ? e.message : String(e))
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Подписка на SSE-апдейты остатков. Когда другой магазин фискализирует/
   * возвращает товар → сервер шлёт `inv.items.updated` → runtime обновляет
   * локальную SQLite → emitItemsUpdated → мы патчим item.available в нашем
   * локальном snapshot пула.
   *
   * Что НЕ перезагружаем: minSellingPrice, sellingPrice — они от vat+markup,
   * не зависят от available. Только qty/available patch'им in-place.
   */
  useEffect(() => {
    if (!pool) return
    const off = onItemsUpdated((updates) => {
      setPool((cur) => {
        if (!cur) return cur
        const byId = new Map(updates.map((u) => [u.id, u.available]))
        let touched = false
        const next = {
          ...cur,
          items: cur.items.map((pi) => {
            const newAvail = byId.get(pi.item.id)
            if (newAvail === undefined || newAvail === pi.item.available) {
              return pi
            }
            touched = true
            return {
              ...pi,
              item: { ...pi.item, available: newAvail },
            }
          }),
        }
        if (touched) {
          setLiveUpdateCount((n) => n + 1)
        }
        return touched ? next : cur
      })
    })
    return off
  }, [pool])

  if (poolError) {
    return (
      <ModalShell onClose={props.onClose} title="Ручная сборка чека">
        <div className="flex flex-col items-center gap-3 px-5 py-8 text-center">
          <AlertCircle size={36} className="text-danger" />
          <div className="text-body font-medium text-ink">
            Не удалось загрузить справочник
          </div>
          <div className="text-caption text-ink-muted max-w-md">
            {poolError}. Попробуйте закрыть и открыть снова, или
            синхронизируйте справочник вручную в разделе «Справочник».
          </div>
          <Button variant="ghost" onClick={props.onClose}>
            Закрыть
          </Button>
        </div>
      </ModalShell>
    )
  }

  if (!pool) {
    return (
      <ModalShell onClose={props.onClose} title="Ручная сборка чека">
        <div className="flex flex-col items-center gap-3 px-5 py-12 text-center">
          <Loader2 size={32} className="animate-spin text-primary" />
          <div className="text-body text-ink-muted">
            Синхронизирую справочник с сервером…
          </div>
          <div className="text-caption text-ink-subtle max-w-md">
            Получаем актуальные остатки прямо сейчас, чтобы вы видели
            именно то что реально доступно на складе.
          </div>
        </div>
      </ModalShell>
    )
  }

  return (
    <ManualReceiptModalBody
      pool={pool}
      targetTiyin={props.targetTiyin}
      initialLines={props.initialLines}
      opts={props.opts}
      onClose={props.onClose}
      onDone={props.onDone}
      liveUpdateCount={liveUpdateCount}
    />
  )
}

/**
 * Минимальная обёртка-overlay для loading/error состояний модалки.
 * Тело модалки рендерит свой собственный layout с тем же стилем —
 * выносить общий ModalShell для них пока не стоит, разные требования.
 */
function ModalShell(props: {
  onClose: () => void
  title: string
  children: React.ReactNode
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
      onClick={props.onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-canvas shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
          <div className="text-h4 font-medium text-ink">{props.title}</div>
          <button
            type="button"
            onClick={props.onClose}
            className="rounded-md p-1 text-ink-muted hover:bg-surface-hover hover:text-ink"
            aria-label="Закрыть"
          >
            <X size={18} />
          </button>
        </div>
        {props.children}
      </div>
    </div>
  )
}

/**
 * Модалка ручной сборки чека ЦЕЛИКОМ (тело — после загрузки пула).
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
function ManualReceiptModalBody(props: BodyProps) {
  const { targetTiyin, pool, initialLines, opts, onClose, onDone, liveUpdateCount } = props

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

  /**
   * Когда SSE приходит апдейт пула (другой магазин фискализировал товар) —
   * clamp выбранные количества к новому available. Если кассир выбрал 5 шт,
   * а на сервере стало 3 → выставляем 3 и показываем toast «X шт. Y стало
   * недоступно». Если стало 0 → удаляем из selected.
   *
   * Запускается ТОЛЬКО когда pool обновлён через SSE — не на initial mount
   * (liveUpdateCount = 0 → пропускаем).
   */
  const clampedRefliveUpdate = useRef(0)
  useEffect(() => {
    if (liveUpdateCount === 0) return
    if (liveUpdateCount === clampedRefliveUpdate.current) return
    clampedRefliveUpdate.current = liveUpdateCount

    const adjusted: { name: string; was: number; now: number }[] = []
    const next = new Map(selected)
    selected.forEach((qty, id) => {
      const pi = poolById.get(id)
      if (!pi) {
        // Товар вообще исчез из пула (reconcile soft-void)
        adjusted.push({ name: '(удалённый товар)', was: qty, now: 0 })
        next.delete(id)
        return
      }
      const cap = availablePcs(pi)
      if (qty > cap) {
        adjusted.push({ name: pi.item.name, was: qty, now: cap })
        if (cap <= 0) next.delete(id)
        else next.set(id, cap)
      }
    })
    if (adjusted.length > 0) {
      setSelected(next)
      const first = adjusted[0]!
      toast.error(
        adjusted.length === 1
          ? `«${first.name}» — было ${first.was} шт, стало ${first.now} (другой магазин забрал)`
          : `${adjusted.length} товаров изменили остаток — количество уменьшено`,
        { duration: 5000 },
      )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveUpdateCount])

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
    const subPoolItems = pool.items.map((pi) => {
      const usedPcs = selected.get(pi.item.id) ?? 0
      if (usedPcs <= 0) return pi
      return {
        ...pi,
        item: {
          ...pi.item,
          available: Math.max(0, pi.item.available - usedPcs * 1000),
        },
      }
    })
    const subPool: MatcherPool = {
      minSellingPrice: pool.minSellingPrice,
      items: subPoolItems,
      // remainingById строим из скорректированных available субпула.
      remainingById: new Map(subPoolItems.map((p) => [p.item.id, p.item.available])),
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
    // Позиции ниже минимальной цены (себестоимость +5%) — для warning.
    // Цена в manual = pi.sellingPrice (наценка ≥10% по дефолту, выше floor),
    // поэтому срабатывает только при markup<5% (упрощёнка). Не блокируем —
    // консистентно с правилом: цену не меняем, кассир решает сам.
    const belowFloor: string[] = []
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
      const floor = priceFloorTiyin(
        pi.item.unit_price_tiyin,
        pi.item.vat_percent,
        quantityMilli,
      )
      if (priceTiyin > 0 && priceTiyin < floor) {
        belowFloor.push(pi.item.name)
      }
    })
    if (lines.length === 0) {
      toast.error('Добавьте хотя бы один товар', { duration: 4000 })
      return
    }
    if (belowFloor.length > 0) {
      toast.error(
        `${belowFloor.length} ${belowFloor.length === 1 ? 'товар' : 'товара'} ` +
          `ниже минимальной цены (себестоимость +5%): ${belowFloor[0]}` +
          (belowFloor.length > 1 ? ` и др.` : '') +
          `. Проверьте наценку магазина в Настройках.`,
        { duration: 6000 },
      )
    }
    onDone({
      lines,
      totalTiyin,
      totalCostTiyin,
      notes: [
        'Чек собран вручную кассиром',
        ...(belowFloor.length > 0
          ? [`⚠️ ${belowFloor.length} позиций ниже минимальной наценки 5%`]
          : []),
      ],
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
              <div className="flex items-center gap-2">
                <div className="text-h4 font-medium text-ink">Ручная сборка чека</div>
                {liveUpdateCount > 0 && (
                  <span
                    className="inline-flex items-center gap-1 rounded-full bg-warning-soft px-2 py-0.5 text-caption text-warning"
                    title={`SSE-уведомление: остатки обновлены ${liveUpdateCount} раз. Другие магазины списали/вернули товар прямо сейчас.`}
                  >
                    🔄 Остатки обновлены ({liveUpdateCount})
                  </span>
                )}
              </div>
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
