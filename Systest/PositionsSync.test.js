jest.mock('../src/DatabaseClient', () => {
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        client: { query: jest.fn() }
    }));
});

const PositionsSync = require('../src/PositionsSync');
const BrokerClient = require('../src/BrokerClient');

describe('PositionsSync (replacement exit-ledger engine)', () => {
    let sync;

    beforeEach(() => {
        sync = new PositionsSync();
        jest.spyOn(BrokerClient.prototype, 'getPositions');
        jest.spyOn(BrokerClient.prototype, 'getOrderHistory');

        sync.db.client.query.mockImplementation((sql) => {
            if (sql.includes("SELECT * FROM trade_analytics WHERE status = 'OPEN'")) {
                return Promise.resolve({ rows: sync.__openTrades || [] });
            }
            return Promise.resolve({ rows: [] });
        });
    });

    afterEach(() => jest.restoreAllMocks());

    const trade = (over = {}) => ({
        id: 25, symbol: 'SDOT', buy_price: '24.70', qty: 368, action: 'BUY',
        opened_at: '2026-08-24T18:23:59Z', ...over
    });

    test('closes a DB-OPEN row once the broker is flat, using the real sell fill', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'buy', status: 'filled', filled_qty: '368', filled_avg_price: '24.70', filled_at: '2026-08-24T18:24:00Z' },
            { side: 'sell', status: 'filled', filled_qty: '368', filled_avg_price: '17.91', filled_at: '2026-08-25T14:02:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(1);
        expect(report.closed[0].sellPrice).toBe(17.91);
        expect(report.closed[0].netProfit).toBe(parseFloat(((17.91 - 24.70) * 368).toFixed(2)));

        const update = sync.db.client.query.mock.calls.find(c => c[0].includes("SET status = 'CLOSED'"));
        expect(update).toBeDefined();
        expect(update[1]).toEqual([17.91, report.closed[0].netProfit, report.closed[0].marginPercentage, '2026-08-25T14:02:00Z', 25]);
    });

    test('leaves a row alone while the broker still holds the position', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'SDOT', qty: '368' }]);

        const report = await sync.run({ dryRun: false });

        expect(report.stillOpen).toEqual(['SDOT']);
        expect(report.closed).toHaveLength(0);
        expect(sync.db.client.query.mock.calls.some(c => c[0].includes("SET status = 'CLOSED'"))).toBe(false);
    });

    test('combines partial exit fills into one weighted-average close', async () => {
        sync.__openTrades = [trade({ qty: 300 })];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'sell', status: 'filled', filled_qty: '100', filled_avg_price: '20.00', filled_at: '2026-08-25T14:00:00Z' },
            { side: 'sell', status: 'filled', filled_qty: '200', filled_avg_price: '26.00', filled_at: '2026-08-25T14:05:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(1);
        expect(report.closed[0].sellPrice).toBe(24); // (100*20 + 200*26) / 300
    });

    test('ignores a sell that predates the row and flags it instead of inventing a close', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'sell', status: 'filled', filled_qty: '368', filled_avg_price: '40.00', filled_at: '2026-08-01T14:00:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(0);
        expect(report.flagged).toEqual(['SDOT']);
    });

    test('flags rather than closes when exit quantity does not match the row', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'sell', status: 'filled', filled_qty: '100', filled_avg_price: '17.91', filled_at: '2026-08-25T14:02:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(0);
        expect(report.flagged).toEqual(['SDOT']);
    });

    test('never auto-inserts a broker position that has no ledger row', async () => {
        sync.__openTrades = [];
        BrokerClient.prototype.getPositions.mockResolvedValue([{ symbol: 'GHOST', qty: '10' }]);

        const report = await sync.run({ dryRun: false });

        expect(report.untracked).toEqual(['GHOST']);
        expect(sync.db.client.query.mock.calls.some(c => c[0].includes('INSERT'))).toBe(false);
    });

    test('never writes to capital_pots - Settlement.js owns pot distribution', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'sell', status: 'filled', filled_qty: '368', filled_avg_price: '17.91', filled_at: '2026-08-25T14:02:00Z' }
        ]);

        await sync.run({ dryRun: false });

        expect(sync.db.client.query.mock.calls.some(c => c[0].includes('capital_pots'))).toBe(false);
    });

    test('a short closes profitably when bought back below the entry', async () => {
        sync.__openTrades = [trade({ symbol: 'SHRT', action: 'SELL_SHORT', buy_price: '50.00', qty: 10 })];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'buy', status: 'filled', filled_qty: '10', filled_avg_price: '40.00', filled_at: '2026-08-25T14:02:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed[0].netProfit).toBe(100); // (50 - 40) * 10
    });

    test('dry run reports the close without writing it', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { side: 'sell', status: 'filled', filled_qty: '368', filled_avg_price: '17.91', filled_at: '2026-08-25T14:02:00Z' }
        ]);

        const report = await sync.run({ dryRun: true });

        expect(report.closed).toHaveLength(1);
        expect(sync.db.client.query.mock.calls.some(c => c[0].includes("SET status = 'CLOSED'"))).toBe(false);
    });
});
