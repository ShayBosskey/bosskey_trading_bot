const net = require('net');

// Incremental parser for the Wyoming protocol (what linuxserver/piper speaks).
// Each event is: one JSON header line, then optionally `data_length` bytes of
// extra JSON, then optionally `payload_length` bytes of binary (raw PCM audio).
class WyomingParser {
    constructor() {
        this.buffer = Buffer.alloc(0);
        this.header = null;
    }

    push(chunk) {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const events = [];

        for (;;) {
            if (!this.header) {
                const newline = this.buffer.indexOf(0x0a);
                if (newline === -1) break;
                this.header = JSON.parse(this.buffer.subarray(0, newline).toString('utf8'));
                this.buffer = this.buffer.subarray(newline + 1);
            }

            const dataLength = this.header.data_length || 0;
            const payloadLength = this.header.payload_length || 0;
            if (this.buffer.length < dataLength + payloadLength) break;

            // Older servers inline `data` in the header; newer ones send it separately.
            let data = this.header.data || {};
            if (dataLength) {
                data = { ...data, ...JSON.parse(this.buffer.subarray(0, dataLength).toString('utf8')) };
            }
            const payload = payloadLength
                ? Buffer.from(this.buffer.subarray(dataLength, dataLength + payloadLength))
                : null;

            events.push({ type: this.header.type, data, payload });
            this.buffer = this.buffer.subarray(dataLength + payloadLength);
            this.header = null;
        }

        return events;
    }
}

class PiperClient {
    constructor({ host, port = 10200, timeoutMs = 60000 }) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
    }

    // Resolves to { rate, width, channels, pcm } - raw signed 16-bit PCM.
    synthesize(text) {
        return new Promise((resolve, reject) => {
            const socket = net.createConnection({ host: this.host, port: this.port });
            const parser = new WyomingParser();
            const chunks = [];
            let format = null;
            let settled = false;

            const finish = (err, value) => {
                if (settled) return;
                settled = true;
                socket.destroy();
                if (err) reject(err);
                else resolve(value);
            };

            socket.setTimeout(this.timeoutMs, () => finish(new Error('Piper timed out.')));
            socket.on('error', (err) => finish(new Error(`Piper connection failed: ${err.message}`)));
            socket.on('close', () => finish(new Error('Piper closed the connection before audio-stop.')));

            socket.on('connect', () => {
                socket.write(JSON.stringify({ type: 'synthesize', data: { text } }) + '\n');
            });

            socket.on('data', (chunk) => {
                let events;
                try {
                    events = parser.push(chunk);
                } catch (err) {
                    return finish(new Error(`Malformed Wyoming stream from Piper: ${err.message}`));
                }

                for (const event of events) {
                    if (event.type === 'audio-start') {
                        format = { rate: event.data.rate, width: event.data.width, channels: event.data.channels };
                    } else if (event.type === 'audio-chunk' && event.payload) {
                        format = format || { rate: event.data.rate, width: event.data.width, channels: event.data.channels };
                        chunks.push(event.payload);
                    } else if (event.type === 'audio-stop') {
                        if (!format || chunks.length === 0) return finish(new Error('Piper returned no audio.'));
                        return finish(null, { ...format, pcm: Buffer.concat(chunks) });
                    } else if (event.type === 'error') {
                        return finish(new Error(`Piper error: ${event.data.text || JSON.stringify(event.data)}`));
                    }
                }
            });
        });
    }
}

module.exports = { PiperClient, WyomingParser };
