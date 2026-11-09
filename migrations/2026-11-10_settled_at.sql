-- Settlement sweeps every CLOSED row not yet settled, instead of "closed today".
-- Fixes weekend crypto closes (Settlement used to run Mon-Fri only) and back-dated
-- closes like WETO id 24, which a closed-today filter can never see.
BEGIN;
ALTER TABLE trade_analytics ADD COLUMN IF NOT EXISTS settled_at timestamptz;
-- All 38 rows closed before this migration are already reflected in capital_pots:
-- swept by Settlement (last run 2026-11-09 22:15, nothing closed since) or booked by
-- hand (WETO id 24). closed_at stands in for the settlement time we never recorded.
UPDATE trade_analytics SET settled_at = closed_at
 WHERE status = 'CLOSED' AND settled_at IS NULL;
CREATE INDEX IF NOT EXISTS trade_analytics_unsettled_idx
    ON trade_analytics (id) WHERE status = 'CLOSED' AND settled_at IS NULL;
COMMIT;
