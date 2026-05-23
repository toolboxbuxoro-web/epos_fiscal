import { Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import Dashboard from '@/routes/Dashboard'
import Receipt from '@/routes/Receipt'
import Refund from '@/routes/Refund'
import Catalog from '@/routes/Catalog'
import History from '@/routes/History'
import Logs from '@/routes/Logs'
import Settings from '@/routes/Settings'
import Login from '@/routes/Login'
import Zreport from '@/routes/Zreport'
import { AppGate, RedirectIfAuthed } from '@/components/AppGate'
import { useEffect } from 'react'
import { autoApplyOnStartup } from '@/lib/updater'
import { log } from '@/lib/log'
import {
  ensureInventoryRuntime,
  stopInventoryRuntime,
} from '@/lib/inventory'
import { ensureTelemetryStarted } from '@/lib/telemetry'
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

    // Телеметрия: error-логи на mytoolbox-сервер для centralized debugging.
    // Background-flusher раз в 30 сек, opt-out через Настройки.
    // Idempotent. Никогда не throw — не ломает основной поток.
    void ensureTelemetryStarted()

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
          <Route path="/refund/:id" element={<Refund />} />
          <Route path="/zreport" element={<Zreport />} />
          <Route path="/history" element={<History />} />
          <Route path="/catalog" element={<Catalog />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  )
}
