import { Routes, Route } from 'react-router-dom'
import Layout from '@/components/Layout'
import Dashboard from '@/routes/Dashboard'
import Receipt from '@/routes/Receipt'
import Catalog from '@/routes/Catalog'
import History from '@/routes/History'
import Logs from '@/routes/Logs'
import Settings from '@/routes/Settings'
import { useEffect } from 'react'
import { autoApplyOnStartup } from '@/lib/updater'
import { log } from '@/lib/log'
import {
  ensureInventoryRuntime,
  stopInventoryRuntime,
} from '@/lib/inventory'

export default function App() {
  useEffect(() => {
    void log.info('app', 'Приложение запущено')
    // Авто-обновление: если есть новая версия — само скачивается
    // и перезапускает приложение в новой версии. Без диалогов.
    void autoApplyOnStartup()

    // Inventory runtime — если включён remote-режим, тянет конфиг от админа,
    // подписывается на SSE-обновления, гоняет periodic sync. Если выключен —
    // тихо ничего не делает. Idempotent — можно дёргать несколько раз.
    // Внутри уже асинхронно: housekeeping → bootstrap sync → SSE.
    // НЕ блокируем return — делаем void чтобы UI не задерживать.
    void ensureInventoryRuntime()

    // На размонтировании App (например HMR) — стопаем SSE+timers, иначе
    // в DevTools накопятся открытые stream'ы.
    return () => {
      stopInventoryRuntime()
    }
  }, [])

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Dashboard />} />
        <Route path="/receipts/:id" element={<Receipt />} />
        <Route path="/catalog" element={<Catalog />} />
        <Route path="/history" element={<History />} />
        <Route path="/logs" element={<Logs />} />
        <Route path="/settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}
