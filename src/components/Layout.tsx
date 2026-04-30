import { NavLink, Outlet } from 'react-router-dom'

const links = [
  { to: '/', label: 'Очередь' },
  { to: '/catalog', label: 'Справочник' },
  { to: '/history', label: 'История' },
  { to: '/settings', label: 'Настройки' },
]

export default function Layout() {
  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-slate-900 text-sm font-semibold text-white">
              EF
            </div>
            <div>
              <div className="text-sm font-semibold leading-tight">EPOS Fiscal</div>
              <div className="text-xs text-slate-500 leading-tight">Помощник кассира</div>
            </div>
          </div>
          <nav className="flex gap-1 text-sm">
            {links.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end={link.to === '/'}
                className={({ isActive }) =>
                  `rounded-md px-3 py-1.5 transition ${
                    isActive
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
                  }`
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        <div className="mx-auto max-w-6xl px-6 py-6">
          <Outlet />
        </div>
      </main>
    </div>
  )
}
