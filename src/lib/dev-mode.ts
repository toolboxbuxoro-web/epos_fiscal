/**
 * Dev-режим — комбинированный флаг.
 *
 *   isDevMode() = `import.meta.env.DEV` (build-time, Vite dev) ИЛИ
 *                 sessionStorage[DEV_FLAG] (runtime разблокировка через PIN)
 *
 * Используется в:
 *   - <DevMarker> — жёлтая плашка в углу
 *   - Login.tsx — footer «🔧 Сервер» + поле для смены URL
 *   - (потенциально) другие диагностические фичи
 *
 * Подписка через `useDevMode()` хук — рендерит реактивно. Любое
 * `unlockDevMode()` / `lockDevMode()` диспатчит событие, все хуки обновляются.
 *
 * sessionStorage (а не localStorage) — флаг сбрасывается при закрытии
 * программы. Логика «один сеанс — одна разблокировка», без долгоживущего
 * состояния на машине магазина.
 */

import { useEffect, useState } from 'react'

const DEV_FLAG_KEY = 'epos.dev-mode-unlocked'
const EVT = 'epos:dev-mode-changed'

/** Проверить runtime-разблокировку (без учёта build-time). */
export function isRuntimeDevUnlocked(): boolean {
  try {
    return sessionStorage.getItem(DEV_FLAG_KEY) === 'true'
  } catch {
    return false
  }
}

/** Главный API: dev-режим включён? */
export function isDevMode(): boolean {
  return import.meta.env.DEV || isRuntimeDevUnlocked()
}

/** Разблокировать dev-режим в текущем сеансе. Сбросится при закрытии. */
export function unlockDevMode(): void {
  try {
    sessionStorage.setItem(DEV_FLAG_KEY, 'true')
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    // sessionStorage может быть недоступен в каком-то edge case — silent
  }
}

/** Заблокировать обратно. Build-time DEV это не выключит. */
export function lockDevMode(): void {
  try {
    sessionStorage.removeItem(DEV_FLAG_KEY)
    window.dispatchEvent(new CustomEvent(EVT))
  } catch {
    // ignore
  }
}

/**
 * React-хук для реактивного отслеживания. После `unlockDevMode()` все
 * компоненты подписанные на хук обновляются благодаря CustomEvent.
 */
export function useDevMode(): boolean {
  const [enabled, setEnabled] = useState(isDevMode())
  useEffect(() => {
    const h = () => setEnabled(isDevMode())
    window.addEventListener(EVT, h)
    return () => window.removeEventListener(EVT, h)
  }, [])
  return enabled
}

/**
 * Хук специально для runtime-флага (без учёта build-time DEV).
 * Используется в Settings чтобы показать «Заблокировать» только когда
 * именно RUNTIME разблокировка была — иначе кнопка бесполезна в `vite dev`.
 */
export function useRuntimeDevUnlocked(): boolean {
  const [v, setV] = useState(isRuntimeDevUnlocked())
  useEffect(() => {
    const h = () => setV(isRuntimeDevUnlocked())
    window.addEventListener(EVT, h)
    return () => window.removeEventListener(EVT, h)
  }, [])
  return v
}
