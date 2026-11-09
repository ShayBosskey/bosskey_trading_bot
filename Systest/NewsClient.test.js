const NewsClient = require('../src/NewsClient');

const reply = news => Promise.resolve({ ok: true, json: () => Promise.resolve({ news }) });
const item = (headline, symbols = ['X']) => ({ created_at: '2026-11-09T18:00:00Z', headline, summary: '<p>Some <b>summary</b> &amp; Huang&#39;s</p>', symbols });

describe('NewsClient', () => {
    test('maps crypto pairs to the news feed symbol format', () => {
        expect(NewsClient.toNewsSymbol('BTC/USD')).toBe('BTCUSD');
        expect(NewsClient.toNewsSymbol('AAPL')).toBe('AAPL');
    });

    test('returns symbol and macro headlines, de-duplicated and HTML-stripped', async () => {
        const fetchImpl = jest.fn(url => url.includes('symbols=BTCUSD&') || url.endsWith('symbols=BTCUSD')
            ? reply([item('A'), item('A'), item('B')])
            : reply([item('Macro 1'), item('Macro 2')]));
        const client = new NewsClient({ fetchImpl });

        const ctx = await client.getContext('BTC/USD');

        expect(ctx.available).toBe(true);
        expect(ctx.symbol.map(n => n.headline)).toEqual(['A', 'B']);
        expect(ctx.symbol[0].summary).toBe("Some summary & Huang's");
        expect(ctx.macro.map(n => n.headline)).toEqual(['Macro 1', 'Macro 2']);
        expect(fetchImpl.mock.calls.some(([url]) => url.includes('symbols=BTCUSD'))).toBe(true);
    });

    test('never throws: a total outage reports available=false', async () => {
        const client = new NewsClient({ fetchImpl: jest.fn().mockResolvedValue({ ok: false, status: 500 }) });
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

        const ctx = await client.getContext('AAPL');

        expect(ctx).toEqual({ available: false, symbol: [], macro: [] });
        warn.mockRestore();
    });

    test('caches results so one cycle shares the macro fetch', async () => {
        const fetchImpl = jest.fn(() => reply([item('H')]));
        const client = new NewsClient({ fetchImpl });

        await client.getContext('AAPL');
        await client.getContext('MSFT');

        // AAPL + MSFT symbol queries, but only one macro query.
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });
});
