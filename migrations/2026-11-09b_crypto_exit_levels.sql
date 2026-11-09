-- PROPOSED, NOT YET APPLIED. Required by src/CryptoExitEngine.js: with no broker-side
-- brackets for crypto, each row must carry its own exit levels for the Pi to enforce.
BEGIN;
ALTER TABLE trade_analytics
    ADD COLUMN IF NOT EXISTS stop_price   numeric(20,8),
    ADD COLUMN IF NOT EXISTS target_price numeric(20,8);
COMMIT;
