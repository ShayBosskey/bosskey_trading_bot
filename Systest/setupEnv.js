// Runs before every test file. Keeps tests from touching live runtime state:
// a Notifier built inside a test would otherwise record its (mocked) pushes in
// run/notifier-state.json and mute the same real alerts for up to 90 minutes.
const os = require('os');
const path = require('path');

process.env.SIP_CHECK_STATE_FILE = path.join(os.tmpdir(), `sip-check-state-test-${process.pid}-${process.env.JEST_WORKER_ID || 0}.json`);
process.env.NOTIFIER_STATE_FILE = path.join(os.tmpdir(), `notifier-state-test-${process.pid}-${process.env.JEST_WORKER_ID || 0}.json`);

// Tests must never reach the real phone. Reconciliation/PositionsSync tests build
// a real Notifier, and dotenv fills in the live NTFY_TOPIC_URL; on 2026-11-10 that
// pushed fixture alerts ("SDOT ... Net: $-1787.52", "GHOST", "disk full") to the
// live feed and they were read as real incidents. dotenv never overrides a var
// that is already set, so this wins; the fetch guard below also covers the
// hard-coded public fallback topic in Notifier.
process.env.NTFY_TOPIC_URL = 'https://ntfy.invalid/jest-sink';
const realFetch = globalThis.fetch;
globalThis.__blockedNtfyPushes = [];
globalThis.fetch = (url, init) => {
    if (/ntfy\./i.test(String(url))) {
        globalThis.__blockedNtfyPushes.push({ url: String(url), title: init?.headers?.Title });
        return Promise.resolve({ ok: true, status: 200 });
    }
    return realFetch(url, init);
};
