import { useEffect, useState, type ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { hasActiveSession } from '@/lib/inventory'

/**
 * AppGate — проверяет есть ли активная сессия (api_key + МС-creds в Settings).
 *
 * Использование:
 *   <Routes>
 *     <Route path="/login" element={<Login />} />
 *     <Route element={<AppGate><Layout /></AppGate>}>
 *       <Route path="/" element={<Dashboard />} />
 *       ...
 *     </Route>
 *   </Routes>
 *
 * Если сессии нет — редирект на /login. Если есть — рендер детей.
 *
 * NB: проверка только локальная (есть ли ключи в Settings). Если ключ
 * сервер отозвал — узнаем при первом 401 ответе на API и UI это покажет
 * через toast + редирект (Phase D).
 */
export function AppGate({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  const location = useLocation()

  useEffect(() => {
    void hasActiveSession().then(setAuthed)
  }, [])

  if (authed === null) {
    // Splash экран пока проверяем
    return (
      <div className="min-h-screen flex items-center justify-center bg-canvas">
        <div className="flex items-center gap-3 text-ink-muted">
          <Loader2 size={20} className="animate-spin" />
          <span className="text-body">Загрузка…</span>
        </div>
      </div>
    )
  }

  if (!authed) {
    return <Navigate to="/login" state={{ from: location }} replace />
  }

  return <>{children}</>
}

/**
 * Зеркальный гард для /login — если уже залогинен, редиректить в /.
 * Используется чтобы пользователь не залипал на login после успешного
 * входа (например через "назад" в браузерной истории).
 */
export function RedirectIfAuthed({ children }: { children: ReactNode }) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => {
    void hasActiveSession().then(setAuthed)
  }, [])
  if (authed === null) return null
  if (authed) return <Navigate to="/" replace />
  return <>{children}</>
}
