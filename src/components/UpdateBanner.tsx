import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { Button } from '@/components/ui'
import {
  applyPendingUpdate,
  subscribePendingUpdate,
  type UpdateInfo,
} from '@/lib/updater'

/**
 * Полоса «доступно обновление» сверху всех страниц.
 *
 * Появляется, когда фоновая проверка нашла новую версию. Перезапуск —
 * по кнопке, а не сам: установщик закрывает приложение, и в середине
 * смены это стоило бы кассиру набранного чека.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribePendingUpdate(setUpdate), [])

  if (!update) return null

  async function install() {
    setBusy(true)
    try {
      await applyPendingUpdate()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="border-b border-info/30 bg-info-soft text-info">
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-6 py-2.5 text-body">
        <Download size={16} className="shrink-0" />
        <div className="flex-1">
          <strong>Доступно обновление v{update.version}</strong>
          <span className="ml-1 text-ink-muted">
            — установится за несколько секунд, программа перезапустится
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={install} loading={busy}>
          Обновить сейчас
        </Button>
      </div>
    </div>
  )
}
