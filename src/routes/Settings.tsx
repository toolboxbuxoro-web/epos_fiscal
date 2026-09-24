import { useEffect, useState } from 'react'
import { formatErrorForUser } from '@/lib/error-message'
import { getAllSettings, setSetting, setSettings, SettingKey } from '@/lib/db'
import {
  DEMAND_SYNC_KEY,
  MoyskladClient,
  MoyskladError,
  parseAccountMapping,
  type AccountMapping,
  type MsEmployee,
  type MsOrganizationAccount,
  type MsState,
  type MsStore,
  type PaymentKind,
} from '@/lib/moysklad'
import { JsonRpcEposClient, FiscalDriveClient } from '@/lib/epos'
import { applyUpdate, checkForUpdate } from '@/lib/updater'
import { log } from '@/lib/log'
import {
  getInventoryClient,
  getInventorySseStatus,
  InventoryServerClient,
  syncFromServer,
  syncShopConfig,
} from '@/lib/inventory'
import { pollMoyskladNow } from '@/lib/poller-runtime'
import { AdminUnlockModal } from '@/components/AdminUnlockModal'
import { lockDevMode, useRuntimeDevUnlocked } from '@/lib/dev-mode'
import { ShieldCheck, Lock as LockIcon, Unlock } from 'lucide-react'
import {
  listPrinters,
  printTestQr,
  type PrinterInfo,
} from '@/lib/printer'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { Select } from '@/components/ui/Select'
import { toast } from '@/components/ui'
import { MIN_MARKUP_PERCENT } from '@/lib/matcher/strategies'

interface FormState {
  // МойСклад: логин и доступ приходят с сервера при входе по коду
  moyskladLogin: string
  // Basic credentials в base64
  moyskladCredentials: string
  // Что пробивает касса: отгрузки с этого склада в этом статусе
  moyskladStoreId: string
  moyskladStoreName: string
  moyskladDemandStateId: string
  moyskladDemandStateName: string
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
  matcherMode: 'auto' | 'classic' | 'holistic' | 'off'
  // Ценообразование (применяется к товарам из справочника при подборе)
  markupPercent: string
  roundUpToSum: string
  defaultVatPercent: string
  // Скидка для точной суммы (распределяется чтобы Jami = чек МС)
  discountForExactSum: 'true' | 'false'
  maxDiscountPerItemSum: string
  maxQtyPerLine: string
  // Тестовый режим — фискализация без реальной отправки в Communicator
  testMode: 'true' | 'false'
  // Фискальный бэкенд
  fiscalBackend: 'epos' | 'fiscaldrive'
  fiscalDriveBaseUrl: string
  fiscalDriveFactoryId: string
  // Inventory Server (общий пул приходов через mytoolbox) — обязательно с 0.10+
  invServerUrl: string
  invShopSlug: string
  invShopApiKey: string
  telemetryEnabled: 'true' | 'false'
}

const empty: FormState = {
  moyskladLogin: '',
  moyskladCredentials: '',
  moyskladStoreId: '',
  moyskladStoreName: '',
  moyskladDemandStateId: '',
  moyskladDemandStateName: '',
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
  matcherMode: 'auto',
  markupPercent: '10',
  roundUpToSum: '1000',
  defaultVatPercent: '12',
  discountForExactSum: 'true',
  maxDiscountPerItemSum: '2000',
  maxQtyPerLine: '20',
  testMode: 'false',
  fiscalBackend: 'epos',
  fiscalDriveBaseUrl: 'http://localhost:3449',
  fiscalDriveFactoryId: '',
  invServerUrl: '',
  invShopSlug: '',
  invShopApiKey: '',
  telemetryEnabled: 'true',
}

/** Подпись счёта для людей: банк, номер и юрлицо. Хранится в привязке. */
function accountLabel(acc: MsOrganizationAccount & { organizationName: string }): string {
  return [acc.bankName, acc.accountNumber, acc.organizationName].filter(Boolean).join(' · ')
}

export default function Settings() {
  const [form, setForm] = useState<FormState>(empty)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [authError, setAuthError] = useState<string | null>(null)
  const [stores, setStores] = useState<MsStore[]>([])
  const [demandStates, setDemandStates] = useState<MsState[]>([])
  const [orgAccounts, setOrgAccounts] = useState<Array<MsOrganizationAccount & { organizationName: string }>>([])
  const [accountMapping, setAccountMapping] = useState<AccountMapping>({})
  /** Что вышло с отправкой выбора на сервер — показать рядом с полями. */
  const [demandSyncMsg, setDemandSyncMsg] = useState<string | null>(null)
  const [employees, setEmployees] = useState<MsEmployee[]>([])
  const [eposTest, setEposTest] = useState<string>('')
  const [updateMsg, setUpdateMsg] = useState<string>('')
  const [printers, setPrinters] = useState<PrinterInfo[]>([])
  const [printerLoading, setPrinterLoading] = useState(false)
  const [printerTestMsg, setPrinterTestMsg] = useState<string>('')
  // FiscalDriveService
  const [fdsDetectMsg, setFdsDetectMsg] = useState<string>('')
  // Inventory подключение
  const [invTestMsg, setInvTestMsg] = useState<string>('')
  const [invConnecting, setInvConnecting] = useState(false)
  const [invSseStatus, setInvSseStatus] = useState<
    'connected' | 'disconnected' | 'connecting' | 'idle'
  >('idle')
  // Admin gate
  const [showAdminModal, setShowAdminModal] = useState(false)
  const devUnlocked = useRuntimeDevUnlocked()

  useEffect(() => {
    void load()
    void refreshPrinters()
    // Polling SSE-status — runtime обновляет статус через колбэк onStatusChange,
    // но для UI проще раз в секунду спросить getter. Дешёво.
    const t = setInterval(() => {
      setInvSseStatus(getInventorySseStatus())
    }, 1000)
    return () => clearInterval(t)
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
      moyskladStoreId: all[SettingKey.MoyskladStoreId] ?? '',
      moyskladStoreName: all[SettingKey.MoyskladStoreName] ?? '',
      moyskladDemandStateId: all[SettingKey.MoyskladDemandStateId] ?? '',
      moyskladDemandStateName: all[SettingKey.MoyskladDemandStateName] ?? '',
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
      matcherMode: ((): 'auto' | 'classic' | 'holistic' | 'off' => {
        const v = all[SettingKey.MatcherMode]
        return v === 'classic' || v === 'holistic' || v === 'off' ? v : 'auto'
      })(),
      markupPercent: all[SettingKey.MarkupPercent] ?? '10',
      roundUpToSum: all[SettingKey.RoundUpToSum] ?? '1000',
      defaultVatPercent: all[SettingKey.DefaultVatPercent] ?? '12',
      discountForExactSum: (all[SettingKey.DiscountForExactSum] ?? 'true') as
        | 'true'
        | 'false',
      maxQtyPerLine: all[SettingKey.MaxQtyPerLine] ?? '20',
      maxDiscountPerItemSum:
        all[SettingKey.MaxDiscountPerItemSum] ?? '2000',
      testMode: (all[SettingKey.TestMode] ?? 'false') as 'true' | 'false',
      fiscalBackend: (all[SettingKey.FiscalBackend] === 'fiscaldrive' ? 'fiscaldrive' : 'epos') as 'epos' | 'fiscaldrive',
      fiscalDriveBaseUrl: all[SettingKey.FiscalDriveBaseUrl] ?? 'http://localhost:3449',
      fiscalDriveFactoryId: all[SettingKey.FiscalDriveFactoryId] ?? '',
      autoFiscalize: (all[SettingKey.AutoFiscalize] ?? 'false') as 'true' | 'false',
      replacementEnabled: (all[SettingKey.ReplacementEnabled] ?? 'true') as 'true' | 'false',
      invServerUrl: all[SettingKey.InventoryServerUrl] ?? '',
      invShopSlug: all[SettingKey.InventoryShopSlug] ?? '',
      invShopApiKey: all[SettingKey.InventoryShopApiKey] ?? '',
      telemetryEnabled: (all[SettingKey.TelemetryEnabled] ?? 'true') as
        | 'true'
        | 'false',
    }))
    setAccountMapping(parseAccountMapping(all[SettingKey.MoyskladPaymentAccounts]))
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
      const [st, dst, acc, e] = await Promise.all([
        client.listStores(),
        client.listDemandStates(),
        client.listOrganizationAccounts(),
        client.listEmployees(),
      ])
      setStores(st)
      setDemandStates(dst)
      setOrgAccounts(acc)
      setEmployees(e)
    } catch (err) {
      if (err instanceof MoyskladError && err.status === 401) {
        setAuthError('Доступ к МойСклад недействителен — подключите кассу заново по коду')
      }
    }
  }

  /**
   * Отправить выбор кассы на сервер. Локально он уже сохранён и работает;
   * сервер нужен, чтобы после переустановки касса получила его обратно, а
   * админ видел настройку. Нет связи — не страшно, но сказать об этом надо.
   */
  async function pushDemandConfig(patch: Parameters<InventoryServerClient['updateShopDemandConfig']>[0]) {
    try {
      const client = await getInventoryClient()
      if (!client) return
      await client.updateShopDemandConfig(patch)
      setDemandSyncMsg(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDemandSyncMsg(`Сохранено на кассе, но не на сервере: ${msg}`)
      void log.warn('inventory.sync', 'Выбор склада/статуса/счетов не ушёл на сервер', { error: msg })
    }
  }

  /**
   * Склад или статус сменились: сбрасываем курсор опроса, чтобы новый
   * фильтр прошёл по последним суткам, и сразу опрашиваем МойСклад —
   * кассир увидит очередь, не дожидаясь следующего тика.
   */
  async function applyDemandFilter(updates: Record<string, string>) {
    await setSettings({ ...updates, [DEMAND_SYNC_KEY as never]: '' })
    void pollMoyskladNow().catch(() => {})
  }

  async function pickStore(id: string) {
    const st = stores.find((x) => x.id === id)
    setField('moyskladStoreId', id)
    setField('moyskladStoreName', st?.name ?? '')
    await applyDemandFilter({
      [SettingKey.MoyskladStoreId]: id,
      [SettingKey.MoyskladStoreName]: st?.name ?? '',
    })
    await pushDemandConfig({ store_id: id || null, store_name: st?.name ?? null })
  }

  async function pickDemandState(id: string) {
    const st = demandStates.find((x) => x.id === id)
    setField('moyskladDemandStateId', id)
    setField('moyskladDemandStateName', st?.name ?? '')
    await applyDemandFilter({
      [SettingKey.MoyskladDemandStateId]: id,
      [SettingKey.MoyskladDemandStateName]: st?.name ?? '',
    })
    await pushDemandConfig({ demand_state_id: id || null, demand_state_name: st?.name ?? null })
  }

  /** Привязать расчётный счёт к типу оплаты. Пустое значение — снять привязку. */
  async function setAccountType(accountId: string, type: PaymentKind | '') {
    const acc = orgAccounts.find((a) => a.id === accountId)
    const next: AccountMapping = { ...accountMapping }
    const key = accountId.toLowerCase()
    if (type) {
      const label = acc ? accountLabel(acc) : undefined
      next[key] = label ? { type, label } : { type }
    } else {
      delete next[key]
    }
    setAccountMapping(next)
    await setSetting(SettingKey.MoyskladPaymentAccounts, JSON.stringify(next))
    await pushDemandConfig({ payment_accounts: next })
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
    // Нижняя граница наценки — MIN_MARKUP_PERCENT (см. strategies.ts).
    // Замер на реальном пуле: при наценке 10/8/5% floor-фильтры инертны
    // (0% пула отсекается), но уже при 3% отсекается 88.5% пула, при 0% —
    // 95.4%. Т.е. магазин с наценкой ниже 5% практически перестаёт
    // подбирать товары (auto/classic проваливаются в «не подобрано»,
    // holistic — в reject). loadMatcherPool клампит наценку тоже (защита
    // от старых сохранённых значений/ручной правки БД), но здесь блокируем
    // ДО сохранения — чтобы магазин вообще не мог выставить ниже этого
    // значения через форму и не узнал о проблеме только по факту простоя.
    const markupNum = Number(form.markupPercent)
    if (!Number.isFinite(markupNum) || markupNum < MIN_MARKUP_PERCENT) {
      const msg =
        `Наценка не может быть ниже ${MIN_MARKUP_PERCENT}% — при более низкой ` +
        `подбор товаров почти перестаёт работать (это минимальная маржа, ниже ` +
        `которой продавать нельзя по правилу «не в убыток»).`
      setError(msg)
      toast.error(msg, { duration: 6000 })
      return
    }
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
        [SettingKey.MatcherMode]: form.matcherMode,
        [SettingKey.MarkupPercent]: form.markupPercent,
        [SettingKey.RoundUpToSum]: form.roundUpToSum,
        [SettingKey.DefaultVatPercent]: form.defaultVatPercent,
        [SettingKey.DiscountForExactSum]: form.discountForExactSum,
        [SettingKey.MaxDiscountPerItemSum]: form.maxDiscountPerItemSum,
        [SettingKey.MaxQtyPerLine]: form.maxQtyPerLine,
        [SettingKey.TestMode]: form.testMode,
        [SettingKey.FiscalBackend]: form.fiscalBackend,
        [SettingKey.FiscalDriveBaseUrl]: form.fiscalDriveBaseUrl.replace(/\/$/, ''),
        [SettingKey.FiscalDriveFactoryId]: form.fiscalDriveFactoryId.trim(),
        [SettingKey.AutoFiscalize]: form.autoFiscalize,
        [SettingKey.ReplacementEnabled]: form.replacementEnabled,
        [SettingKey.InventoryRemoteEnabled]: "true",
        [SettingKey.InventoryServerUrl]: form.invServerUrl.replace(/\/$/, ''),
        [SettingKey.InventoryShopSlug]: form.invShopSlug.trim(),
        [SettingKey.InventoryShopApiKey]: form.invShopApiKey.trim(),
        [SettingKey.TelemetryEnabled]: form.telemetryEnabled,
      })
      setSaved(true)
    } catch (e) {
      setError(formatErrorForUser(e))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Подключиться к inventory server: ping → если форма заполнена и НЕ
   * совпадает с уже сохранёнными настройками, сначала их save (потому что
   * клиент берёт конфиг из настроек, не из form). Затем syncShopConfig
   * (подтянуть МС-creds от админа) + syncFromServer (подтянуть приходы).
   */
  async function connectInventory() {
    setInvTestMsg('')
    setInvConnecting(true)
    try {
      if (!form.invServerUrl || !form.invShopApiKey) {
        setInvTestMsg('Заполни URL и API key — без них не подключусь.')
        setInvConnecting(false)
        return
      }
      // Сначала сохраняем — служебные функции читают из БД, не из form.
      await setSettings({
        [SettingKey.InventoryRemoteEnabled]: "true",
        [SettingKey.InventoryServerUrl]: form.invServerUrl.replace(/\/$/, ''),
        [SettingKey.InventoryShopSlug]: form.invShopSlug.trim(),
        [SettingKey.InventoryShopApiKey]: form.invShopApiKey.trim(),
      })

      // Smoke-check: ping (GET /items?limit=1) — самый дешёвый способ
      // проверить URL+авторизацию+связь с БД на сервере.
      const client = new InventoryServerClient({
        serverUrl: form.invServerUrl.replace(/\/$/, ''),
        apiKey: form.invShopApiKey.trim(),
        shopSlug: form.invShopSlug.trim(),
      })
      setInvTestMsg('Проверяю связь…')
      await client.ping()

      // Если remote включён — подтягиваем МС-creds от админа и приходы.
      if (true) {
        setInvTestMsg('Подтягиваю МС-настройки от админа…')
        const cfg = await syncShopConfig()
        if (cfg.applied) {
          // Перезагружаем форму чтобы юзер увидел подтянутые поля МС.
          await load()
        }

        setInvTestMsg('Загружаю приходы из общего пула…')
        const sync = await syncFromServer({ forceFull: true })

        const cfgPart = cfg.applied
          ? '+ МС-настройки подтянуты от админа'
          : `(МС-привязки на сервере нет: ${cfg.reason ?? '?'})`
        setInvTestMsg(
          `✓ Подключено. Приходов: ${sync.synced}${
            sync.errors > 0 ? `, ошибок ${sync.errors}` : ''
          }. ${cfgPart}`,
        )
      } else {
        setInvTestMsg('✓ Связь есть. Включи "Общий пул" чтобы начать использовать.')
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setInvTestMsg(`✗ Ошибка: ${msg}`)
    } finally {
      setInvConnecting(false)
    }
  }

  /**
   * Применить настройки от админа без полного reconnect — только syncShopConfig.
   * Используется когда remote уже включён и админ обновил МС-привязку
   * (поменял пароль / точку продаж / кассира).
   */
  async function refreshFromAdmin() {
    setInvTestMsg('Перечитываю настройки от админа…')
    setInvConnecting(true)
    try {
      const res = await syncShopConfig()
      if (res.applied) {
        await load()
        setInvTestMsg('✓ Настройки обновлены от админа.')
      } else {
        setInvTestMsg(`Без изменений: ${res.reason ?? 'неизвестно'}`)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setInvTestMsg(`✗ ${msg}`)
    } finally {
      setInvConnecting(false)
    }
  }

  async function testEpos() {
    setEposTest('Проверяю…')
    await log.info('epos', '=== Начинаю проверку EPOS Communicator ===', {
      url: form.eposCommunicatorUrl,
    })

    try {
      const rpc = new JsonRpcEposClient({ url: form.eposCommunicatorUrl })
      const status = await rpc.status()
      const term = Object.keys(status.Sender?.TotalFilesSent ?? {})[0] ?? '—'
      const sent = Object.values(status.Sender?.TotalFilesSent ?? {}).reduce(
        (s, v) => s + v,
        0,
      )
      setEposTest(`OK — JSON-RPC (terminal ${term}, в ОФД отправлено ${sent} файлов)`)
      await log.info('epos', `✓ Communicator отвечает: terminal ${term}, ${sent} файлов в ОФД`, {
        url: form.eposCommunicatorUrl,
        terminalId: term,
        filesSent: sent,
        status,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setEposTest(`Ошибка: ${msg}`)
      await log.error('epos', `✗ Communicator не отвечает: ${msg}`, {
        url: form.eposCommunicatorUrl,
        error: msg,
      })
    }
  }

  async function detectFdsFactoryId() {
    setFdsDetectMsg('Получаю список ФМ…')
    try {
      const baseUrl = form.fiscalDriveBaseUrl.replace(/\/$/, '') || 'http://localhost:3449'
      const client = new FiscalDriveClient({ baseUrl })
      const drives = await client.listDrives()
      if (drives.length === 0) {
        setFdsDetectMsg('Список ФМ пустой — проверьте что FiscalDriveService запущен и ФМ подключён.')
        return
      }
      const first = drives[0]!
      const factoryId = first.FactoryID
      setField('fiscalDriveFactoryId', factoryId)
      setFdsDetectMsg(`✓ FactoryID: ${factoryId} (AppletVersion: ${first.AppletVersion})`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setFdsDetectMsg(`Ошибка: ${msg}`)
    }
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
        <p className="mt-1 text-sm text-ink-muted">
          Подключения к МойСклад и EPOS Communicator, реквизиты компании.
        </p>
      </div>

      {form.testMode === 'true' && (
        <div className="rounded-lg border-2 border-warning/20 bg-warning-soft px-4 py-3 text-sm text-warning">
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
          <div className="mt-1 text-xs text-ink-muted">
            При включённом режиме UI ведёт себя как обычно (подбор работает,
            кнопка «Фискализировать» жмётся), но запрос в EPOS Communicator
            НЕ уходит. Никаких записей в ОФД, остатки не списываются, история
            чеков не пополняется. Используйте для проверки настройки matcher
            и ценообразования без мусора в реальной отчётности.
          </div>
        </Field>
      </Section>

      <Section title="Общий пул приходов (Inventory Server)">
        <div className="col-span-1 md:col-span-2 flex items-center justify-between gap-3 text-xs">
          <div className="text-ink-muted">
            Если все магазины твоей сети используют общий пул приходов через
            mytoolbox-сервер — включи здесь и подключись. Тогда:
            <ul className="mt-1 ml-5 list-disc">
              <li>Приходы загружает бухгалтер централизованно через админку — не нужно импортить Excel в каждый магазин</li>
              <li>2 магазина не смогут списать одну штуку — атомарная резервация на сервере</li>
              <li>МС-логин/пароль/точка продаж тянутся от админа — нечего настраивать вручную</li>
            </ul>
            Магазин и его API key создаёт админ в mytoolbox.
          </div>
          <SseStatusBadge status={invSseStatus} />
        </div>

        <Field label="Inventory Server URL">
          <Input
            value={form.invServerUrl}
            onChange={(e) => setField('invServerUrl', e.target.value)}
            placeholder="https://mytoolbox-backend.up.railway.app"
          />
          <div className="mt-1 text-xs text-ink-muted">
            Базовый URL mytoolbox backend. Без хвостового слэша.
          </div>
        </Field>

        <Field label="Slug магазина">
          <Input
            value={form.invShopSlug}
            onChange={(e) => setField('invShopSlug', e.target.value)}
            placeholder="toolbox-honabod"
          />
          <div className="mt-1 text-xs text-ink-muted">
            Идентификатор магазина из админки (для логов; auth по API key).
          </div>
        </Field>

        <Field label="API key">
          <Input
            type="password"
            value={form.invShopApiKey}
            onChange={(e) => setField('invShopApiKey', e.target.value)}
            placeholder="epf_..."
          />
          <div className="mt-1 text-xs text-ink-muted">
            Выдаётся админом в mytoolbox при создании магазина (показывается один раз).
          </div>
        </Field>

        <Field label="Отправлять ошибки на сервер для анализа">
          <Select
            value={form.telemetryEnabled}
            onChange={(e) =>
              setField(
                'telemetryEnabled',
                e.target.value as 'true' | 'false',
              )
            }
          >
            <option value="true">Включено (рекомендуется)</option>
            <option value="false">Выключено</option>
          </Select>
          <div className="mt-1 text-xs text-ink-muted">
            Раз в 30 сек шлёт error-логи в admin-панель mytoolbox для
            централизованного debugging'а. ПИНФЛ/ИНН/телефоны/email
            автоматически вычищаются перед отправкой. info/debug/warn
            остаются локально. Можно выключить для приватности.
          </div>
        </Field>

        <div className="col-span-1 md:col-span-2 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            size="sm"
            onClick={connectInventory}
            disabled={invConnecting}
          >
            {invConnecting ? 'Подключаюсь…' : 'Подключиться'}
          </Button>
          {true && (
            <Button
              variant="secondary"
              size="sm"
              onClick={refreshFromAdmin}
              disabled={invConnecting}
            >
              Перечитать настройки от админа
            </Button>
          )}
          <span className="text-xs text-ink-muted">{invTestMsg}</span>
        </div>
      </Section>

      <Section title="МойСклад">
        <div className="col-span-1 md:col-span-2 rounded-md bg-canvas border border-border p-3 text-xs text-ink-muted">
          Доступ к МойСклад и кассира задаёт администратор, касса получает их при входе по коду.
          Склад, статус и счета оплаты выбираются здесь: касса пробивает только отгрузки с этого
          склада в этом статусе, а тип оплаты берёт из входящих платежей по привязке счетов.
        </div>
        {!isAuthenticated ? (
          <div className="col-span-1 md:col-span-2 rounded-md bg-warning-soft p-3 text-sm text-warning">
            Касса не подключена к МойСклад. Выйдите и войдите заново по коду подключения из админки.
          </div>
        ) : (
          <>
            <div className="col-span-1 md:col-span-2 flex items-center justify-between rounded-md bg-success-soft p-3 text-sm">
              <div>
                <span className="text-success">Подключено к МойСклад как</span>{' '}
                <span className="font-medium">{form.moyskladLogin || 'пользователь'}</span>
              </div>
              {authError && <span className="text-sm text-danger">{authError}</span>}
            </div>

            <Field label="Склад, с которого пробивать отгрузки">
              <Select value={form.moyskladStoreId} onChange={(e) => void pickStore(e.target.value)}>
                <option value="">— выберите склад —</option>
                {stores.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
                {/* Склад выбран, но список ещё не подгрузился или склад в архиве. */}
                {form.moyskladStoreId && !stores.some((st) => st.id === form.moyskladStoreId) && (
                  <option value={form.moyskladStoreId}>
                    {form.moyskladStoreName || form.moyskladStoreId}
                  </option>
                )}
              </Select>
            </Field>
            <Field label="Статус отгрузки, в котором её пора пробивать">
              <Select
                value={form.moyskladDemandStateId}
                onChange={(e) => void pickDemandState(e.target.value)}
              >
                <option value="">— выберите статус —</option>
                {demandStates.map((st) => (
                  <option key={st.id} value={st.id}>
                    {st.name}
                  </option>
                ))}
                {form.moyskladDemandStateId &&
                  !demandStates.some((st) => st.id === form.moyskladDemandStateId) && (
                    <option value={form.moyskladDemandStateId}>
                      {form.moyskladDemandStateName || form.moyskladDemandStateId}
                    </option>
                  )}
              </Select>
            </Field>
            {(!form.moyskladStoreId || !form.moyskladDemandStateId) && (
              <div className="col-span-1 md:col-span-2 rounded-md bg-warning-soft p-3 text-xs text-warning">
                Пока склад и статус не выбраны, касса не видит отгрузки и ничего не пробивает.
              </div>
            )}

            <Field label="Кассир (ФИО для чека)">
              <Select value={form.moyskladEmployeeId} onChange={(e) => void pickEmployee(e.target.value)} disabled={true}>
                <option value="">— задаёт администратор —</option>
                {employees.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.shortFio ?? e.fullName ?? e.name}
                  </option>
                ))}
                {form.moyskladEmployeeId && !employees.some((e) => e.id === form.moyskladEmployeeId) && (
                  <option value={form.moyskladEmployeeId}>
                    {form.moyskladEmployeeName || form.moyskladEmployeeId}
                  </option>
                )}
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

            {/* Счета оплаты. У отгрузки нет разбивки «наличные / карта»: тип
                оплаты входящего платежа определяется по расчётному счёту, на
                который пришли деньги. Счёт без привязки блокирует чек —
                угадывать нельзя, в ОФД уйдёт неверный тип оплаты. */}
            <div className="col-span-1 md:col-span-2 space-y-2">
              <div className="text-sm font-medium text-ink">Счета оплаты</div>
              <div className="text-xs text-ink-muted">
                Как считать поступления на каждый расчётный счёт. Приходный кассовый ордер всегда
                наличные. «Мимо ОФД» — Click, Payme и всё, что в фискальный чек не входит.
              </div>
              {orgAccounts.length === 0 ? (
                <div className="text-xs text-ink-subtle">
                  Счета юрлиц не загрузились. Проверьте связь с МойСклад и откройте Настройки снова.
                </div>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {orgAccounts.map((acc) => (
                    <div key={acc.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                      <div className="text-sm">
                        <div className="text-ink">
                          {acc.bankName || 'Банк не указан'} · <span className="font-mono">{acc.accountNumber}</span>
                        </div>
                        <div className="text-xs text-ink-muted">{acc.organizationName}</div>
                      </div>
                      <Select
                        className="w-56"
                        value={accountMapping[acc.id.toLowerCase()]?.type ?? ''}
                        onChange={(e) => void setAccountType(acc.id, e.target.value as PaymentKind | '')}
                      >
                        <option value="">— не привязан —</option>
                        <option value="card">Карта</option>
                        <option value="cash">Наличные</option>
                        <option value="exclude">Мимо ОФД (Click, Payme)</option>
                      </Select>
                    </div>
                  ))}
                </div>
              )}
              {demandSyncMsg && <div className="text-xs text-warning">{demandSyncMsg}</div>}
            </div>
          </>
        )}
      </Section>

      <Section title="Фискальный бэкенд">
        <Field label="Бэкенд">
          <Select
            value={form.fiscalBackend}
            onChange={(e) => setField('fiscalBackend', e.target.value as 'epos' | 'fiscaldrive')}
          >
            <option value="epos">E-POS Communicator (JSON-RPC :3448)</option>
            <option value="fiscaldrive">FiscalDriveService (REST :3449)</option>
          </Select>
          <div className="mt-1 text-xs text-ink-muted">
            Магазин 1 (Хонабод) — epos. Магазин 2 (Хазрати Имом) — fiscaldrive.
          </div>
        </Field>
      </Section>

      {form.fiscalBackend === 'epos' && (
        <Section title="EPOS Communicator">
          <Field label="URL">
            <Input
              value={form.eposCommunicatorUrl}
              onChange={(e) => setField('eposCommunicatorUrl', e.target.value)}
              placeholder="http://localhost:3448/rpc/api"
            />
            <div className="mt-1 text-xs text-ink-muted">
              JSON-RPC API: <code className="bg-surface-hover px-1 rounded">http://localhost:3448/rpc/api</code>
              <br />
              <span className="text-ink-muted/80">Подтверждён рабочим в 0.10.12 — корректно передаёт ИКПУ в ОФД, кешбэк начисляется.</span>
            </div>
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
            <span className="text-xs text-ink-muted">{eposTest}</span>
          </div>
        </Section>
      )}

      {form.fiscalBackend === 'fiscaldrive' && (
        <Section title="FiscalDriveService">
          <Field label="URL">
            <Input
              value={form.fiscalDriveBaseUrl}
              onChange={(e) => setField('fiscalDriveBaseUrl', e.target.value)}
              placeholder="http://localhost:3449"
            />
            <div className="mt-1 text-xs text-ink-muted">
              REST API FiscalDriveService. По умолчанию <code className="bg-surface-hover px-1 rounded">http://localhost:3449</code>.
            </div>
          </Field>
          <Field label="FactoryID (серийник ФМ)">
            <div className="flex gap-2">
              <Input
                value={form.fiscalDriveFactoryId}
                onChange={(e) => setField('fiscalDriveFactoryId', e.target.value)}
                placeholder="серийник с корпуса USB-ключа"
                className="flex-1"
              />
              <Button variant="secondary" size="sm" onClick={detectFdsFactoryId}>
                Авто
              </Button>
            </div>
            <div className="mt-1 text-xs text-ink-muted">
              Серийный номер USB-фискального модуля. Нажми «Авто» чтобы получить из /FiscalDrive/List.
            </div>
          </Field>
          {fdsDetectMsg && (
            <div className="col-span-1 md:col-span-2 text-xs text-ink-muted">{fdsDetectMsg}</div>
          )}
        </Section>
      )}

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
        <Field label="Режим подбора">
          <Select
            value={form.matcherMode}
            onChange={(e) =>
              setField(
                'matcherMode',
                e.target.value as 'auto' | 'classic' | 'holistic' | 'off',
              )
            }
          >
            <option value="auto">
              Авто (рекомендуется) — classic + holistic при провале
            </option>
            <option value="classic">
              Только classic — позиция-в-позицию (старое поведение)
            </option>
            <option value="holistic">
              Только holistic — всегда собирать целостно на сумму
            </option>
            <option value="off">
              Выключен — никакого авто-подбора, только ручной
            </option>
          </Select>
          <div className="mt-1 text-xs text-ink-muted">
            <strong>Авто</strong> сначала пробует classic (одна МС-позиция →
            один товар), а если в пуле нет подходящих кандидатов — переключается
            в <strong>holistic</strong>: подбирает товары совокупно на сумму
            всего чека (крупные + филлеры, точная сборка через DP). Это спасает
            кассира от ручного подбора когда склад «дырявый».
            <br />
            <strong>Только classic</strong> воспроизводит поведение до 0.10.30
            — при пустом пуле кассир увидит «не подобрано» и должен подобрать
            вручную через модалку.
          </div>
        </Field>
        <Field label="Допуск по сумме (тийины)">
          <Input
            type="number"
            min={0}
            value={form.matchToleranceTiyin}
            onChange={(e) => setField('matchToleranceTiyin', e.target.value)}
          />
          <div className="mt-1 text-xs text-ink-muted">
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
            min={MIN_MARKUP_PERCENT}
            max={500}
            value={form.markupPercent}
            onChange={(e) => setField('markupPercent', e.target.value)}
          />
          <div className="mt-1 text-xs text-ink-muted">
            К приходной цене из справочника добавляется эта наценка, потом
            начисляется НДС товара. По умолчанию <strong>10</strong>. Минимум{' '}
            <strong>{MIN_MARKUP_PERCENT}%</strong> — ниже подбор товаров
            почти перестаёт работать (замер: при 3% отсекается 88.5% склада,
            при 0% — 95.4%, потому что ни один товар не проходит по правилу
            «не продавать ниже себестоимости+5%»).
          </div>
        </Field>
        <Field label="Округление продажной цены до, сум">
          <Input
            type="number"
            min={1}
            value={form.roundUpToSum}
            onChange={(e) => setField('roundUpToSum', e.target.value)}
          />
          <div className="mt-1 text-xs text-ink-muted">
            Продажная цена округляется ВВЕРХ до этого шага.{' '}
            <strong>1000</strong> = 15 500 → 16 000, 667 450 → 668 000.{' '}
            <strong>100</strong> = до сотен. <strong>1</strong> = без округления.
          </div>
        </Field>
        <Field label="Ставка НДС для продаж, %">
          <Input
            type="number"
            min={0}
            max={50}
            value={form.defaultVatPercent}
            onChange={(e) => setField('defaultVatPercent', e.target.value)}
          />
          <div className="mt-1 text-xs text-ink-muted">
            Принудительная ставка НДС для <strong>всех</strong> позиций
            (независимо от того что указал поставщик в приходе).
            По умолчанию <strong>12</strong> — общий режим в РУз.
            Если магазин на упрощёнке — поставьте <strong>0</strong>.
            <br />
            Используется в расчёте продажной цены (×1.12), в НДС
            фискального чека и в payload Communicator.
          </div>
        </Field>
        <div className="md:col-span-2 rounded-md bg-canvas p-3 text-xs text-ink-muted">
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
          <div className="mt-1 text-xs text-ink-muted">
            Из-за округления вверх продажная цена систематически выше
            оригинальной. Если включить — программа применит скидку на
            позиции чтобы итог совпал 1-в-1. Скидка не опускает цену
            ниже себестоимости с НДС (приход × 1.12).
          </div>
        </Field>

        <Field label="Максимум штук одного товара в строке">
          <Input
            type="number"
            min={0}
            value={form.maxQtyPerLine}
            onChange={(e) => setField('maxQtyPerLine', e.target.value)}
          />
          <div className="mt-1 text-xs text-ink-muted">
            Сколько максимум штук одного товара подбор кладёт в одну строку.
            По умолчанию <strong>20</strong>. Без ограничения дешёвые приходы
            выедаются лавиной — доходило до 560 штук в чеке, и склад оставался
            без недорогих позиций, которыми набираются мелкие суммы.
            Ограничение мягкое: если чек иначе не собрать, подбор возьмёт
            больше и предупредит. <strong>0</strong> — без ограничения.
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
          <div className="mt-1 text-xs text-ink-muted">
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
          <div className="mt-1 text-xs text-ink-muted">
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
          <div className="mt-1 text-xs text-ink-muted">
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
                    ? 'text-xs text-success'
                    : 'text-xs text-danger'
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
          <span className="text-xs text-ink-muted">{updateMsg}</span>
        </div>
        <div className="col-span-1 md:col-span-2 text-xs text-ink-muted">
          Приложение само проверяет наличие новой версии при запуске.
          Кнопка выше делает это вручную.
        </div>
      </Section>

      <Section title="Режим разработчика">
        <div className="col-span-1 md:col-span-2 flex items-start justify-between gap-3">
          <div className="text-xs text-ink-muted max-w-2xl">
            Активирует диагностические функции (смена сервера на login screen,
            DEV-плашка в углу и т.п.). Требует администраторские учётные данные
            и PIN. Сбрасывается при закрытии программы.
          </div>
          {devUnlocked ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<Unlock size={14} className="text-warning" />}
              onClick={() => {
                lockDevMode()
                toast.success('Режим разработчика заблокирован')
              }}
            >
              Заблокировать
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<ShieldCheck size={14} />}
              onClick={() => setShowAdminModal(true)}
            >
              Активировать
            </Button>
          )}
        </div>
        {devUnlocked && (
          <div className="col-span-1 md:col-span-2 flex items-start gap-2 text-xs text-warning">
            <LockIcon size={12} className="mt-0.5" />
            <span>Режим активен. Диагностические функции доступны.</span>
          </div>
        )}
      </Section>

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 border-t border-border pt-4">
        <Button variant="primary" disabled={busy} onClick={save}>
          {busy ? 'Сохранение…' : 'Сохранить остальные настройки'}
        </Button>
        {saved && <span className="text-sm text-success">Сохранено</span>}
      </div>

      <AdminUnlockModal
        open={showAdminModal}
        onClose={() => setShowAdminModal(false)}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-surface p-5">
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">{children}</div>
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-medium text-ink-muted">{label}</span>
      {children}
    </label>
  )
}

/**
 * Цветной бейдж со статусом SSE-канала к inventory server.
 *  🟢 connected   — поток открыт, live-обновления приходят
 *  🟡 connecting  — handshake, ещё не получили первое событие
 *  🔴 disconnected— оборвалось, ждём backoff и retry
 *  ⚪ idle        — runtime ещё не запускался (remote выключен)
 */
function SseStatusBadge({
  status,
}: {
  status: 'connected' | 'disconnected' | 'connecting' | 'idle'
}) {
  const map: Record<typeof status, { dot: string; label: string; cls: string }> = {
    connected: {
      dot: '🟢',
      label: 'Live',
      cls: 'bg-success-soft text-success border-success/20',
    },
    connecting: {
      dot: '🟡',
      label: 'Подключаюсь…',
      cls: 'bg-warning-soft text-warning border-warning/20',
    },
    disconnected: {
      dot: '🔴',
      label: 'Нет связи',
      cls: 'bg-danger-soft text-danger border-danger/20',
    },
    idle: {
      dot: '⚪',
      label: 'Не запущен',
      cls: 'bg-canvas text-ink-muted border-border',
    },
  }
  const m = map[status]
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
      title={`SSE канал: ${m.label}`}
    >
      <span>{m.dot}</span>
      <span>{m.label}</span>
    </span>
  )
}
