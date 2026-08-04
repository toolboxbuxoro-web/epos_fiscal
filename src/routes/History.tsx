import { useEffect, useMemo, useRef, useState } from 'react'
import { formatErrorForUser } from '@/lib/error-message'
import { useNavigate } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Search, Undo2, X } from 'lucide-react'
import {
  backfillSearchText,
  countFiscalReceipts,
  getAllSettings,
  getRefundStatesMap,
  searchFiscalReceipts,
  SettingKey,
  type FiscalReceiptRow,
  type RefundState,
} from '@/lib/db'
import { formatDateTime, tiyinToSumDisplay } from '@/lib/format'
import {
  formatPrintDate,
  formatQtyForPrint,
  formatTiyinForPrint,
  printFiscalReceipt,
  type ReceiptData,
} from '@/lib/printer'
import { parseRequestJsonReceipt } from '@/lib/epos/request-json'
import { Button } from '@/components/ui/Button'

/** Сколько чеков на одной странице Истории. */
const PAGE_SIZE = 50

/**
 * Распарсить оплату из `fiscal_receipts.request_json` (это то что мы
 * отправили в Communicator). Поля payload в JSON-RPC у EPOS:
 *   Receipt.ReceivedCash — тийины наличными
 *   Receipt.ReceivedCard — тийины картой/QR (мы их складываем при отправке)
 *
 * Возвращаем структуру для UI:
 *   - cashTiyin, cardTiyin
 *   - total = cash + card
 *   - kind: 'cash' | 'card' | 'mixed' (по тому что > 0)
 *
 * Если JSON битый — возвращаем null, UI покажет прочерк. Это нормальный
 * сценарий для очень старых чеков, до миграции на JSON-RPC.
 */
function parsePayment(requestJson: string): {
  cashTiyin: number
  cardTiyin: number
  total: number
  kind: 'cash' | 'card' | 'mixed'
} | null {
  // Единый парсер: EPOS (params.Receipt) И FiscalDriveService ({receipt}).
  // Раньше знал только EPOS — у FDS-чеков колонки показывали прочерк.
  const norm = parseRequestJsonReceipt(requestJson)
  if (!norm) return null
  const cash = norm.receivedCashTiyin
  const card = norm.receivedCardTiyin
  if (cash === 0 && card === 0) return null
  let kind: 'cash' | 'card' | 'mixed'
  if (cash > 0 && card > 0) kind = 'mixed'
  else if (card > 0) kind = 'card'
  else kind = 'cash'
  return { cashTiyin: cash, cardTiyin: card, total: cash + card, kind }
}

// ── Даты фильтра ─────────────────────────────────────────────────
// <input type="date"> работает со строкой 'YYYY-MM-DD' в ЛОКАЛЬНОМ времени,
// а fiscalized_at в БД — epoch-секунды. Конвертируем через локальный
// конструктор Date: `new Date('2026-07-24')` распарсил бы строку как UTC и
// на UZT (+5) сдвинул бы границу периода на 5 часов.

/** Date → 'YYYY-MM-DD' (локальная дата) для value у <input type="date">. */
function toDateInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Строгая форма даты: `Number('')` даёт 0, поэтому split+isFinite мало. */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 'YYYY-MM-DD' → epoch-сек начала этого дня. Пустая/кривая строка → null. */
function dayStartEpoch(s: string): number | null {
  if (!DATE_RE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return Math.floor(new Date(y, m - 1, d, 0, 0, 0, 0).getTime() / 1000)
}

/** 'YYYY-MM-DD' → epoch-сек конца этого дня (день входит в период целиком). */
function dayEndEpoch(s: string): number | null {
  if (!DATE_RE.test(s)) return null
  const [y, m, d] = s.split('-').map(Number) as [number, number, number]
  return Math.floor(new Date(y, m - 1, d, 23, 59, 59, 999).getTime() / 1000)
}

export default function History() {
  const nav = useNavigate()
  const [rows, setRows] = useState<FiscalReceiptRow[]>([])
  /**
   * Состояние возврата по каждому fiscal_id:
   *   - не в Map     → возвратов нет, можно делать
   *   - 'partial'    → есть частичные, можно ещё (показываем «Частично», кнопка активна)
   *   - 'full'       → полностью возвращён, кнопка disabled
   */
  const [refundStates, setRefundStates] = useState<Map<number, RefundState>>(
    new Map(),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  /** id чека → сообщение результата перепечати (для inline-фидбека). */
  const [printMsg, setPrintMsg] = useState<Record<number, string>>({})
  /** id чека → busy-флаг (чтобы не дёргать дважды). */
  const [printing, setPrinting] = useState<Record<number, boolean>>({})
  /** Текущая страница (0-based). */
  const [page, setPage] = useState(0)
  /** Число чеков, подходящих под текущие фильтры (для пагинации и счётчика). */
  const [total, setTotal] = useState(0)

  // ── Поиск и фильтры ────────────────────────────────────────────
  /** Что кассир печатает прямо сейчас (обновляется на каждый символ). */
  const [query, setQuery] = useState('')
  /** Запрос с задержкой — в БД ходим только по нему, а не на каждый символ. */
  const [debouncedQuery, setDebouncedQuery] = useState('')
  /** Границы периода, как их отдаёт <input type="date"> — 'YYYY-MM-DD' или ''. */
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  /**
   * Номер последнего запущенного запроса. Ответы могут прийти не в том
   * порядке, в котором ушли (быстрый ввод) — применяем только самый свежий,
   * иначе в таблице окажется результат уже неактуального запроса.
   */
  const reqIdRef = useRef(0)

  // Debounce ввода: 250 мс тишины — и только тогда идём в БД.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query), 250)
    return () => clearTimeout(t)
  }, [query])

  /** Фильтры для DAO: даты → epoch-секунды (включая весь последний день). */
  const filters = useMemo(
    () => ({
      query: debouncedQuery,
      dateFrom: dayStartEpoch(dateFrom),
      dateTo: dayEndEpoch(dateTo),
    }),
    [debouncedQuery, dateFrom, dateTo],
  )
  const hasFilters =
    debouncedQuery.trim() !== '' || dateFrom !== '' || dateTo !== ''

  // Разовая дозаливка search_text для чеков, созданных до migration 014.
  // Идемпотентна и почти бесплатна после первого прохода (частичный индекс).
  // Обычно уже отработала на старте приложения (App.tsx) — здесь подстраховка
  // на случай, если Историю открыли раньше, чем она успела завершиться.
  useEffect(() => {
    void backfillSearchText()
      .then((n) => {
        // Что-то доиндексировали — перечитаем страницу, иначе кассир сразу
        // после обновления ищет и не находит уже проиндексированный чек.
        if (n > 0) void load()
      })
      .catch(() => {
        // Не критично: поиск по старым чекам их не найдёт, новые чеки
        // индексируются при вставке. Кассиру ошибку не показываем.
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, filters])

  async function load() {
    const reqId = ++reqIdRef.current
    setLoading(true)
    setError(null)
    try {
      const [list, count] = await Promise.all([
        searchFiscalReceipts(filters, PAGE_SIZE, page * PAGE_SIZE),
        countFiscalReceipts(filters),
      ])
      // Пока ждали — кассир успел изменить фильтр: этот ответ уже неактуален.
      if (reqId !== reqIdRef.current) return
      setRows(list)
      setTotal(count)
      // Bulk-проверка состояния возвратов: полный / частичный / нет.
      // - 'full'    → кнопка disabled, бейдж «Возвращён»
      // - 'partial' → кнопка активна (можно довозвратить), бейдж «Частично»
      // - отсутствует → кнопка активна, бейджа нет
      const states = await getRefundStatesMap(list.map((r) => r.id))
      if (reqId !== reqIdRef.current) return
      setRefundStates(states)
    } catch (e) {
      if (reqId !== reqIdRef.current) return
      setError(formatErrorForUser(e))
    } finally {
      if (reqId === reqIdRef.current) setLoading(false)
    }
  }

  /** Любое изменение фильтра сбрасывает пагинацию на первую страницу. */
  function applyQuery(v: string) {
    setQuery(v)
    setPage(0)
    // Очистку (крестик / Esc) применяем сразу, без debounce — ждать 250 мс
    // после явного «стереть» выглядит как подвисание.
    if (v === '') setDebouncedQuery('')
  }
  function applyDates(from: string, to: string) {
    setDateFrom(from)
    setDateTo(to)
    setPage(0)
  }
  function resetFilters() {
    setQuery('')
    setDebouncedQuery('')
    setDateFrom('')
    setDateTo('')
    setPage(0)
  }
  /** Пресет «последние N дней» (0 = только сегодня). */
  function applyDayPreset(days: number) {
    const today = new Date()
    const from = new Date()
    from.setDate(from.getDate() - days)
    applyDates(toDateInput(from), toDateInput(today))
  }

  // Кол-во страниц (минимум 1, чтобы «Страница 1 из 1» при пустой Истории).
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // Диапазон строк текущей страницы для подписи «11–20 из 134».
  const rangeFrom = total === 0 ? 0 : page * PAGE_SIZE + 1
  const rangeTo = Math.min(total, page * PAGE_SIZE + rows.length)

  /**
   * Перепечатать ранее фискализированный чек как копию ("Chek nusxasi").
   *
   * Реконструирует данные чека из request_json (это то что мы отправили
   * в Communicator — Items, ReceivedCash, ReceivedCard) + Settings
   * (реквизиты компании). Данные идентичны попавшим в ОФД, печатается
   * точная копия с QR.
   */
  async function reprintQr(receipt: FiscalReceiptRow) {
    setPrintMsg((m) => ({ ...m, [receipt.id]: '' }))
    setPrinting((p) => ({ ...p, [receipt.id]: true }))
    try {
      const settings = await getAllSettings()
      const printerName = settings[SettingKey.PrinterName]
      if (!printerName) {
        setPrintMsg((m) => ({
          ...m,
          [receipt.id]: '✗ Принтер не выбран в Настройках → Печать чека',
        }))
        return
      }

      const data = buildReceiptDataFromHistory(receipt, settings)
      const jobId = await printFiscalReceipt(printerName, data)
      setPrintMsg((m) => ({
        ...m,
        [receipt.id]: `✓ Копия отправлена (job #${jobId})`,
      }))
    } catch (e) {
      setPrintMsg((m) => ({
        ...m,
        [receipt.id]: `✗ ${e instanceof Error ? e.message : String(e)}`,
      }))
    } finally {
      setPrinting((p) => ({ ...p, [receipt.id]: false }))
    }
  }

  function parseFiscalDateTime(s: string): number {
    // Формат YYYYMMDDHHMMSS → epoch sec
    if (!/^\d{14}$/.test(s)) return 0
    const y = Number(s.slice(0, 4))
    const m = Number(s.slice(4, 6)) - 1
    const d = Number(s.slice(6, 8))
    const h = Number(s.slice(8, 10))
    const mi = Number(s.slice(10, 12))
    const se = Number(s.slice(12, 14))
    return Math.floor(Date.UTC(y, m, d, h, mi, se) / 1000)
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">История</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Чеки, фискализированные через EPOS Communicator.
        </p>
      </div>

      {error && (
        <div className="rounded-md border border-danger/20 bg-danger-soft p-3 text-sm text-danger">
          {error}
        </div>
      )}

      {/* Поиск и период. Всё фильтруется в SQL — в UI никогда не приезжает
          больше одной страницы чеков. */}
      <div className="space-y-3 rounded-lg border border-border bg-surface p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1">
            <Search
              size={15}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-subtle"
            />
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => applyQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') applyQuery('')
              }}
              placeholder="Товар, ИКПУ, № чека, фискальный признак…"
              className="w-full rounded-md border border-border bg-canvas py-1.5 pl-8 pr-8 text-sm outline-none placeholder:text-ink-subtle focus:border-ink-muted"
            />
            {query && (
              <button
                type="button"
                title="Очистить (Esc)"
                onClick={() => {
                  applyQuery('')
                  searchRef.current?.focus()
                }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-subtle hover:text-ink"
              >
                <X size={14} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-sm">
            <span className="text-ink-muted">с</span>
            <input
              type="date"
              value={dateFrom}
              max={dateTo || undefined}
              onChange={(e) => applyDates(e.target.value, dateTo)}
              className="rounded-md border border-border bg-canvas px-2 py-1.5 text-sm outline-none focus:border-ink-muted"
            />
            <span className="text-ink-muted">по</span>
            <input
              type="date"
              value={dateTo}
              min={dateFrom || undefined}
              onChange={(e) => applyDates(dateFrom, e.target.value)}
              className="rounded-md border border-border bg-canvas px-2 py-1.5 text-sm outline-none focus:border-ink-muted"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => applyDayPreset(0)}>
            Сегодня
          </Button>
          <Button variant="ghost" size="sm" onClick={() => applyDayPreset(6)}>
            7 дней
          </Button>
          <Button variant="ghost" size="sm" onClick={() => applyDayPreset(29)}>
            30 дней
          </Button>
          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              icon={<X size={12} />}
              onClick={resetFilters}
            >
              Сбросить
            </Button>
          )}
          <div className="ml-auto text-sm tabular-nums text-ink-muted">
            {loading
              ? 'Поиск…'
              : hasFilters
                ? `Найдено: ${total}`
                : `Всего чеков: ${total}`}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-border bg-surface">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-canvas">
            <tr>
              <Th>Время</Th>
              <Th>Терминал</Th>
              <Th>№ чека</Th>
              <Th>Фискальный признак</Th>
              <Th>Сумма</Th>
              <Th>Оплата</Th>
              <Th>QR</Th>
              <Th>Печать</Th>
              <Th>Возврат</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {loading && rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={9}>
                  Загрузка…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-3 py-8 text-center text-sm text-ink-muted" colSpan={9}>
                  {hasFilters ? (
                    <div className="space-y-2">
                      <div>По этому запросу ничего не найдено.</div>
                      <Button variant="ghost" size="sm" onClick={resetFilters}>
                        Сбросить фильтры
                      </Button>
                    </div>
                  ) : (
                    'Пока нет ни одного фискализированного чека.'
                  )}
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const refState = refundStates.get(r.id)
                const isFullyRefunded = refState === 'full'
                const isPartiallyRefunded = refState === 'partial'
                // Парсим request_json чтобы показать сумму и способ оплаты.
                // request_json — это payload который мы слали в EPOS (там
                // ReceivedCash + ReceivedCard). Сумма получается их склейкой.
                const pay = parsePayment(r.request_json)
                return (
                <tr key={r.id} className="hover:bg-canvas">
                  <Td>{formatDateTime(parseFiscalDateTime(r.fiscal_datetime) || r.fiscalized_at)}</Td>
                  <Td className="font-mono text-xs">{r.terminal_id}</Td>
                  <Td className="font-mono text-xs">{r.receipt_seq}</Td>
                  <Td className="font-mono text-xs">{r.fiscal_sign}</Td>
                  <Td className="text-right font-mono">
                    {pay ? (
                      <span>{tiyinToSumDisplay(pay.total)} сум</span>
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    {pay ? (
                      pay.kind === 'mixed' ? (
                        // Смешанная — детализируем: «Нал 200к + Карта 100к».
                        // Кассиру важно видеть как разделено (особенно когда
                        // часть была Click/Payme).
                        <div className="text-xs text-warning">
                          Смешанная
                          <div className="text-ink-muted">
                            нал {tiyinToSumDisplay(pay.cashTiyin)} +{' '}
                            карта {tiyinToSumDisplay(pay.cardTiyin)}
                          </div>
                        </div>
                      ) : pay.kind === 'card' ? (
                        <span className="text-ink-muted">Карта</span>
                      ) : (
                        <span className="text-ink-muted">Наличные</span>
                      )
                    ) : (
                      <span className="text-ink-subtle">—</span>
                    )}
                  </Td>
                  <Td>
                    <a
                      href={r.qr_code_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-ink-muted underline-offset-2 hover:underline"
                    >
                      открыть
                    </a>
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void reprintQr(r)}
                        disabled={!!printing[r.id]}
                      >
                        {printing[r.id] ? '…' : 'Печать QR'}
                      </Button>
                      {printMsg[r.id] && (
                        <span
                          className={
                            printMsg[r.id]?.startsWith('✓')
                              ? 'text-xs text-success'
                              : 'text-xs text-danger'
                          }
                        >
                          {printMsg[r.id]}
                        </span>
                      )}
                    </div>
                  </Td>
                  <Td>
                    {isFullyRefunded ? (
                      <span className="inline-flex items-center gap-1 rounded-md bg-danger-soft px-2 py-0.5 text-xs text-danger">
                        <Undo2 size={11} />
                        Возвращён
                      </span>
                    ) : isPartiallyRefunded ? (
                      <div className="flex items-center gap-2">
                        <span className="inline-flex items-center gap-1 rounded-md bg-warning-soft px-2 py-0.5 text-xs text-warning">
                          <Undo2 size={11} />
                          Частично
                        </span>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => nav(`/refund/${r.id}`)}
                          icon={<Undo2 size={12} />}
                          title="Довозвратить остаток"
                        >
                          Ещё
                        </Button>
                      </div>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Undo2 size={12} />}
                        onClick={() => nav(`/refund/${r.id}`)}
                      >
                        Возврат
                      </Button>
                    )}
                  </Td>
                </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Пагинация — показываем всегда когда есть хотя бы одна страница
          с данными. При total ≤ PAGE_SIZE кнопки disabled, но строка
          «N из M» полезна как индикатор сколько всего чеков. */}
      {total > 0 && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="text-sm text-ink-muted">
            {rangeFrom}–{rangeTo} из {total}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              icon={<ChevronLeft size={14} />}
              disabled={page <= 0 || loading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
            >
              Назад
            </Button>
            <span className="text-sm text-ink-muted tabular-nums select-none">
              Страница {page + 1} из {pageCount}
            </span>
            <Button
              variant="ghost"
              size="sm"
              iconRight={<ChevronRight size={14} />}
              disabled={page >= pageCount - 1 || loading}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Вперёд
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Реконструировать данные чека для повторной печати из БД.
 *
 * Источник позиций — это `request_json`, тот самый JSON, который мы
 * отправили в EPOS Communicator. То есть распечатается ТОЧНАЯ копия
 * того, что попало в ОФД.
 *
 * Поддерживаются два формата request_json:
 *   - JSON-RPC (Api.SendSaleReceipt) — params.Receipt с PascalCase полями
 *   - Legacy /uzpos — на верхнем уровне `params.items` с camelCase полями
 */
function buildReceiptDataFromHistory(
  receipt: FiscalReceiptRow,
  settings: Record<string, string>,
): ReceiptData {
  // Современные форматы (EPOS/FDS) разбирает parseRequestJsonReceipt,
  // ниже остался только тип для legacy /uzpos-чеков.
  type LegacyItem = {
    price?: number
    discount?: number
    vat?: number
    name?: string
    classCode?: string
    amount?: number
    vatPercent?: number
  }

  let items: ReceiptData['items'] = []
  let receivedCash = 0
  let receivedCard = 0
  try {
    const parsed = JSON.parse(receipt.request_json) as Record<string, unknown>

    // Современные форматы (EPOS params.Receipt / FDS {receipt}) — через единый
    // парсер. Заодно чинит ИКПУ на копиях: EPOS шлёт поле `spic`, а старый
    // код читал только `ClassCode` (пустой ИКПУ на перепечати).
    const norm = parseRequestJsonReceipt(receipt.request_json)
    if (norm) {
      items = norm.items.map((it) => ({
        name: it.name,
        class_code: it.classCode,
        qty_str: formatQtyForPrint(it.amount),
        price_str: formatTiyinForPrint(it.priceTiyin),
        discount_str:
          it.discountTiyin > 0 ? formatTiyinForPrint(it.discountTiyin) : '',
        vat_str: formatTiyinForPrint(it.vatTiyin),
        // Без дефолта в 12: наши payload всегда содержат VATPercent, а
        // «|| 12» ломал бы законный 0% (магазин на упрощёнке).
        vat_percent: it.vatPercent,
      }))
      receivedCash = norm.receivedCashTiyin
      receivedCard = norm.receivedCardTiyin
    } else {
      // Legacy /uzpos: { params: { items: [...], receivedCash, receivedCard } }
      const legacyParams = parsed?.params as
        | {
            items?: LegacyItem[]
            receivedCash?: number
            receivedCard?: number
          }
        | undefined
      if (legacyParams?.items) {
        items = legacyParams.items.map((it) => ({
          name: it.name ?? '',
          class_code: it.classCode ?? '',
          qty_str: formatQtyForPrint(it.amount ?? 1000),
          price_str: formatTiyinForPrint(it.price ?? 0),
          discount_str:
            (it.discount ?? 0) > 0
              ? formatTiyinForPrint(it.discount ?? 0)
              : '',
          vat_str: formatTiyinForPrint(it.vat ?? 0),
          vat_percent: it.vatPercent ?? 12,
        }))
        receivedCash = legacyParams.receivedCash ?? 0
        receivedCard = legacyParams.receivedCard ?? 0
      }
    }
  } catch {
    // request_json повреждён — печатаем хотя бы шапку и QR.
  }

  const totalTiyin = receivedCash + receivedCard
  // Сумма НДС оригинальная — берём из items, чтобы не делать отдельных пересчётов.
  // VAT там уже посчитан под продажную цену.
  const totalVatTiyin = items.reduce((s, it) => {
    // it.vat_str — строка типа "1 234.56"; парсим обратно.
    const num = Number.parseFloat(it.vat_str.replace(/\s/g, '')) * 100
    return s + (Number.isFinite(num) ? Math.round(num) : 0)
  }, 0)

  return {
    is_copy: true,
    company: {
      name: settings[SettingKey.CompanyName] ?? '',
      address: settings[SettingKey.CompanyAddress] ?? '',
      phone: settings[SettingKey.CompanyPhone] ?? '',
      inn: settings[SettingKey.CompanyInn] ?? '',
    },
    receipt_seq: receipt.receipt_seq,
    date_str: formatPrintDate(receipt.fiscal_datetime),
    items,
    total_str: formatTiyinForPrint(totalTiyin),
    total_vat_str: formatTiyinForPrint(totalVatTiyin),
    cash_str: formatTiyinForPrint(receivedCash),
    card_str: formatTiyinForPrint(receivedCard),
    // Тип карты — берём из БД (был выбран кассиром при первичной фискализации,
    // сохранён в migration 009). Для legacy-чеков до 009 — null, строка не
    // печатается. Для оплат чисто наличкой (receivedCard=0) тоже не печатаем.
    karta_turi: receivedCard > 0 ? (receipt.card_kind ?? '') : '',
    cashier: settings[SettingKey.MoyskladEmployeeName] ?? '',
    terminal_id: receipt.terminal_id,
    fiscal_sign: receipt.fiscal_sign,
    virtual_kassa: receipt.fiscal_datetime,
    qr_url: receipt.qr_code_url,
  }
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="px-3 py-2 text-left text-xs font-medium text-ink-muted">
      {children}
    </th>
  )
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`whitespace-nowrap px-3 py-2 ${className}`}>{children}</td>
}
