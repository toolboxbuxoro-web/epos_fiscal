import { Routes, Route } from 'react-router-dom'
import Layout, { RequireAdmin } from '@/components/Layout'
import Dashboard from '@/routes/Dashboard'
import Receipt from '@/routes/Receipt'
import Catalog from '@/routes/Catalog'
import History from '@/routes/History'
import Logs from '@/routes/Logs'
import Settings from '@/routes/Settings'
import Login from '@/routes/Login'
import { AppGate, RedirectIfAuthed } from '@/components/AppGate'
import { useEffect } from 'react'
import { autoApplyOnStartup } from '@/lib/updater'
import { log } from '@/lib/log'
import {
  ensureInventoryRuntime,
  stopInventoryRuntime,
} from '@/lib/inventory'
import { Toaster } from '@/components/ui'

export default function App() {
  useEffect(() => {
    void log.info('app', 'Приложение запущено')
    // Авто-обновление: если есть новая версия — само скачивается
    // и перезапускает приложение в новой версии. Без диалогов.
    void autoApplyOnStartup()

    // Inventory runtime — если включён remote-режим, тянет конфиг от админа,
    // подписывается на SSE-обновления, гоняет periodic sync. Если выключен —
    // тихо ничего не делает. Idempotent — можно дёргать несколько раз.
    void ensureInventoryRuntime()

    return () => {
      stopInventoryRuntime()
    }
  }, [])

  return (
    <>
      <Routes>
        {/* Login — без Layout, без AppGate (наоборот — отбрасывает залогиненных) */}
        <Route
          path="/login"
          element={
            <RedirectIfAuthed>
              <Login />
            </RedirectIfAuthed>
          }
        />

        {/* Все остальные routes — за AppGate'ом, под Layout'ом */}
        <Route
          element={
            <AppGate>
              <Layout />
            </AppGate>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/receipts/:id" element={<Receipt />} />
          <Route path="/history" element={<History />} />
          {/* Admin-only — защищены RequireAdmin (localStorage flag).
              Кассир не видит их в нав, прямой URL редиректит на /. */}
          <Route
            path="/catalog"
            element={
              <RequireAdmin>
                <Catalog />
              </RequireAdmin>
            }
          />
          <Route
            path="/logs"
            element={
              <RequireAdmin>
                <Logs />
              </RequireAdmin>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAdmin>
                <Settings />
              </RequireAdmin>
            }
          />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}
