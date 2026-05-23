# План стабилизации multi-shop при race-conditions и stale-cache

**Контекст:** Кассир Хонабод в 19:14 23.05.2026 получил «Остатки изменились»
на чеке 420 000 сум. Backend-исследование показало:
- 32 товара полностью consumed на сервере (available=0)
- На клиенте matcher выбирает их потому что **локальный кэш отстаёт от сервера**
- Reserve упирается в `inv_items_check` Postgres constraint
- Express отдаёт raw `err.message` в HTTP 500 теле → клиент детектит regex →
  бросает `InventoryStaleError`

## Корневые причины (root causes)

### RC1: Локальный SQLite `esf_items` отстаёт от Postgres `inv_items`

Сценарии когда это происходит:
1. **SSE-канал отвалился** (Wi-Fi мигнул, server reboot, timeout)
2. **Periodic sync gap** — раз в 5 мин, между ними окно
3. **Reconcile не отработал** (forceFull sync упал на partial)
4. **Multi-shop race** — другой магазин fiscalize'ит тот же товар в окно
   между нашим SELECT и reserve

### RC2: Backend возвращает 500 вместо structured 409

Express catch блок:
```js
catch (err) {
  console.error('POST /reserve error:', err);
  res.status(500).json({ error: err.message });  // ← raw stack trace!
}
```

Это означает что если Postgres constraint всё-таки фаерит (по any reason),
клиент получает 500 + `err.message` = "violates check constraint inv_items_check".

### RC3: matcher на клиенте не имеет server-side state

`loadMatcherPool` фильтрует по `available >= 1000` из локального SQLite.
Если SQLite показывает available=5 но сервер показывает available=0 →
matcher выбирает sold-out товар → reserve fail.

## План в 4 фазы

### Фаза A: Серверная сторона — structured errors

**A.1** В `routes/inventory.js::POST /reserve` (и /confirm/release/unconsume)
catch'ить Postgres constraint codes:

```js
catch (err) {
  if (err.code === '23514') {
    // CHECK constraint violation
    return res.status(409).json({
      ok: false,
      code: 'CONSTRAINT_VIOLATION',
      constraint: err.constraint,  // 'inv_items_check', 'inv_items_qty_reserved_check', и т.п.
      message: 'Сервер обнаружил несогласованность остатков. Кэш клиента устарел.',
      hint: 'force_sync_required',
    });
  }
  console.error('POST /reserve error:', err);
  res.status(500).json({ error: err.message });
}
```

Эффект: клиент получает **structured 409** с понятным кодом вместо
raw stack trace. Detection regex заменяется на проверку `code === 'CONSTRAINT_VIOLATION'`.

**A.2** В `reservations.js::reserve()` если SELECT FOR UPDATE прошёл но потом
UPDATE упал с constraint — значит **между SELECT и UPDATE в той же транзакции**
state изменился. Это не может быть от другой shop (FOR UPDATE блокирует),
значит баг или corrupted state. Логируем подробно для расследования:

```js
const stockBefore = stockById.get(it.inv_item_id);
try {
  await client.query('UPDATE inv_items SET qty_reserved = qty_reserved + $1 WHERE id = $2',
    [it.quantity, it.inv_item_id]);
} catch (err) {
  if (err.code === '23514') {
    console.error('CONSTRAINT FIRED ON RESERVE:', {
      inv_item_id: it.inv_item_id,
      stock_before_lock: stockBefore,
      requested_quantity: it.quantity,
      constraint: err.constraint,
    });
  }
  throw err;
}
```

### Фаза B: Клиентская сторона — preflight refresh

**B.1** В `tryRemoteReserve` ПЕРЕД основным `client.reserve()` запросом:

```ts
// 1. Refresh именно тех items которые мы собираемся резервировать
const itemIds = items.map(it => it.inv_item_id);
const fresh = await client.listItems({ ids: itemIds });

// 2. Сверяем с нашим планом
const insufficient = [];
for (const it of items) {
  const f = fresh.find(x => x.id === it.inv_item_id);
  if (!f || f.qty_received - f.qty_consumed - f.qty_reserved < it.quantity) {
    insufficient.push({
      inv_item_id: it.inv_item_id,
      requested: it.quantity,
      available: f ? f.qty_received - f.qty_consumed - f.qty_reserved : 0,
    });
  }
}

if (insufficient.length > 0) {
  // Локальный кэш отстал — не отправляем reserve. Обновляем кэш этих items
  // в SQLite + бросаем InventoryConflictError с конкретным failed[].
  await applyItemsUpdate(fresh.map(f => ({
    id: f.id,
    qty_received: f.qty_received,
    qty_consumed: f.qty_consumed,
    qty_reserved: f.qty_reserved,
    available: f.qty_received - f.qty_consumed - f.qty_reserved,
  })));
  throw new InventoryConflictError(insufficient);
}

// 3. Если preflight OK — отправляем reserve как и раньше
const resp = await client.reserve({ ms_receipt_id, items });
```

**Эффект:** preflight отлавливает 99% случаев когда наш кэш отстал.
Reserve дойдёт до сервера только если cache совпадает с server state
(или race-window 0.5 сек после preflight).

**Цена:** +1 HTTP GET на каждый reserve. На быстром Wi-Fi ~80мс — кассир
не заметит. Сэкономим 500мс на ROLLBACK + retry + sync.

**B.2** Backend `GET /items?ids=` endpoint — обновить чтобы поддерживал
filter по конкретным ids:

```js
shopRouter.get('/items', async (req, res) => {
  const ids = req.query.ids ? req.query.ids.split(',').map(Number) : undefined;
  // ... pass to itemsService.list({ ids, ...rest })
});
```

В `itemsService.list` добавить `if (ids) where.push('id = ANY($N::int[])')`.

### Фаза C: UI — индикатор stale-state

**C.1** В `App.tsx` или `Layout.tsx` показывать **bottom-corner badge**:
- 🟢 «Синхронизирован 5 сек назад» — SSE активен
- 🟡 «Синхронизирован 2 мин назад» — SSE отвалился, periodic работает
- 🔴 «Связь с сервером потеряна» — нет ни SSE ни sync >10 мин

Источник: state из `runtime.ts` (status SSE + last sync timestamp).

**C.2** В `Receipt.tsx` при открытии чека — если last sync > 60 сек назад,
автоматически делать forceFull sync ПРЕЖДЕ чем показать matched plan.

### Фаза D: Тесты — полигон для воспроизведения

См. файлы:
- `src/lib/epos/__tests__/fiscalize.race.test.ts` — race conditions
- `src/lib/epos/__tests__/fiscalize.stale.test.ts` — stale cache
- `src/lib/matcher/__tests__/excludes.test.ts` — exclude logic
- `src/lib/inventory/__tests__/preflight.test.ts` — preflight refresh

Тесты используют **mock InventoryServerClient** который симулирует:
- Успешный reserve
- 409 INSUFFICIENT_STOCK
- 500 с inv_items_check (legacy backend)
- 409 CONSTRAINT_VIOLATION (new backend after A.1)
- Network timeout
- Concurrent reserves (race условие через Promise.all)

## Приоритет

| Фаза | Польза | Сложность | Риск | Рекомендация |
|---|---|---|---|---|
| **B.1 (preflight)** | 🟢 Решает 90% случаев | Низкая | Низкая | **Сразу делать** |
| **A.1 (structured errors)** | 🟢 Чистый код клиента | Низкая | Низкая | **Сразу делать** |
| **D (тесты)** | 🟡 Регрессии не будут | Средняя | Нулевая | **Сразу делать** |
| **A.2 (server logs)** | 🟡 Расследование багов | Низкая | Нулевая | Можно сразу |
| **C.1 (status badge)** | 🟡 UX | Средняя | Низкая | Phase 2 |
| **C.2 (auto-sync on open)** | 🟡 UX | Низкая | Низкая | Сразу |

## Метрики успеха

После раскатки на 4 магазина:
- Доля чеков с InventoryStaleError → должно упасть с ~5% до <0.5%
- Среднее время фискализации с stale → было 5+ сек (с retry), станет <1 сек
- Кассир не должен видеть «Остатки изменились» в обычной работе

Метрики собираем через `shop_logs` таблицу (telemetry уже работает).
