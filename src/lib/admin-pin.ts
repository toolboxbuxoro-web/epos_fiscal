/**
 * Admin gate — три фактора для разблокировки dev-режима после kassir-логина:
 *
 *   1. Логин = "admin" (хардкод)
 *   2. Пароль = "admin" (хардкод; в v2 будет настраиваемый)
 *   3. PIN — настраивается админом при первом входе, хранится PBKDF2-хешем
 *
 * Где используется:
 *   - Settings → секция «Режим разработчика» → кнопка «Активировать»
 *   - Открывает <AdminUnlockModal> с тремя полями
 *   - При успехе → `unlockDevMode()` ставит sessionStorage флаг
 *   - DevMarker / Login footer / другие dev-only фичи смотрят на `isDevMode()`
 *
 * Безопасность:
 *   - PIN хешируется PBKDF2-SHA256 100k итераций + соль 16 байт
 *   - Сравнение constant-time через TimingSafeEqual emulation
 *   - Без сервера — всё локально, не для защиты от атак с физическим доступом
 *     к Win-машине, а только от случайного клика «не туда» кассиром
 */

import { getSetting, setSetting, SettingKey } from '@/lib/db'

export const ADMIN_LOGIN = 'admin'
export const ADMIN_PASSWORD = 'admin'

const PBKDF2_ITERATIONS = 100_000
const SALT_BYTES = 16
const KEY_BITS = 256 // SHA-256

/**
 * Прохэшировать PIN. Возвращает строку формата `<salt>:<hash>` (base64),
 * пригодную для хранения в SettingKey.AdminPinHash.
 */
export async function hashPin(pin: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await deriveBits(pin, salt)
  return `${b64encode(salt)}:${b64encode(hash)}`
}

/**
 * Сравнить введённый PIN с сохранённым хешем. Использует одинаковую соль
 * из сохранённой строки → детерминированно повторяет PBKDF2.
 *
 * Constant-time сравнение чтобы не утечь по таймингу длину совпадения.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  if (typeof stored !== 'string' || !stored.includes(':')) return false
  const [saltB64, hashB64] = stored.split(':')
  if (!saltB64 || !hashB64) return false
  try {
    const salt = b64decode(saltB64)
    const expected = b64decode(hashB64)
    const actual = await deriveBits(pin, salt)
    return constantTimeEquals(actual, expected)
  } catch {
    return false
  }
}

/** PIN установлен в Settings? */
export async function hasPinSet(): Promise<boolean> {
  const v = await getSetting(SettingKey.AdminPinHash)
  return Boolean(v && v.length > 0)
}

/** Сохранить новый PIN (хэшированно). */
export async function setPin(pin: string): Promise<void> {
  if (!pin || pin.length < 4) {
    throw new Error('PIN должен быть не короче 4 символов')
  }
  const hash = await hashPin(pin)
  await setSetting(SettingKey.AdminPinHash, hash)
}

/** Хардкодные admin/admin — для v1 достаточно, в v2 сделаем настраиваемые. */
export function verifyAdminCredentials(login: string, password: string): boolean {
  return login === ADMIN_LOGIN && password === ADMIN_PASSWORD
}

// ── PBKDF2 helpers (Web Crypto API) ────────────────────────────────────

async function deriveBits(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  const enc = new TextEncoder().encode(pin)
  const key = await crypto.subtle.importKey('raw', enc, 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
    },
    key,
    KEY_BITS,
  )
  return new Uint8Array(bits)
}

function b64encode(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}

function b64decode(s: string): Uint8Array {
  const raw = atob(s)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function constantTimeEquals(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a[i]! ^ b[i]!
  }
  return diff === 0
}
