import { fetch } from '@tauri-apps/plugin-http'
import {
  formatMsMoment,
  type MsDemand,
  type MsEmployee,
  type MsListResponse,
  type MsCurrency,
  type MsOrganization,
  type MsOrganizationAccount,
  type MsPaymentDocument,
  type MsRetailDemand,
  type MsSaleDocument,
  type MsState,
  type MsStore,
  type MsVariant,
} from './types'

const BASE_URL = 'https://api.moysklad.ru/api/remap/1.2'

export class MoyskladError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown,
  ) {
    super(message)
    this.name = 'MoyskladError'
  }
}

/**
 * Закодировать login:password в base64 для Basic Auth.
 *
 * btoa(unescape(encodeURIComponent(...))) — стандартный приём для
 * корректной обработки не-ASCII символов в логине/пароле.
 */
export function makeBasicCredentials(login: string, password: string): string {
  return btoa(unescape(encodeURIComponent(`${login}:${password}`)))
}

export interface MoyskladClientOptions {
  /**
   * Один из двух:
   *   - `basic`: base64 от "login:password" — Authorization: Basic <basic>
   *   - `token`: Bearer токен — Authorization: Bearer <token>
   * Если оба — приоритет у `basic`.
   */
  basic?: string
  token?: string
  /** Кастомный fetch (для тестов). */
  fetchImpl?: typeof fetch
  /** Прерывание (AbortSignal). */
  signal?: AbortSignal
}

export class MoyskladClient {
  constructor(private readonly opts: MoyskladClientOptions) {
    if (!opts.basic && !opts.token) {
      throw new Error('MoyskladClient requires either `basic` or `token`')
    }
  }

  private authHeader(): string {
    if (this.opts.basic) return `Basic ${this.opts.basic}`
    return `Bearer ${this.opts.token}`
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const f = this.opts.fetchImpl ?? fetch
    const url = path.startsWith('http') ? path : `${BASE_URL}${path}`
    const headers = new Headers(init.headers)
    headers.set('Authorization', this.authHeader())
    headers.set('Accept', 'application/json;charset=utf-8')
    if (init.body && !headers.has('Content-Type')) {
      headers.set('Content-Type', 'application/json')
    }

    const res = await f(url, {
      ...init,
      headers,
      signal: init.signal ?? this.opts.signal,
    })

    // Читаем тело один раз — повторное чтение даёт "Body is disturbed or locked".
    const text = await res.text()
    let body: unknown = text
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        // оставляем text как есть
      }
    }

    if (!res.ok) {
      // Достаём осмысленное сообщение из ответа МойСклад, если есть.
      const errMsg =
        (body as { errors?: Array<{ error?: string }> })?.errors?.[0]?.error ??
        `MoySklad ${res.status} ${res.statusText} on ${path}`
      throw new MoyskladError(errMsg, res.status, body)
    }
    return body as T
  }

  // ── Отгрузки ────────────────────────────────────────────────

  /**
   * Отгрузки со склада кассы в выбранном статусе, изменённые после момента.
   * Для опроса: передаём курсор, получаем только новые и изменённые.
   *
   * Статус — это и есть сигнал «пробить»: отгрузка попадает в очередь, когда
   * её переводят в нужный статус (смена статуса двигает `updated`, поэтому
   * курсор её не пропустит). Склад отсекает чужие магазины: иначе касса
   * попыталась бы пробить отгрузку другого магазина через свою USB-карту.
   *
   * @param updatedFrom — epoch секунды
   * @param limit — максимум **100** за запрос.
   *
   * ⚠️ МС API: expand работает только при `limit ≤ 100`. Больше — expand
   * молча игнорируется, позиции придут ссылками без названий и ИКПУ, и
   * подбор скатится на худшую стратегию. Поэтому жёстко клампим в 100:
   * если накопилось больше (после простоя), опрос догонит за несколько
   * проходов по курсору.
   */
  async listRecentDemands(
    updatedFrom: number,
    storeId: string,
    stateId: string,
    limit = 100,
  ): Promise<MsDemand[]> {
    const params = new URLSearchParams()
    // Фильтры МойСклад API объединяются через `;` в одном параметре `filter`.
    params.set(
      'filter',
      [
        `updated>${formatMsMoment(updatedFrom)}`,
        `store=${BASE_URL}/entity/store/${storeId}`,
        `state=${BASE_URL}/entity/demand/metadata/states/${stateId}`,
      ].join(';'),
    )
    params.set('order', 'updated,asc')
    params.set('limit', String(Math.min(limit, 100)))
    params.set('expand', 'positions.assortment')

    const res = await this.request<MsListResponse<MsDemand>>(`/entity/demand?${params.toString()}`)
    return res.rows
  }

  /** Одна отгрузка по UUID с позициями. */
  async getDemand(id: string, expand = 'positions.assortment'): Promise<MsDemand> {
    const params = new URLSearchParams()
    if (expand) params.set('expand', expand)
    return this.request<MsDemand>(`/entity/demand/${id}?${params.toString()}`)
  }

  /**
   * Розничная продажа по UUID. Розницы больше нет, но старые чеки в базе
   * кассы — розничные, и позиции у них дотягиваются этим запросом.
   */
  async getRetailDemand(id: string, expand = 'positions.assortment'): Promise<MsRetailDemand> {
    const params = new URLSearchParams()
    if (expand) params.set('expand', expand)
    return this.request<MsRetailDemand>(`/entity/retaildemand/${id}?${params.toString()}`)
  }

  /**
   * Дотянуть документ продажи с позициями, каким бы он ни был: отгрузка
   * или старая розничная продажа. Тип берём из `meta.type` сохранённого
   * документа.
   */
  async getSaleDocument(doc: Pick<MsSaleDocument, 'id' | 'meta'>): Promise<MsSaleDocument> {
    return doc.meta?.type === 'retaildemand' ? this.getRetailDemand(doc.id) : this.getDemand(doc.id)
  }

  /**
   * Платежи, связанные с отгрузкой: приходные ордера и входящие платежи.
   *
   * В отгрузке лежат только ссылки, поэтому каждый платёж дотягиваем
   * отдельно — обычно их один-два. Нужны они целиком: сумма, отнесённая
   * именно к этой отгрузке, и расчётный счёт, по которому понятно, карта
   * это или наличные.
   */
  async listDemandPayments(demand: Pick<MsDemand, 'payments'>): Promise<MsPaymentDocument[]> {
    const refs = demand.payments ?? []
    return Promise.all(refs.map((ref) => this.request<MsPaymentDocument>(ref.meta.href)))
  }

  // ── Справочники для настройки кассы ─────────────────────────

  /** Склады аккаунта, без архивных. */
  async listStores(): Promise<MsStore[]> {
    const res = await this.request<MsListResponse<MsStore>>('/entity/store?limit=1000')
    return res.rows.filter((s) => s.archived !== true)
  }

  /** Статусы отгрузок, как их завели в МойСклад. */
  async listDemandStates(): Promise<MsState[]> {
    const res = await this.request<{ states?: MsState[] }>('/entity/demand/metadata')
    return res.states ?? []
  }

  /**
   * Расчётные счета всех юрлиц аккаунта — чтобы привязать каждый к типу
   * оплаты. Название юрлица прикладываем: у разных юрлиц бывают счета в
   * одном банке, и без него их не различить.
   */
  async listOrganizationAccounts(): Promise<Array<MsOrganizationAccount & { organizationName: string }>> {
    const res = await this.request<MsListResponse<MsOrganization>>(
      '/entity/organization?expand=accounts&limit=100',
    )
    const out: Array<MsOrganizationAccount & { organizationName: string }> = []
    for (const org of res.rows) {
      if (org.archived === true) continue
      const accounts = org.accounts && 'rows' in org.accounts ? org.accounts.rows : []
      for (const acc of accounts) out.push({ ...acc, organizationName: org.name })
    }
    return out
  }

  /**
   * Получить все модификации (variants) товара.
   *
   * Используется в `enrichWithVariants` для linked-ms: если в чеке пришёл
   * базовый товар (product) без characteristics, тянем модификации товара
   * и если ровно одна — берём её characteristics. Это даёт связку для
   * товаров где бухгалтер создал «карточку-обёртку» из 1 модификации.
   *
   * Лимит 100 — достаточно для типичного товара (модификаций обычно ≤20).
   */
  async listVariantsByProduct(productId: string): Promise<MsVariant[]> {
    const params = new URLSearchParams()
    params.set('filter', `productid=${productId}`)
    params.set('limit', '100')
    const res = await this.request<MsListResponse<MsVariant>>(
      `/entity/variant?${params.toString()}`,
    )
    return res.rows
  }

  /** Проверка валидности credentials. Возвращает информацию о текущем пользователе. */
  async getMe(): Promise<MsEmployee> {
    return this.request<MsEmployee>('/context/employee')
  }

  /**
   * Справочник валют аккаунта.
   *
   * Нужен, чтобы понять, В ЧЁМ выражена сумма чека. МойСклад отдаёт валюту
   * документа ссылкой, а сама сумма приходит в минорных единицах БАЗОВОЙ
   * валюты аккаунта. Пока база — сум, это тийины, и всё сходится. Если база
   * станет долларом, те же поля начнут означать центы, и чек на 500 000 сум
   * уедет в ОФД как ~4000 тийинов. Проверка валюты — единственный способ
   * заметить это до отправки, а не после.
   */
  async listCurrencies(): Promise<MsCurrency[]> {
    const res = await this.request<MsListResponse<MsCurrency>>('/entity/currency?limit=100')
    return res.rows
  }

  /** Получить активных сотрудников (кассиров). */
  async listEmployees(): Promise<MsEmployee[]> {
    const res = await this.request<MsListResponse<MsEmployee>>(
      '/entity/employee?limit=200',
    )
    return res.rows.filter((e) => e.archived !== true)
  }
}
