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
          },
          signal: controller.signal,
        })
        if (!res.ok || !res.body) {
          throw new Error(`SSE handshake failed: HTTP ${res.status}`)
        }
        opts.onStatusChange?.('connected')
        retryMs = RETRY_BASE_MS // reset backoff после успешного подключения

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
