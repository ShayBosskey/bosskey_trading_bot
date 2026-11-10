const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
const AIEngine = require('./AIEngine');
const attachGlobalErrorLogger = require('./ErrorHandler');
const { SHEFA_FUND_SHARE } = require('./PotSplit');

// SHEFA's daily strategy sync (cron, 22:30 - after Settlement's 22:15 run).
//
//   1. Evaluates today: how much trading net actually settled, against the target.
//   2. Re-plans the next 30 days toward the active goal in shefa_goals.
//
// Division of labour: the model returns only a relative effort weight and a focus
// note per day, plus a self-evaluation. Every dollar figure is computed here, so
// the plan always adds up to exactly what the goal needs however the model behaves.
// If the model fails entirely, the plan still runs with even weights.

const TZ = 'Europe/Zurich';
const HORIZON_DAYS = 30;
const RECENT_DAYS = 14;
const MIN_WEIGHT = 0.25;
const MAX_WEIGHT = 2.0;

// ---------- Pure helpers (unit-tested) ----------

function localDate(date = new Date(), timeZone = TZ) {
    // en-CA formats as YYYY-MM-DD.
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function addDays(dateStr, n) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
}

function daysBetween(fromStr, toStr) {
    return Math.round((Date.parse(`${toStr}T00:00:00Z`) - Date.parse(`${fromStr}T00:00:00Z`)) / 86_400_000);
}

const round2 = n => Math.round(n * 100) / 100;

function clampWeight(w) {
    const n = Number(w);
    if (!Number.isFinite(n)) return 1;
    return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, n));
}

function cleanText(text, max) {
    if (typeof text !== 'string') return null;
    // eslint-disable-next-line no-control-regex
    const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// Maps the model's day list onto the dates we asked for. Anything missing,
// misdated or malformed falls back to weight 1 and no focus note.
function alignPlan(dates, aiDays) {
    const byDate = new Map();
    if (Array.isArray(aiDays)) {
        for (const d of aiDays) if (d && typeof d.date === 'string') byDate.set(d.date.slice(0, 10), d);
    }
    return dates.map((date, i) => {
        // Small models often get the dates wrong but the order right: fall back to position.
        const d = byDate.get(date) || (Array.isArray(aiDays) && !byDate.size ? aiDays[i] : null);
        return { date, weight: clampWeight(d?.weight), focus: cleanText(d?.focus, 140) };
    });
}

// The arithmetic. The remaining fund is spread evenly over every day left until
// the deadline (not just the 30 shown), so the horizon carries exactly its share;
// within the horizon the model's weights shift effort between days without
// changing the total.
function computeTargets({ fund, goalUsd, today, deadline, plan, share = SHEFA_FUND_SHARE }) {
    const daysLeft = daysBetween(today, deadline); // tomorrow .. deadline inclusive
    if (daysLeft <= 0 || !plan.length) return { daysLeft: Math.max(0, daysLeft), requiredNetPerDay: 0, rows: [] };

    const remainingFund = Math.max(0, goalUsd - fund);
    const requiredNetPerDay = remainingFund / share / daysLeft;
    const totalWeight = plan.reduce((s, d) => s + d.weight, 0);

    let fundTotal = fund;
    const rows = plan.map(d => {
        const target = round2(requiredNetPerDay * d.weight * plan.length / totalWeight);
        fundTotal += target * share;
        return { ...d, targetNet: target, targetFundTotal: round2(fundTotal) };
    });
    return { daysLeft, requiredNetPerDay: round2(requiredNetPerDay), rows };
}

function judge(target, actual) {
    return actual >= target ? 'HIT' : 'MISSED';
}

// ---------- The job ----------

class StrategySync {
    constructor({ ai = new AIEngine(), now = () => new Date() } = {}) {
        this.db = new DatabaseClient();
        this.logger = new Logger('StrategySync');
        this.ai = ai;
        this.now = now;
    }

    async #settledNetByDay(fromDate, toDate) {
        const res = await this.db.client.query(
            `SELECT (settled_at AT TIME ZONE $1)::date::text AS day,
                    COALESCE(SUM(net_profit) FILTER (WHERE net_profit <> 'NaN'), 0)::float8 AS net,
                    COUNT(*)::int AS trades
               FROM trade_analytics
              WHERE status = 'CLOSED' AND settled_at IS NOT NULL
                AND (settled_at AT TIME ZONE $1)::date BETWEEN $2::date AND $3::date
              GROUP BY 1 ORDER BY 1`,
            [TZ, fromDate, toDate]
        );
        return res.rows.map(r => ({ date: r.day, net: Number(r.net), trades: r.trades }));
    }

    async run() {
        await this.db.connect();
        try {
            const goalRes = await this.db.client.query(
                `SELECT id, title, target_usd::float8 AS target, deadline::text AS deadline
                   FROM shefa_goals WHERE active LIMIT 1`
            );
            const goal = goalRes.rows[0];
            if (!goal) {
                await this.logger.log('No active goal in shefa_goals; nothing to plan.');
                return null;
            }

            const potsRes = await this.db.client.query('SELECT shefa_fund::float8 AS fund FROM capital_pots WHERE id = 1');
            const fund = Number(potsRes.rows[0]?.fund) || 0;
            const today = localDate(this.now());

            // 1. Today's result.
            const todayRes = await this.db.client.query(
                `SELECT target_net_profit::float8 AS target, status FROM shefa_milestones WHERE target_date = $1`,
                [today]
            );
            const todayRow = todayRes.rows[0];
            const recentDays = await this.#settledNetByDay(addDays(today, -(RECENT_DAYS - 1)), today);
            const todayActual = recentDays.find(d => d.date === today) || { net: 0, trades: 0 };
            const todayStatus = todayRow ? judge(todayRow.target, todayActual.net) : null;
            const todayLine = todayRow
                ? `target net +${todayRow.target.toFixed(2)}, settled net ${todayActual.net >= 0 ? '+' : ''}${todayActual.net.toFixed(2)} over ${todayActual.trades} trade(s): ${todayStatus}.`
                : 'no target was set for today (first day of planning).';

            // 2. Plan the horizon.
            const daysLeft = daysBetween(today, goal.deadline);
            const horizon = Math.min(HORIZON_DAYS, Math.max(0, daysLeft));
            const dates = Array.from({ length: horizon }, (_, i) => addDays(today, i + 1));
            const pct = goal.target > 0 ? (fund / goal.target) * 100 : 0;
            const evenPace = computeTargets({ fund, goalUsd: goal.target, today, deadline: goal.deadline, plan: dates.map(date => ({ date, weight: 1 })) });

            let ai = null;
            let model = 'none (fallback: even pace)';
            if (horizon > 0) {
                try {
                    ai = await this.ai.planMilestones({
                        goalTitle: goal.title,
                        deadline: goal.deadline,
                        daysLeft,
                        onTrack: `upgrade fund ${fund.toFixed(2)} of ${goal.target.toFixed(2)} USD (${pct.toFixed(1)}%); an even pace needs about +${evenPace.requiredNetPerDay.toFixed(2)} USD of trading net per day`,
                        today,
                        todayLine,
                        recentDays,
                        dates,
                    });
                    model = this.ai.lastModel || 'unknown';
                } catch (err) {
                    await this.logger.log(`Model planning failed (${err.message}); using an even pace with no focus notes.`);
                }
            }

            const plan = alignPlan(dates, ai?.days);
            const { rows, requiredNetPerDay } = computeTargets({ fund, goalUsd: goal.target, today, deadline: goal.deadline, plan });
            const evaluation = cleanText(ai?.evaluation, 400)
                || (todayRow ? `Today ${todayStatus === 'HIT' ? 'met' : 'missed'} its target (${todayLine})` : null);

            // 3. Write atomically: today's verdict and the refreshed plan together.
            await this.db.client.query('BEGIN');
            try {
                if (todayRow) {
                    await this.db.client.query(
                        `UPDATE shefa_milestones
                            SET actual_net_profit = $2, actual_fund_total = $3, status = $4,
                                self_evaluation = $5, evaluated_at = now()
                          WHERE target_date = $1`,
                        [today, round2(todayActual.net), round2(fund), todayStatus, evaluation]
                    );
                }
                for (const r of rows) {
                    // Re-plan only days not yet judged; a past verdict is never rewritten.
                    await this.db.client.query(
                        `INSERT INTO shefa_milestones
                                (target_date, goal_id, target_net_profit, target_fund_total, pace_weight, focus, model, planned_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
                         ON CONFLICT (target_date) DO UPDATE
                            SET goal_id = EXCLUDED.goal_id, target_net_profit = EXCLUDED.target_net_profit,
                                target_fund_total = EXCLUDED.target_fund_total, pace_weight = EXCLUDED.pace_weight,
                                focus = EXCLUDED.focus, model = EXCLUDED.model, planned_at = now()
                          WHERE shefa_milestones.status = 'PLANNED'`,
                        [r.date, goal.id, r.targetNet, r.targetFundTotal, r.weight, r.focus, model]
                    );
                }
                await this.db.client.query('COMMIT');
            } catch (err) {
                await this.db.client.query('ROLLBACK').catch(() => {});
                throw err;
            }

            await this.logger.log(
                `Strategy synced via ${model}. Fund $${fund.toFixed(2)}/$${goal.target.toFixed(2)} (${pct.toFixed(1)}%), ` +
                `${daysLeft} day(s) to ${goal.deadline}, even pace +$${requiredNetPerDay.toFixed(2)}/day. ` +
                `${todayRow ? `Today: ${todayStatus}. ` : ''}Planned ${rows.length} day(s).`
            );
            return { today, todayStatus, rows, model };
        } finally {
            await this.db.disconnect();
        }
    }
}

if (require.main === module) {
    attachGlobalErrorLogger('StrategySync');
    new StrategySync().run().catch(err => {
        console.error(`[StrategySync] Failed: ${err.stack || err.message}`);
        process.exit(1);
    });
}

module.exports = StrategySync;
Object.assign(module.exports, { localDate, addDays, daysBetween, clampWeight, alignPlan, computeTargets, judge, cleanText });
