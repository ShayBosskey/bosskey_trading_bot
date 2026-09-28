const fs = require('fs');
const path = require('path');

// Talks to whisper.cpp's built-in HTTP server (`whisper-server`).
class WhisperClient {
    constructor({ baseUrl, timeoutMs = 60000 }) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.timeoutMs = timeoutMs;
    }

    async transcribe(filePath) {
        const form = new FormData();
        form.append('file', await fs.openAsBlob(filePath), path.basename(filePath));
        form.append('response_format', 'json');
        form.append('temperature', '0');

        const res = await fetch(`${this.baseUrl}/inference`, {
            method: 'POST',
            body: form,
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!res.ok) throw new Error(`whisper-server responded ${res.status}: ${await res.text()}`);

        const body = await res.json();
        return WhisperClient.clean(body.text || '');
    }

    // Whisper marks silence/noise as "[BLANK_AUDIO]", "(wind blowing)" etc.
    static clean(text) {
        return text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    }
}

module.exports = WhisperClient;
