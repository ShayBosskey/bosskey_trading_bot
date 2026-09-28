// Executes confirmed voice commands against the trading bot's own Dashboard API
// (src/DashboardAPI.js), using the same bearer token the dashboard uses.
//
// Deliberately one-directional: a phone call can only move the bot TOWARDS
// safety (CONSTRUCTION or PAPER). PRODUCTION is not reachable from here, no
// matter what was said or transcribed.
const SAFE_MODES = new Set(['CONSTRUCTION', 'PAPER']);

class BotActions {
    constructor({ baseUrl, adminToken, timeoutMs = 10000 }) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.adminToken = adminToken;
        this.timeoutMs = timeoutMs;
    }

    async setMode(targetMode) {
        if (!SAFE_MODES.has(targetMode)) {
            throw new Error(`Refusing to switch to ${targetMode} from a voice call.`);
        }
        if (!this.adminToken || this.adminToken === 'CHANGE_ME') {
            throw new Error('BOT_ADMIN_TOKEN is not configured.');
        }

        const res = await fetch(`${this.baseUrl}/api/v1/system/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.adminToken}` },
            body: JSON.stringify({ targetMode }),
            signal: AbortSignal.timeout(this.timeoutMs)
        });
        if (!res.ok) throw new Error(`Bot API rejected mode change (${res.status}): ${await res.text()}`);
        return res.json();
    }

    async status() {
        const res = await fetch(`${this.baseUrl}/api/v1/system/status`, { signal: AbortSignal.timeout(this.timeoutMs) });
        if (!res.ok) throw new Error(`Bot API status failed (${res.status}).`);
        return res.json(); // { mode, isTradingAllowed, serverTime }
    }
}

module.exports = BotActions;
