import { getDb, now } from './client'
import type { SettingKey, SettingRow } from './types'

/** Прочитать одно значение настройки. */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const db = await getDb()
  const rows = await db.select<SettingRow[]>(
    'SELECT key, value, updated_at FROM settings WHERE key = $1',
    [key],
  )
  return rows[0]?.value ?? null
}

/** Прочитать все настройки одним мапом. */
export async function getAllSettings(): Promise<Record<string, string>> {
  const db = await getDb()
  const rows = await db.select<SettingRow[]>(
    'SELECT key, value, updated_at FROM settings',
  )
  const result: Record<string, string> = {}
  for (const row of rows) {
    result[row.key] = row.value
  }
  return result
}

/** Записать (upsert) одно значение настройки. */
export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const db = await getDb()
  await db.execute(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, now()],
  )
}

/** Записать несколько настроек атомарно. */
export async function setSettings(values: Partial<Record<SettingKey, string>>): Promise<void> {
  const db = await getDb()
  const ts = now()
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue
    await db.execute(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, $3)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, ts],
    )
  }
}
