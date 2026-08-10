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

        // Force the API to look back 45 days so we have enough bars for the math
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - 45);
        const startStr = startDate.toISOString();

        for (const sym of topTickers) {
            try {
                // 1. Get live price via SDK
                const currentPrice = await this.alpaca.marketData.getLatestPrice(sym);

                // 2. Fetch historical bars with an explicit start date
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

                // 3. Extract closing prices safely
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
}

module.exports = BrokerClient;
