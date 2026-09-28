const fs = require('fs');
const os = require('os');
const path = require('path');
const EscalationService = require('../src/EscalationService');

function setup({ renderImpl, placeImpl } = {}) {
    const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
    let clock = Date.UTC(2026, 8, 28, 18, 0, 0);
    const synth = {
        render: jest.fn(renderImpl || (async (text, name) => {
            fs.writeFileSync(path.join(audioDir, `${name}.sln16`), 'pcm');
            return `escalation/${name}`;
        }))
    };
    const callWriter = { place: jest.fn(placeImpl || (async (id) => `/spool/outgoing/escalation-${id}.call`)) };
    const service = new EscalationService({ synth, callWriter, audioDir, cooldownMs: 15 * 60 * 1000, timeZone: 'Europe/Zurich', now: () => clock });
    return { service, synth, callWriter, audioDir, advance: (ms) => { clock += ms; } };
}

describe('EscalationService', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('renders the alert, keeps a copy as alert-latest, and queues the call', async () => {
        const { service, callWriter, audioDir } = setup();
        const r = service.escalate({ title: 'TradingBot crashed', message: 'Alpaca 500' });
        expect(r.accepted).toBe(true);
        await r.done;
        expect(callWriter.place).toHaveBeenCalledWith(r.id);
        expect(fs.existsSync(path.join(audioDir, 'alert-latest.sln16'))).toBe(true);
    });

    test('a second alert inside the cooldown is suppressed; after it, allowed', async () => {
        const { service, callWriter, advance } = setup();
        await service.escalate({ title: 'a' }).done;
        advance(5 * 60 * 1000);
        expect(service.escalate({ title: 'b' })).toMatchObject({ accepted: false, retryInMs: 10 * 60 * 1000 });
        advance(10 * 60 * 1000);
        await service.escalate({ title: 'c' }).done;
        expect(callWriter.place).toHaveBeenCalledTimes(2);
    });

    test('still calls when Piper is down', async () => {
        const { service, callWriter } = setup({ renderImpl: async () => { throw new Error('Piper down'); } });
        await service.escalate({ title: 'x' }).done;
        expect(callWriter.place).toHaveBeenCalled();
    });

    test('if the call file cannot be written, the cooldown is released', async () => {
        const { service } = setup({ placeImpl: async () => { throw new Error('EACCES'); } });
        await expect(service.escalate({ title: 'x' }).done).rejects.toThrow('EACCES');
        const retry = service.escalate({ title: 'y' });
        expect(retry.accepted).toBe(true);
        await expect(retry.done).rejects.toThrow('EACCES');
    });

    test('alert text uses a time-of-day greeting and drops stack frames', () => {
        const { service } = setup(); // 18:00 UTC = 20:00 Zurich
        const text = service.composeAlert({ title: 'TradingBot crashed', message: 'TypeError: x is undefined\n    at foo (a.js:1:1)\n    at bar (b.js:2:2)' });
        expect(text).toMatch(/^Good evening, sir\./);
        expect(text).toContain('TypeError: x is undefined');
        expect(text).not.toContain('a.js');
    });
});
