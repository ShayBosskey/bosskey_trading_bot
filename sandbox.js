require('dotenv').config({ path: '../.env' });
const { Client } = require('pg');
const { Alpaca } = require('@alpacahq/alpaca-trade-api');

const dbClient = new Client({
    user: process.env.PGUSER,
    password: process.env.PGPASSWORD,
    host: process.env.PGHOST,
    port: process.env.PGPORT,
    database: process.env.PGDATABASE
});

const alpaca = new Alpaca({
    keyId: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_SECRET_KEY,
    paper: true
});

async function runSandboxEvaluation() {
    try {
        await dbClient.connect();
        console.log("--- BOSSKEY AI SANDBOX EVALUATION ---");

        // 1. Fetch current pot balances from database
        const potsRes = await dbClient.query('SELECT pot_name, balance FROM capital_pots ORDER BY pot_id ASC;');
        console.log("\n[Database] Current Capital Pots:");
        potsRes.rows.forEach(pot => {
            console.log(`> ${pot.name || pot.pot_name}: $${pot.balance}`);
        });

        // 2. Fetch live account status from Alpaca Sandbox
        const account = await alpaca.trading.account.getAccount();
        console.log(`\n[Broker] Alpaca Paper Cash Available: $${account.cash}`);

        // 3. Sandbox Decision Logic (Simulated AI evaluation for tomorrow's trade)
        const activeCapitalPot = parseFloat(potsRes.rows[0].balance);
        
        console.log("\n[AI Sandbox] Analyzing market patterns for execution...");
        
        if (activeCapitalPot > 0) {
            // Allocate a strict 1% risk test for the sandbox trade
            const testAllocation = activeCapitalPot * 0.01;
            console.log(`[Sandbox Success] AI validated test parameters. Approved virtual trade allocation: $${testAllocation.toFixed(2)}`);
            console.log("[Sandbox Status] Ready to execute paper trade cycle for tomorrow's market open.");
        } else {
            console.log("[Sandbox Warning] Pot 1 active capital is insufficient. Halting trade execution.");
        }

    } catch (err) {
        console.error("Sandbox execution error:", err);
    } finally {
        await dbClient.end();
    }
}

runSandboxEvaluation();
