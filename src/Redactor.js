// Last line of defence against secrets leaking into PM2 logs, the system_logs
// table (served by the dashboard), ntfy pushes or the voice-call payload.
// Every outbound text path runs through redact(), so a key that ends up inside
// an error message (an SDK echoing a URL, a connection string in a pg error)
// is masked instead of published.

const SECRET_NAME = /KEY|SECRET|PASSWORD|TOKEN/i;
const MIN_SECRET_LENGTH = 8;
const MASK = '[REDACTED]';

// Read on every call: dotenv may load after this module is first required.
function secretValues() {
    return Object.entries(process.env)
        .filter(([name, value]) => SECRET_NAME.test(name) && typeof value === 'string' && value.length >= MIN_SECRET_LENGTH)
        .map(([, value]) => value)
        .sort((a, b) => b.length - a.length); // longest first, so a secret containing another is fully masked
}

function redact(text) {
    if (text === null || text === undefined) return text;
    let out = String(text);

    for (const secret of secretValues()) {
        out = out.split(secret).join(MASK);
    }

    // Patterns for secrets that never passed through process.env.
    return out
        .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, `$1${MASK}`)
        .replace(/([?&](?:key|api_?key|token|access_token|secret|password)=)[^&\s"']+/gi, `$1${MASK}`)
        .replace(/(postgres(?:ql)?:\/\/[^:/\s]+:)[^@\s]+@/gi, `$1${MASK}@`);
}

module.exports = { redact, MASK };
