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
        
        if ((decision.action === 'BUY' || decision.action === 'SELL_SHORT') && decision.target_symbol !== 'NONE') {
            
            // --- DYNAMIC POSITION SIZING (KELLY CRITERION) ---
            const p = decision.confidence_score / 100;
            
            // Only calculate if confidence is above 50%
            if (p > 0.5) {
                const kellyFraction = (2 * p) - 1;
                const maxRiskPercentage = 0.02; // Absolute max risk is 2% of Active Capital
                
                // Calculate the exact dollar amount to risk
                const dynamicRiskAmount = activeCapital * maxRiskPercentage * kellyFraction;
                
                console.log(`[Risk Manager] AI Confidence: ${decision.confidence_score}%. Applying Kelly Fraction: ${kellyFraction.toFixed(2)}`);
                console.log(`[Risk Manager] Dynamically allocating $${dynamicRiskAmount.toFixed(2)} to this trade.`);

                await notifier.push(
                	"Bot Executing Trade", 
                	`Action: ${decision.action}\nTarget: ${decision.target_symbol}\nConfidence: ${decision.confidence_score}/100\nRisk: $${dynamicRiskAmount.toFixed(2)}`, 
                	decision.action === 'BUY' ? "chart_with_upwards_trend" : "chart_with_downwards_trend"
            	);
                
                // Pass the dynamic risk amount to your broker execution function
                const tradeData = await broker.executeTrade(decision, marketData, dynamicRiskAmount);
                
                if (tradeData && tradeData.executed) {
                    await pgClient.query(`
                        INSERT INTO trade_analytics (symbol, buy_price, qty, status)
                        VALUES ($1, $2, $3, 'OPEN')
                    `, [tradeData.symbol, tradeData.price, tradeData.qty]);
                    console.log(`[System] Trade logged to analytics database.`);
                }
            } else {
                console.log("[System] Confidence too low (<50%) to justify capital risk.");
            }
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
