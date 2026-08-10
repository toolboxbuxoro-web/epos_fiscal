/**
 * Интеграционные тесты `buildMatch()` через реальный pipeline (не через
 * ручную сборку `MatcherPool`/`matches[]`, как в остальных тестах matcher —
 * см. комментарий в `multi-position-stock.test.ts`: «buildMatch недоступен
 * без SQLite, тестируем стратегии напрямую»).
 *
 * Мокаем ТОЛЬКО `@/lib/db` (`listEsfItems`/`countEsfItems`) — это единственная
 * точка, где `buildMatch`/`loadMatcherPool` трогают tauri-plugin-sql. Логгер
 * (`log.*`) трогать не нужно: `src/lib/log.ts::write()` сам оборачивает
 * `getDb()` в try/catch и не бросает наружу, поэтому в node-окружении
 * (vitest.config.ts: `environment: 'node'`) он просто no-op'ит с
 * `console.error` в фоне — безопасно оставить как есть.
 *
 * Два сценария:
 *
 *   1. Анти-микс лок (п.5 задачи): партия реально ЗАПИСЫВАЕТСЯ в
 *      `pool.chosenBatchByProduct` после позиции 1 (`lockChosenBatches`,
 *      приватная функция index.ts) и реально ЧИТАЕТСЯ позицией 2
 *      (`isBatchAllowed` внутри `tryPriceBucket`) — через настоящий
 *      `buildMatch()`, а не через ручную запись `pool.chosenBatchByProduct.set(...)`
 *      как во всех остальных анти-микс тестах (floor-and-batch-guard.test.ts).
 *
 *   2. Порядок вызовов внутри `buildMatch`: `distributeDiscount` →
 *      `distributeBump` → `enforceFloorOrUnmatch` (см. index.ts). Порядок
 *      важен в направлении bump: если `enforceFloorOrUnmatch` вызвать ДО
 *      `distributeBump`, позиция которая НИЖЕ floor до бампа, но ВЫШЕ floor
 *      после — была бы ошибочно отклонена (false reject). В обратную
 *      сторону (discount) порядок неважен, потому что `distributeDiscount`
 *      по конструкции никогда не режет ниже floor (см. её `maxBySelfCost`
 *      cap) — сам «выше floor после distribute» инвариант там гарантирован
 *      кодом, а не порядком вызова.
 */

import { describe, it, expect, vi } from 'vitest'
import type { EsfItemWithAvailable } from '@/lib/db'
import type {
  MsRetailDemand,
  MsRetailDemandPosition,
} from '@/lib/moysklad/types'
import type { MatchCandidate, PositionMatch } from '@/lib/matcher/types'

// ── DB mock (hoisted — виден и в фабрике vi.mock, и в теле тестов) ────────

const dbMock = vi.hoisted(() => {
  let items: EsfItemWithAvailable[] = []
  return {
    setItems: (next: EsfItemWithAvailable[]) => {
      items = next
    },
    listEsfItems: vi.fn(async () => items),
    countEsfItems: vi.fn(async () => items.length),
  }
})

vi.mock('@/lib/db', () => ({
  listEsfItems: dbMock.listEsfItems,
  countEsfItems: dbMock.countEsfItems,
}))

// Импортируем ПОСЛЕ vi.mock — стандартный порядок для vitest (сам вызов
// vi.mock всё равно хостится наверх модуля транформером).
const { buildMatch, distributeDiscount, distributeBump, enforceFloorOrUnmatch } =
  await import('@/lib/matcher')

// ── Helpers ────────────────────────────────────────────────────────────

let nextId = 1000

function mkItem(opts: {
  name: string
  unitPriceTiyin: number
  availableMilli: number
  vat?: number
  receivedAt?: number
}): EsfItemWithAvailable {
  const id = nextId++
  return {
    id,
    source: 'remote',
    external_id: null,
    name: opts.name,
    barcode: null,
    class_code: `0800000000000${String(id).padStart(4, '0')}`,
    package_code: '',
    vat_percent: opts.vat ?? 12,
    owner_type: 0,
    unit_price_tiyin: opts.unitPriceTiyin,
    qty_received: opts.availableMilli,
    qty_consumed: 0,
    received_at: opts.receivedAt ?? id,
    imported_at: 0,
    notes: null,
    server_item_id: id,
    available: opts.availableMilli,
  } as EsfItemWithAvailable
}

/** Минимальная МС-позиция чека: имя товара + цена/шт (тийины) + qty (шт). */
function mkMsPosition(opts: {
  id: string
  name: string
  price: number
  quantity?: number
  vat?: number
}): MsRetailDemandPosition {
  return {
    id: opts.id,
    quantity: opts.quantity ?? 1,
    price: opts.price,
    discount: 0,
    vat: opts.vat ?? 12,
    vatEnabled: true,
    assortment: {
      id: `${opts.id}-assortment`,
      name: opts.name,
      meta: { type: 'product' },
      attributes: [],
    },
  } as unknown as MsRetailDemandPosition
}

function mkReceipt(rows: MsRetailDemandPosition[], sum: number): MsRetailDemand {
  return {
    id: 'receipt-1',
    sum,
    positions: { rows },
  } as unknown as MsRetailDemand
}

// ── 1. Анти-микс: реальный write (позиция 1) → реальный read (позиция 2) ──

describe('buildMatch — анти-микс лок пишется и читается через реальный pipeline', () => {
  it('позиция 2 того же товара вынуждена использовать ТУ ЖЕ партию что и позиция 1, хотя без лока предпочла бы другую', async () => {
    // batchA: sellingPrice ровно совпадает с позицией 1 (лучший матч для неё).
    // unit 800_000 × markup10% × vat12% = 985_600 → ceil до 1000 сум → 1_000_000.
    const batchA = mkItem({
      name: 'Товар P',
      unitPriceTiyin: 800_000,
      availableMilli: 5000,
      receivedAt: 1,
    })
    // batchB: sellingPrice ровно совпадает с позицией 2 (был бы лучшим
    // матчем для неё БЕЗ анти-микс лока — diff=0 против diff=200_000 у A).
    // unit 950_000 × 1.10 × 1.12 = 1_170_400 → ceil до 1000 сум → 1_200_000.
    const batchB = mkItem({
      name: 'Товар P', // ТОТ ЖЕ нормализованный товар, ДРУГАЯ партия (id)
      unitPriceTiyin: 950_000,
      availableMilli: 5000,
      receivedAt: 2,
    })
    dbMock.setItems([batchA, batchB])

    const pos1 = mkMsPosition({ id: 'p1', name: 'Товар P', price: 1_000_000, quantity: 1 })
    const pos2 = mkMsPosition({ id: 'p2', name: 'Товар P', price: 1_200_000, quantity: 1 })
    const receipt = mkReceipt([pos1, pos2], 1_000_000 + 1_200_000)

    // toleranceTiyin=250_000 достаточно чтобы позиция 2 всё равно матчилась
    // партией A (diff=200_000), но НЕ настолько большое чтобы это было
    // тривиальным совпадением — если бы лок не сработал, позиция 2 выбрала
    // бы partию B (diff=0, строго лучше).
    const result = await buildMatch(receipt, { toleranceTiyin: 250_000 })

    expect(result.mode).toBe('classic') // сумма сошлась без holistic-фоллбэка
    expect(result.positions).toHaveLength(2)
    const [m1, m2] = result.positions as [PositionMatch, PositionMatch]
    expect(m1.candidates).toHaveLength(1)
    expect(m2.candidates).toHaveLength(1)

    // Позиция 1 (без конкуренции) естественно берёт partию A (diff=0).
    expect(m1.candidates[0]!.esfItem.id).toBe(batchA.id)

    // КЛЮЧЕВАЯ проверка: позиция 2 НЕ взяла partию B (которая была бы
    // ближе по цене), потому что реальный `lockChosenBatches` (вызванный
    // ПОСЛЕ финализации позиции 1 внутри buildMatch) записал partию A как
    // «залоченную» для «Товар P», а реальный `isBatchAllowed` (вызванный
    // ВНУТРИ tryPriceBucket для позиции 2) её прочитал и отфильтровал
    // partию B из кандидатов. Ни один pool.chosenBatchByProduct не
    // выставлялся руками в этом тесте — только настоящий buildMatch().
    expect(m2.candidates[0]!.esfItem.id).toBe(batchA.id)
    expect(m2.candidates[0]!.esfItem.id).not.toBe(batchB.id)

    // Сумма сошлась точно (без distribute — оба diff внутри tolerance).
    expect(result.matchedTotalTiyin).toBe(2_200_000)
    expect(result.totalDiffTiyin).toBe(0)
  })
})

// ── 2. Порядок: distributeDiscount → distributeBump → enforceFloorOrUnmatch ─

describe('index.ts — порядок distribute-проходов перед enforceFloorOrUnmatch', () => {
  /** Собрать HolisticLine-подобный MatchCandidate для конструирования matches вручную. */
  function mkCandidate(opts: {
    name: string
    unitPriceTiyin: number
    priceTiyin: number
    vat?: number
  }): MatchCandidate {
    const item = {
      id: nextId++,
      source: 'remote',
      external_id: null,
      name: opts.name,
      barcode: null,
      class_code: '08000000000000001',
      package_code: '',
      vat_percent: opts.vat ?? 12,
      owner_type: 0,
      unit_price_tiyin: opts.unitPriceTiyin,
      qty_received: 5000,
      qty_consumed: 0,
      received_at: 1,
      imported_at: 0,
      notes: null,
      server_item_id: nextId,
    } as EsfItemWithAvailable
    return {
      esfItem: item,
      quantity: 1000,
      priceTiyin: opts.priceTiyin,
      discountTiyin: 0,
      vatTiyin: 0,
    }
  }

  function mkPositionMatch(cand: MatchCandidate, totalTiyin: number): PositionMatch {
    return {
      source: {
        index: 0,
        name: cand.esfItem.name,
        quantity: 1000,
        totalTiyin,
        vatPercent: 12,
        classCode: null,
        packageCode: null,
        barcode: null,
        linkedBuhName: null,
      },
      candidates: [cand],
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
  }

  it('позиция ниже floor ДО bump, но выше floor ПОСЛЕ — реальный порядок (bump затем enforce) её НЕ отклоняет', () => {
    // unit 1_000_000, vat 12 → floor = ceil(1_120_000 × 1.05) = 1_176_000.
    // Кандидат стартует на 800_000 (ниже floor намеренно — симулируем
    // «строку которую бы отклонили, если бы floor-проверка шла раньше
    // bump'а»). target = 1_200_000, то есть diff = 400_000 который
    // distributeBump обязан закрыть (bump-cap по умолчанию 1_000_000).
    const cand = mkCandidate({ name: 'Товар', unitPriceTiyin: 1_000_000, priceTiyin: 800_000 })
    const matches = [mkPositionMatch(cand, 1_200_000)]
    const target = 1_200_000

    // Реальный порядок как в buildMatch (см. index.ts): discount → bump → enforce.
    distributeDiscount(matches, target, { discountForExactSum: true })
    distributeBump(matches, target, { discountForExactSum: true })
    const warnings = enforceFloorOrUnmatch(matches)

    // bump поднял priceTiyin с 800_000 до 1_200_000 (400_000 < cap 1_000_000),
    // что выше floor 1_176_000 — enforceFloorOrUnmatch НЕ должен отклонить.
    expect(matches[0]!.candidates[0]!.priceTiyin).toBe(1_200_000)
    expect(matches[0]!.candidates).toHaveLength(1)
    expect(warnings).toHaveLength(0)
  })

  it('та же стартовая позиция: если enforceFloorOrUnmatch вызвать ДО bump (неправильный порядок) — ложное отклонение', () => {
    // Тот же кандидат, тот же target — НО порядок вызовов НАРОЧНО неверный
    // (enforce ДО bump), чтобы показать что такое рассинхронизация
    // порядка реально ломает результат. Этот тест документирует ПОЧЕМУ
    // buildMatch держит enforceFloorOrUnmatch строго последним.
    const cand = mkCandidate({ name: 'Товар', unitPriceTiyin: 1_000_000, priceTiyin: 800_000 })
    const matches = [mkPositionMatch(cand, 1_200_000)]
    const target = 1_200_000

    // НЕПРАВИЛЬНЫЙ порядок — enforce первым.
    const warningsWrongOrder = enforceFloorOrUnmatch(matches)
    // 800_000 < floor 1_176_000 → отклонено ДО того как bump успел бы поднять цену.
    expect(matches[0]!.candidates).toHaveLength(0)
    expect(warningsWrongOrder.length).toBeGreaterThan(0)

    // bump после этого — бесполезен, candidates уже пуст (позиция потеряна).
    distributeBump(matches, target, { discountForExactSum: true })
    expect(matches[0]!.candidates).toHaveLength(0)
  })
})
