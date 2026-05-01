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
 * Проверить обновления при старте приложения. Тихо, без UI:
 * если есть — пишем в лог, а UI показывает только при ручном запросе.
 */
export async function backgroundCheckOnStartup(): Promise<void> {
  try {
    await checkForUpdate()
  } catch {
    // ошибки уже залогированы внутри
  }
}
