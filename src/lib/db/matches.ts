import { getDb, now } from './client'
import type {
  MatchItemRow,
  MatchRow,
  MatchStrategy,
  MilliQty,
  Tiyin,
} from './types'

export interface NewMatchItem {
  esf_item_id: number
  quantity: MilliQty
  price_tiyin: Tiyin
  vat_tiyin: Tiyin
}

export interface CreateMatchInput {
  ms_receipt_id: number
  strategy: MatchStrategy
  total_tiyin: Tiyin
  diff_tiyin: Tiyin
  items: NewMatchItem[]
}

/**
 * Создать подбор + позиции. Возвращает id подбора.
 *
 * Раньше тут был BEGIN/COMMIT/ROLLBACK, но в tauri-plugin-sql это не работает
 * как настоящая транзакция — каждый db.execute берёт свой коннект из пула,
 * BEGIN на нём бесполезен, а COMMIT падает с «cannot commit - no transaction
 * is active» если попадает на другой коннект. Это и ронял фискализацию.
 *
 * Теперь: создаём matches, затем match_items по очереди. Если что-то из
 * match_items упало — удаляем matches чтобы не оставлять сиротскую запись.
 * Это слабее ACID, но такого надёжного транзакционного API в tauri-plugin-sql
 * сейчас нет (без перехода на rust-side wrapper).
 */
export async function createMatch(input: CreateMatchInput): Promise<number> {
  const db = await getDb()
  const ts = now()

  const matchResult = await db.execute(
    `INSERT INTO matches (ms_receipt_id, strategy, total_tiyin, diff_tiyin, created_at)
     VALUES ($1,$2,$3,$4,$5)`,
    [input.ms_receipt_id, input.strategy, input.total_tiyin, input.diff_tiyin, ts],
  )
  const matchId = matchResult.lastInsertId ?? 0
  if (matchId === 0) {
    throw new Error('createMatch: SQLite не вернул lastInsertId')
  }

  try {
    for (const item of input.items) {
      await db.execute(
        `INSERT INTO match_items (match_id, esf_item_id, quantity, price_tiyin, vat_tiyin)
         VALUES ($1,$2,$3,$4,$5)`,
        [matchId, item.esf_item_id, item.quantity, item.price_tiyin, item.vat_tiyin],
      )
    }
    return matchId
  } catch (err) {
    // Откат вручную: убираем matches чтобы не остался без позиций.
    // Если этот DELETE тоже упадёт — пробрасываем оригинальную ошибку.
    try {
      await db.execute('DELETE FROM matches WHERE id = $1', [matchId])
    } catch {
      /* ignore — оригинальная ошибка важнее */
    }
    throw err
  }
}

export async function getMatch(id: number): Promise<MatchRow | null> {
  const db = await getDb()
  const rows = await db.select<MatchRow[]>('SELECT * FROM matches WHERE id = $1', [id])
  return rows[0] ?? null
}

export async function getMatchItems(matchId: number): Promise<MatchItemRow[]> {
  const db = await getDb()
  return db.select<MatchItemRow[]>(
    'SELECT * FROM match_items WHERE match_id = $1 ORDER BY id',
    [matchId],
  )
}

export async function getLatestMatchForReceipt(msReceiptId: number): Promise<MatchRow | null> {
  const db = await getDb()
  const rows = await db.select<MatchRow[]>(
    `SELECT * FROM matches WHERE ms_receipt_id = $1
     ORDER BY created_at DESC, id DESC LIMIT 1`,
    [msReceiptId],
  )
  return rows[0] ?? null
}

export async function approveMatch(id: number): Promise<void> {
  const db = await getDb()
  await db.execute('UPDATE matches SET approved_at = $1 WHERE id = $2', [now(), id])
}
