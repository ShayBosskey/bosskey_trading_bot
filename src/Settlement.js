const attachGlobalErrorLogger = require('./ErrorHandler');
attachGlobalErrorLogger('Settlement');
require('dotenv').config({ path: '../.env' });
const { Client } = require('pg');
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const Notifier = require('./Notifier');

const alpaca = new Alpaca({
    keyId: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_SECRET_KEY,
    paper: true
});

const notifier = new Notifier();

async function runSettlement() {
    console.log("--- INITIATING DAILY SETTLEMENT ---");
    
    // Connect to PostgreSQL
    const db = new Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });

    try {
        await db.connect();

        // 1. Fetch Account Data
        const account = await alpaca.trading.account.getAccount();
        const currentEquity = parseFloat(account.equity);
        const lastEquity = parseFloat(account.last_equity);
        
        // Calculate exact daily P&L
        const dailyProfit = currentEquity - lastEquity;
        
        // 2. Fetch Current Database State
        const result = await db.query('SELECT * FROM capital_pots ORDER BY id DESC LIMIT 1');
        const state = result.rows[0];
        
        let newActive = parseFloat(state.active_capital);
        let newReserve = parseFloat(state.emergency_reserve);
        let newTax = parseFloat(state.tax_vault);
        let newPayout = parseFloat(state.personal_payout);

        let pushTitle = "";
        let pushBody = "";
        let pushEmoji = "";

        // 3. The Distribution Math
        if (dailyProfit > 0) {
            console.log(`[Settlement] Profitable day secured! Distributing $${dailyProfit.toFixed(2)}...`);
            
            newActive += dailyProfit * 0.60;
            newReserve += dailyProfit * 0.20;
            newTax += dailyProfit * 0.10;
            newPayout += dailyProfit * 0.10;

            pushTitle = "📈 Profitable Day Settled!";
            pushBody = `Profit: $${dailyProfit.toFixed(2)}\n\nActive Cap: $${newActive.toFixed(2)}\nReserves: $${newReserve.toFixed(2)}\nTax Vault: $${newTax.toFixed(2)}\nPayout: $${newPayout.toFixed(2)}`;
            pushEmoji = "money_with_wings";
            
        } else if (dailyProfit < 0) {
            console.log(`[Settlement] Loss recorded. Deducting $${Math.abs(dailyProfit).toFixed(2)} from Active Capital...`);
            
            // Losses are absorbed entirely by Active Capital to protect the vaults
            newActive += dailyProfit; 
            
            pushTitle = "📉 Losing Day Settled";
            pushBody = `Loss: $${dailyProfit.toFixed(2)}\nActive Capital adjusted to: $${newActive.toFixed(2)}`;
            pushEmoji = "chart_with_downwards_trend";
            
        } else {
            console.log("[Settlement] Breakeven day. No distribution required.");
            await db.end();
            return;
        }

        // 4. Update the Database
        const updateQuery = `
            UPDATE capital_pots 
            SET active_capital = $1, emergency_reserve = $2, tax_vault = $3, personal_payout = $4, last_settled = CURRENT_TIMESTAMP
            WHERE id = $5
        `;
        await db.query(updateQuery, [newActive, newReserve, newTax, newPayout, state.id]);
        
        console.log("[Settlement] ✅ Database successfully updated.");

        // 5. Notify the User
        await notifier.push(pushTitle, pushBody, pushEmoji);

    } catch (err) {
        console.error("\n[Settlement Error]:", err.message);
        await notifier.push("Settlement Failed", err.message, "warning");
    } finally {
        await db.end();
    }
}

runSettlement();
