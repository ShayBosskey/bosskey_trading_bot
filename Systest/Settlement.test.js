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
