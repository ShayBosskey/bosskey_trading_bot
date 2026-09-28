const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const FundamentalClient = require('./FundamentalClient');
const yahooFinance = require('yahoo-finance2').default;
const Config = require('./Config');

class BrokerClient {
    constructor() {
        this.alpaca = new Alpaca({
            keyId: process.env.ALPACA_API_KEY,
            secret: process.env.ALPACA_SECRET_KEY,
            paper: Config.getMode() !== 'PRODUCTION'
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

    async scanMarketMovers(heldSymbols, neededSlots) {
        console.log(`[Broker] Pinging Screener API. Looking for ${neededSlots} valid setups...`);
        
        try {
            const screenerUrl = 'https://data.alpaca.markets/v1beta1/screener/stocks/movers?top=50';
            const response = await fetch(screenerUrl, {
                headers: {
                    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                    'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                    'accept': 'application/json'
                }
            });

            if (!response.ok) throw new Error(`Alpaca API Error: ${response.status}`);
            const screenerData = await response.json();
            
            let allMovers = [...(screenerData.gainers || []), ...(screenerData.losers || [])];
            
            // Filter 1: Must be >= $5.00
            // Filter 2: Must NOT be currently held in our portfolio
            allMovers = allMovers.filter(mover => 
                mover.price >= 5.00 && 
                !heldSymbols.includes(mover.symbol)
            );
            
            allMovers.sort((a, b) => Math.abs(b.percent_change) - Math.abs(a.percent_change));
            
            let validSetups = [];
            const pastDate = new Date();
            pastDate.setDate(pastDate.getDate() - 40);
            const startString = pastDate.toISOString();

            for (const mover of allMovers) {
                if (validSetups.length >= neededSlots) break; // Stop when we have enough targets

                const barUrl = `https://data.alpaca.markets/v2/stocks/bars?symbols=${mover.symbol}&timeframe=1Day&start=${startString}`;
                const barResponse = await fetch(barUrl, {
                    headers: {
                        'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                        'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                        'accept': 'application/json'
                    }
                });

                if (!barResponse.ok) continue;

                const barData = await barResponse.json();
                const bars = barData.bars[mover.symbol];
                
                if (bars && bars.length >= 20) {
                    const closePrices = bars.map(bar => bar.c);
                    const sma_20 = this.calculateSMA(closePrices, 20);
                    
                    if (sma_20 >= 5.00) {

			const fundamentalClient = new FundamentalClient();
                        const earningsRisk = await fundamentalClient.hasUpcomingEarnings(mover.symbol);
                        
                        if (earningsRisk) {
                            console.log(`[Broker] Discarding ${mover.symbol} due to impending earnings report.`);
                            continue; // Skip this stock and move to the next one
                        }

                        validSetups.push({
                            symbol: mover.symbol,
                            price: mover.price,
                            dailyChange: mover.percent_change.toFixed(2),
                            volume: bars[bars.length - 1].v,
                            sma_20: sma_20,
                            rsi_14: this.calculateRSI(closePrices, 14),
			    rawBars: bars
                        });
                        console.log(`[Broker] Valid target added: ${mover.symbol}`);
                    }
                }
            }

            return validSetups; // Now returns an array of targets

        } catch (err) {
            console.error(`[Broker Error]: ${err.message}`);
            throw err;
        }
    }

    async fetchFundamentals(symbol) {
        try {
            const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${process.env.FINNHUB_API_KEY}`);
            if (!response.ok) throw new Error('Finnhub fetch failed.');
            return await response.json();
        } catch (error) {
            console.log(`[Fundamental Warning] Finnhub unavailable for ${symbol}. Routing to Yahoo Finance fallback...`);
            const quote = await yahooFinance.quote(symbol);
            return {
                c: quote.regularMarketPrice,
                d: quote.regularMarketChange,
                dp: quote.regularMarketChangePercent
            };
        }
    }

    // Alpaca will not honour GTC on a bracket whose entry is a *market* order: the
    // parent and both protective legs silently come back as `day`. At 16:00 ET the
    // take-profit leg expires, OCO cancels the stop-loss along with it, and the
    // position is left completely naked overnight. Confirmed against the live
    // order history for ISRL/RDAC/SDOT/AAPL - every leg recorded tif=day with the
    // TP expiring at 20:00 UTC and the SL cancelled microseconds later.
    //
    // A *limit* entry is accepted as GTC, so the bracket and both legs survive
    // across sessions. The limit is priced marketably (a small buffer above the
    // quote) so it still fills promptly while capping entry slippage.
    //
    // Returns the REAL fill from Alpaca - never the screener's quote - because the
    // ledger's buy_price is what every downstream P&L calculation is built on.
    async executeBuyOrder(symbol, allocateAmount, currentPrice, takeProfitPrice, stopLossPrice, options = {}) {
        const {
            slippageBufferPct = 0.005,
            fillTimeoutMs = 20000,
            pollIntervalMs = 1000
        } = options;

        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
            throw new Error(`Invalid reference price ($${currentPrice}) for ${symbol}.`);
        }
        if (!Number.isFinite(takeProfitPrice) || !Number.isFinite(stopLossPrice)) {
            throw new Error(`Invalid bracket prices for ${symbol} (TP: ${takeProfitPrice}, SL: ${stopLossPrice}).`);
        }

        // Calculate maximum whole shares
        const qty = Math.floor(allocateAmount / currentPrice);

        // NaN fails every `< 1` comparison, so it must be checked explicitly or a
        // corrupted capital figure would silently pass through as a malformed order.
        if (!Number.isFinite(qty) || qty < 1) {
            throw new Error(`Allocated capital ($${allocateAmount}) is insufficient or invalid to buy 1 share of ${symbol} at $${currentPrice}.`);
        }

        const limitPrice = this.#formatPrice(currentPrice * (1 + slippageBufferPct));
        const takeProfit = this.#formatPrice(takeProfitPrice);
        const stopLoss = this.#formatPrice(stopLossPrice);

        // Alpaca rejects a buy bracket whose TP is not above, or SL not below, the
        // entry. Catching it here gives a readable error instead of an API 422.
        if (parseFloat(takeProfit) <= parseFloat(limitPrice)) {
            throw new Error(`Take-profit ($${takeProfit}) must be above the entry limit ($${limitPrice}) for ${symbol}.`);
        }
        if (parseFloat(stopLoss) >= parseFloat(limitPrice)) {
            throw new Error(`Stop-loss ($${stopLoss}) must be below the entry limit ($${limitPrice}) for ${symbol}.`);
        }

        console.log(`[Broker] Formatting GTC BRACKET BUY (limit $${limitPrice}) for ${qty} shares of ${symbol}...`);

        const response = await fetch(`${this.#getBaseUrl()}/v2/orders`, {
            method: 'POST',
            headers: { ...this.#authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({
                symbol: symbol,
                qty: String(qty),
                side: 'buy',
                type: 'limit',
                limit_price: limitPrice,
                time_in_force: 'gtc',
                order_class: 'bracket',
                take_profit: {
                    limit_price: takeProfit
                },
                stop_loss: {
                    stop_price: stopLoss
                }
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Alpaca Order API Error: ${errorData.message || response.status}`);
        }

        const order = await response.json();

        // The whole point of this change is the GTC brackets. If Alpaca ever coerces
        // it back to `day`, that must be loud rather than silent - a silent coercion
        // is precisely what left six positions unprotected.
        if (order.time_in_force !== 'gtc') {
            console.warn(`[Broker] ⚠️ Alpaca returned time_in_force='${order.time_in_force}' (expected 'gtc') for ${symbol}. Protective legs may expire at the close.`);
        }

        const settled = await this.#awaitFill(order.id, { fillTimeoutMs, pollIntervalMs });

        if (!settled.filled) {
            console.log(`[Broker] ${symbol} entry did not fill within ${fillTimeoutMs}ms (status: ${settled.status}). Order cancelled; nothing recorded.`);
            return { filled: false, orderId: order.id, status: settled.status, symbol };
        }

        console.log(`[Broker] ${symbol} BRACKET filled: ${settled.qty} @ $${settled.filledAvgPrice} (GTC legs active).`);

        return {
            filled: true,
            orderId: order.id,
            symbol,
            qty: settled.qty,
            filled_avg_price: settled.filledAvgPrice,
            time_in_force: order.time_in_force
        };
    }

    // Polls a submitted order to its resting state. Returns the real fill, or
    // cancels the order so no untracked position can exist without a ledger row.
    async #awaitFill(orderId, { fillTimeoutMs, pollIntervalMs }) {
        const deadline = Date.now() + fillTimeoutMs;
        let order = null;

        while (Date.now() < deadline) {
            order = await this.#getOrder(orderId);

            if (order.status === 'filled') {
                return {
                    filled: true,
                    qty: parseInt(order.filled_qty, 10),
                    filledAvgPrice: parseFloat(order.filled_avg_price),
                    status: order.status
                };
            }

            if (['canceled', 'expired', 'rejected', 'suspended'].includes(order.status)) {
                throw new Error(`Order ${orderId} ended as '${order.status}' without filling.`);
            }

            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        }

        // Timed out. Cancel so we never hold shares the ledger knows nothing about.
        await this.#cancelOrder(orderId);
        order = await this.#getOrder(orderId);

        // A fill can land in the gap between the timeout and the cancel taking
        // effect, in which case the position is real and must still be recorded.
        const filledQty = parseInt(order.filled_qty, 10);
        if (filledQty > 0 && order.filled_avg_price) {
            return {
                filled: true,
                qty: filledQty,
                filledAvgPrice: parseFloat(order.filled_avg_price),
                status: order.status
            };
        }

        return { filled: false, qty: 0, filledAvgPrice: null, status: order.status };
    }

    async #getOrder(orderId) {
        const response = await fetch(`${this.#getBaseUrl()}/v2/orders/${orderId}`, {
            headers: this.#authHeaders()
        });
        if (!response.ok) throw new Error(`Alpaca Get Order API Error: ${response.status}`);
        return await response.json();
    }

    async #cancelOrder(orderId) {
        // 422 here means "already filled/done" - not an error worth throwing on.
        const response = await fetch(`${this.#getBaseUrl()}/v2/orders/${orderId}`, {
            method: 'DELETE',
            headers: this.#authHeaders()
        });
        return response.ok || response.status === 422;
    }

    // Alpaca accepts penny increments at or above $1.00, and 4 decimals below it.
    // Blindly using toFixed(2) rounds a sub-dollar stop to $0.00 and gets rejected.
    #formatPrice(price) {
        return price >= 1 ? price.toFixed(2) : price.toFixed(4);
    }

    #getBaseUrl() {
        return Config.getMode() === 'PRODUCTION'
            ? 'https://api.alpaca.markets'
            : 'https://paper-api.alpaca.markets';
    }

    #authHeaders() {
        return {
            'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
            'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
            'accept': 'application/json'
        };
    }

    // Ground truth for what the broker actually holds right now. Used by the
    // reconciliation routine to detect drift against `trade_analytics`.
    async getPositions() {
        const response = await fetch(`${this.#getBaseUrl()}/v2/positions`, {
            headers: this.#authHeaders()
        });

        if (!response.ok) throw new Error(`Alpaca Positions API Error: ${response.status}`);
        return await response.json();
    }

    // Finds the most recent filled order on the given side for a symbol, so a
    // reconciled trade can be closed with a real fill price/time instead of a guess.
    async getLastFilledOrder(symbol, side) {
        const url = `${this.#getBaseUrl()}/v2/orders?status=closed&symbols=${symbol}&direction=desc&limit=50`;
        const response = await fetch(url, { headers: this.#authHeaders() });

        if (!response.ok) throw new Error(`Alpaca Orders API Error: ${response.status}`);
        const orders = await response.json();

        return orders.find(o => o.side === side && o.status === 'filled' && o.filled_avg_price) || null;
    }

    // Full order history (every status, all time) for one symbol. Used to fully
    // reconstruct what actually happened to a position before repairing a row -
    // never inferred from just the most recent order.
    async getOrderHistory(symbol) {
        const url = `${this.#getBaseUrl()}/v2/orders?status=all&symbols=${symbol}&limit=500&direction=asc`;
        const response = await fetch(url, { headers: this.#authHeaders() });

        if (!response.ok) throw new Error(`Alpaca Orders API Error: ${response.status}`);
        return await response.json();
    }
}

module.exports = BrokerClient;
