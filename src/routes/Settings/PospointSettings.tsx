/**
 * Настройки Pospoint: адрес программы, ключ кассы, проверки и журнал
 * попыток с неизвестным исходом.
 *
 * «Проверить подключение» — жива ли программа и принимает ли она ключ. Пока
 * касса не переключена на Pospoint, фискальный модуль НЕ трогаем: им ещё
 * пользуется старая программа (E-POS / FiscalDriveService), и два хозяина
 * одной карты — риск её заблокировать. После переключения — ещё и ФМ.
 *
 * «Пробный чек» — отправляет чек из настоящего товара склада с ПУБЛИЧНЫМ
 * тестовым ключом Pospoint: касса проверяет формат и отвечает случайными
 * данными, ФМ и ОФД не трогаются, у нас ничего не сохраняется. Так формат
 * проверяется до первого боевого чека.
 */

import { useEffect, useState } from 'react'
import { getSetting, listEsfItems, SettingKey } from '@/lib/db'
import { log } from '@/lib/log'
import { calculateSellingPrice } from '@/lib/matcher/strategies'
import {
  buildPospointSale,
  clearPendingAttempt,
  ensureUnits,
  listPendingAttempts,
  markPospointFmHandedOver,
  pickUnit,
  toUserError,
  type PendingAttempt,
  type PospointLine,
} from '@/lib/epos/pospoint'
import {
  POSPOINT_DEFAULT_URL,
  POSPOINT_TEST_KEY,
  PospointClient,
  PospointError,
} from '@/lib/epos/pospoint-client'
import { describeSettleResult, settlePendingAttempt } from '@/lib/epos/pospoint-settle'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

interface Props {
  url: string
  apiKey: string
  onUrl: (v: string) => void
  onKey: (v: string) => void
}

function describe(e: unknown): string {
  const user = toUserError(e, 'shift')
  if (user !== e) return user.message
  if (e instanceof PospointError) return e.message
  return e instanceof Error ? e.message : String(e)
}

function formatAt(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU')
}

export function PospointSettings({ url, apiKey, onUrl, onKey }: Props) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [pending, setPending] = useState<Array<[string, PendingAttempt]>>([])

  async function reloadPending() {
    setPending(await listPendingAttempts().catch(() => []))
  }

  useEffect(() => {
    void reloadPending()
  }, [])

  async function check() {
    setBusy(true)
    setMsg('Проверяю…')
    try {
      const key = apiKey.trim()
      const client = new PospointClient({ baseUrl: url, key })
      if (!(await client.health())) {
        setMsg(
          `Pospoint не отвечает по адресу ${client.baseUrl}. Откройте программу, войдите и включите «Режим интеграции» и «Использовать локальный адрес». Если они уже включены — выключите и включите «Режим интеграции» снова.`,
        )
        return
      }
      if (!key) {
        setMsg('✓ Pospoint отвечает. Ключ кассы не задан — без него чеки не пробьются.')
        return
      }
      if (key === POSPOINT_TEST_KEY) {
        setMsg('Pospoint отвечает, но это тестовый ключ из документации — с ним чеки не фискализируются.')
        return
      }
      // Ключ проверяем поиском чека: ответ из базы Pospoint, без ФМ.
      await client.getReceiptByPayCheckNumber('key-check')
      const switched = (await getSetting(SettingKey.FiscalBackend)) === 'pospoint'
      if (!switched) {
        setMsg(
          '✓ Pospoint отвечает и принимает ключ. Фискальный модуль проверится после переключения кассы ' +
            '(сейчас им пользуется старая программа).',
        )
        return
      }
      const fm = await client.checkFmStatus()
      // Кассир сам проверил ФМ через Pospoint — дальше его смотрит и фон.
      await markPospointFmHandedOver()
      setMsg(
        fm.isConnected
          ? `✓ Pospoint отвечает, ключ принят, фискальный модуль ${fm.terminalId ?? ''} подключён` +
              (fm.appletVersion ? ` (апплет ${fm.appletVersion})` : '') +
              (fm.unsentReceiptCount ? `, не отправлено в ОФД: ${fm.unsentReceiptCount}` : '')
          : 'Pospoint отвечает, но фискальный модуль не подключён — проверьте USB-ридер ФМ.',
      )
    } catch (e) {
      setMsg(describe(e))
    } finally {
      setBusy(false)
    }
  }

  async function testReceipt() {
    setBusy(true)
    setMsg('Отправляю пробный чек на тестовом ключе…')
    try {
      const client = new PospointClient({ baseUrl: url, key: POSPOINT_TEST_KEY })
      const items = await listEsfItems({ minAvailable: 1000, source: 'remote', limit: 200 })
      const it = items.find((i) => /^\d{17}$/.test(i.class_code ?? ''))
      if (!it) {
        setMsg(
          items.length
            ? 'У товаров склада нет ИКПУ из 17 цифр — такой чек Pospoint не примет. Исправьте приходы в админке.'
            : 'На складе нет товаров с остатком — не из чего собрать пробный чек.',
        )
        return
      }
      const price = calculateSellingPrice(it.unit_price_tiyin, 12, 10, 1000)
      const line: PospointLine = {
        esfItem: { ...it, vat_percent: 12 },
        quantity: 1000,
        priceTiyin: price,
        discountTiyin: 0,
      }
      // Справочник единиц — только из кэша: тестовый ключ его не обслуживает.
      const cache = await ensureUnits(client, [])
      const unit = pickUnit(cache, it.class_code, it.package_code)
      const sale = buildPospointSale({
        lines: [line],
        unitOf: () => unit,
        receivedCash: price,
        receivedCard: 0,
        payCheckNumber: `TEST-${Date.now()}`,
      })
      const answer = await client.registerSaleFull(sale.params)
      setMsg(
        `✓ Pospoint принял формат чека («${it.name}», ${price / 100} сум, единица «${unit.unit}»). ` +
          `Ответ тестовый (чек №${answer.id}) — в ОФД ничего не ушло.` +
          (unit.note ? ` Внимание: ${unit.note}.` : ''),
      )
    } catch (e) {
      setMsg(describe(e))
    } finally {
      setBusy(false)
    }
  }

  /** Спросить Pospoint об одной попытке: пробита — сохранить, нет — снять. */
  async function settleOne(payCheckNumber: string) {
    setBusy(true)
    setMsg(`Проверяю ${payCheckNumber}…`)
    try {
      setMsg(describeSettleResult(await settlePendingAttempt(payCheckNumber)))
    } catch (e) {
      setMsg(describe(e))
    } finally {
      await reloadPending()
      setBusy(false)
    }
  }

  async function dropPending(payCheckNumber: string, p: PendingAttempt) {
    const ok = confirm(
      p.fmMaySigned
        ? `Документ ${payCheckNumber}: фискальный модуль мог подписать чек без записи в Pospoint.\n\n` +
            'Снимайте, только если сверили в программе Pospoint и в кабинете налоговой, что чека нет. ' +
            'Иначе следующая попытка пробьёт ВТОРОЙ чек.\n\nСнять?'
        : `Снять попытку ${payCheckNumber}? Следующая попытка этого документа пробьётся без проверки прошлой.`,
    )
    if (!ok) return
    await clearPendingAttempt(payCheckNumber)
    await log.warn('fiscalize', `Pospoint: попытка ${payCheckNumber} снята вручную`, {
      kind: p.kind,
      at: new Date(p.at).toISOString(),
      fmMaySigned: !!p.fmMaySigned,
    })
    await reloadPending()
  }

  return (
    <>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-muted">Адрес</span>
        <Input value={url} onChange={(e) => onUrl(e.target.value)} placeholder={POSPOINT_DEFAULT_URL} />
        <span className="mt-1 block text-xs text-ink-muted">
          Pospoint на этом компьютере — {POSPOINT_DEFAULT_URL}. В программе должны быть включены
          «Режим интеграции» и «Использовать локальный адрес» (Общие настройки → Кассовый режим).
        </span>
      </label>
      <label className="block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-muted">Ключ кассы</span>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => onKey(e.target.value)}
          placeholder="выдаёт Pospoint при регистрации кассы"
          autoComplete="off"
        />
        <span className="mt-1 block text-xs text-ink-muted">
          У каждой кассы свой ключ. Без него чеки не пробиваются.
        </span>
      </label>
      <div className="col-span-1 md:col-span-2 flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={check} disabled={busy}>
          Проверить подключение
        </Button>
        <Button variant="secondary" size="sm" onClick={testReceipt} disabled={busy}>
          Пробный чек (без ФМ и ОФД)
        </Button>
      </div>
      {msg && <div className="col-span-1 md:col-span-2 text-xs text-ink-muted">{msg}</div>}

      {pending.length > 0 && (
        <div className="col-span-1 md:col-span-2 rounded-md border border-warning/30 bg-warning-soft p-3 text-xs">
          <div className="mb-2 font-medium">Незавершённые попытки (исход неизвестен)</div>
          <div className="mb-2 text-ink-muted">
            Касса не ответила, пробит ли документ. «Проверить» спросит Pospoint: пробит — чек сохранится, нет —
            попытка снимется. Фоновая проверка делает то же раз в 10 минут. «Снять» — только после сверки.
          </div>
          <ul className="space-y-1">
            {pending.map(([n, p]) => (
              <li key={n} className="flex flex-wrap items-center gap-2">
                <span className="font-mono">{n}</span>
                <span className="text-ink-muted">
                  {p.kind === 'sale' ? 'продажа' : 'возврат'}, {formatAt(p.at)}
                  {p.fmMaySigned ? ' — ФМ мог подписать, нужна сверка' : ''}
                </span>
                <Button variant="secondary" size="sm" onClick={() => void settleOne(n)} disabled={busy}>
                  Проверить
                </Button>
                <Button variant="ghost" size="sm" onClick={() => void dropPending(n, p)} disabled={busy}>
                  Снять
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}
