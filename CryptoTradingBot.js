require('dotenv').config({ path: __dirname + '/.env' });
const fs = require('fs');
const BrokerClient = require('./src/BrokerClient');
const AIEngine = require('./src/AIEngine');
const DatabaseClient = require('./src/DatabaseClient');
const Logger = require('./src/Logger');
const Notifier = require('./src/Notifier');
const Config = require('./src/Config');
const RiskEngine = require('./src/RiskEngine');
const Capacity = require('./src/Capacity');
const Cooldown = require('./src/Cooldown');
const NewsClient = require('./src/NewsClient');
const { HEARTBEAT_FILE } = require('./src/CryptoExitEngine');
const attachGlobalErrorLogger = require('./src/ErrorHandler');

// SHEFA's crypto entry cycle. One run = one scan, so it can be scheduled 24/7
// (cron or PM2 cron_restart) independently of the US-hours equities loop.
// Exits are NOT handled here: CryptoExitEngine enforces the stop/target written
// on each row, which is why entries refuse to run without its heartbeat.

const SYMBOL_PACING_MS = 5000;
const HEARTBEAT_MAX_AGE_MS = 2 * 60 * 1000;
// Take-profit distance must be at least this multiple of the round-trip cost.
const MIN_REWARD_TO_COST = 3;
// The position may use at most this share of bid depth within 1% of mid.
const MAX_DEPTH_SHARE = 0.5;
// Largest position the sizing rule can produce (100 confidence x 15%).
const MAX_ALLOCATION_FRACTION = 0.15;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Returns null when the exit engine is protecting positions, else the reason not to trade.
function exitEngineProblem() {
    let beat;
    try {
        beat = JSON.parse(fs.readFileSync(HEARTBEAT_FILE, 'utf8'));
    } catch {
        return 'no heartbeat file (is crypto-exit-engine running under PM2?)';
    }
    const ageMs = Date.now() - new Date(beat.at).getTime();
    if (!(ageMs <= HEARTBEAT_MAX_AGE_MS)) return `heartbeat is ${Math.round(ageMs / 1000)}s old`;
    if (beat.dryRun) return 'exit engine is in dry-run mode and would not sell';
    return null;
}

// Deterministic gates applied after the agents approve. The agents judge these too,
// but a model's approval never overrides a hard limit.
function hardGateFailure(setup, position) {
    if (!Number.isFinite(setup.atr_1h) || setup.atr_1h <= 0) return 'no usable ATR';
    if (position.qty < setup.min_order_size) return `qty ${position.qty} below minimum order size ${setup.min_order_size}`;

    const stops = RiskEngine.calculateDynamicStops(setup.price, setup.atr_1h);
    const targetPct = (stops.takeProfitPrice - setup.price) / setup.price * 100;
    const costPct = RiskEngine.cryptoRoundTripCostPct(setup.spread_bps);
    if (targetPct < costPct * MIN_REWARD_TO_COST) {
        return `target +${targetPct.toFixed(2)}% is under ${MIN_REWARD_TO_COST}x the ${costPct.toFixed(2)}% round-trip cost`;
    }
    if (position.notional > setup.bid_depth_1pct_usd * MAX_DEPTH_SHARE) {
        return `notional $${position.notional.toFixed(0)} exceeds ${MAX_DEPTH_SHARE * 100}% of bid depth ($${setup.bid_depth_1pct_usd})`;
    }
    return null;
}

async function processCandidate(setup, { aiEngine, broker, db, logger, notifier, activeCapital, dryRun }) {
    const decision = await aiEngine.evaluateBatch(setup);

    await logger.log(`--- AI CRYPTO DECISION FOR ${setup.symbol} ---`);
    await logger.log(`Action: ${decision.action} | Confidence: ${decision.confidence_score} | Reasoning: ${decision.reasoning}`);
    if (decision.debate?.proposal?.catalyst) {
        await logger.log(`[News] Sentiment: ${decision.debate.proposal.news_sentiment} | Catalyst: ${decision.debate.proposal.catalyst}`);
    }
    if (decision.debate?.audit) {
        await logger.log(`[Risk Auditor] Approved: ${decision.riskApproved} | Risk: ${decision.debate.audit.risk_score} | News risk: ${decision.debate.audit.news_risk} | ${decision.debate.audit.audit_notes}`);
    }

    if (!(decision.action === 'BUY' && decision.target_symbol === setup.symbol && decision.riskApproved)) {
        await logger.log(`HOLD on ${setup.symbol}.`);
        return activeCapital;
    }

    const position = RiskEngine.calculateCryptoPositionSize(activeCapital, decision.confidence_score, setup.price, setup.min_trade_increment);
    const gate = hardGateFailure(setup, position);
    if (gate) {
        await logger.log(`Trade for ${setup.symbol} blocked by hard gate: ${gate}.`);
        return activeCapital;
    }

    if (!(await Capacity.hasFreeSlot(db.client, 'crypto'))) {
        await logger.log(`Trade for ${setup.symbol} skipped: crypto book is full (${Capacity.LIMITS.crypto} max).`);
        return activeCapital;
    }

    if (dryRun) {
        const stops = RiskEngine.calculateDynamicStops(setup.price, setup.atr_1h);
        await logger.log(`[DRY RUN] Would BUY ${position.qty} ${setup.symbol} (~$${position.notional.toFixed(2)}) | stop ${stops.stopLossPrice} | target ${stops.takeProfitPrice}. No order placed.`);
        return activeCapital - position.notional;
    }

    const problem = exitEngineProblem();
    if (problem) {
        await logger.log(`Trade for ${setup.symbol} refused: exit engine not protecting positions (${problem}).`);
        await notifier.push('Crypto Entry Refused', `${setup.symbol} was approved but the exit engine is not live: ${problem}.`, 'warning');
        return activeCapital;
    }

    const fill = await broker.executeCryptoBuy(setup, position.qty);
    if (!fill.filled) {
        await logger.log(`Crypto entry for ${setup.symbol} did not fill (status: ${fill.status}). Order cancelled, nothing recorded.`);
        return activeCapital;
    }

    // Exit levels are anchored to the real fill, not the pre-trade quote.
    const stops = RiskEngine.calculateDynamicStops(fill.filled_avg_price, setup.atr_1h);
    await db.client.query(
        `INSERT INTO trade_analytics (symbol, action, qty, buy_price, stop_price, target_price, entry_order_id, status)
         VALUES ($1, 'BUY', $2, $3, $4, $5, $6, 'OPEN')`,
        [setup.symbol, fill.qty, fill.filled_avg_price, stops.stopLossPrice, stops.takeProfitPrice, fill.orderId]
    );

    await logger.log(`Crypto trade executed and logged: ${fill.qty} ${setup.symbol} @ $${fill.filled_avg_price}.`);
    await notifier.push(
        'SHEFA Crypto Entry',
        `Bought ${fill.qty} ${setup.symbol} at $${fill.filled_avg_price}\nTarget: $${stops.takeProfitPrice.toFixed(6)}\nStop: $${stops.stopLossPrice.toFixed(6)}`,
        'buy'
    );
    return activeCapital - fill.qty * fill.filled_avg_price;
}

async function runCryptoCycle({ dryRun = false, maxCandidates = Infinity } = {}) {
    const logger = new Logger('CryptoTradingBot');
    const db = new DatabaseClient();
    const notifier = new Notifier();

    await logger.log('==================================================');
    await logger.log(`🪙 SHEFA CRYPTO CYCLE${dryRun ? ' (DRY RUN)' : ''}`);
    await logger.log('==================================================');

    if (!Config.isTradingAllowed()) {
        await logger.log('Trading is DISABLED in Construction Mode. Standing down.');
        return;
    }

    try {
        await db.connect();

        const { heldSymbols, open, max, available } = await Capacity.getCapacity(db.client, 'crypto');
        await logger.log(`[${Config.getMode()}] Holding ${open}/${max} crypto positions.`);
        if (available <= 0) {
            await logger.log('Crypto book is full. Standing down.');
            return;
        }

        // Don't spend AI calls on candidates that could never be traded.
        if (!dryRun) {
            const problem = exitEngineProblem();
            if (problem) {
                await logger.log(`Standing down: exit engine not protecting positions (${problem}).`);
                return;
            }
        }

        let activeCapital = parseFloat(await db.getActiveCapital());
        await logger.log(`Active Capital Available: $${activeCapital.toFixed(2)}`);

        // Anti-whipsaw: a symbol that was just stopped out is not re-scanned until its cool-down ends.
        const cooled = await Cooldown.getCooledDownSymbols(db.client);
        if (cooled.length > 0) {
            await logger.log(`[Cool-down] Skipping ${cooled.map(c => `${c.symbol} (${c.stopouts} stop-out${c.stopouts > 1 ? 's' : ''}, until ${c.until})`).join(', ')}.`);
        }
        const excluded = [...heldSymbols, ...cooled.map(c => c.symbol)];

        const broker = new BrokerClient();
        const setups = await broker.scanCryptoMarket(excluded, Math.min(available, maxCandidates), {
            maxNotional: activeCapital * MAX_ALLOCATION_FRACTION
        });
        if (setups.length === 0) {
            await logger.log('No crypto pair passed the spread/depth gates.');
            return;
        }

        const aiEngine = new AIEngine();
        const newsClient = new NewsClient();
        const failed = [];

        for (const [index, setup] of setups.entries()) {
            if (index > 0) await sleep(SYMBOL_PACING_MS);
            try {
                setup.news = await newsClient.getContext(setup.symbol);
                await logger.log(`[Scan] ${setup.symbol}: ${setup.change_24h}% 24h | spread ${setup.spread_bps}bps | bid depth $${setup.bid_depth_1pct_usd} | RV ${setup.realized_vol_24h_pct}% | news ${setup.news.symbol.length}/${setup.news.macro.length}`);
                activeCapital = await processCandidate(setup, { aiEngine, broker, db, logger, notifier, activeCapital, dryRun });
            } catch (err) {
                failed.push(setup.symbol);
                await logger.log(`[Symbol Error] ${setup.symbol} skipped: ${err.stack}`);
            }
        }

        if (failed.length > 0) {
            await notifier.push('⚠️ Crypto Cycle: Symbols Skipped', `${failed.length}/${setups.length} errored: ${failed.join(', ')}. See execution.log.`, 'error');
        }
    } catch (err) {
        await logger.log(`[System Error]: ${err.stack}`);
        await notifier.push('⚠️ Crypto Cycle Error', err.message, 'error');
    } finally {
        await db.disconnect();
    }
}

if (require.main === module) {
    attachGlobalErrorLogger('CryptoTradingBot');
    const maxArg = process.argv.find(a => a.startsWith('--max='));
    runCryptoCycle({
        dryRun: process.argv.includes('--dry-run'),
        maxCandidates: maxArg ? parseInt(maxArg.split('=')[1], 10) : Infinity
    });
}

module.exports = { runCryptoCycle, processCandidate, hardGateFailure, exitEngineProblem };
