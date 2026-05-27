-- Чеки на 0 сум (вся покупка за бонусные баллы / 100% скидка) — ОФД не
-- принимает товар на 0 сум, фискально это шум. Старые записи могли быть
-- сохранены со status='pending' до фикса в poller.ts (24.05.2026).
-- Помечаем их как not_required чтобы кассир их не видел в активном списке.
--
-- Только записи в статусе 'pending' (не трогаем уже fiscalized/failed —
-- они в особом флоу, не хотим вмешиваться задним числом).
UPDATE ms_receipts
   SET status = 'not_required',
       updated_at = strftime('%s', 'now')
 WHERE ms_sum_tiyin <= 0
   AND status = 'pending';
