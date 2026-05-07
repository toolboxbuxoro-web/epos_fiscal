-- Migration 006: откатить migration 005 которая ошибочно переключила
-- EposCommunicatorUrl с legacy /uzpos на JSON-RPC /rpc/api.
--
-- Причина:
--   В 0.10.8 я думал что legacy /uzpos баговый и не передаёт MXIK в ОФД.
--   На основании этой гипотезы migration 005 автоматически переключила
--   все магазины на JSON-RPC /rpc/api который мы реверсили из декомпиляции
--   F-Lab Market 6 и НИКОГДА не тестировали на реальном Communicator.
--
--   Прямое тестирование на public Communicator E-POS (3.23.4) показало:
--   legacy /uzpos РАБОТАЕТ ПРАВИЛЬНО — принимает classCode/packageCode
--   (camelCase) и корректно передаёт MXIK в ОФД (https://ofd.soliq.uz).
--
--   Реальный sale на test-сервер вернул FiscalSign и QR-ссылку, по которой
--   ОФД показал MXIK 08207001004000000 в чеке.
--
-- Поэтому возвращаемся на legacy. JSON-RPC оставлен как опциональный
-- путь — если кто-то осознанно поменяет URL в Settings.
--
-- Идемпотентно: если URL уже /uzpos или кастомный — не трогаем.

UPDATE settings
SET value = 'http://localhost:8347/uzpos'
WHERE key = 'epos.communicator_url'
  AND value = 'http://localhost:3448/rpc/api';
