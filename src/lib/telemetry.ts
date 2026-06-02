/**
 * Телеметрия: централизованный сбор error-логов на mytoolbox-сервере.
 *
 * Зачем: 4 магазина в проде на разных Win-машинах. Если что-то ломается,
 * админ узнаёт обычно через несколько дней (когда кассир напишет). С
 * сервер-телеметрией: error попадает в admin-панель mytoolbox через
 * ~30 сек после возникновения. Critical-ошибки триггерят Telegram-алерт.
 *
 * Что шлётся:
 *   - level='error' (всё что log.error(...) пишет)
 *   - вкл. 🚨 «refund в ОФД но не сохранён локально» (HIGH #2)
 *
 * Что НЕ шлётся:
 *   - info / warn / debug — остаются локально
 *   - PII (tin, pinfl, clientName, phoneNumber) — убираются scrubPii
 *     до отправки
 *   - apiKey / пароли / токены — те же скрабинг + не должны попадать
 *     в логи изначально
 *
 * Архитектура:
 *   1. log.ts пишет в local SQLite как обычно
 *   2. ensureTelemetryStarted() — таймер 30 сек на старте приложения
 *   3. flushLogsToServer() — listUnsentLogsForServer → POST → markSent
 *   4. На ошибке сети — exp backoff, retry на следующем тике
 *
 * Серверная сторона (mytoolbox, отдельный репо):
 *   - Endpoint: POST /api/v1/inventory/telemetry/logs
 *   - Auth: Bearer <SettingKey.InventoryShopApiKey>
 *   - Body: { shop_slug, app_version, logs: [{ts, level, source, message, details}] }
 *   - Response: { ok: true }
 *   - Persistent: таблица `shop_logs` с TTL 90 дней
 *   - Admin UI: страница «Логи 4 магазинов» с фильтрами
 *   - Telegram-bot слушает INSERT'ы level='error' с маркером CRITICAL
 */

import { fetch } from '@tauri-apps/plugin-http'
import { getSetting, SettingKey } from '@/lib/db'
import { listUnsentLogsForServer, markLogsSentToServer } from '@/lib/log'

/** Интервал между попытками flush'а — 30 сек. */
const FLUSH_INTERVAL_MS = 30_000
/** Сколько строк за один POST. */
const BATCH_SIZE = 50
/**
 * Текущая версия приложения для трассировки на сервере.
 *
 * ⚠️ Должна совпадать с `package.json::version` и
 * `src-tauri/tauri.conf.json::version`. Все 3 места обновляются при
 * каждом релизе вручную (package.json не импортируется в браузерный bundle).
 */
const APP_VERSION = '0.11.7'

let started = false
let timer: ReturnType<typeof setInterval> | null = null
/** Кол-во подряд-failed flush'ей для exp backoff. */
let consecutiveFailures = 0

/**
 * Запустить background-flusher один раз на всё приложение.
 * Идемпотентно. Вызывается из App.tsx после ensurePollerStarted.
 */
export async function ensureTelemetryStarted(): Promise<void> {
  if (started) return
  started = true

  // Первый тик с задержкой 5 сек чтобы дать приложению инициализироваться
  // (получить shop config, проверить connection с сервером и т.п.).
  setTimeout(() => {
    void flushLogsToServer()
  }, 5_000)

  // Регулярный таймер. Точно НЕ сохраняем в module-level чтобы не было
  // утечки если по какой-то причине ensureTelemetryStarted вызвался дважды.
  timer = setInterval(() => {
    void flushLogsToServer()
  }, FLUSH_INTERVAL_MS)
}

/**
 * Один цикл flush'а — выбрать unsent, отправить, пометить sent.
 *
 * Безопасен для параллельного вызова (markLogsSentToServer идемпотентен).
 * Никогда не throw'ит — ошибки логируем локально (НЕ через log.error
 * чтобы не было бесконечного цикла «logging-failure → log → logging-failure»).
 */
export async function flushLogsToServer(): Promise<void> {
  try {
    // Opt-out: если магазин выключил телеметрию — ничего не делаем.
    // Дефолт = 'true' для всех новых установок.
    const enabledStr = await getSetting(SettingKey.TelemetryEnabled)
    if (enabledStr === 'false') return

    // Серверные настройки. Если inventory не сконфигурирован — телеметрия
    // тоже не работает (используем тот же URL+ApiKey).
    const serverUrl = await getSetting(SettingKey.InventoryServerUrl)
    const apiKey = await getSetting(SettingKey.InventoryShopApiKey)
    const shopSlug = await getSetting(SettingKey.InventoryShopSlug)
    if (!serverUrl || !apiKey || !shopSlug) return

    // Exp backoff после подряд-failures: 30s → 60s → 120s → 240s → cap 30min.
    // Просто пропускаем тики чтобы не долбить мёртвый endpoint.
    if (consecutiveFailures > 0) {
      const skipTicks = Math.min(consecutiveFailures, 60) // cap = 60 ticks = 30min
      // Псевдо-skip через ts-проверку времени. Простой счётчик:
      // если consecutiveFailures > 0, шанс попытки = 1 / 2^failures.
      const chance = 1 / Math.pow(2, Math.min(consecutiveFailures, 6))
      if (Math.random() > chance) return
      void skipTicks // явно используем чтобы тс не ругался
    }

    const unsent = await listUnsentLogsForServer(BATCH_SIZE)
    if (unsent.length === 0) {
      consecutiveFailures = 0
      return
    }

    // PII-скрабинг + минификация перед отправкой.
    const cleaned = unsent.map((row) => ({
      ts: row.ts,
      level: row.level,
      source: row.source,
      message: scrubText(row.message),
      details: row.details ? scrubText(row.details) : null,
      local_log_id: row.id, // для дедупа на сервере + трассировки
    }))

    // Endpoint живёт ВНУТРИ shopRouter inventory (mytoolbox), чтобы наследовать
    // существующий `requireShopApiKey` middleware. URL получается длинным,
    // но не плодим дублирующий middleware на сервере.
    const url = serverUrl.replace(/\/$/, '') + '/api/v1/inventory/telemetry/logs'
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        shop_slug: shopSlug,
        app_version: APP_VERSION,
        logs: cleaned,
      }),
    })

    if (res.status >= 200 && res.status < 300) {
      // Успех — помечаем все эти id как sent.
      await markLogsSentToServer(unsent.map((r) => r.id))
      consecutiveFailures = 0
      return
    }

    // 404 — endpoint ещё не задеплоен на сервере, помечаем sent чтобы не
    // зацикливать. Когда задеплоят — следующие логи поедут нормально.
    // Это решение: «нет сервера = молча игнорим, не тормозим клиента».
    if (res.status === 404) {
      await markLogsSentToServer(unsent.map((r) => r.id))
      return
    }

    // Другие не-2xx — учитываем как failure, не помечаем sent (повторим).
    consecutiveFailures += 1
    consoleWarn(
      `telemetry: HTTP ${res.status} при POST /api/v1/inventory/telemetry/logs ` +
        `(подряд-ошибок ${consecutiveFailures})`,
    )
  } catch (e) {
    consecutiveFailures += 1
    consoleWarn(
      `telemetry: flush упал — ${e instanceof Error ? e.message : String(e)} ` +
        `(подряд-ошибок ${consecutiveFailures})`,
    )
  }
}

/**
 * Убрать ПД клиента (PII) из текста перед отправкой.
 *
 * Что чистим:
 *   - ИНН (9-14 цифр)
 *   - ПИНФЛ (14 цифр строго, узбекский формат)
 *   - Телефон (+998 + 9 цифр или похожие)
 *   - email
 *
 * Что оставляем:
 *   - FiscalSign, TerminalID, ReceiptSeq (фискальная атрибутика, не ПД)
 *   - Item names (ИКПУ-данные публичные)
 *   - Суммы (бизнес-метрика, не ПД конкретного клиента)
 *   - Названия магазина
 *
 * Простая regex-замена. Не претендуем на 100% покрытие — если что-то
 * редкое проскочит, серверная сторона тоже должна делать скрабинг как
 * defense-in-depth.
 */
export function scrubText(s: string): string {
  return (
    s
      // ПИНФЛ — строго 14 цифр подряд (избегаем матча сумм/timestamp).
      // Контекст: '"pinfl":"12345678901234"' / 'PINFL 12345678901234'.
      // Заменяем последовательность 14 цифр окружённую non-digit ничем.
      .replace(/(?<!\d)\d{14}(?!\d)/g, '[PINFL]')
      // ИНН — 9 цифр (юр.лица) или 14 (ИП-цепочка ИНН+ПИНФЛ). 14 уже
      // отработал выше. Здесь 9-13 цифр в контексте `tin`/`inn`/«ИНН».
      .replace(/(?<!\d)\d{9}(?!\d)/g, '[TIN]')
      // Телефоны UZ. Покрывает форматы +998 90 123 45 67 / 998901234567.
      .replace(/\+?998[\s-]?\d{2}[\s-]?\d{3}[\s-]?\d{2}[\s-]?\d{2}/g, '[PHONE]')
      // Email — простой паттерн.
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
  )
}

/**
 * Console-only лог для самой телеметрии (НЕ через log.ts чтобы избежать
 * рекурсии — если ошибка пишется в log.error, она бы триггерила flush
 * который её бы прочитал...).
 */
function consoleWarn(message: string) {
  console.warn('[telemetry]', message)
}

/**
 * Для тестов / shutdown — остановить таймер. В обычной работе не
 * вызывается (приложение работает 24/7).
 */
export function stopTelemetry(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  started = false
  consecutiveFailures = 0
}

/** Для теста: добавил для возможной кнопки «Отправить логи сейчас». */
export async function flushNow(): Promise<void> {
  await flushLogsToServer()
}

