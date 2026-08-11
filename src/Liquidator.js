const attachGlobalErrorLogger = require('./ErrorHandler');
attachGlobalErrorLogger('Liquidator');
require('dotenv').config({ path: '../.env' });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const { Client } = require('pg');
const Notifier = require('./Notifier');

const alpaca = new Alpaca({
    keyId: process.env.ALPACA_API_KEY,
    secret: process.env.ALPACA_SECRET_KEY,
    paper: true
});

const notifier = new Notifier();

async function runHardClose() {
    console.log("--- INITIATING END OF DAY LIQUIDATION ---");
    
    const db = new Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });

    try {
        await db.connect();
        const positions = await alpaca.trading.positions.getAllOpenPositions();
        
        if (positions.length === 0) {
            console.log("[Liquidator] No open positions to close. Portfolio is cash heavy.");
            await notifier.push(
                "End of Day Check", 
                "No open positions to close. Portfolio is safely in cash.", 
                "zzz"
            );
            return;
        }

        console.log(`[Liquidator] Found ${positions.length} open position(s). Executing sales and logging analytics...`);
        let liquidatedSymbols = [];
        
        for (const position of positions) {
            const qty = parseFloat(position.qty);
            const buyPrice = parseFloat(position.avg_entry_price);
            const sellPrice = parseFloat(position.current_price);
            
            const netProfit = (sellPrice - buyPrice) * qty;
            const margin = ((sellPrice - buyPrice) / buyPrice) * 100;

            console.log(`[Liquidator] Selling ${qty} shares of ${position.symbol}...`);
            await alpaca.trading.orders.market({
                symbol: position.symbol,
                qty: qty,
                side: 'sell',
                timeInForce: 'day'
            });
            
            // Update the open trade record
            await db.query(`
                UPDATE trade_analytics 
                SET sell_price = $1, net_profit = $2, margin_percentage = $3, status = 'CLOSED'
                WHERE symbol = $4 AND status = 'OPEN'
            `, [sellPrice, netProfit, margin, position.symbol]);

            liquidatedSymbols.push(position.symbol);
        }
        
        const summary = liquidatedSymbols.join(', ');
        console.log("[Liquidator] Daily liquidation complete. Capital secured.");
        
        await notifier.push(
            "End of Day Liquidation", 
            `Successfully sold all daily holdings: ${summary}. Portfolio converted to cash.`, 
            "moneybag"
        );
        
    } catch (err) {
        console.error("\n[Liquidator Error]:", err.message);
        await notifier.push("Liquidator Error", err.message, "warning");
    } finally {
        await db.end();
    }
}

runHardClose();
