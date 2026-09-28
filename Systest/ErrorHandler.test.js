jest.mock('../src/Notifier');
jest.mock('../src/VoiceEscalator');

const Notifier = require('../src/Notifier');
const VoiceEscalator = require('../src/VoiceEscalator');
const attachGlobalErrorLogger = require('../src/ErrorHandler');

describe('attachGlobalErrorLogger', () => {
    let exitSpy;
    const before = {};

    beforeEach(() => {
        Notifier.prototype.push = jest.fn().mockResolvedValue();
        VoiceEscalator.prototype.escalate = jest.fn().mockResolvedValue('placed');
        exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        before.exc = process.listeners('uncaughtException');
        before.rej = process.listeners('unhandledRejection');
        attachGlobalErrorLogger('TradingBot');
    });

    afterEach(() => {
        // Remove only the listeners this test added (Jest has its own).
        for (const l of process.listeners('uncaughtException')) if (!before.exc.includes(l)) process.off('uncaughtException', l);
        for (const l of process.listeners('unhandledRejection')) if (!before.rej.includes(l)) process.off('unhandledRejection', l);
        jest.restoreAllMocks();
    });

    const newListener = (event, prev) => process.listeners(event).find((l) => !prev.includes(l));
    const flush = () => new Promise((r) => setImmediate(r));

    test('an uncaught exception sends the push AND requests a voice call, then exits 1', async () => {
        newListener('uncaughtException', before.exc)(new Error('Alpaca socket died'));
        await flush();

        expect(Notifier.prototype.push).toHaveBeenCalledWith('CRITICAL SYSTEM CRASH', expect.stringContaining('Alpaca socket died'), 'rotating_light');
        expect(VoiceEscalator.prototype.escalate).toHaveBeenCalledWith('TradingBot crashed', 'Uncaught Exception: Alpaca socket died');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });

    test('an unhandled rejection with a non-Error reason is escalated too', async () => {
        newListener('unhandledRejection', before.rej)('db pool exhausted');
        await flush();

        expect(VoiceEscalator.prototype.escalate).toHaveBeenCalledWith('TradingBot crashed', 'Unhandled Rejection: db pool exhausted');
        expect(exitSpy).toHaveBeenCalledWith(1);
    });
});
