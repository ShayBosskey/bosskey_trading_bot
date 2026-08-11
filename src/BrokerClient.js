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
        const topTickers = ['NVDA', 'AAPL', 'MSFT', 'PLTR', 'TSLA', 'AMZN'];
        const marketData = [];

        console.log(`[Broker] Scanning live prices and fetching historical indicators...`);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 45);
        const startStr = startDate.toISOString();

        for (const sym of topTickers) {
            try {
                const currentPrice = await this.alpaca.marketData.getLatestPrice(sym);
                const url = `https://data.alpaca.markets/v2/stocks/bars?symbols=${sym}&timeframe=1Day&start=${startStr}&limit=30&feed=iex`;
                
                const response = await fetch(url, {
                    method: 'GET',
                    headers: {
                        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                        'accept': 'application/json'
                    }
                });

                const data = await response.json();
                let sma20 = null;
                let rsi14 = null;

                if (data.bars && data.bars[sym] && Array.isArray(data.bars[sym])) {
                    const closePrices = data.bars[sym].map(bar => bar.c);
                    sma20 = this.calculateSMA(closePrices, 20);
                    rsi14 = this.calculateRSI(closePrices, 14);
                }

                marketData.push({ 
                    symbol: sym, 
                    price: currentPrice,
                    sma_20: sma20,
                    rsi_14: rsi14
                });

            } catch (err) {
                console.log(`[Broker] Skipped ${sym}: ${err.message}`);
            }
        }
        return marketData;
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
                const order = await this.alpaca.trading.orders.market({
                    symbol: decision.target_symbol,
                    qty: shares,
                    side: 'buy',
                    timeInForce: 'day'
                });
                console.log(`[Broker] Order Executed! Alpaca Order ID: ${order.id}`);
                
                // Return the execution data for the analytics logger
                return { executed: true, symbol: decision.target_symbol, qty: shares, price: target.price };
            } catch (err) {
                console.log(`[Broker] Order Failed: ${err.message}`);
                return null;
            }
    }
}

module.exports = BrokerClient;
