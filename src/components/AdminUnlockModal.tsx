import { useEffect, useState, type FormEvent } from 'react'
import { LogIn, ShieldCheck } from 'lucide-react'
import { Button, Field, Input, Modal, toast } from '@/components/ui'
import {
  ADMIN_LOGIN,
  hasPinSet,
  setPin,
  verifyAdminCredentials,
  verifyPin,
} from '@/lib/admin-pin'
import { unlockDevMode } from '@/lib/dev-mode'

/**
 * Модалка разблокировки dev-режима после kassir-логина.
 *
 * Два режима:
 *   - **setup**: PIN ещё не задан — форма с login + password + new PIN + confirm
 *   - **verify**: PIN задан — форма с login + password + PIN
 *
 * Login и password оба должны быть `admin` (хардкод). PIN сравнивается с
 * сохранённым PBKDF2-хешем. При успехе → `unlockDevMode()` + onUnlocked.
 */
interface Props {
  open: boolean
  onClose: () => void
  onUnlocked?: () => void
}

export function AdminUnlockModal({ open, onClose, onUnlocked }: Props) {
  const [mode, setMode] = useState<'loading' | 'setup' | 'verify'>('loading')
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [pin, setPin_] = useState('')
  const [pinConfirm, setPinConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setLogin('')
    setPassword('')
    setPin_('')
    setPinConfirm('')
    setMode('loading')
    void hasPinSet().then((set) => setMode(set ? 'verify' : 'setup'))
  }, [open])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    setBusy(true)
    try {
      if (!verifyAdminCredentials(login.trim(), password)) {
        setError('Неверный логин или пароль администратора.')
        return
      }

      if (mode === 'setup') {
        if (pin.length < 4) {
          setError('PIN должен быть минимум 4 символа.')
          return
        }
        if (pin !== pinConfirm) {
          setError('PIN не совпадает с подтверждением.')
          return
        }
        await setPin(pin)
        unlockDevMode()
        toast.success('PIN установлен. Режим разработчика активирован.')
        onUnlocked?.()
        onClose()
        return
      }

      // verify
      const ok = await verifyPin(pin, await getStoredPin())
      if (!ok) {
        setError('Неверный PIN.')
        return
      }
      unlockDevMode()
      toast.success('Режим разработчика активирован')
      onUnlocked?.()
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const title =
    mode === 'setup' ? 'Создать PIN администратора' : 'Активировать режим разработчика'

  return (
    <Modal open={open} onClose={onClose} title={title} size="sm">
      <div className="flex items-start gap-3 mb-4 p-3 rounded-md bg-info-soft border border-info/20">
        <ShieldCheck size={18} className="text-info shrink-0 mt-0.5" />
        <div className="text-caption text-ink-muted">
          {mode === 'setup' ? (
            <>
              <strong className="text-ink">Первый вход.</strong> Установите PIN — он
              будет нужен в дальнейшем чтобы разблокировать диагностические
              функции (смена сервера, debug-панели).
            </>
          ) : (
            <>
              Введите учётные данные администратора и PIN. Активирует диагностические
              функции до закрытия программы.
            </>
          )}
        </div>
      </div>

      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field label="Логин" htmlFor="admin-login">
          <Input
            id="admin-login"
            value={login}
            onChange={(e) => setLogin(e.target.value)}
            placeholder={ADMIN_LOGIN}
            autoComplete="off"
            autoFocus
            disabled={busy || mode === 'loading'}
          />
        </Field>
        <Field label="Пароль" htmlFor="admin-password">
          <Input
            id="admin-password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••"
            autoComplete="off"
            disabled={busy || mode === 'loading'}
          />
        </Field>
        <Field
          label={mode === 'setup' ? 'Новый PIN' : 'PIN'}
          htmlFor="admin-pin"
          hint={mode === 'setup' ? 'Минимум 4 символа. Запомните или запишите.' : undefined}
        >
          <Input
            id="admin-pin"
            type="password"
            value={pin}
            onChange={(e) => setPin_(e.target.value)}
            placeholder="••••"
            autoComplete="off"
            inputMode="numeric"
            disabled={busy || mode === 'loading'}
          />
        </Field>
        {mode === 'setup' && (
          <Field label="Подтвердите PIN" htmlFor="admin-pin-confirm">
            <Input
              id="admin-pin-confirm"
              type="password"
              value={pinConfirm}
              onChange={(e) => setPinConfirm(e.target.value)}
              placeholder="••••"
              autoComplete="off"
              inputMode="numeric"
              disabled={busy}
            />
          </Field>
        )}

        {error && (
          <div className="rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-caption text-danger">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 mt-2">
          <Button type="button" variant="ghost" size="md" onClick={onClose} disabled={busy}>
            Отмена
          </Button>
          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={busy}
            disabled={mode === 'loading'}
            icon={!busy ? <LogIn size={14} /> : undefined}
          >
            {mode === 'setup' ? 'Создать и войти' : 'Активировать'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}

async function getStoredPin(): Promise<string> {
  const { getSetting, SettingKey } = await import('@/lib/db')
  return (await getSetting(SettingKey.AdminPinHash)) ?? ''
}
