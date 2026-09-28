const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const BrokerClient = require('./BrokerClient');
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
const Notifier = require('./Notifier');
const attachGlobalErrorLogger = require('./ErrorHandler');

// Replaces the exit engine deleted in 8caf045 (src/Liquidator.js), which was
// removed when execution moved to broker-side OCO brackets. Nothing took over
// its bookkeeping job: when a bracket leg fired, Alpaca closed the position but
// no process ever wrote status='CLOSED' back to trade_analytics. OPEN rows piled
// up until TradingBot saw 5/5 slots used and stood down permanently.
//
// This runs on a schedule and answers one question per open row: "does the
// broker still hold this?" If not, the row is closed using Alpaca's real fill.
//
// Deliberately does NOT touch capital_pots. Settlement.js already sweeps every
// row closed today and distributes the day's net across the pots; moving capital
// here as well would double-count every trade. This module owns row status only.
class PositionsSync {
    constructor() {
        this.broker = new BrokerClient();
        this.db = new DatabaseClient();
        this.logger = new Logger('PositionsSync');
        this.notifier = new Notifier();
    }

    // The order side that CLOSES the position described by a row.
    #closingSide(trade) {
        return trade.action === 'SELL_SHORT' ? 'buy' : 'sell';
    }

    // Reconstructs the real exit from Alpaca's order history: every filled
    // closing-side order at or after this row was opened. Summed rather than
    // taking the latest single order, so a position exited in partial fills
    // still resolves to one correct quantity and one weighted average price.
    async #resolveExit(trade) {
        const history = await this.broker.getOrderHistory(trade.symbol);
        const openedAt = new Date(trade.opened_at).getTime();
        const side = this.#closingSide(trade);

        const exits = history.filter(o =>
            o.side === side &&
            o.status === 'filled' &&
            o.filled_at &&
            o.filled_avg_price &&
            new Date(o.filled_at).getTime() >= openedAt
        );

        if (exits.length === 0) return null;

        let qty = 0;
        let notional = 0;
        for (const o of exits) {
            const q = parseInt(o.filled_qty, 10);
            const p = parseFloat(o.filled_avg_price);
            if (!Number.isFinite(q) || !Number.isFinite(p)) return null;
            qty += q;
            notional += q * p;
        }

        if (qty !== parseInt(trade.qty, 10)) {
            return { mismatch: true, qty };
        }

        return {
            mismatch: false,
            qty,
            sellPrice: parseFloat((notional / qty).toFixed(4)),
            closedAt: exits[exits.length - 1].filled_at
        };
    }

    #buildClose(trade, exit) {
        const buyPrice = parseFloat(trade.buy_price);
        const qty = parseInt(trade.qty, 10);
        // A short is profitable when it closes BELOW the entry, so the sign flips.
        const direction = trade.action === 'SELL_SHORT' ? -1 : 1;
        const netProfit = parseFloat(((exit.sellPrice - buyPrice) * qty * direction).toFixed(2));
        const marginPercentage = parseFloat(((((exit.sellPrice - buyPrice) / buyPrice) * 100) * direction).toFixed(2));

        return { trade, sellPrice: exit.sellPrice, netProfit, marginPercentage, closedAt: exit.closedAt };
    }

    async run({ dryRun = false } = {}) {
        await this.logger.log('==================================================');
        await this.logger.log(`🔁 POSITIONS SYNC (${dryRun ? 'DRY RUN' : 'APPLY'})`);
        await this.logger.log('==================================================');

        const report = { closed: [], stillOpen: [], flagged: [], untracked: [] };

        try {
            await this.db.connect();

            const livePositions = await this.broker.getPositions();
            const liveBySymbol = new Map(livePositions.map(p => [p.symbol, p]));

            const res = await this.db.client.query("SELECT * FROM trade_analytics WHERE status = 'OPEN' ORDER BY id");
            const openTrades = res.rows;

            await this.logger.log(`DB reports ${openTrades.length} OPEN row(s); Alpaca holds ${livePositions.length} position(s).`);

            for (const trade of openTrades) {
                const live = liveBySymbol.get(trade.symbol);

                if (live) {
                    // Still held. A qty drift means a partial exit we can't attribute
                    // to this row with confidence - flag it rather than guess.
                    if (parseInt(live.qty, 10) !== parseInt(trade.qty, 10)) {
                        report.flagged.push(trade.symbol);
                        await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is still held but qty differs (DB ${trade.qty} vs broker ${live.qty}). Needs manual review.`);
                    } else {
                        report.stillOpen.push(trade.symbol);
                    }
                    liveBySymbol.delete(trade.symbol);
                    continue;
                }

                // Broker is flat on this symbol, so the position is gone. Find out
                // for how much, from Alpaca's own record.
                const exit = await this.#resolveExit(trade);

                if (!exit) {
                    report.flagged.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is OPEN in the DB but absent from Alpaca, with no verifiable closing fill since ${trade.opened_at}. Needs manual review.`);
                    continue;
                }

                if (exit.mismatch) {
                    report.flagged.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) closing fills total ${exit.qty} shares but the row records ${trade.qty}. Needs manual review.`);
                    continue;
                }

                const closeItem = this.#buildClose(trade, exit);

                // Never let a corrupted buy_price write NaN/Infinity into the ledger.
                if (!Number.isFinite(closeItem.netProfit) || !Number.isFinite(closeItem.marginPercentage)) {
                    report.flagged.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) produced a non-finite net_profit/margin. Skipping. Needs manual review.`);
                    continue;
                }

                report.closed.push(closeItem);
                await this.logger.log(`Closing ${trade.symbol} (id=${trade.id}): ${trade.qty} @ $${trade.buy_price} -> $${closeItem.sellPrice} = net $${closeItem.netProfit} (${closeItem.marginPercentage}%)`);
            }

            // Anything Alpaca holds with no OPEN row. Never auto-inserted: a row
            // invented here would carry a guessed entry price, which is exactly the
            // class of bug this whole cleanup exists to remove.
            for (const symbol of liveBySymbol.keys()) {
                report.untracked.push(symbol);
                await this.logger.log(`⚠️ Alpaca holds ${symbol} with no OPEN row in trade_analytics. Needs manual review (not auto-inserted).`);
            }

            if (!dryRun && report.closed.length > 0) {
                for (const c of report.closed) {
                    await this.db.client.query(
                        `UPDATE trade_analytics
                         SET status = 'CLOSED', sell_price = $1, net_profit = $2, margin_percentage = $3, closed_at = $4
                         WHERE id = $5 AND status = 'OPEN'`,
                        [c.sellPrice, c.netProfit, c.marginPercentage, c.closedAt, c.trade.id]
                    );
                }

                const net = report.closed.reduce((sum, c) => sum + c.netProfit, 0);
                await this.logger.log(`✅ Synced ${report.closed.length} closed position(s). Net: $${net.toFixed(2)}. (Capital pots are settled by Settlement.js, not here.)`);
                await this.notifier.push(
                    'Positions Synced',
                    `${report.closed.length} position(s) closed by the broker are now CLOSED in the ledger. Net: $${net.toFixed(2)}.`,
                    'sync'
                );
            } else if (dryRun && report.closed.length > 0) {
                await this.logger.log(`DRY RUN: would close ${report.closed.length} row(s). Re-run without --dry-run to apply.`);
            } else {
                await this.logger.log('Ledger already matches the broker. Nothing to sync.');
            }

            if (report.flagged.length > 0 || report.untracked.length > 0) {
                await this.notifier.push(
                    '⚠️ Positions Sync Needs Review',
                    `Flagged: ${report.flagged.join(', ') || 'none'}. Untracked at broker: ${report.untracked.join(', ') || 'none'}.`,
                    'error'
                );
            }

            return report;
        } catch (err) {
            await this.logger.log(`[System Error]: ${err.stack}`);
            await this.notifier.push('Positions Sync Error', err.message, 'error');
            throw err;
        } finally {
            await this.db.disconnect();
        }
    }
}

// Execute (applies by default; pass --dry-run to preview)
if (require.main === module) {
    attachGlobalErrorLogger('PositionsSync');
    const dryRun = process.argv.includes('--dry-run');
    new PositionsSync().run({ dryRun }).catch(() => process.exit(1));
}

module.exports = PositionsSync;
