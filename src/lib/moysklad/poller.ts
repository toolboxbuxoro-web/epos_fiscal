import {
  getSetting,
  setSetting,
  upsertMsReceipt,
  SettingKey,
  now,
  type MsReceiptStatus,
} from '@/lib/db'
import { log } from '@/lib/log'
import { MoyskladClient, MoyskladError } from './client'
import { parseMsMoment, type MsRetailDemand } from './types'
import { loadCurrencies, verifyReceiptCurrency } from './currency-guard'

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
  /**
   * Подряд-ошибки опроса. В телеметрию (log.error) уходит только ПЕРВАЯ
   * ошибка серии — сетевой обрыв на 3 минуты иначе давал 6-12 одинаковых
   * error-записей на сервер. Остальные — log.warn (остаются локально).
   */
  private consecutiveErrors = 0
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

  /**
   * Принудительно выполнить один опрос МойСклад сейчас, не дожидаясь
   * следующего тика по таймеру. Используется кнопкой «Обновить» в Кассе.
   * Обычный interval-таймер при этом не сбрасывается — просто внеплановый тик.
   */
  async pollNow(): Promise<void> {
    await this.tick()
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
      // Фильтруем по выбранной точке продаж — иначе в multi-shop сценарии
      // программа в магазине №1 увидела бы чеки магазина №2 и попыталась
      // фискализировать их через свою USB-карту.
      const retailStoreId = await getSetting(SettingKey.MoyskladRetailStoreId)
      const items = await client.listRecentRetailDemands(
        lastSync,
        retailStoreId || null,
        200,
      )

      for (const item of items) {
        await this.persist(item, client)
      }

      // Курсор сдвигаем на момент самой свежей записи (плюс 1 секунда),
      // чтобы не получать одну и ту же дважды.
      if (items.length > 0) {
        const latest = items.reduce((acc, it) => {
          const t = parseMsMoment(it.updated)
          return t > acc ? t : acc
        }, lastSync)
        await setSetting(LAST_SYNC_KEY as never, String(latest + 1))
        await log.info(
          'poller',
          `Получено ${items.length} новых/изменённых чеков из МойСклад`,
          { count: items.length, names: items.map((i) => i.name).slice(0, 10) },
        )
      } else {
        await log.debug('poller', 'Опрос завершён, новых чеков нет')
      }

      this.status.lastSuccessAt = now()
      this.status.lastFetchedCount = items.length
      this.status.lastError = null
      this.consecutiveErrors = 0
    } catch (err) {
      this.status.lastError =
        err instanceof MoyskladError
          ? `${err.status}: ${err.message}`
          : err instanceof Error
            ? err.message
            : String(err)
      this.consecutiveErrors += 1
      const logFn = this.consecutiveErrors === 1 ? log.error : log.warn
      await logFn('poller', 'Ошибка опроса МойСклад', {
        error: this.status.lastError,
        status: err instanceof MoyskladError ? err.status : undefined,
        consecutive: this.consecutiveErrors,
      })
    } finally {
      this.notify()
    }
  }

  private async persist(rd: MsRetailDemand, client: MoyskladClient): Promise<void> {
    // Чек на 0 сум (вся покупка за бонусные баллы / 100% скидка) —
    // ОФД физически не примет товар на 0 сум. Сразу помечаем такой
    // чек как not_required чтобы он не висел в списке pending и не
    // тревожил кассира «нужно фискализировать».
    let status: MsReceiptStatus | undefined = rd.sum <= 0 ? 'not_required' : undefined

    // Валюта. Пока учёт в сумах, проверка молчит и ничего не меняет.
    // Если базовая валюта аккаунта сменится, суммы начнут приходить в других
    // минорных единицах — и тогда чек лучше не фискализировать вовсе, чем
    // отправить в ОФД сумму, заниженную в тысячи раз.
    if (status === undefined) {
      try {
        const currencies = await loadCurrencies(client)
        const verdict = verifyReceiptCurrency(rd, currencies)
        if (!verdict.ok) {
          status = 'currency_mismatch' as const
          console.error(`[poller] чек ${rd.name ?? rd.id} не фискализируется: ${verdict.reason}`)
        }
      } catch (err) {
        // Справочник недоступен — НЕ блокируем. Касса не должна вставать
        // из-за недоступности справочника: это остановило бы торговлю ради
        // защиты от события, которое ещё не наступило.
        console.warn('[poller] валюту проверить не удалось:', err)
      }
    }
    await upsertMsReceipt({
      ms_id: rd.id,
      ms_name: rd.name ?? null,
      ms_moment: parseMsMoment(rd.moment),
      ms_sum_tiyin: rd.sum,
      raw_json: JSON.stringify(rd),
      fetched_at: now(),
      status,
    })
  }
}

/** Глобальный синглтон поллера на жизнь приложения. */
let singleton: MoyskladPoller | null = null

export function getPoller(opts: PollerOptions = {}): MoyskladPoller {
  if (!singleton) singleton = new MoyskladPoller(opts)
  return singleton
}
