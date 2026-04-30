import { useEffect, useState } from 'react'
import { getAllSettings, setSettings, SettingKey } from '@/lib/db'
import { MoyskladClient } from '@/lib/moysklad/client'
import { EposClient } from '@/lib/epos'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

interface FormState {
  moyskladToken: string
  moyskladPollInterval: string
  eposCommunicatorUrl: string
  eposToken: string
  companyName: string
  companyInn: string
  companyAddress: string
  companyPhone: string
  printerSize: string
  matchToleranceTiyin: string
  autoFiscalize: 'true' | 'false'
  replacementEnabled: 'true' | 'false'
}

const empty: FormState = {
  moyskladToken: '',
  moyskladPollInterval: '30',
  eposCommunicatorUrl: 'http://localhost:8347/uzpos',
  eposToken: 'DXJFX32CN1296678504F2',
  companyName: '',
  companyInn: '',
  companyAddress: '',
  companyPhone: '',
  printerSize: '80',
  matchToleranceTiyin: '0',
  autoFiscalize: 'false',
  replacementEnabled: 'true',
}

export default function Settings() {
  const [form, setForm] = useState<FormState>(empty)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [errors, setErrors] = useState<string | null>(null)
  const [msTest, setMsTest] = useState<string>('')
  const [eposTest, setEposTest] = useState<string>('')

  useEffect(() => {
    void load()
  }, [])

  async function load() {
    const all = await getAllSettings()
    setForm({
      moyskladToken: all[SettingKey.MoyskladToken] ?? '',
      moyskladPollInterval: all[SettingKey.MoyskladPollIntervalSec] ?? '30',
      eposCommunicatorUrl:
        all[SettingKey.EposCommunicatorUrl] ?? 'http://localhost:8347/uzpos',
      eposToken: all[SettingKey.EposToken] ?? 'DXJFX32CN1296678504F2',
      companyName: all[SettingKey.CompanyName] ?? '',
      companyInn: all[SettingKey.CompanyInn] ?? '',
      companyAddress: all[SettingKey.CompanyAddress] ?? '',
      companyPhone: all[SettingKey.CompanyPhone] ?? '',
      printerSize: all[SettingKey.PrinterSize] ?? '80',
      matchToleranceTiyin: all[SettingKey.MatchToleranceTiyin] ?? '0',
      autoFiscalize:
        (all[SettingKey.AutoFiscalize] ?? 'false') as 'true' | 'false',
      replacementEnabled:
        (all[SettingKey.ReplacementEnabled] ?? 'true') as 'true' | 'false',
    })
  }

  function setField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }))
    setSaved(false)
  }

  async function save() {
    setBusy(true)
    setErrors(null)
    try {
      await setSettings({
        [SettingKey.MoyskladToken]: form.moyskladToken,
        [SettingKey.MoyskladPollIntervalSec]: form.moyskladPollInterval,
        [SettingKey.EposCommunicatorUrl]: form.eposCommunicatorUrl,
        [SettingKey.EposToken]: form.eposToken,
        [SettingKey.CompanyName]: form.companyName,
        [SettingKey.CompanyInn]: form.companyInn,
        [SettingKey.CompanyAddress]: form.companyAddress,
        [SettingKey.CompanyPhone]: form.companyPhone,
        [SettingKey.PrinterSize]: form.printerSize,
        [SettingKey.MatchToleranceTiyin]: form.matchToleranceTiyin,
        [SettingKey.AutoFiscalize]: form.autoFiscalize,
        [SettingKey.ReplacementEnabled]: form.replacementEnabled,
      })
      setSaved(true)
    } catch (e) {
      setErrors(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function testMoysklad() {
    setMsTest('Проверяю…')
    try {
      const c = new MoyskladClient({ token: form.moyskladToken })
      await c.ping()
      setMsTest('OK — токен принят МойСклад')
    } catch (e) {
      setMsTest('Ошибка: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function testEpos() {
    setEposTest('Проверяю…')
    try {
      const c = new EposClient({ url: form.eposCommunicatorUrl, token: form.eposToken })
      const v = await c.getVersion()
      setEposTest('OK — Communicator: ' + v)
    } catch (e) {
      setEposTest('Ошибка: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-slate-500">
          Подключения к МойСклад и EPOS Communicator, реквизиты компании, правила подбора.
        </p>
      </div>

      <Section title="МойСклад">
        <Field label="Bearer-токен">
          <Input
            type="password"
            value={form.moyskladToken}
            onChange={(e) => setField('moyskladToken', e.target.value)}
            placeholder="Создайте сервисный токен в Настройки → Сервис"
          />
        </Field>
        <Field label="Интервал опроса, сек">
          <Input
            type="number"
            min={5}
            value={form.moyskladPollInterval}
            onChange={(e) => setField('moyskladPollInterval', e.target.value)}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={testMoysklad}>
            Проверить подключение
          </Button>
          <span className="text-xs text-slate-600">{msTest}</span>
        </div>
      </Section>

      <Section title="EPOS Communicator">
        <Field label="URL">
          <Input
            value={form.eposCommunicatorUrl}
            onChange={(e) => setField('eposCommunicatorUrl', e.target.value)}
            placeholder="http://localhost:8347/uzpos"
          />
        </Field>
        <Field label="Токен">
          <Input
            value={form.eposToken}
            onChange={(e) => setField('eposToken', e.target.value)}
          />
        </Field>
        <Field label="Ширина чековой ленты">
          <Select
            value={form.printerSize}
            onChange={(e) => setField('printerSize', e.target.value)}
          >
            <option value="58">58 мм</option>
            <option value="80">80 мм</option>
          </Select>
        </Field>
        <div className="flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={testEpos}>
            Проверить подключение
          </Button>
          <span className="text-xs text-slate-600">{eposTest}</span>
        </div>
      </Section>

      <Section title="Реквизиты компании">
        <Field label="Название (как в чеке)">
          <Input
            value={form.companyName}
            onChange={(e) => setField('companyName', e.target.value)}
          />
        </Field>
        <Field label="ИНН">
          <Input
            value={form.companyInn}
            onChange={(e) => setField('companyInn', e.target.value)}
          />
        </Field>
        <Field label="Адрес">
          <Input
            value={form.companyAddress}
            onChange={(e) => setField('companyAddress', e.target.value)}
          />
        </Field>
        <Field label="Телефон">
          <Input
            value={form.companyPhone}
            onChange={(e) => setField('companyPhone', e.target.value)}
          />
        </Field>
      </Section>

      <Section title="Правила подбора">
        <Field label="Допуск по сумме (тийины)">
          <Input
            type="number"
            min={0}
            value={form.matchToleranceTiyin}
            onChange={(e) => setField('matchToleranceTiyin', e.target.value)}
          />
          <div className="mt-1 text-xs text-slate-500">
            Например, 5000 = ±50 сум на одну позицию
          </div>
        </Field>
        <Field label="Подмена ИКПУ для товаров без приходов">
          <Select
            value={form.replacementEnabled}
            onChange={(e) => setField('replacementEnabled', e.target.value as 'true' | 'false')}
          >
            <option value="true">Включена</option>
            <option value="false">Выключена</option>
          </Select>
        </Field>
        <Field label="Автоматическая фискализация без подтверждения">
          <Select
            value={form.autoFiscalize}
            onChange={(e) => setField('autoFiscalize', e.target.value as 'true' | 'false')}
          >
            <option value="false">Только по подтверждению оператора</option>
            <option value="true">Автоматически (рискованно)</option>
          </Select>
        </Field>
      </Section>

      {errors && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {errors}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? 'Сохранение…' : 'Сохранить'}
        </Button>
        {saved && (
          <span className="text-sm text-emerald-700">Настройки сохранены</span>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-slate-700">{label}</span>
      {children}
    </label>
  )
}
