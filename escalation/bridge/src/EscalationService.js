const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const ALERT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

// Decides whether to ring you, renders the alert with Piper, and drops the
// .call file. The cooldown is what stops a crash-looping bot from calling you
// every minute.
class EscalationService {
    constructor({ synth, callWriter, audioDir, cooldownMs, timeZone = 'UTC', now = () => Date.now() }) {
        this.synth = synth;
        this.callWriter = callWriter;
        this.audioDir = audioDir;
        this.cooldownMs = cooldownMs;
        this.timeZone = timeZone;
        this.now = now;
        this.lastPlacedAt = null;
    }

    // Synchronous gate + async work, so the HTTP caller gets an instant answer
    // while TTS (a few seconds on a Pi 4) happens in the background.
    escalate({ title, message }) {
        const now = this.now();
        if (this.lastPlacedAt !== null && now - this.lastPlacedAt < this.cooldownMs) {
            return { accepted: false, retryInMs: this.cooldownMs - (now - this.lastPlacedAt) };
        }
        // Reserve the slot before any await so two simultaneous crashes can't both call.
        this.lastPlacedAt = now;

        const id = `${now}-${crypto.randomBytes(3).toString('hex')}`;
        const done = this.#place(id, title, message).catch((err) => {
            // No call went out - release the cooldown so the next alert can try again.
            this.lastPlacedAt = null;
            throw err;
        });
        return { accepted: true, id, done };
    }

    async #place(id, title, message) {
        const text = this.composeAlert({ title, message });
        console.log(`[Escalation ${id}] ${text}`);

        try {
            await this.synth.render(text, `alert-${id}`);
            await fs.copyFile(path.join(this.audioDir, `alert-${id}.sln16`), path.join(this.audioDir, 'alert-latest.sln16'));
        } catch (err) {
            // A ringing phone is the most important signal - still place the call.
            console.error(`[Escalation ${id}] Could not render the alert audio (${err.message}); calling anyway.`);
        }

        const callFile = await this.callWriter.place(id);
        console.log(`[Escalation ${id}] Call file queued: ${callFile}`);
        this.#pruneOldAlerts().catch(() => {});
        return id;
    }

    composeAlert({ title, message }) {
        const hour = Number(new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hourCycle: 'h23', timeZone: this.timeZone }).format(new Date(this.now())));
        const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

        return `${greeting}, sir. I regret to inform you that the trading system has reported a critical failure. ` +
            `${EscalationService.speakable(title, 120)}. ${EscalationService.speakable(message, 300)}`;
    }

    // Keeps only what's worth hearing: no stack frames, no control characters, bounded length.
    static speakable(text, maxLength) {
        const cleaned = String(text || '')
            .split('\n')
            .filter((line) => !/^\s*at\s/.test(line))
            .join('. ')
            .replace(/[^\x20-\x7E]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        return cleaned.length > maxLength ? `${cleaned.slice(0, maxLength)}...` : cleaned;
    }

    async #pruneOldAlerts() {
        const cutoff = this.now() - ALERT_RETENTION_MS;
        for (const file of await fs.readdir(this.audioDir)) {
            if (!/^alert-\d/.test(file)) continue;
            const full = path.join(this.audioDir, file);
            const { mtimeMs } = await fs.stat(full);
            if (mtimeMs < cutoff) await fs.rm(full, { force: true });
        }
    }
}

module.exports = EscalationService;
