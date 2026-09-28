// One live call, driven over FastAGI.
//
// Asterisk opens a TCP connection, sends "agi_xxx: value" lines ending in a
// blank line, then waits for us to send commands one at a time. Every command
// gets a reply like `200 result=1 (timeout) endpos=1234`.
class HangupError extends Error {
    constructor(message = 'Caller hung up.') {
        super(message);
        this.name = 'HangupError';
    }
}

class AgiChannel {
    constructor(socket) {
        this.socket = socket;
        this.env = {};
        this.buffer = '';
        this.lines = [];
        this.waiters = [];
        this.closed = false;
        this.hungUp = false;

        socket.setEncoding('utf8');
        socket.on('data', (chunk) => this.#onData(chunk));
        socket.on('close', () => this.#onClose());
        socket.on('error', () => this.#onClose());
    }

    static parseResponse(line) {
        const m = /^(\d{3})(?: result=(\S*))?(?: \(([^)]*)\))?(.*)$/.exec(line);
        if (!m) return { code: 0, result: null, data: null, rest: line };
        return { code: Number(m[1]), result: m[2] ?? null, data: m[3] ?? null, rest: m[4].trim() };
    }

    async init() {
        for (;;) {
            const line = await this.#readLine();
            if (line === '') break;
            const idx = line.indexOf(':');
            if (idx > 0) this.env[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
        }
        return this.env;
    }

    async command(cmd) {
        if (this.closed) throw new HangupError();
        this.socket.write(`${cmd}\n`);

        // Skip Asterisk's "HANGUP" notice and the body of multi-line (520-) errors.
        for (;;) {
            const line = await this.#readLine();
            if (line === 'HANGUP') {
                this.hungUp = true;
                continue;
            }
            if (!/^\d{3} /.test(line)) continue;

            const res = AgiChannel.parseResponse(line);
            if (res.code === 511) throw new HangupError();
            // result=-1 means either "caller hung up" or "that failed" (e.g. a
            // missing sound file) - only the HANGUP notice tells them apart.
            if (res.result === '-1') {
                if (this.hungUp) throw new HangupError();
                throw new Error(`AGI command failed: "${cmd}" -> ${line}`);
            }
            if (res.code !== 200) throw new Error(`AGI command failed: "${cmd}" -> ${line}`);
            return res;
        }
    }

    streamFile(name, escapeDigits = '') {
        return this.command(`STREAM FILE ${name} "${escapeDigits}"`);
    }

    // Records until `silenceSec` of silence, `#` pressed, or timeoutMs.
    recordFile(pathWithoutExt, { format = 'wav', escapeDigits = '#', timeoutMs = 15000, silenceSec = 2, beep = true } = {}) {
        return this.command(`RECORD FILE ${pathWithoutExt} ${format} "${escapeDigits}" ${timeoutMs} 0${beep ? ' BEEP' : ''} s=${silenceSec}`);
    }

    // Plays a prompt and collects keypad digits. Returns the digits ('' on timeout).
    async getData(promptName, timeoutMs = 8000, maxDigits = 1) {
        const res = await this.command(`GET DATA ${promptName} ${timeoutMs} ${maxDigits}`);
        return res.result || '';
    }

    async hangup() {
        try {
            await this.command('HANGUP');
        } catch {
            // Already gone - that's the goal anyway.
        }
    }

    close() {
        this.socket.end();
    }

    #onData(chunk) {
        this.buffer += chunk;
        let idx;
        while ((idx = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, idx).replace(/\r$/, '');
            this.buffer = this.buffer.slice(idx + 1);
            const waiter = this.waiters.shift();
            if (waiter) waiter.resolve(line);
            else this.lines.push(line);
        }
    }

    #onClose() {
        if (this.closed) return;
        this.closed = true;
        this.hungUp = true;
        for (const waiter of this.waiters.splice(0)) waiter.reject(new HangupError());
    }

    #readLine() {
        if (this.lines.length) return Promise.resolve(this.lines.shift());
        if (this.closed) return Promise.reject(new HangupError());
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }
}

module.exports = { AgiChannel, HangupError };
