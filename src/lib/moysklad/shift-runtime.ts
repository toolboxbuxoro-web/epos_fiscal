/**
 * Singleton runtime для отслеживания **активной розничной смены** магазина.
 *
 * Раз в 30 секунд опрашивает МС endpoint `/entity/retailshift?closeDate=null`
 * и обновляет cached state. Если смены нет — в UI показываем «Смена закрыта»,
 * чеки в очереди фильтруются по последнему сохранённому shiftId (или ничего
 * не показывается до открытия новой смены).
 *
 *   const shift = useShiftStatus()  // подписка с авто-обновлением
 *   shift.shiftId        // 'uuid' | null
 *   shift.openedAt       // Date | null
 *   shift.lastCheckedAt  // Date
 *
 * НЕ запускается автоматически — Dashboard вызывает ensureShiftRuntime()
 * при mount. После Logout — stopShiftRuntime() в AppGate сбросит таймер.
 */

import { useEffect, useState } from 'react'
import { getSetting, SettingKey } from '@/lib/db'
import {
  makeBasicCredentials,
  MoyskladClient,
  type MsRetailShift,
} from '@/lib/moysklad'
import { log } from '@/lib/log'

export interface ShiftStatus {
  /** UUID активной смены, null если ни одной нет открытой. */
  shiftId: string | null
  /** Когда смена была открыта (если есть). */
  openedAt: Date | null
  /** Когда последний раз ходили на сервер. */
  lastCheckedAt: Date | null
  /** Ошибка последнего запроса (null если ОК). */
  lastError: string | null
  /** Есть ли вообще доступ к МС (creds + retailStoreId). */
  ready: boolean
}

const POLL_INTERVAL_MS = 30_000
const FAST_POLL_AFTER_LOGIN_MS = 2_000

let started = false
let timer: ReturnType<typeof setInterval> | null = null
let firstFastTimer: ReturnType<typeof setTimeout> | null = null
let current: ShiftStatus = {
  shiftId: null,
  openedAt: null,
  lastCheckedAt: null,
  lastError: null,
  ready: false,
}
const listeners = new Set<(s: ShiftStatus) => void>()

function emit() {
  for (const l of listeners) l(current)
}

async function tick() {
  const [credsB64, retailStoreId] = await Promise.all([
    getSetting(SettingKey.MoyskladCredentials),
    getSetting(SettingKey.MoyskladRetailStoreId),
  ])

  if (!credsB64 || !retailStoreId) {
    current = {
      ...current,
      ready: false,
      lastError: 'Нет МС-creds или точки продаж',
      lastCheckedAt: new Date(),
    }
    emit()
    return
  }

  current = { ...current, ready: true }
  try {
    const client = new MoyskladClient({ basic: credsB64 })
    const shift: MsRetailShift | null = await client.getActiveShift(retailStoreId)
    current = {
      shiftId: shift?.id ?? null,
      openedAt: shift ? new Date(shift.created) : null,
      lastCheckedAt: new Date(),
      lastError: null,
      ready: true,
    }
    emit()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    current = {
      ...current,
      lastError: msg,
      lastCheckedAt: new Date(),
    }
    emit()
    await log.warn('moysklad', `getActiveShift failed: ${msg}`)
  }
}

/** Запустить опрос. Идемпотентен — повторные вызовы no-op. */
export function ensureShiftRuntime(): void {
  if (started) return
  started = true
  // Первый запрос быстро — чтобы UI не висел на «загрузка…» 30 сек
  firstFastTimer = setTimeout(() => {
    void tick()
  }, FAST_POLL_AFTER_LOGIN_MS)
  // Регулярный поллинг
  timer = setInterval(() => {
    void tick()
  }, POLL_INTERVAL_MS)
}

export function stopShiftRuntime(): void {
  if (!started) return
  started = false
  if (timer) clearInterval(timer)
  if (firstFastTimer) clearTimeout(firstFastTimer)
  timer = null
  firstFastTimer = null
  current = {
    shiftId: null,
    openedAt: null,
    lastCheckedAt: null,
    lastError: null,
    ready: false,
  }
  emit()
}

/** Принудительный refresh — например после явного «обновить» в UI. */
export async function refreshShift(): Promise<void> {
  await tick()
}

export function getShiftStatus(): ShiftStatus {
  return current
}

/**
 * React-хук с авто-обновлением. Подписывается на listeners,
 * возвращает свежий ShiftStatus и автоматически вызывает ensureShiftRuntime.
 */
export function useShiftStatus(): ShiftStatus {
  const [s, setS] = useState<ShiftStatus>(current)
  useEffect(() => {
    ensureShiftRuntime()
    listeners.add(setS)
    setS(current)
    return () => {
      listeners.delete(setS)
    }
  }, [])
  return s
}

// Утилита для совместимости — реэкспорт чтобы не импортить из двух мест.
export { makeBasicCredentials }
