/**
 * Server-Sent Events подписка на /api/v1/inventory/events.
 *
 * Получаем live-уведомления когда другие магазины списали/освободили товары.
 * Обновляем локальный кэш `esf_items` чтобы matcher видел свежие остатки.
 *
 * Если конект отвалился — экспоненциальный backoff с reconnect. Параллельно
 * `polling`-fallback в `sync.ts` догонит пропущенное через GET /items?since=.
 *
 * EventSource не доступен в Tauri (нет CORS-friendly реализации),
 * поэтому делаем вручную через fetch + ReadableStream. По стандарту
 * SSE — простой текстовый формат:
 *   event: <name>\n
 *   data: <json>\n
 *   \n
 *   : <comment>\n  ← heartbeat, игнорируем
 */

import { fetch } from '@tauri-apps/plugin-http'
import { log } from '@/lib/log'

export type SseEvent = { type: string; data: unknown }
export type SseHandler = (e: SseEvent) => void

interface SubscribeOptions {
  serverUrl: string
  apiKey: string
  onEvent: SseHandler
  /** Опционально: вызывается при connect/disconnect для UI. */
  onStatusChange?: (status: 'connected' | 'disconnected' | 'connecting') => void
  /** AbortSignal — позволяет извне закрыть подписку. */
  signal?: AbortSignal
}

const RETRY_BASE_MS = 2000
const RETRY_MAX_MS = 60000

// Минимальный интервал между forceFull-sync при реконнектах — 60 сек.
// Если соединение флапает (handshake проходит, стрим сразу рвётся), backoff
// сбрасывается при каждом успешном handshake, и без этого guard'а forceFull
// запускался бы каждые ~2 сек бесконечно, создавая лавину GET /items запросов.
const RECONNECT_SYNC_MIN_INTERVAL_MS = 60_000
let lastReconnectSyncTs = 0

/**
 * Запустить SSE подписку. Возвращает функцию-стоп для отвязки.
 * Внутренний reconnect-loop работает пока stop() не вызван.
 */
export function subscribeToInventoryEvents(opts: SubscribeOptions): () => void {
  const controller = new AbortController()
  if (opts.signal) {
    opts.signal.addEventListener('abort', () => controller.abort())
  }

  let retryMs = RETRY_BASE_MS
  let stopped = false
  // Флаг: первый коннект или реконнект после разрыва.
  // На первом коннекте bootstrap forceFull уже был сделан в App.tsx,
  // поэтому лишний sync не нужен. При реконнекте — дозагружаем пропущенное.
  let hadDisconnect = false

  const loop = async () => {
    while (!stopped && !controller.signal.aborted) {
      opts.onStatusChange?.('connecting')
      try {
        const url = `${opts.serverUrl.replace(/\/$/, '')}/api/v1/inventory/events`
        const res = await fetch(url, {
          headers: {
            Authorization: `Bearer ${opts.apiKey}`,
            Accept: 'text/event-stream',
            'Cache-Control': 'no-cache',
            // ВАЖНО: явно отключаем сжатие. Tauri http plugin (reqwest)
            // по дефолту шлёт `Accept-Encoding: gzip` (фича включена в
            // Cargo.toml для МойСклад API) и пытается декомпрессить ответ.
            // SSE — это потоковый event-stream без сжатия; gzip-декодер
            // падает с «error decoding response body» на первом chunk'е.
            // `identity` = «никаких преобразований», reqwest отдаст body
            // как есть.
            'Accept-Encoding': 'identity',
          },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`SSE handshake failed: HTTP ${res.status}`)
        }
        opts.onStatusChange?.('connected')
        retryMs = RETRY_BASE_MS // reset backoff после успешного подключения

        // При реконнекте после разрыва — дозагружаем то что могло прийти
        // пока SSE-канал был оборван. Используем dynamic import чтобы
        // избежать циклической зависимости sync.ts ↔ sse.ts.
        // Guard: не запускаем forceFull чаще раза в RECONNECT_SYNC_MIN_INTERVAL_MS.
        // При флапающем соединении backoff сбрасывается после каждого успешного
        // handshake, без guard'а это приводило бы к forceFull каждые ~2 сек.
        if (hadDisconnect) {
          const now = Date.now()
          if (now - lastReconnectSyncTs >= RECONNECT_SYNC_MIN_INTERVAL_MS) {
            lastReconnectSyncTs = now
            void import('./sync')
              .then(({ syncFromServer }) =>
                syncFromServer({ forceFull: true }),
              )
              .catch((e: unknown) => {
                log
                  .warn(
                    'inventory.sse',
                    `reconnect forceFull-sync упал: ${e instanceof Error ? e.message : String(e)}`,
                  )
                  .catch(() => {})
              })
          }
        }

        // Читаем поток построчно через ReadableStream API.
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        let curEvent = 'message'
        let curData = ''

        const dispatch = () => {
          if (!curData) {
            curEvent = 'message'
            return
          }
          try {
            const data = JSON.parse(curData)
            opts.onEvent({ type: curEvent, data })
          } catch (e) {
            // не-JSON событие — отдадим как text
            opts.onEvent({ type: curEvent, data: curData })
          }
          curEvent = 'message'
          curData = ''
        }

        while (!stopped && !controller.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true })
          let nlIdx
          while ((nlIdx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nlIdx).replace(/\r$/, '')
            buf = buf.slice(nlIdx + 1)
            if (line === '') {
              // конец события — диспатчим
              dispatch()
            } else if (line.startsWith(':')) {
              // comment / heartbeat — пропускаем
            } else if (line.startsWith('event:')) {
              curEvent = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
              const v = line.slice(5).trim()
              curData = curData ? curData + '\n' + v : v
            }
            // прочие поля (id:, retry:) игнорируем
          }
        }
      } catch (e) {
        // Любая ошибка → backoff + retry. Если это abort — выходим.
        if (controller.signal.aborted || stopped) break
        const msg = e instanceof Error ? e.message : String(e)
        log.warn('inventory.sse', `SSE disconnected: ${msg}; retry in ${retryMs}ms`).catch(
          () => {},
        )
      }
      opts.onStatusChange?.('disconnected')
      if (stopped || controller.signal.aborted) break

      // Помечаем что был разрыв — следующий успешный коннект запустит
      // forceFull sync для дозагрузки пропущенных событий.
      hadDisconnect = true

      // Wait + exponential backoff (с jitter).
      const wait = retryMs + Math.floor(Math.random() * 500)
      retryMs = Math.min(retryMs * 2, RETRY_MAX_MS)
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }

  // Запускаем без await — pollerLoop живёт в фоне до stop().
  loop()

  return () => {
    stopped = true
    controller.abort()
  }
}
