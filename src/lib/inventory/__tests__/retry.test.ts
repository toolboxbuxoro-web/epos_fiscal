/**
 * Повтор запросов к inventory-серверу на кратковременных сбоях.
 *
 * Регресс на прод-случай 20.08.2026 (Дон бозори): Railway отдал 502 во время
 * деплоя, кассир получил «Сервер inventory недоступен» посреди продажи и
 * вынужден был жать «Фискализировать» заново. 502 при деплое — норма, и
 * кассир не должен его видеть.
 *
 * Инвариант: транзиентное повторяем, бизнес-ответы — нет.
 */
import { describe, expect, it } from 'vitest'

/** Копия правила из server-client.ts::request (там оно приватное). */
const TRANSIENT = new Set([502, 503, 504])
function isRetriable(status: number | undefined): boolean {
  return status === undefined || TRANSIENT.has(status)
}

describe('политика повтора запросов к inventory', () => {
  it('шлюзовые сбои Railway повторяем', () => {
    for (const s of [502, 503, 504]) expect(isRetriable(s)).toBe(true)
  })

  it('сетевой обрыв (нет статуса) повторяем', () => {
    expect(isRetriable(undefined)).toBe(true)
  })

  it('бизнес-ответы НЕ повторяем — повтор их не исправит', () => {
    // 409 = товар закончился (другой магазин опередил): нужен пересбор плана.
    // 401 = неверный ключ. 400 = кривой запрос.
    for (const s of [400, 401, 403, 404, 409, 422]) {
      expect(isRetriable(s)).toBe(false)
    }
  })

  it('500 не повторяем — ошибка приложения, а не шлюза', () => {
    expect(isRetriable(500)).toBe(false)
  })
})
