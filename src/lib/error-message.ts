/**
 * Перевод сырых технических ошибок (Postgres, JSON-RPC, HTTP) в понятные
 * для кассира сообщения.
 *
 * Зачем: до этого `setError(e instanceof Error ? e.message : String(e))`
 * показывал сырьём «new row for relation "inv_items" violates check
 * constraint "inv_items_check"», «illegal argument: VATPercent: cannot
 * parse», «HTTP 500: PostgresError: duplicate key» и т.п. Кассир видит
 * страшный SQL/RPC текст — не понятно что делать.
 *
 * Использование в catch:
 *   } catch (e) {
 *     setError(formatErrorForUser(e))
 *     await log.error('something', 'context', { error: ..., raw: ... })
 *   }
 *
 * Типизированные ошибки (`AlreadyFiscalizedError`, `ShiftNotOpenError`,
 * `InventoryConflictError`, `InventoryStaleError`, `RefundAlreadyExistsError`,
 * `InventoryNotConfiguredError`) уже имеют человекочитаемые messages —
 * их catch их обрабатывает специальным флоу и сюда не доходит. Сюда
 * приходят НЕ-типизированные / транспортные ошибки.
 */

import { JsonRpcEposError } from '@/lib/epos/jsonrpc-client'
import { InventoryServerError } from '@/lib/inventory'
import { MoyskladError } from '@/lib/moysklad'

/**
 * Превратить любую ошибку в строку для UI.
 *
 * Порядок проверки:
 *   1. Типизированные транспортные ошибки → human-friendly по полям
 *      (code/status)
 *   2. Pattern-matching по message (Postgres constraint, SQLite busy,
 *      network, FK violation)
 *   3. Fallback: усечённый raw + хвост «См. Логи»
 */
export function formatErrorForUser(e: unknown): string {
  if (e instanceof JsonRpcEposError) {
    return formatEposError(e)
  }
  if (e instanceof InventoryServerError) {
    return formatInventoryServerError(e)
  }
  if (e instanceof MoyskladError) {
    return formatMoyskladError(e)
  }

  const raw = e instanceof Error ? e.message : String(e)

  // Postgres constraint violations — сервер не маскирует, текст SQL утечкой
  if (/inv_items_check|violates check constraint/i.test(raw)) {
    return (
      'Остатки на сервере изменились. Обновите справочник в разделе ' +
      '«Справочник» и попробуйте снова.'
    )
  }
  if (/unique constraint|UNIQUE constraint failed/i.test(raw)) {
    return (
      'Дубликат записи в БД (возможно операция уже выполнена). ' +
      'Обновите страницу и проверьте. См. Логи для деталей.'
    )
  }
  if (/FOREIGN KEY constraint failed|foreign key/i.test(raw)) {
    return (
      'Связь данных нарушена (запись зависит от удалённой). ' +
      'Обратитесь в саппорт. См. Логи.'
    )
  }
  if (/SQLITE_BUSY|database is locked/i.test(raw)) {
    return (
      'Локальная БД временно занята. Подождите секунду и попробуйте снова.'
    )
  }
  if (/NOT NULL constraint failed/i.test(raw)) {
    return (
      'Не заполнены обязательные поля в БД. Обратитесь в саппорт. См. Логи.'
    )
  }

  // Сетевые / транспортные
  if (/fetch failed|network|ECONNREFUSED|ENOTFOUND|timeout|TLS handshake/i.test(raw)) {
    return (
      'Нет связи с сервером. Проверьте интернет и попробуйте снова. ' +
      'Если проблема не уходит — проверьте Настройки → Inventory.'
    )
  }

  // Communicator URL не отвечает (типичный текст reqwest)
  if (/Connection refused|tcp connect error|localhost.*3448/i.test(raw)) {
    return (
      'EPOS Communicator не отвечает. Проверьте что Cashdesk запущен ' +
      'на этой машине и USB-карта подключена.'
    )
  }

  // Fallback — усечённый raw чтобы хотя бы что-то техническое было видно
  const truncated = raw.length > 120 ? raw.slice(0, 120) + '…' : raw
  return `Техническая ошибка: ${truncated}. См. раздел «Логи» для деталей.`
}

function formatEposError(e: JsonRpcEposError): string {
  const code = e.code ?? 0
  // Известные коды Communicator. См. docs/external-apis/universal-communicator.md.
  switch (code) {
    case 36909:
      return 'Смена ККМ не открыта. Откройте смену в разделе «Смена».'
    case 36912:
      return (
        'Терминал не подключён. Проверьте USB-карту фискального модуля и ' +
        'перезапустите Cashdesk.'
      )
    case 36913:
      return 'ОФД недоступен. Проверьте интернет на машине с ФМ.'
    default:
      // Если code 0 — это «текстовая» ошибка без code из JSON-RPC, типа
      // illegal argument / cannot parse — обычно из-за плохого payload.
      // Показываем message коротко, не SQL/трейс.
      return (
        `EPOS Communicator: ${truncate(e.message, 80)}` +
        (code > 0 ? ` (код ${code})` : '') +
        '. См. Логи для деталей.'
      )
  }
}

function formatInventoryServerError(e: InventoryServerError): string {
  switch (e.status) {
    case 401:
    case 403:
      return (
        'API-ключ магазина не работает (' +
        e.status +
        '). Проверьте Настройки → Inventory или обратитесь к админу.'
      )
    case 404:
      return 'Сервер inventory: ресурс не найден (404). См. Логи.'
    case 409:
      // 409 уже обрабатывается через InventoryConflictError, но на всякий
      return 'Конфликт остатков. Обновите справочник и попробуйте снова.'
    case 500:
    case 502:
    case 503:
      return (
        `Сервер inventory недоступен (HTTP ${e.status}). ` +
        'Попробуйте через минуту. См. Логи.'
      )
    default:
      return (
        `Inventory сервер: ${truncate(e.message, 80)} ` +
        `(HTTP ${e.status}). См. Логи.`
      )
  }
}

function formatMoyskladError(e: MoyskladError): string {
  if (e.status === 401) {
    return 'Сессия МойСклад истекла. Войдите снова в Настройках.'
  }
  if (e.status === 403) {
    return 'МойСклад: нет прав. Проверьте права кассира в МойСклад-админке.'
  }
  if (e.status === 404) {
    return 'МойСклад: чек/документ не найден. Возможно удалён в МС.'
  }
  if (e.status >= 500) {
    return 'МойСклад сервер недоступен. Попробуйте позже. См. Логи.'
  }
  return `МойСклад: ${truncate(e.message, 80)} (HTTP ${e.status}). См. Логи.`
}

function truncate(s: string, n: number): string {
  if (!s) return ''
  return s.length > n ? s.slice(0, n) + '…' : s
}
