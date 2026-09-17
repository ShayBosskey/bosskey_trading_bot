const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const BrokerClient = require('./BrokerClient');
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
const Notifier = require('./Notifier');

// Reconciles trade_analytics against Alpaca's live account state. Two passes:
//
// 1. Stale-OPEN pass: a row marked OPEN for a symbol Alpaca no longer holds at
//    all is closed using Alpaca's own order history for the real fill.
// 2. Ghost-row pass: a row marked CLOSED with no sell_price on record (the
//    signature of a past manual "ghost position" cleanup, or of the historical
//    NaN-corruption bug) is repaired with Alpaca's real order history - either
//    a real closing fill (repair with real numbers) or a still-open position
//    (reopen it) - but ONLY when that symbol has exactly one row anywhere in
//    trade_analytics. A symbol with multiple historical rows can't be safely
//    attributed to a single lot (Alpaca's average-cost accounting doesn't
//    preserve which buy a given remaining share came from), so it is always
//    left flagged for manual review rather than guessed at.
//
// Nothing is ever deleted: every row this system has ever written corresponds
// to a real order Alpaca actually executed, so the correct fix is always to
// repair the row with verified data, never to remove it.
class Reconciliation {
    constructor() {
        this.broker = new BrokerClient();
        this.db = new DatabaseClient();
        this.logger = new Logger('Reconciliation');
        this.notifier = new Notifier();
    }

    async #findResolvableClose(trade) {
        const closingSide = trade.action === 'SELL_SHORT' ? 'buy' : 'sell';
        const fill = await this.broker.getLastFilledOrder(trade.symbol, closingSide);
        if (!fill) return null; // no verifiable close on record - flag, don't guess

        return this.#buildClose(trade, fill);
    }

    #buildClose(trade, fill) {
        const buyPrice = parseFloat(trade.buy_price);
        const sellPrice = parseFloat(fill.filled_avg_price);
        const qty = trade.qty;
        const netProfit = parseFloat(((sellPrice - buyPrice) * qty).toFixed(2));
        const marginPercentage = parseFloat((((sellPrice - buyPrice) / buyPrice) * 100).toFixed(2));

        return {
            trade,
            sellPrice,
            netProfit,
            marginPercentage,
            closedAt: fill.filled_at
        };
    }

    // Ghost rows: CLOSED with no sell_price recorded - the shared signature of
    // both the 2026-09-02 manual "ghost cleanup" (net_profit fabricated to 0)
    // and the older raw-NaN corruption bug (net_profit NULL). Only resolved
    // when the symbol has exactly one row in the whole table.
    async #resolveGhostRows(liveBySymbol) {
        const resolvedCloses = [];
        const reopened = [];
        const flagged = [];

        const ghostRes = await this.db.client.query(
            "SELECT * FROM trade_analytics WHERE status = 'CLOSED' AND sell_price IS NULL"
        );

        for (const trade of ghostRes.rows) {
            const countRes = await this.db.client.query(
                'SELECT COUNT(*)::int AS count FROM trade_analytics WHERE symbol = $1',
                [trade.symbol]
            );

            if (countRes.rows[0].count > 1) {
                flagged.push(trade.symbol);
                await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is a fabricated ghost-closure row, but ${trade.symbol} has multiple historical rows in trade_analytics — cannot be safely attributed to a single lot. Needs manual review.`);
                continue;
            }

            const history = await this.broker.getOrderHistory(trade.symbol);
            const filledBuys = history.filter(o => o.side === 'buy' && o.status === 'filled');
            const filledSells = history.filter(o => o.side === 'sell' && o.status === 'filled');

            if (filledBuys.length !== 1) {
                flagged.push(trade.symbol);
                await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) has ${filledBuys.length} filled buy orders on record — cannot uniquely attribute this row. Needs manual review.`);
                continue;
            }

            if (filledSells.length === 1) {
                resolvedCloses.push(this.#buildClose(trade, filledSells[0]));
            } else if (filledSells.length === 0 && liveBySymbol.has(trade.symbol)) {
                const live = liveBySymbol.get(trade.symbol);
                if (parseInt(live.qty, 10) === parseInt(trade.qty, 10)) {
                    reopened.push(trade);
                    liveBySymbol.delete(trade.symbol);
                } else {
                    flagged.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is live on Alpaca but qty doesn't match (DB ${trade.qty} vs live ${live.qty}). Needs manual review.`);
                }
            } else {
                flagged.push(trade.symbol);
                await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) has an inconclusive order history (${filledSells.length} filled sells, not live on Alpaca). Needs manual review.`);
            }
        }

        return { resolvedCloses, reopened, flagged };
    }

    async run({ dryRun = true } = {}) {
        await this.logger.log('==================================================');
        await this.logger.log(`🔄 POSITION RECONCILIATION (${dryRun ? 'DRY RUN' : 'APPLY'})`);
        await this.logger.log('==================================================');

        const report = {
            resolvedCloses: [], stillOpen: [], unresolvedGaps: [],
            untrackedBrokerPositions: [], reopened: [], flaggedGhostRows: []
        };

        try {
            await this.db.connect();

            const livePositions = await this.broker.getPositions();
            const liveBySymbol = new Map(livePositions.map(p => [p.symbol, p]));

            const res = await this.db.client.query("SELECT * FROM trade_analytics WHERE status = 'OPEN'");
            const openTrades = res.rows;

            for (const trade of openTrades) {
                const live = liveBySymbol.get(trade.symbol);
                if (live) {
                    report.stillOpen.push(trade.symbol);
                    liveBySymbol.delete(trade.symbol);
                    continue;
                }

                const countRes = await this.db.client.query(
                    'SELECT COUNT(*)::int AS count FROM trade_analytics WHERE symbol = $1',
                    [trade.symbol]
                );

                if (countRes.rows[0].count > 1) {
                    report.unresolvedGaps.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is OPEN in the DB but absent from Alpaca, and ${trade.symbol} has multiple historical rows in trade_analytics — cannot be safely attributed to a single lot. Needs manual review.`);
                    continue;
                }

                const resolved = await this.#findResolvableClose(trade);
                if (resolved) {
                    report.resolvedCloses.push(resolved);
                } else {
                    report.unresolvedGaps.push(trade.symbol);
                    await this.logger.log(`⚠️ ${trade.symbol} (id=${trade.id}) is OPEN in the DB but absent from Alpaca with no verifiable closing fill. Needs manual review.`);
                }
            }

            const ghostResult = await this.#resolveGhostRows(liveBySymbol);
            report.resolvedCloses.push(...ghostResult.resolvedCloses);
            report.reopened.push(...ghostResult.reopened);
            report.flaggedGhostRows.push(...ghostResult.flagged);

            // Anything Alpaca holds that never appears in our OPEN set, and was not
            // just claimed by the ghost-row pass above (e.g. WEAV/SDOT reopening).
            for (const symbol of liveBySymbol.keys()) {
                report.untrackedBrokerPositions.push(symbol);
                await this.logger.log(`⚠️ Alpaca holds ${symbol} but it has no OPEN row in trade_analytics. Needs manual review (not auto-inserted).`);
            }

            // A close with a non-finite net_profit/margin_percentage (e.g. a corrupted
            // buy_price on an old row) must NOT be written to trade_analytics or allowed
            // to poison totalNetProfit with NaN/Infinity.
            const validCloses = [];
            for (const closeItem of report.resolvedCloses) {
                if (Number.isFinite(closeItem.netProfit) && Number.isFinite(closeItem.marginPercentage)) {
                    validCloses.push(closeItem);
                } else {
                    report.unresolvedGaps.push(closeItem.trade.symbol);
                    await this.logger.log(`⚠️ ${closeItem.trade.symbol} (id=${closeItem.trade.id}) produced a non-finite net_profit/margin_percentage — skipping this close. Needs manual review.`);
                }
            }
            report.resolvedCloses = validCloses;

            let totalNetProfit = 0;
            for (const closeItem of report.resolvedCloses) {
                await this.logger.log(
                    `Reconciled close: ${closeItem.trade.symbol} (id=${closeItem.trade.id}) sold @ $${closeItem.sellPrice} ` +
                    `-> net $${closeItem.netProfit} (verified via Alpaca order history)`
                );
                totalNetProfit += closeItem.netProfit;
            }
            for (const trade of report.reopened) {
                await this.logger.log(`Reopening: ${trade.symbol} (id=${trade.id}) is still a live Alpaca position; the CLOSED status was fabricated. Reverting to OPEN.`);
            }

            if (!Number.isFinite(totalNetProfit)) {
                throw new Error(`Computed totalNetProfit is not finite (${totalNetProfit}). Aborting reconciliation without touching capital_pots.`);
            }

            if (!dryRun) {
                for (const closeItem of report.resolvedCloses) {
                    await this.db.client.query(
                        `UPDATE trade_analytics
                         SET status = 'CLOSED', sell_price = $1, net_profit = $2, margin_percentage = $3, closed_at = $4
                         WHERE id = $5`,
                        [closeItem.sellPrice, closeItem.netProfit, closeItem.marginPercentage, closeItem.closedAt, closeItem.trade.id]
                    );
                }

                for (const trade of report.reopened) {
                    await this.db.client.query(
                        `UPDATE trade_analytics
                         SET status = 'OPEN', sell_price = NULL, net_profit = NULL, margin_percentage = NULL, closed_at = NULL
                         WHERE id = $1`,
                        [trade.id]
                    );
                }

                // Same pot-distribution rule Settlement.js applies for a day's net result,
                // applied here once for the trades this run newly resolved.
                if (totalNetProfit > 0) {
                    const activeAddition = totalNetProfit * 0.50;
                    const emergencyAddition = totalNetProfit * 0.20;
                    const taxAddition = totalNetProfit * 0.20;
                    const personalAddition = totalNetProfit * 0.10;

                    await this.db.client.query(
                        `UPDATE capital_pots
                         SET active_capital = active_capital + $1,
                             emergency_reserve = emergency_reserve + $2,
                             tax_vault = tax_vault + $3,
                             personal_payout = personal_payout + $4,
                             last_settled = CURRENT_TIMESTAMP
                         WHERE id = 1`,
                        [activeAddition, emergencyAddition, taxAddition, personalAddition]
                    );
                } else if (totalNetProfit < 0) {
                    await this.db.client.query(
                        `UPDATE capital_pots SET active_capital = active_capital + $1, last_settled = CURRENT_TIMESTAMP WHERE id = 1`,
                        [totalNetProfit]
                    );
                }

                if (report.resolvedCloses.length > 0 || report.reopened.length > 0) {
                    await this.logger.log(`✅ Applied ${report.resolvedCloses.length} reconciled close(s) and ${report.reopened.length} reopen(s). Net: $${totalNetProfit.toFixed(2)}.`);
                    await this.notifier.push(
                        'Reconciliation Applied',
                        `Closed ${report.resolvedCloses.length} trade(s), reopened ${report.reopened.length}, using verified Alpaca data. Net: $${totalNetProfit.toFixed(2)}.`,
                        'sync'
                    );
                } else {
                    await this.logger.log('No auto-resolvable discrepancies found.');
                }
            } else if (report.resolvedCloses.length > 0 || report.reopened.length > 0) {
                await this.logger.log(`DRY RUN: would close ${report.resolvedCloses.length} trade(s) (net $${totalNetProfit.toFixed(2)}) and reopen ${report.reopened.length} trade(s). Re-run with dryRun: false to apply.`);
            } else {
                await this.logger.log('No auto-resolvable discrepancies found.');
            }

            return report;
        } catch (err) {
            await this.logger.log(`[System Error]: ${err.stack}`);
            await this.notifier.push('Reconciliation Error', err.message, 'error');
            throw err;
        } finally {
            await this.db.disconnect();
        }
    }
}

// Execute (defaults to dry run; pass --apply to write changes)
if (require.main === module) {
    const dryRun = !process.argv.includes('--apply');
    const reconciliation = new Reconciliation();
    reconciliation.run({ dryRun }).catch(() => process.exit(1));
}

module.exports = Reconciliation;
