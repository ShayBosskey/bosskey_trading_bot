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

    async scanMarketMovers() {
        // We start with a high-liquidity watchlist to mock the scanner. 
        // Later, we will upgrade this to query Alpaca's actual screener API.
        const topTickers = ['NVDA', 'AAPL', 'MSFT', 'PLTR', 'TSLA', 'AMZN'];
        const marketData = [];

        console.log(`[Broker] Scanning live prices for top momentum targets...`);
        for (const sym of topTickers) {
            try {
                const price = await this.alpaca.marketData.getLatestPrice(sym);
                marketData.push({ symbol: sym, price: price });
            } catch (err) {
                // Silently skip if a ticker is temporarily halted or unavailable
            }
        }
        return marketData;
    }
}

module.exports = BrokerClient;
