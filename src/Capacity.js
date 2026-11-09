// Separate position limits per market. Crypto (fast, fractional, 24/7) and equities
// (swing trades, US hours) never compete for the same slots, so a full crypto book
// can't block an equity entry or the reverse.
const LIMITS = Object.freeze({ crypto: 5, equity: 3 });

// Alpaca writes crypto pairs with a slash ("BTC/USD") and equities without, and the
// ledger stores the symbol exactly as ordered - the same rule CryptoExitEngine uses.
function assetClassOf(symbol) {
    return String(symbol).includes('/') ? 'crypto' : 'equity';
}

async function getCapacity(dbClient, assetClass) {
    if (!(assetClass in LIMITS)) throw new Error(`Unknown asset class: ${assetClass}`);

    const res = await dbClient.query("SELECT symbol FROM trade_analytics WHERE status = 'OPEN'");
    const heldSymbols = res.rows.map(r => r.symbol).filter(s => assetClassOf(s) === assetClass);
    const max = LIMITS[assetClass];

    return {
        assetClass,
        heldSymbols,
        open: heldSymbols.length,
        max,
        available: Math.max(0, max - heldSymbols.length),
    };
}

// Re-checked right before each order, not just at the top of the cycle, so the
// limit holds even if another process opened a position mid-cycle.
async function hasFreeSlot(dbClient, assetClass) {
    return (await getCapacity(dbClient, assetClass)).available > 0;
}

module.exports = { LIMITS, assetClassOf, getCapacity, hasFreeSlot };
