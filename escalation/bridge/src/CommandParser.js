// Maps what you said on the call to ONE action from a fixed allowlist.
//
// The LLM never produces a command to run - it only picks an enum value, and
// anything outside the list becomes UNKNOWN. Clear phrases are matched by
// keywords first (instant, deterministic); the LLM only handles phrasing the
// keywords can't, or anything with a negation ("don't stop trading").
const ACTIONS = Object.freeze({
    HALT_TRADING: 'HALT_TRADING',       // SYSTEM_MODE -> CONSTRUCTION (bot stops opening trades)
    SWITCH_TO_PAPER: 'SWITCH_TO_PAPER', // SYSTEM_MODE -> PAPER (off real money)
    STATUS_REPORT: 'STATUS_REPORT',     // read-only: current mode
    ACKNOWLEDGE: 'ACKNOWLEDGE',         // heard it, do nothing
    UNKNOWN: 'UNKNOWN'
});

const KEYWORD_RULES = [
    [ACTIONS.HALT_TRADING, /\b(halt|stop|kill|pause|freeze|suspend)\b.*\b(trad\w*|bot|everything|all)\b|\bemergency stop\b|\bconstruction mode\b/],
    [ACTIONS.SWITCH_TO_PAPER, /\bpaper\b/],
    [ACTIONS.STATUS_REPORT, /\b(status|report)\b|\bwhat(?:'s| is) the (?:state|mode)\b/],
    [ACTIONS.ACKNOWLEDGE, /\b(acknowledged?|understood|noted|ignore it|leave it|do nothing|that's fine|thank you|thanks)\b/]
];

const NEGATION = /\b(don't|dont|do not|never|no need|not)\b/;

const SYSTEM_PROMPT = `You classify a spoken instruction from the owner of an automated stock trading bot.
The bot just reported a critical failure. Reply with exactly one action:
- HALT_TRADING: they want the bot to stop trading / stop everything / shut it down.
- SWITCH_TO_PAPER: they want to move the bot to paper (simulated) trading.
- STATUS_REPORT: they ask what state or mode the system is in.
- ACKNOWLEDGE: they heard the alert and want no action taken.
- UNKNOWN: anything else, unclear, or contradictory.
Respect negations: "don't stop trading" is ACKNOWLEDGE, not HALT_TRADING.`;

class CommandParser {
    constructor({ ollamaUrl, model, timeoutMs = 45000 }) {
        this.ollamaUrl = ollamaUrl.replace(/\/$/, '');
        this.model = model;
        this.timeoutMs = timeoutMs;
    }

    // Returns { action, via } where via is 'keyword' | 'llm' | 'none'.
    async parse(transcript) {
        const text = (transcript || '').toLowerCase().trim();
        if (!text) return { action: ACTIONS.UNKNOWN, via: 'none' };

        const keywordAction = CommandParser.matchKeywords(text);
        if (keywordAction) return { action: keywordAction, via: 'keyword' };

        try {
            return { action: await this.#askLlm(text), via: 'llm' };
        } catch (err) {
            console.error(`[CommandParser] LLM classification failed: ${err.message}`);
            return { action: ACTIONS.UNKNOWN, via: 'none' };
        }
    }

    // Exactly one keyword hit and no negation -> trust it. Otherwise defer to the LLM.
    static matchKeywords(text) {
        if (NEGATION.test(text)) return null;
        const hits = KEYWORD_RULES.filter(([, re]) => re.test(text)).map(([action]) => action);
        return hits.length === 1 ? hits[0] : null;
    }

    async #askLlm(text) {
        const allowed = Object.values(ACTIONS);
        const res = await fetch(`${this.ollamaUrl}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: AbortSignal.timeout(this.timeoutMs),
            body: JSON.stringify({
                model: this.model,
                stream: false,
                options: { temperature: 0 },
                // Ollama structured output: the model can only emit this shape.
                format: {
                    type: 'object',
                    properties: { action: { type: 'string', enum: allowed } },
                    required: ['action']
                },
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user', content: `Instruction: "${text}"` }
                ]
            })
        });
        if (!res.ok) throw new Error(`Ollama responded ${res.status}: ${await res.text()}`);

        const body = await res.json();
        const action = JSON.parse(body.message?.content || '{}').action;
        // Belt and braces: never trust the model to respect the enum.
        return allowed.includes(action) ? action : ACTIONS.UNKNOWN;
    }
}

module.exports = { CommandParser, ACTIONS };
