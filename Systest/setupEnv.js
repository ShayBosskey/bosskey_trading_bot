// Runs before every test file. Keeps tests from touching live runtime state:
// a Notifier built inside a test would otherwise record its (mocked) pushes in
// run/notifier-state.json and mute the same real alerts for up to 90 minutes.
const os = require('os');
const path = require('path');

process.env.NOTIFIER_STATE_FILE = path.join(os.tmpdir(), `notifier-state-test-${process.pid}-${process.env.JEST_WORKER_ID || 0}.json`);
