const BrokerClient = require('../src/BrokerClient');

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
