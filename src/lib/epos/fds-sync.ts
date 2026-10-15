/**
 * Отправка накопленных чеков FiscalDriveService в ОФД.
 *
 * FiscalDriveService подписывает чек в фискальном модуле (ФМ) и хранит его у
 * себя, а в ОФД отправляет ТОЛЬКО по команде кассы. Касса этой команды не
 * давала: раньше её, видимо, подавал E-POS Cashdesk. Чеки копились в ФМ, и
 * когда самый старый неотправленный стал старше двух суток, ФМ заблокировал
 * продажи (`9031 - SEND_ALL_RECEIPTS_FIRST`) — Хазрати Имом встал 15.10.2026
 * с 10:26 до вечера.
 *
 * Теперь касса отправляет чеки сама: после каждого пробитого чека и раз в
 * 10 минут. И следит за возрастом самого старого неотправленного чека —
 * если он старше суток (до блокировки остаются сутки), пишет error, который
 * уходит на сервер и виден админу.
 *
 * Только для бэкенда `fiscaldrive`; у E-POS Communicator отправка своя.
 */

import { getSetting, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'
import {
  FiscalDriveClient,
  FISCAL_DRIVE_DEFAULT_URL,
  type FiscalDriveMemoryInfo,
} from './fiscal-drive-client'

/** Сколько чеков отправляет один вызов Sync — больше 32 сервис не берёт. */
const BATCH = 32
/** Предохранитель от бесконечного цикла: 20 × 32 = 640 чеков за проход. */
const MAX_ROUNDS = 20
const SYNC_INTERVAL_MS = 10 * 60 * 1000
/** Отправка пачки в ОФД идёт через интернет — даём ей время. */
const SYNC_TIMEOUT_MS = 120_000
/** ФМ блокирует продажи на 48 ч; тревожим на 24 ч, чтобы успели починить. */
export const UNSENT_ALARM_HOURS = 24
export const UNSENT_BLOCK_HOURS = 48

export interface PendingSendResult {
  receipts: number
  zReports: number
}

/**
 * Отправить всё накопленное: чеки пачками по 32, пока сервис их отдаёт, и
 * закрытые смены. Ошибки пробрасываются — решает вызывающий.
 */
export async function sendPendingToOfd(
  client: FiscalDriveClient,
  factoryId: string,
): Promise<PendingSendResult> {
  let receipts = 0
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await client.syncFullReceipts(factoryId, BATCH)
    const items = res?.Items?.length ?? 0
    receipts += res?.SuccessfulsCount ?? 0
    // Меньше полной пачки — больше отправлять нечего.
    if (items < BATCH) break
  }
  const z = await client.syncZReports(factoryId, BATCH)
  return { receipts, zReports: z?.SuccessfulsCount ?? 0 }
}

/**
 * Сколько часов самому старому чеку, который ещё не ушёл в ОФД. null — всё
 * отправлено или ФМ не сообщил время.
 *
 * Отсчёт от `LastOperationTime` ФМ, а не от часов компьютера: блокировку ФМ
 * считает по своим часам.
 */
export function unsentAgeHours(info: Pick<FiscalDriveMemoryInfo, 'ReceiptsCount' | 'LastOperationTime' | 'FirstUnacknowledgedReceiptTime'>): number | null {
  if (!info.ReceiptsCount || !info.FirstUnacknowledgedReceiptTime) return null
  const first = parseFdsTime(info.FirstUnacknowledgedReceiptTime)
  const last = parseFdsTime(info.LastOperationTime) ?? Date.now()
  if (first === null) return null
  return Math.max(0, (last - first) / 3_600_000)
}

/** «2026-10-15 10:26:09» или ISO → миллисекунды. */
function parseFdsTime(value: string | undefined): number | null {
  if (!value) return null
  const t = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'))
  return Number.isFinite(t) ? t : null
}

// ── Фоновый цикл ──────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null
let inFlight: Promise<void> | null = null
let consecutiveFailures = 0
let lastAlarmAt = 0

async function loadConfig(): Promise<{ baseUrl: string; factoryId: string } | null> {
  const backend = await getSetting(SettingKey.FiscalBackend)
  if (backend !== 'fiscaldrive') return null
  const factoryId = (await getSetting(SettingKey.FiscalDriveFactoryId))?.trim()
  if (!factoryId) return null
  const baseUrl = (await getSetting(SettingKey.FiscalDriveBaseUrl))?.trim() || FISCAL_DRIVE_DEFAULT_URL
  return { baseUrl, factoryId }
}

/** Один проход: отправить и проверить, что в ФМ не залежалось. Не бросает. */
export function runFdsSyncOnce(): Promise<void> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    const cfg = await loadConfig()
    if (!cfg) return
    const client = new FiscalDriveClient({ baseUrl: cfg.baseUrl, timeoutMs: SYNC_TIMEOUT_MS })
    try {
      const sent = await sendPendingToOfd(client, cfg.factoryId)
      if (sent.receipts > 0 || sent.zReports > 0) {
        await log.info('fiscalize', `В ОФД отправлено: чеков ${sent.receipts}, Z-отчётов ${sent.zReports}`)
      }
      consecutiveFailures = 0
    } catch (e) {
      consecutiveFailures += 1
      const msg = e instanceof Error ? e.message : String(e)
      // Одиночный сбой (нет интернета минуту) — локально; затяжной — на сервер.
      const write = consecutiveFailures >= 3 ? log.error : log.warn
      await write('fiscalize', `Не удалось отправить чеки в ОФД (попытка ${consecutiveFailures}): ${msg}`)
    }

    try {
      const info = await client.getFiscalMemoryInfo(cfg.factoryId)
      const age = unsentAgeHours(info)
      if (age !== null && age >= UNSENT_ALARM_HOURS && Date.now() - lastAlarmAt > 60 * 60 * 1000) {
        lastAlarmAt = Date.now()
        const left = Math.max(0, Math.round(UNSENT_BLOCK_HOURS - age))
        await log.error(
          'fiscalize',
          `🚨 Чеки не уходят в ОФД ${Math.round(age)} ч (${info.ReceiptsCount} шт). ` +
            `Через ~${left} ч фискальный модуль заблокирует продажи — проверьте интернет на кассе.`,
          { receipts: info.ReceiptsCount, first: info.FirstUnacknowledgedReceiptTime },
        )
      }
    } catch {
      // Состояние ФМ — для тревоги; не узнали сейчас — узнаем через 10 минут.
    }
  })().finally(() => {
    inFlight = null
  })
  return inFlight
}

/** Сразу после пробитого чека: отправить его, не задерживая кассира. */
export function kickFdsSync(): void {
  void runFdsSyncOnce().catch(() => {})
}

/** Запустить фоновую отправку. Идемпотентно, никогда не бросает. */
export function ensureFdsSyncStarted(): void {
  if (timer) return
  // Первый проход сразу: касса могла быть выключена с неотправленными чеками.
  kickFdsSync()
  timer = setInterval(kickFdsSync, SYNC_INTERVAL_MS)
}
