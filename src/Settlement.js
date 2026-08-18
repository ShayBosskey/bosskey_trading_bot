require('dotenv').config({ path: '../.env' });
const DatabaseClient = require('./DatabaseClient');
const Logger = require('./Logger');
const Notifier = require('./Notifier');

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

        try {
            await this.db.connect();

            // 1. Find ALL trades that were closed today
            // Using PostgreSQL DATE() function to match today's date
            const res = await this.db.client.query(`
                SELECT * FROM trade_analytics 
                WHERE status = 'CLOSED' 
                AND DATE(closed_at AT TIME ZONE 'Europe/Zurich') = CURRENT_DATE
            `);
            
            const closedTrades = res.rows;

            if (closedTrades.length === 0) {
                await this.logger.log('No trades were closed today. No settlement required.');
                await this.notifier.push(
                    "Daily Settlement Report", 
                    "No positions were closed today. Portfolio holding steady.", 
                    "bank"
                );
                return;
            }

            // 2. Tally up the total profit/loss for the day
            let dailyNetProfit = 0;
            for (const trade of closedTrades) {
                dailyNetProfit += parseFloat(trade.net_profit);
            }

            await this.logger.log(`Batch processed ${closedTrades.length} closed trades. Daily Net: $${dailyNetProfit.toFixed(2)}`);

            // 3. Pot Distribution Logic
            if (dailyNetProfit > 0) {
                // Winning Day: Distribute the profits across the pots
                const activeAddition = dailyNetProfit * 0.50;
                const emergencyAddition = dailyNetProfit * 0.20;
                const taxAddition = dailyNetProfit * 0.20;
                const personalAddition = dailyNetProfit * 0.10;

                await this.db.client.query(`
                    UPDATE capital_pots 
                    SET active_capital = active_capital + $1,
                        emergency_reserve = emergency_reserve + $2,
                        tax_vault = tax_vault + $3,
                        personal_payout = personal_payout + $4,
                        last_settled = CURRENT_TIMESTAMP
                    WHERE id = 1
                `, [activeAddition, emergencyAddition, taxAddition, personalAddition]);

                await this.logger.log(`Profit distributed: 50% Active, 20% Emergency, 20% Tax, 10% Personal.`);
                
                await this.notifier.push(
                    "🟢 Winning Day Settled!", 
                    `Closed ${closedTrades.length} trades.\nNet Profit: +$${dailyNetProfit.toFixed(2)}\nPersonal Payout Pot: +$${personalAddition.toFixed(2)}`, 
                    "bank"
                );

            } else {
                // Losing/Breakeven Day: Deduct the loss directly from Active Capital
                await this.db.client.query(`
                    UPDATE capital_pots 
                    SET active_capital = active_capital + $1,
                        last_settled = CURRENT_TIMESTAMP
                    WHERE id = 1
                `, [dailyNetProfit]); // dailyNetProfit is negative, so addition works as deduction

                await this.logger.log(`Loss recorded. Deducting $${Math.abs(dailyNetProfit).toFixed(2)} from Active Capital...`);
                
                await this.notifier.push(
                    "🔴 Losing Day Settled", 
                    `Closed ${closedTrades.length} trades.\nNet Loss: -$${Math.abs(dailyNetProfit).toFixed(2)}\nDeducted from Active Capital.`, 
                    "bank"
                );
            }

            await this.logger.log('✅ Database successfully updated.');

        } catch (err) {
            await this.logger.log(`[System Error]: ${err.stack}`);
            await this.notifier.push("Settlement Error", err.message, "error");
        } finally {
            await this.db.disconnect();
        }
    }
}

// Execute
if (require.main === module) {
    const settlement = new Settlement();
    settlement.runDailySettlement();
}

module.exports = Settlement;
