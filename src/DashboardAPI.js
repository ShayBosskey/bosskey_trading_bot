require('dotenv').config({ path: require('path').resolve(__dirname, '../.env')});
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const DatabaseClient = require('./DatabaseClient');
const Config = require('./Config');

const app = express();
const PORT = process.env.API_PORT || 3000;

// `cors()` with no options reflects ANY origin, which let any page the browser
// happened to load drive this API. Restricted to an explicit allowlist.
const ALLOWED_ORIGINS = (process.env.DASHBOARD_ORIGIN || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);

app.use(cors({
    origin(origin, callback) {
        // No Origin header = a non-browser client (curl, the bot itself). Those are
        // governed by the bearer token below, not by CORS.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new Error(`Origin ${origin} is not permitted.`));
    }
}));
app.use(express.json());

// Guards every state-changing route. Without this, an unauthenticated POST to
// /api/v1/system/mode could flip the bot into PRODUCTION and start routing real
// orders to the live Alpaca endpoint.
//
// Fails CLOSED: if ADMIN_API_TOKEN is unset or too short to be meaningful, the
// route is disabled outright rather than left open.
function requireAdmin(req, res, next) {
    const expected = process.env.ADMIN_API_TOKEN;

    if (!expected || expected.length < 32) {
        console.error('[API Security] ADMIN_API_TOKEN is missing or too short. Refusing all privileged requests.');
        return res.status(503).json({ error: 'Privileged endpoints are disabled: ADMIN_API_TOKEN is not configured.' });
    }

    const header = req.get('authorization') || '';
    const presented = header.startsWith('Bearer ') ? header.slice(7) : null;

    if (!presented) {
        return res.status(401).json({ error: 'Missing bearer token.' });
    }

    // Hash both sides first so timingSafeEqual always gets equal-length buffers
    // and the comparison leaks no information about the token's length.
    const a = crypto.createHash('sha256').update(presented).digest();
    const b = crypto.createHash('sha256').update(expected).digest();

    if (!crypto.timingSafeEqual(a, b)) {
        console.error(`[API Security] Rejected privileged request from ${req.ip}.`);
        return res.status(403).json({ error: 'Invalid credentials.' });
    }

    return next();
}

// Endpoint 1: System Health and Operational Mode
app.get('/api/v1/system/status', (req, res) => {
    res.json({
        mode: Config.getMode(),
        isTradingAllowed: Config.isTradingAllowed(),
        serverTime: new Date().toISOString()
    });
});

// Endpoint 2: Portfolio and Capital Metrics
app.get('/api/v1/portfolio', async (req, res) => {
    const db = new DatabaseClient();
    try {
        await db.connect();
        
        const capitalRes = await db.client.query("SELECT * FROM capital_pots WHERE id = 1");
        const positionsRes = await db.client.query("SELECT * FROM trade_analytics WHERE status = 'OPEN'");
        const historyQuery = await db.client.query("SELECT opened_at, closed_at, net_profit FROM trade_analytics WHERE status = 'CLOSED' ORDER BY closed_at ASC");
        
        res.json({
            capital: capitalRes.rows[0],
            openPositions: positionsRes.rows,
            tradeHistory: historyQuery.rows,
            activeSlotCount: positionsRes.rows.length,
            maxSlots: 5
        });
    } catch (error) {
        console.error(`[API Error]: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error fetching portfolio data.' });
    } finally {
        await db.disconnect();
    }
});

// Endpoint 3: Recent System Logs
app.get('/api/v1/logs', async (req, res) => {
    const db = new DatabaseClient();
    try {
        await db.connect();
        const logsRes = await db.client.query("SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT 20");
        res.json(logsRes.rows);
    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error fetching logs.' });
    } finally {
        await db.disconnect();
    }
});

// Endpoint 4: System Mode Toggle (privileged)
app.post('/api/v1/system/mode', requireAdmin, (req, res) => {
    const { targetMode, confirm } = req.body;
    const validModes = ['CONSTRUCTION', 'PAPER', 'PRODUCTION'];

    if (!validModes.includes(targetMode)) {
        return res.status(400).json({ error: 'Invalid mode requested.' });
    }

    // PRODUCTION routes real money to the live Alpaca endpoint, so it needs a
    // deliberate second signal - a stray valid-token request cannot trip it.
    if (targetMode === 'PRODUCTION' && confirm !== 'PRODUCTION') {
        return res.status(400).json({
            error: "Switching to PRODUCTION requires \"confirm\": \"PRODUCTION\" in the request body."
        });
    }

    try {
        const envPath = path.resolve(__dirname, '../.env');
        let envContent = fs.readFileSync(envPath, 'utf8');

        // Append when the key is absent, otherwise the write silently no-ops and
        // the API reports a mode change that never happened.
        if (/^SYSTEM_MODE=.*/m.test(envContent)) {
            envContent = envContent.replace(/^SYSTEM_MODE=.*/gm, `SYSTEM_MODE=${targetMode}`);
        } else {
            envContent += `\nSYSTEM_MODE=${targetMode}\n`;
        }

        fs.writeFileSync(envPath, envContent);
        process.env.SYSTEM_MODE = targetMode;

        console.log(`[API Security] SYSTEM_MODE changed to ${targetMode} by an authenticated request from ${req.ip}.`);
        res.json({ message: `System successfully transitioned to ${targetMode} mode.` });
    } catch (error) {
        console.error(`[API Error]: Failed to update environment state: ${error.message}`);
        res.status(500).json({ error: 'Internal Server Error modifying system state.' });
    }
});

// A blocked origin surfaces as a thrown error from the cors middleware. Without
// this it escapes as an opaque 500; a rejected origin is a 403.
app.use((err, req, res, next) => {
    if (err && /is not permitted/.test(err.message)) {
        return res.status(403).json({ error: 'Origin not permitted.' });
    }
    return next(err);
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`[Dashboard API] Server securely running and listening on port ${PORT}`);
    });
}

module.exports = app;
