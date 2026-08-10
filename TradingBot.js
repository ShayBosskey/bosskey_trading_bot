const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');

async function runTradingCycle() {
    console.log("--- INITIATING OOP TRADING BOT ---");
    const broker = new BrokerClient();
    const ai = new AIEngine();
    const db = new DatabaseClient();

    try {
        await db.connect();
        
        // Dynamically fetch capital from PostgreSQL
        const activeCapital = await db.getActiveCapital();
        const cash = await broker.getCashBalance();
        
        console.log(`[System] Active Capital: $${activeCapital} | Broker Cash: $${cash}\n`);

        const marketData = await broker.scanMarketMovers();
        const decision = await ai.evaluateBatch(marketData, activeCapital);
        
        console.log("\n--- AI TRADE DECISION ---");
        console.log(`Next Action: ${decision.action} | Target: ${decision.target_symbol} | Confidence Score: ${decision.confidence_score} | Reasoning: ${decision.reasoning}`);
        
    } catch (error) {
        console.error("\n[System Error]:", error);
    } finally {
        // Always close the database connection, even if the AI fails
        await db.disconnect();
    }
}

runTradingCycle();
