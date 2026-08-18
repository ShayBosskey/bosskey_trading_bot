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
    await logger.log('🚀 INITIATING OOP TRADING BOT (MULTI-SLOT ARCHITECTURE)');
    await logger.log('==================================================');

    try {
        await db.connect();

        // 1. Check Portfolio Capacity (The 5-Slot Limit)
        const slotCheck = await db.client.query("SELECT COUNT(*) FROM trade_analytics WHERE status = 'OPEN'");
        const openPositions = parseInt(slotCheck.rows[0].count);
        const MAX_POSITIONS = 5;

        await logger.log(`System currently holding ${openPositions}/${MAX_POSITIONS} active positions.`);

        if (openPositions >= MAX_POSITIONS) {
            await logger.log('Portfolio is at maximum capacity. Standing down to allow Liquidator to manage open trades.');
            return; // Exit the script gracefully. No buying today.
        }

        // 2. Fetch Active Capital
        const activeCapital = await db.getActiveCapital();
        await logger.log(`Active Capital Available: $${activeCapital}`);

        // 3. Scan the Market (Broker)
        const broker = new BrokerClient();
        const marketData = await broker.scanMarketMovers();

        if (marketData.symbol === 'NONE') {
            await logger.log('No valid setups found in the market today.');
            return;
        }

        // 4. AI Evaluation
        const aiEngine = new AIEngine();
        const decision = await aiEngine.evaluateBatch(marketData);

        await logger.log(`--- AI TRADE DECISION ---`);
        await logger.log(`Action: ${decision.action} | Target: ${decision.target_symbol} | Confidence: ${decision.confidence_score}`);
        await logger.log(`Reasoning: ${decision.reasoning}`);

        // 5. Execution
        if (decision.action === 'BUY' && decision.target_symbol !== 'NONE') {
            
            // Kelly Criterion Math (Dynamically scales based on remaining capital and AI confidence)
            const baseFraction = decision.confidence_score / 100;
            const tradeAllocation = activeCapital * (baseFraction * 0.15); // Risking max 15% of active capital per slot
            
            await logger.log(`[Risk Manager] AI Confidence: ${decision.confidence_score}%. Allocating $${tradeAllocation.toFixed(2)} to this slot.`);
            
            // Execute the trade via Alpaca
            const orderResult = await broker.executeBuyOrder(decision.target_symbol, tradeAllocation);
            
            // Log to Database (opened_at is automatically set by our new PostgreSQL schema)
            await db.client.query(
                `INSERT INTO trade_analytics (symbol, action, qty, buy_price, status) 
                 VALUES ($1, $2, $3, $4, 'OPEN')`,
                [decision.target_symbol, 'BUY', orderResult.qty, orderResult.filled_avg_price]
            );

            await logger.log(`Trade securely logged to database analytics.`);
            await notifier.push(
                "Bot Executing Trade", 
                `Purchased ${orderResult.qty} shares of ${decision.target_symbol} at $${orderResult.filled_avg_price}`, 
                "buy"
            );

        } else {
            await logger.log(`Executing HOLD strategy. Target did not meet breakout criteria.`);
            // Only notify on a hold if you want to know it actively rejected a specific stock
            await notifier.push(
                "Bot Holding Position", 
                `Action: HOLD\nConfidence: ${decision.confidence_score}/100\nReason: ${decision.reasoning}`, 
                "shield"
            );
        }

    } catch (err) {
        await logger.log(`[System Error]: ${err.stack}`);
        await notifier.push("Trading Bot Error", err.message, "error");
    } finally {
        await db.disconnect();
    }
}

// Execute
runTradingCycle();
