import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { log } from './log'

export interface UpdateInfo {
  version: string
  notes?: string
  date?: string
}

/**
 * Проверить наличие обновления (без скачивания).
 * Возвращает Update объект если доступно, иначе null.
 */
export async function checkForUpdate(): Promise<Update | null> {
  try {
    const update = await check()
    if (update) {
      await log.info(
        'updater',
        `Доступно обновление: v${update.version}`,
        {
          version: update.version,
          date: update.date,
          notes: update.body?.slice(0, 500),
        },
      )
    } else {
      await log.debug('updater', 'Обновлений нет, текущая версия актуальна')
    }
    return update
  } catch (e) {
    await log.error('updater', 'Ошибка проверки обновлений', {
      error: e instanceof Error ? e.message : String(e),
    })
    throw e
  }
}

/**
 * Скачать и установить обновление, потом перезапустить приложение.
 */
export async function applyUpdate(update: Update): Promise<void> {
  await log.info('updater', `Скачиваю обновление v${update.version}…`)
  let downloaded = 0
  let total = 0
  await update.downloadAndInstall((event) => {
    if (event.event === 'Started') {
      total = event.data.contentLength ?? 0
    } else if (event.event === 'Progress') {
      downloaded += event.data.chunkLength
    } else if (event.event === 'Finished') {
      void log.info('updater', 'Обновление установлено', { downloaded, total })
    }
  })
  await log.info('updater', 'Перезапуск приложения…')
  await relaunch()
}

/**
 * При старте приложения тихо проверяет, есть ли новая версия,
 * и если есть — сразу скачивает + ставит + перезапускается.
 *
 * Без диалогов и подтверждений: пользователь видит, как приложение
 * закрылось и открылось — уже новой версии. Логи операций пишутся
 * на страницу «Логи» (источник: updater).
 */
export async function autoApplyOnStartup(): Promise<void> {
  try {
    const update = await checkForUpdate()
    if (!update) return
    await log.info('updater', `Применяю обновление v${update.version} автоматически`)
    await applyUpdate(update)
  } catch {
    // ошибки уже залогированы внутри
  }
}

/** Алиас на старое имя — оставлен на случай существующих импортов. */
export const backgroundCheckOnStartup = autoApplyOnStartup

// ── Периодическая проверка обновлений ──────────────────────────────

/**
 * Как часто проверяем обновление у работающей кассы.
 *
 * Зачем вообще: до этого обновление применялось ТОЛЬКО в `autoApplyOnStartup`,
 * а касса приложение не закрывает сутками. В итоге магазины неделями сидели
 * на старой версии — 28.08 все три работали на 0.11.25, хотя 0.11.26 вышел
 * накануне и чинил ровно ту ошибку, на которую жаловался кассир. Любой фикс
 * доезжал до магазина только когда кто-то случайно перезапускал программу.
 */
const UPDATE_CHECK_INTERVAL_MS = 2 * 60 * 60 * 1000

let updateTimer: ReturnType<typeof setInterval> | null = null
let pending: UpdateInfo | null = null
const updateListeners = new Set<(u: UpdateInfo | null) => void>()

/** Найденное, но ещё не применённое обновление (для баннера). */
export function getPendingUpdate(): UpdateInfo | null {
  return pending
}

export function subscribePendingUpdate(fn: (u: UpdateInfo | null) => void): () => void {
  updateListeners.add(fn)
  fn(pending)
  return () => updateListeners.delete(fn)
}

async function checkTick(): Promise<void> {
  try {
    const update = await checkForUpdate()
    if (!update) return
    pending = { version: update.version, notes: update.body, date: update.date }
    for (const fn of updateListeners) fn(pending)
  } catch {
    // уже залогировано в checkForUpdate; сеть могла моргнуть — попробуем позже
  }
}

/**
 * Запустить фоновую проверку обновлений.
 *
 * Намеренно НЕ применяет обновление само: установщик Windows закрывает
 * работающее приложение, и сделай мы это в середине смены — кассир потерял бы
 * набранный чек. Поэтому только показываем баннер, а перезапуск остаётся
 * решением кассира. При следующем старте `autoApplyOnStartup` доделает
 * остальное.
 */
export function ensureUpdateCheckStarted(): void {
  if (updateTimer) return
  void checkTick()
  updateTimer = setInterval(() => void checkTick(), UPDATE_CHECK_INTERVAL_MS)
}

export function stopUpdateCheck(): void {
  if (updateTimer) clearInterval(updateTimer)
  updateTimer = null
  pending = null
}

/** Применить найденное обновление по кнопке в баннере. */
export async function applyPendingUpdate(): Promise<void> {
  const update = await check()
  if (!update) return
  await applyUpdate(update)
}
