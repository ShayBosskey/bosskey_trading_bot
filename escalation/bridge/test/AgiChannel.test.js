const { EventEmitter } = require('events');
const { AgiChannel, HangupError } = require('../src/AgiChannel');

class FakeSocket extends EventEmitter {
    constructor() { super(); this.written = []; }
    setEncoding() {}
    write(s) { this.written.push(s); }
    end() { this.emit('close'); }
    feed(s) { this.emit('data', s); }
}

describe('AgiChannel', () => {
    test('parseResponse handles result, data and trailing fields', () => {
        expect(AgiChannel.parseResponse('200 result=1 (timeout) endpos=1234')).toEqual({ code: 200, result: '1', data: 'timeout', rest: 'endpos=1234' });
        expect(AgiChannel.parseResponse('200 result= (timeout)')).toMatchObject({ code: 200, result: '', data: 'timeout' });
        expect(AgiChannel.parseResponse('200 result=-1 endpos=0')).toMatchObject({ result: '-1', data: null });
    });

    test('reads the agi_ environment then runs commands in order', async () => {
        const sock = new FakeSocket();
        const ch = new AgiChannel(sock);
        const init = ch.init();
        sock.feed('agi_network: yes\nagi_arg_1: 99-ab\n\n');
        await expect(init).resolves.toMatchObject({ agi_arg_1: '99-ab' });

        const play = ch.streamFile('escalation/tts-1');
        sock.feed('200 result=0 endpos=8000\n');
        await expect(play).resolves.toMatchObject({ code: 200, result: '0' });
        expect(sock.written).toEqual(['STREAM FILE escalation/tts-1 ""\n']);

        const digits = ch.getData('escalation/tts-2', 8000, 1);
        sock.feed('200 result=1\n');
        await expect(digits).resolves.toBe('1');
    });

    test('builds RECORD FILE with beep and silence detection', async () => {
        const sock = new FakeSocket();
        const ch = new AgiChannel(sock);
        const p = ch.recordFile('/var/lib/asterisk/sounds/escalation/rec-1');
        sock.feed('200 result=0 (silence) endpos=16000\n');
        await p;
        expect(sock.written[0]).toBe('RECORD FILE /var/lib/asterisk/sounds/escalation/rec-1 wav "#" 15000 0 BEEP s=2\n');
    });

    test('HANGUP notice + result=-1 raises HangupError', async () => {
        const sock = new FakeSocket();
        const ch = new AgiChannel(sock);
        const p = ch.streamFile('x');
        sock.feed('HANGUP\n200 result=-1 endpos=0\n');
        await expect(p).rejects.toBeInstanceOf(HangupError);
    });

    test('result=-1 without a hangup is a plain failure (e.g. missing sound file)', async () => {
        const sock = new FakeSocket();
        const ch = new AgiChannel(sock);
        const p = ch.streamFile('missing');
        sock.feed('200 result=-1 endpos=0\n');
        await expect(p).rejects.toThrow(/AGI command failed/);
        await expect(p).rejects.not.toBeInstanceOf(HangupError);
    });

    test('socket closing mid-command raises HangupError', async () => {
        const sock = new FakeSocket();
        const ch = new AgiChannel(sock);
        const p = ch.streamFile('x');
        sock.emit('close');
        await expect(p).rejects.toBeInstanceOf(HangupError);
    });
});
