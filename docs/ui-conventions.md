# UI Conventions — EPOS Fiscal

Правила для разработчиков и AI-ассистентов. Соблюдай их когда добавляешь
новый экран, компонент, цвет или иконку. Они дают единообразие интерфейса
без отдельной библиотеки UI.

> **Если ты AI-ассистент** — прочитай этот файл прежде чем менять `src/components/*`,
> `src/routes/*` или Tailwind-конфиг. Он отвечает на вопросы:
> «какой компонент использовать», «как назвать цвет», «можно ли inline-стиль».

---

## 1. Дизайн направление

**Минималистичный «банковский»**: нейтральная палитра, тонкие линии,
цветные акценты ТОЛЬКО для статусов. Ориентир: Linear / Notion / Stripe.

Что НЕ делаем:
- ❌ Мультяшные эмодзи (`✓` `✗` `⚠️` `🟢` `🔒` `📥`) в JSX
- ❌ Декоративные эффекты (gradient borders, glowing shadows, bouncy анимации)
- ❌ Иллюстрации с человечками / 3D-объекты
- ❌ Цветные бейджи без причины (бейдж = состояние, не украшение)

Что делаем:
- ✅ Lucide-react иконки (16/20/24px) везде где смысл нуждается в иконке
- ✅ Семантические токены (`bg-success-soft`, не `bg-green-100`)
- ✅ Минимум цвета: интерфейс серый, цвет = информация о состоянии
- ✅ Tabular-nums для чисел в таблицах

---

## 2. Tokens (цвета и типографика)

Всё определено в `tailwind.config.ts` и `src/index.css` (CSS variables).
Никогда не пиши raw цвет в JSX (`bg-slate-50`, `text-emerald-600`, `#fafafa`).

### Палитра — semantic, не описательная

| Token | Использование |
|---|---|
| `bg-canvas` | Фон страницы (background главного container) |
| `bg-surface` | Фон карточек, модалок, dropdown |
| `bg-surface-hover` | Hover-состояние строк/табов/секций |
| `border-border` | Тонкие линии разделителей |
| `border-border-strong` | Focus rings, выделенные обводки |
| `text-ink` | Основной текст |
| `text-ink-muted` | Вторичный текст (подписи, меньше важно) |
| `text-ink-subtle` | Подсказки, placeholder, disabled |
| `text-ink-inverse` | Текст на тёмных фонах (primary buttons) |
| `bg-primary` / `text-primary` | Главный action (нейтральный почти-чёрный) |
| `bg-primary-soft` | Tonal action / hover |

### Семантические статусы

Каждый статус имеет `.DEFAULT` (для иконок/бордеров) и `.soft` (для backgrounds):

| Token | Когда |
|---|---|
| `success` / `success-soft` | Успех, фискализация прошла, активная смена, online |
| `warning` / `warning-soft` | Внимание, подбор не идеален, смена не открыта |
| `danger` / `danger-soft` | Ошибка, недостача, deleted |
| `info` / `info-soft` | Подсказка, нейтральная информация, loading |

### Типографика

Используй **семантические размеры**, не raw `text-2xl`:

| Token | Где |
|---|---|
| `text-display` | Заголовок страницы (`<PageHeader title>`) |
| `text-heading` | Карточки, модальные окна, секции |
| `text-body` | Основной контент (default) |
| `text-caption` | Лейблы, метки, hint, badge |

---

## 3. Spacing scale

Только стандартная Tailwind шкала: `4 8 12 16 20 24 32 40 48 64`.

❌ **Запрещено**: `p-[14px]`, `gap-[7px]`, `mt-[18px]` — любой arbitrary value.

Если нужно «между» — выбери ближайшее. 14px → `p-3` (12px) или `p-4` (16px),
не середина.

---

## 4. Иконки — Lucide

```tsx
import { Receipt, Check, AlertCircle, Clock } from 'lucide-react'
```

### Размеры

| Размер | Где |
|---|---|
| `12px` | Inside Badge / StatusBadge |
| `14-16px` | Кнопки, маленькие списки |
| `18-20px` | Заголовки, header navigation |
| `24-28px` | PageHeader, EmptyState, hero |
| `32-40px` | EmptyState centerpiece |

### Соответствия (концепт → иконка)

Если добавляешь новый смысл — выбери иконку и **запиши тут** чтобы AI и
другие разработчики использовали ту же:

| Концепт | Lucide |
|---|---|
| Чек / receipt | `Receipt` |
| Магазин | `Store` |
| Кассир / пользователь | `User` |
| Смена / время | `Clock` |
| Успех | `Check` или `CheckCircle2` |
| Ошибка | `AlertCircle` |
| Предупреждение | `AlertTriangle` или `TriangleAlert` |
| Информация / подсказка | `Info` |
| Loading | `Loader2` (`animate-spin`) |
| SSE Live | `Wifi` |
| SSE Disconnected | `WifiOff` |
| Импорт Excel | `Upload` |
| Скачивание | `Download` |
| Печать | `Printer` |
| Настройки | `Settings` |
| Логи | `FileText` |
| Каталог приходов | `Package` |
| История | `History` |
| Войти | `LogIn` |
| Выйти | `LogOut` |
| Привязка / link | `Link2` |
| Ключ | `KeyRound` |
| Пробить чек / отправить | `ArrowRight` или `Send` |
| Замок (read-only) | `Lock` |
| Refresh | `RefreshCcw` |
| Закрыть | `X` |

Эмодзи в коде = баг. Если хочется emoji — замени на Lucide-icon ИЛИ удали.

---

## 5. Компоненты — где брать

Импорт из единой точки:
```tsx
import { Button, Card, Field, Input, StatusBadge, toast } from '@/components/ui'
```

| Что хочешь | Используй |
|---|---|
| Кнопка | `<Button variant size loading icon iconRight />` |
| Текстовое поле + label + error | `<Field label hint error><Input /></Field>` |
| Выпадающий список | `<Field><Select>...</Select></Field>` |
| Контейнер с заголовком | `<Card><Card.Header>...<Card.Body>...</Card>` |
| Бейдж со статусом | `<StatusBadge status="success">Готов</StatusBadge>` |
| Кастомный бейдж | `<Badge variant="info" icon={<Clock size={12} />}>...</Badge>` |
| Пустое состояние | `<EmptyState icon title description action />` |
| Шапка страницы | `<PageHeader title subtitle action icon />` |
| Модалка | `<Modal open onClose title children footer />` |
| Таблица | `<DataTable columns rows rowKey empty onRowClick />` |
| Уведомление | `toast.success("Сохранено")` / `toast.error(...)` |

### НЕ создавай самописное

Если в `src/components/ui/` есть подходящий компонент — используй его.
Не пиши свой `<button>` с inline стилями — даже один раз превращает 1
шаблон в 2 (а через 3 итерации в 12).

### Когда добавляешь новый ui-компонент

1. Имя файла: `<Name>.tsx` в `src/components/ui/`
2. `forwardRef` если это input-like
3. Принимает `className` и пропускает через `cn()` в самом конце
4. Использует только tokens (никаких raw цветов)
5. Документирует props через JSDoc
6. Экспорт в `src/components/ui/index.ts`
7. Обнови этот файл (раздел выше) — новая категория или новый компонент

---

## 6. Структура страницы (route)

Каждый файл в `src/routes/*` следует одному паттерну:

```tsx
import { PageHeader, Card, Button, EmptyState } from '@/components/ui'
import { Receipt, RefreshCcw } from 'lucide-react'

export default function MyPage() {
  // ... data fetching
  return (
    <div className="space-y-6">
      <PageHeader
        title="Название"
        subtitle="Подзаголовок (3 чека ожидают…)"
        icon={<Receipt size={24} />}
        action={<Button icon={<RefreshCcw size={14} />}>Обновить</Button>}
      />

      {/* Filters / toggles в горизонтальной полосе */}
      <div className="flex flex-wrap items-center gap-2">
        ...
      </div>

      {/* Контент в Card блоках или DataTable */}
      <Card>
        <Card.Body>
          {items.length === 0 ? (
            <EmptyState ... />
          ) : (
            <DataTable ... />
          )}
        </Card.Body>
      </Card>
    </div>
  )
}
```

Правила:
- Корневой div — `space-y-6` (вертикальные промежутки между блоками)
- НЕТ лишних кастомных wrapper'ов (`<section className="my-card">...`) — только наши компоненты
- НЕТ inline стилей (`style={{...}}`) кроме случаев где Tailwind не справляется (динамические значения через CSS variables)

---

## 7. Состояния (loading / empty / error)

Каждая страница со списком/данными должна показывать **3 состояния**:

```tsx
{error ? (
  <Card><Card.Body className="text-danger">{error}</Card.Body></Card>
) : loading ? (
  <DataTable loading rows={[]} columns={...} rowKey={...} />
) : items.length === 0 ? (
  <Card>
    <EmptyState
      icon={<Receipt size={36} className="text-ink-subtle" />}
      title="Нет чеков"
      description="Чеки появятся когда МС-касса пробьёт первый"
    />
  </Card>
) : (
  <DataTable rows={items} ... />
)}
```

Никогда не показывай пустую таблицу или undefined — это выглядит как баг.

---

## 8. Формы

Используй `<Field>` для каждого поля — он подкладывает label/hint/error:

```tsx
<form onSubmit={onSubmit} className="flex flex-col gap-4">
  <Field label="Email" htmlFor="email" required>
    <Input id="email" type="email" autoComplete="username" />
  </Field>
  <Field label="Пароль" htmlFor="password" error={errors.password}>
    <Input id="password" type="password" />
  </Field>
  <Button type="submit" variant="primary" loading={busy}>
    Войти
  </Button>
</form>
```

- Промежутки полей — `gap-4` (16px)
- `<Button type="submit">` — последним
- Loading state на submit-кнопке (`loading={busy}` — спиннер сам появится)

---

## 9. Toast

```tsx
import { toast } from '@/components/ui'

toast.success('Чек фискализирован')
toast.error('Не удалось подключиться')
const id = toast.loading('Сохраняю…')
toast.dismiss(id) // когда закончилось

// promise-обёртка для async-операций
toast.promise(saveAction(), {
  loading: 'Сохраняю…',
  success: 'Сохранено',
  error: (e) => `Ошибка: ${e.message}`,
})
```

Когда показывать toast:
- ✅ Успех мутации (создание, удаление, переименование)
- ✅ Сетевая ошибка (если она не отображается inline в форме)
- ❌ НЕ показывать toast при показе нормального error-состояния (например пустой результат поиска)

---

## 10. Доступность и UX-мелочи

- **Focus-visible** автоматический на всех элементах (CSS в `index.css`).
  Не отключай `outline` без причины.
- **autoComplete** — обязательно на login-полях (`username` / `current-password`).
- **autoFocus** — только на первом поле формы при mount.
- **disabled** — visually faded (`opacity-50` в наших токенах). НЕ скрывай элемент когда он disabled — пользователю понятнее.
- **loading** на кнопках (≥1 сек ожидания) — `loading={busy}`.
- **Error messages** — рядом с полем, не toast'ом для validation errors.

---

## 11. Когда нужен новый токен / цвет

Сценарий: добавляешь функцию «уведомления» и хочешь голубой цвет иконки.

❌ Плохо:
```tsx
<Bell className="text-blue-500" />
```

✅ Хорошо:
```tsx
// 1. Если это «info» статус — используй существующий токен
<Bell className="text-info" />

// 2. Если это новая семантическая категория (например "highlight") — добавь:
//    в src/index.css:
//      :root { --highlight: 99 102 241; --highlight-soft: 238 242 255; }
//    в tailwind.config.ts:
//      colors.highlight: { DEFAULT: 'rgb(var(--highlight)/<alpha>)', soft: 'rgb(var(--highlight-soft)/<alpha>)' }
//    обнови этот файл (раздел 2)
//    тогда:
<Bell className="text-highlight" />
```

Никогда не пиши `text-blue-500` или `text-[#6366f1]` напрямую.

---

## 12. Структура папок

```
src/
  components/
    ui/              ← УВЕРСАЛЬНЫЕ компоненты, переиспользуемые везде
      Button.tsx
      Card.tsx
      ...
      index.ts       ← barrel export
    Layout.tsx       ← оболочка приложения (sidebar+header)
    AppGate.tsx      ← гарды для роутов
  routes/            ← страницы (1 файл = 1 route)
    Login.tsx
    Dashboard.tsx
    ...
  lib/               ← бизнес-логика без UI
    cn.ts            ← Tailwind class merge
    db/              ← БД
    moysklad/        ← клиент МС
    inventory/       ← клиент сервера mytoolbox
    ...
docs/
  ui-conventions.md  ← этот файл
  plans/             ← планы крупных изменений
```

Не клади визуальные компоненты вне `src/components/ui/`.
Не клади бизнес-логику внутри компонентов — выноси в `src/lib/*` и импортируй.

---

## 13. Что менять с осторожностью

- **`tailwind.config.ts` tokens** — изменение цвета влияет на ВСЕ места.
  Меняй когда уверен, и проверяй несколько ключевых страниц.
- **`src/index.css` CSS variables** — то же самое.
- **`src/components/ui/<Name>.tsx` API** — если меняешь props, проверь все
  места использования через `grep`.
- **Иконки concept → component map (раздел 4)** — не меняй назначения,
  расширяй. Если `Receipt` уже использовался для чеков, не меняй на `FileText`.
