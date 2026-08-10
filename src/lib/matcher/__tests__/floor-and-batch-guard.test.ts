/**
 * Тесты бизнес-требования владельца (дословно): «ниже себестоимости не
 * должно продаваться вообще, запрет. Партия за 191 тысячу не должна ниже
 * себестоимости никак, партия того же товара за 121 тысячу не должна ниже
 * себестоимости. И не должна смешиваться с другой партией, хоть и в одном
 * чеке».
 *
 * Два независимых правила:
 *
 *   1. ЖЁСТКИЙ ЗАПРЕТ продажи ниже floor (себестоимость+5%) — раньше это
 *      было только предупреждением (`collectBelowFloorWarnings`), теперь
 *      стратегии фильтруют убыточных кандидатов ДО выбора
 *      (`tryLinkedMsVariant`/`tryPassthrough`/`tryPriceBucket`/`tryMultiItem`,
 *      `planHolistic`), плюс финальная страховка после сборки плана
 *      (`enforceFloorOrUnmatch` для classic, `findBelowFloorLine` для
 *      holistic).
 *
 *   2. АНТИ-МИКС: один товар (по нормализованному имени, см.
 *      `normalizeForLink`) = одна партия на весь чек. `isBatchAllowed` +
 *      `MatcherPool.chosenBatchByProduct` в classic-режиме,
 *      «коллапс до FIFO-самого-старого батча на товар» в holistic.
 *
 * Реальный кейс-триггер (упомянут в задаче): чек 413130402658, где matcher
 * взял 1 шт из партии за 111 185 и 4 шт из партии за 196 899 ОДНОГО товара
 * в одном чеке — voспроизведено в группе «Запрет смешивания» ниже.
 */

import { describe, it, expect } from 'vitest'
import {
  isBatchAllowed,
  normalizeForLink,
  poolRemaining,
  priceFloorTiyin,
  tryLinkedMsVariant,
  tryMultiItem,
  tryPassthrough,
  tryPriceBucket,
  type MatcherPool,
  type PoolItem,
} from '@/lib/matcher/strategies'
import { enforceFloorOrUnmatch } from '@/lib/matcher'
import { findBelowFloorLine, planHolistic } from '@/lib/matcher/holistic'
import type { EsfItemWithAvailable } from '@/lib/db'
import type {
  HolisticLine,
  MatchCandidate,
  NormalizedPosition,
  PositionMatch,
} from '@/lib/matcher/types'

// ── Helpers ──────────────────────────────────────────────────────────────

let nextId = 1

function mkItem(opts: {
  name: string
  unitPriceTiyin: number
  availableMilli: number
  vat?: number
  classCode?: string
  receivedAt?: number
  id?: number
}): EsfItemWithAvailable {
  const id = opts.id ?? nextId++
  return {
    id,
    source: 'remote',
    external_id: null,
    name: opts.name,
    barcode: null,
    class_code: opts.classCode ?? `0800000000000${String(id).padStart(4, '0')}`,
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

/** PoolItem с ЯВНО заданной sellingPrice (не через calculateSellingPrice) —
 * нужен точный контроль над числами в тестах анти-микс/floor. */
function mkPoolItem(item: EsfItemWithAvailable, sellingPrice: number): PoolItem {
  return { item, sellingPrice }
}

function mkPool(poolItems: PoolItem[]): MatcherPool {
  const minSellingPrice = poolItems.reduce(
    (m, p) => (p.sellingPrice > 0 && p.sellingPrice < m ? p.sellingPrice : m),
    Number.POSITIVE_INFINITY,
  )
  const remainingById = new Map<number, number>(
    poolItems.map((p) => [p.item.id, p.item.available]),
  )
  return {
    items: poolItems,
    minSellingPrice: Number.isFinite(minSellingPrice) ? minSellingPrice : 0,
    remainingById,
    chosenBatchByProduct: new Map<string, number>(),
  }
}

function mkPos(opts: {
  totalTiyin: number
  quantity?: number
  classCode?: string | null
  linkedBuhName?: string | null
}): NormalizedPosition {
  return {
    index: 0,
    name: 'Test Position',
    quantity: opts.quantity ?? 1000,
    totalTiyin: opts.totalTiyin,
    vatPercent: 12,
    classCode: opts.classCode ?? null,
    packageCode: null,
    barcode: null,
    linkedBuhName: opts.linkedBuhName ?? null,
  }
}

// ── 1. isBatchAllowed / normalizeForLink — базовые правила ────────────────

describe('normalizeForLink + isBatchAllowed — базовые правила анти-микс', () => {
  it('одинаковые имена (с точностью до регистра/пробелов) → один ключ', () => {
    expect(normalizeForLink('Дрель  Bosch  GSB13RE')).toBe(
      normalizeForLink('дрель bosch gsb13re'),
    )
  })

  it('isBatchAllowed: true если товар ещё не залочен', () => {
    const pool = mkPool([])
    const item = mkItem({ name: 'Дрель', unitPriceTiyin: 100_000, availableMilli: 1000 })
    expect(isBatchAllowed(pool, item)).toBe(true)
  })

  it('isBatchAllowed: true если залочена именно эта партия (тот же id)', () => {
    const pool = mkPool([])
    const item = mkItem({ name: 'Дрель', unitPriceTiyin: 100_000, availableMilli: 1000 })
    pool.chosenBatchByProduct!.set(normalizeForLink(item.name), item.id)
    expect(isBatchAllowed(pool, item)).toBe(true)
  })

  it('isBatchAllowed: false если залочена ДРУГАЯ партия того же товара', () => {
    const pool = mkPool([])
    const itemA = mkItem({ name: 'Дрель', unitPriceTiyin: 100_000, availableMilli: 1000 })
    const itemB = mkItem({ name: 'Дрель', unitPriceTiyin: 200_000, availableMilli: 1000 })
    pool.chosenBatchByProduct!.set(normalizeForLink(itemA.name), itemA.id)
    expect(isBatchAllowed(pool, itemB)).toBe(false)
    expect(isBatchAllowed(pool, itemA)).toBe(true)
  })

  it('без chosenBatchByProduct (ad-hoc пул) — ограничений нет', () => {
    const pool = mkPool([])
    delete pool.chosenBatchByProduct
    const item = mkItem({ name: 'Дрель', unitPriceTiyin: 100_000, availableMilli: 1000 })
    expect(isBatchAllowed(pool, item)).toBe(true)
  })
})

// ── 2. tryLinkedMsVariant — floor + анти-микс ──────────────────────────────

describe('tryLinkedMsVariant — жёсткий запрет ниже floor', () => {
  it('партия дороже суммы позиции (клиент заплатил меньше floor) → не выбирается, возвращает null', () => {
    // unit 1_000_000, vat 12 → cost 1_120_000, floor = ceil(1_120_000*1.05) = 1_176_000.
    const expensive = mkItem({
      name: 'Дрель Bosch GSB13RE',
      unitPriceTiyin: 1_000_000,
      availableMilli: 5000,
    })
    const floor = priceFloorTiyin(1_000_000, 12, 1000)
    expect(floor).toBe(1_176_000)

    const pool = mkPool([mkPoolItem(expensive, 999_999)])
    const pos = mkPos({ totalTiyin: 700_000, linkedBuhName: 'Дрель Bosch GSB13RE' })

    const m = tryLinkedMsVariant(pos, pool, {})
    expect(m).toBeNull()
  })

  it('выбирается более дешёвая подходящая партия, дорогая партия исключена (и из candidates, и из alternatives)', () => {
    const expensive = mkItem({
      name: 'Дрель Bosch GSB13RE',
      unitPriceTiyin: 1_000_000, // floor 1_176_000
      availableMilli: 5000,
      receivedAt: 1,
    })
    const cheap = mkItem({
      name: 'Дрель Bosch GSB13RE',
      unitPriceTiyin: 400_000, // cost 448_000, floor = ceil(470_400) = 470_400
      availableMilli: 5000,
      receivedAt: 2,
    })
    expect(priceFloorTiyin(400_000, 12, 1000)).toBe(470_400)

    const pool = mkPool([mkPoolItem(expensive, 999_999), mkPoolItem(cheap, 999_999)])
    const pos = mkPos({ totalTiyin: 700_000, linkedBuhName: 'Дрель Bosch GSB13RE' })

    const m = tryLinkedMsVariant(pos, pool, {})
    expect(m).not.toBeNull()
    expect(m!.candidates).toHaveLength(1)
    expect(m!.candidates[0]!.esfItem.id).toBe(cheap.id)
    // Дорогая партия не должна попасть даже в alternatives (swap не может
    // предложить кассиру убыточный выбор).
    expect(m!.alternatives.some((a) => a.esfItem.id === expensive.id)).toBe(false)
    expect(m!.alternatives.every((a) => a.esfItem.id === cheap.id)).toBe(true)
  })

  it('ни одна партия не проходит по минимальной цене → null (даже если остатка достаточно)', () => {
    const a = mkItem({ name: 'X', unitPriceTiyin: 1_000_000, availableMilli: 5000 })
    const b = mkItem({ name: 'X', unitPriceTiyin: 900_000, availableMilli: 5000 })
    const pool = mkPool([mkPoolItem(a, 1), mkPoolItem(b, 1)])
    // Клиент заплатил очень мало — обе партии дороже floor.
    const pos = mkPos({ totalTiyin: 100_000, linkedBuhName: 'X' })
    const m = tryLinkedMsVariant(pos, pool, {})
    expect(m).toBeNull()
  })

  it('anti-mix: партия уже залочена под другой позицией → linked-ms не предлагает другую партию', () => {
    const older = mkItem({
      name: 'Перфоратор Makita',
      unitPriceTiyin: 300_000, // floor ~ 352_800, дёшево, подходит
      availableMilli: 1000, // всего 1 шт
      receivedAt: 1,
    })
    const newer = mkItem({
      name: 'Перфоратор Makita',
      unitPriceTiyin: 300_000,
      availableMilli: 5000,
      receivedAt: 2,
    })
    const pool = mkPool([mkPoolItem(older, 1), mkPoolItem(newer, 1)])
    // Залочим товар на `newer` вручную (как будто другая позиция уже его выбрала).
    pool.chosenBatchByProduct!.set(normalizeForLink(newer.name), newer.id)

    const pos = mkPos({ totalTiyin: 500_000, linkedBuhName: 'Перфоратор Makita' })
    const m = tryLinkedMsVariant(pos, pool, {})
    expect(m).not.toBeNull()
    // FIFO обычно выбрал бы `older` (received_at=1), но он занят другим товаром → должен взять newer.
    expect(m!.candidates[0]!.esfItem.id).toBe(newer.id)
  })
})

// ── 3. tryPassthrough — floor ──────────────────────────────────────────────

describe('tryPassthrough — жёсткий запрет ниже floor', () => {
  it('единственный кандидат с ИКПУ ниже floor → passthrough не матчит (null)', () => {
    const item = mkItem({
      name: 'Дорогой',
      unitPriceTiyin: 1_000_000,
      availableMilli: 5000,
      classCode: '12345678901234567',
    })
    // sellingPrice override делаем НАМЕРЕННО ниже floor (симулируем markup < 5%,
    // например упрощёнка с ручной настройкой наценки).
    const pool = mkPool([mkPoolItem(item, 800_000)]) // floor(1_000_000,12,1000)=1_176_000 > 800_000
    const pos = mkPos({ totalTiyin: 800_000, classCode: item.class_code, quantity: 1000 })
    const m = tryPassthrough(pos, pool, {})
    expect(m).toBeNull()
  })

  it('кандидат с sellingPrice выше floor → матчит как обычно (регресс)', () => {
    const item = mkItem({
      name: 'Обычный',
      unitPriceTiyin: 500_000, // floor 588_000
      availableMilli: 5000,
      classCode: '99998888777766665',
    })
    const pool = mkPool([mkPoolItem(item, 700_000)])
    const pos = mkPos({ totalTiyin: 700_000, classCode: item.class_code, quantity: 1000 })
    const m = tryPassthrough(pos, pool, {})
    expect(m).not.toBeNull()
    expect(m!.candidates[0]!.esfItem.id).toBe(item.id)
  })
})

// ── 4. tryPriceBucket — floor фильтрация кандидатов ────────────────────────

describe('tryPriceBucket — убыточные кандидаты отфильтрованы', () => {
  it('дорогая партия (floor > pos.totalTiyin) исключена из inRange, дешёвая выбрана', () => {
    const expensive = mkItem({
      name: 'Дорогой',
      unitPriceTiyin: 1_000_000, // floor 1_176_000
      availableMilli: 5000,
    })
    const cheap = mkItem({
      name: 'Дешёвый',
      unitPriceTiyin: 400_000, // floor 470_400
      availableMilli: 5000,
    })
    // Обе цены близки к target=700_000 — без floor-фильтра expensive был бы
    // лучшим match'ем (diff=0).
    const pool = mkPool([mkPoolItem(expensive, 700_000), mkPoolItem(cheap, 720_000)])
    const pos = mkPos({ totalTiyin: 700_000 })
    const m = tryPriceBucket(pos, pool, { toleranceTiyin: 100_000 })
    expect(m).not.toBeNull()
    expect(m!.candidates[0]!.esfItem.id).toBe(cheap.id)
    // expensive не должен появиться даже в alternatives (swap не предлагает убыток).
    expect(m!.alternatives.some((a) => a.esfItem.id === expensive.id)).toBe(false)
  })

  it('единственный кандидат в радиусе — ниже floor → price-bucket возвращает null', () => {
    const expensive = mkItem({
      name: 'Дорогой',
      unitPriceTiyin: 1_000_000,
      availableMilli: 5000,
    })
    const pool = mkPool([mkPoolItem(expensive, 700_000)])
    const pos = mkPos({ totalTiyin: 700_000 })
    const m = tryPriceBucket(pos, pool, { toleranceTiyin: 100_000 })
    expect(m).toBeNull()
  })

  it('anti-mix: партия занята другим товаром чека → price-bucket её не предлагает', () => {
    const locked = mkItem({ name: 'Занятый', unitPriceTiyin: 400_000, availableMilli: 5000 })
    const pool = mkPool([mkPoolItem(locked, 700_000)])
    pool.chosenBatchByProduct!.set(normalizeForLink(locked.name), 99999) // залочено на ДРУГОЙ id
    const pos = mkPos({ totalTiyin: 700_000 })
    const m = tryPriceBucket(pos, pool, { toleranceTiyin: 100_000 })
    expect(m).toBeNull()
  })
})

// ── 5. Запрет смешивания партий — tryMultiItem ─────────────────────────────

describe('Запрет смешивания партий одного товара (multi-item knapsack)', () => {
  it('НИКОГДА не берёт 1 шт дорогой партии + 4 шт дешёвой партии ОДНОГО товара', () => {
    // Воспроизводит реальный баг (чек 413130402658): партия A (дорогая,
    // мало остатка) + партия B (дешёвая, того же товара) знаписьвались
    // ВМЕСТЕ в один чек через knapsack. Числа отмасштабированы для теста,
    // структура один-в-один: 1×дорогая + N×дешёвая = target ровно.
    const batchA = mkItem({
      name: 'Дрель ударная XYZ',
      unitPriceTiyin: 1_000_000, // floor 1_176_000, комфортно ниже sellingPrice ниже
      availableMilli: 1000, // всего 1 шт
      receivedAt: 1,
    })
    const batchB = mkItem({
      name: 'Дрель ударная XYZ', // ТОТ ЖЕ нормализованный товар
      unitPriceTiyin: 700_000,
      availableMilli: 10_000, // 10 шт
      receivedAt: 2,
    })
    const priceA = 1_910_000
    const priceB = 1_210_000
    const pool = mkPool([mkPoolItem(batchA, priceA), mkPoolItem(batchB, priceB)])

    // Target = 1×A + 4×B ровно — БЕЗ анти-микс защиты жадный алгоритм это
    // бы собрал (сортировка по убыванию цены: A первым влезает 1 шт по
    // остатку, потом B добирает остаток 4 шт).
    const target = priceA + 4 * priceB
    const pos = mkPos({ totalTiyin: target })

    const m = tryMultiItem(pos, pool, { toleranceTiyin: 0, maxMultiItem: 10 })
    // С анти-микс правилом: после выбора A партия B того же товара
    // недоступна → сумма не сходится (только 1×A влезает, остаток от
    // другого товара взять негде) → multi-item обязан провалиться, а НЕ
    // вернуть план с A+B.
    expect(m).toBeNull()
  })

  it('партия недостаточна по количеству → НЕ добирает из другой партии, matches null или другим товаром', () => {
    const batchA = mkItem({
      name: 'Перфоратор ABC',
      unitPriceTiyin: 1_000_000,
      availableMilli: 1000, // 1 шт
      receivedAt: 1,
    })
    const batchB = mkItem({
      name: 'Перфоратор ABC',
      unitPriceTiyin: 700_000,
      availableMilli: 10_000,
      receivedAt: 2,
    })
    const priceA = 1_910_000
    const priceB = 1_210_000
    const pool = mkPool([mkPoolItem(batchA, priceA), mkPoolItem(batchB, priceB)])

    // Target собирается ТОЛЬКО как 1×A + 4×B — если запрещено смешивать,
    // единственный легальный исход — null (ни одна из партий одна не
    // покрывает сумму с tolerance=0).
    const target = priceA + 4 * priceB
    const pos = mkPos({ totalTiyin: target })
    const m = tryMultiItem(pos, pool, { toleranceTiyin: 0 })
    expect(m).toBeNull()

    // Убедимся что если бы смешивание было разрешено — тест бы это поймал:
    // (документация инварианта, не реальная проверка кода) — 1000+10000=11000
    // remainingById суммарно хватило бы с запасом.
    expect(poolRemaining(pool, batchA.id) + poolRemaining(pool, batchB.id)).toBe(11_000)
  })

  it('добор допустим ДРУГИМ товаром (не батчем того же товара)', () => {
    const batchA = mkItem({
      name: 'Дрель ударная XYZ',
      unitPriceTiyin: 1_000_000,
      availableMilli: 1000,
      receivedAt: 1,
    })
    const batchB = mkItem({
      name: 'Дрель ударная XYZ', // тот же товар — должен быть проигнорирован
      unitPriceTiyin: 700_000,
      availableMilli: 10_000,
      receivedAt: 2,
    })
    const otherProduct = mkItem({
      name: 'Совсем другой товар',
      unitPriceTiyin: 700_000,
      availableMilli: 10_000,
      receivedAt: 3,
    })
    const priceA = 1_910_000
    const priceOther = 1_210_000
    const pool = mkPool([
      mkPoolItem(batchA, priceA),
      mkPoolItem(batchB, priceOther), // то же имя что и A, но другая цена (partии могут отличаться ценой)
      mkPoolItem(otherProduct, priceOther),
    ])

    const target = priceA + 4 * priceOther
    const pos = mkPos({ totalTiyin: target })
    const m = tryMultiItem(pos, pool, { toleranceTiyin: 0, maxMultiItem: 10 })
    expect(m).not.toBeNull()
    const usedIds = new Set(m!.candidates.map((c) => c.esfItem.id))
    expect(usedIds.has(batchA.id)).toBe(true)
    expect(usedIds.has(batchB.id)).toBe(false) // тот же товар — не подмешан
    expect(usedIds.has(otherProduct.id)).toBe(true) // другой товар — можно
  })

  it('anti-mix уважает глобальный лок (pool.chosenBatchByProduct) — не только within-call дедуп', () => {
    const batchA = mkItem({
      name: 'Товар Z',
      unitPriceTiyin: 1_000_000,
      availableMilli: 10_000,
      receivedAt: 1,
    })
    const pool = mkPool([mkPoolItem(batchA, 1_200_000)])
    // Товар уже залочен на ДРУГОЙ (несуществующий здесь) id другой позицией чека.
    pool.chosenBatchByProduct!.set(normalizeForLink(batchA.name), 999_999)

    const pos = mkPos({ totalTiyin: 1_200_000 })
    const m = tryMultiItem(pos, pool, { toleranceTiyin: 0 })
    expect(m).toBeNull() // единственный кандидат заблокирован анти-микс локом
  })

  it('регресс: обычный multi-item без пересечения товаров продолжает работать', () => {
    const itemA = mkItem({ name: 'A', unitPriceTiyin: 1_000_000, availableMilli: 10_000 })
    const itemB = mkItem({ name: 'B', unitPriceTiyin: 500_000, availableMilli: 10_000 })
    const pool = mkPool([mkPoolItem(itemA, 1_200_000), mkPoolItem(itemB, 600_000)])
    const target = 1_200_000 + 2 * 600_000
    const pos = mkPos({ totalTiyin: target })
    const m = tryMultiItem(pos, pool, { toleranceTiyin: 0, maxMultiItem: 10 })
    expect(m).not.toBeNull()
    expect(m!.candidates.reduce((s, c) => s + c.priceTiyin, 0)).toBe(target)
  })
})

// ── 6. Финальная страховка classic — enforceFloorOrUnmatch ─────────────────

describe('enforceFloorOrUnmatch — финальная страховка classic-режима', () => {
  function mkGoodMatch(): PositionMatch {
    const item = mkItem({ name: 'OK товар', unitPriceTiyin: 500_000, availableMilli: 5000 })
    const cand: MatchCandidate = {
      esfItem: item,
      quantity: 1000,
      priceTiyin: 700_000, // floor 588_000 → OK
      discountTiyin: 0,
      vatTiyin: 0,
    }
    return {
      source: mkPos({ totalTiyin: 700_000, quantity: 1000 }),
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

  function mkBadMatch(): PositionMatch {
    const item = mkItem({ name: 'Убыточный товар', unitPriceTiyin: 1_000_000, availableMilli: 5000 })
    const cand: MatchCandidate = {
      esfItem: item,
      quantity: 1000,
      priceTiyin: 800_000, // floor 1_176_000 → НИЖЕ floor
      discountTiyin: 0,
      vatTiyin: 0,
    }
    return {
      source: mkPos({ totalTiyin: 800_000, quantity: 1000 }),
      candidates: [cand],
      strategy: 'linked-ms',
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

  it('убыточная позиция → candidates обнуляются, strategy становится manual, warning возвращён', () => {
    const bad = mkBadMatch()
    const matches = [bad]
    const warnings = enforceFloorOrUnmatch(matches)
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Убыточный товар')
    expect(matches[0]!.candidates).toHaveLength(0)
    expect(matches[0]!.strategy).toBe('manual')
    // source (исходная МС-позиция) не теряется — кассиру всё ещё видно что подбирать.
    expect(matches[0]!.source).toBe(bad.source)
  })

  it('прибыльная позиция не трогается', () => {
    const good = mkGoodMatch()
    const matches = [good]
    const warnings = enforceFloorOrUnmatch(matches)
    expect(warnings).toHaveLength(0)
    expect(matches[0]!.candidates).toHaveLength(1)
    expect(matches[0]!.strategy).toBe('passthrough')
  })

  it('смешанный набор — обнуляется только убыточная, хорошая остаётся', () => {
    const good = mkGoodMatch()
    const bad = mkBadMatch()
    const matches = [good, bad]
    const warnings = enforceFloorOrUnmatch(matches)
    expect(warnings).toHaveLength(1)
    expect(matches[0]!.candidates).toHaveLength(1) // good нетронут
    expect(matches[1]!.candidates).toHaveLength(0) // bad обнулён
  })

  it('уже-неподобранная позиция (candidates=[]) пропускается без warning', () => {
    const already: PositionMatch = {
      ...mkGoodMatch(),
      candidates: [],
      strategy: 'manual',
    }
    const warnings = enforceFloorOrUnmatch([already])
    expect(warnings).toHaveLength(0)
  })

  it('цена РОВНО floor — граница допустима, не отклоняется', () => {
    const item = mkItem({ name: 'На грани', unitPriceTiyin: 500_000, availableMilli: 5000 })
    const floor = priceFloorTiyin(500_000, 12, 1000)
    const cand: MatchCandidate = {
      esfItem: item,
      quantity: 1000,
      priceTiyin: floor,
      discountTiyin: 0,
      vatTiyin: 0,
    }
    const match: PositionMatch = {
      source: mkPos({ totalTiyin: floor }),
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
    const warnings = enforceFloorOrUnmatch([match])
    expect(warnings).toHaveLength(0)
    expect(match.candidates).toHaveLength(1)
  })
})

// ── 7. Holistic — анти-микс (коллапс до одной партии) + per-line floor ─────

describe('planHolistic — анти-микс партий', () => {
  it('никогда не комбинирует 2 батча одного товара — коллапсирует до батча с максимальным sellingPrice×available', () => {
    // Тот же сценарий что и в tryMultiItem, но через holistic. Если бы
    // алгоритм не коллапсировал батчи, DP/greedy собрали бы 1×A(дорогая) +
    // 4×B(дешёвая) точно на target — воспроизводя реальный баг.
    //
    // Здесь batchB СТАРЕЕ (receivedAt=1) И имеет БОЛЬШИЙ потенциал
    // (priceB×available=1_210_000×10=12_100_000 против priceA×available=
    // 1_910_000×1=1_910_000) — коллапс выбирает batchB что по старому
    // критерию (FIFO), что по новому (max value), это подтверждается
    // отдельным тестом ниже с разведёнными критериями.
    const batchA = mkItem({
      name: 'Дрель ударная XYZ',
      unitPriceTiyin: 1_000_000,
      availableMilli: 1000,
      receivedAt: 5,
    })
    const batchB = mkItem({
      name: 'Дрель ударная XYZ',
      unitPriceTiyin: 700_000,
      availableMilli: 10_000,
      receivedAt: 1,
    })
    const priceA = 1_910_000
    const priceB = 1_210_000
    // Добавим дешёвый филлер другого товара чтобы дать holistic шанс собрать
    // сумму БЕЗ смешивания батчей одного товара (через другой продукт).
    const filler = mkItem({
      name: 'Филлер другой товар',
      unitPriceTiyin: 200_000,
      availableMilli: 50_000,
      receivedAt: 10,
    })
    const priceFiller = 300_000

    const pool = mkPool([
      mkPoolItem(batchA, priceA),
      mkPoolItem(batchB, priceB),
      mkPoolItem(filler, priceFiller),
    ])

    // target который БЕЗ анти-микса собрался бы как 1×A + 4×B (реальный баг).
    const target = priceA + 4 * priceB
    const r = planHolistic(target, pool, {})

    // Детерминированный исход для ЭТИХ конкретных чисел (проверено прогоном):
    // фаза 1 не берёт ни A, ни B крупным SKU (обе ≤ дефолтный fillerThreshold
    // 2_000_000), фаза 2 closest-below набирает 5×B + 2×filler, фаза 3 bump
    // закрывает остаток — план сходится БЕЗ участия batchA вообще.
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable — r.ok проверен выше')
    // План использует только ОДИН батч «Дрель ударная XYZ» (никогда оба сразу).
    const drillLines = r.plan.lines.filter(
      (l) => normalizeForLink(l.esfItem.name) === normalizeForLink('Дрель ударная XYZ'),
    )
    const distinctIds = new Set(drillLines.map((l) => l.esfItem.id))
    expect(distinctIds.size).toBeLessThanOrEqual(1)
    expect(distinctIds.has(batchB.id)).toBe(true)
    expect(distinctIds.has(batchA.id)).toBe(false)
  })

  it('FIFO — тай-брейк при РАВНОМ потенциале (sellingPrice×available одинаковы у обоих батчей)', () => {
    const older = mkItem({
      name: 'Товар FIFO-тест',
      unitPriceTiyin: 500_000,
      availableMilli: 10_000,
      receivedAt: 1,
    })
    const newer = mkItem({
      name: 'Товар FIFO-тест',
      unitPriceTiyin: 500_000,
      availableMilli: 10_000,
      receivedAt: 2,
    })
    // Одинаковый sellingPrice И одинаковый available → value(older)===value(newer)
    // → коллапс должен упасть на тай-брейк (FIFO-самый-старый).
    const pool = mkPool([mkPoolItem(older, 700_000), mkPoolItem(newer, 700_000)])
    const target = 700_000 * 3
    const r = planHolistic(target, pool, {})
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable — r.ok проверен выше')
    expect(r.plan.lines).toHaveLength(1)
    expect(r.plan.lines[0]!.esfItem.id).toBe(older.id)
  })

  it('НЕ-тай-брейк: батч с БОЛЬШИМ потенциалом (sellingPrice×available) побеждает более старый батч с маленьким остатком', () => {
    // Регрессия на сам фикс п.4: раньше коллапс был ЧИСТО FIFO — брал
    // самый старый батч независимо от остатка. Если у самого старого батча
    // остаток был мизерный (например 1 шт, почти распродан), holistic
    // мог провалиться в NO_FIT/INSUFFICIENT_POOL там, где «богатый» новый
    // батч того же товара легко закрыл бы сумму. Теперь коллапс выбирает
    // батч который МАКСИМИЗИРУЕТ sellingPrice×available.
    const old = mkItem({
      name: 'Товар с почти пустым старым приходом',
      unitPriceTiyin: 500_000,
      availableMilli: 1_000, // всего 1 шт — почти распродан
      receivedAt: 1, // СТАРЕЕ
    })
    const rich = mkItem({
      name: 'Товар с почти пустым старым приходом', // тот же нормализованный товар
      unitPriceTiyin: 500_000,
      availableMilli: 50_000, // 50 шт — свежий большой приход
      receivedAt: 5, // НОВЕЕ
    })
    const sellPrice = 700_000
    // value(old) = 700_000×1 = 700_000. value(rich) = 700_000×50 = 35_000_000.
    const pool = mkPool([mkPoolItem(old, sellPrice), mkPoolItem(rich, sellPrice)])

    // target требует 10 шт — старый батч (1 шт) физически не может его
    // покрыть в одиночку, только «богатый» новый батч способен.
    const target = sellPrice * 10
    const r = planHolistic(target, pool, {})

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable — r.ok проверен выше')
    expect(r.plan.lines).toHaveLength(1)
    // Коллапс выбрал `rich` (больший потенциал), НЕ `old` (несмотря на то
    // что `old` старее по FIFO) — старый чисто-FIFO алгоритм здесь дал бы
    // NO_FIT/INSUFFICIENT_POOL (working содержал бы только `old` с 1 шт).
    expect(r.plan.lines[0]!.esfItem.id).toBe(rich.id)
    expect(r.plan.totalTiyin).toBe(target)
  })
})

describe('findBelowFloorLine — построчная проверка (используется как финальная страховка holistic)', () => {
  function mkLine(opts: { unitPriceTiyin: number; priceTiyin: number; discountTiyin?: number; name?: string }): HolisticLine {
    const item = mkItem({
      name: opts.name ?? 'Строка',
      unitPriceTiyin: opts.unitPriceTiyin,
      availableMilli: 5000,
    })
    return {
      esfItem: item,
      quantity: 1000,
      priceTiyin: opts.priceTiyin,
      discountTiyin: opts.discountTiyin ?? 0,
      vatTiyin: 0,
    }
  }

  it('пустой список → null', () => {
    expect(findBelowFloorLine([])).toBeNull()
  })

  it('все строки выше floor → null', () => {
    const lines = [
      mkLine({ unitPriceTiyin: 500_000, priceTiyin: 700_000 }), // floor 588_000, OK
      mkLine({ unitPriceTiyin: 300_000, priceTiyin: 450_000 }), // floor ~352_800, OK
    ]
    expect(findBelowFloorLine(lines)).toBeNull()
  })

  it('одна строка ниже floor, ДАЖЕ если сумма всех строк с запасом прибыльна — находит нарушителя', () => {
    // Строка 1 — огромный запас прибыли (компенсировал бы агрегатную проверку).
    const profitable = mkLine({ unitPriceTiyin: 100_000, priceTiyin: 5_000_000 })
    // Строка 2 — сама по себе ниже floor.
    const violating = mkLine({
      unitPriceTiyin: 1_000_000, // floor 1_176_000
      priceTiyin: 800_000,
      name: 'Нарушитель',
    })
    const violation = findBelowFloorLine([profitable, violating])
    expect(violation).not.toBeNull()
    expect(violation!.line.esfItem.name).toBe('Нарушитель')
    expect(violation!.effective).toBe(800_000)
    expect(violation!.floor).toBe(1_176_000)
  })

  it('discount учитывается: priceTiyin - discountTiyin < floor → нарушение', () => {
    const line = mkLine({
      unitPriceTiyin: 500_000, // floor 588_000
      priceTiyin: 700_000,
      discountTiyin: 200_000, // effective 500_000 < 588_000
    })
    const violation = findBelowFloorLine([line])
    expect(violation).not.toBeNull()
    expect(violation!.effective).toBe(500_000)
  })

  it('цена РОВНО floor — граница допустима (не нарушение)', () => {
    const floor = priceFloorTiyin(500_000, 12, 1000)
    const line = mkLine({ unitPriceTiyin: 500_000, priceTiyin: floor })
    expect(findBelowFloorLine([line])).toBeNull()
  })
})

describe('planHolistic — per-line floor reject интегрирован в основной flow', () => {
  it('филлер ниже floor не выбирается фазой 2 даже если он единственный способ добить сумму', () => {
    // Крупный товар покрывает бОльшую часть, остаток ТОЧНО равен цене
    // единственного доступного филлера, но этот филлер продавался бы ниже
    // floor. Ожидание: filler floor-фильтр (фаза 2) не даёт его выбрать →
    // DP/closest-below не находят точной суммы → phase 3 либо докрывает
    // bump'ом (если задействует другую строку), либо весь план отклоняется.
    // Здесь резерва под филлер нет и другого филлера тоже нет → NO_FIT/BELOW_COST.
    const big = mkItem({ name: 'Крупный', unitPriceTiyin: 4_000_000, availableMilli: 5000 })
    const badFiller = mkItem({
      name: 'Плохой филлер',
      unitPriceTiyin: 1_000_000, // floor 1_176_000
      availableMilli: 50_000,
    })
    const priceBig = 5_000_000
    const priceBadFiller = 1_000_000 // ниже floor (1_176_000) — специально
    const pool = mkPool([mkPoolItem(big, priceBig), mkPoolItem(badFiller, priceBadFiller)])

    const target = priceBig + priceBadFiller
    const r = planHolistic(target, pool, { holisticFillerReserveTiyin: 0 })
    // Детерминированный исход (проверено прогоном): фаза 1 берёт 1×big
    // (unitFloor 4_704_000 ≤ 5_000_000 → ОК), фаза 2 полностью исключает
    // badFiller (его unitFloor 1_176_000 > его sellingPrice 1_000_000 —
    // filler floor-фильтр не даёт даже ПОПРОБОВАТЬ его в DP/closest-below),
    // фаза 3 закрывает остаток 1_000_000 бампом строки `big` (в пределах
    // cap 1_000_000 и относительного cap 50%). План сходится БЕЗ badFiller
    // вообще — не «план нашёлся, но без нарушителя», а «нарушитель никогда
    // не рассматривался».
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error('unreachable — r.ok проверен выше')
    expect(r.plan.lines).toHaveLength(1)
    expect(r.plan.lines[0]!.esfItem.id).toBe(big.id)
    expect(r.plan.totalTiyin).toBe(target)
    const violation = findBelowFloorLine(r.plan.lines)
    expect(violation).toBeNull()
  })
})
