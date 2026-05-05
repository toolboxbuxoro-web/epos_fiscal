# UX redesign план

Документ-памятка по переделке EPOS Fiscal Tauri-программы для конечных
пользователей (кассиров). Login + фильтр по открытой смене + дизайн-система.

Дата: 2026-05-05
Статус: ⏳ В работе

---

## Решения (зафиксированы)

| # | Что | Решение |
|---|---|---|
| 1 | **Длительность сессии** | До явного `Logout` — без авто-просрочки. После рестарта программы — silent re-auth по сохранённым creds (если ОФД-сервер пустит) |
| 2 | **Открытая смена** | Через МС API `retailshift?filter=retailStore=<id>;closeDate=null` — берём первую открытую смену магазина и фильтруем чеки по `retailShift.id` |
| 3 | **Дизайн направление** | Минималистичный «банковский» — Linear/Notion. Нейтральный (white/gray), цветные акценты только для статусов |
| 4 | **Кому видно Логи + Настройки** | Кассиру не показываем. В Layout-сайдбаре только: **Касса / Чеки / История**. Настройки и Логи — за «гайкой» внизу с PIN-входом или в отдельном dev-режиме (см. ниже «admin gate») |

## Полный flow

```
[Запуск программы]
       │
       ▼
[Layer 1: AppGate]  — проверяет, есть ли валидный shop_session
       │
       ├─ нет/протух → Login screen
       │                  │
       │                  ▼ POST /inventory/login {email, password}
       │              [server] → проверяет МС creds + ищет inv_shops
       │                  │
       │                  ▼ возвращает {shop, api_key, ms_basic, retailstore, employee}
       │              Tauri пишет всё в Settings (МС creds + shop)
       │              + помечает shop_session активной
       │
       └─ есть → MainLayout
                    │
                    ├ Header (магазин, кассир, статус смены, выйти, SSE-индикатор)
                    │
                    └ Sidebar (минимальный)
                       • Касса (главная) — очередь чеков ОТКРЫТОЙ смены
                       • Чеки — История фискализированных
                       • [гайка внизу] → Admin gate (PIN) → Настройки + Логи
```

## Login flow — детали

### Backend: `POST /api/v1/inventory/login`

**Body**: `{ email: string, password: string }`

**Логика**:
1. Look up `inv_shops` где `moysklad_login = email`. Если не найдено — 404 «Магазин не найден. Обратитесь к администратору».
2. Decrypt `moysklad_basic_encrypted` → получить базовые credentials.
3. Сравнить с `Buffer.from("${email}:${password}").base64`. Если совпало — пароль правильный (без обращения к МС API). Если нет — 401 «Неверный пароль».
4. Опционально: проверить через `GET api.moysklad.ru/context/employee` с этими creds — гарантирует что пароль не отозвали в МС. Делать раз при первом логине, не каждый раз.
5. Вернуть:
   ```json
   {
     "shop": { "id", "slug", "name", "organization_id" },
     "api_key": "epf_...",         // сырой ключ для дальнейших вызовов API
     "moysklad": {                  // те же поля что в /shop/me
       "login", "basic_credentials",
       "retailstore_id", "retailstore_name",
       "employee_id", "employee_name"
     }
   }
   ```

**NB**: api_key хранится bcrypt'ом, не возвращается. Для login возвращаем НОВЫЙ api_key (rotate на каждый логин)? Или храним отдельно... Простейший вариант: **api_key один на магазин, заведён админом, не возвращается через /login**. Login возвращает **JWT-сессию** на N часов / без срока, которая валидна вместо api_key для inventory-эндпоинтов.

**Финальное решение**: чтобы не дублировать auth-механизмы, **/login возвращает api_key открытым текстом** (это первый логин = регистрация устройства). Магазин знает свой ключ от админа, но мы не заставляем кассира его вводить — он уже в БД, мы возвращаем его «по доверенному каналу пароля».

⚠️ Альтернатива чище: ввести `inv_sessions` таблицу с JWT-токенами + refresh. Но это усложнение на 1 день работы. Phase A v1 — возвращаем api_key, Phase A v2 (если безопасность жмёт) — JWT.

### Tauri: Login screen

- Centered card, без сайдбара (`<LoginLayout>` отдельный)
- Поля: email + password + кнопка «Войти»
- Состояния:
  - idle — кнопка серая если поля пустые
  - busy — кнопка показывает spinner + блокирована
  - error — текст под кнопкой красным
- При успехе: пишет в settings → `navigate('/')`
- В settings пишутся все ключи как раньше: `MoyskladCredentials/RetailStoreId/EmployeeId/...`, плюс `InventoryRemoteEnabled=true`, `InventoryShopApiKey`, `InventoryServerUrl`.

### Settings → Logout

В header / dropdown «Выйти» — очищает все settings связанные с сессией:
- `MoyskladCredentials`, `MoyskladLogin`, `RetailStoreId/Name`, `EmployeeId/Name`
- `InventoryShopApiKey`, `InventoryShopSlug`
- НЕ трогает: `EposCommunicatorUrl`, `CompanyName`, `PrinterName` — это настройки **устройства**, не сессии

После logout → AppGate увидит отсутствие creds → Login screen.

### AppGate (новая компонента)

```tsx
function AppGate({ children }) {
  const [authed, setAuthed] = useState<boolean | null>(null)
  useEffect(() => {
    getSetting(SettingKey.MoyskladCredentials).then(c => setAuthed(!!c))
  }, [])
  if (authed === null) return <Splash />
  if (!authed) return <Login />
  return children
}
```

Работает поверх React Router — показывает Login если нет creds, иначе пропускает к роутам.

## Cashshift filter — детали

### Поток

1. Tauri при старте магазина (после login) → запрос `GET /entity/retailshift?filter=retailStore={id};closeDate=null&limit=1`
2. Если есть — храним `currentShift.id` + `currentShift.created` в memory + Settings (для оффлайн-фоллбэка)
3. Поллинг МС-чеков делает дополнительный фильтр `&filter=retailShift={meta-href}`
4. UI показывает в Header: «Смена открыта 09:32» (зелёная точка). Если нет открытой → «Смена закрыта» (серая). Кассир знает что чеки не появятся пока смена не открыта в МС.

### Edge cases

- **Магазин использует кассу не через МС** → смена не создаётся. Тогда `closeDate=null` всегда даёт 0 → чеки не отображаются. **Решение**: тоггл в шапке «Все чеки» (показывает за последние 24 часа без фильтра по retailShift). Полезно для пилотов.
- **Кассир закрыл смену → открыл новую** → currentShift.id обновится при следующем poll-цикле. Лаг до 30 сек ок.
- **Несколько активных смен** (теоретически возможно если касса баговая) → берём **самую свежую** (`order=created,desc`).

### Реализация

- Новая функция `MoyskladClient.getActiveShift(retailStoreId)` → `RetailShift | null`
- Поллер: после `formatMsMoment(cursor)` фильтра добавляет `&filter=retailShift=https://api.moysklad.ru/api/remap/1.2/entity/retailshift/{id}` если активная смена есть
- Если нет активной — поллер пропускает цикл с warning «Нет открытой смены, чеки не запрашиваю»
- В UI Header через `useShiftStatus` хук — реактивный, обновляется на тиках поллера

## Дизайн-система — детали

### Подход

Не используем тяжёлые UI-киты (MUI, Mantine). Берём **минималистичный домашний design system на Tailwind + лёгкие радикальные компоненты в стиле shadcn/ui**, но рубленые специально под наш кейс:

- 10 базовых компонентов (Button, Input, Select, Card, Modal, Badge, EmptyState, PageHeader, DataTable, Toast)
- Tailwind tokens заданы в `tailwind.config.ts`
- Иконки: **lucide-react** (плагин уже установлен в mytoolbox; добавляем в epos_fiscal)
- Утилита `cn()` (clsx + tailwind-merge) для compose классов

### Tokens (в `tailwind.config.ts`)

```ts
theme: {
  extend: {
    colors: {
      canvas: 'rgb(var(--canvas) / <alpha-value>)',     // #fafafa light, #0a0a0a dark
      surface: 'rgb(var(--surface) / <alpha-value>)',   // #ffffff
      border: 'rgb(var(--border) / <alpha-value>)',     // #e5e5e5
      ink: {
        DEFAULT: 'rgb(var(--ink) / <alpha-value>)',     // #0a0a0a primary text
        muted: 'rgb(var(--ink-muted) / <alpha-value>)', // #6b7280 secondary
        subtle: 'rgb(var(--ink-subtle) / <alpha-value>)', // #9ca3af tertiary
      },
      success: { DEFAULT: '#10b981', soft: '#ecfdf5' },
      warning: { DEFAULT: '#f59e0b', soft: '#fffbeb' },
      danger:  { DEFAULT: '#ef4444', soft: '#fef2f2' },
      info:    { DEFAULT: '#3b82f6', soft: '#eff6ff' },
    },
    fontFamily: {
      sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      mono: ['JetBrains Mono', 'monospace'],
    },
  }
}
```

CSS variables в `index.css` под light/dark theme:

```css
:root {
  --canvas: 250 250 250;
  --surface: 255 255 255;
  --border: 229 229 229;
  --ink: 10 10 10;
  --ink-muted: 107 114 128;
  --ink-subtle: 156 163 175;
}
.dark {
  --canvas: 10 10 10;
  --surface: 23 23 23;
  --border: 38 38 38;
  --ink: 250 250 250;
  --ink-muted: 163 163 163;
  --ink-subtle: 115 115 115;
}
```

### Spacing scale

Только степени 4: `4 8 12 16 24 32 48 64`. **Никаких** `p-[14px]` или `gap-[7px]`.

### Typography

- `text-display` — 30px / 700 — заголовок страницы (например «Касса»)
- `text-heading` — 18px / 600 — карточек
- `text-body` — 14px / 400 — основной
- `text-caption` — 12px / 500 — лейблы, hint

### Components контракт

```tsx
// src/components/ui/Button.tsx
<Button variant="primary | secondary | ghost | danger"
        size="sm | md | lg"
        loading={false}
        icon={<Receipt />}
        iconRight={<ArrowRight />}
        disabled />

// src/components/ui/Card.tsx
<Card>
  <Card.Header>
    <Card.Title>Чек 04551</Card.Title>
    <Card.Description>Пробит 17:28</Card.Description>
  </Card.Header>
  <Card.Body>...</Card.Body>
  <Card.Footer>...</Card.Footer>
</Card>

// src/components/ui/StatusBadge.tsx
<StatusBadge variant="success | warning | danger | info">
  Фискализирован
</StatusBadge>

// src/components/ui/EmptyState.tsx
<EmptyState
  icon={<Receipt />}
  title="Нет чеков в смене"
  description="Чеки появятся как только МС-касса пробьёт первый"
/>

// src/components/ui/PageHeader.tsx
<PageHeader
  title="Касса"
  subtitle="3 чека ожидают фискализации"
  action={<Button>Обновить</Button>}
/>

// src/components/ui/DataTable.tsx
<DataTable
  columns={[
    { key: 'name', label: 'Чек', cell: (r) => r.name },
    { key: 'sum', label: 'Сумма', cell: (r) => fmt(r.sum), align: 'right' },
  ]}
  rows={receipts}
  empty={<EmptyState ... />}
/>
```

### Иконки (Lucide)

Замены текущих эмодзи:

| Где | Сейчас | Будет |
|---|---|---|
| Status fiscalized | ✓ | `<Check size={16}>` |
| Status pending | ⏳ | `<Clock size={16}>` |
| Status error | ✗ | `<AlertCircle size={16}>` |
| Test mode banner | ⚠️ | `<TriangleAlert size={20}>` |
| 🟢 Live | 🟢 | `<Wifi size={14} />` (зелёный) |
| 🔴 Disconnected | 🔴 | `<WifiOff size={14} />` (красный) |
| 🔒 read-only | 🔒 | `<Lock size={14} />` |
| Привязка МС | 🔗 МС | `<Link2>` |
| Ротация ключа | 🔑 Ключ | `<KeyRound>` |
| Импорт | 📥 | `<Upload>` |
| Принтер | (нет) | `<Printer>` |
| Бейдж смены open | 🟢 | green dot + текст |

**Правило**: один и тот же концепт использует один и тот же icon во всём приложении. Если новый — добавь в `docs/ui-conventions.md`.

### Анимации

Только полезные:
- Hover на карточках/кнопках — `transition-colors duration-150`
- Появление модалки — `animate-in fade-in zoom-in-95`
- Toast — `animate-in slide-in-from-top`
- Skeleton loaders — `animate-pulse`

Никаких декоративных эффектов.

## Admin gate (для Логи/Настройки)

Кассиру не нужны эти экраны. Спрятать так:

- В сайдбаре только Касса/Чеки/История
- Внизу сайдбара — иконка `<Settings>` (gear)
- Клик → промпт «Введите PIN администратора»
- PIN хранится в Settings (можно установить впервые при инсталляции; default `1234`, требуем смены)
- После ввода открывается «Admin» секция: Настройки + Логи

В нашем `dev` режиме — PIN сразу пропускает (без проверки), удобно для отладки.

Хранится `SettingKey.AdminPin` (хеш), флаг `app.dev_mode` обходит.

## Сайдбар (новый)

```
┌─────────────────────┐
│  EPOS Fiscal        │  ← логотип / название
│  Toolbox-Хонабод    │  ← магазин
├─────────────────────┤
│ [⌘] Касса         3 │  ← очередь чеков, badge=кол-во pending
│ [⎘] Чеки           │  ← история фискализированных
├─────────────────────┤
│  Смена 09:32 ●     │  ← мини-индикатор смены
│  Кассир: Турсуной  │
├─────────────────────┤
│ [⚙] Admin           │  ← gear, ведёт за PIN-gate
│ [→] Выйти          │  ← logout
└─────────────────────┘
```

## Phases — конкретно

### Phase A — Login flow (2 ч)

- [ ] Backend: `POST /api/v1/inventory/login` в `routes/inventory.js` (без auth, в `shopRouter` ДО `requireShopApiKey`)
- [ ] Backend: `services/inventory/auth.js` с функцией `verifyShopCredentials(email, password)`
- [ ] Tauri: новая страница `src/routes/Login.tsx`
- [ ] Tauri: `<AppGate>` обёртка над всеми роутами в `App.tsx`
- [ ] Tauri: `signInWithMs(email, password)` в новом `src/lib/inventory/login.ts` — вызывает `/login`, пишет всё в settings
- [ ] Tauri: `signOut()` — очищает session-related settings
- [ ] Layout: header с кнопкой «Выйти»

### Phase B — Cashshift filter (1.5 ч)

- [ ] `MoyskladClient.getActiveShift(retailStoreId)` — GET retailshift с фильтром
- [ ] Тип `MsRetailShift` в `moysklad/types.ts`
- [ ] `Poller` хранит `activeShiftId`, обновляет на каждом тике (cheap GET)
- [ ] Если нет открытой — поллер skip + warning в логи
- [ ] Поллер фильтрует по `&filter=retailShift={meta}`
- [ ] Header: `useShiftStatus()` хук → бейдж «Смена открыта HH:MM» / «Смена закрыта»
- [ ] Очередь: тоггл «Все чеки» (по умолчанию off — только текущей смены)

### Phase C — Design system (3 ч)

- [ ] `package.json`: `lucide-react`, `clsx`, `tailwind-merge`
- [ ] `tailwind.config.ts`: tokens (canvas, surface, border, ink, status)
- [ ] `src/index.css`: CSS variables light/dark
- [ ] `src/lib/cn.ts`: `cn()` utility
- [ ] 10 компонентов в `src/components/ui/`:
  - Button, Input, Select, Textarea
  - Card (compound), Modal, Toast (через `react-hot-toast`)
  - Badge, StatusBadge
  - EmptyState, PageHeader, DataTable
- [ ] `<LoginLayout>` (без сайдбара) и `<AppLayout>` (sidebar+header)
- [ ] Иконки везде Lucide

### Phase D — Restyle (4 ч)

- [ ] `Layout.tsx` (новый): Sidebar + Header
- [ ] `Login.tsx`
- [ ] `Dashboard.tsx` (переименовать в `Cashier.tsx` или оставить)
- [ ] `Receipt.tsx` (детали чека)
- [ ] `Catalog.tsx` (read-only когда remote)
- [ ] `History.tsx`
- [ ] `Settings.tsx` (за admin gate)
- [ ] `Logs.tsx` (за admin gate)
- [ ] Убрать ВСЕ эмодзи

### Phase E — Conventions doc (30 мин)

- [ ] `docs/ui-conventions.md` — правила добавления страниц/компонентов/цветов/иконок
- [ ] Обновить CLAUDE.md, добавить ссылку на conventions

## Открытые вопросы

- Нужен ли DARK theme? Правил мало, можно одной строкой включить, по умолчанию off.
- Sound notifications когда новый чек прилетел? Минорная фича, отложим.
- Биометрия / PIN для входа кассира — отложим, сейчас login по МС-паролю достаточно.
