const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { Pool } = require('pg');
const Config = require('./Config');
const Logger = require('./Logger');
const Notifier = require('./Notifier');
const attachGlobalErrorLogger = require('./ErrorHandler');

// Alpaca has no bracket/OCO orders for crypto, so this process IS the stop-loss.
// It runs 24/7 under PM2, watches quotes for every OPEN crypto row, and sends a
// market sell when the bid crosses the row's stop_price or target_price.
//
// Self-healing layers, outermost first:
//   1. PM2 restarts the process on any crash (attachGlobalErrorLogger exits 1).
//   2. On (re)start, pending exits are recovered from the DB and every row is
//      checked against a REST quote before the stream is even up.
//   3. The WebSocket reconnects with jittered exponential backoff, forever.
//   4. A watchdog kills a connection that is open but silent (half-dead TCP,
//      Tailscale route flap) - a heartbeat symbol keeps data flowing so silence
//      always means a broken link, never a quiet market.
//   5. While the stream is unhealthy, REST polling keeps enforcing exits.
//   6. Every HTTP call has a hard timeout so a hung socket can't freeze a loop.
//
// Like PositionsSync, this never writes capital_pots - Settlement owns that.

const STREAM_URL = 'wss://stream.data.alpaca.markets/v1beta3/crypto/us';
const DATA_URL = 'https://data.alpaca.markets/v1beta3/crypto/us';
const HEARTBEAT_SYMBOL = 'BTC/USD';

const BACKOFF_BASE_MS = 1000;
const BACKOFF_CAP_MS = 30000;
// Alpaca allows one data-stream connection per key; a 406 means a previous socket
// is still registered server-side, so wait for it to expire rather than hammer.
const CONNECTION_LIMIT_BACKOFF_MS = 60000;
const STALE_AFTER_MS = 20000;
const WATCHDOG_INTERVAL_MS = 5000;
const REST_POLL_INTERVAL_MS = 5000;
const ROW_REFRESH_INTERVAL_MS = 15000;
const OUTAGE_ALERT_AFTER_MS = 60000;
const HTTP_TIMEOUT_MS = 8000;
const FILL_POLL_MS = 1000;
const FILL_TIMEOUT_MS = 30000;
const PENDING_PREFIX = 'pending:';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Crypto quantities go to Alpaca as decimal strings; 9 places matches the ledger column.
function formatQty(qty) {
    return qty.toFixed(9).replace(/\.?0+$/, '');
}

class CryptoExitEngine {
    constructor({ dryRun = false } = {}) {
        this.dryRun = dryRun;
        this.logger = new Logger('CryptoExitEngine');
        this.notifier = new Notifier();
        this.tradingUrl = Config.getMode() === 'PRODUCTION'
            ? 'https://api.alpaca.markets'
            : 'https://paper-api.alpaca.markets';
        this.authHeaders = {
            'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
            'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
        };

        // A Pool, not a Client: a dropped DB connection is replaced on the next query
        // instead of leaving the engine holding a dead handle.
        this.pool = new Pool({
            user: process.env.DB_USER,
            host: process.env.DB_HOST,
            database: process.env.DB_NAME,
            password: process.env.DB_PASSWORD,
            port: process.env.DB_PORT,
            max: 3,
            connectionTimeoutMillis: HTTP_TIMEOUT_MS,
        });
        this.pool.on('error', err => this.logger.log(`DB pool error (will reconnect on next query): ${err.message}`));

        this.rows = new Map();          // id -> OPEN crypto row (last good DB read is kept if the DB drops)
        this.bids = new Map();          // symbol -> { bid, at }
        this.inFlight = new Set();      // row ids with an exit being placed right now
        this.warnedNoLevels = new Set();

        this.ws = null;
        this.authenticated = false;
        this.subscribed = new Set();
        this.lastMessageAt = 0;
        this.reconnectAttempt = 0;
        this.reconnectTimer = null;
        this.unhealthySince = Date.now();
        this.outageAlerted = false;
        this.timers = [];
        this.stopping = false;
    }

    // ---------- HTTP ----------

    async #http(url, options = {}) {
        const response = await fetch(url, {
            ...options,
            headers: { ...this.authHeaders, 'content-type': 'application/json', ...(options.headers || {}) },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        const text = await response.text();
        const body = text ? JSON.parse(text) : null;
        return { ok: response.ok, status: response.status, body };
    }

    async #getPositionQty(symbol) {
        const res = await this.#http(`${this.tradingUrl}/v2/positions/${symbol.replace('/', '')}`);
        if (res.status === 404) return 0;
        if (!res.ok) throw new Error(`Alpaca position lookup ${symbol}: ${res.status}`);
        return parseFloat(res.body.qty);
    }

    async #getOrderByClientId(clientOrderId) {
        const res = await this.#http(`${this.tradingUrl}/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`);
        if (res.status === 404) return null;
        if (!res.ok) throw new Error(`Alpaca order lookup ${clientOrderId}: ${res.status}`);
        return res.body;
    }

    // ---------- DB ----------

    async #refreshRows() {
        try {
            const res = await this.pool.query(
                `SELECT id, symbol, action, qty, buy_price, stop_price, target_price, exit_order_id
                   FROM trade_analytics
                  WHERE status = 'OPEN' AND symbol LIKE '%/%'`
            );
            this.rows = new Map(res.rows.map(r => [r.id, r]));
        } catch (err) {
            // Keep enforcing the last known rows - losing the DB must not disarm the stops.
            await this.logger.log(`Row refresh failed, keeping ${this.rows.size} cached row(s): ${err.message}`);
            return;
        }

        for (const row of this.rows.values()) {
            if (row.exit_order_id?.startsWith(PENDING_PREFIX) && !this.inFlight.has(row.id)) {
                await this.#recoverPendingExit(row);
            }
        }
        this.#syncSubscriptions();
    }

    // Claims the row before ordering, so a restart mid-exit knows an order may exist.
    // The client_order_id is stored, letting recovery find the order at Alpaca.
    async #claim(row, clientOrderId) {
        try {
            const res = await this.pool.query(
                `UPDATE trade_analytics SET exit_order_id = $1
                  WHERE id = $2 AND status = 'OPEN' AND exit_order_id IS NULL
                  RETURNING id`,
                [PENDING_PREFIX + clientOrderId, row.id]
            );
            return res.rowCount === 1 ? 'claimed' : 'taken';
        } catch (err) {
            // DB down: exit anyway. The broker position check in #exit prevents a
            // double sell, and #finalize will retry the bookkeeping later.
            await this.logger.log(`Claim for id=${row.id} failed (${err.message}); exiting unclaimed.`);
            return 'unclaimed';
        }
    }

    async #release(row) {
        await this.pool.query(
            `UPDATE trade_analytics SET exit_order_id = NULL WHERE id = $1 AND status = 'OPEN'`,
            [row.id]
        ).catch(err => this.logger.log(`Release of id=${row.id} failed: ${err.message}`));
    }

    async #finalize(row, order) {
        const filledQty = parseFloat(order.filled_qty);
        const sellPrice = parseFloat(order.filled_avg_price);
        const buyPrice = parseFloat(row.buy_price);
        const rowQty = parseFloat(row.qty);
        // Cost uses the full bought qty: Alpaca takes the buy fee out of the coins
        // received, so any shortfall between rowQty and filledQty is a real cost.
        const netProfit = sellPrice * filledQty - buyPrice * rowQty;
        const margin = (sellPrice - buyPrice) / buyPrice * 100;

        for (let attempt = 1; attempt <= 5; attempt++) {
            try {
                await this.pool.query(
                    `UPDATE trade_analytics
                        SET status = 'CLOSED', sell_price = $1, net_profit = $2, margin_percentage = $3,
                            closed_at = $4, exit_order_id = $5
                      WHERE id = $6 AND status = 'OPEN'`,
                    [sellPrice, netProfit.toFixed(2), margin.toFixed(2), order.filled_at, order.id, row.id]
                );
                this.rows.delete(row.id);
                return true;
            } catch (err) {
                await this.logger.log(`Finalize id=${row.id} attempt ${attempt}/5 failed: ${err.message}`);
                await sleep(2000 * attempt);
            }
        }
        // Sold but not booked. The row still holds the pending client id, so the
        // next refresh after the DB recovers runs #recoverPendingExit and books it.
        await this.notifier.push('Crypto Exit Not Booked', `${row.symbol} (id=${row.id}) sold via ${order.id} but the DB write failed. Will retry on recovery.`, 'warning');
        return false;
    }

    // ---------- Exits ----------

    async #recoverPendingExit(row) {
        const clientOrderId = row.exit_order_id.slice(PENDING_PREFIX.length);
        this.inFlight.add(row.id);
        try {
            const order = await this.#getOrderByClientId(clientOrderId);
            if (order?.status === 'filled') {
                await this.logger.log(`Recovered filled exit ${clientOrderId} for ${row.symbol} (id=${row.id}).`);
                await this.#finalize(row, order);
            } else if (!order || ['canceled', 'expired', 'rejected'].includes(order.status)) {
                await this.logger.log(`Pending exit ${clientOrderId} for id=${row.id} never filled (${order?.status || 'not found'}); re-arming.`);
                await this.#release(row);
                row.exit_order_id = null;
            }
            // Anything else (new, partially_filled) is still working - check again next refresh.
        } catch (err) {
            await this.logger.log(`Recovery of id=${row.id} deferred: ${err.message}`);
        } finally {
            this.inFlight.delete(row.id);
        }
    }

    #shouldExit(row, bid) {
        if (row.action !== 'BUY') return null; // Alpaca crypto is long-only
        const stop = parseFloat(row.stop_price);
        const target = parseFloat(row.target_price);
        if (!Number.isFinite(stop) || !Number.isFinite(target)) {
            if (!this.warnedNoLevels.has(row.id)) {
                this.warnedNoLevels.add(row.id);
                this.notifier.push('Crypto Position Unprotected', `${row.symbol} (id=${row.id}) has no stop_price/target_price. The exit engine cannot protect it.`, 'rotating_light');
            }
            return null;
        }
        if (bid <= stop) return 'STOP';
        if (bid >= target) return 'TARGET';
        return null;
    }

    async #evaluate(symbol) {
        const quote = this.bids.get(symbol);
        if (!quote) return;
        for (const row of this.rows.values()) {
            if (row.symbol !== symbol || this.inFlight.has(row.id) || row.exit_order_id) continue;
            const reason = this.#shouldExit(row, quote.bid);
            if (reason) this.#exit(row, reason, quote.bid); // not awaited: one slow exit mustn't block others
        }
    }

    async #exit(row, reason, bid) {
        this.inFlight.add(row.id);
        const clientOrderId = `exit-${row.id}-${Date.now()}`;
        try {
            await this.logger.log(`${reason} hit for ${row.symbol} (id=${row.id}) at bid ${bid} (stop ${row.stop_price}, target ${row.target_price}).`);
            if (this.dryRun) return;

            // Sell what is actually held, never more: the buy fee leaves slightly fewer
            // coins than the row records, and an already-closed position sells nothing.
            const heldQty = await this.#getPositionQty(row.symbol);
            if (heldQty <= 0) {
                await this.notifier.push('Crypto Exit Skipped', `${row.symbol} (id=${row.id}) hit ${reason} but Alpaca holds none. Needs manual review.`, 'warning');
                row.exit_order_id = 'manual-review';
                return;
            }
            const qty = Math.min(parseFloat(row.qty), heldQty);

            const claim = await this.#claim(row, clientOrderId);
            if (claim === 'taken') return;
            row.exit_order_id = PENDING_PREFIX + clientOrderId;

            const res = await this.#http(`${this.tradingUrl}/v2/orders`, {
                method: 'POST',
                body: JSON.stringify({
                    symbol: row.symbol,
                    qty: formatQty(qty),
                    side: 'sell',
                    type: 'market',
                    time_in_force: 'gtc',
                    client_order_id: clientOrderId,
                }),
            });
            if (!res.ok) {
                await this.#release(row);
                row.exit_order_id = null; // re-armed: the next quote retries
                throw new Error(`order rejected ${res.status}: ${JSON.stringify(res.body)}`);
            }

            const order = await this.#awaitFill(res.body.id);
            if (order.status === 'filled') {
                await this.#finalize(row, order);
                await this.notifier.push(
                    reason === 'STOP' ? '🔴 Crypto Stop Hit' : '🟢 Crypto Target Hit',
                    `${row.symbol}: sold ${order.filled_qty} @ $${order.filled_avg_price}`,
                    'money_with_wings'
                );
            } else {
                // Left pending in the DB; #recoverPendingExit resolves it on a later refresh.
                await this.logger.log(`Exit ${order.id} for id=${row.id} still ${order.status} after ${FILL_TIMEOUT_MS}ms; recovery will finish it.`);
            }
        } catch (err) {
            await this.logger.log(`Exit for ${row.symbol} (id=${row.id}) failed: ${err.message}`);
            await this.notifier.push('Crypto Exit Failed', `${row.symbol} (id=${row.id}) ${reason}: ${err.message}. Will retry on the next quote.`, 'rotating_light');
        } finally {
            this.inFlight.delete(row.id);
        }
    }

    async #awaitFill(orderId) {
        const deadline = Date.now() + FILL_TIMEOUT_MS;
        let order;
        do {
            await sleep(FILL_POLL_MS);
            const res = await this.#http(`${this.tradingUrl}/v2/orders/${orderId}`);
            if (res.ok) order = res.body;
        } while ((!order || order.status !== 'filled') && Date.now() < deadline);
        return order || { id: orderId, status: 'unknown' };
    }

    // ---------- Stream ----------

    #isHealthy() {
        return this.authenticated && Date.now() - this.lastMessageAt < STALE_AFTER_MS;
    }

    #connect() {
        if (this.stopping) return;
        this.reconnectTimer = null;
        this.authenticated = false;
        this.subscribed.clear();

        let ws;
        try {
            ws = new WebSocket(STREAM_URL);
        } catch (err) {
            this.logger.log(`WebSocket construct failed: ${err.message}`);
            this.#scheduleReconnect();
            return;
        }
        this.ws = ws;
        this.lastMessageAt = Date.now(); // grace period for the handshake

        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ action: 'auth', key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_SECRET_KEY }));
        });
        ws.addEventListener('message', event => {
            if (ws !== this.ws) return; // a superseded socket still flushing
            this.lastMessageAt = Date.now();
            let messages;
            try {
                messages = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString());
            } catch {
                return;
            }
            for (const msg of messages) this.#onMessage(msg);
        });
        ws.addEventListener('error', () => { /* 'close' always follows and owns reconnection */ });
        ws.addEventListener('close', event => {
            if (ws !== this.ws) return;
            this.#markUnhealthy(`stream closed (code ${event.code})`);
            this.#scheduleReconnect();
        });
    }

    #onMessage(msg) {
        if (msg.T === 'success' && msg.msg === 'authenticated') {
            this.authenticated = true;
            this.reconnectAttempt = 0;
            this.#syncSubscriptions();
            this.#markHealthy();
        } else if (msg.T === 'error') {
            this.logger.log(`Stream error ${msg.code}: ${msg.msg}`);
            if (msg.code === 406) this.reconnectAttempt = -1; // connection limit: long wait
            this.#dropSocket();
        } else if (msg.T === 'q' && Number.isFinite(msg.bp) && msg.bp > 0) {
            this.bids.set(msg.S, { bid: msg.bp, at: Date.now() });
            this.#evaluate(msg.S);
        }
    }

    #syncSubscriptions() {
        if (!this.authenticated || this.ws?.readyState !== WebSocket.OPEN) return;
        const wanted = new Set([HEARTBEAT_SYMBOL, ...[...this.rows.values()].map(r => r.symbol)]);
        const add = [...wanted].filter(s => !this.subscribed.has(s));
        const remove = [...this.subscribed].filter(s => !wanted.has(s));
        if (add.length) this.ws.send(JSON.stringify({ action: 'subscribe', quotes: add }));
        if (remove.length) this.ws.send(JSON.stringify({ action: 'unsubscribe', quotes: remove }));
        this.subscribed = wanted;
    }

    // Abandons the current socket without waiting for a close handshake that a dead
    // link would never complete. Its handlers ignore events once it's superseded.
    #dropSocket() {
        const old = this.ws;
        this.ws = null;
        this.authenticated = false;
        try { old?.close(); } catch { /* already dead */ }
        this.#markUnhealthy('socket dropped');
        this.#scheduleReconnect();
    }

    #scheduleReconnect() {
        if (this.stopping || this.reconnectTimer) return;
        let delay;
        if (this.reconnectAttempt < 0) {
            delay = CONNECTION_LIMIT_BACKOFF_MS;
            this.reconnectAttempt = 0;
        } else {
            // Full jitter so a Tailscale flap doesn't make every retry land in lockstep.
            delay = Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.reconnectAttempt);
            this.reconnectAttempt++;
        }
        this.logger.log(`Reconnecting stream in ${Math.round(delay)}ms (attempt ${this.reconnectAttempt}).`);
        this.reconnectTimer = setTimeout(() => this.#connect(), delay);
    }

    #markUnhealthy(reason) {
        if (this.unhealthySince === null) {
            this.unhealthySince = Date.now();
            this.logger.log(`Stream unhealthy: ${reason}. REST polling is enforcing exits.`);
        }
    }

    #markHealthy() {
        if (this.unhealthySince !== null) {
            const downMs = Date.now() - this.unhealthySince;
            this.logger.log(`Stream healthy again after ${Math.round(downMs / 1000)}s.`);
            if (this.outageAlerted) {
                this.notifier.push('Crypto Stream Recovered', `Live quotes restored after ${Math.round(downMs / 1000)}s.`, 'white_check_mark');
            }
        }
        this.unhealthySince = null;
        this.outageAlerted = false;
    }

    #watchdog() {
        if (this.ws && this.authenticated && !this.#isHealthy()) {
            this.logger.log(`No stream data for ${STALE_AFTER_MS}ms; assuming a dead link.`);
            this.#dropSocket();
        }
        if (this.unhealthySince !== null && !this.outageAlerted && Date.now() - this.unhealthySince > OUTAGE_ALERT_AFTER_MS) {
            this.outageAlerted = true;
            this.notifier.push('Crypto Stream Down', `No live quotes for over ${OUTAGE_ALERT_AFTER_MS / 1000}s. Exits are running on REST polling.`, 'warning');
        }
    }

    // Fallback price source whenever the stream isn't trustworthy. Also runs once at
    // boot so anything that crossed its level while the engine was down exits at once.
    async #pollRest(force = false) {
        if (!force && this.#isHealthy()) return;
        const symbols = [...new Set([...this.rows.values()].map(r => r.symbol))];
        if (symbols.length === 0) return;
        try {
            const res = await this.#http(`${DATA_URL}/latest/quotes?symbols=${encodeURIComponent(symbols.join(','))}`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            for (const [symbol, q] of Object.entries(res.body.quotes || {})) {
                if (q.bp > 0) {
                    this.bids.set(symbol, { bid: q.bp, at: Date.now() });
                    await this.#evaluate(symbol);
                }
            }
        } catch (err) {
            await this.logger.log(`REST quote poll failed: ${err.message}`);
        }
    }

    // ---------- Lifecycle ----------

    async start() {
        await this.logger.log(`🛡️ CRYPTO EXIT ENGINE starting (${Config.getMode()}${this.dryRun ? ', DRY RUN' : ''}).`);
        await this.#refreshRows();
        await this.logger.log(`Guarding ${this.rows.size} OPEN crypto row(s).`);
        await this.#pollRest(true);
        this.#connect();

        this.timers.push(setInterval(() => this.#watchdog(), WATCHDOG_INTERVAL_MS));
        this.timers.push(setInterval(() => this.#pollRest(), REST_POLL_INTERVAL_MS));
        this.timers.push(setInterval(() => this.#refreshRows(), ROW_REFRESH_INTERVAL_MS));

        for (const signal of ['SIGINT', 'SIGTERM']) {
            process.on(signal, () => this.stop(signal));
        }
    }

    async stop(signal) {
        this.stopping = true;
        await this.logger.log(`Stopping on ${signal}.`);
        this.timers.forEach(clearInterval);
        clearTimeout(this.reconnectTimer);
        try { this.ws?.close(); } catch { /* ignore */ }
        await this.pool.end().catch(() => {});
        process.exit(0);
    }
}

if (require.main === module) {
    attachGlobalErrorLogger('CryptoExitEngine');
    new CryptoExitEngine({ dryRun: process.argv.includes('--dry-run') }).start();
}

module.exports = CryptoExitEngine;
