/**
 * Можно ли переключить кассу на другую программу фискализации.
 *
 * Перед переключением старая программа должна закрыть смену и отправить в
 * ОФД всё накопленное: после переключения её никто больше не позовёт.
 * FiscalDriveService хранит подписанные чеки у себя и шлёт их только по
 * команде — после переключения они не ушли бы никогда, а ФМ, у которого
 * висят неподтверждённые чеки, через 48 часов блокирует продажи. Открытую
 * смену в старой программе потом не закрыть нашим экраном.
 *
 * Проверяем старую программу. «Не отвечает» — только когда соединение не
 * устанавливается (программа выключена или удалена): тогда кассир может
 * переключиться под свою ответственность. Программа, которая занята (сразу
 * после закрытия смены Communicator и FiscalDriveService шлют в ОФД и
 * отвечают с задержкой), — это «подождите и повторите», а не «выключена».
 *
 * С Pospoint, кроме того, нельзя уйти, пока в журнале есть попытки с
 * неизвестным исходом: после переключения их никто не разберёт, а документ
 * пробился бы второй раз через другую программу.
 */

import { getSetting, SettingKey } from '@/lib/db'
import { FiscalDriveClient, FiscalDriveError, FISCAL_DRIVE_DEFAULT_URL } from './fiscal-drive-client'
import { sendPendingToOfd } from './fds-sync'
import { JsonRpcEposClient, JsonRpcEposError } from './jsonrpc-client'
import { flushOfd, getPospointClient, isPospointShiftClosed, listPendingAttempts, PospointUserError } from './pospoint'
import { PospointError, PospointUnavailableError } from './pospoint-client'

export type FiscalBackendKind = 'epos' | 'fiscaldrive' | 'pospoint'

export type SwitchReadiness =
  | { status: 'ready'; notes: string[] }
  /**
   * Старая программа отвечает, но переключаться нельзя — причины для кассира.
   * `unverified` — она ответила ошибкой, и проверить смену и отправку не
   * удалось: так выглядит и отключённый E-POS, поэтому кассир может
   * переключиться под свою ответственность (как при «не отвечает»).
   */
  | { status: 'blocked'; reasons: string[]; unverified?: string }
  /** Старая программа не отвечает — проверить нельзя. */
  | { status: 'unreachable'; detail: string }

const NAMES: Record<FiscalBackendKind, string> = {
  epos: 'E-POS Communicator',
  fiscaldrive: 'FiscalDriveService',
  pospoint: 'Pospoint',
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Наш таймаут: программа приняла соединение, но не успела ответить. */
function isTimeout(e: unknown): boolean {
  if (e instanceof Error && e.name === 'AbortError') return true
  return /cancell?ed|abort|timed? ?out/i.test(errText(e))
}

/**
 * Сбой связи со старой программой: не успела ответить → «занята, подождите»;
 * всё остальное → «не отвечает» (кассир может переключиться под свою
 * ответственность). По тексту «выключена» не узнать: reqwest на отказ в
 * соединении пишет только «error sending request for url (…)», поэтому
 * отличаем по обратному признаку — был ли это наш таймаут.
 */
function transportFailure(name: string, e: unknown): SwitchReadiness {
  const msg = errText(e)
  if (!isTimeout(e)) return { status: 'unreachable', detail: `${name} не отвечает (${msg})` }
  return {
    status: 'blocked',
    reasons: [`${name} не ответил вовремя — возможно, отправляет чеки в ОФД. Подождите минуту и повторите.`],
  }
}

async function checkEpos(): Promise<SwitchReadiness> {
  const url = (await getSetting(SettingKey.EposCommunicatorUrl)) ?? 'http://localhost:3448/rpc/api'
  const client = new JsonRpcEposClient({ url, timeoutMs: 15_000 })
  const reasons: string[] = []
  try {
    const z = await client.getZReportInfo().catch((e) => {
      // 36909 — смена не открыта: это и нужно.
      if (e instanceof JsonRpcEposError && e.code === 36909) return null
      throw e
    })
    if (z && z.CloseTime === '') reasons.push('Закройте смену в разделе «Смена» (сейчас она открыта в E-POS).')
    const unsent = await client.getUnsentCount()
    if ((unsent?.Count ?? 0) > 0) {
      reasons.push(
        `В E-POS не отправлено в ОФД чеков: ${unsent.Count}. Проверьте интернет и подождите, пока Communicator их отправит.`,
      )
    }
  } catch (e) {
    if (e instanceof JsonRpcEposError) {
      const detail = `E-POS ответил ошибкой: ${errText(e)}`
      return { status: 'blocked', reasons: [detail], unverified: detail }
    }
    return transportFailure('E-POS Communicator', e)
  }
  return reasons.length ? { status: 'blocked', reasons } : { status: 'ready', notes: [] }
}

async function checkFiscalDrive(): Promise<SwitchReadiness> {
  const factoryId = (await getSetting(SettingKey.FiscalDriveFactoryId))?.trim()
  if (!factoryId) return { status: 'unreachable', detail: 'FiscalDriveService не настроен (нет FactoryID)' }
  const baseUrl = (await getSetting(SettingKey.FiscalDriveBaseUrl))?.trim() || FISCAL_DRIVE_DEFAULT_URL
  const client = new FiscalDriveClient({ baseUrl, timeoutMs: 120_000 })
  const reasons: string[] = []
  const notes: string[] = []
  try {
    // Сначала отправляем всё, что накопилось: после переключения эти чеки
    // FiscalDriveService больше никто не попросит отправить.
    const sent = await sendPendingToOfd(client, factoryId)
    if (sent.receipts || sent.zReports) {
      notes.push(`FiscalDriveService отправил в ОФД: чеков ${sent.receipts}, Z-отчётов ${sent.zReports}.`)
    }
    // null — данных о смене нет (404/400); любая другая ошибка — не «закрыта».
    const z = await client.getZReportInfo(factoryId, 0)
    if (z && z.CloseTime === '') reasons.push('Закройте смену в разделе «Смена» (сейчас она открыта в FiscalDriveService).')
    const mem = await client.getFiscalMemoryInfo(factoryId)
    // Только чеки: ReceiptsCount — «ещё не отправлены в ОФД». ZReportsCount —
    // сколько всего Z-отчётов в ФМ за всё время (у Хазрати 243), а не очередь
    // на отправку; по нему блокировать нельзя — касса не переключилась бы никогда.
    if (mem.ReceiptsCount > 0) {
      reasons.push(
        `В фискальном модуле остались не отправленные в ОФД чеки: ${mem.ReceiptsCount}. ` +
          'Проверьте интернет и повторите — переключаться можно, когда всё уйдёт.',
      )
    }
  } catch (e) {
    if (e instanceof FiscalDriveError) {
      const detail = `FiscalDriveService ответил ошибкой: ${errText(e)}`
      return { status: 'blocked', reasons: [detail], unverified: detail }
    }
    return transportFailure('FiscalDriveService', e)
  }
  return reasons.length ? { status: 'blocked', reasons } : { status: 'ready', notes }
}

async function checkPospoint(): Promise<SwitchReadiness> {
  // Журнал — локальный, проверяем даже если Pospoint не отвечает.
  const pending = await listPendingAttempts()
  if (pending.length) {
    return {
      status: 'blocked',
      reasons: [
        `Есть чеки с неизвестным исходом (${pending.map(([n]) => n).join(', ')}). ` +
          'Разберите их в Настройки → Pospoint («Проверить»), потом переключайте: иначе документ может пробиться второй раз.',
      ],
    }
  }
  let client
  try {
    client = await getPospointClient()
  } catch (e) {
    return { status: 'unreachable', detail: errText(e) }
  }
  if (!(await client.health())) return { status: 'unreachable', detail: 'Pospoint не отвечает' }
  const reasons: string[] = []
  const notes: string[] = []
  try {
    try {
      await client.getXReport()
      reasons.push('Закройте смену в разделе «Смена» (сейчас она открыта в Pospoint).')
    } catch (e) {
      if (!isPospointShiftClosed(e)) throw e
    }
    let fm = await client.checkFmStatus()
    if ((fm.unsentReceiptCount ?? 0) > 0) {
      const sent = await flushOfd(client, 3).catch(() => 0)
      if (sent) notes.push(`Pospoint отправил в ОФД чеков: ${sent}.`)
      fm = await client.checkFmStatus()
    }
    if ((fm.unsentReceiptCount ?? 0) > 0) {
      reasons.push(
        `В Pospoint не отправлено в ОФД чеков: ${fm.unsentReceiptCount}. Проверьте интернет и повторите.`,
      )
    }
  } catch (e) {
    if (e instanceof PospointError || e instanceof PospointUserError) {
      return { status: 'blocked', reasons: [`Pospoint ответил ошибкой: ${errText(e)}`] }
    }
    if (e instanceof PospointUnavailableError) return { status: 'unreachable', detail: `Pospoint не отвечает (${errText(e)})` }
    return {
      status: 'blocked',
      reasons: ['Pospoint не ответил вовремя — возможно, отправляет чеки в ОФД. Подождите минуту и повторите.'],
    }
  }
  return reasons.length ? { status: 'blocked', reasons } : { status: 'ready', notes }
}

/** Проверить старую программу перед переключением кассы с `from` на `to`. */
export async function checkSwitchReadiness(from: FiscalBackendKind, to: FiscalBackendKind): Promise<SwitchReadiness> {
  if (from === to) return { status: 'ready', notes: [] }
  if (from === 'epos') return checkEpos()
  if (from === 'fiscaldrive') return checkFiscalDrive()
  return checkPospoint()
}

export function backendName(b: FiscalBackendKind): string {
  return NAMES[b]
}
