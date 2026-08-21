const FundamentalClient = require('../src/FundamentalClient');

// Mock global fetch to simulate Finnhub returning an upcoming earnings report
global.fetch = jest.fn(() =>
    Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
            earningsCalendar: [
                { date: '2026-08-23', symbol: 'TEST' }
            ]
        }),
    })
);

describe('Fundamental Data Architecture', () => {
    let originalEnv;

    beforeAll(() => {
        originalEnv = process.env.FINNHUB_API_KEY;
        process.env.FINNHUB_API_KEY = 'valid_test_key';
    });

    afterAll(() => {
        process.env.FINNHUB_API_KEY = originalEnv;
    });

    beforeEach(() => {
        fetch.mockClear();
    });

    test('hasUpcomingEarnings returns TRUE if an earnings report is detected within 5 days', async () => {
        const client = new FundamentalClient();
        const hasRisk = await client.hasUpcomingEarnings('TEST');
        
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(hasRisk).toBe(true);
    });
});
