/**
 * Тесты округления цен на РЕАЛЬНЫХ данных из БД (Toolbox Xonabod).
 *
 * Бизнес-правило: цена товара на фискальной ленте НИКОГДА не должна иметь
 * тийинов (дробных сум). Всё кратно 1 суму (100 тийинов).
 *
 * Источник фикстур: snapshot inv_items из production Postgres (read-only,
 * данные НЕ изменялись). unit_price_tiyin + vat_percent — реальные.
 *
 * Снято запросом:
 *   SELECT unit_price_tiyin, vat_percent, name FROM inv_items
 *   JOIN inv_shops ON ... WHERE slug='Toolbox Xonabod' AND unit_price_tiyin>0
 *
 * Проверяем:
 *   - calculateSellingPrice — всегда кратна шагу (1000 сум), без тийинов
 *   - priceFloorTiyin — всегда кратна 1 суму (ceilToSum)
 *   - ceilToSum / floorToSum — корректность
 */

import { describe, it, expect } from 'vitest'
import {
  calculateSellingPrice,
  priceFloorTiyin,
  costWithVat,
  ceilToSum,
  floorToSum,
  TIYIN_PER_SUM,
} from '@/lib/matcher/strategies'

/**
 * Реальные приходы Toolbox Xonabod (production snapshot, не изменялись).
 * [unit_price_tiyin, vat_percent, name]
 */
const REAL_XONABOD_ITEMS: Array<[number, number, string]> = [
  [60_000, 12, 'Зажим для троса'],
  [106_200, 12, 'Коуш для троса'],
  [120_000, 12, 'Грузики балансировочные'],
  [200_000, 12, 'Головка для гаечных ключей'],
  [300_000, 12, 'Хомут металлический'],
  [500_000, 12, 'КЛЮЧИ ГАЕЧНЫЕ НЕРАЗВОДНЫЕ'],
  [1_600_000, 12, 'Колесо для тележки'],
  [2_000_000, 12, 'Ключ неразводной'],
  [13_000_100, 12, 'Газонокосилка (триммер) с бензиновым мотором'],
  [15_500_000, 12, 'Ручная цепная бензопила'],
  [15_564_000, 12, 'Ручная циркулярная электрическая дисковая пила'],
  [22_500_000, 12, 'Мини набор Пила цепная + Секатор'],
  [31_500_000, 12, 'Насос водяной электрический центробежный'],
  [116_500_000, 12, 'Компрессоры объёмные возвратно-поступательные'],
]

// ── ceilToSum / floorToSum ──────────────────────────────────────────

describe('ceilToSum / floorToSum (округление до целого сума)', () => {
  it('TIYIN_PER_SUM = 100', () => {
    expect(TIYIN_PER_SUM).toBe(100)
  })

  it('ceilToSum округляет вверх до 100', () => {
    expect(ceilToSum(117_601)).toBe(117_700)
    expect(ceilToSum(117_600)).toBe(117_600) // уже целый
    expect(ceilToSum(1)).toBe(100)
    expect(ceilToSum(0)).toBe(0)
  })

  it('floorToSum округляет вниз до 100', () => {
    expect(floorToSum(117_699)).toBe(117_600)
    expect(floorToSum(117_600)).toBe(117_600)
    expect(floorToSum(99)).toBe(0)
    expect(floorToSum(0)).toBe(0)
  })

  it('floorToSum + ceilToSum на дробных тийинах (имитация cost×1.05)', () => {
    // 887985 тийинов = 8879.85 сум → ceilToSum = 8880 сум = 888000 тийинов
    expect(ceilToSum(887_985)).toBe(888_000)
    expect(floorToSum(887_985)).toBe(887_900)
    // разница ceil - floor = ровно 1 сум для дробного значения
    expect(ceilToSum(887_985) - floorToSum(887_985)).toBe(TIYIN_PER_SUM)
  })
})

// ── calculateSellingPrice — без тийинов ─────────────────────────────

describe('calculateSellingPrice на реальных приходах — кратна 1000 сум', () => {
  for (const [unit, vat, name] of REAL_XONABOD_ITEMS) {
    it(`«${name}» (приход ${unit / 100} сум) → продажная без тийинов`, () => {
      const selling = calculateSellingPrice(unit, vat, 10, 1000)
      // Кратна шагу 1000 сум = 100000 тийинов
      expect(selling % 100_000).toBe(0)
      // Значит точно без тийинов
      expect(selling % TIYIN_PER_SUM).toBe(0)
      // И выше себестоимости
      expect(selling).toBeGreaterThan(costWithVat(unit, vat, 1000))
    })
  }

  it('markup 0% (упрощёнка) — тоже кратна шагу', () => {
    for (const [unit, vat] of REAL_XONABOD_ITEMS) {
      const selling = calculateSellingPrice(unit, vat, 0, 1000)
      expect(selling % 100_000).toBe(0)
    }
  })

  it('шаг 100 сум — кратна 100 сум, без тийинов', () => {
    for (const [unit, vat] of REAL_XONABOD_ITEMS) {
      const selling = calculateSellingPrice(unit, vat, 10, 100)
      expect(selling % 10_000).toBe(0) // 100 сум = 10000 тийинов
      expect(selling % TIYIN_PER_SUM).toBe(0)
    }
  })
})

// ── priceFloorTiyin — без тийинов ───────────────────────────────────

describe('priceFloorTiyin на реальных приходах — без тийинов', () => {
  for (const [unit, vat, name] of REAL_XONABOD_ITEMS) {
    it(`«${name}» floor кратен 1 суму`, () => {
      const floor = priceFloorTiyin(unit, vat, 1000)
      // КЛЮЧЕВОЕ: никаких тийинов
      expect(floor % TIYIN_PER_SUM).toBe(0)
      // floor ≥ себестоимость × 1.05 (округление вверх)
      const cost = costWithVat(unit, vat, 1000)
      expect(floor).toBeGreaterThanOrEqual(Math.floor((cost * 105) / 100))
    })
  }

  it('конкретные значения floor для проблемных приходов с тийинами', () => {
    // Коуш 106200: cost = round(106200×1.12) = 118944. ×1.05 = 124891.2
    // → ceilToSum = 124900 (было бы 124891 с round — тийины!)
    const floor = priceFloorTiyin(106_200, 12, 1000)
    expect(floor).toBe(124_900)
    expect(floor % TIYIN_PER_SUM).toBe(0)

    // Газонокосилка 13000100: cost = round(13000100×1.12) = 14560112.
    // ×1.05 = 15288117.6 → ceilToSum = 15288200
    const floor2 = priceFloorTiyin(13_000_100, 12, 1000)
    expect(floor2 % TIYIN_PER_SUM).toBe(0)
    expect(floor2).toBeGreaterThan(costWithVat(13_000_100, 12, 1000))
  })
})

// ── Инвариант: для ВСЕХ приходов нет тийинов ────────────────────────

describe('Глобальный инвариант: ни selling ни floor не имеют тийинов', () => {
  it('весь пул Xonabod при разных markup/step', () => {
    const markups = [0, 5, 10, 15, 20]
    const steps = [100, 500, 1000]
    let checked = 0
    for (const [unit, vat] of REAL_XONABOD_ITEMS) {
      const floor = priceFloorTiyin(unit, vat, 1000)
      expect(floor % TIYIN_PER_SUM).toBe(0)
      for (const markup of markups) {
        for (const step of steps) {
          const selling = calculateSellingPrice(unit, vat, markup, step)
          expect(selling % TIYIN_PER_SUM).toBe(0)
          checked++
        }
      }
    }
    // 14 items × 5 markups × 3 steps = 210 selling-цен проверено
    expect(checked).toBe(REAL_XONABOD_ITEMS.length * markups.length * steps.length)
  })
})
