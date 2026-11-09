-- Crypto pivot: fractional quantities, sub-cent prices, pair symbols (e.g. "DOGE/USD"),
-- and per-row broker order IDs so exits pair to their own entry without time-window guessing.
BEGIN;
ALTER TABLE trade_analytics
    ALTER COLUMN qty        TYPE numeric(24,9),
    ALTER COLUMN buy_price  TYPE numeric(20,8),
    ALTER COLUMN sell_price TYPE numeric(20,8),
    ALTER COLUMN symbol     TYPE varchar(16),
    ADD COLUMN IF NOT EXISTS entry_order_id varchar(64),
    ADD COLUMN IF NOT EXISTS exit_order_id  varchar(64);
CREATE INDEX IF NOT EXISTS trade_analytics_status_idx ON trade_analytics (status);
COMMIT;
