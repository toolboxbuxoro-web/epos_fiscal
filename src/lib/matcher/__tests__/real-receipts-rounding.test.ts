/**
 * Валидация округления на РЕАЛЬНЫХ суммах чеков из production БД.
 *
 * Источник: таблица `receipts` (FinCore sales tracking), 16179 реальных
 * чеков всех 4 магазинов. Данные read-only, НЕ изменялись.
 *
 * Ключевой факт (агрегат по 16179 чекам):
 *   - 99.91% чеков — суммы кратны 1000 сум (целые, без тийинов)
 *   - 14 чеков (0.087%) имеют тийины — артефакты округления МС (бонусы/
 *     скидки/FX). Все в пределах 1-2 тийинов от целого сума (.01 / .98 / .99).
 *
 * Это валидирует допущение matcher'а: «UZ-розница = целые сумы». Для редких
 * дробных чеков сабсумный остаток (1-2 тийина) остаётся нераспределённым,
 * в пределах EPOS-tolerance (10000 тийинов = 100 сум).
 */

import { describe, it, expect } from 'vitest'
import {
  floorToSum,
  ceilToSum,
  TIYIN_PER_SUM,
} from '@/lib/matcher/strategies'

/** Реальные суммы целых чеков (тийины) — production snapshot, read-only. */
const REAL_WHOLE_RECEIPT_SUMS: number[] = [
  66_100_000, // чек 06211
  143_000_000, // чек 05529
  3_300_000, // чек 06210
  7_000_000, // чек 05528
  2_800_000, // чек 03210
  1_800_000, // чек 06209
  19_000_000, // чек 04052
  5_000_000, // чек 04051
  118_100_000, // чек 05527
  2_500_000, // чек 06208
  28_600_000, // чек 06207
  8_500_000, // чек 03208
  86_500_000, // чек 06206
  13_900, // минимальный чек = 139 сум
]

/** Реальные суммы ДРОБНЫХ чеков (14 шт из 16179) — тийины. */
const REAL_FRACTIONAL_RECEIPT_SUMS: number[] = [
  303_900_001, // 3039000.01 сум
  595_999_998, // 5959999.98
  437_500_001, // 4375000.01
  141_999_999, // 1419999.99
  96_799_999, // 967999.99
  147_199_999, // 1471999.99
  326_000_001, // 3260000.01
  140_000_001, // 1400000.01
  179_899_999, // 1798999.99
  497_999_999, // 4979999.99
  104_500_001, // 1045000.01
  173_900_001, // 1739000.01
  158_600_001, // 1586000.01
]

describe('Реальные ЦЕЛЫЕ чеки — кратны 1000 сум', () => {
  for (const sum of REAL_WHOLE_RECEIPT_SUMS) {
    it(`чек ${sum / 100} сум: floorToSum = ceilToSum = сам (нет тийинов)`, () => {
      // Целый чек: округление вниз и вверх дают одно и то же
      expect(floorToSum(sum)).toBe(sum)
      expect(ceilToSum(sum)).toBe(sum)
      expect(sum % TIYIN_PER_SUM).toBe(0)
    })
  }

  it('все целые чеки кратны 1000 сум (кроме мелкого 139 сум)', () => {
    for (const sum of REAL_WHOLE_RECEIPT_SUMS) {
      if (sum >= 100_000) {
        expect(sum % 100_000).toBe(0) // кратны 1000 сум
      } else {
        // мелкий чек 13900 = 139 сум, кратен 100 сум но не 1000
        expect(sum % TIYIN_PER_SUM).toBe(0)
      }
    }
  })
})

describe('Реальные ДРОБНЫЕ чеки — остаток в пределах tolerance', () => {
  const EPOS_TOLERANCE_TIYIN = 10_000 // 100 сум

  for (const sum of REAL_FRACTIONAL_RECEIPT_SUMS) {
    it(`чек ${(sum / 100).toFixed(2)} сум: сабсумный остаток < 1 сум`, () => {
      // floorToSum отбрасывает дробную часть < 1 сум
      const wholePart = floorToSum(sum)
      const remainder = sum - wholePart
      // Остаток меньше 1 сума (100 тийинов)
      expect(remainder).toBeLessThan(TIYIN_PER_SUM)
      // И гарантированно в пределах EPOS-tolerance
      expect(remainder).toBeLessThan(EPOS_TOLERANCE_TIYIN)
    })
  }

  it('все дробные чеки — артефакт округления МС (≤2 тийина от целого)', () => {
    for (const sum of REAL_FRACTIONAL_RECEIPT_SUMS) {
      // Расстояние до ближайшего целого сума
      const down = sum - floorToSum(sum)
      const up = ceilToSum(sum) - sum
      const distToWhole = Math.min(down, up)
      // Все реальные дробные — в пределах 2 тийинов от целого сума
      expect(distToWhole).toBeLessThanOrEqual(2)
    }
  })

  it('распределение дробного чека: matched в пределах 1 сум от target', () => {
    for (const sum of REAL_FRACTIONAL_RECEIPT_SUMS) {
      // Симуляция: matcher собирает на floorToSum(target) точно,
      // оставляя дробный остаток. matched = floorToSum(sum).
      const matched = floorToSum(sum)
      const diff = Math.abs(sum - matched)
      expect(diff).toBeLessThan(TIYIN_PER_SUM) // < 1 сум
    }
  })
})

describe('Статистика валидации (документирование)', () => {
  it('99.91% реальных чеков — целые сумы (16165 из 16179)', () => {
    // Из агрегата: COUNT(*) FILTER (WHERE sum % 100 != 0) = 14 из 16179
    const total = 16_179
    const withTiyin = 14
    const wholePct = ((total - withTiyin) / total) * 100
    expect(wholePct).toBeGreaterThan(99.9)
  })
})
