import { useEffect, useState } from 'react'
import { getAllSettings, setSetting, setSettings, SettingKey } from '@/lib/db'
import {
  makeBasicCredentials,
  MoyskladClient,
  MoyskladError,
  type MsEmployee,
  type MsRetailStore,
} from '@/lib/moysklad'
import { EposClient, JsonRpcEposClient } from '@/lib/epos'
import { applyUpdate, checkForUpdate } from '@/lib/updater'
import { log } from '@/lib/log'
import {
  listPrinters,
  printTestQr,
  type PrinterInfo,
} from '@/lib/printer'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'

interface FormState {
  // МойСклад логин
  moyskladLogin: string
  moyskladPassword: string
  // МойСклад данные после логина (Basic credentials в base64)
  moyskladCredentials: string
  moyskladRetailStoreId: string
  moyskladRetailStoreName: string
  moyskladEmployeeId: string
  moyskladEmployeeName: string
  // Опрос
  moyskladPollInterval: string
  // EPOS
  eposCommunicatorUrl: string
  eposToken: string
  // Реквизиты
  companyName: string
  companyInn: string
  companyAddress: string
  companyPhone: string
  printerSize: string
  // Печать чека
  printerName: string
  printerAutoPrint: 'true' | 'false'
  // Matcher
  matchToleranceTiyin: string
  autoFiscalize: 'true' | 'false'
  replacementEnabled: 'true' | 'false'
  // Ценообразование (применяется к товарам из справочника при подборе)
  markupPercent: string
  roundUpToSum: string
  // Скидка для точной суммы (распределяется чтобы Jami = чек МС)
  discountForExactSum: 'true' | 'false'
  maxDiscountPerItemSum: string
  // Тестовый режим — фискализация без реальной отправки в Communicator
  testMode: 'true' | 'false'
}

const empty: FormState = {
  moyskladLogin: '',
  moyskladPassword: '',
  moyskladCredentials: '',
  moyskladRetailStoreId: '',
  moyskladRetailStoreName: '',
  moyskladEmployeeId: '',
  moyskladEmployeeName: '',
  moyskladPollInterval: '30',
  eposCommunicatorUrl: 'http://localhost:8347/uzpos',
  eposToken: 'DXJFX32CN1296678504F2',
  companyName: '',
  companyInn: '',
  companyAddress: '',
  companyPhone: '',
  printerSize: '80',
  printerName: '',
  printerAutoPrint: 'false',
  matchToleranceTiyin: '0',
  autoFiscalize: 'false',
  replacementEnabled: 'true',
  markupPercent: '10',
  roundUpToSum: '1000',
  discountForExactSum: 'true',
  maxDiscountPerItemSum: '2000',
  testMode: 'false',
}

export default function Settings() {
  const [form, setForm] = useState<FormState>(empty)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [stores, setStores] = useState<MsRetailStore[]>([])
  const [employees, setEmployees] = useState<MsEmployee[]>([])
  const [eposTest, setEposTest] = useState<string>('')
  const [updateMsg, setUpdateMsg] = useState<string>('')
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [printerLoading, setPrinterLoading] = useState(false)
  const [printerTestMsg, setPrinterTestMsg] = useState<string>('')

  useEffect(() => {
    void load()
    void refreshPrinters()
  }, [])

  /** Получить список принтеров через Rust-команду list_printers. */
  async function refreshPrinters() {
    setPrinterLoading(true)
    try {
      const list = await listPrinters()
      setPrinters(list)
    } catch (err) {
      // Команда может упасть на macOS если CUPS не запущен — это нормально,
      // печать всё равно опциональна.
      console.warn('Не удалось получить список принтеров:', err)
      setPrinters([])
    } finally {
      setPrinterLoading(false)
    }
  }

  /** Тестовая печать на выбранный принтер. */
  async function doTestPrint() {
    setPrinterTestMsg('')
    if (!form.printerName) {
      setPrinterTestMsg('Сначала выберите принтер из списка.')
      return
    }
    try {
      const jobId = await printTestQr(form.printerName)
      setPrinterTestMsg(`✓ Тестовый чек отправлен (job #${jobId})`)
    } catch (err) {
      setPrinterTestMsg(
        `✗ Ошибка печати: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  async function load() {
    const all = await getAllSettings()
    setForm((f) => ({
      ...f,
      moyskladLogin: all[SettingKey.MoyskladLogin] ?? '',
      moyskladCredentials: all[SettingKey.MoyskladCredentials] ?? '',
      moyskladRetailStoreId: all[SettingKey.MoyskladRetailStoreId] ?? '',
      moyskladRetailStoreName: all[SettingKey.MoyskladRetailStoreName] ?? '',
      moyskladEmployeeId: all[SettingKey.MoyskladEmployeeId] ?? '',
      moyskladEmployeeName: all[SettingKey.MoyskladEmployeeName] ?? '',
      moyskladPollInterval: all[SettingKey.MoyskladPollIntervalSec] ?? '30',
      eposCommunicatorUrl:
        all[SettingKey.EposCommunicatorUrl] ?? 'http://localhost:8347/uzpos',
      eposToken: all[SettingKey.EposToken] ?? 'DXJFX32CN1296678504F2',
      companyName: all[SettingKey.CompanyName] ?? '',
      companyInn: all[SettingKey.CompanyInn] ?? '',
      companyAddress: all[SettingKey.CompanyAddress] ?? '',
      companyPhone: all[SettingKey.CompanyPhone] ?? '',
      printerSize: all[SettingKey.PrinterSize] ?? '80',
      printerName: all[SettingKey.PrinterName] ?? '',
      printerAutoPrint: (all[SettingKey.PrinterAutoPrint] ?? 'false') as
        | 'true'
        | 'false',
      matchToleranceTiyin: all[SettingKey.MatchToleranceTiyin] ?? '100000',
      markupPercent: all[SettingKey.MarkupPercent] ?? '10',
      roundUpToSum: all[SettingKey.RoundUpToSum] ?? '1000',
      discountForExactSum: (all[SettingKey.DiscountForExactSum] ?? 'true') as
        | 'true'
        | 'false',
      maxDiscountPerItemSum:
        all[SettingKey.MaxDiscountPerItemSum] ?? '2000',
      testMode: (all[SettingKey.TestMode] ?? 'false') as 'true' | 'false',
      autoFiscalize: (all[SettingKey.AutoFiscalize] ?? 'false') as 'true' | 'false',
      replacementEnabled: (all[SettingKey.ReplacementEnabled] ?? 'true') as 'true' | 'false',
    }))
    // если уже есть credentials — подгрузим списки
    const creds = all[SettingKey.MoyskladCredentials]
    if (creds) {
      void loadDirectories(creds)
    }
  }

  function setField<K extends keyof FormState>(field: K, value: FormState[K]) {
    setForm((f) => ({ ...f, [field]: value }))
    setSaved(false)
  }

  async function loadDirectories(basic: string) {
    try {
      const client = new MoyskladClient({ basic })
      const [s, e] = await Promise.all([
        client.listRetailStores(),
        client.listEmployees(),
      ])
      setStores(s)
      setEmployees(e)
    } catch (err) {
      if (err instanceof MoyskladError && err.status === 401) {
        setAuthError('Сессия недействительна, войдите снова')
      }
    }
  }

  async function signIn() {
    setAuthBusy(true)
    setAuthError(null)
    try {
      const basic = makeBasicCredentials(form.moyskladLogin, form.moyskladPassword)
      // Проверяем credentials через GET /context/employee — если 401,
      // выкинет MoyskladError с понятным сообщением.
      const client = new MoyskladClient({ basic })
      await client.getMe()
      // Сохраняем — пароль уже зашит в base64-строку,
      // отдельно plaintext-пароль не храним.
      await setSettings({
        [SettingKey.MoyskladCredentials]: basic,
        [SettingKey.MoyskladLogin]: form.moyskladLogin,
      })
      setForm((f) => ({
        ...f,
        moyskladCredentials: basic,
        moyskladPassword: '',
      }))
      await loadDirectories(basic)
    } catch (e) {
      const msg =
        e instanceof MoyskladError && e.status === 401
          ? 'Неверный логин или пароль'
          : e instanceof Error
            ? e.message
            : String(e)
      setAuthError(msg)
    } finally {
      setAuthBusy(false)
    }
  }

  async function signOut() {
    await setSettings({
      [SettingKey.MoyskladCredentials]: '',
      [SettingKey.MoyskladToken]: '',
      [SettingKey.MoyskladLogin]: '',
      [SettingKey.MoyskladRetailStoreId]: '',
      [SettingKey.MoyskladRetailStoreName]: '',
      [SettingKey.MoyskladEmployeeId]: '',
      [SettingKey.MoyskladEmployeeName]: '',
    })
    setForm((f) => ({
      ...f,
      moyskladCredentials: '',
      moyskladLogin: '',
      moyskladRetailStoreId: '',
      moyskladRetailStoreName: '',
      moyskladEmployeeId: '',
      moyskladEmployeeName: '',
    }))
    setStores([])
    setEmployees([])
  }

  async function pickStore(id: string) {
    const s = stores.find((x) => x.id === id)
    setField('moyskladRetailStoreId', id)
    setField('moyskladRetailStoreName', s?.name ?? '')
    await setSettings({
      [SettingKey.MoyskladRetailStoreId]: id,
      [SettingKey.MoyskladRetailStoreName]: s?.name ?? '',
    })
  }

  async function pickEmployee(id: string) {
    const e = employees.find((x) => x.id === id)
    const fio = e?.shortFio ?? e?.fullName ?? e?.name ?? ''
    setField('moyskladEmployeeId', id)
    setField('moyskladEmployeeName', fio)
    await setSettings({
      [SettingKey.MoyskladEmployeeId]: id,
      [SettingKey.MoyskladEmployeeName]: fio,
    })
  }

  async function save() {
    setBusy(true)
    setError(null)
    try {
      await setSettings({
        [SettingKey.MoyskladPollIntervalSec]: form.moyskladPollInterval,
        [SettingKey.EposCommunicatorUrl]: form.eposCommunicatorUrl,
        [SettingKey.EposToken]: form.eposToken,
        [SettingKey.CompanyName]: form.companyName,
        [SettingKey.CompanyInn]: form.companyInn,
        [SettingKey.CompanyAddress]: form.companyAddress,
        [SettingKey.CompanyPhone]: form.companyPhone,
        [SettingKey.PrinterSize]: form.printerSize,
        [SettingKey.PrinterName]: form.printerName,
        [SettingKey.PrinterAutoPrint]: form.printerAutoPrint,
        [SettingKey.MatchToleranceTiyin]: form.matchToleranceTiyin,
        [SettingKey.MarkupPercent]: form.markupPercent,
        [SettingKey.RoundUpToSum]: form.roundUpToSum,
        [SettingKey.DiscountForExactSum]: form.discountForExactSum,
        [SettingKey.MaxDiscountPerItemSum]: form.maxDiscountPerItemSum,
        [SettingKey.TestMode]: form.testMode,
        [SettingKey.AutoFiscalize]: form.autoFiscalize,
        [SettingKey.ReplacementEnabled]: form.replacementEnabled,
      })
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function testEpos() {
    setEposTest('Проверяю…')

    await log.info('epos', '=== Начинаю проверку EPOS Communicator ===', {
      url: form.eposCommunicatorUrl,
      token: form.eposToken,
    })

    // Сначала пробуем JSON-RPC :3448/rpc/api (актуальный API).
    const rpcUrl = form.eposCommunicatorUrl.includes('/rpc/')
      ? form.eposCommunicatorUrl
      : 'http://localhost:3448/rpc/api'

    await log.info('epos', `[1/2] Пробую JSON-RPC API: ${rpcUrl}`, {
      url: rpcUrl,
      method: 'Api.Status',
    })

    try {
      const rpc = new JsonRpcEposClient({ url: rpcUrl })
      const status = await rpc.status()
      const term = Object.keys(status.Sender?.TotalFilesSent ?? {})[0] ?? '—'
      const sent = Object.values(status.Sender?.TotalFilesSent ?? {}).reduce(
        (s, v) => s + v,
        0,
      )
      setEposTest(`OK — JSON-RPC (terminal ${term}, в ОФД: ${sent})`)
      await log.info('epos', `✓ JSON-RPC отвечает: terminal ${term}, отправлено ${sent} файлов в ОФД`, {
        url: rpcUrl,
        terminalId: term,
        filesSent: sent,
        status,
      })
      return
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      await log.warn('epos', `JSON-RPC не отвечает: ${msg}`, {
        url: rpcUrl,
        error: msg,
      })
    }

    await log.info('epos', `[2/2] Пробую legacy /uzpos: ${form.eposCommunicatorUrl}`, {
      url: form.eposCommunicatorUrl,
    })

    const c = new EposClient({ url: form.eposCommunicatorUrl, token: form.eposToken })

    // Стратегия: probe-методы делятся на два класса.
    //
    // 1. «Служебные» (getVersion, checkStatus, getDeviceId, getZReportCount) —
    //    могут отсутствовать в старых сборках Communicator (NO_SUCH_METHOD_AVAILABLE).
    // 2. «Базовые» (getReceiptCount, getZreportInfo с zReportId=0, openZreport) —
    //    есть в любой версии. Возвращают либо успех, либо «Z уже открыт» / «Z не открыт» —
    //    но не NO_SUCH_METHOD_AVAILABLE.
    //
    // Идём служебными → потом базовыми. Базовые ошибки типа «Z уже открыт» считаем
    // подтверждением что Communicator живой.
    const probes: Array<{
      method: string
      payload?: Record<string, unknown>
      describe: (r: unknown) => string
      acceptableErrors?: RegExp[]
    }> = [
      // Эмпирически: на «холодном» Communicator (без активной сессии Cashdesk)
      // работает только getUnsentCount. Ставим первым.
      {
        method: 'getUnsentCount',
        describe: (r) => {
          const c = (r as { Count?: number })?.Count ?? '?'
          return `неотправленных в ОФД: ${c}`
        },
      },
      { method: 'getVersion', describe: (r) => `версия ${String(r)}` },
      { method: 'checkStatus', describe: () => 'checkStatus OK' },
      { method: 'getDeviceId', describe: (r) => `device ${String(r)}` },
      { method: 'getZReportCount', describe: (r) => `Z-отчётов ${String(r)}` },
      { method: 'getReceiptCount', describe: (r) => `чеков в ФМ: ${String(r)}` },
      {
        method: 'getZreportInfo',
        payload: { printerSize: 80, zReportId: 0 },
        describe: () => 'getZreportInfo OK',
        acceptableErrors: [/Z\s*отчет/i, /Zreport/i, /not open/i],
      },
    ]

    let firstNoMethodError: unknown = null
    for (const probe of probes) {
      await log.debug('epos', `→ Пробую legacy метод: ${probe.method}`, {
        method: probe.method,
        payload: probe.payload,
      })
      try {
        const result = await c.call({
          method: probe.method as never,
          ...(probe.payload ?? {}),
        } as never)
        setEposTest(`OK — ${probe.describe(result)}`)
        await log.info('epos', `✓ Legacy метод ${probe.method} ответил`, {
          url: form.eposCommunicatorUrl,
          method: probe.method,
          result,
        })
        return
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e)
        if (probe.acceptableErrors?.some((re) => re.test(errMsg))) {
          setEposTest(`OK — Communicator отвечает (${errMsg.slice(0, 80)})`)
          await log.info(
            'epos',
            `✓ Communicator живой, ${probe.method} вернул ожидаемую ошибку`,
            { url: form.eposCommunicatorUrl, method: probe.method, errMsg },
          )
          return
        }
        await log.debug('epos', `← ${probe.method}: ${errMsg}`, {
          method: probe.method,
          errMsg,
        })
        if (!firstNoMethodError && /NO_SUCH_METHOD/i.test(errMsg)) {
          firstNoMethodError = e
        }
      }
    }

    const finalMsg = firstNoMethodError
      ? 'Ни один из служебных методов не распознан Communicator. Проверьте версию.'
      : 'Communicator не отвечает. Проверьте URL и что служба запущена.'
    setEposTest('Ошибка: ' + finalMsg)
    await log.error('epos', `✗ Проверка завершилась ошибкой: ${finalMsg}`, {
      url: form.eposCommunicatorUrl,
      tried: probes.map((p) => p.method),
    })
  }

  async function checkUpdate() {
    setUpdateMsg('Проверяю…')
    try {
      const update = await checkForUpdate()
      if (!update) {
        setUpdateMsg('Установлена последняя версия')
        return
      }
      const ok = confirm(
        `Доступно обновление: v${update.version}\n\n${update.body ?? ''}\n\nУстановить сейчас? Приложение перезапустится.`,
      )
      if (!ok) {
        setUpdateMsg(`Доступна v${update.version} — установка отложена`)
        return
      }
      setUpdateMsg(`Скачиваю и устанавливаю v${update.version}…`)
      await applyUpdate(update)
    } catch (e) {
      setUpdateMsg('Ошибка: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const isAuthenticated = !!form.moyskladCredentials

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Настройки</h1>
        <p className="mt-1 text-sm text-slate-500">
          Подключения к МойСклад и EPOS Communicator, реквизиты компании.
        </p>
      </div>

      {form.testMode === 'true' && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>⚠️ Тестовый режим включён.</strong> При нажатии «Фискализировать»
          чек НЕ отправляется в ОФД ГНК — только проверяется подбор. Чтобы
          реально пробивать чеки — выключите ниже и сохраните.
        </div>
      )}

      <Section title="Тестовый режим">
        <Field label="Сухой прогон фискализации">
          <Select
            value={form.testMode}
            onChange={(e) =>
              setField('testMode', e.target.value as 'true' | 'false')
            }
          >
            <option value="false">Выключен (реальная фискализация в ОФД)</option>
            <option value="true">Включён (без отправки в Communicator)</option>
          </Select>
          <div className="mt-1 text-xs text-slate-500">
            При включённом режиме UI ведёт себя как обычно (подбор работает,
            кнопка «Фискализировать» жмётся), но запрос в EPOS Communicator
            НЕ уходит. Никаких записей в ОФД, остатки не списываются, история
            чеков не пополняется. Используйте для проверки настройки matcher
            и ценообразования без мусора в реальной отчётности.
          </div>
        </Field>
      </Section>

      <Section title="МойСклад">
        {!isAuthenticated ? (
          <>
            <Field label="Email или логин">
              <Input
                value={form.moyskladLogin}
                onChange={(e) => setField('moyskladLogin', e.target.value)}
                placeholder="user@example.com"
                autoComplete="username"
              />
            </Field>
            <Field label="Пароль">
              <Input
                type="password"
                value={form.moyskladPassword}
                onChange={(e) => setField('moyskladPassword', e.target.value)}
                placeholder="••••••••"
                autoComplete="current-password"
              />
            </Field>
            <div className="col-span-1 md:col-span-2 flex items-center gap-3">
              <Button
                variant="primary"
                disabled={authBusy || !form.moyskladLogin || !form.moyskladPassword}
                onClick={signIn}
              >
                {authBusy ? 'Вход…' : 'Войти в МойСклад'}
              </Button>
              {authError && (
                <span className="text-sm text-red-700">{authError}</span>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="col-span-1 md:col-span-2 flex items-center justify-between rounded-md bg-emerald-50 p-3 text-sm">
              <div>
                <span className="text-emerald-700">Залогинен как</span>{' '}
                <span className="font-medium">{form.moyskladLogin || 'пользователь'}</span>
              </div>
              <Button variant="ghost" size="sm" onClick={signOut}>
                Выйти
              </Button>
            </div>

            <Field label="Точка продаж">
              <Select
                value={form.moyskladRetailStoreId}
                onChange={(e) => void pickStore(e.target.value)}
              >
                <option value="">— выберите —</option>
                {stores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Кассир (ФИО для чека)">
              <Select
                value={form.moyskladEmployeeId}
                onChange={(e) => void pickEmployee(e.target.value)}
              >
                <option value="">— выберите —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.shortFio ?? e.fullName ?? e.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Интервал опроса, сек">
              <Input
                type="number"
                min={5}
                value={form.moyskladPollInterval}
                onChange={(e) => {
                  setField('moyskladPollInterval', e.target.value)
                  void setSetting(SettingKey.MoyskladPollIntervalSec, e.target.value)
                }}
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="EPOS Communicator">
        <Field label="URL">
          <Input
            value={form.eposCommunicatorUrl}
            onChange={(e) => setField('eposCommunicatorUrl', e.target.value)}
            placeholder="http://localhost:3448/rpc/api"
          />
          <div className="mt-1 text-xs text-slate-500">
            Новый API (рекомендуется): <code className="bg-slate-100 px-1 rounded">http://localhost:3448/rpc/api</code>
            <br />
            Старый API: <code className="bg-slate-100 px-1 rounded">http://localhost:8347/uzpos</code>
          </div>
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
        <div className="col-span-1 md:col-span-2 flex items-center gap-3">
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
            Насколько может расходиться сумма подобранного товара с оригиналом.
            <br />
            <strong>100000</strong> = ±1 000 сум (рекомендуется),{' '}
            <strong>500000</strong> = ±5 000 сум (более либерально),{' '}
            <strong>0</strong> = строго копейка-в-копейку (почти всегда не сработает).
          </div>
        </Field>
        <Field label="Подмена ИКПУ для товаров без приходов">
          <Select
            value={form.replacementEnabled}
            onChange={(e) =>
              setField('replacementEnabled', e.target.value as 'true' | 'false')
            }
          >
            <option value="true">Включена</option>
            <option value="false">Выключена</option>
          </Select>
        </Field>
        <Field label="Автоматическая фискализация без подтверждения">
          <Select
            value={form.autoFiscalize}
            onChange={(e) =>
              setField('autoFiscalize', e.target.value as 'true' | 'false')
            }
          >
            <option value="false">Только по подтверждению оператора</option>
            <option value="true">Автоматически (рискованно)</option>
          </Select>
        </Field>
      </Section>

      <Section title="Ценообразование">
        <Field label="Наценка на приходную цену, %">
          <Input
            type="number"
            min={0}
            max={500}
            value={form.markupPercent}
            onChange={(e) => setField('markupPercent', e.target.value)}
          />
          <div className="mt-1 text-xs text-slate-500">
            К приходной цене из справочника добавляется эта наценка, потом
            начисляется НДС товара. По умолчанию <strong>10</strong>.
          </div>
        </Field>
        <Field label="Округление продажной цены до, сум">
          <Input
            type="number"
            min={1}
            value={form.roundUpToSum}
            onChange={(e) => setField('roundUpToSum', e.target.value)}
          />
          <div className="mt-1 text-xs text-slate-500">
            Продажная цена округляется ВВЕРХ до этого шага.{' '}
            <strong>1000</strong> = 15 500 → 16 000, 667 450 → 668 000.{' '}
            <strong>100</strong> = до сотен. <strong>1</strong> = без округления.
          </div>
        </Field>
        <div className="md:col-span-2 rounded-md bg-slate-50 p-3 text-xs text-slate-600">
          <strong>Формула:</strong> продажная_цена = round_up( приход × (1 +
          наценка/100) × (1 + НДС/100), шаг ).
          <br />
          Пример: приход 5 959 сум, наценка 10%, НДС 12%, шаг 1000 →{' '}
          5 959 × 1.10 × 1.12 = 7 341.63 → <strong>8 000 сум</strong>.
        </div>

        <Field label="Скидка для точной суммы">
          <Select
            value={form.discountForExactSum}
            onChange={(e) =>
              setField(
                'discountForExactSum',
                e.target.value as 'true' | 'false',
              )
            }
          >
            <option value="true">
              Включена — итог совпадёт с чеком МойСклад
            </option>
            <option value="false">
              Выключена — итог может быть выше чека МС
            </option>
          </Select>
          <div className="mt-1 text-xs text-slate-500">
            Из-за округления вверх продажная цена систематически выше
            оригинальной. Если включить — программа применит скидку на
            позиции чтобы итог совпал 1-в-1. Скидка не опускает цену
            ниже себестоимости с НДС (приход × 1.12).
          </div>
        </Field>

        <Field label="Максимум скидки на позицию, сум">
          <Input
            type="number"
            min={0}
            value={form.maxDiscountPerItemSum}
            onChange={(e) =>
              setField('maxDiscountPerItemSum', e.target.value)
            }
            disabled={form.discountForExactSum === 'false'}
          />
          <div className="mt-1 text-xs text-slate-500">
            Сколько максимум разрешено скинуть на одну позицию (даже если
            себестоимость позволяет больше). По умолчанию <strong>2000</strong>.
          </div>
        </Field>
      </Section>

      <Section title="Печать чека">
        <Field label="Принтер">
          <div className="flex gap-2">
            <Select
              value={form.printerName}
              onChange={(e) => setField('printerName', e.target.value)}
              className="flex-1"
            >
              <option value="">— не выбран —</option>
              {printers.map((p) => (
                <option key={p.system_name} value={p.system_name}>
                  {p.name}
                  {p.is_default ? ' (по умолчанию)' : ''}
                  {p.state !== 'READY' ? ` · ${p.state}` : ''}
                </option>
              ))}
            </Select>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refreshPrinters()}
              disabled={printerLoading}
            >
              {printerLoading ? '…' : 'Обновить'}
            </Button>
          </div>
          <div className="mt-1 text-xs text-slate-500">
            Список берётся из ОС. Если принтера нет — установите драйвер
            Xprinter (или Generic Text Only ESC/POS) и нажмите «Обновить».
          </div>
        </Field>

        <Field label="Авто-печать после фискализации">
          <Select
            value={form.printerAutoPrint}
            onChange={(e) =>
              setField('printerAutoPrint', e.target.value as 'true' | 'false')
            }
          >
            <option value="false">Не печатать (только электронный чек)</option>
            <option value="true">
              Печатать QR-код автоматически после успеха
            </option>
          </Select>
          <div className="mt-1 text-xs text-slate-500">
            Сейчас печатается только QR-код фискального чека. Покупатель
            сканирует QR — открывается электронный чек на soliq.uz.
          </div>
        </Field>

        <Field label="Тест печати">
          <div className="flex items-start gap-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void doTestPrint()}
              disabled={!form.printerName}
            >
              Напечатать тестовый QR
            </Button>
            {printerTestMsg && (
              <span
                className={
                  printerTestMsg.startsWith('✓')
                    ? 'text-xs text-emerald-700'
                    : 'text-xs text-red-700'
                }
              >
                {printerTestMsg}
              </span>
            )}
          </div>
        </Field>
      </Section>

      <Section title="Обновления">
        <div className="col-span-1 md:col-span-2 flex items-center gap-3">
          <Button variant="secondary" size="sm" onClick={checkUpdate}>
            Проверить обновления
          </Button>
          <span className="text-xs text-slate-600">{updateMsg}</span>
        </div>
        <div className="col-span-1 md:col-span-2 text-xs text-slate-500">
          Приложение само проверяет наличие новой версии при запуске.
          Кнопка выше делает это вручную.
        </div>
      </Section>

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-slate-200 pt-4">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? 'Сохранение…' : 'Сохранить остальные настройки'}
        </Button>
        {saved && <span className="text-sm text-emerald-700">Сохранено</span>}
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
