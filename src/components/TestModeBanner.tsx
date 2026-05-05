import { useEffect, useState } from 'react'
import { TriangleAlert, X } from 'lucide-react'
import { getSetting, setSetting, SettingKey } from '@/lib/db'
import { Button } from '@/components/ui'

/**
 * Постоянная полоса сверху ВСЕХ страниц когда включён `SettingKey.TestMode`.
 *
 * Без подтверждений — клик «✕» сразу выключает тестовый режим.
 * Не отвлекает кассира когда режим выключен — компонент просто null.
 *
 * Polls SettingKey каждые 2 секунды (изменения из других экранов
 * подхватываются без обновления страницы).
 */
export function TestModeBanner() {
  const [enabled, setEnabled] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const v = await getSetting(SettingKey.TestMode)
      if (!cancelled) setEnabled(v === 'true')
    }
    void refresh()
    const t = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (!enabled) return null

  async function turnOff() {
    setBusy(true)
    try {
      await setSetting(SettingKey.TestMode, 'false')
      setEnabled(false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-warning/30 bg-warning-soft text-warning">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-2.5 text-body">
        <TriangleAlert size={16} className="shrink-0" />
        <div className="flex-1">
          <strong>Тестовый режим включён.</strong>
          <span className="ml-1 text-ink-muted">
            Фискализация имитируется — в ОФД ничего не уходит.
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={turnOff}
          loading={busy}
          icon={!busy ? <X size={14} /> : undefined}
          className="text-warning hover:bg-warning/10"
        >
          Выключить
        </Button>
      </div>
    </div>
  )
}

/**
 * Компактный indicator для сайдбара (точка/иконка) — показывает что
 * тест-режим включён даже если основной баннер прокрутился.
 */
export function TestModeDot() {
  const [enabled, setEnabled] = useState(false)

  useEffect(() => {
    let cancelled = false
    const refresh = async () => {
      const v = await getSetting(SettingKey.TestMode)
      if (!cancelled) setEnabled(v === 'true')
    }
    void refresh()
    const t = setInterval(refresh, 2000)
    return () => {
      cancelled = true
      clearInterval(t)
    }
  }, [])

  if (!enabled) return null
  return (
    <span
      className="inline-block h-2 w-2 rounded-full bg-warning"
      title="Тестовый режим"
    />
  )
}
