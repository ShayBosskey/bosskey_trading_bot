const fs = require('fs');
const os = require('os');
const path = require('path');
const CallFileWriter = require('../src/CallFileWriter');

describe('CallFileWriter', () => {
    let spool;
    beforeEach(() => { spool = fs.mkdtempSync(path.join(os.tmpdir(), 'spool-')); });
    afterEach(() => { fs.rmSync(spool, { recursive: true, force: true }); });

    test('builds a call file that dials the endpoint into the escalation context', () => {
        const text = new CallFileWriter({ spoolDir: spool, endpoint: 'mobile' }).build('123-abc');
        expect(text).toContain('Channel: PJSIP/mobile\n');
        expect(text).toContain('Context: escalation\n');
        expect(text).toContain('Extension: s\n');
        expect(text).toContain('Setvar: ESC_ID=123-abc\n');
        expect(text).toContain('MaxRetries: 2\n');
    });

    test('rejects ids that could inject extra call-file lines', () => {
        const writer = new CallFileWriter({ spoolDir: spool, endpoint: 'mobile' });
        expect(() => writer.build('x\nChannel: PJSIP/evil')).toThrow(/Invalid escalation id/);
        expect(() => writer.build('')).toThrow();
    });

    test('rejects a malformed endpoint name', () => {
        expect(() => new CallFileWriter({ spoolDir: spool, endpoint: 'mobile/../x' })).toThrow(/Invalid SIP endpoint/);
    });

    test('place() leaves the finished file in outgoing/ and nothing in tmp/', async () => {
        const final = await new CallFileWriter({ spoolDir: spool, endpoint: 'mobile' }).place('42-ff');
        expect(final).toBe(path.join(spool, 'outgoing', 'escalation-42-ff.call'));
        expect(fs.readFileSync(final, 'utf8')).toContain('Setvar: ESC_ID=42-ff');
        expect(fs.readdirSync(path.join(spool, 'tmp'))).toEqual([]);
        // mtime must not be in the future or Asterisk delays the call.
        expect(fs.statSync(final).mtimeMs).toBeLessThanOrEqual(Date.now() + 1000);
    });
});
