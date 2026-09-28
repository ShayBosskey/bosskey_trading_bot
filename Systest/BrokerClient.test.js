jest.mock('yahoo-finance2', () => ({
    default: { quote: jest.fn() }
}));

const BrokerClient = require('../src/BrokerClient');
const yahooFinance = require('yahoo-finance2').default;

// Mock the global fetch function
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: 'mock-order-id' }),
    })
);

describe('BrokerClient Execution Architecture', () => {
    let broker;
    const originalFetch = global.fetch;

    beforeEach(() => {
        broker = new BrokerClient();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    // Mocks the two-step lifecycle: POST /v2/orders, then the GET poll that
    // resolves the real fill.
    function mockOrderLifecycle(pollResponses, submitOverrides = {}) {
        const polls = [...pollResponses];
        let lastPoll = polls[polls.length - 1];
        global.fetch = jest.fn((url, init) => {
            if (init && init.method === 'POST') {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ id: 'mock-order-id', time_in_force: 'gtc', ...submitOverrides })
                });
            }
            if (init && init.method === 'DELETE') {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
            }
            // Each GET advances the script, then repeats the final state.
            if (polls.length > 0) lastPoll = polls.shift();
            return Promise.resolve({ ok: true, json: () => Promise.resolve(lastPoll) });
        });
        return global.fetch;
    }

    test('executeBuyOrder submits a GTC bracket with a marketable LIMIT entry', async () => {
        // A market entry is what Alpaca silently coerces to tif=day, killing the
        // protective legs at the close. The entry must therefore be a limit order.
        mockOrderLifecycle([{ status: 'filled', filled_qty: '100', filled_avg_price: '10.02' }]);

        const symbol = 'WETO';
        const allocateAmount = 1000;
        const currentPrice = 10.00;
        const takeProfitPrice = currentPrice * 1.10; // 11.00
        const stopLossPrice = currentPrice * 0.95;   // 9.50

        await broker.executeBuyOrder(symbol, allocateAmount, currentPrice, takeProfitPrice, stopLossPrice);

        const postCall = global.fetch.mock.calls.find(c => c[1] && c[1].method === 'POST');
        const requestBody = JSON.parse(postCall[1].body);

        expect(requestBody.order_class).toBe('bracket');
        expect(requestBody.qty).toBe('100');
        expect(requestBody.take_profit.limit_price).toBe('11.00');
        expect(requestBody.stop_loss.stop_price).toBe('9.50');
        // Brackets must stay protected across sessions, not expire after one day (P0 fix).
        expect(requestBody.time_in_force).toBe('gtc');
        expect(requestBody.type).toBe('limit');
        expect(requestBody.limit_price).toBe('10.05'); // 0.5% marketable buffer
    });

    test('executeBuyOrder returns Alpaca real filled_avg_price, not the screener quote', async () => {
        // The fabricated-P&L bug: the ledger recorded the screener's quote as
        // buy_price, so real sells were measured against prices never paid.
        mockOrderLifecycle([{ status: 'filled', filled_qty: '100', filled_avg_price: '10.02' }]);

        const result = await broker.executeBuyOrder('WETO', 1000, 10.00, 11.00, 9.50);

        expect(result.filled).toBe(true);
        expect(result.filled_avg_price).toBe(10.02);
        expect(result.filled_avg_price).not.toBe(10.00);
        expect(result.qty).toBe(100);
    });

    test('executeBuyOrder cancels an entry that never fills and records nothing', async () => {
        mockOrderLifecycle([{ status: 'new', filled_qty: '0', filled_avg_price: null }]);

        const result = await broker.executeBuyOrder('WETO', 1000, 10.00, 11.00, 9.50, {
            fillTimeoutMs: 10,
            pollIntervalMs: 1
        });

        expect(result.filled).toBe(false);
        expect(global.fetch.mock.calls.some(c => c[1] && c[1].method === 'DELETE')).toBe(true);
    });

    test('executeBuyOrder still records a fill that lands during the cancel race', async () => {
        // First poll shows unfilled; the post-cancel re-check shows it filled.
        mockOrderLifecycle([
            { status: 'new', filled_qty: '0', filled_avg_price: null },
            { status: 'filled', filled_qty: '100', filled_avg_price: '10.04' }
        ]);

        const result = await broker.executeBuyOrder('WETO', 1000, 10.00, 11.00, 9.50, {
            fillTimeoutMs: 10,
            pollIntervalMs: 1
        });

        expect(result.filled).toBe(true);
        expect(result.filled_avg_price).toBe(10.04);
    });

    test('executeBuyOrder rejects a bracket whose stop-loss is not below the entry', async () => {
        mockOrderLifecycle([{ status: 'filled', filled_qty: '100', filled_avg_price: '10.00' }]);

        await expect(
            broker.executeBuyOrder('WETO', 1000, 10.00, 11.00, 10.50)
        ).rejects.toThrow(/Stop-loss/);
    });

    test('executeBuyOrder prices sub-dollar stops to 4 decimals instead of rounding to 0.00', async () => {
        mockOrderLifecycle([{ status: 'filled', filled_qty: '2', filled_avg_price: '5.00' }]);

        await broker.executeBuyOrder('PENNY', 10, 5.00, 7.50, 0.4321);

        const postCall = global.fetch.mock.calls.find(c => c[1] && c[1].method === 'POST');
        expect(JSON.parse(postCall[1].body).stop_loss.stop_price).toBe('0.4321');
    });

});

describe('BrokerClient Market Scanner', () => {
    let broker;
    const originalFetch = global.fetch;

    beforeEach(() => {
        broker = new BrokerClient();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('scanMarketMovers reads volume from the latest fetched bar, not the nonexistent mover.volume field', async () => {
        global.fetch = jest.fn((url) => {
            if (url.includes('/screener/')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        gainers: [{ symbol: 'TEST', price: 10, percent_change: 5 }], // no `volume` field
                        losers: []
                    })
                });
            }
            if (url.includes('/bars')) {
                const bars = Array.from({ length: 20 }, (_, i) => ({ c: 10, h: 11, l: 9, v: 1000 + i }));
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({ bars: { TEST: bars } })
                });
            }
            if (url.includes('finnhub')) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ earningsCalendar: [] }) });
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
        });

        const setups = await broker.scanMarketMovers([], 1);

        expect(setups).toHaveLength(1);
        expect(setups[0].volume).toBe(1019); // the last bar's `v`, not `mover.volume` (undefined)
    });
});

describe('BrokerClient Position Reconciliation Support', () => {
    let broker;
    const originalFetch = global.fetch;

    beforeEach(() => {
        broker = new BrokerClient();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    test('getPositions fetches live positions from Alpaca', async () => {
        global.fetch = jest.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve([{ symbol: 'AAPL', qty: '1' }])
        }));

        const positions = await broker.getPositions();

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('/v2/positions'),
            expect.any(Object)
        );
        expect(positions).toEqual([{ symbol: 'AAPL', qty: '1' }]);
    });

    test('getLastFilledOrder returns the most recent filled order on the given side', async () => {
        global.fetch = jest.fn(() => Promise.resolve({
            ok: true,
            json: () => Promise.resolve([
                { side: 'sell', status: 'filled', filled_avg_price: '10.07', filled_at: '2026-09-02T14:01:18Z' },
                { side: 'buy', status: 'filled', filled_avg_price: '13.01', filled_at: '2026-09-02T13:32:37Z' }
            ])
        }));

        const order = await broker.getLastFilledOrder('RIBBU', 'sell');

        expect(order.filled_avg_price).toBe('10.07');
    });

    test('getLastFilledOrder returns null when there is no verifiable closing fill', async () => {
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve([]) }));

        const order = await broker.getLastFilledOrder('UNKNOWN', 'sell');

        expect(order).toBeNull();
    });

    test('getOrderHistory fetches the full all-time, all-status order history for a symbol', async () => {
        const orders = [{ side: 'buy', status: 'filled' }, { side: 'sell', status: 'canceled' }];
        global.fetch = jest.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve(orders) }));

        const result = await broker.getOrderHistory('WETO');

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining('status=all&symbols=WETO'),
            expect.any(Object)
        );
        expect(result).toEqual(orders);
    });
});

describe('BrokerClient Fundamental Data Fallback', () => {
    let broker;

    beforeEach(() => {
        broker = new BrokerClient();
        fetch.mockClear();
        yahooFinance.quote.mockReset();
    });

    test('fetchFundamentals returns the Finnhub payload directly when Finnhub is reachable', async () => {
        fetch.mockResolvedValueOnce({
            ok: true,
            json: () => Promise.resolve({ c: 150.25, d: 1.5, dp: 1.01 })
        });

        const result = await broker.fetchFundamentals('AAPL');

        expect(yahooFinance.quote).not.toHaveBeenCalled();
        expect(result).toEqual({ c: 150.25, d: 1.5, dp: 1.01 });
    });

    test('fetchFundamentals falls back to yahoo-finance2 and matches Finnhub JSON shape when Finnhub errors', async () => {
        fetch.mockResolvedValueOnce({ ok: false, status: 500 });
        yahooFinance.quote.mockResolvedValueOnce({
            regularMarketPrice: 150.25,
            regularMarketChange: 1.5,
            regularMarketChangePercent: 1.01
        });

        const result = await broker.fetchFundamentals('AAPL');

        expect(yahooFinance.quote).toHaveBeenCalledWith('AAPL');
        expect(result).toEqual({ c: 150.25, d: 1.5, dp: 1.01 });
    });

    test('fetchFundamentals falls back to yahoo-finance2 when the Finnhub request itself throws', async () => {
        fetch.mockRejectedValueOnce(new Error('network down'));
        yahooFinance.quote.mockResolvedValueOnce({
            regularMarketPrice: 200,
            regularMarketChange: -2,
            regularMarketChangePercent: -0.99
        });

        const result = await broker.fetchFundamentals('MSFT');

        expect(result).toEqual({ c: 200, d: -2, dp: -0.99 });
    });
});
