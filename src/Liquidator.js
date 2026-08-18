require('dotenv').config({ path: '../.env' });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
// Assuming your notifier class is exported like this based on your previous logs
const Notifier = require('./Notifier'); 

class Liquidator {
    constructor() {
        this.alpaca = new Alpaca({
            keyId: process.env.ALPACA_API_KEY,
            secret: process.env.ALPACA_SECRET_KEY,
            paper: true // Still on paper until we swap keys!
        });
        this.db = new DatabaseClient();
        this.logger = new Logger('Liquidator');
        this.notifier = new Notifier();
        
        // Risk Parameters
        this.TAKE_PROFIT_PCT = 10.0;
        this.STOP_LOSS_PCT = -5.0;
        this.MAX_HOLD_DAYS = 3;
    }

    async runContinuousCheck() {
        await this.logger.log('Initiating 15-minute continuous position scan...');
        
        try {
            await this.db.connect();
            
            // 1. Get all OPEN positions from our database
            const res = await this.db.client.query("SELECT * FROM trade_analytics WHERE status = 'OPEN'");
            const openTrades = res.rows;

            if (openTrades.length === 0) {
                await this.logger.log('No open positions to monitor.');
                return;
            }

            // 2. Fetch current real-time prices for all open positions directly from Alpaca
            const symbols = openTrades.map(t => t.symbol).join(',');
            const url = `https://data.alpaca.markets/v2/stocks/snapshots?symbols=${symbols}`;
            
            const response = await fetch(url, {
                headers: {
                    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                    'accept': 'application/json'
                }
            });

            if (!response.ok) throw new Error(`Alpaca API HTTP Error: ${response.status}`);
            const snapshots = await response.json();

            // 3. Evaluate each position against our rules
            const now = new Date();

            for (const trade of openTrades) {
                const snapshot = snapshots[trade.symbol];
                if (!snapshot || !snapshot.latestTrade) continue;

                const currentPrice = snapshot.latestTrade.p;
                const buyPrice = parseFloat(trade.buy_price);
                const profitPct = ((currentPrice - buyPrice) / buyPrice) * 100;
                
                // Calculate days held (ignoring weekends is complex, so we use absolute hours for safety)
                const openedAt = new Date(trade.opened_at);
                const hoursHeld = Math.abs(now - openedAt) / 36e5;
                const daysHeld = hoursHeld / 24;

                let sellReason = null;

                if (profitPct >= this.TAKE_PROFIT_PCT) {
                    sellReason = `TAKE-PROFIT (+${profitPct.toFixed(2)}%)`;
                } else if (profitPct <= this.STOP_LOSS_PCT) {
                    sellReason = `STOP-LOSS (${profitPct.toFixed(2)}%)`;
                } else if (daysHeld >= this.MAX_HOLD_DAYS) {
                    sellReason = `TIME-STOP (Held ${daysHeld.toFixed(1)} days)`;
                }

                if (sellReason) {
                    await this.logger.log(`Trigger activated for ${trade.symbol}: ${sellReason}. Executing liquidation.`);
                    await this.executeSale(trade, currentPrice, sellReason);
                } else {
                    console.log(`[Liquidator] ${trade.symbol} at ${profitPct.toFixed(2)}%. Holding.`);
                }
            }

        } catch (err) {
            await this.logger.log(`CRITICAL ERROR: ${err.message}`);
            await this.notifier.push("Liquidator Error", err.message, "error");
        } finally {
            await this.db.disconnect();
        }
    }

    async executeSale(trade, currentPrice, reason) {
        try {
            // Sell all shares via Alpaca
            await this.alpaca.trading.orders.market({
                symbol: trade.symbol,
                qty: trade.qty,
                side: 'sell',
                timeInForce: 'day'
            });

            const netProfit = (currentPrice - parseFloat(trade.buy_price)) * trade.qty;
            const margin = ((currentPrice - parseFloat(trade.buy_price)) / parseFloat(trade.buy_price)) * 100;

            // Update Database: Mark as CLOSED so Settlement can process it tonight
            await this.db.client.query(
                `UPDATE trade_analytics 
                 SET status = 'CLOSED', sell_price = $1, net_profit = $2, margin_percentage = $3, closed_at = CURRENT_TIMESTAMP 
                 WHERE id = $4`,
                [currentPrice, netProfit, margin, trade.id]
            );

            const logMsg = `Sold ${trade.qty}x ${trade.symbol} at $${currentPrice}. Net: $${netProfit.toFixed(2)} (${margin.toFixed(2)}%)`;
            await this.logger.log(logMsg);
            
            // Immediate Push Notification to your phone!
            await this.notifier.push(
                "Position Liquidated", 
                `Symbol: ${trade.symbol}\nReason: ${reason}\nProfit: $${netProfit.toFixed(2)}`, 
                "sell"
            );

        } catch (err) {
            await this.logger.log(`Failed to sell ${trade.symbol}: ${err.message}`);
        }
    }
}

// Execute if run directly
if (require.main === module) {
    const liquidator = new Liquidator();
    liquidator.runContinuousCheck();
}

module.exports = Liquidator;
