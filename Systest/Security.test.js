const fs = require('fs');
const os = require('os');
const path = require('path');
const { redact, MASK } = require('../src/Redactor');
const Notifier = require('../src/Notifier');
const { runWatchdog, heartbeatProblem } = require('../src/ExitEngineWatchdog');

describe('Redactor', () => {
    const saved = { ...process.env };
    afterEach(() => { process.env = { ...saved }; });

    test('masks the value of every secret-named env var', () => {
        process.env.ALPACA_SECRET_KEY = 'sk_live_abcdefgh12345';
        process.env.DB_PASSWORD = 'hunter2hunter2';
        const out = redact('auth failed for sk_live_abcdefgh12345 using hunter2hunter2');
        expect(out).toBe(`auth failed for ${MASK} using ${MASK}`);
    });

    test('masks bearer tokens, key query params and connection-string passwords', () => {
        expect(redact('Authorization: Bearer abcdefghijklmnop')).toBe(`Authorization: Bearer ${MASK}`);
        expect(redact('GET https://x.test/v1?key=AIzaSyXYZ123&alt=json')).toBe(`GET https://x.test/v1?key=${MASK}&alt=json`);
        expect(redact('postgres://bot:p4ss@localhost/db')).toBe(`postgres://bot:${MASK}@localhost/db`);
    });

    test('leaves ordinary text and short env values alone', () => {
        process.env.SOME_TOKEN = 'abc';
        expect(redact('BTC/USD stop hit at 74000')).toBe('BTC/USD stop hit at 74000');
    });
});

describe('Notifier throttling', () => {
    let stateFile;
    let clock;
    let fetchImpl;
    const make = () => new Notifier({ topicUrl: 'https://ntfy.test/t', stateFile, now: () => clock, fetchImpl });

    beforeEach(() => {
        stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ntfy-')), 'state.json');
        clock = Date.UTC(2026, 10, 9, 20, 0, 0);
        fetchImpl = jest.fn().mockResolvedValue({ ok: true });
        jest.spyOn(console, 'log').mockImplementation(() => {});
    });
    afterEach(() => console.log.mockRestore());

    test('mutes a repeat for 90 minutes across fresh processes, then reports the count', async () => {
        expect(await make().push('Stream Down', 'No quotes for 61s', 'warning')).toBe('sent');
        clock += 15 * 60 * 1000;
        expect(await make().push('Stream Down', 'No quotes for 75s', 'warning')).toBe('muted'); // numbers ignored
        clock += 15 * 60 * 1000;
        expect(await make().push('Stream Down', 'No quotes for 90s', 'warning')).toBe('muted');
        clock += 61 * 60 * 1000;
        expect(await make().push('Stream Down', 'No quotes for 99s', 'warning')).toBe('sent');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(fetchImpl.mock.calls[1][1].body).toContain('Repeated 2x');
    });

    test('a different alert is never muted by another', async () => {
        await make().push('Exit Failed', 'BTC/USD rejected', 'warning');
        expect(await make().push('Exit Failed', 'ETH/USD rejected', 'warning')).toBe('sent');
    });

    test('critical alerts push with urgent priority and only collapse a 10-minute burst', async () => {
        expect(await make().push('CRITICAL SYSTEM CRASH', 'boom', 'rotating_light')).toBe('sent');
        expect(fetchImpl.mock.calls[0][1].headers.Priority).toBe('urgent');
        clock += 5 * 60 * 1000;
        expect(await make().push('CRITICAL SYSTEM CRASH', 'boom', 'rotating_light')).toBe('muted');
        clock += 6 * 60 * 1000;
        expect(await make().push('CRITICAL SYSTEM CRASH', 'boom', 'rotating_light')).toBe('sent');
    });

    test('a failed send is not recorded, so the retry is not muted', async () => {
        fetchImpl.mockResolvedValueOnce({ ok: false, status: 502 });
        jest.spyOn(console, 'error').mockImplementation(() => {});
        expect(await make().push('A', 'b')).toBe('failed');
        expect(await make().push('A', 'b')).toBe('sent');
        console.error.mockRestore();
    });

    test('secrets are redacted from the push payload', async () => {
        process.env.TEST_API_KEY = 'zzzz-secret-value-1234';
        await make().push('Error', 'request failed with zzzz-secret-value-1234');
        expect(fetchImpl.mock.calls[0][1].body).not.toContain('zzzz-secret-value-1234');
        delete process.env.TEST_API_KEY;
    });
});

describe('ExitEngineWatchdog', () => {
    const fresh = { at: new Date().toISOString() };
    const stale = { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    const deps = () => ({ notifier: { push: jest.fn() }, escalator: { escalate: jest.fn() } });
    beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
    afterEach(() => console.error.mockRestore());

    test('a fresh heartbeat is healthy', async () => {
        expect(heartbeatProblem(fresh)).toBeNull();
        const d = deps();
        expect(await runWatchdog({ ...d, beat: fresh, openCount: 3 })).toBe('ok');
        expect(d.escalator.escalate).not.toHaveBeenCalled();
    });

    test('stale heartbeat with open positions phones the owner and pushes urgently', async () => {
        const d = deps();
        expect(await runWatchdog({ ...d, beat: stale, openCount: 2 })).toBe('down-exposed');
        expect(d.escalator.escalate).toHaveBeenCalledTimes(1);
        expect(d.notifier.push.mock.calls[0][2]).toBe('rotating_light');
    });

    test('a missing heartbeat with an unknown DB state is treated as exposed', async () => {
        const d = deps();
        expect(await runWatchdog({ ...d, beat: null, openCount: null })).toBe('down-exposed');
    });

    test('stale heartbeat with nothing open only pushes, no call', async () => {
        const d = deps();
        expect(await runWatchdog({ ...d, beat: stale, openCount: 0 })).toBe('down-idle');
        expect(d.escalator.escalate).not.toHaveBeenCalled();
    });
});

describe('SIP registration check', () => {
    const { checkSipRegistration } = require('../src/ExitEngineWatchdog');

    test('a registered phone is silent; an unregistered one pushes a warning', async () => {
        const notifier = { push: jest.fn() };
        expect(await checkSipRegistration({ notifier, registered: true })).toBe('registered');
        expect(notifier.push).not.toHaveBeenCalled();
        expect(await checkSipRegistration({ notifier, registered: false })).toBe('unregistered');
        expect(notifier.push.mock.calls[0][0]).toBe('Voice Escalation Unreachable');
    });
});
