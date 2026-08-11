require('dotenv').config({ path: '../.env' });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const TICKER_UNIVERSE = require('./Tickers');
class BrokerClient {
    constructor() {
        this.alpaca = new Alpaca({
            keyId: process.env.ALPACA_API_KEY,
            secret: process.env.ALPACA_SECRET_KEY,
            paper: true
        });
    }

    async getCashBalance() {
        const account = await this.alpaca.trading.account.getAccount();
        return parseFloat(account.cash);
    }

    calculateSMA(prices, period) {
        if (!prices || prices.length < period) return null;
        const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
        return parseFloat((sum / period).toFixed(2));
    }

    calculateRSI(prices, period = 14) {
        if (!prices || prices.length < period + 1) return null;
        let gains = 0, losses = 0;
        
        for (let i = prices.length - period; i < prices.length; i++) {
            const diff = prices[i] - prices[i - 1];
            if (diff >= 0) gains += diff;
            else losses -= diff;
        }
        
        const avgGain = gains / period;
        const avgLoss = losses / period;
        
        if (avgLoss === 0) return 100;
        const rs = avgGain / avgLoss;
        return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
    }

    async scanMarketMovers() {
        console.log(`[Broker] Initiating multi-threaded scan of ${TICKER_UNIVERSE.length} tickers...`);
        
        try {
            // Ask Alpaca for a snapshot of every single ticker at the same time
            const snapshots = await this.alpaca.marketData.stocks.getSnapshots({ 
                symbols: TICKER_UNIVERSE 
            });
            
            let bestSetup = null;
            let highestMomentum = -999;

            // Loop through the results to find the stock moving the fastest right now
            for (const [symbol, snapshot] of Object.entries(snapshots)) {
                if (!snapshot || !snapshot.dailyBar || !snapshot.prevDailyBar) continue;
                
                const currentPrice = snapshot.latestTrade.p;
                const prevClose = snapshot.prevDailyBar.c;
                const dailyChangePercent = ((currentPrice - prevClose) / prevClose) * 100;
                
                // We are looking for the absolute biggest mover (positive or negative)
                if (Math.abs(dailyChangePercent) > highestMomentum) {
                    highestMomentum = Math.abs(dailyChangePercent);
                    bestSetup = {
                        symbol: symbol,
                        price: currentPrice,
                        dailyChange: dailyChangePercent.toFixed(2),
                        volume: snapshot.dailyBar.v
                    };
                }
            }

            console.log(`[Broker] Scan complete. Top mover identified: ${bestSetup.symbol} moving ${bestSetup.dailyChange}% today.`);
            return bestSetup;

        } catch (err) {
            console.error(`[Broker Error]: Failed to scan market movers: ${err.message}`);
            throw err;
        }
    }

    async executeTrade(decision, marketData, activeCapital) {
        // Abort if the AI said HOLD
        if (decision.action !== 'BUY' || decision.target_symbol === 'NONE') return;

        const target = marketData.find(d => d.symbol === decision.target_symbol);
        if (!target) return;

        // Risk Math: 1% of capital max loss, 2% stop-loss means total position is 50x the risk
        const maxRisk = activeCapital * 0.01;
        const positionSize = maxRisk / 0.02; 
        let shares = Math.floor(positionSize / target.price);

        const cash = await this.getCashBalance();
        
        // Safety Check: Never over-leverage the available cash
        if ((shares * target.price) > cash) {
            shares = Math.floor(cash / target.price);
        }

        if (shares <= 0) {
            console.log(`\n[Broker] Insufficient cash to buy ${decision.target_symbol}.`);
            return;
        }

        console.log(`\n[Broker] Formatting MARKET BUY order for ${shares} shares of ${decision.target_symbol}...`);
            
    	try {
                // If the AI says BUY, we buy. If it says SELL_SHORT, we sell to open the position.
                const orderSide = decision.action === 'BUY' ? 'buy' : 'sell';
                
                const order = await this.alpaca.trading.orders.market({
                    symbol: decision.target_symbol,
                    qty: shares, // Alpaca expects a positive number for quantity
                    side: orderSide,
                    timeInForce: 'day'
                });
                console.log(`[Broker] ${decision.action} Order Executed! Alpaca ID: ${order.id}`);
                
                return { executed: true, symbol: decision.target_symbol, qty: shares, price: target.price, action: decision.action };
            } catch (err) {
                console.log(`[Broker] Order Failed: ${err.message}`);
                return null;
            }
    }
}

module.exports = BrokerClient;
