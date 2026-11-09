require('dotenv').config({ path: __dirname + '/.env'});
const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');
const Logger = require('./src/Logger');
const Notifier = require('./src/Notifier');
const Config = require('./src/Config');
const RiskEngine = require('./src/RiskEngine');
const Capacity = require('./src/Capacity');
const NewsClient = require('./src/NewsClient');
const attachGlobalErrorLogger = require('./src/ErrorHandler');

// Gap between symbol evaluations, keeping Gemini calls spread out under its
// requests-per-minute limit.
const SYMBOL_PACING_MS = 5000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Runs the Agent A -> Agent B debate for one candidate and trades it if approved.
// Returns the active capital left after any fill.
async function processCandidate(marketData, { aiEngine, broker, db, logger, notifier, activeCapital }) {
    const decision = await aiEngine.evaluateBatch(marketData, { activeCapital });

    await logger.log(`--- AI TRADE DECISION FOR ${marketData.symbol} ---`);
    await logger.log(`Action: ${decision.action} | Confidence: ${decision.confidence_score}`);
    await logger.log(`Reasoning: ${decision.reasoning}`);
    if (decision.debate?.proposal?.catalyst) {
        await logger.log(`[News] Sentiment: ${decision.debate.proposal.news_sentiment} | Catalyst: ${decision.debate.proposal.catalyst}`);
    }
    if (decision.debate?.audit) {
        await logger.log(`[Risk Auditor] Approved: ${decision.riskApproved} | Risk Score: ${decision.debate.audit.risk_score} | Notes: ${decision.debate.audit.audit_notes}`);
    }

    // Agent B (Risk Auditor) must explicitly approve before any capital is deployed.
    // The model's target_symbol must be the candidate it was shown. Headlines are
    // untrusted text in the prompt, so a model steered to name another ticker is a HOLD.
    if (decision.action === 'BUY' && decision.target_symbol !== 'NONE' && decision.target_symbol !== marketData.symbol) {
        await logger.log(`Trade blocked: agent named ${decision.target_symbol} while evaluating ${marketData.symbol}.`);
        return activeCapital;
    }

    if (decision.action === 'BUY' && decision.target_symbol !== 'NONE' && decision.riskApproved) {
        if (!(await Capacity.hasFreeSlot(db.client, 'equity'))) {
            await logger.log(`Trade for ${decision.target_symbol} skipped: equity book is full (${Capacity.LIMITS.equity} max).`);
            return activeCapital;
        }

        const { allocation: tradeAllocation } = RiskEngine.calculatePositionSize(activeCapital, decision.confidence_score, marketData.price);

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

        // The broker cancels an entry that doesn't fill, so there is no
        // position to record. Writing a row here anyway is what used to
        // put the ledger out of step with the account.
        if (!orderResult.filled) {
            await logger.log(`Entry for ${decision.target_symbol} did not fill (status: ${orderResult.status}). Order cancelled, nothing recorded.`);
            return activeCapital;
        }

        // buy_price MUST be Alpaca's real filled_avg_price. Logging the
        // screener's quote instead is what generated the fabricated P&L
        // (e.g. the -$2,454.01 reconciliation) - real sells were being
        // measured against prices we never actually paid.
        await db.client.query(
            `INSERT INTO trade_analytics (symbol, action, qty, buy_price, status)
             VALUES ($1, $2, $3, $4, 'OPEN')`,
            [decision.target_symbol, decision.action, orderResult.qty, orderResult.filled_avg_price]
        );

        await logger.log(`Trade successfully executed and logged for ${decision.target_symbol}.`);
        await notifier.push(
            "Bot Executing Trade",
            `Purchased ${orderResult.qty} shares of ${decision.target_symbol} at $${orderResult.filled_avg_price}\nTarget: $${stops.takeProfitPrice.toFixed(2)}\nStop: $${stops.stopLossPrice.toFixed(2)}`,
            "buy"
        );

        return activeCapital - (orderResult.qty * orderResult.filled_avg_price);
    } else if (decision.action === 'BUY' && decision.target_symbol !== 'NONE' && !decision.riskApproved) {
        await logger.log(`Trade blocked: Risk Auditor did not approve ${marketData.symbol}.`);
    } else {
        await logger.log(`Executing HOLD strategy for ${marketData.symbol}.`);
    }

    return activeCapital;
}

async function runTradingCycle() {
    const logger = new Logger('TradingBot');
    const db = new DatabaseClient();
    const notifier = new Notifier();

    await logger.log('==================================================');
    await logger.log('🚀 SHEFA EQUITIES CYCLE (OCO BRACKET ARCHITECTURE)');
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

        // This loop trades equities only; crypto has its own 24/7 loop and slots.
        const { heldSymbols, open: openPositions, max: maxPositions, available: neededSlots } =
            await Capacity.getCapacity(db.client, 'equity');

        await logger.log(`System currently holding ${openPositions}/${maxPositions} active equity positions.`);

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
        const newsClient = new NewsClient();
        const failedSymbols = [];

        for (const [index, marketData] of marketDataArray.entries()) {
            if (index > 0) await sleep(SYMBOL_PACING_MS);

            // One bad symbol (unparseable AI reply, broker rejection) must not abort
            // the remaining candidates, so each is isolated.
            try {
                // Never throws; on a news outage the agents are told the feed is down.
                marketData.news = await newsClient.getContext(marketData.symbol);
                await logger.log(`[News] ${marketData.symbol}: ${marketData.news.symbol.length} symbol / ${marketData.news.macro.length} macro headline(s)${marketData.news.available ? '' : ' (feed unavailable)'}.`);
                activeCapital = await processCandidate(marketData, { aiEngine, broker, db, logger, notifier, activeCapital });
            } catch (err) {
                failedSymbols.push(marketData.symbol);
                await logger.log(`[Symbol Error] ${marketData.symbol} skipped: ${err.stack}`);
            }
        }

        if (failedSymbols.length > 0) {
            await notifier.push(
                "⚠️ Trading Bot: Symbols Skipped",
                `${failedSymbols.length}/${marketDataArray.length} candidate(s) errored and were skipped: ${failedSymbols.join(', ')}. See execution.log.`,
                "error"
            );
        }

    } catch (err) {
        await logger.log(`[System Error]: ${err.stack}`);
        await notifier.push("⚠️ Trading Bot Error", err.message, "error");
    } finally {
        await db.disconnect();
    }
}

attachGlobalErrorLogger('TradingBot');
runTradingCycle();
