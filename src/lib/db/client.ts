import Database from '@tauri-apps/plugin-sql'

/**
 * Singleton-клиент SQLite-базы.
 *
 * Имя БД совпадает с миграцией в src-tauri/src/lib.rs: `sqlite:epos_fiscal.db`.
 * Файл лежит в каталоге $APPDATA приложения (определяется Tauri).
 */

let dbPromise: Promise<Database> | null = null

export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load('sqlite:epos_fiscal.db')
  }
  return dbPromise
}

/** Текущее unix-время в секундах. */
export function now(): number {
  return Math.floor(Date.now() / 1000)
}
