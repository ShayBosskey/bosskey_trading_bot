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
            // Alpaca returns short positions as negative quantities. We convert it to a positive absolute number.
            const rawQty = parseFloat(position.qty);
            const qty = Math.abs(rawQty);
            const isShort = rawQty < 0;
            
            const entryPrice = parseFloat(position.avg_entry_price);
            const exitPrice = parseFloat(position.current_price);
            
            // Invert the profit math if it is a short position
            const netProfit = isShort ? (entryPrice - exitPrice) * qty : (exitPrice - entryPrice) * qty;
            const margin = isShort ? ((entryPrice - exitPrice) / entryPrice) * 100 : ((exitPrice - entryPrice) / entryPrice) * 100;
            const sideToClose = isShort ? 'buy' : 'sell';

            console.log(`[Liquidator] Closing ${isShort ? 'Short' : 'Long'} position on ${position.symbol}...`);
            
            await alpaca.trading.orders.market({
                symbol: position.symbol,
                qty: qty,
                side: sideToClose,
                timeInForce: 'day'
            });
            
            await db.query(`
                UPDATE trade_analytics 
                SET sell_price = $1, net_profit = $2, margin_percentage = $3, status = 'CLOSED'
                WHERE symbol = $4 AND status = 'OPEN'
            `, [exitPrice, netProfit, margin, position.symbol]);

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
