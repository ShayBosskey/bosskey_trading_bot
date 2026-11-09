const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Alpaca } = require('@alpacahq/alpaca-trade-api');
const Config = require('./Config');
const RiskEngine = require('./RiskEngine');

const CRYPTO_DATA_URL = 'https://data.alpaca.markets/v1beta3/crypto/us';
const CRYPTO_BENCHMARK = 'BTC/USD';
const CRYPTO_EXCLUDED_BASES = ['USDC', 'USDT', 'USDG', 'DAI', 'PYUSD', 'TUSD', 'USDP', 'PAXG', 'XAUT'];
const CRYPTO_MAX_SPREAD_BPS = 30;
// Bid depth within 1% of mid must cover this multiple of the largest position, so
// a market-sell stop doesn't walk the book.
const CRYPTO_MIN_DEPTH_MULTIPLE = 2;

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
                        // Baseline excludes today's bar, so a spike day is compared
                        // against normal volume rather than inflating its own average.
                        const priorBars = bars.slice(-21, -1);
                        const avgVolume20 = priorBars.reduce((sum, bar) => sum + bar.v, 0) / priorBars.length;

                        validSetups.push({
                            symbol: mover.symbol,
                            price: mover.price,
                            dailyChange: mover.percent_change.toFixed(2),
                            volume: bars[bars.length - 1].v,
                            avg_volume_20: Math.round(avgVolume20),
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

    // ---------- Crypto (Alpaca /v1beta3/crypto/us) ----------
    //
    // Alpaca's crypto venue is thin: 24h volume on most pairs is a few thousand
    // dollars and spreads run 20-100 bps. So the scanner gates on spread and on
    // bid-side order book depth (what a market-sell stop actually hits), and the
    // venue volume is passed to the agents labelled as Alpaca-only.

    async #cryptoData(pathAndQuery) {
        const response = await fetch(`${CRYPTO_DATA_URL}${pathAndQuery}`, {
            headers: { ...this.#authHeaders(), accept: 'application/json' },
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Alpaca Crypto Data API Error: ${response.status} on ${pathAndQuery.split('?')[0]}`);
        return await response.json();
    }

    // Tradable USD pairs, minus stablecoins and gold tokens (no momentum to trade).
    async getCryptoAssets() {
        const response = await fetch(`${this.#getBaseUrl()}/v2/assets?asset_class=crypto&status=active`, {
            headers: this.#authHeaders(),
            signal: AbortSignal.timeout(10000)
        });
        if (!response.ok) throw new Error(`Alpaca Assets API Error: ${response.status}`);
        const assets = await response.json();
        return assets.filter(a =>
            a.tradable &&
            a.symbol.endsWith('/USD') &&
            !CRYPTO_EXCLUDED_BASES.includes(a.symbol.split('/')[0])
        );
    }

    async getCryptoHourlyBars(symbols, hours = 72) {
        const start = new Date(Date.now() - hours * 3600 * 1000).toISOString();
        const bars = {};
        let pageToken = null;
        // `limit` is shared across all symbols, so a multi-symbol request pages.
        do {
            const page = await this.#cryptoData(
                `/bars?symbols=${encodeURIComponent(symbols.join(','))}&timeframe=1Hour&start=${start}&limit=10000` +
                (pageToken ? `&page_token=${pageToken}` : '')
            );
            for (const [symbol, list] of Object.entries(page.bars || {})) {
                (bars[symbol] = bars[symbol] || []).push(...list);
            }
            pageToken = page.next_page_token;
        } while (pageToken);
        return bars;
    }

    async getCryptoSnapshots(symbols) {
        const body = await this.#cryptoData(`/snapshots?symbols=${encodeURIComponent(symbols.join(','))}`);
        return body.snapshots || {};
    }

    async getCryptoOrderbooks(symbols) {
        const body = await this.#cryptoData(`/latest/orderbooks?symbols=${encodeURIComponent(symbols.join(','))}`);
        return body.orderbooks || {};
    }

    // USD resting within `pct` of mid on one side of the book.
    static bookDepthUsd(levels, mid, pct, side) {
        const limit = side === 'bid' ? mid * (1 - pct) : mid * (1 + pct);
        return (levels || [])
            .filter(l => (side === 'bid' ? l.p >= limit : l.p <= limit))
            .reduce((sum, l) => sum + l.p * l.s, 0);
    }

    // Hourly log-return standard deviation scaled to a day, in percent.
    static realizedVolPct(closes) {
        if (closes.length < 3) return null;
        const returns = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
        const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
        return Math.sqrt(variance) * Math.sqrt(24) * 100;
    }

    // Returns up to `neededSlots` candidates with everything both agents and the
    // entry gates need. `maxNotional` is the largest position the bot could size,
    // used to demand enough bid depth for a stop to exit through.
    async scanCryptoMarket(heldSymbols, neededSlots, { maxNotional, maxSpreadBps = CRYPTO_MAX_SPREAD_BPS, minDepthMultiple = CRYPTO_MIN_DEPTH_MULTIPLE } = {}) {
        const assets = (await this.getCryptoAssets()).filter(a => !heldSymbols.includes(a.symbol));
        const symbols = assets.map(a => a.symbol);
        if (!symbols.includes(CRYPTO_BENCHMARK)) symbols.push(CRYPTO_BENCHMARK);
        console.log(`[Broker] Scanning ${assets.length} crypto pairs for ${neededSlots} setup(s)...`);

        const [snapshots, bars, books] = await Promise.all([
            this.getCryptoSnapshots(symbols),
            this.getCryptoHourlyBars(symbols),
            this.getCryptoOrderbooks(symbols)
        ]);

        const change24h = list => list.length >= 24 ? (list[list.length - 1].c / list[list.length - 24].o - 1) * 100 : null;
        const btcChange = change24h(bars[CRYPTO_BENCHMARK] || []);

        const setups = [];
        for (const asset of assets) {
            const symbol = asset.symbol;
            const quote = snapshots[symbol]?.latestQuote;
            const hourly = bars[symbol] || [];
            if (!quote || !(quote.bp > 0) || !(quote.ap > 0) || hourly.length < 25) continue;

            const mid = (quote.ap + quote.bp) / 2;
            const spreadBps = (quote.ap - quote.bp) / mid * 10000;
            const book = books[symbol] || {};
            const bidDepth = BrokerClient.bookDepthUsd(book.b, mid, 0.01, 'bid');
            const askDepth = BrokerClient.bookDepthUsd(book.a, mid, 0.01, 'ask');

            if (spreadBps > maxSpreadBps) continue;
            if (Number.isFinite(maxNotional) && bidDepth < maxNotional * minDepthMultiple) continue;

            const closes = hourly.map(b => b.c);
            const last24 = hourly.slice(-24);
            const atr = RiskEngine.calculateATR(hourly, 14);

            setups.push({
                symbol,
                assetClass: 'crypto',
                price: quote.ap,             // a buy pays the ask
                bid: quote.bp,
                ask: quote.ap,
                spread_bps: Number(spreadBps.toFixed(1)),
                change_24h: Number(change24h(hourly).toFixed(2)),
                venue_volume_24h_usd: Math.round(last24.reduce((sum, b) => sum + b.v * (b.vw || b.c), 0)),
                bid_depth_1pct_usd: Math.round(bidDepth),
                ask_depth_1pct_usd: Math.round(askDepth),
                realized_vol_24h_pct: Number(BrokerClient.realizedVolPct(closes.slice(-25)).toFixed(2)),
                atr_1h: atr,
                atr_1h_pct: Number((atr / mid * 100).toFixed(3)),
                sma_20h: this.calculateSMA(closes, 20),
                rsi_14h: this.calculateRSI(closes, 14),
                btc_change_24h: btcChange === null ? null : Number(btcChange.toFixed(2)),
                min_order_size: parseFloat(asset.min_order_size),
                min_trade_increment: parseFloat(asset.min_trade_increment),
                price_increment: parseFloat(asset.price_increment),
                rawBars: hourly
            });
        }

        // Strongest 24h momentum first; the agents decide whether it is tradeable.
        setups.sort((a, b) => b.change_24h - a.change_24h);
        console.log(`[Broker] ${setups.length} crypto pair(s) passed spread/depth gates.`);
        return setups.slice(0, neededSlots);
    }

    // Fractional, long-only crypto entry. No bracket: Alpaca has none for crypto,
    // so the exit levels go in the ledger and CryptoExitEngine enforces them.
    // A marketable limit (ask + buffer) caps slippage on a thin book.
    async executeCryptoBuy(setup, qty, options = {}) {
        const { slippageBufferPct = 0.005, fillTimeoutMs = 20000, pollIntervalMs = 1000 } = options;

        if (!Number.isFinite(qty) || qty <= 0 || qty < setup.min_order_size) {
            throw new Error(`Crypto qty ${qty} for ${setup.symbol} is below the minimum order size ${setup.min_order_size}.`);
        }

        const decimals = Math.max(0, Math.min(9, Math.round(-Math.log10(setup.price_increment || 1e-9))));
        const limitPrice = (Math.ceil(setup.ask * (1 + slippageBufferPct) * 10 ** decimals) / 10 ** decimals).toFixed(decimals);
        const qtyString = qty.toFixed(9).replace(/\.?0+$/, '');

        console.log(`[Broker] Crypto BUY ${qtyString} ${setup.symbol} (limit $${limitPrice}, GTC, no bracket)...`);
        const response = await fetch(`${this.#getBaseUrl()}/v2/orders`, {
            method: 'POST',
            headers: { ...this.#authHeaders(), 'content-type': 'application/json' },
            body: JSON.stringify({
                symbol: setup.symbol,
                qty: qtyString,
                side: 'buy',
                type: 'limit',
                limit_price: limitPrice,
                time_in_force: 'gtc'
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(`Alpaca Crypto Order API Error: ${errorData.message || response.status}`);
        }

        const order = await response.json();
        const settled = await this.#awaitFill(order.id, { fillTimeoutMs, pollIntervalMs });
        if (!settled.filled) {
            return { filled: false, orderId: order.id, status: settled.status, symbol: setup.symbol };
        }

        console.log(`[Broker] ${setup.symbol} crypto entry filled: ${settled.qty} @ $${settled.filledAvgPrice}.`);
        return { filled: true, orderId: order.id, symbol: setup.symbol, qty: settled.qty, filled_avg_price: settled.filledAvgPrice };
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
                    qty: parseFloat(order.filled_qty),
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
        // parseFloat, not parseInt: crypto fills are fractional.
        const filledQty = parseFloat(order.filled_qty);
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
    // never inferred from just the most recent order. With `nested`, Alpaca rolls
    // bracket take-profit/stop-loss legs up under their entry order's `legs`.
    async getOrderHistory(symbol, { nested = false } = {}) {
        const url = `${this.#getBaseUrl()}/v2/orders?status=all&symbols=${symbol}&limit=500&direction=asc${nested ? '&nested=true' : ''}`;
        const response = await fetch(url, { headers: this.#authHeaders() });

        if (!response.ok) throw new Error(`Alpaca Orders API Error: ${response.status}`);
        return await response.json();
    }
}

module.exports = BrokerClient;
