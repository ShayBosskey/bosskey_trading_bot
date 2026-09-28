require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });

// Asks the local voice-escalation bridge (escalation/ docker stack) to phone the
// owner about a critical failure. The bridge does the TTS, the Asterisk .call
// file and the conversation; this class only raises the request.
//
// Never throws and never blocks for long: it runs inside crash handlers, where
// a hung or failing escalation must not stop the push notification or the exit.
class VoiceEscalator {
    constructor({ url = process.env.ESCALATION_BRIDGE_URL || 'http://127.0.0.1:3100', token = process.env.ESCALATION_TOKEN, timeoutMs = 3000 } = {}) {
        this.url = url.replace(/\/$/, '');
        this.token = token;
        this.timeoutMs = timeoutMs;
    }

    isEnabled() {
        return Boolean(this.token) && this.token.length >= 32;
    }

    // Resolves to 'placed' | 'cooldown' | 'disabled' | 'failed'.
    async escalate(title, message) {
        if (!this.isEnabled()) return 'disabled';

        try {
            const res = await fetch(`${this.url}/escalate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
                body: JSON.stringify({ title, message }),
                signal: AbortSignal.timeout(this.timeoutMs)
            });

            if (res.status === 202) {
                console.log(`[VoiceEscalator] 📞 Escalation call requested: "${title}"`);
                return 'placed';
            }
            if (res.status === 429) {
                console.log('[VoiceEscalator] Call suppressed: bridge cooldown still active.');
                return 'cooldown';
            }
            console.error(`[VoiceEscalator Error]: bridge responded ${res.status}`);
            return 'failed';
        } catch (err) {
            console.error(`[VoiceEscalator Error]: ${err.message}`);
            return 'failed';
        }
    }
}

module.exports = VoiceEscalator;
