/**
 * Вход кассы по коду из админки.
 *
 * Кассир вводит короткий код → POST /inventory/connect → сервер возвращает
 * ключ магазина, доступ к МойСклад и выбранные ранее склад, статус и счета.
 * Касса пишет всё в local Settings, после чего AppGate пропускает к
 * основному приложению.
 *
 * Раньше кассир входил логином и паролем МойСклад, а админ заранее вводил
 * те же логин и пароль в админке. Два места и два человека: при смене
 * пароля в МС ломались оба. Код выдаёт админ, пароль МС на кассе больше
 * не нужен.
 *
 * Logout — очищает session-related Settings, AppGate возвращает на login.
 */

import { fetch } from '@tauri-apps/plugin-http'
import { getSetting, setSettings, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'
import { DEMAND_SYNC_KEY } from '@/lib/moysklad/poller'
import type { ShopMeResponse } from './types'

export type LoginErrorCode =
  | 'invalid_code'
  | 'too_many_attempts'
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
    login: string | null
    store_name: string | null
  }
}

export interface LoginFailure {
  ok: false
  code: LoginErrorCode
  message: string
}

const ERROR_MESSAGES: Record<LoginErrorCode, string> = {
  invalid_code:
    'Неверный код. Проверьте его или попросите администратора выдать новый в админке, вкладка «Магазины».',
  too_many_attempts: 'Слишком много попыток. Подождите 15 минут и попробуйте снова.',
  shop_not_found:
    'Магазин с таким email не найден. Обратитесь к администратору, чтобы он создал ваш магазин в mytoolbox.',
  invalid_password: 'Неверный пароль.',
  inactive_shop: 'Магазин временно отключён. Обратитесь к администратору.',
  shop_not_configured:
    'Администратор ещё не привязал МойСклад к этому магазину в mytoolbox (кнопка «МС» во вкладке «Магазины»).',
  api_key_not_recoverable:
    'Внутренняя ошибка: API key магазина недоступен. Попроси админа перевыпустить ключ.',
  bad_request: 'Не указан код подключения.',
  server_error: 'Сервер вернул ошибку. Попробуйте позже.',
  network_error:
    'Нет связи с сервером. Проверьте интернет и URL inventory server в настройках.',
}

/**
 * Настройки МойСклад, которые сервер отдаёт кассе при входе и в /shop/me.
 * Поля отгрузок приходят от сервера с этой версии; у старого сервера их нет —
 * тогда просто остаются пустыми.
 */
type ServerMoysklad = ShopMeResponse['moysklad']

/**
 * Записать в настройки то, что сервер знает о магазине: доступ к МС, кассира
 * и выбранные склад, статус и счета.
 *
 * Если склад или статус пришли другими, сбрасываем курсор опроса: новый
 * фильтр должен заново пройти по последним суткам, иначе отгрузки,
 * изменённые до старого курсора, так и не попадут в очередь.
 */
export async function applyServerMoysklad(ms: ServerMoysklad): Promise<void> {
  const [prevStore, prevState] = await Promise.all([
    getSetting(SettingKey.MoyskladStoreId),
    getSetting(SettingKey.MoyskladDemandStateId),
  ])
  const storeId = ms.store_id ?? ''
  const stateId = ms.demand_state_id ?? ''
  const filterChanged = (prevStore ?? '') !== storeId || (prevState ?? '') !== stateId

  await setSettings({
    ...(ms.basic_credentials ? { [SettingKey.MoyskladCredentials]: ms.basic_credentials } : {}),
    [SettingKey.MoyskladLogin]: ms.login ?? '',
    [SettingKey.MoyskladEmployeeId]: ms.employee_id ?? '',
    [SettingKey.MoyskladEmployeeName]: ms.employee_name ?? '',
    [SettingKey.MoyskladStoreId]: storeId,
    [SettingKey.MoyskladStoreName]: ms.store_name ?? '',
    [SettingKey.MoyskladDemandStateId]: stateId,
    [SettingKey.MoyskladDemandStateName]: ms.demand_state_name ?? '',
    [SettingKey.MoyskladPaymentAccounts]: JSON.stringify(ms.payment_accounts ?? {}),
    ...(filterChanged ? { [DEMAND_SYNC_KEY as never]: '' } : {}),
  })
}

/**
 * Войти по коду подключения из админки.
 *
 * Требует, чтобы InventoryServerUrl уже был установлен (дефолт из релиза).
 * При успехе пишет в Settings ключ магазина, доступ к МС и выбранные склад,
 * статус и счета.
 */
export async function signInWithCode(code: string): Promise<LoginSuccess | LoginFailure> {
  const serverUrl = await getSetting(SettingKey.InventoryServerUrl)
  if (!serverUrl) {
    return {
      ok: false,
      code: 'bad_request',
      message: 'Не указан адрес сервера. Откройте Настройки → Inventory Server.',
    }
  }
  if (!code.trim()) {
    return { ok: false, code: 'bad_request', message: ERROR_MESSAGES.bad_request }
  }

  let response
  try {
    response = await fetch(`${serverUrl.replace(/\/$/, '')}/api/v1/inventory/connect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ code: code.trim() }),
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    await log.warn('inventory.sync', `connect network error: ${msg}`)
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
    moysklad: ServerMoysklad
  }
  if (!data?.ok || !data.api_key || !data.moysklad?.basic_credentials) {
    return { ok: false, code: 'server_error', message: 'Сервер вернул неверный формат' }
  }

  await setSettings({
    [SettingKey.InventoryRemoteEnabled]: 'true',
    [SettingKey.InventoryShopApiKey]: data.api_key,
    [SettingKey.InventoryShopSlug]: data.shop.slug,
  })
  await applyServerMoysklad(data.moysklad)

  await log.info(
    'inventory.sync',
    `Касса подключена по коду: shop=${data.shop.slug} (${data.shop.name}), ms=${data.moysklad.login}`,
  )

  return {
    ok: true,
    shop: data.shop,
    moysklad: { login: data.moysklad.login, store_name: data.moysklad.store_name ?? null },
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
    // Склад, статус и счета — магазина, а не машины: после выхода за этой
    // кассой может войти другой магазин. Курсор опроса — туда же.
    [SettingKey.MoyskladStoreId]: '',
    [SettingKey.MoyskladStoreName]: '',
    [SettingKey.MoyskladDemandStateId]: '',
    [SettingKey.MoyskladDemandStateName]: '',
    [SettingKey.MoyskladPaymentAccounts]: '',
    [DEMAND_SYNC_KEY as never]: '',
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
