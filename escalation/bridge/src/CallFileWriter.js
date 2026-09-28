const fs = require('fs/promises');
const path = require('path');

// Builds an Asterisk .call file and hands it to Asterisk's outgoing spool.
//
// Asterisk polls /var/spool/asterisk/outgoing and dials the moment a file shows
// up there, so the file must appear COMPLETE in one step. Writing straight into
// outgoing/ risks Asterisk reading a half-written file. Instead we write into
// tmp/ on the same volume and rename() it across - a rename within one
// filesystem is atomic.
class CallFileWriter {
    constructor({ spoolDir, endpoint, callerId = '"Bosskey Butler" <900>', maxRetries = 2, retryTime = 60, waitTime = 45 }) {
        if (!spoolDir) throw new Error('CallFileWriter requires spoolDir.');
        if (!/^[A-Za-z0-9_-]+$/.test(endpoint || '')) throw new Error(`Invalid SIP endpoint name: ${endpoint}`);

        this.spoolDir = spoolDir;
        this.endpoint = endpoint;
        this.callerId = callerId;
        this.maxRetries = maxRetries;   // redial attempts if you don't answer
        this.retryTime = retryTime;     // seconds between attempts
        this.waitTime = waitTime;       // seconds to let the phone ring each attempt
    }

    build(escalationId) {
        // The id lands in the call file and the dialplan - only allow a strict
        // charset so nothing can smuggle in an extra "Setvar:" or dialplan code.
        if (!/^[A-Za-z0-9-]+$/.test(escalationId || '')) {
            throw new Error(`Invalid escalation id: ${escalationId}`);
        }

        return [
            `Channel: PJSIP/${this.endpoint}`,
            `CallerID: ${this.callerId}`,
            `MaxRetries: ${this.maxRetries}`,
            `RetryTime: ${this.retryTime}`,
            `WaitTime: ${this.waitTime}`,
            'Context: escalation',
            'Extension: s',
            'Priority: 1',
            `Setvar: ESC_ID=${escalationId}`,
            'Archive: no',
            ''
        ].join('\n');
    }

    async place(escalationId) {
        const content = this.build(escalationId);
        const tmpDir = path.join(this.spoolDir, 'tmp');
        const outgoingDir = path.join(this.spoolDir, 'outgoing');
        await fs.mkdir(tmpDir, { recursive: true });
        await fs.mkdir(outgoingDir, { recursive: true });

        const fileName = `escalation-${escalationId}.call`;
        const tmpPath = path.join(tmpDir, fileName);
        const finalPath = path.join(outgoingDir, fileName);

        await fs.writeFile(tmpPath, content, { mode: 0o644 });
        // Asterisk treats a future mtime as "dial later". Pin it to now so the
        // call goes out immediately regardless of clock skew between containers.
        const now = new Date();
        await fs.utimes(tmpPath, now, now);
        await fs.rename(tmpPath, finalPath);

        return finalPath;
    }
}

module.exports = CallFileWriter;
