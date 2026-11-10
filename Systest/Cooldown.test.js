const Cooldown = require('../src/Cooldown');

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-10T16:00:00Z').getTime();
const ago = hours => new Date(NOW - hours * HOUR).toISOString();

// Fake DB client: returns the given stop-out rows, records the SQL it was sent.
function dbWith(rows) {
    const client = { query: jest.fn().mockResolvedValue({ rows }) };
    return client;
}

describe('symbol cool-down after a stop-out', () => {
    test('a single stop-out within 24h blocks the symbol', async () => {
        const db = dbWith([{ symbol: 'UNI/USD', stopouts: 1, last_stop_at: ago(3) }]);
        const result = await Cooldown.getCooledDownSymbols(db, { now: NOW });
        expect(result.map(r => r.symbol)).toEqual(['UNI/USD']);
        expect(new Date(result[0].until).getTime()).toBe(NOW + 21 * HOUR);
    });

    test('a single stop-out older than 24h no longer blocks', async () => {
        const db = dbWith([{ symbol: 'ETH/USD', stopouts: 1, last_stop_at: ago(25) }]);
        expect(await Cooldown.getCooledDownSymbols(db, { now: NOW })).toEqual([]);
    });

    test('repeated stop-outs within 48h extend the ban to 48h from the last one', async () => {
        // UNI/USD on 2026-11-10: stopped 12:32, re-entered 13:00, stopped again 16:41.
        const db = dbWith([{ symbol: 'UNI/USD', stopouts: 2, last_stop_at: ago(30) }]);
        const result = await Cooldown.getCooledDownSymbols(db, { now: NOW });
        expect(result.map(r => r.symbol)).toEqual(['UNI/USD']);
        expect(new Date(result[0].until).getTime()).toBe(NOW + 18 * HOUR);
    });

    test('only crypto symbols are returned', async () => {
        const db = dbWith([
            { symbol: 'SDOT', stopouts: 1, last_stop_at: ago(1) },
            { symbol: 'LINK/USD', stopouts: 1, last_stop_at: ago(1) }
        ]);
        const result = await Cooldown.getCooledDownSymbols(db, { now: NOW });
        expect(result.map(r => r.symbol)).toEqual(['LINK/USD']);
    });

    test('query looks at losing / at-or-below-stop closes inside the long window', async () => {
        const db = dbWith([]);
        await Cooldown.getCooledDownSymbols(db, { now: NOW });
        const [sql, params] = db.query.mock.calls[0];
        expect(sql).toMatch(/status = 'CLOSED'/);
        expect(sql).toMatch(/sell_price <= stop_price/);
        expect(sql).toMatch(/net_profit < 0/);
        expect(new Date(params[0]).getTime()).toBe(NOW - Cooldown.REPEAT_COOLDOWN_HOURS * HOUR);
    });

    test('a DB failure fails closed (throws) rather than silently allowing re-entry', async () => {
        const db = { query: jest.fn().mockRejectedValue(new Error('connection refused')) };
        await expect(Cooldown.getCooledDownSymbols(db, { now: NOW })).rejects.toThrow('connection refused');
    });
});
