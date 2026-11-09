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

    // A bracket entry as Alpaca returns it with nested=true: TP/SL legs rolled up.
    const entryOrder = (legs, over = {}) => ({
        id: 'entry-1', side: 'buy', status: 'filled', order_class: 'bracket',
        filled_qty: '368', filled_avg_price: '24.70', filled_at: '2026-08-24T18:23:40Z',
        legs, ...over
    });
    const leg = (over = {}) => ({
        id: 'leg-tp', side: 'sell', status: 'filled',
        filled_qty: '368', filled_avg_price: '17.91', filled_at: '2026-08-25T14:02:00Z', ...over
    });
    const canceledLeg = (id, side = 'sell') => ({ id, side, status: 'canceled', filled_qty: '0', filled_avg_price: null, filled_at: null });

    test('closes a DB-OPEN row once the broker is flat, using its own bracket leg fill', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            entryOrder([leg({ id: 'leg-sl' }), canceledLeg('leg-tp')])
        ]);

        const report = await sync.run({ dryRun: false });

        expect(BrokerClient.prototype.getOrderHistory).toHaveBeenCalledWith('SDOT', { nested: true });
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

    test('combines a partially filled exit leg into one weighted-average close', async () => {
        sync.__openTrades = [trade({ qty: 300 })];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            entryOrder([
                leg({ id: 'leg-tp', filled_qty: '100', filled_avg_price: '20.00', filled_at: '2026-08-25T14:00:00Z', status: 'canceled' }),
                leg({ id: 'leg-sl', filled_qty: '200', filled_avg_price: '26.00', filled_at: '2026-08-25T14:05:00Z' })
            ], { filled_qty: '300' })
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(1);
        expect(report.closed[0].sellPrice).toBe(24); // (100*20 + 200*26) / 300
        expect(report.closed[0].closedAt).toBe('2026-08-25T14:05:00Z');
    });

    test('ignores other trades in the same symbol (the WETO 1657-vs-549 mismatch)', async () => {
        sync.__openTrades = [trade({ symbol: 'WETO', qty: 549, buy_price: '30.65', opened_at: '2026-08-18T14:43:28Z' })];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            // An earlier, unrelated WETO round trip.
            entryOrder([leg({ id: 'old-tp', filled_qty: '554', filled_avg_price: '28.00', filled_at: '2026-08-18T13:00:00Z' })],
                { id: 'old-entry', filled_qty: '554', filled_avg_price: '27.00', filled_at: '2026-08-18T12:00:00Z' }),
            // This row's entry, exited by its stop-loss leg.
            entryOrder([canceledLeg('tp'), leg({ id: 'sl', filled_qty: '549', filled_avg_price: '29.10', filled_at: '2026-08-19T15:00:00Z' })],
                { id: 'row-entry', filled_qty: '549', filled_avg_price: '30.65', filled_at: '2026-08-18T14:43:10Z' }),
            // A later, separate manual sell in the same symbol.
            { id: 'manual', side: 'sell', status: 'filled', filled_qty: '554', filled_avg_price: '31.00', filled_at: '2026-08-20T15:00:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.flagged).toEqual([]);
        expect(report.closed).toHaveLength(1);
        expect(report.closed[0].sellPrice).toBe(29.1);
    });

    test('flags rather than closes when the exit legs do not add up to the row', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            entryOrder([leg({ filled_qty: '100' })])
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(0);
        expect(report.flagged).toEqual(['SDOT']);
    });

    test('flags when no entry order matches the row, instead of guessing from loose sells', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            { id: 'loose', side: 'sell', status: 'filled', filled_qty: '368', filled_avg_price: '40.00', filled_at: '2026-08-25T14:00:00Z' }
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed).toHaveLength(0);
        expect(report.flagged).toEqual(['SDOT']);
    });

    test('flags when the entry exists but no bracket leg filled (closed outside the bracket)', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            entryOrder([canceledLeg('leg-tp'), canceledLeg('leg-sl')])
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
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([entryOrder([leg()])]);

        await sync.run({ dryRun: false });

        expect(sync.db.client.query.mock.calls.some(c => c[0].includes('capital_pots'))).toBe(false);
    });

    test('a short closes profitably when its buy-to-cover leg fills below the entry', async () => {
        sync.__openTrades = [trade({ symbol: 'SHRT', action: 'SELL_SHORT', buy_price: '50.00', qty: 10 })];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([
            entryOrder([leg({ side: 'buy', filled_qty: '10', filled_avg_price: '40.00' })],
                { side: 'sell', filled_qty: '10', filled_avg_price: '50.00' })
        ]);

        const report = await sync.run({ dryRun: false });

        expect(report.closed[0].netProfit).toBe(100); // (50 - 40) * 10
    });

    test('dry run reports the close without writing it', async () => {
        sync.__openTrades = [trade()];
        BrokerClient.prototype.getPositions.mockResolvedValue([]);
        BrokerClient.prototype.getOrderHistory.mockResolvedValue([entryOrder([leg()])]);

        const report = await sync.run({ dryRun: true });

        expect(report.closed).toHaveLength(1);
        expect(sync.db.client.query.mock.calls.some(c => c[0].includes("SET status = 'CLOSED'"))).toBe(false);
    });
});

describe('PositionsSync leaves crypto to the crypto engine', () => {
    afterEach(() => jest.restoreAllMocks());

    test('a held crypto position is neither untracked nor flagged, and crypto rows are not queried', async () => {
        const sync = new PositionsSync();
        const queries = [];
        sync.db.client.query.mockImplementation((sql) => {
            queries.push(sql);
            return Promise.resolve({ rows: [] }); // DB filter excludes crypto rows
        });
        jest.spyOn(BrokerClient.prototype, 'getPositions').mockResolvedValue([
            { symbol: 'BTCUSD', asset_class: 'crypto', qty: '0.016' }
        ]);
        const history = jest.spyOn(BrokerClient.prototype, 'getOrderHistory');

        const report = await sync.run({ dryRun: true });

        expect(report.flagged).toEqual([]);
        expect(report.untracked || []).toEqual([]);
        expect(history).not.toHaveBeenCalled();
        expect(queries.find(q => q.includes("status = 'OPEN'"))).toContain("symbol NOT LIKE '%/%'");
    });
});
