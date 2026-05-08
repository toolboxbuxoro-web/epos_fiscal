-- Migration 007: принудительный переход на JSON-RPC `/rpc/api`.
--
-- В 0.10.13 удалена поддержка legacy /uzpos в коде fiscalize. Если у
-- кого-то ещё остался URL с `/uzpos` (например auto-fallback не сработал
-- или установка свежая) — переключаем на JSON-RPC.
--
-- Подтверждено реальной фискализацией с TerminalID VG343420011189
-- в 0.10.12: JSON-RPC `/rpc/api` принимает наш payload и MXIK доходит
-- до ОФД, кешбэк начисляется покупателю.
--
-- Идемпотентно — если URL уже /rpc/api или кастомный, не трогаем.

UPDATE settings
SET value = 'http://localhost:3448/rpc/api'
WHERE key = 'epos.communicator_url'
  AND value LIKE '%/uzpos%';
