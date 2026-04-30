# EPOS Fiscal

Помощник кассира для магазинов в Узбекистане. Принимает чеки из МойСклад,
автоматически подбирает товары с налоговыми приходами на нужную сумму
и фискализирует чек через EPOS Communicator → ОФД ГНК.

## Стек

- **Tauri 2** — десктоп-приложение (Windows / macOS / Linux)
- **React 18 + TypeScript + Vite** — UI
- **Tailwind CSS** — стили
- **SQLite** — локальная БД (приходы, чеки, журнал замен)

## Требования к разработке

- Node.js 18+
- Rust 1.75+ (для сборки Tauri)
- macOS / Windows / Linux

## Установка

```bash
npm install
```

Иконки приложения (для сборки `tauri build`) генерируются один раз
из исходного PNG:

```bash
npx @tauri-apps/cli icon path/to/logo.png
```

Это создаст `src-tauri/icons/*` в нужных форматах. Для `tauri dev`
иконки не обязательны.

## Запуск в режиме разработки

```bash
npm run dev
```

Tauri запустит Vite на `http://localhost:1420` и откроет окно приложения.

## Сборка

```bash
npm run build
```

На выходе — `.dmg` (macOS), `.msi` / `.exe` (Windows) или `.AppImage` / `.deb` (Linux)
в `src-tauri/target/release/bundle/`.

## Структура

```
src/                      ← React + TS (UI и клиентская логика)
  components/             ← общие React-компоненты
  routes/                 ← страницы (Dashboard, Receipt, Catalog, History, Settings)
  lib/                    ← (создаётся на этапе 2+)
    db/                   ← SQLite схема и клиент
    moysklad/             ← клиент API + поллер
    esf/                  ← источник приходов (Excel → e-faktura/didox)
    matcher/              ← алгоритм подбора чеков
    epos/                 ← фискализация (Manual → Communicator)
src-tauri/                ← Rust часть Tauri
  src/                    ← native-точка входа
  capabilities/           ← разрешения окна
  tauri.conf.json         ← конфиг приложения
docs/                     ← документация и спецификации
  external-apis/
    universal-communicator.md   ← API EPOS Communicator
```

## Этапы

- [x] **Этап 1** — bootstrap (Tauri 2 + React + TS + Tailwind)
- [x] **Этап 2** — SQLite + миграции + DAO (settings, esf_items, ms_receipts, matches, fiscal_receipts)
- [x] **Этап 3** — клиент МойСклад API + автоматический поллинг с курсором
- [x] **Этап 4** — импорт приходов из Excel (с автомаппингом колонок)
- [x] **Этап 5** — Matcher: 3 стратегии подбора (passthrough / price-bucket / multi-item)
- [x] **Этап 6** — EPOS Communicator адаптер + `fiscalize()`
- [x] **Этап 7** — UI: Dashboard, Receipt, Catalog, History, Settings
- [ ] **Этап 8** — упаковка в `.exe`, иконки, авто-обновления

## Первый запуск

1. `npm run dev` — открывается окно приложения.
2. **Настройки** → впишите токен МойСклад, реквизиты компании, проверьте `localhost:8347` Communicator.
3. **Справочник** → импортируйте Excel с приходами.
4. На **Очередь** появятся новые чеки из МойСклад (опрос раз в N секунд).
5. Откройте чек → проверьте подбор → «Фискализировать через EPOS» → данные уходят в Communicator → ОФД.

## Документация

- [API Universal Communicator](docs/external-apis/universal-communicator.md) —
  локальный фискальный сервис E-POS Systems.
