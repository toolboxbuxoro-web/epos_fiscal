/**
 * Aggregated health-check для UI status-panel.
 *
 * Подписывается на:
 *   - poller-runtime (МойСклад)
 *   - shift-runtime (открытая смена)
 *   - inventory SSE-status (если remote вкл)
 *   - последние ERROR-логи (за 5 минут)
 *
 * Возвращает массив `SystemIssue` для отрисовки в SystemStatusPanel.
 *
 * Хук обновляется когда:
 *   - poller тикает (через subscribePollerStatus)
 *   - shift-runtime тикает (через listeners)
 *   - SSE меняет состояние (через poll-getter раз в 5с)
 *   - logs меняются (raw poll каждые 30с)
 *
 * Все проверки клиентские. Никаких сетевых запросов из самого хука.
 */

import { useEffect, useState } from 'react'
import { listLogs, type LogRow } from '@/lib/log'
import { getInventorySseStatus } from '@/lib/inventory'
import { getSetting, SettingKey } from '@/lib/db'
import { subscribePollerStatus } from '@/lib/poller-runtime'
import type { PollerStatus } from '@/lib/moysklad/poller'
import { getShiftStatus, type ShiftStatus } from '@/lib/moysklad'

export type IssueSeverity = 'warning' | 'error'

export interface SystemIssue {
  /** Стабильный ID — для key и dedup. */
  id: string
  severity: IssueSeverity
  source: 'moysklad' | 'inventory' | 'shift' | 'logs' | 'fiscalize' | 'printer'
  title: string
  detail?: string
  /** Куда вести при клике — путь внутри SPA или anchor. */
  action?: { label: string; href: string }
}

export interface SystemStatusSummary {
  issues: SystemIssue[]
  hasErrors: boolean
  hasWarnings: boolean
  ok: boolean
}

const LOG_WINDOW_SEC = 5 * 60 // последние 5 минут

async function collectIssues(): Promise<SystemIssue[]> {
  const issues: SystemIssue[] = []

  // ── Recent error logs ───────────────────────────────────────────────
  try {
    const since = Math.floor(Date.now() / 1000) - LOG_WINDOW_SEC
    const errs = await listLogs({ level: 'error', since, limit: 5 })
    if (errs.length > 0 && errs[0]) {
      issues.push({
        id: `logs.errors`,
        severity: 'error',
        source: 'logs',
        title: `${errs.length} ${errs.length === 1 ? 'ошибка' : 'ошибок'} в логах за 5 мин`,
        detail: errs[0].message.slice(0, 100),
        action: { label: 'Открыть логи', href: '/logs' },
      })
    }
  } catch {
    // тихо — лог недоступен, не критично
  }

  return issues
}

/** Проверки которые есть только во время рендера (через хуки). */
function buildIssuesFromState(opts: {
  poller: PollerStatus | null
  shift: ShiftStatus
  sseStatus: 'connected' | 'disconnected' | 'connecting' | 'idle'
  remoteEnabled: boolean
  testMode: boolean
}): SystemIssue[] {
  const issues: SystemIssue[] = []

  // ── Poller ────────────────────────────────────────────────────────
  if (opts.poller) {
    if (opts.poller.lastError) {
      issues.push({
        id: 'moysklad.poller-error',
        severity: 'error',
        source: 'moysklad',
        title: 'МойСклад: ошибка опроса',
        detail: opts.poller.lastError.slice(0, 120),
        action: { label: 'Проверить настройки', href: '/settings' },
      })
    } else if (!opts.poller.running && opts.poller.lastTickAt) {
      issues.push({
        id: 'moysklad.poller-stopped',
        severity: 'warning',
        source: 'moysklad',
        title: 'МойСклад: поллер остановлен',
        action: { label: 'Открыть Кассу', href: '/' },
      })
    }
  }

  // ── Shift ─────────────────────────────────────────────────────────
  if (opts.shift.ready && !opts.shift.shiftId) {
    issues.push({
      id: 'shift.closed',
      severity: 'warning',
      source: 'shift',
      title: 'Смена закрыта в МойСклад',
      detail: 'Откройте смену в МС-кассе чтобы пробивать чеки',
    })
  }
  if (opts.shift.lastError) {
    issues.push({
      id: 'shift.error',
      severity: 'warning',
      source: 'shift',
      title: 'Не удалось получить статус смены',
      detail: opts.shift.lastError.slice(0, 120),
    })
  }

  // ── Inventory SSE ─────────────────────────────────────────────────
  if (opts.remoteEnabled) {
    if (opts.sseStatus === 'disconnected') {
      issues.push({
        id: 'inventory.sse-down',
        severity: 'warning',
        source: 'inventory',
        title: 'Inventory сервер: нет связи',
        detail: 'Live-обновления остатков не приходят. Polling-fallback каждые 5 мин.',
        action: { label: 'Настройки сервера', href: '/settings' },
      })
    } else if (opts.sseStatus === 'idle' && opts.remoteEnabled) {
      issues.push({
        id: 'inventory.sse-idle',
        severity: 'warning',
        source: 'inventory',
        title: 'Inventory: SSE не запущен',
        action: { label: 'Настройки сервера', href: '/settings' },
      })
    }
  }

  // Test mode — это не «ошибка», но видеть нужно. Включаем как warning
  // чтобы отображалось в Status panel.
  if (opts.testMode) {
    issues.push({
      id: 'app.test-mode',
      severity: 'warning',
      source: 'fiscalize',
      title: 'Тестовый режим включён',
      detail: 'Фискализация имитируется, в ОФД ничего не уходит',
      action: { label: 'Выключить в Настройках', href: '/settings' },
    })
  }

  return issues
}

/**
 * Главный хук. Возвращает агрегированный статус системы для отрисовки
 * в SystemStatusPanel.
 */
export function useSystemStatus(): SystemStatusSummary {
  const [poller, setPoller] = useState<PollerStatus | null>(null)
  const [shift, setShift] = useState<ShiftStatus>(getShiftStatus())
  const [sseStatus, setSseStatus] = useState<
    'connected' | 'disconnected' | 'connecting' | 'idle'
  >('idle')
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [testMode, setTestMode] = useState(false)
  const [logIssues, setLogIssues] = useState<SystemIssue[]>([])

  // Poller
  useEffect(() => {
    const unsub = subscribePollerStatus(setPoller)
    return () => unsub()
  }, [])

  // Shift — опрашиваем cached state раз в 2 секунды (дёшево)
  useEffect(() => {
    const t = setInterval(() => setShift(getShiftStatus()), 2000)
    return () => clearInterval(t)
  }, [])

  // SSE + settings (testMode, remoteEnabled) — раз в 3 секунды
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const [tm, re] = await Promise.all([
        getSetting(SettingKey.TestMode),
        getSetting(SettingKey.InventoryRemoteEnabled),
      ])
      if (cancelled) return
      setTestMode(tm === 'true')
      setRemoteEnabled(re === 'true')
      setSseStatus(getInventorySseStatus())
    }
    void refresh()
    const t = setInterval(refresh, 3000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  // Logs — раз в 30 секунд
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const issues = await collectIssues()
      if (!cancelled) setLogIssues(issues)
    }
    void refresh()
    const t = setInterval(refresh, 30_000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  const stateIssues = buildIssuesFromState({
    poller,
    shift,
    sseStatus,
    remoteEnabled,
    testMode,
  })
  const issues = [...stateIssues, ...logIssues]

  return {
    issues,
    hasErrors: issues.some((i) => i.severity === 'error'),
    hasWarnings: issues.some((i) => i.severity === 'warning'),
    ok: issues.length === 0,
  }
}

// ── log.listLogs helper signature shim ─────────────────────────────────
// listLogs принимает { level?, since?, limit? } — наш log.ts уже поддерживает.
// Если в будущем сигнатура изменится — поправь buildIssuesFromState.
export type _LogRowAlias = LogRow
