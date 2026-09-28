const VoiceEscalator = require('../src/VoiceEscalator');

const TOKEN = 'x'.repeat(40);

describe('VoiceEscalator (bot -> escalation bridge)', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    test('is a no-op when no token is configured', async () => {
        global.fetch = jest.fn();
        const esc = new VoiceEscalator({ token: '' });
        await expect(esc.escalate('t', 'm')).resolves.toBe('disabled');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('posts title/message with the bearer token and reports placed on 202', async () => {
        global.fetch = jest.fn().mockResolvedValue({ status: 202 });
        const esc = new VoiceEscalator({ url: 'http://127.0.0.1:3100/', token: TOKEN });

        await expect(esc.escalate('TradingBot crashed', 'boom')).resolves.toBe('placed');

        const [url, opts] = global.fetch.mock.calls[0];
        expect(url).toBe('http://127.0.0.1:3100/escalate');
        expect(opts.headers.Authorization).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(opts.body)).toEqual({ title: 'TradingBot crashed', message: 'boom' });
    });

    test('reports cooldown on 429', async () => {
        global.fetch = jest.fn().mockResolvedValue({ status: 429 });
        await expect(new VoiceEscalator({ token: TOKEN }).escalate('t', 'm')).resolves.toBe('cooldown');
    });

    test('never throws when the bridge is down', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(new VoiceEscalator({ token: TOKEN }).escalate('t', 'm')).resolves.toBe('failed');
    });
});
