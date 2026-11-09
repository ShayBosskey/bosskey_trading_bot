jest.mock('../src/DatabaseClient', () => {
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        client: { query: jest.fn() }
    }));
});

global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));

const Settlement = require('../src/Settlement');

describe('Settlement daily net profit calculation', () => {
    let settlement;
    let updateCalls;

    beforeEach(() => {
        settlement = new Settlement();
        updateCalls = [];
        fetch.mockClear();

        settlement.db.client.query.mockImplementation((sql, params) => {
            if (sql.includes('SELECT * FROM trade_analytics')) {
                return Promise.resolve({ rows: settlement.__fixtureRows || [] });
            }
            if (sql.includes('UPDATE capital_pots')) {
                updateCalls.push(params);
                return Promise.resolve({});
            }
            return Promise.resolve({ rows: [] });
        });
    });

    test('a closed trade with a NULL net_profit (e.g. a cleared ghost position) is skipped, not treated as NaN', async () => {
        settlement.__fixtureRows = [
            { id: 1, symbol: 'GHOST', net_profit: null }
        ];

        await settlement.runDailySettlement();

        expect(updateCalls).toHaveLength(1);
        const params = updateCalls[0];
        params.forEach((p) => expect(Number.isFinite(p)).toBe(true));
        // A single skipped trade nets to $0 for the day -> treated as the loss/breakeven branch.
        expect(params[0]).toBe(0);
    });

    test('real profit is still summed correctly alongside a skipped ghost row', async () => {
        settlement.__fixtureRows = [
            { id: 2, symbol: 'WIN', net_profit: '100.00' },
            { id: 3, symbol: 'GHOST', net_profit: null }
        ];

        await settlement.runDailySettlement();

        expect(updateCalls).toHaveLength(1);
        // $100 net: $20 to SHEFA's fund first, then $80 split 50/20/20/10.
        const [activeAddition, emergencyAddition, taxAddition, personalAddition, shefaAddition] = updateCalls[0];
        expect(shefaAddition).toBeCloseTo(20);
        expect(activeAddition).toBeCloseTo(40);
        expect(emergencyAddition).toBeCloseTo(16);
        expect(taxAddition).toBeCloseTo(16);
        expect(personalAddition).toBeCloseTo(8);
    });

    test('a losing day gives the SHEFA fund nothing', async () => {
        settlement.__fixtureRows = [
            { id: 4, symbol: 'WIN', net_profit: '100.00' },
            { id: 5, symbol: 'LOSS', net_profit: '-300.00' }
        ];

        await settlement.runDailySettlement();

        expect(updateCalls).toHaveLength(1);
        expect(updateCalls[0]).toEqual([-200]);
    });

    test('a literal NaN net_profit (Postgres numeric NaN, the historical corruption case) is skipped, never written to capital_pots', async () => {
        settlement.__fixtureRows = [
            { id: 4, symbol: 'CORRUPT', net_profit: 'NaN' }
        ];

        await settlement.runDailySettlement();

        expect(updateCalls).toHaveLength(1);
        updateCalls[0].forEach((p) => expect(Number.isFinite(p)).toBe(true));
    });
});

describe('Settlement sweeps unsettled rows atomically', () => {
    let settlement;
    let calls;

    const setup = (rows, { failOn } = {}) => {
        settlement = new Settlement();
        calls = [];
        fetch.mockClear();
        settlement.db.client.query.mockImplementation((sql, params) => {
            const text = sql.replace(/\s+/g, ' ').trim();
            calls.push({ text, params });
            if (failOn && text.includes(failOn)) return Promise.reject(new Error('db down'));
            if (text.startsWith('SELECT * FROM trade_analytics')) return Promise.resolve({ rows });
            return Promise.resolve({ rows: [] });
        });
    };
    const texts = () => calls.map(c => c.text.split(' ').slice(0, 3).join(' '));

    test('selects unsettled CLOSED rows (not "closed today") inside one transaction', async () => {
        setup([{ id: 7, symbol: 'BTC/USD', net_profit: '50.00' }]);
        await settlement.runDailySettlement();

        const select = calls.find(c => c.text.startsWith('SELECT * FROM trade_analytics')).text;
        expect(select).toContain('settled_at IS NULL');
        expect(select).toContain('FOR UPDATE');
        expect(select).not.toContain('CURRENT_DATE');
        expect(texts()).toEqual(['BEGIN', 'SELECT * FROM', 'UPDATE capital_pots SET', 'UPDATE trade_analytics SET', 'COMMIT']);
    });

    test('stamps every swept row, including one skipped for a missing net_profit', async () => {
        setup([{ id: 7, symbol: 'A', net_profit: '50.00' }, { id: 9, symbol: 'GHOST', net_profit: null }]);
        await settlement.runDailySettlement();

        const stamp = calls.find(c => c.text.startsWith('UPDATE trade_analytics SET settled_at'));
        expect(stamp.params).toEqual([[7, 9]]);
    });

    test('rolls back without stamping when the pot update fails, and pushes no settlement report', async () => {
        setup([{ id: 7, symbol: 'A', net_profit: '50.00' }], { failOn: 'UPDATE capital_pots' });
        await settlement.runDailySettlement();

        expect(texts()).toContain('ROLLBACK');
        expect(texts()).not.toContain('COMMIT');
        expect(calls.some(c => c.text.startsWith('UPDATE trade_analytics SET settled_at'))).toBe(false);
        const titles = fetch.mock.calls.map(c => c[1].headers.Title);
        expect(titles).toContain('Settlement Error');
        expect(titles.some(t => /Day Settled/.test(t))).toBe(false);
    });

    test('nothing to settle commits the empty transaction and touches no pots', async () => {
        setup([]);
        await settlement.runDailySettlement();
        expect(texts()).toEqual(['BEGIN', 'SELECT * FROM', 'COMMIT']);
    });
});
