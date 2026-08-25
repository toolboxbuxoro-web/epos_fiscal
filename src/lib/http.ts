/**
 * Сетевые вызовы с таймаутом.
 *
 * Зачем отдельный модуль: `fetch` без таймаута висит СКОЛЬКО УГОДНО. Это не
 * теория — из-за этого магазин Хонабод не отправил на сервер ни одного чека
 * за три месяца. У флашера продаж стоит guard `inFlight` (чтобы два тика не
 * слали один батч дважды), и зависший POST его залипал навсегда: промис не
 * завершался, guard не снимался, каждый следующий тик возвращал ту же
 * зависшую промису. Ни ошибки, ни ретрая, ни строчки в логах — просто тишина.
 *
 * Таймаут превращает «висит вечно» в «упало и повторим через минуту».
 *
 * `fetch` берём из `@tauri-apps/plugin-http` — как во всём остальном коде.
 * Браузерный fetch в webview пошёл бы мимо Rust-слоя и упёрся в CORS. Плагин
 * (v2.5.8) честно поддерживает `AbortSignal`: по abort зовёт
 * `plugin:http|fetch_cancel`, то есть запрос реально обрывается, а не просто
 * отпускается вызывающий.
 */

import { fetch } from '@tauri-apps/plugin-http'

/** Ошибка вылета по таймауту — отличима от сетевой, чтобы вызывающий мог её узнать. */
export class RequestTimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
  ) {
    super(`${label}: нет ответа за ${Math.round(timeoutMs / 1000)} сек`)
    this.name = 'RequestTimeoutError'
  }
}

/**
 * `fetch` с жёстким потолком по времени.
 *
 * `label` попадает в текст ошибки — по логу должно быть понятно, какой
 * именно запрос отвалился, без раскопок стека.
 *
 * Если вызывающий передал свой `signal` — уважаем оба: отмена приходит и по
 * таймауту, и снаружи.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  const external = init.signal
  const onExternalAbort = () => controller.abort()
  if (external) {
    if (external.aborted) controller.abort()
    else external.addEventListener('abort', onExternalAbort, { once: true })
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (e) {
    // Отличаем «мы сами прервали по таймауту» от «сеть отвалилась»:
    // внешняя отмена пробрасывается как есть.
    if (controller.signal.aborted && !(external && external.aborted)) {
      throw new RequestTimeoutError(label, timeoutMs)
    }
    throw e
  } finally {
    clearTimeout(timer)
    if (external) external.removeEventListener('abort', onExternalAbort)
  }
}
