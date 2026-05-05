import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  FileText,
  History as HistoryIcon,
  LogOut,
  Package,
  Receipt as ReceiptIcon,
  Settings as SettingsIcon,
} from 'lucide-react'
import { Button } from '@/components/ui'
import { cn } from '@/lib/cn'
import { signOut } from '@/lib/inventory'
import { getSetting, SettingKey } from '@/lib/db'
import { stopShiftRuntime } from '@/lib/moysklad'
import { SystemStatusPanel } from './SystemStatusPanel'
import { TestModeBanner, TestModeDot } from './TestModeBanner'
import { DevMarker } from './DevMarker'

/**
 * Layout приложения — sidebar (слева) + outlet (контент).
 *
 *   Sidebar:
 *     - Шапка: логотип + название магазина
 *     - Nav: ВСЕ разделы видны (Касса/Чеки/Справочник/Настройки/Логи).
 *       Идея — диагностика всегда под рукой если что-то сломалось.
 *     - SystemStatusPanel — агрегированный health-check
 *     - Кассир + email + кнопка «Выйти»
 *
 *   Поверх контента:
 *     - <TestModeBanner /> — если тест-режим включён, постоянная полоса
 *     - <DevMarker /> — крошечный «DEV» в углу когда vite dev
 */

interface NavItem {
  to: string
  label: string
  icon: React.ElementType
  end?: boolean
}

const NAV_LINKS: NavItem[] = [
  { to: '/', label: 'Касса', icon: ReceiptIcon, end: true },
  { to: '/history', label: 'Чеки', icon: HistoryIcon },
  { to: '/catalog', label: 'Справочник', icon: Package },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon },
  { to: '/logs', label: 'Логи', icon: FileText },
]

export default function Layout() {
  const navigate = useNavigate()
  const [shopName, setShopName] = useState<string | null>(null)
  const [msLogin, setMsLogin] = useState<string | null>(null)
  const [employeeName, setEmployeeName] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      const [name, login, emp] = await Promise.all([
        getSetting(SettingKey.MoyskladRetailStoreName),
        getSetting(SettingKey.MoyskladLogin),
        getSetting(SettingKey.MoyskladEmployeeName),
      ])
      setShopName(name || null)
      setMsLogin(login || null)
      setEmployeeName(emp || null)
    })()
  }, [])

  async function onLogout() {
    if (
      !confirm(
        'Выйти? Локальные настройки сессии (логин МойСклад, токены) будут стёрты. ' +
          'Войти снова можно вашим МС email и паролем.',
      )
    )
      return
    stopShiftRuntime()
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-full w-full">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        {/* Шапка */}
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-ink-inverse">
              <ReceiptIcon size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-caption text-ink-muted leading-tight">
                EPOS Fiscal
              </div>
              <div className="text-body font-semibold text-ink leading-tight truncate">
                {shopName || '—'}
              </div>
            </div>
            <TestModeDot />
          </div>
        </div>

        {/* Навигация */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
          <div className="flex flex-col gap-0.5">
            {NAV_LINKS.map((item) => (
              <NavItemLink key={item.to} item={item} />
            ))}
          </div>
        </nav>

        {/* Подвал — статус + кассир + выход */}
        <div className="border-t border-border px-3 py-3 space-y-3">
          <SystemStatusPanel />

          {(employeeName || msLogin) && (
            <div className="text-caption text-ink-muted px-1">
              {employeeName && <div className="text-ink truncate">{employeeName}</div>}
              {msLogin && (
                <div className="text-ink-subtle truncate" title={msLogin}>
                  {msLogin}
                </div>
              )}
            </div>
          )}

          <Button
            variant="ghost"
            size="sm"
            onClick={onLogout}
            icon={<LogOut size={14} />}
            className="w-full justify-start"
          >
            Выйти
          </Button>
        </div>
      </aside>

      {/* Outlet */}
      <main className="flex-1 overflow-auto bg-canvas">
        <TestModeBanner />
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Outlet />
        </div>
      </main>

      <DevMarker />
    </div>
  )
}

function NavItemLink({ item }: { item: NavItem }) {
  const Icon = item.icon
  return (
    <NavLink
      to={item.to}
      end={item.end}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-md px-3 py-2 text-body transition-colors',
          isActive
            ? 'bg-primary text-ink-inverse'
            : 'text-ink-muted hover:bg-surface-hover hover:text-ink',
        )
      }
    >
      <Icon size={16} className="shrink-0" />
      <span>{item.label}</span>
    </NavLink>
  )
}
