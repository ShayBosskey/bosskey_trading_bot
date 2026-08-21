require('dotenv').config({ path: '../.env' });
const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');
const Logger = require('./src/Logger');
const Notifier = require('./src/Notifier');
const Config = require('./src/Config');
const RiskEngine = require('./src/RiskEngine');

async function runTradingCycle() {
    const logger = new Logger('TradingBot');
    const db = new DatabaseClient();
    const notifier = new Notifier();
    
    await logger.log('==================================================');
    await logger.log('🚀 INITIATING OOP TRADING BOT (OCO BRACKET ARCHITECTURE)');
    await logger.log('==================================================');

    const systemMode = Config.getMode();
    await logger.log(`System Initializing in [${systemMode}] Mode.`);
    
    if (!Config.isTradingAllowed()) {
        await logger.log('Trading is DISABLED in Construction Mode. Standing down.');
        await notifier.push("System Alert", "Bot attempted to run but is locked in Construction Mode.", "shield");
        return;
    }

    try {
        await db.connect();

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

        let activeCapital = parseFloat(await db.getActiveCapital());
        await logger.log(`Active Capital Available: $${activeCapital.toFixed(2)}`);

        const broker = new BrokerClient();
        const marketDataArray = await broker.scanMarketMovers(heldSymbols, neededSlots);

        if (marketDataArray.length === 0) {
            await logger.log('No valid setups found in the market right now.');
            return;
        }

        const aiEngine = new AIEngine();

        for (const marketData of marketDataArray) {
            const decision = await aiEngine.evaluateBatch(marketData);

            await logger.log(`--- AI TRADE DECISION FOR ${marketData.symbol} ---`);
            await logger.log(`Action: ${decision.action} | Confidence: ${decision.confidence_score}`);
            await logger.log(`Reasoning: ${decision.reasoning}`);

            if (decision.action === 'BUY' && decision.target_symbol !== 'NONE') {
                const baseFraction = decision.confidence_score / 100;
                const tradeAllocation = activeCapital * (baseFraction * 0.15); 
                
                // === DYNAMIC RISK CALCULATION ===
                const atr = RiskEngine.calculateATR(marketData.rawBars, 14);
                const stops = RiskEngine.calculateDynamicStops(marketData.price, atr);

                await logger.log(`[Risk Manager] Allocating $${tradeAllocation.toFixed(2)} to ${decision.target_symbol}.`);
                await logger.log(`[Risk Manager] ATR = $${atr.toFixed(2)}. Setting dynamic bracket -> SL: $${stops.stopLossPrice.toFixed(2)} | TP: $${stops.takeProfitPrice.toFixed(2)}`);
                
                // Pass the absolute stop prices directly to the broker
                const orderResult = await broker.executeBuyOrder(
                    decision.target_symbol, 
                    tradeAllocation, 
                    marketData.price, 
                    stops.takeProfitPrice, 
                    stops.stopLossPrice
                );
                
                await db.client.query(
                    `INSERT INTO trade_analytics (symbol, action, qty, buy_price, status) 
                     VALUES ($1, $2, $3, $4, 'OPEN')`,
                    [decision.target_symbol, decision.action, orderResult.qty, orderResult.filled_avg_price]
                );

                activeCapital -= (orderResult.qty * orderResult.filled_avg_price);

                await logger.log(`Trade successfully executed and logged for ${decision.target_symbol}.`);
                await notifier.push(
                    "Bot Executing Trade", 
                    `Purchased ${orderResult.qty} shares of ${decision.target_symbol} at $${orderResult.filled_avg_price}\nTarget: $${stops.takeProfitPrice.toFixed(2)}\nStop: $${stops.stopLossPrice.toFixed(2)}`, 
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
