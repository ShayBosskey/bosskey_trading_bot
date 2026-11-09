const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
const Notifier = require('./Notifier');
const attachGlobalErrorLogger = require('./ErrorHandler');

class Settlement {
    constructor() {
        this.db = new DatabaseClient();
        this.logger = new Logger('Settlement');
        this.notifier = new Notifier();
    }

    async runDailySettlement() {
        await this.logger.log('==================================================');
        await this.logger.log('🏦 INITIATING DAILY BATCH SETTLEMENT');
        await this.logger.log('==================================================');

        let inTransaction = false;
        try {
            await this.db.connect();

            // 1. Sweep every CLOSED trade not yet settled - not "closed today". Crypto
            // closes 24/7 (weekends included) and a row can be closed with a back-dated
            // closed_at (WETO id 24), and a date filter silently misses both. The sweep,
            // the pot update and the settled_at stamp commit together or not at all,
            // and FOR UPDATE stops two overlapping runs from settling a row twice.
            await this.db.client.query('BEGIN');
            inTransaction = true;
            const res = await this.db.client.query(`
                SELECT * FROM trade_analytics
                WHERE status = 'CLOSED' AND settled_at IS NULL
                ORDER BY id
                FOR UPDATE
            `);

            const closedTrades = res.rows;

            if (closedTrades.length === 0) {
                await this.db.client.query('COMMIT');
                inTransaction = false;
                await this.logger.log('No unsettled closed trades. No settlement required.');
                await this.notifier.push(
                    "Daily Settlement Report",
                    "No positions were closed since the last settlement. Portfolio holding steady.",
                    "bank"
                );
                return;
            }

            // 2. Tally up the total profit/loss for the day.
            // A row with a missing net_profit (e.g. a manually-cleared ghost position)
            // must NOT be allowed to poison the whole day's math with NaN.
            let dailyNetProfit = 0;
            const skippedTrades = [];
            for (const trade of closedTrades) {
                const profit = parseFloat(trade.net_profit);
                if (Number.isFinite(profit)) {
                    dailyNetProfit += profit;
                } else {
                    skippedTrades.push(trade.symbol || trade.id);
                }
            }

            if (skippedTrades.length > 0) {
                await this.logger.log(`⚠️ Skipped ${skippedTrades.length} closed trade(s) with a missing/invalid net_profit (treated as $0): ${skippedTrades.join(', ')}`);
            }

            await this.logger.log(`Batch processed ${closedTrades.length} closed trades (${skippedTrades.length} skipped). Daily Net: $${dailyNetProfit.toFixed(2)}`);

            // Final guard: never let a non-finite figure reach the ledger.
            if (!Number.isFinite(dailyNetProfit)) {
                throw new Error(`Computed dailyNetProfit is not finite (${dailyNetProfit}). Aborting settlement without touching capital_pots.`);
            }

            // 3. Pot Distribution Logic
            let report;
            if (dailyNetProfit > 0) {
                // Winning Day: SHEFA's upgrade fund takes 20% of the day's net first,
                // then the remaining 80% is split 50/20/20/10 so the tax and emergency
                // vaults stay funded. A losing day gives the fund nothing.
                const shefaAddition = dailyNetProfit * 0.20;
                const distributable = dailyNetProfit - shefaAddition;
                const activeAddition = distributable * 0.50;
                const emergencyAddition = distributable * 0.20;
                const taxAddition = distributable * 0.20;
                const personalAddition = distributable * 0.10;

                await this.db.client.query(`
                    UPDATE capital_pots 
                    SET active_capital = active_capital + $1,
                        emergency_reserve = emergency_reserve + $2,
                        tax_vault = tax_vault + $3,
                        personal_payout = personal_payout + $4,
                        shefa_fund = shefa_fund + $5,
                        last_settled = CURRENT_TIMESTAMP
                    WHERE id = 1
                `, [activeAddition, emergencyAddition, taxAddition, personalAddition, shefaAddition]);

                await this.logger.log(`Profit distributed: 20% SHEFA Fund, then 80% split 50% Active, 20% Emergency, 20% Tax, 10% Personal.`);

                report = [
                    "🟢 Winning Day Settled!",
                    `Closed ${closedTrades.length} trades.\nNet Profit: +$${dailyNetProfit.toFixed(2)}\nSHEFA Fund: +$${shefaAddition.toFixed(2)}\nPersonal Payout Pot: +$${personalAddition.toFixed(2)}`
                ];

            } else {
                // Losing/Breakeven Day: Deduct the loss directly from Active Capital
                await this.db.client.query(`
                    UPDATE capital_pots 
                    SET active_capital = active_capital + $1,
                        last_settled = CURRENT_TIMESTAMP
                    WHERE id = 1
                `, [dailyNetProfit]); // dailyNetProfit is negative, so addition works as deduction

                await this.logger.log(`Loss recorded. Deducting $${Math.abs(dailyNetProfit).toFixed(2)} from Active Capital...`);

                report = [
                    "🔴 Losing Day Settled",
                    `Closed ${closedTrades.length} trades.\nNet Loss: -$${Math.abs(dailyNetProfit).toFixed(2)}\nDeducted from Active Capital.`
                ];
            }

            // Every swept row is stamped, including skipped ones (counted as $0), so
            // none is ever settled twice.
            await this.db.client.query(
                'UPDATE trade_analytics SET settled_at = NOW() WHERE id = ANY($1::int[])',
                [closedTrades.map(t => t.id)]
            );
            await this.db.client.query('COMMIT');
            inTransaction = false;

            await this.logger.log('✅ Database successfully updated.');
            // Pushed only after COMMIT, so a report never describes a rolled-back settlement.
            await this.notifier.push(report[0], report[1], "bank");

        } catch (err) {
            if (inTransaction) {
                await this.db.client.query('ROLLBACK').catch(() => {});
            }
            await this.logger.log(`[System Error]: ${err.stack}`);
            await this.notifier.push("Settlement Error", `${err.message}\nNothing was settled; the next run will retry.`, "error");
        } finally {
            await this.db.disconnect();
        }
    }
}

// Execute
if (require.main === module) {
    attachGlobalErrorLogger('Settlement');
    const settlement = new Settlement();
    settlement.runDailySettlement();
}

module.exports = Settlement;
