require('dotenv').config({ path: '../.env' });
const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');
const Logger = require('./src/Logger');
const Notifier = require('./src/Notifier');

async function runTradingCycle() {
    const logger = new Logger('TradingBot');
    const db = new DatabaseClient();
    const notifier = new Notifier();
    
    await logger.log('==================================================');
    await logger.log('🚀 INITIATING OOP TRADING BOT (DYNAMIC MULTI-FILL)');
    await logger.log('==================================================');

    try {
        await db.connect();

        // 1. Check Portfolio Capacity and extract currently held symbols
        const res = await db.client.query("SELECT symbol FROM trade_analytics WHERE status = 'OPEN'");
        const heldSymbols = res.rows.map(row => row.symbol);
        const openPositions = heldSymbols.length;
        const MAX_POSITIONS = 5;
        const neededSlots = MAX_POSITIONS - openPositions;

        await logger.log(`System currently holding ${openPositions}/${MAX_POSITIONS} active positions.`);

        if (neededSlots <= 0) {
            await logger.log('Portfolio is at maximum capacity. Standing down.');
            return;
        }

        // 2. Fetch Active Capital
        let activeCapital = parseFloat(await db.getActiveCapital());
        await logger.log(`Active Capital Available: $${activeCapital.toFixed(2)}`);

        // 3. Scan the Market for multiple setups
        const broker = new BrokerClient();
        const marketDataArray = await broker.scanMarketMovers(heldSymbols, neededSlots);

        if (marketDataArray.length === 0) {
            await logger.log('No valid setups found in the market right now.');
            return;
        }

        // 4. Evaluate and Execute in a loop
        const aiEngine = new AIEngine();

        for (const marketData of marketDataArray) {
            const decision = await aiEngine.evaluateBatch(marketData);

            await logger.log(`--- AI TRADE DECISION FOR ${marketData.symbol} ---`);
            await logger.log(`Action: ${decision.action} | Confidence: ${decision.confidence_score}`);
            await logger.log(`Reasoning: ${decision.reasoning}`);

            if (decision.action === 'BUY' && decision.target_symbol !== 'NONE') {
                const baseFraction = decision.confidence_score / 100;
                // Risk 15% of the REMAINING active capital per slot
                const tradeAllocation = activeCapital * (baseFraction * 0.15); 
                
                await logger.log(`[Risk Manager] Allocating $${tradeAllocation.toFixed(2)} to ${decision.target_symbol}.`);
                
                const orderResult = await broker.executeBuyOrder(decision.target_symbol, tradeAllocation, marketData.price);
                
                await db.client.query(
                    `INSERT INTO trade_analytics (symbol, action, qty, buy_price, status) 
                     VALUES ($1, $2, $3, $4, 'OPEN')`,
                    [decision.target_symbol, decision.action, orderResult.qty, orderResult.filled_avg_price]
                );

                // Deduct from local tracking variable so the next loop has accurate capital math
                activeCapital -= (orderResult.qty * orderResult.filled_avg_price);

                await logger.log(`Trade successfully executed and logged for ${decision.target_symbol}.`);
                await notifier.push(
                    "Bot Executing Trade", 
                    `Purchased ${orderResult.qty} shares of ${decision.target_symbol} at $${orderResult.filled_avg_price}`, 
                    "buy"
                );
            } else {
                await logger.log(`Executing HOLD strategy for ${marketData.symbol}.`);
            }
        }

    } catch (err) {
        await logger.log(`[System Error]: ${err.stack}`);
        await notifier.push("⚠️ Trading Bot Error", err.message, "error");
    } finally {
        await db.disconnect();
    }
}

runTradingCycle();
