import { useEffect, useState, type FormEvent } from 'react'
import { LogIn, Settings as SettingsIcon } from 'lucide-react'
import logoUrl from '@/assets/toolbox-fiscal.png'
import { Button, Field, Input, Card } from '@/components/ui'
import { getSetting, setSetting, SettingKey } from '@/lib/db'
import { signInWithCode } from '@/lib/inventory'
import { useDevMode } from '@/lib/dev-mode'

/**
 * Дефолтный inventory-сервер. Фиксирован для нашей инсталляции — у всех
 * 4 магазинов один общий backend на Railway. Магазин может переопределить
 * вручную через кнопку «Сервер» (для dev или нестандартных deploy'ев).
 */
const DEFAULT_SERVER_URL = 'https://backend-production-c3d4.up.railway.app'

/**
 * Login screen — единственный экран без Layout/Sidebar.
 *
 * Flow:
 *   1. Кассир вводит код подключения из админки (вкладка «Магазины» → «Код»)
 *   2. POST /api/v1/inventory/connect → сервер возвращает ключ магазина,
 *      доступ к МойСклад и выбранные ранее склад, статус и счета
 *   3. signInWithCode пишет всё в local Settings
 *   4. reload → AppGate видит сессию → пускает в основное приложение
 *
 * Логина и пароля МойСклад здесь больше нет: их вводит админ один раз в
 * админке, а кассир получает доступ по коду. Регистр, пробелы, дефис и
 * русская раскладка в коде не важны — сервер это нормализует.
 *
 * Состояния: idle / busy / error.
 *
 * Если сервер ещё не настроен (`InventoryServerUrl` пуст) — UI блокирует
 * login и показывает «настрой URL в Admin → Настройки» (через PIN-gate
 * в Phase D, пока кнопка просто переходит в /settings).
 */
export default function Login() {
  const devMode = useDevMode()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [showServerUrlField, setShowServerUrlField] = useState(false)
  const [serverUrlDraft, setServerUrlDraft] = useState('')

  useEffect(() => {
    void (async () => {
      const stored = await getSetting(SettingKey.InventoryServerUrl)
      // Если URL не сохранён — подкладываем дефолт и сохраняем чтобы при
      // следующем старте уже был. Кассиру вообще не нужно знать про сервер.
      const url = stored || DEFAULT_SERVER_URL
      if (!stored) {
        await setSetting(SettingKey.InventoryServerUrl, DEFAULT_SERVER_URL)
      }
      setServerUrl(url)
      setServerUrlDraft(url)
    })()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!code.trim()) return
    setBusy(true)
    try {
      const result = await signInWithCode(code)
      if (result.ok) {
        // Полный reload вместо navigate(): нужно перезапустить App.tsx
        // mount-эффект чтобы `ensureInventoryRuntime()` подхватил свежие
        // creds. SoftNavigate оставит in-memory флаг runtime=false с
        // момента когда мы были не залогинены.
        window.location.href = '/'
        window.location.reload()
      } else {
        setError(result.message)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function saveServerUrl() {
    const trimmed = serverUrlDraft.trim().replace(/\/$/, '')
    if (!trimmed) return
    await setSetting(SettingKey.InventoryServerUrl, trimmed)
    setServerUrl(trimmed)
    setShowServerUrlField(false)
  }

  const canSubmit = !!serverUrl && code.trim().length > 0 && !busy

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-canvas px-4 py-8">
      <div className="w-full max-w-md">
        {/* Логотип / название */}
        <div className="flex items-center justify-center mb-6">
          <div className="flex items-center gap-2.5 text-ink">
            <img
              src={logoUrl}
              alt="Toolbox Fiscal"
              className="h-11 w-11 rounded-lg object-cover"
            />
            <span className="text-heading font-semibold">Toolbox Fiscal</span>
          </div>
        </div>

        <Card>
          <Card.Header>
            <div>
              <Card.Title>Подключение кассы</Card.Title>
              <Card.Description>
                Введите код подключения. Его выдаёт администратор в mytoolbox:
                вкладка «Магазины», кнопка «Код».
              </Card.Description>
            </div>
          </Card.Header>

          <Card.Body>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field label="Код подключения" htmlFor="code">
                <Input
                  id="code"
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="ABCD-EFGH"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  autoFocus
                  disabled={busy}
                  required
                  className="font-mono text-center tracking-widest uppercase"
                />
              </Field>

              {error && (
                <div className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-caption text-danger">
                  {error}
                </div>
              )}

              <Button
                type="submit"
                variant="primary"
                size="lg"
                loading={busy}
                disabled={!canSubmit}
                icon={!busy ? <LogIn size={16} /> : undefined}
                className="mt-2"
              >
                Подключить
              </Button>
            </form>
          </Card.Body>

          {/* Footer с конфигурацией сервера — ТОЛЬКО в dev-режиме.
              В production кассиру он не нужен: дефолтный URL подкладывается
              автоматически, а если нужен другой — админ меняет в /settings. */}
          {devMode && (
            <Card.Footer className="justify-between">
              <span className="text-caption text-ink-muted">
                {serverUrl ? (
                  <span className="truncate" title={serverUrl}>
                    Сервер: {serverUrl.replace(/^https?:\/\//, '')}
                  </span>
                ) : (
                  <span className="text-warning">Сервер не настроен</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setShowServerUrlField((v) => !v)}
                className="text-caption text-ink-muted hover:text-ink transition-colors inline-flex items-center gap-1"
              >
                <SettingsIcon size={12} />
                Сервер
              </button>
            </Card.Footer>
          )}
        </Card>

        {devMode && showServerUrlField && (
          <div className="mt-3 animate-fade-in">
            <Card>
              <Card.Body>
                <Field
                  label="Inventory Server URL"
                  hint="Адрес mytoolbox-сервера. Только в dev-режиме."
                >
                  <Input
                    type="url"
                    value={serverUrlDraft}
                    onChange={(e) => setServerUrlDraft(e.target.value)}
                    placeholder="https://backend-production-c3d4.up.railway.app"
                  />
                </Field>
                <div className="flex justify-end gap-2 mt-3">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowServerUrlField(false)}
                  >
                    Отмена
                  </Button>
                  <Button variant="primary" size="sm" onClick={saveServerUrl}>
                    Сохранить
                  </Button>
                </div>
              </Card.Body>
            </Card>
          </div>
        )}

        <p className="mt-6 text-center text-caption text-ink-subtle">
          Нет кода или он не подходит — попросите администратора выдать новый
        </p>
      </div>
    </div>
  )
}
