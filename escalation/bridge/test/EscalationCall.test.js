const fs = require('fs');
const os = require('os');
const path = require('path');
const { EscalationCall, LINES } = require('../src/EscalationCall');
const { HangupError } = require('../src/AgiChannel');
const { ACTIONS } = require('../src/CommandParser');

// Scripted fake of a live call: each recording "contains" the next transcript,
// and each keypad prompt returns the next scripted digit.
function setup({ transcripts, digits = [], setModeImpl } = {}) {
    const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-'));
    const said = [];
    const heard = [...transcripts];
    const channel = {
        streamFile: jest.fn(async (name) => said.push(name)),
        recordFile: jest.fn(async (astPath) => {
            const text = heard.shift();
            if (text === undefined) throw new HangupError();
            // Simulate Asterisk writing the recording into the shared volume.
            fs.writeFileSync(path.join(audioDir, `${path.basename(astPath)}.wav`), Buffer.alloc(text ? 20000 : 100));
            channel.lastTranscript = text;
        }),
        getData: jest.fn(async () => digits.shift() ?? ''),
        hangup: jest.fn(async () => {}),
        close: jest.fn()
    };
    const synth = { render: jest.fn(async (text) => `tts:${text}`) };
    const whisper = { transcribe: jest.fn(async () => channel.lastTranscript) };
    const parser = {
        parse: jest.fn(async (t) => ({
            action: /halt/i.test(t) ? ACTIONS.HALT_TRADING : /status/i.test(t) ? ACTIONS.STATUS_REPORT : /ack/i.test(t) ? ACTIONS.ACKNOWLEDGE : ACTIONS.UNKNOWN,
            via: 'keyword'
        }))
    };
    const actions = {
        setMode: jest.fn(setModeImpl || (async () => ({}))),
        status: jest.fn(async () => ({ mode: 'PAPER', isTradingAllowed: true }))
    };
    const call = new EscalationCall({ channel, escalationId: '1-a', synth, whisper, parser, actions, audioDir, asteriskAudioDir: '/ast/escalation' });
    return { call, channel, actions, said, audioDir };
}

describe('EscalationCall conversation', () => {
    beforeEach(() => {
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });
    afterEach(() => jest.restoreAllMocks());

    test('halt + pressing 1 switches the bot to CONSTRUCTION', async () => {
        const { call, actions, said, channel } = setup({ transcripts: ['Halt trading'], digits: ['1'] });
        await call.run();
        expect(actions.setMode).toHaveBeenCalledWith('CONSTRUCTION');
        expect(said).toContain(`tts:${LINES.done[ACTIONS.HALT_TRADING]}`);
        expect(channel.hangup).toHaveBeenCalled();
    });

    test('halt without pressing 1 changes nothing', async () => {
        const { call, actions, said } = setup({ transcripts: ['Halt trading'], digits: [''] });
        await call.run();
        expect(actions.setMode).not.toHaveBeenCalled();
        expect(said).toContain(`tts:${LINES.cancelled}`);
    });

    test('status report is read back, then it listens again', async () => {
        const { call, actions, said } = setup({ transcripts: ['status report', 'acknowledged'] });
        await call.run();
        expect(actions.status).toHaveBeenCalled();
        expect(said).toContain('tts:The bot is in paper mode, and trading is currently enabled.');
        expect(said).toContain(`tts:${LINES.acknowledged}`);
        expect(actions.setMode).not.toHaveBeenCalled();
    });

    test('three unintelligible replies -> gives up without acting', async () => {
        const { call, actions, said } = setup({ transcripts: ['mumble', '', 'blah'] });
        await call.run();
        expect(actions.setMode).not.toHaveBeenCalled();
        expect(said[said.length - 1]).toBe(`tts:${LINES.giveUp}`);
    });

    test('a failing bot API is reported on the call, not thrown', async () => {
        const { call, said } = setup({ transcripts: ['halt'], digits: ['1'], setModeImpl: async () => { throw new Error('503'); } });
        await call.run();
        expect(said).toContain(`tts:${LINES.actionFailed}`);
    });

    test('recordings are deleted after transcription', async () => {
        const { call, audioDir } = setup({ transcripts: ['acknowledged'] });
        await call.run();
        expect(fs.readdirSync(audioDir).filter((f) => f.startsWith('rec-'))).toEqual([]);
    });

    test('caller hanging up ends the call quietly', async () => {
        const { call, channel } = setup({ transcripts: [] });
        await expect(call.run()).resolves.toBeUndefined();
        expect(channel.close).toHaveBeenCalled();
    });
});
