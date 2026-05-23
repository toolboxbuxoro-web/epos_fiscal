/**
 * Vitest конфиг.
 *
 * Запуск:
 *   npx vitest run          — однократный прогон в CI-режиме
 *   npx vitest              — watch-mode для локальной разработки
 *   npx vitest --ui         — браузерный UI
 *
 * Файлы тестов: `**\/*.test.ts` рядом с тестируемыми модулями.
 */
import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    globals: true,
    environment: 'node', // нет DOM-зависимых тестов; для UI-тестов будет 'jsdom'
    include: ['src/**/*.test.ts'],
    // Tauri-плагины (@tauri-apps/plugin-http и т.п.) пытаются обратиться к
    // глобальному window.__TAURI__, которого нет в node-окружении. Их нужно
    // мокать в тестах.
  },
})
