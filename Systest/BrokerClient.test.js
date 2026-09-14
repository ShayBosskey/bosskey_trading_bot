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

    beforeEach(() => {
        broker = new BrokerClient();
        fetch.mockClear();
    });

    test('executeBuyOrder constructs correct Bracket Order payload', async () => {
        const symbol = 'WETO';
        const allocateAmount = 1000;
        const currentPrice = 10.00;
        
        // Simulating a 10% profit target and 5% stop loss
        const takeProfitPrice = currentPrice * 1.10; // 11.00
        const stopLossPrice = currentPrice * 0.95;   // 9.50

        await broker.executeBuyOrder(symbol, allocateAmount, currentPrice, takeProfitPrice, stopLossPrice);

        // Verify fetch was called once
        expect(fetch).toHaveBeenCalledTimes(1);

        // Extract the payload sent to Alpaca
        const fetchArgs = fetch.mock.calls[0];
        const requestBody = JSON.parse(fetchArgs[1].body);

        // Assertions: Verify Risk Parameters
        expect(requestBody.order_class).toBe('bracket');
        expect(requestBody.qty).toBe('100');
        expect(requestBody.take_profit.limit_price).toBe('11.00');
        expect(requestBody.stop_loss.stop_price).toBe('9.50');
        // Brackets must stay protected across sessions, not expire after one day (P0 fix).
        expect(requestBody.time_in_force).toBe('gtc');
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
