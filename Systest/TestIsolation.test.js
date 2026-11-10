const Notifier = require('../src/Notifier');

describe('test isolation', () => {
    test('a default Notifier built inside a test never posts to the live ntfy topic', async () => {
        require('dotenv').config({ path: require('path').join(__dirname, '../.env'), quiet: true });
        const notifier = new Notifier();
        expect(notifier.topicUrl).toBe('https://ntfy.invalid/jest-sink');
        expect(await notifier.push('Isolation Check', 'should be swallowed')).toBe('sent');
        expect(globalThis.__blockedNtfyPushes.map(p => p.title)).toContain('Isolation Check');
    });

    test('even the hard-coded public fallback topic is intercepted', async () => {
        const notifier = new Notifier({ topicUrl: 'https://ntfy.sh/bosskey_trading_rasp_200' });
        await notifier.push('Fallback Check', 'should be swallowed');
        expect(globalThis.__blockedNtfyPushes.map(p => p.url)).toContain('https://ntfy.sh/bosskey_trading_rasp_200');
    });
});
