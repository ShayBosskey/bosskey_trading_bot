const BotActions = require('../src/BotActions');

describe('BotActions', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    test('can never switch the bot to PRODUCTION', async () => {
        global.fetch = jest.fn();
        const a = new BotActions({ baseUrl: 'http://bot:3000', adminToken: 't'.repeat(40) });
        await expect(a.setMode('PRODUCTION')).rejects.toThrow(/Refusing/);
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('halts via the authenticated mode endpoint', async () => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
        await new BotActions({ baseUrl: 'http://bot:3000/', adminToken: 't'.repeat(40) }).setMode('CONSTRUCTION');
        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://bot:3000/api/v1/system/mode');
        expect(opts.headers.Authorization).toBe(`Bearer ${'t'.repeat(40)}`);
        expect(JSON.parse(opts.body)).toEqual({ targetMode: 'CONSTRUCTION' });
    });

    test('refuses to act without a configured admin token', async () => {
        await expect(new BotActions({ baseUrl: 'http://bot:3000', adminToken: 'CHANGE_ME' }).setMode('PAPER')).rejects.toThrow(/not configured/);
    });
});
