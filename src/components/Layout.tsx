import { useEffect, useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import {
  Clock,
  FileText,
  History as HistoryIcon,
  Lock,
  LogOut,
  Package,
  Receipt as ReceiptIcon,
  Settings as SettingsIcon,
  Store as StoreIcon,
  Unlock,
} from 'lucide-react'
import { Button, StatusBadge } from '@/components/ui'
import { cn } from '@/lib/cn'
import { signOut } from '@/lib/inventory'
import { getSetting, SettingKey } from '@/lib/db'
import { stopShiftRuntime, useShiftStatus } from '@/lib/moysklad'

/**
 * Layout приложения — sidebar + outlet.
 *
 * Sidebar:
 *   - Шапка: логотип + название магазина
 *   - Нав: только то что нужно кассиру (Касса / Чеки)
 *   - Admin-секция (через PIN-toggle): Справочник, Настройки, Логи
 *   - Подвал: смена + кассир + кнопка «Admin» + Выйти
 *
 * Admin gate (упрощённый v1):
 *   - localStorage 'epos.admin-unlocked' = 'true'
 *   - Кнопка «Admin» внизу сайдбара переключает флаг
 *   - В dev-режиме (Vite import.meta.env.DEV) флаг тоже показывает,
 *     но без подтверждения. В prod — TODO: PIN-modal.
 */

const ADMIN_LS_KEY = 'epos.admin-unlocked'

const KASSIR_LINKS: NavItem[] = [
  { to: '/', label: 'Касса', icon: ReceiptIcon, end: true },
  { to: '/history', label: 'Чеки', icon: HistoryIcon },
]

const ADMIN_LINKS: NavItem[] = [
  { to: '/catalog', label: 'Справочник', icon: Package },
  { to: '/settings', label: 'Настройки', icon: SettingsIcon },
  { to: '/logs', label: 'Логи', icon: FileText },
]

interface NavItem {
  to: string
  label: string
  icon: React.ElementType
  end?: boolean
}

export default function Layout() {
  const navigate = useNavigate()
  const [shopName, setShopName] = useState<string | null>(null)
  const [msLogin, setMsLogin] = useState<string | null>(null)
  const [employeeName, setEmployeeName] = useState<string | null>(null)
  const [adminUnlocked, setAdminUnlocked] = useState(false)
  const shift = useShiftStatus()

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
    setAdminUnlocked(localStorage.getItem(ADMIN_LS_KEY) === 'true')
  }, [])

  function toggleAdmin() {
    if (adminUnlocked) {
      localStorage.removeItem(ADMIN_LS_KEY)
      setAdminUnlocked(false)
      // Если сейчас на admin-странице — кикаем на главную
      navigate('/', { replace: true })
    } else {
      // TODO: PIN-modal в prod. Пока просто включаем (dev-режим).
      localStorage.setItem(ADMIN_LS_KEY, 'true')
      setAdminUnlocked(true)
    }
  }

  async function onLogout() {
    if (
      !confirm(
        'Выйти? Локальные настройки сессии (логин МойСклад, токены) будут стёрты. ' +
          'Войти снова можно вашим МС email и паролем.',
      )
    )
      return
    stopShiftRuntime()
    localStorage.removeItem(ADMIN_LS_KEY)
    await signOut()
    navigate('/login', { replace: true })
  }

  return (
    <div className="flex h-full w-full">
      {/* Sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-surface">
        {/* Логотип / магазин */}
        <div className="border-b border-border px-4 py-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-primary text-ink-inverse">
              <ReceiptIcon size={16} />
            </div>
            <div className="min-w-0">
              <div className="text-caption text-ink-muted leading-tight">
                EPOS Fiscal
              </div>
              <div className="text-body font-semibold text-ink leading-tight truncate">
                {shopName || '—'}
              </div>
            </div>
          </div>
        </div>

        {/* Навигация */}
        <nav className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
          <NavGroup>
            {KASSIR_LINKS.map((item) => (
              <NavItemLink key={item.to} item={item} />
            ))}
          </NavGroup>

          {adminUnlocked && (
            <>
              <div className="mt-4 mb-1 px-3 text-caption text-ink-subtle uppercase tracking-wide">
                Admin
              </div>
              <NavGroup>
                {ADMIN_LINKS.map((item) => (
                  <NavItemLink key={item.to} item={item} />
                ))}
              </NavGroup>
            </>
          )}
        </nav>

        {/* Подвал: смена / кассир / admin / выход */}
        <div className="border-t border-border px-3 py-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <ShiftBadge
              shiftId={shift.shiftId}
              openedAt={shift.openedAt}
              ready={shift.ready}
            />
          </div>
          {(employeeName || msLogin) && (
            <div className="flex items-start gap-2 text-caption text-ink-muted px-1">
              <StoreIcon size={12} className="mt-0.5 shrink-0" />
              <div className="min-w-0">
                <div className="text-ink truncate">{employeeName || '—'}</div>
                {msLogin && (
                  <div className="text-ink-subtle truncate" title={msLogin}>
                    {msLogin}
                  </div>
                )}
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5 pt-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={toggleAdmin}
              icon={
                adminUnlocked ? (
                  <Unlock size={14} className="text-warning" />
                ) : (
                  <Lock size={14} />
                )
              }
              className="flex-1 justify-start"
            >
              {adminUnlocked ? 'Заблокировать' : 'Admin'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onLogout}
              icon={<LogOut size={14} />}
              aria-label="Выйти"
              title="Выйти"
            />
          </div>
        </div>
      </aside>

      {/* Outlet */}
      <main className="flex-1 overflow-auto bg-canvas">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

function NavGroup({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-0.5">{children}</div>
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

/**
 * Бейдж статуса смены — компактная версия для sidebar (без полного «Смена …»).
 */
function ShiftBadge({
  shiftId,
  openedAt,
  ready,
}: {
  shiftId: string | null
  openedAt: Date | null
  ready: boolean
}) {
  if (!ready) return <div className="text-caption text-ink-subtle">…</div>

  if (!shiftId) {
    return (
      <StatusBadge status="warning" size="sm">
        Смена закрыта
      </StatusBadge>
    )
  }
  const time = openedAt
    ? openedAt.toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      })
    : ''
  return (
    <StatusBadge status="success" size="sm">
      <Clock size={11} className="-ml-0.5" />
      Открыта {time}
    </StatusBadge>
  )
}

/**
 * Защитная компонента — обернуть admin-роуты чтобы кассир не зашёл по URL.
 *
 *   <Route path="/settings" element={<RequireAdmin><Settings /></RequireAdmin>} />
 *
 * Если admin не разблокирован — редиректит на главную.
 */
export function RequireAdmin({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null)
  const navigate = useNavigate()
  useEffect(() => {
    const flag = localStorage.getItem(ADMIN_LS_KEY) === 'true'
    if (!flag) {
      navigate('/', { replace: true })
    } else {
      setUnlocked(true)
    }
  }, [navigate])
  if (!unlocked) return null
  return <>{children}</>
}

