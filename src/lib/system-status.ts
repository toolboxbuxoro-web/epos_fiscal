/**
 * Aggregated health-check для UI status-panel.
 *
 * Подписывается на:
 *   - poller-runtime (МойСклад)
 *   - настройки отгрузок (выбраны ли склад и статус)
 *   - inventory SSE-status (если remote вкл)
 *   - последние ERROR-логи (за 5 минут)
 *
 * Возвращает массив `SystemIssue` для отрисовки в SystemStatusPanel.
 *
 * Хук обновляется когда:
 *   - poller тикает (через subscribePollerStatus)
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
import { getPospointHealth, type PospointHealth } from '@/lib/epos/pospoint-sync'
import type { PollerStatus } from '@/lib/moysklad/poller'

export type IssueSeverity = 'warning' | 'error'

export interface SystemIssue {
  /** Стабильный ID — для key и dedup. */
  id: string
  severity: IssueSeverity
  source: 'moysklad' | 'inventory' | 'logs' | 'fiscalize' | 'printer'
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

/** Одна проблема Pospoint для панели состояния — самая важная. */
function pospointIssue(pp: PospointHealth): SystemIssue | null {
  const settings = { label: 'Открыть Настройки', href: '/settings' }
  const err = (id: string, title: string, detail: string, withSettings = false): SystemIssue => ({
    id: `fiscalize.pospoint-${id}`,
    severity: 'error',
    source: 'fiscalize',
    title,
    detail,
    ...(withSettings ? { action: settings } : {}),
  })
  switch (pp.state) {
    case 'no-key':
      return err('no-key', 'Pospoint: не задан ключ кассы', 'Без ключа чеки не пробиваются', true)
    case 'test-key':
      return err('test-key', 'Pospoint: указан тестовый ключ', 'С ним чеки не фискализируются — вставьте ключ этой кассы', true)
    case 'bad-key':
      return err('bad-key', 'Pospoint не принял ключ кассы', 'Проверьте ключ в Настройках', true)
    case 'inactive':
      return err('inactive', 'Pospoint: касса не активна', 'Проверьте регистрацию и подписку или обратитесь в поддержку Pospoint')
    case 'fiscal-off':
      return err('fiscal-off', 'Pospoint: выключен фискальный режим', 'Включите его в настройках программы Pospoint')
    case 'demo-limit':
      return err('demo-limit', 'Pospoint: исчерпан лимит демо-режима', 'Обратитесь в Pospoint')
    case 'pos-auth':
      return err('pos-auth', 'Pospoint: касса не авторизована в ФМ', 'Обратитесь в поддержку Pospoint')
    case 'down':
      return err('down', 'Pospoint не отвечает', 'Откройте программу Pospoint, войдите и включите «Режим интеграции»')
    case 'fm-disconnected':
      return err('fm', 'Pospoint: фискальный модуль не подключён', 'Проверьте USB-ридер ФМ')
    default:
      break
  }
  if (pp.unsent > 0 && pp.unsentSince && Date.now() - pp.unsentSince > 2 * 3600 * 1000) {
    const day = Date.now() - pp.unsentSince > 24 * 3600 * 1000
    return {
      id: 'fiscalize.pospoint-unsent',
      severity: day ? 'error' : 'warning',
      source: 'fiscalize',
      title: `Pospoint: ${pp.unsent} чеков не ушло в ОФД`,
      detail: day
        ? 'Больше суток — проверьте интернет на кассе, иначе ФМ заблокирует продажи'
        : 'Проверьте интернет на кассе — Pospoint отправит их сам',
    }
  }
  return null
}

/** Проверки которые есть только во время рендера (через хуки). */
function buildIssuesFromState(opts: {
  poller: PollerStatus | null
  /** Выбраны ли склад и статус отгрузок. null — ещё не прочитали. */
  demandConfigured: boolean | null
  sseStatus: 'connected' | 'disconnected' | 'connecting' | 'idle'
  remoteEnabled: boolean
  testMode: boolean
  /** Состояние Pospoint; null — касса не на Pospoint. */
  pospoint?: PospointHealth | null
}): SystemIssue[] {
  const issues: SystemIssue[] = []

  // ── Настройка отгрузок ────────────────────────────────────────────
  // Пока склад и статус не выбраны, опрос стоит. Это не сбой связи, а
  // недоделанная настройка — показываем отдельно и с понятным действием,
  // а не как «ошибку опроса».
  if (opts.demandConfigured === false) {
    issues.push({
      id: 'moysklad.demand-config',
      severity: 'error',
      source: 'moysklad',
      title: 'Не выбраны склад и статус отгрузок',
      detail: 'Касса не видит отгрузки, пока их не выбрать',
      action: { label: 'Открыть Настройки', href: '/settings' },
    })
  }

  // ── Poller ────────────────────────────────────────────────────────
  if (opts.poller && opts.demandConfigured !== false) {
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

  // ── Pospoint ──────────────────────────────────────────────────────
  const pp = opts.pospoint
  const ppIssue = pp ? pospointIssue(pp) : null
  if (ppIssue) issues.push(ppIssue)
  if (pp && pp.pending > 0) {
    issues.push({
      id: 'fiscalize.pospoint-pending',
      severity: 'warning',
      source: 'fiscalize',
      title: `Pospoint: ${pp.pending} ${pp.pending === 1 ? 'чек' : 'чеков'} с неизвестным исходом`,
      detail: 'Пробит ли чек, проверится сам; подробности — Настройки → Pospoint',
      action: { label: 'Открыть Настройки', href: '/settings' },
    })
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
  const [demandConfigured, setDemandConfigured] = useState<boolean | null>(null)
  const [sseStatus, setSseStatus] = useState<
    'connected' | 'disconnected' | 'connecting' | 'idle'
  >('idle')
  const [remoteEnabled, setRemoteEnabled] = useState(false)
  const [testMode, setTestMode] = useState(false)
  const [pospoint, setPospoint] = useState<PospointHealth | null>(null)
  const [logIssues, setLogIssues] = useState<SystemIssue[]>([])

  // Poller
  useEffect(() => {
    const unsub = subscribePollerStatus(setPoller)
    return () => unsub()
  }, [])

  // SSE + settings (testMode, remoteEnabled, склад и статус) — раз в 3 секунды
  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const [tm, re, storeId, stateId] = await Promise.all([
        getSetting(SettingKey.TestMode),
        getSetting(SettingKey.InventoryRemoteEnabled),
        getSetting(SettingKey.MoyskladStoreId),
        getSetting(SettingKey.MoyskladDemandStateId),
      ])
      if (cancelled) return
      setTestMode(tm === 'true')
      const pp = getPospointHealth()
      setPospoint(pp.state === 'off' || pp.state === 'unknown' ? null : pp)
      setDemandConfigured(!!storeId && !!stateId)
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
    demandConfigured,
    sseStatus,
    remoteEnabled,
    testMode,
    pospoint,
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
