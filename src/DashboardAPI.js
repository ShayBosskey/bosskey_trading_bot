require('dotenv').config({ path: '../.env' });
const express = require('express');
const cors = require('cors');
const DatabaseClient = require('./DatabaseClient');
const Config = require('./Config');

const app = express();
const PORT = process.env.API_PORT || 3000;

// Security: In production, we will restrict this to your specific frontend URL
app.use(cors());
app.use(express.json());

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
        
        res.json({
            capital: capitalRes.rows[0],
            openPositions: positionsRes.rows,
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

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`[Dashboard API] Server securely running and listening on port ${PORT}`);
    });
}

module.exports = app;
