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
import { backfillSearchText } from '@/lib/db'
import { Toaster } from '@/components/ui'
import { AppVersionBadge } from '@/components/AppVersionBadge'

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

    // Разовая индексация старых чеков для поиска в Истории (migration 014).
    // Делаем на старте, чтобы к моменту открытия Истории поиск уже работал.
    // Идемпотентно, после первого прохода почти бесплатно.
    void backfillSearchText().catch((e) => {
      void log.warn(
        'app',
        `Индексация Истории для поиска не завершилась: ${e instanceof Error ? e.message : String(e)}`,
      )
    })

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
      <AppVersionBadge />
    </>
  )
}
