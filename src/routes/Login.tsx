import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { LogIn, Receipt, Settings as SettingsIcon } from 'lucide-react'
import { Button, Field, Input, Card } from '@/components/ui'
import { getSetting, setSetting, SettingKey } from '@/lib/db'
import { signInWithMs } from '@/lib/inventory'

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
 *   1. Пользователь вводит МС email + password
 *   2. POST /api/v1/inventory/login → backend сверяет, возвращает api_key+creds
 *   3. signInWithMs пишет всё в local Settings
 *   4. navigate('/') → AppGate видит сессию → пускает в основное приложение
 *
 * Состояния: idle / busy / error.
 *
 * Если сервер ещё не настроен (`InventoryServerUrl` пуст) — UI блокирует
 * login и показывает «настрой URL в Admin → Настройки» (через PIN-gate
 * в Phase D, пока кнопка просто переходит в /settings).
 */
export default function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [serverUrl, setServerUrl] = useState<string | null>(null)
  const [showServerUrlField, setShowServerUrlField] = useState(false)
  const [serverUrlDraft, setServerUrlDraft] = useState('')

  useEffect(() => {
    void (async () => {
      const stored = await getSetting(SettingKey.InventoryServerUrl)
      const lastLogin = await getSetting(SettingKey.MoyskladLogin)
      // Если URL не сохранён — подкладываем дефолт и сохраняем чтобы при
      // следующем старте уже был. Кассиру вообще не нужно знать про сервер.
      const url = stored || DEFAULT_SERVER_URL
      if (!stored) {
        await setSetting(SettingKey.InventoryServerUrl, DEFAULT_SERVER_URL)
      }
      setServerUrl(url)
      setServerUrlDraft(url)
      if (lastLogin) setEmail(lastLogin)
    })()
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!email.trim() || !password) return
    setBusy(true)
    try {
      const result = await signInWithMs({ email, password })
      if (result.ok) {
        navigate('/', { replace: true })
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

  const canSubmit = !!serverUrl && email.trim().length > 0 && password.length > 0 && !busy

  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-canvas px-4 py-8">
      <div className="w-full max-w-md">
        {/* Логотип / название */}
        <div className="flex items-center justify-center mb-6">
          <div className="flex items-center gap-2 text-ink">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-ink-inverse">
              <Receipt size={20} />
            </div>
            <span className="text-heading font-semibold">EPOS Fiscal</span>
          </div>
        </div>

        <Card>
          <Card.Header>
            <div>
              <Card.Title>Вход</Card.Title>
              <Card.Description>
                Введите ваш логин и пароль МойСклад.
              </Card.Description>
            </div>
          </Card.Header>

          <Card.Body>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <Field label="Email МойСклад" htmlFor="email">
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="kassa@toolbox.uz"
                  autoComplete="username"
                  autoFocus
                  disabled={busy}
                  required
                />
              </Field>

              <Field label="Пароль" htmlFor="password">
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  autoComplete="current-password"
                  disabled={busy}
                  required
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
                Войти
              </Button>
            </form>
          </Card.Body>

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
        </Card>

        {showServerUrlField && (
          <div className="mt-3 animate-fade-in">
            <Card>
              <Card.Body>
                <Field
                  label="Inventory Server URL"
                  hint="Адрес mytoolbox-сервера. Узнайте у администратора."
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
          Если забыли пароль — обратитесь к администратору в mytoolbox
        </p>
      </div>
    </div>
  )
}
