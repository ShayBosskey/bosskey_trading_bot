const { assetClassOf } = require('./Capacity');

// Anti-whipsaw cool-down. After a crypto position is stopped out, SHEFA may not
// re-enter that symbol for COOLDOWN_HOURS. A symbol stopped out twice or more
// within REPEAT_COOLDOWN_HOURS is banned for REPEAT_COOLDOWN_HOURS from its
// latest stop-out. (Incident 2026-11-10: UNI/USD was stopped at 12:32, re-bought
// at 13:00 and stopped again at 16:41.)
//
// The ledger has no exit-reason column, so a stop-out is a CLOSED row whose fill
// was at or below its stop, or any losing close. That second test catches a stop
// that filled a tick above the stop price, and is the right call anyway: a
// loss on a symbol is a reason not to buy it straight back.
const COOLDOWN_HOURS = 24;
const REPEAT_COOLDOWN_HOURS = 48;
const HOUR_MS = 60 * 60 * 1000;

// Returns [{ symbol, stopouts, lastStopAt, until }] for every crypto symbol still
// cooling down. Throws on a DB error: the caller must not trade blind.
async function getCooledDownSymbols(dbClient, { now = Date.now() } = {}) {
    const since = new Date(now - REPEAT_COOLDOWN_HOURS * HOUR_MS).toISOString();
    const res = await dbClient.query(
        `SELECT symbol, COUNT(*)::int AS stopouts, MAX(closed_at) AS last_stop_at
           FROM trade_analytics
          WHERE status = 'CLOSED'
            AND closed_at >= $1
            AND (sell_price <= stop_price OR net_profit < 0)
          GROUP BY symbol`,
        [since]
    );

    const cooled = [];
    for (const row of res.rows) {
        if (assetClassOf(row.symbol) !== 'crypto') continue;
        const lastStopAt = new Date(row.last_stop_at).getTime();
        const hours = row.stopouts >= 2 ? REPEAT_COOLDOWN_HOURS : COOLDOWN_HOURS;
        const until = lastStopAt + hours * HOUR_MS;
        if (until > now) {
            cooled.push({ symbol: row.symbol, stopouts: row.stopouts, lastStopAt: new Date(lastStopAt).toISOString(), until: new Date(until).toISOString() });
        }
    }
    return cooled;
}

module.exports = { getCooledDownSymbols, COOLDOWN_HOURS, REPEAT_COOLDOWN_HOURS };
