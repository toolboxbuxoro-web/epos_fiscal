import {
  getSetting,
  setSetting,
  upsertMsReceipt,
  SettingKey,
  now,
} from '@/lib/db'
import { MoyskladClient, MoyskladError } from './client'
import { parseMsMoment, type MsRetailDemand } from './types'

/** Сколько часов истории тянуть при первом запуске. */
const INITIAL_LOOKBACK_HOURS = 6

/** Ключ настройки, где храним курсор поллинга. */
const LAST_SYNC_KEY = 'moysklad.last_sync_epoch_sec' as const

export interface PollerStatus {
  running: boolean
  lastTickAt: number | null
  lastSuccessAt: number | null
  lastError: string | null
  lastFetchedCount: number
  intervalSec: number
}

export interface PollerOptions {
  /** Колбэк уведомления о тике (для UI). */
  onTick?: (status: PollerStatus) => void
}

export class MoyskladPoller {
  private timer: number | null = null
  private status: PollerStatus = {
    running: false,
    lastTickAt: null,
    lastSuccessAt: null,
    lastError: null,
    lastFetchedCount: 0,
    intervalSec: 30,
  }

  constructor(private readonly opts: PollerOptions = {}) {}

  getStatus(): PollerStatus {
    return { ...this.status }
  }

  async start(): Promise<void> {
    if (this.status.running) return
    this.status.running = true

    // Один тик сразу, чтобы не ждать interval-секунд при старте.
    await this.tick()

    const intervalSec = await this.readIntervalSec()
    this.status.intervalSec = intervalSec
    this.timer = setInterval(() => {
      void this.tick()
    }, intervalSec * 1000) as unknown as number
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.status.running = false
    this.notify()
  }

  private async readIntervalSec(): Promise<number> {
    const v = await getSetting(SettingKey.MoyskladPollIntervalSec)
    const n = v ? Number.parseInt(v, 10) : 30
    return Number.isFinite(n) && n >= 5 ? n : 30
  }

  private notify(): void {
    this.opts.onTick?.(this.getStatus())
  }

  private async tick(): Promise<void> {
    this.status.lastTickAt = now()

    try {
      // Приоритет: новый Basic-флоу, fallback на старый Bearer-токен.
      const basic = await getSetting(SettingKey.MoyskladCredentials)
      const token = basic ? null : await getSetting(SettingKey.MoyskladToken)
      if (!basic && !token) {
        this.status.lastError = 'Войдите в МойСклад в Настройках'
        this.notify()
        return
      }

      const lastSyncStr = await getSetting(LAST_SYNC_KEY as never)
      const lastSync = lastSyncStr
        ? Number.parseInt(lastSyncStr, 10)
        : now() - INITIAL_LOOKBACK_HOURS * 3600

      const client = new MoyskladClient(
        basic ? { basic } : { token: token! },
      )
      const items = await client.listRecentRetailDemands(lastSync, 200)

      for (const item of items) {
        await this.persist(item)
      }

      // Курсор сдвигаем на момент самой свежей записи (плюс 1 секунда),
      // чтобы не получать одну и ту же дважды.
      if (items.length > 0) {
        const latest = items.reduce((acc, it) => {
          const t = parseMsMoment(it.updated)
          return t > acc ? t : acc
        }, lastSync)
        await setSetting(LAST_SYNC_KEY as never, String(latest + 1))
      }

      this.status.lastSuccessAt = now()
      this.status.lastFetchedCount = items.length
      this.status.lastError = null
    } catch (err) {
      this.status.lastError =
        err instanceof MoyskladError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
    } finally {
      this.notify()
    }
  }

  private async persist(rd: MsRetailDemand): Promise<void> {
    await upsertMsReceipt({
      ms_id: rd.id,
      ms_name: rd.name ?? null,
      ms_moment: parseMsMoment(rd.moment),
      ms_sum_tiyin: rd.sum,
      raw_json: JSON.stringify(rd),
      fetched_at: now(),
    })
  }
}

/** Глобальный синглтон поллера на жизнь приложения. */
let singleton: MoyskladPoller | null = null

export function getPoller(opts: PollerOptions = {}): MoyskladPoller {
  if (!singleton) singleton = new MoyskladPoller(opts)
  return singleton
}
