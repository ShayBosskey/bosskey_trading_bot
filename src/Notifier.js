const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { redact } = require('./Redactor');

// ntfy.sh topics are public: anyone who knows the name can subscribe. Set
// NTFY_TOPIC_URL in .env to a long random topic; the old name is the fallback.
const DEFAULT_TOPIC_URL = 'https://ntfy.sh/bosskey_trading_rasp_200';

// Anti-spam. Cron starts a fresh process every few minutes, so the mute state
// lives on disk, shared by every script that pushes.
const STATE_FILE = path.resolve(__dirname, '../run/notifier-state.json');
// A repeat of the same alert is muted this long...
const REPEAT_MUTE_MS = 90 * 60 * 1000;
// ...except critical alerts, which only collapse an exact burst (a crash loop).
const CRITICAL_REPEAT_MS = 10 * 60 * 1000;
const STATE_RETENTION_MS = 24 * 60 * 60 * 1000;
const CRITICAL_TAGS = /rotating_light/;

// Same alert = same title and same text once numbers are ignored, so "down for
// 61s" and "down for 75s" collapse, while a different symbol or error does not.
function fingerprint(title, message) {
    const normalized = `${title}|${message}`.toLowerCase().replace(/\d+(\.\d+)?/g, '#').replace(/\s+/g, ' ').slice(0, 300);
    return crypto.createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}

class Notifier {
    constructor({ topicUrl = process.env.NTFY_TOPIC_URL || DEFAULT_TOPIC_URL, stateFile = STATE_FILE, now = () => Date.now(), fetchImpl = (...args) => fetch(...args) } = {}) {
        this.topicUrl = topicUrl;
        this.stateFile = stateFile;
        this.now = now;
        this.fetch = fetchImpl;
    }

    #loadState() {
        try {
            return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
        } catch {
            return {};
        }
    }

    #saveState(state) {
        try {
            const cutoff = this.now() - STATE_RETENTION_MS;
            for (const [key, entry] of Object.entries(state)) {
                if (entry.lastSent < cutoff) delete state[key];
            }
            fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
            fs.writeFileSync(`${this.stateFile}.${process.pid}.tmp`, JSON.stringify(state));
            fs.renameSync(`${this.stateFile}.${process.pid}.tmp`, this.stateFile);
        } catch (err) {
            console.error(`[Notifier] Could not save throttle state: ${err.message}`);
        }
    }

    // Resolves to 'sent' | 'muted' | 'failed'. Never throws: it runs inside crash handlers.
    async push(title, message, tags = '', { critical = CRITICAL_TAGS.test(tags) } = {}) {
        try {
            const safeTitle = redact(title).replace(/[^\x00-\x7F]/g, '').trim();
            let body = redact(message);

            const key = fingerprint(safeTitle, body);
            const state = this.#loadState();
            const entry = state[key];
            const window = critical ? CRITICAL_REPEAT_MS : REPEAT_MUTE_MS;

            if (entry && this.now() - entry.lastSent < window) {
                entry.suppressed = (entry.suppressed || 0) + 1;
                this.#saveState(state);
                console.log(`[Notifier] 🔇 Muted repeat of "${safeTitle}" (${entry.suppressed} since last push).`);
                return 'muted';
            }

            if (entry?.suppressed) {
                const since = new Date(entry.lastSent).toLocaleTimeString('de-CH', { timeZone: 'Europe/Zurich', hour: '2-digit', minute: '2-digit' });
                body += `\n\n(Repeated ${entry.suppressed}x since ${since}; repeats were muted.)`;
            }

            const headers = { Title: safeTitle, Tags: tags };
            if (critical) headers.Priority = 'urgent';

            const response = await this.fetch(this.topicUrl, { method: 'POST', body, headers, signal: AbortSignal.timeout(8000) });
            if (!response.ok) throw new Error(`ntfy responded ${response.status}`);

            state[key] = { lastSent: this.now(), suppressed: 0 };
            this.#saveState(state);
            console.log(`[Notifier] 📱 Push notification sent: "${safeTitle}"`);
            return 'sent';
        } catch (err) {
            // Not recorded as sent, so the next attempt is not muted.
            console.error('\n[Notifier Error]:', redact(err.message));
            return 'failed';
        }
    }
}

module.exports = Notifier;
module.exports.fingerprint = fingerprint;
module.exports.REPEAT_MUTE_MS = REPEAT_MUTE_MS;
module.exports.CRITICAL_REPEAT_MS = CRITICAL_REPEAT_MS;
