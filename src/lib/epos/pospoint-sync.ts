/**
 * Фоновое наблюдение за Pospoint (только для бэкенда 'pospoint').
 *
 * Раз в минуту — жива ли программа (GET /health, ФМ не трогает). Pospoint
 * принимает чеки, только пока программа открыта, выполнен вход и включён
 * «Режим интеграции», а после повторного входа по логину этот режим
 * выключается сам. Без проверки кассир узнал бы об этом только на чеке.
 *
 * Раз в 10 минут:
 *   - ключ и касса: ключ принят, касса активна, фискальный режим включён;
 *   - подключён ли фискальный модуль, какая версия апплета (от неё зависит
 *     смысл части кодов ошибок);
 *   - не копятся ли чеки, не ушедшие в ОФД. Pospoint отправляет их сам (и
 *     раз в час); мы досылаем, только если очередь стоит больше часа: наш
 *     вызов держит кассу до двух минут, и чек кассира ждал бы за ним. Если
 *     чеки висят больше суток — 🚨 на сервер: ФМ хранит неотправленное
 *     ограниченное время, потом блокирует продажи. Время, с которого висят,
 *     переживает перезапуск программы;
 *   - попытки с неизвестным исходом (журнал), которые кассир не повторил:
 *     пробита — сохраняем её сами (без печати), не вышло — 🚨; точно не
 *     пробита — снимаем;
 *   - кэш единиц измерения для склада, чтобы на чеке не ждать справочник.
 *
 * Все вызовы — фоновые: касса выполняет запросы по одному, и чек кассира
 * идёт вперёд очереди (см. PospointClient, опция background).
 */

import { getSetting, listEsfItems, setSetting, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'
import {
  ensureUnits,
  flushOfd,
  getPospointClient,
  isPospointFmHandedOver,
  isPospointForegroundBusy,
  listPendingAttempts,
  setPospointApplet,
  updatePendingAttempt,
} from './pospoint'
import { POSPOINT_TEST_KEY, PospointError, type PospointClient } from './pospoint-client'
import { settlePendingAttempt } from './pospoint-settle'

const HEALTH_INTERVAL_MS = 60 * 1000
const FM_INTERVAL_MS = 10 * 60 * 1000
const UNSENT_ALARM_MS = 24 * 60 * 60 * 1000
/** Pospoint сам шлёт чеки раз в час — вмешиваемся, только если это не помогло. */
const UNSENT_FLUSH_AFTER_MS = 60 * 60 * 1000
const LOG_EVERY_MS = 60 * 60 * 1000
/** Сколько подряд «не отвечает», прежде чем писать error (одиночные сбои — шум). */
const DOWN_LOG_AFTER = 3
/** Сколько подряд неудачных досылок в ОФД, прежде чем писать error. */
const OFD_FAIL_LOG_AFTER = 3
/** Попытка моложе — её, возможно, ещё разбирает кассир. */
const PENDING_MIN_AGE_MS = 10 * 60 * 1000
/** Не пробита, но ФМ мог подписать — напоминаем раз в сутки. */
const PENDING_REPORT_EVERY_MS = 24 * 60 * 60 * 1000

export type PospointHealthState =
  | 'off'
  | 'unknown'
  | 'no-key'
  | 'test-key'
  | 'bad-key'
  | 'inactive'
  | 'fiscal-off'
  | 'demo-limit'
  | 'pos-auth'
  | 'down'
  | 'fm-disconnected'
  | 'up'

/** Состояния, которые узнаются только длинной проверкой — короткая их не затирает. */
const STICKY: PospointHealthState[] = ['bad-key', 'inactive', 'fiscal-off', 'demo-limit', 'pos-auth', 'fm-disconnected']

export interface PospointHealth {
  state: PospointHealthState
  checkedAt: number
  /** Чеков не ушло в ОФД (по последней проверке ФМ). */
  unsent: number
  /** С какого момента чеки не уходят; null — всё отправлено. */
  unsentSince: number | null
  terminalId?: string
  appletVersion?: string
  /** Попыток с неизвестным исходом в журнале. */
  pending: number
}

const INITIAL: PospointHealth = { state: 'unknown', checkedAt: 0, unsent: 0, unsentSince: null, pending: 0 }

let health: PospointHealth = { ...INITIAL }
/**
 * Что показала последняя длинная проверка (ключ, касса, ФМ). Короткая
 * проверка «жива ли программа» после сбоя возвращает именно это состояние,
 * а не «всё хорошо»: проблема с ключом или ФМ от перезапуска не проходит.
 */
let lastFmState: PospointHealthState | null = null
let downStreak = 0
let ofdFailStreak = 0
let lastOfdFlushAt = 0
const lastLogAt = new Map<string, number>()

export function getPospointHealth(): PospointHealth {
  return health
}

function setState(state: PospointHealthState, patch: Partial<PospointHealth> = {}): void {
  health = { ...health, ...patch, state, checkedAt: Date.now() }
}

/** error на сервер — не чаще раза в час на тему. */
async function errorHourly(topic: string, message: string, details?: Record<string, unknown>): Promise<void> {
  const now = Date.now()
  if (now - (lastLogAt.get(topic) ?? 0) < LOG_EVERY_MS) return
  lastLogAt.set(topic, now)
  await log.error('fiscalize', message, details)
}

/** Касса работает через Pospoint и ключ годится? Иначе — состояние для панели. */
async function readyClient(): Promise<PospointClient | null> {
  if ((await getSetting(SettingKey.FiscalBackend)) !== 'pospoint') {
    lastFmState = null
    setState('off')
    return null
  }
  const key = ((await getSetting(SettingKey.PospointKey)) ?? '').trim()
  if (!key) {
    lastFmState = null
    setState('no-key')
    return null
  }
  if (key === POSPOINT_TEST_KEY) {
    lastFmState = null
    setState('test-key')
    await errorHourly('test-key', 'Pospoint: указан тестовый ключ из документации — чеки не фискализируются')
    return null
  }
  try {
    return await getPospointClient({ background: true })
  } catch {
    setState('no-key')
    return null
  }
}

/** Ответ кассы про ключ, регистрацию или ФМ → состояние. null — ошибка не об этом. */
function keyState(e: unknown): { state: PospointHealthState; message: string } | null {
  if (!(e instanceof PospointError)) return null
  if (e.has(4240, 4100, -13)) {
    return { state: 'fm-disconnected', message: 'Pospoint: фискальный модуль не найден или не отвечает — проверьте USB-ридер ФМ' }
  }
  if (e.has(14800)) return { state: 'bad-key', message: 'Pospoint не принял ключ кассы — чеки не пробиваются' }
  if (e.has(-10)) return { state: 'inactive', message: 'Pospoint: касса не активна (регистрация или подписка) — чеки не пробиваются' }
  if (e.has(-12)) return { state: 'fiscal-off', message: 'Pospoint: выключен фискальный режим — чеки не пробиваются' }
  if (e.has(-555)) return { state: 'demo-limit', message: 'Pospoint: исчерпан лимит демо-режима — чеки не пробиваются' }
  if (e.has(37011)) return { state: 'pos-auth', message: 'Pospoint: касса не авторизована в фискальном модуле — чеки не пробиваются' }
  return null
}

let healthInFlight: Promise<void> | null = null

/** Жива ли программа. Не бросает. */
export function runPospointHealthOnce(): Promise<void> {
  if (healthInFlight) return healthInFlight
  healthInFlight = (async () => {
    const client = await readyClient()
    if (!client) return
    // Число незавершённых попыток — с каждой короткой проверкой (одно чтение
    // настройки), чтобы панель не отставала на 10 минут.
    const pending = (await listPendingAttempts().catch(() => [])).length
    if (await client.health()) {
      downStreak = 0
      if (!STICKY.includes(health.state)) setState(lastFmState ?? 'up', { pending })
      else health = { ...health, pending }
      return
    }
    downStreak++
    setState('down', { pending })
    if (downStreak >= DOWN_LOG_AFTER) {
      await errorHourly(
        'down',
        'Pospoint не отвечает: программа закрыта, не выполнен вход или не работает «Режим интеграции» (выключить и включить снова) — чеки не пробиваются',
      )
    }
  })()
    .catch(() => {})
    .finally(() => {
      healthInFlight = null
    })
  return healthInFlight
}

async function loadUnsentSince(): Promise<number | null> {
  const raw = await getSetting(SettingKey.PospointUnsentSince).catch(() => null)
  const v = raw ? Number(raw) : NaN
  return Number.isFinite(v) && v > 0 ? v : null
}

async function saveUnsentSince(v: number | null): Promise<void> {
  await setSetting(SettingKey.PospointUnsentSince, v ? String(v) : '').catch(() => {})
}

/** Очередь неотправленных: досылка, если стоит; тревога, если больше суток. */
async function watchUnsent(client: PospointClient, fmUnsent: number, terminalId: string | undefined): Promise<void> {
  let unsent = fmUnsent
  const saved = await loadUnsentSince()
  let since = unsent > 0 ? (saved ?? Date.now()) : null

  if (since && Date.now() - since >= UNSENT_FLUSH_AFTER_MS && Date.now() - lastOfdFlushAt >= UNSENT_FLUSH_AFTER_MS) {
    lastOfdFlushAt = Date.now()
    try {
      const sent = await flushOfd(client, 1)
      ofdFailStreak = 0
      if (sent > 0) {
        await log.info('fiscalize', `Pospoint: в ОФД дослано чеков: ${sent}`)
        const fm = await client.checkFmStatus().catch(() => null)
        if (fm) unsent = fm.unsentReceiptCount ?? 0
        if (unsent === 0) since = null
      }
    } catch (e) {
      ofdFailStreak++
      if (ofdFailStreak >= OFD_FAIL_LOG_AFTER) {
        await errorHourly('ofd-sync', 'Pospoint: чеки не удаётся отправить в ОФД', {
          error: e instanceof Error ? e.message : String(e),
          unsent,
        })
      }
    }
  }

  if (since !== saved) await saveUnsentSince(since)
  health = { ...health, unsent, unsentSince: since }
  if (since && Date.now() - since >= UNSENT_ALARM_MS) {
    await errorHourly(
      'unsent',
      `🚨 Pospoint: ${unsent} чеков не уходят в ОФД больше суток — проверьте интернет на кассе. ` +
        'Когда истечёт срок хранения, фискальный модуль заблокирует продажи.',
      { terminalId, since: new Date(since).toISOString() },
    )
  }
}

/**
 * Попытки с неизвестным исходом, которые никто не довёл до конца (см.
 * settlePendingAttempt). 🚨 — только когда нужен человек: чек пробит, а
 * сохранить не вышло, или ФМ мог подписать чек мимо Pospoint. Напоминаем
 * раз в сутки, пока запись не снята.
 */
async function reviewPendingAttempts(): Promise<void> {
  // В тестовом режиме сохранить настоящий чек нельзя — ждём, пока выключат.
  if ((await getSetting(SettingKey.TestMode)) === 'true') return
  const entries = await listPendingAttempts()
  for (const [payCheckNumber, p] of entries) {
    if (isPospointForegroundBusy()) break
    if (Date.now() - p.at < PENDING_MIN_AGE_MS) continue
    const source = p.kind === 'sale' ? 'fiscalize' : 'refund'
    const what = p.kind === 'sale' ? 'чек' : 'возврат'
    const r = await settlePendingAttempt(payCheckNumber, { background: true })
    if (r.status === 'unknown') break // касса не отвечает — проверим в следующий раз
    if (r.status === 'saved') {
      await log.warn(source, `Pospoint: ${what} ${payCheckNumber} был пробит, но не сохранён — сохранён фоновой проверкой`, {
        fiscalSign: r.fiscalSign,
      })
      continue
    }
    if (r.status === 'cleared') {
      await log.info(source, `Pospoint: попытка ${payCheckNumber} не пробита — снята из журнала`)
      continue
    }
    if (r.status === 'none') continue
    if (p.reportedAt && Date.now() - p.reportedAt < PENDING_REPORT_EVERY_MS) continue
    if (r.status === 'failed') {
      await log.error(
        source,
        `🚨 Pospoint: ${what} ${payCheckNumber} пробит (признак ${r.fiscalSign}), но не сохранён в программе, и сохранить его не удалось` +
          (p.kind === 'sale'
            ? ' — откройте этот документ и нажмите «Фискализировать»: сохранится без второго чека.'
            : ' — откройте возврат по этому чеку и повторите: сохранится без второго возврата.'),
        { payCheckNumber, error: r.error },
      )
    } else {
      await log.error(
        source,
        `🚨 Pospoint: ${what} ${payCheckNumber} мог быть подписан фискальным модулем без записи в Pospoint — документ заблокирован до сверки`,
        { payCheckNumber, at: new Date(p.at).toISOString() },
      )
    }
    await updatePendingAttempt(payCheckNumber, { reportedAt: Date.now() })
  }
  health = { ...health, pending: (await listPendingAttempts()).length }
}

let fmInFlight: Promise<void> | null = null

/** Ключ, ФМ, отправка в ОФД, журнал попыток, кэш единиц. Не бросает. */
export function runPospointFmOnce(): Promise<void> {
  if (fmInFlight) return fmInFlight
  fmInFlight = (async () => {
    const client = await readyClient()
    if (!client) return
    if (!(await client.health())) {
      setState('down')
      return
    }
    // ФМ не трогаем, пока кассир сам не начал работать через Pospoint: до
    // этого им ещё может владеть старая программа (см. isPospointFmHandedOver).
    // Журнал попыток и кэш единиц ФМ не касаются — они идут как обычно.
    try {
      if (!(await isPospointFmHandedOver())) {
        // Ключ и кассу проверяем поиском чека: ответ из базы Pospoint, без ФМ.
        await client.getReceiptByPayCheckNumber('key-check')
        lastFmState = 'up'
        setState('up')
      } else {
        const fm = await client.checkFmStatus()
        setPospointApplet(fm.appletVersion)
        if (!fm.isConnected) {
          lastFmState = 'fm-disconnected'
          setState('fm-disconnected', { terminalId: fm.terminalId, appletVersion: fm.appletVersion })
          await errorHourly('fm', 'Pospoint: фискальный модуль не подключён — проверьте USB-ридер ФМ')
        } else {
          lastFmState = 'up'
          setState('up', { terminalId: fm.terminalId, appletVersion: fm.appletVersion })
          await watchUnsent(client, fm.unsentReceiptCount ?? 0, fm.terminalId)
        }
      }
    } catch (e) {
      const ks = keyState(e)
      if (ks) {
        lastFmState = ks.state
        setState(ks.state)
        await errorHourly(ks.state, ks.message)
        return
      }
      await log.warn('fiscalize', `Pospoint: проверка ФМ не удалась: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      await reviewPendingAttempts()
    } catch (e) {
      await log.warn('fiscalize', `Pospoint: проверка журнала попыток не удалась: ${e instanceof Error ? e.message : String(e)}`)
    }

    try {
      const items = await listEsfItems({ minAvailable: 1000, source: 'remote', limit: 5000 })
      await ensureUnits(
        client,
        items.map((i) => i.class_code),
        { maxFetch: 20, timeoutMs: 8_000, stopOnOutage: true },
      )
    } catch {
      // Справочник недоступен — на чеке единица возьмётся из прихода или «шт».
    }
  })()
    .catch(() => {})
    .finally(() => {
      fmInFlight = null
    })
  return fmInFlight
}

let healthTimer: ReturnType<typeof setInterval> | null = null
let fmTimer: ReturnType<typeof setInterval> | null = null

/** Запустить наблюдение. Идемпотентно; на других бэкендах проверки сразу выходят. */
export function ensurePospointSyncStarted(): void {
  if (healthTimer) return
  void runPospointHealthOnce()
  void runPospointFmOnce()
  healthTimer = setInterval(() => void runPospointHealthOnce(), HEALTH_INTERVAL_MS)
  fmTimer = setInterval(() => void runPospointFmOnce(), FM_INTERVAL_MS)
}

/**
 * Перепроверить сейчас (после сохранения настроек). `fm: false` — только
 * «жива ли программа»: сразу после переключения кассы ФМ не трогаем, пока
 * кассир не выключил старую программу (см. порядок перехода).
 */
export function kickPospointSync(opts: { fm?: boolean } = {}): void {
  void runPospointHealthOnce().then(() => (opts.fm === false ? undefined : runPospointFmOnce()))
}

/** Для тестов. */
export function _resetPospointHealthForTests(): void {
  health = { ...INITIAL }
  lastFmState = null
  downStreak = 0
  ofdFailStreak = 0
  lastOfdFlushAt = 0
  lastLogAt.clear()
  if (healthTimer) clearInterval(healthTimer)
  if (fmTimer) clearInterval(fmTimer)
  healthTimer = null
  fmTimer = null
}
