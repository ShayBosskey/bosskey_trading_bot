-- SHEFA's calendar: the upgrade goal she is working toward, and one row per day
-- with her target, what actually happened, and her own evaluation of it.
-- Lives in Postgres (not a JSON file) so it travels with every pg_dump/migration.
BEGIN;

CREATE TABLE IF NOT EXISTS shefa_goals (
    id          serial PRIMARY KEY,
    title       text          NOT NULL,
    target_usd  numeric(12,2) NOT NULL CHECK (target_usd > 0),  -- shefa_fund balance to reach
    deadline    date          NOT NULL,
    active      boolean       NOT NULL DEFAULT true,
    created_at  timestamptz   NOT NULL DEFAULT now()
);
-- At most one active goal at a time.
CREATE UNIQUE INDEX IF NOT EXISTS shefa_goals_one_active ON shefa_goals (active) WHERE active;

INSERT INTO shefa_goals (title, target_usd, deadline)
SELECT 'Hardware upgrade (Mac Mini)', 600.00, DATE '2026-12-31'
WHERE NOT EXISTS (SELECT 1 FROM shefa_goals WHERE active);

CREATE TABLE IF NOT EXISTS shefa_milestones (
    target_date        date          PRIMARY KEY,
    goal_id            integer       REFERENCES shefa_goals(id),
    -- Dollar figures are computed by StrategySync.js (Node), never by the model.
    target_net_profit  numeric(12,2) NOT NULL,   -- trading net SHEFA aims to settle that day
    target_fund_total  numeric(12,2) NOT NULL,   -- where shefa_fund should stand that evening
    pace_weight        numeric(4,2)  NOT NULL DEFAULT 1.00
                       CHECK (pace_weight BETWEEN 0.25 AND 2.00),  -- model's relative effort for the day
    focus              text,                       -- model's micro-target for the day
    actual_net_profit  numeric(12,2),
    actual_fund_total  numeric(12,2),
    status             text          NOT NULL DEFAULT 'PLANNED'
                       CHECK (status IN ('PLANNED', 'HIT', 'MISSED')),
    self_evaluation    text,
    model              text,
    planned_at         timestamptz   NOT NULL DEFAULT now(),
    evaluated_at       timestamptz
);

COMMIT;
