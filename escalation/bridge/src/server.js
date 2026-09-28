const http = require('http');
const net = require('net');
const crypto = require('crypto');

const CallFileWriter = require('./CallFileWriter');
const { PiperClient } = require('./PiperClient');
const SpeechSynthesizer = require('./SpeechSynthesizer');
const WhisperClient = require('./WhisperClient');
const { CommandParser } = require('./CommandParser');
const BotActions = require('./BotActions');
const { AgiChannel } = require('./AgiChannel');
const { EscalationCall, LINES } = require('./EscalationCall');
const EscalationService = require('./EscalationService');

const env = process.env;
const HTTP_PORT = Number(env.HTTP_PORT || 3100);
const AGI_PORT = Number(env.AGI_PORT || 4573);
const AUDIO_DIR = env.AUDIO_DIR || '/audio';
const ASTERISK_AUDIO_DIR = env.ASTERISK_AUDIO_DIR || '/var/lib/asterisk/sounds/escalation';
const OLLAMA_URL = env.OLLAMA_URL || 'http://ollama:11434';
const OLLAMA_MODEL = env.OLLAMA_MODEL || 'qwen2.5:1.5b';

class EscalationBridge {
    constructor() {
        const piper = new PiperClient({ host: env.PIPER_HOST || 'piper', port: Number(env.PIPER_PORT || 10200) });
        this.synth = new SpeechSynthesizer({ piper, audioDir: AUDIO_DIR, voiceTag: env.PIPER_VOICE || '' });
        this.whisper = new WhisperClient({ baseUrl: env.WHISPER_URL || 'http://whisper:8080' });
        this.parser = new CommandParser({ ollamaUrl: OLLAMA_URL, model: OLLAMA_MODEL });
        this.actions = new BotActions({ baseUrl: env.BOT_API_URL || 'http://host.docker.internal:3000', adminToken: env.BOT_ADMIN_TOKEN });
        this.service = new EscalationService({
            synth: this.synth,
            callWriter: new CallFileWriter({ spoolDir: env.SPOOL_DIR || '/spool', endpoint: env.SIP_USERNAME || 'mobile' }),
            audioDir: AUDIO_DIR,
            cooldownMs: Number(env.CALL_COOLDOWN_MINUTES || 15) * 60 * 1000,
            timeZone: env.TZ || 'UTC'
        });
    }

    start() {
        this.#startHttp();
        this.#startAgi();
        this.#warmUp();
    }

    // ---- HTTP: the trading bot calls POST /escalate -------------------------
    #startHttp() {
        http.createServer((req, res) => {
            this.#handleHttp(req, res).catch((err) => {
                console.error(`[HTTP] ${err.message}`);
                this.#json(res, 500, { error: 'Internal error.' });
            });
        }).listen(HTTP_PORT, () => console.log(`[Bridge] HTTP API listening on :${HTTP_PORT}`));
    }

    async #handleHttp(req, res) {
        if (req.method === 'GET' && req.url === '/health') return this.#json(res, 200, { ok: true });
        if (req.method !== 'POST' || req.url !== '/escalate') return this.#json(res, 404, { error: 'Not found.' });

        const authError = this.#checkToken(req.headers.authorization);
        if (authError) return this.#json(res, authError.status, { error: authError.message });

        const body = await this.#readJson(req);
        if (!body || !body.title) return this.#json(res, 400, { error: 'Body must be JSON with at least "title".' });

        const result = this.service.escalate({ title: body.title, message: body.message });
        if (!result.accepted) {
            console.log(`[Bridge] Escalation "${body.title}" suppressed by cooldown (${Math.ceil(result.retryInMs / 1000)}s left).`);
            return this.#json(res, 429, { error: 'Cooldown active.', retryInSeconds: Math.ceil(result.retryInMs / 1000) });
        }

        result.done.catch((err) => console.error(`[Escalation ${result.id}] FAILED to place call: ${err.message}`));
        return this.#json(res, 202, { id: result.id });
    }

    // Fails closed, same rules as the bot's DashboardAPI requireAdmin.
    #checkToken(header) {
        const expected = env.ESCALATION_TOKEN;
        if (!expected || expected.length < 32) return { status: 503, message: 'ESCALATION_TOKEN is not configured (32+ chars).' };
        const presented = (header || '').startsWith('Bearer ') ? header.slice(7) : '';
        const a = crypto.createHash('sha256').update(presented).digest();
        const b = crypto.createHash('sha256').update(expected).digest();
        return crypto.timingSafeEqual(a, b) ? null : { status: 403, message: 'Invalid credentials.' };
    }

    #readJson(req) {
        return new Promise((resolve) => {
            let raw = '';
            req.on('data', (c) => {
                raw += c;
                if (raw.length > 16 * 1024) req.destroy();
            });
            req.on('end', () => {
                try {
                    resolve(JSON.parse(raw));
                } catch {
                    resolve(null);
                }
            });
            req.on('error', () => resolve(null));
        });
    }

    #json(res, status, body) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }

    // ---- FastAGI: Asterisk hands us the answered call -----------------------
    #startAgi() {
        net.createServer(async (socket) => {
            const channel = new AgiChannel(socket);
            try {
                const agiEnv = await channel.init();
                const escalationId = agiEnv.agi_arg_1;
                if (!/^[A-Za-z0-9-]+$/.test(escalationId || '')) throw new Error(`Bad escalation id from Asterisk: ${escalationId}`);

                await new EscalationCall({
                    channel,
                    escalationId,
                    synth: this.synth,
                    whisper: this.whisper,
                    parser: this.parser,
                    actions: this.actions,
                    audioDir: AUDIO_DIR,
                    asteriskAudioDir: ASTERISK_AUDIO_DIR
                }).run();
            } catch (err) {
                console.error(`[AGI] ${err.message}`);
                channel.close();
            }
        }).listen(AGI_PORT, () => console.log(`[Bridge] FastAGI listening on :${AGI_PORT}`));
    }

    // ---- Warm-up: make the first real call fast ------------------------------
    // Pulls the Ollama model if it's missing and pre-renders the fixed prompts.
    // Retries because Piper/Ollama may still be starting (or downloading) when we boot.
    async #warmUp() {
        for (let attempt = 1; attempt <= 30; attempt++) {
            try {
                await this.#ensureOllamaModel();
                const fixed = [LINES.menu, LINES.retry, LINES.moment, LINES.anythingElse, LINES.giveUp,
                    LINES.acknowledged, LINES.cancelled, LINES.actionFailed,
                    ...Object.values(LINES.confirm), ...Object.values(LINES.done)];
                for (const text of fixed) await this.synth.render(text);
                console.log('[Bridge] Warm-up complete: model ready, prompts rendered.');
                return;
            } catch (err) {
                console.log(`[Bridge] Warm-up attempt ${attempt} not ready yet (${err.message}); retrying in 20s.`);
                await new Promise((r) => setTimeout(r, 20000));
            }
        }
        console.error('[Bridge] Warm-up gave up. Calls will still work but the first one will be slow.');
    }

    async #ensureOllamaModel() {
        const show = await fetch(`${OLLAMA_URL}/api/show`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL })
        });
        if (show.ok) return;

        console.log(`[Bridge] Ollama model ${OLLAMA_MODEL} not found - pulling it (one-time download)...`);
        const pull = await fetch(`${OLLAMA_URL}/api/pull`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: OLLAMA_MODEL, stream: false })
        });
        if (!pull.ok) throw new Error(`Ollama pull failed (${pull.status}): ${await pull.text()}`);
        console.log(`[Bridge] Pulled ${OLLAMA_MODEL}.`);
    }
}

new EscalationBridge().start();
