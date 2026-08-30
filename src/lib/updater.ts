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
/**
 * Сколько проверок подряд сорвалось. Сбрасывается при первой удачной.
 *
 * Порог намеренно маленький: проверка идёт раз в два часа, поэтому три
 * неудачи подряд — это уже около полусуток без связи с GitHub.
 */
const UPDATE_FAIL_THRESHOLD = 3
let updateCheckFailures = 0

/**
 * Повторы внутри ОДНОЙ проверки.
 *
 * До GitHub с магазинного канала запрос доходит не всегда: в логах за два
 * месяца 56 срывов «error sending request», причём у Хонабода 27. На версиях
 * без фоновой проверки обновление ищется только при запуске — и одна такая
 * осечка означала, что за всю сессию магазин не увидит новую версию. Так три
 * кассы и просидели неделю на 0.11.25, пока фиксы лежали в релизах.
 *
 * Пара повторов с паузой превращает моргнувший канал в обычную успешную
 * проверку.
 */
const CHECK_ATTEMPTS = 3
const CHECK_BACKOFF_MS = [2_000, 6_000]

/** Дотянуться до latest.json, пережив моргание канала. */
async function checkWithRetry(): Promise<Update | null> {
  let lastErr: unknown
  for (let attempt = 0; attempt < CHECK_ATTEMPTS; attempt++) {
    try {
      return await check()
    } catch (e) {
      lastErr = e
      const pause = CHECK_BACKOFF_MS[attempt]
      if (pause === undefined) break
      await new Promise((r) => setTimeout(r, pause))
    }
  }
  throw lastErr
}

export async function checkForUpdate(): Promise<Update | null> {
  try {
    const update = await checkWithRetry()
    updateCheckFailures = 0
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
    // Уровень зависит от того, сорвалась проверка разово или не проходит
    // давно.
    //
    // Раньше здесь всегда был error, и каждая неудачная попытка достучаться
    // до GitHub уезжала в телеметрию: за неделю 35 записей, все с одним и тем
    // же «error sending request». Канал магазина моргает, это норма — но за
    // таким шумом не видно настоящих поломок. А после перехода на проверку
    // раз в два часа записей стало только больше.
    //
    // Одиночные срывы теперь тихие. Если же обновления не проверяются подряд
    // (см. порог) — это уже не сеть моргнула, а магазин перестал получать
    // новые версии, и об этом нужно знать: именно так три кассы неделю сидели
    // на 0.11.25, пока фиксы лежали в релизах.
    updateCheckFailures += 1
    const persistent = updateCheckFailures === UPDATE_FAIL_THRESHOLD
    await (persistent ? log.error : log.warn)(
      'updater',
      persistent
        ? `Обновления не проверяются ${updateCheckFailures} попыток подряд — ` +
            'магазин не получает новые версии'
        : 'Не удалось проверить обновления (попробуем позже)',
      { error: e instanceof Error ? e.message : String(e), consecutive: updateCheckFailures },
    )
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

/**
 * Пауза после неудачной проверки.
 *
 * Ждать полных два часа из-за одного моргнувшего канала — значит оставить
 * магазин без обновления на полдня. После успеха возвращаемся к обычному
 * интервалу.
 */
const UPDATE_RETRY_INTERVAL_MS = 10 * 60 * 1000

let updateTimer: ReturnType<typeof setTimeout> | null = null
let started = false
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

/** Одна проверка. Возвращает `false`, если достучаться не удалось. */
async function checkTick(): Promise<boolean> {
  try {
    const update = await checkForUpdate()
    if (update) {
      pending = { version: update.version, notes: update.body, date: update.date }
      for (const fn of updateListeners) fn(pending)
    }
    return true
  } catch {
    // Уже залогировано в checkForUpdate с нужным уровнем.
    return false
  }
}

/** Запланировать следующую проверку: раньше — если предыдущая не прошла. */
function scheduleNext(ok: boolean): void {
  if (!started) return
  updateTimer = setTimeout(() => {
    void checkTick().then(scheduleNext)
  }, ok ? UPDATE_CHECK_INTERVAL_MS : UPDATE_RETRY_INTERVAL_MS)
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
  if (started) return
  started = true
  void checkTick().then(scheduleNext)
}

export function stopUpdateCheck(): void {
  started = false
  if (updateTimer) clearTimeout(updateTimer)
  updateTimer = null
  pending = null
}

/** Применить найденное обновление по кнопке в баннере. */
export async function applyPendingUpdate(): Promise<void> {
  const update = await check()
  if (!update) return
  await applyUpdate(update)
}
