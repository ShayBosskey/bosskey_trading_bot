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
