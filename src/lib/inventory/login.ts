/**
 * Login flow для Tauri-магазина.
 *
 * Кассир вводит МС email+password → POST /inventory/login → backend сверяет
 * и возвращает {api_key, shop, moysklad}. Tauri пишет всё в local Settings,
 * после чего AppGate пропускает к основному приложению.
 *
 * Logout — очищает session-related Settings, AppGate возвращает на login.
 */

import { fetch } from '@tauri-apps/plugin-http'
import { getSetting, setSettings, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'

export type LoginErrorCode =
  | 'shop_not_found'
  | 'invalid_password'
  | 'inactive_shop'
  | 'shop_not_configured'
  | 'api_key_not_recoverable'
  | 'bad_request'
  | 'server_error'
  | 'network_error'

export interface LoginSuccess {
  ok: true
  shop: {
    id: number
    slug: string
    name: string
    organization_id: string
  }
  moysklad: {
    login: string
    retailstore_name: string | null
  }
}

export interface LoginFailure {
  ok: false
  code: LoginErrorCode
  message: string
}

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  shop_not_found:
    'Магазин с таким email не найден. Обратитесь к администратору, чтобы он создал ваш магазин в mytoolbox.',
  invalid_password: 'Неверный пароль.',
  inactive_shop: 'Магазин временно отключён. Обратитесь к администратору.',
  shop_not_configured:
    'Администратор ещё не привязал ваш МС-аккаунт к магазину в mytoolbox.',
  api_key_not_recoverable:
    'Внутренняя ошибка: API key магазина недоступен. Попроси админа перевыпустить ключ.',
  bad_request: 'Не указаны email или пароль.',
  server_error: 'Сервер вернул ошибку. Попробуйте позже.',
  network_error:
    'Нет связи с сервером. Проверьте интернет и URL inventory server в настройках.',
}

/**
 * Аутентификация через mytoolbox-сервер.
 *
 * Требует чтобы InventoryServerUrl уже был установлен (вводится один раз
 * админом при инсталляции, или дефолтное значение из релиза).
 *
 * При успехе пишет в Settings:
 *   - InventoryRemoteEnabled = 'true'
 *   - InventoryShopApiKey, InventoryShopSlug
 *   - MoyskladCredentials, MoyskladLogin
 *   - MoyskladRetailStoreId/Name, MoyskladEmployeeId/Name
 */
export async function signInWithMs({
  email,
  password,
}: {
  email: string
  password: string
}): Promise<LoginSuccess | LoginFailure> {
  const serverUrl = await getSetting(SettingKey.InventoryServerUrl)
  if (!serverUrl) {
    return {
      ok: false,
      code: 'bad_request',
      message:
        'Не указан адрес сервера. Откройте Admin → Настройки → Inventory Server.',
    }
  }

  let response
  try {
    response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/v1/inventory/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ email: email.trim(), password }),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.sync', `login network error: ${msg}`)
    return { ok: false, code: 'network_error', message: ERROR_MESSAGES.network_error }
  }

  let body: unknown
  try {
    const text = await response.text()
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }

  if (!response.ok) {
    const code = (body as { code?: LoginErrorCode })?.code ?? 'server_error'
    return {
      ok: false,
      code,
      message: ERROR_MESSAGES[code] ?? `HTTP ${response.status}`,
    }
  }

  const data = body as {
    ok: boolean
    shop: LoginSuccess['shop']
    api_key: string
    moysklad: {
      login: string
      basic_credentials: string
      retailstore_id: string | null
      retailstore_name: string | null
      employee_id: string | null
      employee_name: string | null
    }
  }
  if (!data?.ok || !data.api_key) {
    return { ok: false, code: 'server_error', message: 'Сервер вернул неверный формат' }
  }

  // Пишем всё в Settings одной транзакцией (одна `setSettings`).
  await setSettings({
    [SettingKey.InventoryRemoteEnabled]: 'true',
    [SettingKey.InventoryShopApiKey]: data.api_key,
    [SettingKey.InventoryShopSlug]: data.shop.slug,
    [SettingKey.MoyskladCredentials]: data.moysklad.basic_credentials,
    [SettingKey.MoyskladLogin]: data.moysklad.login,
    [SettingKey.MoyskladRetailStoreId]: data.moysklad.retailstore_id ?? '',
    [SettingKey.MoyskladRetailStoreName]: data.moysklad.retailstore_name ?? '',
    [SettingKey.MoyskladEmployeeId]: data.moysklad.employee_id ?? '',
    [SettingKey.MoyskladEmployeeName]: data.moysklad.employee_name ?? '',
  })

  await log.info(
    'inventory.sync',
    `Logged in: shop=${data.shop.slug} (${data.shop.name}), ms=${data.moysklad.login}`,
  )

  return {
    ok: true,
    shop: data.shop,
    moysklad: {
      login: data.moysklad.login,
      retailstore_name: data.moysklad.retailstore_name,
    },
  }
}

/**
 * Logout. Очищает все session-ключи в Settings. После вызова AppGate
 * увидит пустой MoyskladCredentials и перенаправит на Login.
 *
 * НЕ трогает device-ключи: EposCommunicatorUrl, CompanyName, PrinterName,
 * InventoryServerUrl — это настройки самой машины, не сессии.
 */
export async function signOut(): Promise<void> {
  await setSettings({
    // МС
    [SettingKey.MoyskladCredentials]: '',
    [SettingKey.MoyskladToken]: '',
    [SettingKey.MoyskladLogin]: '',
    [SettingKey.MoyskladRetailStoreId]: '',
    [SettingKey.MoyskladRetailStoreName]: '',
    [SettingKey.MoyskladEmployeeId]: '',
    [SettingKey.MoyskladEmployeeName]: '',
    // Inventory session — уроним на ноль чтобы AppGate видел Login
    [SettingKey.InventoryRemoteEnabled]: 'false',
    [SettingKey.InventoryShopApiKey]: '',
    [SettingKey.InventoryShopSlug]: '',
    [SettingKey.InventoryLastSyncTs]: '',
  })
  await log.info('inventory.sync', 'Logged out — session settings cleared')
}

/**
 * Хук-чекер для AppGate. Сессия валидна если есть:
 *   - MoyskladCredentials (для МС-поллера)
 *   - InventoryShopApiKey (для inventory-сервера, обязательно с 0.10+)
 *
 * Не делает сетевых запросов — только локальная проверка. Если ключи
 * протухли — это обнаружится при первом API-вызове и пользователя
 * вернёт на Login через UI flow (см. AppGate.tsx).
 */
export async function hasActiveSession(): Promise<boolean> {
  const [ms, apiKey] = await Promise.all([
    getSetting(SettingKey.MoyskladCredentials),
    getSetting(SettingKey.InventoryShopApiKey),
  ])
  return Boolean(ms && apiKey)
}
