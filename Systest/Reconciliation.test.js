jest.mock('../src/DatabaseClient', () => {
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        client: { query: jest.fn() }
    }));
});

const Reconciliation = require('../src/Reconciliation');
const BrokerClient = require('../src/BrokerClient');

describe('Position Reconciliation', () => {
    let reconciliation;

    beforeEach(() => {
        reconciliation = new Reconciliation();
        jest.spyOn(BrokerClient.prototype, 'getPositions');
        jest.spyOn(BrokerClient.prototype, 'getLastFilledOrder');

        reconciliation.db.client.query.mockImplementation((sql, params) => {
            if (sql.includes("SELECT * FROM trade_analytics WHERE status = 'OPEN'")) {
                return Promise.resolve({ rows: reconciliation.__fixtureOpenTrades || [] });
            }
            if (sql.includes("SELECT * FROM trade_analytics WHERE status = 'CLOSED' AND sell_price IS NULL")) {
                return Promise.resolve({ rows: reconciliation.__fixtureGhostRows || [] });
            }
            if (sql.includes('SELECT COUNT(*)::int AS count FROM trade_analytics WHERE symbol')) {
                const symbol = params[0];
                const counts = reconciliation.__fixtureSymbolCounts || {};
                return Promise.resolve({ rows: [{ count: counts[symbol] ?? 1 }] });
            }
            return Promise.resolve({ rows: [] });
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a DB-OPEN row still held on the broker is left untouched', async () => {
        reconciliation.__fixtureOpenTrades = [
            { id: 28, symbol: 'ISRL', buy_price: '24.67', qty: 346, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'ISRL', qty: '346' }]);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.stillOpen).toEqual(['ISRL']);
        expect(report.resolvedCloses).toHaveLength(0);
        expect(BrokerClient.prototype.getLastFilledOrder).not.toHaveBeenCalled();
    });

    test('a DB-OPEN row absent from the broker is resolved using the real closing fill, never a guess', async () => {
        reconciliation.__fixtureOpenTrades = [
            { id: 30, symbol: 'RIBBU', buy_price: '13.99', qty: 456, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getLastFilledOrder.mockResolvedValue({
            side: 'sell',
            status: 'filled',
            filled_avg_price: '10.07',
            filled_at: '2026-09-02T14:01:18.849349Z'
        });

        const report = await reconciliation.run({ dryRun: true });

        expect(BrokerClient.prototype.getLastFilledOrder).toHaveBeenCalledWith('RIBBU', 'sell');
        expect(report.resolvedCloses).toHaveLength(1);
        expect(report.resolvedCloses[0].sellPrice).toBe(10.07);
        expect(report.resolvedCloses[0].netProfit).toBeCloseTo((10.07 - 13.99) * 456, 2);
        // Dry run must never write.
        expect(reconciliation.db.client.query).not.toHaveBeenCalledWith(
            expect.stringContaining('UPDATE trade_analytics'),
            expect.anything()
        );
    });

    test('a DB-OPEN row absent from the broker with no verifiable fill is flagged, not guessed at', async () => {
        reconciliation.__fixtureOpenTrades = [
            { id: 99, symbol: 'GHOST2', buy_price: '5.00', qty: 10, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getLastFilledOrder.mockResolvedValue(null);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.unresolvedGaps).toEqual(['GHOST2']);
        expect(report.resolvedCloses).toHaveLength(0);
    });

    test('a broker position with no OPEN row at all is flagged as untracked, not auto-inserted', async () => {
        reconciliation.__fixtureOpenTrades = [];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'AAPL', qty: '1' }]);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.untrackedBrokerPositions).toEqual(['AAPL']);
    });

    test('apply mode writes the reconciled close and applies the loss directly to active_capital', async () => {
        reconciliation.__fixtureOpenTrades = [
            { id: 30, symbol: 'RIBBU', buy_price: '13.99', qty: 456, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getLastFilledOrder.mockResolvedValue({
            side: 'sell',
            status: 'filled',
            filled_avg_price: '10.07',
            filled_at: '2026-09-02T14:01:18.849349Z'
        });

        await reconciliation.run({ dryRun: false });

        const calls = reconciliation.db.client.query.mock.calls;
        const updateTradeCall = calls.find(([sql]) => sql.includes('UPDATE trade_analytics'));
        const updatePotsCall = calls.find(([sql]) => sql.includes('UPDATE capital_pots'));

        expect(updateTradeCall[1]).toEqual([10.07, expect.any(Number), expect.any(Number), '2026-09-02T14:01:18.849349Z', 30]);
        expect(updateTradeCall[1][1]).toBeCloseTo(-1787.52, 2);
        expect(updatePotsCall[1][0]).toBeCloseTo(-1787.52, 2);
    });
});

describe('Ghost row repair (fabricated CLOSED rows with no sell_price)', () => {
    let reconciliation;

    beforeEach(() => {
        reconciliation = new Reconciliation();
        jest.spyOn(BrokerClient.prototype, 'getPositions');
        jest.spyOn(BrokerClient.prototype, 'getOrderHistory');

        reconciliation.db.client.query.mockImplementation((sql, params) => {
            if (sql.includes("SELECT * FROM trade_analytics WHERE status = 'OPEN'")) {
                return Promise.resolve({ rows: reconciliation.__fixtureOpenTrades || [] });
            }
            if (sql.includes("SELECT * FROM trade_analytics WHERE status = 'CLOSED' AND sell_price IS NULL")) {
                return Promise.resolve({ rows: reconciliation.__fixtureGhostRows || [] });
            }
            if (sql.includes('SELECT COUNT(*)::int AS count FROM trade_analytics WHERE symbol')) {
                const symbol = params[0];
                const counts = reconciliation.__fixtureSymbolCounts || {};
                return Promise.resolve({ rows: [{ count: counts[symbol] ?? 1 }] });
            }
            return Promise.resolve({ rows: [] });
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('a ghost row still live on Alpaca with matching qty is reopened, never deleted', async () => {
        reconciliation.__fixtureOpenTrades = [];
        reconciliation.__fixtureGhostRows = [
            { id: 5, symbol: 'WEAV', buy_price: '7.28', qty: 1128, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'WEAV', qty: '1128' }]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'buy', status: 'filled', filled_avg_price: '7.307154', filled_at: '2026-08-19T13:32:25Z' }
        ]);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.reopened).toHaveLength(1);
        expect(report.reopened[0].symbol).toBe('WEAV');
        expect(report.resolvedCloses).toHaveLength(0);
        // A still-open position must never show up as untracked once claimed by the reopen.
        expect(report.untrackedBrokerPositions).not.toContain('WEAV');
    });

    test('a ghost row with a real filled closing order on Alpaca is repaired with the real numbers', async () => {
        reconciliation.__fixtureOpenTrades = [];
        reconciliation.__fixtureGhostRows = [
            { id: 26, symbol: 'FVNNU', buy_price: '16.81', qty: 459, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'buy', status: 'filled', filled_avg_price: '18.5', filled_at: '2026-08-24T18:24:09Z' },
            { side: 'sell', status: 'canceled', filled_avg_price: null, filled_at: null },
            { side: 'sell', status: 'filled', filled_avg_price: '19.020915', filled_at: '2026-08-24T19:58:26.750236Z' }
        ]);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.resolvedCloses).toHaveLength(1);
        expect(report.resolvedCloses[0].sellPrice).toBeCloseTo(19.020915, 5);
        expect(report.resolvedCloses[0].netProfit).toBeCloseTo(1014.81, 2);
        expect(report.reopened).toHaveLength(0);
    });

    test('a ghost row for a symbol with multiple historical rows is flagged, never guessed at or deleted', async () => {
        reconciliation.__fixtureOpenTrades = [];
        reconciliation.__fixtureGhostRows = [
            { id: 24, symbol: 'WETO', buy_price: '28.66', qty: 331, action: 'BUY' }
        ];
        reconciliation.__fixtureSymbolCounts = { WETO: 5 };
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'WETO', qty: '549' }]);

        const report = await reconciliation.run({ dryRun: true });

        expect(report.flaggedGhostRows).toEqual(['WETO']);
        expect(report.resolvedCloses).toHaveLength(0);
        expect(report.reopened).toHaveLength(0);
        expect(BrokerClient.prototype.getOrderHistory).not.toHaveBeenCalled();
    });

    test('apply mode reopens ghost positions (nulling stale close fields) and repairs real closes, aggregating pot updates across both', async () => {
        reconciliation.__fixtureOpenTrades = [];
        reconciliation.__fixtureGhostRows = [
            { id: 5, symbol: 'WEAV', buy_price: '7.28', qty: 1128, action: 'BUY' },
            { id: 27, symbol: 'FVN', buy_price: '19.84', qty: 439, action: 'BUY' }
        ];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'WEAV', qty: '1128' }]);
        BrokerClient.prototype.getOrderHistory.mockImplementation((symbol) => {
            if (symbol === 'WEAV') {
                return Promise.resolve([{ side: 'buy', status: 'filled', filled_avg_price: '7.307154', filled_at: '2026-08-19T13:32:25Z' }]);
            }
            return Promise.resolve([
                { side: 'buy', status: 'filled', filled_avg_price: '19.77', filled_at: '2026-08-25T13:31:02Z' },
                { side: 'sell', status: 'canceled', filled_avg_price: null, filled_at: null },
                { side: 'sell', status: 'filled', filled_avg_price: '14.25', filled_at: '2026-08-25T14:09:37.172318Z' }
            ]);
        });

        await reconciliation.run({ dryRun: false });

        const calls = reconciliation.db.client.query.mock.calls;
        const reopenCall = calls.find(([sql, p]) => sql.includes("SET status = 'OPEN'") && p[0] === 5);
        const closeCall = calls.find(([sql, p]) => sql.includes('UPDATE trade_analytics') && sql.includes("'CLOSED'") && p[4] === 27);
        const potsCall = calls.find(([sql]) => sql.includes('UPDATE capital_pots'));

        expect(reopenCall).toBeTruthy();
        expect(reopenCall[1]).toEqual([5]);
        expect(closeCall[1][1]).toBeCloseTo(-2454.01, 2); // FVN net_profit
        expect(potsCall[1][0]).toBeCloseTo(-2454.01, 2); // only FVN contributes P&L; reopening WEAV doesn't
    });
});
