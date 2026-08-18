require('dotenv').config({ path: '../.env' });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');

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
        console.log(`[Broker] Pinging Alpaca Screener API for dynamic top market movers...`);
        
        try {
            const screenerUrl = 'https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50';
            const response = await fetch(screenerUrl, {
                headers: {
                    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                    'accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`Alpaca Screener API Error: ${response.status}`);
            }

            const screenerData = await response.json();
            
            // Combine gainers and losers
            let allMovers = [...(screenerData.gainers || []), ...(screenerData.losers || [])];
            
            // Initial filter: Current price must be >= $5.00
            allMovers = allMovers.filter(mover => mover.price >= 5.00);
            
            // Sort remaining high-quality stocks by absolute momentum
            allMovers.sort((a, b) => Math.abs(b.percent_change) - Math.abs(a.percent_change));
            
            let bestSetup = null;

            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - 40);
            const startString = pastDate.toISOString();

            // Iterate down the list of top movers until we find one with a strong historical baseline
            for (const mover of allMovers) {
                const barUrl = `https://data.alpaca.markets/v2/stocks/bars?symbols=${mover.symbol}&timeframe=1Day&start=${startString}`;
                
                const barResponse = await fetch(barUrl, {
                    headers: {
                        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                        'accept': 'application/json'
                    }
                });

                if (!barResponse.ok) continue; // If Alpaca fails on this specific ticker, skip it

                const barData = await barResponse.json();
                const bars = barData.bars[mover.symbol];
                
                if (bars && bars.length >= 20) {
                    const closePrices = bars.map(bar => bar.c);
                    const sma_20 = this.calculateSMA(closePrices, 20);
                    
                    // The Ultimate Shield: The historical 20-day average MUST also be >= $5.00
                    if (sma_20 >= 5.00) {
                        bestSetup = {
                            symbol: mover.symbol,
                            price: mover.price,
                            dailyChange: mover.percent_change.toFixed(2),
                            volume: mover.volume,
                            sma_20: sma_20,
                            rsi_14: this.calculateRSI(closePrices, 14)
                        };
                        break; // We found a legitimate, capitalized target! Stop searching.
                    }
                }
            }

            if (!bestSetup) {
                console.log("[Broker] No movers passed both current price and historical SMA filters. Holding cash.");
                return { symbol: 'NONE', price: 0, dailyChange: 0, volume: 0 };
            }

            console.log(`[Broker] Dynamic target locked: ${bestSetup.symbol} moving ${bestSetup.dailyChange}% today.`);
            console.log(`[Broker] Indicators calculated -> SMA: ${bestSetup.sma_20} | RSI: ${bestSetup.rsi_14}`);

            return bestSetup;

        } catch (err) {
            console.error(`[Broker Error]: Failed to scan dynamic movers: ${err.message}`);
            throw err;
        }
    }

    async executeTrade(decision, marketData, dynamicRiskAmount) {
        // Abort if the AI said HOLD
        if ((decision.action !== 'BUY' && decision.action !== 'SELL_SHORT') || decision.target_symbol === 'NONE') return;

        // Match the single object returned by our new scanner
        const target = marketData.symbol === decision.target_symbol ? marketData : null;
        if (!target) {
            console.log(`[Broker] Target data mismatch.`);
            return;
        }

        // Use the dynamically calculated Kelly Criterion risk amount passed from TradingBot
        const positionSize = dynamicRiskAmount; 
        let shares = Math.floor(positionSize / target.price);

        const cash = await this.getCashBalance();

        // Safety Check: Never over-leverage the available cash
        if ((shares * target.price) > cash) {
            shares = Math.floor(cash / target.price);
        }

        if (shares <= 0) {
            console.log(`\n[Broker] Insufficient cash to execute ${decision.action} on ${decision.target_symbol}.`);
            return;
        }

        console.log(`\n[Broker] Formatting MARKET ${decision.action} order for ${shares} shares of ${decision.target_symbol}...`);

        try {
            const orderSide = decision.action === 'BUY' ? 'buy' : 'sell';

            const order = await this.alpaca.trading.orders.market({
                symbol: decision.target_symbol,
                qty: shares, 
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
