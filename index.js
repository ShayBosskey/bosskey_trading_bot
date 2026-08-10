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

async function initializeSystem() {
    try {
        await dbClient.connect();
        console.log("Connected to Bosskey Trading Database.");

        // 1. Get exact cash from Alpaca
        const account = await alpaca.trading.account.getAccount();
        const startingCapital = parseFloat(account.cash);
        
        // 2. Calculate the 75/25 split
        const activeCapital = startingCapital * 0.75;
        const emergencyReserve = startingCapital * 0.25;

        // 3. Update PostgreSQL pots
        await dbClient.query('UPDATE capital_pots SET balance = $1 WHERE pot_id = 1;', [activeCapital]);
        await dbClient.query('UPDATE capital_pots SET balance = $1 WHERE pot_id = 2;', [emergencyReserve]);
        await dbClient.query('UPDATE capital_pots SET balance = 0.00 WHERE pot_id = 3;');

        // 4. Verify the new balances
        const res = await dbClient.query('SELECT pot_name, balance FROM capital_pots ORDER BY pot_id ASC;');
        console.log("\nSuccessfully Funded Pots (JSON):");
        console.log(JSON.stringify(res.rows, null, 2));

    } catch (err) {
        console.error("System connection error:", err);
    } finally {
        await dbClient.end();
    }
}

initializeSystem();
