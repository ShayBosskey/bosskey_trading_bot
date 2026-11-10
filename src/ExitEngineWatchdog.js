const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const fs = require('fs');
const { execFile } = require('child_process');
const DatabaseClient = require('./DatabaseClient');
const Notifier = require('./Notifier');
const VoiceEscalator = require('./VoiceEscalator');
const { HEARTBEAT_FILE } = require('./CryptoExitEngine');

// attachGlobalErrorLogger only fires when the exit engine throws. A SIGKILL, an
// OOM kill, a hung event loop, or PM2 giving up all end silently - and with no
// broker-side crypto stops, a silent exit engine means unprotected positions.
// This checks from the outside: a stale heartbeat while crypto positions are open
// rings the owner's phone; with nothing open it is only a (throttled) push.

const STALE_AFTER_MS = 3 * 60 * 1000;
const SIP_ENDPOINT = process.env.SIP_USERNAME || 'mobile';
// The watchdog runs every 2 min as a fresh process, so the failure streak lives
// on disk. One missed qualify ping is usually a Tailscale/cellular blip that heals
// within 30 s; only SIP_FAILS_BEFORE_ALERT consecutive failures push an alert.
const SIP_FAILS_BEFORE_ALERT = 2;
const SIP_STATE_FILE = process.env.SIP_CHECK_STATE_FILE || path.resolve(__dirname, '../run/sip-check-state.json');

// The voice call can only ring a phone that is registered with Asterisk. A
// restart of the asterisk container drops registrations until the phone app
// re-registers, so an escalation path that looks armed can silently go nowhere.
// Resolves true (registered), false (not registered) or null (couldn't check).
function sipClientRegistered(endpoint = SIP_ENDPOINT) {
    return new Promise(resolve => {
        execFile('docker', ['exec', 'esc-asterisk', 'asterisk', '-rx', 'pjsip show contacts'], { timeout: 10000 }, (err, stdout) => {
            if (err) return resolve(null);
            const line = stdout.split('\n').find(l => l.includes(`${endpoint}/sip:`));
            resolve(Boolean(line && /\bAvail\b/.test(line)));
        });
    });
}

function readHeartbeat(file = HEARTBEAT_FILE) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function heartbeatProblem(beat, now = Date.now()) {
    if (!beat) return 'no heartbeat file';
    const ageMs = now - new Date(beat.at).getTime();
    if (!(ageMs <= STALE_AFTER_MS)) return `last heartbeat ${Math.round(ageMs / 1000)}s ago`;
    return null;
}

async function countOpenCrypto() {
    const db = new DatabaseClient();
    try {
        await db.connect();
        const res = await db.client.query("SELECT COUNT(*)::int AS n FROM trade_analytics WHERE status = 'OPEN' AND symbol LIKE '%/%'");
        return res.rows[0].n;
    } catch (err) {
        console.error(`[Watchdog] DB check failed (${err.message}); assuming positions may be open.`);
        return null; // unknown counts as "may be exposed"
    } finally {
        await db.disconnect().catch(() => {});
    }
}

async function runWatchdog({ notifier = new Notifier(), escalator = new VoiceEscalator(), beat = readHeartbeat(), openCount } = {}) {
    const problem = heartbeatProblem(beat);
    if (!problem) return 'ok';

    const open = openCount !== undefined ? openCount : await countOpenCrypto();
    const exposed = open === null || open > 0;
    const detail = `Crypto exit engine is not running (${problem}). Open crypto positions: ${open === null ? 'unknown' : open}.`;
    console.error(`[Watchdog] ${detail}`);

    if (!exposed) {
        await notifier.push('Crypto Exit Engine Down', `${detail} Nothing is at risk yet, but new crypto entries are blocked.`, 'warning');
        return 'down-idle';
    }

    await Promise.all([
        notifier.push('CRYPTO STOPS OFFLINE', `${detail} These positions have NO stop-loss until it is restarted: pm2 restart crypto-exit-engine`, 'rotating_light'),
        escalator.escalate('Crypto exit engine down', `${detail} Open positions are unprotected.`)
    ]);
    return 'down-exposed';
}

function readSipFailures(file) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8')).consecutiveFailures || 0;
    } catch {
        return 0;
    }
}

function writeSipFailures(file, consecutiveFailures) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ consecutiveFailures, at: new Date().toISOString() }));
    } catch (err) {
        console.error(`[Watchdog] Could not save SIP check state: ${err.message}`);
    }
}

async function checkSipRegistration({ notifier = new Notifier(), registered, stateFile = SIP_STATE_FILE } = {}) {
    const state = registered !== undefined ? registered : await sipClientRegistered();
    if (state === true) {
        writeSipFailures(stateFile, 0);
        return 'registered';
    }

    const failures = readSipFailures(stateFile) + 1;
    writeSipFailures(stateFile, failures);
    if (failures < SIP_FAILS_BEFORE_ALERT) {
        console.log(`[Watchdog] SIP check failed (${failures}/${SIP_FAILS_BEFORE_ALERT}); waiting for the next check before alerting.`);
        return 'pending';
    }

    const detail = state === null
        ? 'Could not query Asterisk (is the escalation stack running?).'
        : `Your SIP client (${SIP_ENDPOINT}) is not registered with Asterisk.`;
    await notifier.push('Voice Escalation Unreachable', `${detail} SHEFA cannot phone you until it is. Open the SIP app on your phone so it re-registers over Tailscale.`, 'warning');
    return state === null ? 'unknown' : 'unregistered';
}

if (require.main === module) {
    Promise.all([runWatchdog(), checkSipRegistration()]).then(() => process.exit(0)).catch(err => {
        console.error(`[Watchdog] ${err.stack}`);
        process.exit(1);
    });
}

module.exports = { runWatchdog, heartbeatProblem, checkSipRegistration, sipClientRegistered, STALE_AFTER_MS };
