/**
 * Интеграционные тесты recalculateAfterSwap + manual floor/анти-микс логика.
 *
 * Проверяем end-to-end что после ручного swap товара (стрелки ←/→):
 *   1. below-floor warning ПОЯВЛЯЕТСЯ если новый приход продаётся ниже +5%
 *   2. below-floor warning ИСЧЕЗАЕТ если свапнули обратно на нормальный
 *   3. цены без тийинов (distributeDiscount/Bump округляют)
 *   4. сумма сходится на target
 *   5. (НОВОЕ) свап ОТКЛОНЯЕТСЯ если он создал бы анти-микс — другая
 *      позиция чека уже держит ДРУГУЮ партию того же нормализованного
 *      товара (см. описание «дыры свапа» ниже)
 *
 * ── «Дыра свапа» (исправлена в этом файле правками к index.ts) ──────────
 *
 * До фикса: позиция 1 строится ДО того как позиция 2 (тот же товар,
 * например через multi-item/price-bucket) залочила свою партию —
 * `alternatives` позиции 1 это застывший снимок с момента ЕЁ собственной
 * постройки и не пересчитывается при последующих рендерах. Кассир жмёт
 * стрелку `←`/`→` у позиции 1 и получает возможность выбрать партию B,
 * которая на самом деле уже занята позицией 2 → в чеке оказываются ДВЕ
 * партии одного товара, обходя анти-микс правило.
 *
 * После фикса: `recalculateAfterSwap` перед применением свапа проверяет,
 * не держит ли уже ДРУГАЯ позиция чека тот же нормализованный товар из
 * ДРУГОЙ партии (esf_item.id). Если да — свап ОТКЛОНЯЕТСЯ: `result`
 * возвращается с ТЕМИ ЖЕ positions (selectedAlternativeIndex не меняется),
 * но с добавленным warning'ом «Свап отклонён (анти-микс): …» — и Receipt.tsx
 * (`applySwap`) детектит это и кидает toast, так что кассир не видит
 * молчаливый no-op.
 *
 * ── Про раздел «ManualReceiptModal floor-логика» ниже ───────────────────
 *
 * Раньше `manualBelowFloor` был ЧИСТОЙ КОПИЕЙ всей floor-логики
 * `ManualReceiptModal.done()`, и `done()` использовал результат ТОЛЬКО для
 * warning-тоста — план всё равно уходил в `onDone()` (в обход floor-guard'а,
 * который есть в classic/holistic авто-подборе). Это была дыра: «предупреждаем
 * но пропускаем».
 *
 * Теперь `done()` в ManualReceiptModal.tsx БЛОКИРУЕТ — не вызывает `onDone()`
 * если есть below-floor ИЛИ анти-микс нарушение (см. `manualPlan` useMemo +
 * `done()` в ManualReceiptModal.tsx). `manualBelowFloor` ниже остаётся
 * валидной как копия ЧАСТИ детектирующей логики (какие позиции ниже floor),
 * но теперь она документирует вход в БЛОКИРУЮЩУЮ проверку, не в
 * «предупреждаем и всё равно отдаём план». Полноценный React-тест самого
 * компонента не заведён в этом репо (нет @testing-library/react в
 * devDependencies, vitest.config.ts — `environment: 'node'`), поэтому здесь
 * — pure-копия детектирующей логики, а полная блокировка описана и
 * задокументирована прямо в ManualReceiptModal.tsx (`manualPlan`/`done()`).
 */

import { describe, it, expect } from 'vitest'
import { recalculateAfterSwap } from '@/lib/matcher'
import { normalizeForLink, priceFloorTiyin, TIYIN_PER_SUM } from '@/lib/matcher/strategies'
import type {
  BuildMatchResult,
  MatchCandidate,
  PositionMatch,
} from '@/lib/matcher/types'
import type { EsfItemRow } from '@/lib/db'
import type { MsRetailDemand } from '@/lib/moysklad/types'

function mkItem(unitPrice: number, name: string, vat = 12): EsfItemRow {
  return {
    id: Math.floor(unitPrice / 1000),
    source: 'remote',
    external_id: null,
    name,
    barcode: null,
    class_code: '08000000000000000',
    package_code: '',
    vat_percent: vat,
    unit_price_tiyin: unitPrice,
    qty_received: 100_000,
    qty_consumed: 0,
    server_item_id: Math.floor(unitPrice / 1000),
    received_at: 0,
  } as EsfItemRow
}

function mkCand(item: EsfItemRow, priceTiyin: number): MatchCandidate {
  return { esfItem: item, quantity: 1000, priceTiyin, discountTiyin: 0, vatTiyin: 0 }
}

/** BuildMatchResult с одной swappable-позицией и 2 альтернативами. */
function mkSwappableResult(opts: {
  currentItem: EsfItemRow
  currentPrice: number
  altItem: EsfItemRow
  altPrice: number
  receiptSum: number
}): BuildMatchResult {
  const current = mkCand(opts.currentItem, opts.currentPrice)
  const alt = mkCand(opts.altItem, opts.altPrice)
  const pos: PositionMatch = {
    source: {
      index: 0,
      name: 'pos',
      quantity: 1000,
      totalTiyin: opts.receiptSum,
      vatPercent: 12,
      classCode: null,
      packageCode: null,
      barcode: null,
      linkedBuhName: null,
    },
    candidates: [current],
    strategy: 'price-bucket',
    diffTiyin: 0,
    warnings: [],
    swappable: true,
    alternatives: [current, alt],
    selectedAlternativeIndex: 0,
    splitLevel: 1,
    canSplitMore: false,
    splittable: true,
  } as PositionMatch
  return {
    receipt: { id: 'r1', sum: opts.receiptSum } as MsRetailDemand,
    positions: [pos],
    overallStrategy: 'price-bucket',
    totalDiffTiyin: 0,
    originalTotalTiyin: opts.receiptSum,
    matchedTotalTiyin: opts.currentPrice,
    canAutoFiscalize: false,
    warnings: [],
    mode: 'classic',
  }
}

describe('recalculateAfterSwap — floor warning после swap', () => {
  it('swap на дорогой приход (ниже +5%) → warning появляется', () => {
    // Текущий: дешёвый приход 500k (floor 588k), продаём за 700k — OK.
    // Альтернатива: дорогой приход 850k (floor 999600), но клиент платит 700k.
    const current = mkItem(500_000, 'Дешёвый')
    const alt = mkItem(850_000, 'Дорогой')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 700_000, // та же цена (клиент заплатил столько), но дорогой приход
      receiptSum: 700_000,
    })
    // Изначально нет warning
    expect(result.warnings.filter((w) => w.includes('минимальной цены'))).toHaveLength(0)

    // Swap на альтернативу (индекс 1 = дорогой приход)
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    // floor дорогого 999600 > 700000 → warning
    const floorAlt = priceFloorTiyin(850_000, 12, 1000)
    expect(floorAlt).toBe(999_600)
    const floorWarnings = swapped.warnings.filter((w) =>
      w.includes('ниже минимальной цены'),
    )
    expect(floorWarnings.length).toBeGreaterThan(0)
    expect(floorWarnings[0]).toContain('Дорогой')
  })

  it('swap обратно на дешёвый → warning исчезает', () => {
    const current = mkItem(850_000, 'Дорогой') // стартуем с дорогого
    const alt = mkItem(500_000, 'Дешёвый')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 700_000,
      receiptSum: 700_000,
    })
    // Swap на дешёвый (индекс 1)
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    // Дешёвый floor 588000 < 700000 → нет warning
    const floorWarnings = swapped.warnings.filter((w) =>
      w.includes('ниже минимальной цены'),
    )
    expect(floorWarnings).toHaveLength(0)
  })

  it('после swap цены без тийинов', () => {
    const current = mkItem(500_000, 'A')
    const alt = mkItem(600_000, 'B')
    const result = mkSwappableResult({
      currentItem: current,
      currentPrice: 700_000,
      altItem: alt,
      altPrice: 800_000,
      receiptSum: 700_000,
    })
    const swapped = recalculateAfterSwap(result, 0, 1, {
      discountForExactSum: true,
    })
    for (const m of swapped.positions) {
      for (const c of m.candidates) {
        const effective = c.priceTiyin - c.discountTiyin
        expect(effective % TIYIN_PER_SUM).toBe(0) // без тийинов
      }
    }
  })

  it('невалидный индекс позиции → no-op', () => {
    const result = mkSwappableResult({
      currentItem: mkItem(500_000, 'A'),
      currentPrice: 700_000,
      altItem: mkItem(600_000, 'B'),
      altPrice: 800_000,
      receiptSum: 700_000,
    })
    expect(recalculateAfterSwap(result, 99, 0, {})).toBe(result)
  })
})

// ── «Дыра свапа» — анти-микс между ДВУМЯ позициями чека ──────────────

/** BuildMatchResult с ДВУМЯ позициями — нужен для анти-микс сценариев. */
function mkTwoPositionResult(pos1: PositionMatch, pos2: PositionMatch, receiptSum: number): BuildMatchResult {
  return {
    receipt: { id: 'r1', sum: receiptSum } as MsRetailDemand,
    positions: [pos1, pos2],
    overallStrategy: 'price-bucket',
    totalDiffTiyin: 0,
    originalTotalTiyin: receiptSum,
    matchedTotalTiyin: receiptSum,
    canAutoFiscalize: false,
    warnings: [],
    mode: 'classic',
  }
}

describe('recalculateAfterSwap — анти-микс между позициями (дыра свапа, п.3)', () => {
  // Общий товар «Дрель X» представлен ДВУМЯ партиями: locked (уже держит
  // позиция 2) и conflicting (другая партия того же товара — НЕ должна
  // попасть в чек одновременно с locked).
  const locked = mkItem(400_000, 'Дрель X')
  const conflicting = mkItem(500_000, 'Дрель X') // тот же name, ДРУГОЙ id
  const other = mkItem(300_000, 'Прочий товар') // позиция 1 стартует с этого

  function mkScenario(): BuildMatchResult {
    // Позиция 1: swappable, текущий candidate = other, альтернативы:
    //   [0] other (текущий выбор)
    //   [1] conflicting — та же «Дрель X», но ДРУГАЯ партия чем у позиции 2
    //   [2] locked — «Дрель X», ТА ЖЕ партия что уже держит позиция 2 (OK)
    const pos1: PositionMatch = {
      source: {
        index: 0,
        name: 'pos1',
        quantity: 1000,
        totalTiyin: 700_000,
        vatPercent: 12,
        classCode: null,
        packageCode: null,
        barcode: null,
        linkedBuhName: null,
      },
      candidates: [mkCand(other, 700_000)],
      strategy: 'price-bucket',
      diffTiyin: 0,
      warnings: [],
      swappable: true,
      alternatives: [
        mkCand(other, 700_000),
        mkCand(conflicting, 700_000),
        mkCand(locked, 700_000),
      ],
      selectedAlternativeIndex: 0,
      splitLevel: 1,
      canSplitMore: false,
      splittable: true,
    }
    // Позиция 2: НЕ swappable, уже держит `locked` (как если бы её сначала
    // размэтчил passthrough/multi-item и залочил партию на весь чек).
    const pos2: PositionMatch = {
      source: {
        index: 1,
        name: 'pos2',
        quantity: 1000,
        totalTiyin: 700_000,
        vatPercent: 12,
        classCode: null,
        packageCode: null,
        barcode: null,
        linkedBuhName: null,
      },
      candidates: [mkCand(locked, 700_000)],
      strategy: 'passthrough',
      diffTiyin: 0,
      warnings: [],
      swappable: false,
      alternatives: [],
      selectedAlternativeIndex: -1,
      splitLevel: 1,
      canSplitMore: false,
      splittable: false,
    }
    return mkTwoPositionResult(pos1, pos2, 1_400_000)
  }

  it('своп на партию, уже занятую ДРУГОЙ позицией из ДРУГОГО батча → отклонён БЕЗ изменений', () => {
    const result = mkScenario()
    const swapped = recalculateAfterSwap(result, 0, 1, { discountForExactSum: true })

    // Позиции не поменялись (та же ссылка — early-return до клонирования).
    expect(swapped.positions).toBe(result.positions)
    expect(swapped.positions[0]!.selectedAlternativeIndex).toBe(0) // не 1
    expect(swapped.positions[0]!.candidates[0]!.esfItem.id).toBe(other.id)

    // Warning объясняет причину, не молчим.
    const reason = swapped.warnings.find((w) => w.startsWith('Свап отклонён'))
    expect(reason).toBeDefined()
    expect(reason).toContain('Дрель X')
  })

  it('своп на ТУ ЖЕ партию что уже держит другая позиция (тот же id) → РАЗРЕШЁН', () => {
    const result = mkScenario()
    // index 2 = locked — тот же esf_item.id что и у позиции 2, это НЕ микс.
    const swapped = recalculateAfterSwap(result, 0, 2, { discountForExactSum: true })

    expect(swapped.positions[0]!.selectedAlternativeIndex).toBe(2)
    expect(swapped.positions[0]!.candidates[0]!.esfItem.id).toBe(locked.id)
    // Обе позиции теперь ссылаются на одну и ту же партию — это разрешённый
    // случай (один товар = одна партия, условие выполнено).
    expect(swapped.positions[1]!.candidates[0]!.esfItem.id).toBe(locked.id)
    expect(swapped.warnings.some((w) => w.startsWith('Свап отклонён'))).toBe(false)
  })

  it('после отклонённого свапа последующий ДОПУСТИМЫЙ свап очищает стейл-warning', () => {
    const result = mkScenario()
    const rejected = recalculateAfterSwap(result, 0, 1, { discountForExactSum: true })
    expect(rejected.warnings.some((w) => w.startsWith('Свап отклонён'))).toBe(true)

    // Кассир пробует другой (допустимый) вариант на ТОМ ЖЕ result'е —
    // старое предупреждение не должно остаться висеть в warnings навсегда.
    const resolved = recalculateAfterSwap(rejected, 0, 2, { discountForExactSum: true })
    expect(resolved.positions[0]!.selectedAlternativeIndex).toBe(2)
    expect(resolved.warnings.some((w) => w.startsWith('Свап отклонён'))).toBe(false)
  })

  it('повторный клик на тот же отклонённый вариант не плодит дубли warning', () => {
    const result = mkScenario()
    const first = recalculateAfterSwap(result, 0, 1, { discountForExactSum: true })
    const second = recalculateAfterSwap(first, 0, 1, { discountForExactSum: true })
    const count = second.warnings.filter((w) => w.startsWith('Свап отклонён')).length
    expect(count).toBe(1)
  })
})

// ── Manual modal floor-логика (pure copy из done()) ─────────────────

/**
 * Копия floor-проверки из ManualReceiptModal.done(). Возвращает имена
 * позиций ниже floor (для toast-warning).
 */
function manualBelowFloor(
  selected: Array<{ unitPrice: number; vat: number; sellingPrice: number; qty: number; name: string }>,
): string[] {
  const out: string[] = []
  for (const s of selected) {
    if (s.qty <= 0) continue
    const quantityMilli = s.qty * 1000
    const priceTiyin = s.sellingPrice * s.qty
    const floor = priceFloorTiyin(s.unitPrice, s.vat, quantityMilli)
    if (priceTiyin > 0 && priceTiyin < floor) out.push(s.name)
  }
  return out
}

describe('ManualReceiptModal floor-логика', () => {
  it('markup 10% — sellingPrice выше floor, нет warning', () => {
    // unit 500000, markup 10%, vat 12 → selling = round_up(500000×1.10×1.12)=700000
    // floor = 588000. 700000 > 588000 → OK.
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1, name: 'A' },
    ])
    expect(below).toHaveLength(0)
  })

  it('markup 0% (упрощёнка) — selling = себестоимость, НИЖЕ floor → warning', () => {
    // unit 500000, markup 0 → selling ≈ round_up(560000) = 600000.
    // floor = 588000. 600000 > 588000 на самом деле OK из-за округления вверх.
    // Возьмём кейс где округление не спасает: unit 1000000.
    // markup 0 → selling round_up(1000000×1.12=1120000, 1000сум) = 1120000.
    // floor = round(1120000×1.05) ceilToSum = 1176000. 1120000 < 1176000 → warning.
    const below = manualBelowFloor([
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1, name: 'Упрощёнка' },
    ])
    expect(below).toContain('Упрощёнка')
  })

  it('qty масштабирует floor пропорционально', () => {
    // 3 шт: selling 700000×3=2100000, floor 588000×3=1764000 → OK
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 3, name: 'A' },
    ])
    expect(below).toHaveLength(0)
  })

  it('qty=0 игнорируется', () => {
    const below = manualBelowFloor([
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 0, name: 'X' },
    ])
    expect(below).toHaveLength(0)
  })

  it('несколько товаров — только ниже floor в списке', () => {
    const below = manualBelowFloor([
      { unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1, name: 'OK' },
      { unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1, name: 'BAD' },
    ])
    expect(below).toEqual(['BAD'])
  })
})

// ── ManualReceiptModal — план БЛОКИРУЕТСЯ (не просто warning), п.1 ─────

interface ManualSelectedRow {
  /** esf_item.id — партия. */
  id: number
  name: string
  unitPrice: number
  vat: number
  sellingPrice: number
  qty: number
}

/**
 * Pure-копия ОБЕИХ блокирующих проверок из `ManualReceiptModal.tsx`
 * (`manualPlan` useMemo + `done()`): floor и анти-микс между партиями.
 *
 * До фикса `done()` эти нарушения только ДИАГНОСТИРОВАЛ (toast) и ВСЁ РАВНО
 * вызывал `onDone(plan)` — план уходил на фискализацию в обход floor-guard'а
 * и анти-микс правила, которые есть в classic/holistic авто-подборе. Теперь
 * `done()` не вызывает `onDone()` вовсе, если `blocked === true` здесь.
 */
function manualPlanDecision(selected: ManualSelectedRow[]): {
  blocked: boolean
  belowFloorNames: string[]
  mixedProductKeys: string[]
} {
  const belowFloorNames: string[] = []
  const batchesByProduct = new Map<string, Set<number>>()
  for (const s of selected) {
    if (s.qty <= 0) continue
    const quantityMilli = s.qty * 1000
    const priceTiyin = s.sellingPrice * s.qty
    const floor = priceFloorTiyin(s.unitPrice, s.vat, quantityMilli)
    if (priceTiyin > 0 && priceTiyin < floor) belowFloorNames.push(s.name)
    const key = normalizeForLink(s.name)
    if (!batchesByProduct.has(key)) batchesByProduct.set(key, new Set())
    batchesByProduct.get(key)!.add(s.id)
  }
  const mixedProductKeys: string[] = []
  batchesByProduct.forEach((ids, key) => {
    if (ids.size > 1) mixedProductKeys.push(key)
  })
  return {
    blocked: belowFloorNames.length > 0 || mixedProductKeys.length > 0,
    belowFloorNames,
    mixedProductKeys,
  }
}

describe('ManualReceiptModal — план блокируется (не просто warning), п.1', () => {
  it('below-floor строка → blocked=true (план НЕ отдаётся кассой в ОФД)', () => {
    const decision = manualPlanDecision([
      { id: 1, name: 'Упрощёнка', unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1 },
    ])
    expect(decision.blocked).toBe(true)
    expect(decision.belowFloorNames).toContain('Упрощёнка')
  })

  it('нормальная позиция (выше floor, одна партия) — НЕ блокирует', () => {
    const decision = manualPlanDecision([
      { id: 1, name: 'A', unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1 },
    ])
    expect(decision.blocked).toBe(false)
  })

  it('анти-микс: два РАЗНЫХ esf_item.id одного нормализованного товара → блокирует', () => {
    // Тот же товар добавлен из справочника ДВАЖДЫ — двумя разными строками
    // (разные партии, значит разная себестоимость), имена отличаются только
    // регистром/пробелами (normalizeForLink их уравнивает).
    const decision = manualPlanDecision([
      { id: 1, name: 'Дрель X', unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1 },
      { id: 2, name: 'дрель  x', unitPrice: 400_000, vat: 12, sellingPrice: 600_000, qty: 1 },
    ])
    expect(decision.blocked).toBe(true)
    expect(decision.mixedProductKeys).toContain(normalizeForLink('Дрель X'))
  })

  it('один и тот же id повторно (просто увеличили qty) — это НЕ анти-микс', () => {
    const decision = manualPlanDecision([
      { id: 1, name: 'Дрель X', unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 3 },
    ])
    expect(decision.blocked).toBe(false)
  })

  it('два РАЗНЫХ товара (разные имена, разные id) — не анти-микс, не блокирует', () => {
    const decision = manualPlanDecision([
      { id: 1, name: 'Дрель X', unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1 },
      { id: 2, name: 'Перфоратор Y', unitPrice: 400_000, vat: 12, sellingPrice: 600_000, qty: 1 },
    ])
    expect(decision.blocked).toBe(false)
  })

  it('одновременно floor И анти-микс — blocked=true, обе причины видны', () => {
    const decision = manualPlanDecision([
      { id: 1, name: 'Дрель X', unitPrice: 500_000, vat: 12, sellingPrice: 700_000, qty: 1 },
      { id: 2, name: 'Дрель X', unitPrice: 400_000, vat: 12, sellingPrice: 600_000, qty: 1 },
      { id: 3, name: 'Упрощёнка', unitPrice: 1_000_000, vat: 12, sellingPrice: 1_120_000, qty: 1 },
    ])
    expect(decision.blocked).toBe(true)
    expect(decision.belowFloorNames).toContain('Упрощёнка')
    expect(decision.mixedProductKeys).toContain(normalizeForLink('Дрель X'))
  })
})
