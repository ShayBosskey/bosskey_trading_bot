-- SHEFA's hardware-upgrade fund: receives a share of realised profit at settlement.
-- Additive only; existing pots and balances are untouched.
BEGIN;
ALTER TABLE capital_pots
    ADD COLUMN IF NOT EXISTS shefa_fund numeric(10,2) NOT NULL DEFAULT 0.00;
COMMIT;
