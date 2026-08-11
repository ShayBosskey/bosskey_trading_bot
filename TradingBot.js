const attachGlobalErrorLogger = require('./src/ErrorHandler');
attachGlobalErrorLogger('TradingBot');
const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');
const Notifier = require('./src/Notifier');
const { Client } = require('pg');

async function runTradingCycle() {
    console.log("--- INITIATING OOP TRADING BOT ---");
    const broker = new BrokerClient();
    const ai = new AIEngine();
    const dbClient = new DatabaseClient();
    const notifier = new Notifier();

    // Dedicated client for analytics logging
    const pgClient = new Client({
        user: process.env.DB_USER,
        host: process.env.DB_HOST,
        database: process.env.DB_NAME,
        password: process.env.DB_PASSWORD,
        port: process.env.DB_PORT,
    });

    try {
        await dbClient.connect();
        await pgClient.connect();
        
        const activeCapital = await dbClient.getActiveCapital();
        const cash = await broker.getCashBalance();
        
        console.log(`[System] Active Capital: $${activeCapital} | Broker Cash: $${cash}\n`);

        const marketData = await broker.scanMarketMovers();
        const decision = await ai.evaluateBatch(marketData, activeCapital);
        
        console.log("\n--- AI TRADE DECISION ---");
        console.log(`Next Action: ${decision.action} | Target: ${decision.target_symbol} | Confidence Score: ${decision.confidence_score} | Reasoning: ${decision.reasoning}`);
        
        if (decision.action === 'BUY' && decision.target_symbol !== 'NONE') {
            await notifier.push(
                "Bot Executing Trade", 
                `Buying ${decision.target_symbol}\nConfidence: ${decision.confidence_score}/100\nReason: ${decision.reasoning}`, 
                "chart_with_upwards_trend"
            );
            
            const tradeData = await broker.executeTrade(decision, marketData, activeCapital);
            
            // Log the entry to the analytics database
            if (tradeData && tradeData.executed) {
                await pgClient.query(`
                    INSERT INTO trade_analytics (symbol, buy_price, qty, status)
                    VALUES ($1, $2, $3, 'OPEN')
                `, [tradeData.symbol, tradeData.price, tradeData.qty]);
                console.log(`[System] Trade logged to analytics database.`);
            }
        } else {
            console.log("[System] Holding cash. No push notification required.");
        }
        
    } catch (error) {
        console.error("\n[System Error]:", error);
        await notifier.push("Trading Bot Error", error.message, "warning");
    } finally {
        await dbClient.disconnect();
        await pgClient.end();
    }
}

runTradingCycle();
