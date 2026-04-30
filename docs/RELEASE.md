# Сборка и публикация релизов

## Локальная сборка для macOS (на этой машине)

```bash
npm run build
```

Тауринская команда `tauri build`:
1. Собирает Vite в `dist/`
2. Собирает Rust в release-профиле (lto=true, codegen-units=1 — медленно, ~10 мин на первый раз)
3. Создаёт бандл

Результаты:
```
src-tauri/target/release/bundle/
├── dmg/EPOS Fiscal_0.1.0_<arch>.dmg
└── macos/EPOS Fiscal.app
```

`.dmg` — это инсталлятор, который можно отдать пользователю. `.app` — само приложение.

**Важно:** релизный билд **не подписан** Apple Developer ID. При первом запуске
macOS покажет предупреждение «Apple не смогла проверить, не содержит ли это приложение
вредоносного ПО». Решение:

- Либо ПКМ → «Открыть» → «Открыть» (одноразово на каждой машине)
- Либо купить Apple Developer ID (~$99/год) и подписать приложение

Подпись настраивается в `src-tauri/tauri.conf.json` → `bundle.macOS.signingIdentity`.

## Сборка для Windows (через GitHub Actions)

С macOS нельзя напрямую собрать `.exe` (без Docker / cargo-xwin).
Проще всего — собирать в облаке через GitHub Actions.

Файл `.github/workflows/release.yml` уже настроен. Алгоритм релиза:

1. Поправить версию:
   - `package.json` → `version`
   - `src-tauri/tauri.conf.json` → `version`
2. Закоммитить и запушить тег:
   ```bash
   git add -A
   git commit -m "release v0.2.0"
   git tag v0.2.0
   git push --tags
   ```
3. GitHub Actions запустит сборку для 4 платформ параллельно (~10–15 мин)
4. В разделе **Releases** появится draft с артефактами:
   - `EPOS_Fiscal_0.2.0_x64-setup.exe` (Windows installer)
   - `EPOS_Fiscal_0.2.0_aarch64.dmg` (macOS Apple Silicon)
   - `EPOS_Fiscal_0.2.0_x64.dmg` (macOS Intel)
   - `EPOS_Fiscal_0.2.0_amd64.AppImage` (Linux)
5. Опубликовать draft → раздать ссылку

## Auto-update (этап 8b — пока заглушка)

В `src-tauri/tauri.conf.json` плагин updater **выключен** (`"active": false`).
Чтобы включить:

### 1. Сгенерировать ключи подписи

```bash
npx @tauri-apps/cli signer generate -w ~/.tauri/epos-fiscal.key
```

Команда выведет публичный ключ в base64. Сохрани:
- Приватный ключ — в `~/.tauri/epos-fiscal.key` (НЕ КОММИТИТЬ)
- Публичный ключ — в `tauri.conf.json` → `plugins.updater.pubkey`

### 2. Настроить endpoint

В `tauri.conf.json` → `plugins.updater.endpoints` укажи URL вида:

```
https://github.com/<user>/<repo>/releases/latest/download/latest.json
```

или свой сервер с JSON-манифестом обновлений.

### 3. Включить

```json
"plugins": {
  "updater": {
    "active": true,
    ...
  }
}
```

### 4. Подписывать релизы

В GitHub Actions раскомментировать в `release.yml`:

```yaml
TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
```

И добавить в репозиторий два секрета:
- `TAURI_SIGNING_PRIVATE_KEY` — содержимое приватного ключа
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пароль (если задан при `signer generate`)

При следующей сборке Tauri автоматически создаст `latest.json` с подписью,
и приложение начнёт проверять обновления при запуске.

## Подпись приложения

| Платформа | Что нужно | Стоимость |
|---|---|---|
| **Windows** | Code Signing Certificate (DigiCert / Sectigo) | от $200/год |
| **macOS** | Apple Developer ID Application certificate | $99/год |
| **Linux** | Не требуется | — |

Для внутреннего инструмента **можно работать без подписи** — пользователь
один раз подтвердит «Открыть всё равно» и дальше будет работать как обычно.
