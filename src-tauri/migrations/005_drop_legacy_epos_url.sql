-- Migration 005: автоматически переключить EposCommunicatorUrl с legacy /uzpos на JSON-RPC.
--
-- В 0.10.8 удалена поддержка legacy /uzpos API в коде fiscalize. Магазины
-- которые раньше использовали http://localhost:8347/uzpos должны быть
-- переключены на http://localhost:3448/rpc/api иначе fiscalize упадёт при
-- попытке connect (старый порт уже не используется или возвращает другие
-- ответы которые JsonRpcEposClient не понимает).
--
-- Только если value содержит '/uzpos' — иначе не трогаем (юзер мог уже
-- настроить /rpc/api или кастомный URL).

UPDATE settings
SET value = 'http://localhost:3448/rpc/api'
WHERE key = 'epos.communicator_url'
  AND value LIKE '%/uzpos%';
