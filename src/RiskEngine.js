// Alpaca crypto tier-1 taker fee, in percent of notional.
const CRYPTO_TAKER_FEE_PCT = 0.25;

class RiskEngine {
    static calculateATR(bars, period = 14) {
        if (!bars || bars.length < period + 1) return null;

        let trueRanges = [];
        for (let i = 1; i < bars.length; i++) {
            const high = bars[i].h;
            const low = bars[i].l;
            const prevClose = bars[i - 1].c;

            const tr1 = high - low;
            const tr2 = Math.abs(high - prevClose);
            const tr3 = Math.abs(low - prevClose);

            trueRanges.push(Math.max(tr1, tr2, tr3));
        }

        const recentTRs = trueRanges.slice(-period);
        const atr = recentTRs.reduce((sum, tr) => sum + tr, 0) / period;
        
        return atr;
    }

    // Single source of truth for sizing: TradingBot places this order, and Agent B
    // audits the same numbers.
    static calculatePositionSize(activeCapital, confidenceScore, price) {
        const allocation = activeCapital * ((confidenceScore / 100) * 0.15);
        const shares = Math.floor(allocation / price);
        return { allocation, shares };
    }

    // Crypto trades in fractions: qty is floored to the asset's min_trade_increment
    // instead of whole shares. Same allocation rule as equities.
    static calculateCryptoPositionSize(activeCapital, confidenceScore, price, minTradeIncrement = 1e-9) {
        const allocation = activeCapital * ((confidenceScore / 100) * 0.15);
        const increment = minTradeIncrement > 0 ? minTradeIncrement : 1e-9;
        const qty = Number((Math.floor(allocation / price / increment) * increment).toFixed(9));
        return { allocation, qty, notional: qty * price };
    }

    // Round-trip cost of a crypto trade in percent: Alpaca's taker fee on both legs
    // (entry is marketable, stop exits are market orders) plus the bid/ask spread.
    static cryptoRoundTripCostPct(spreadBps, takerFeePct = CRYPTO_TAKER_FEE_PCT) {
        return takerFeePct * 2 + spreadBps / 100;
    }

    static calculateDynamicStops(currentPrice, atr) {
        // Volatility-adjusted parameters
        const stopLossPrice = currentPrice - (atr * 2.0);
        const takeProfitPrice = currentPrice + (atr * 3.0);

        return {
            takeProfitPrice,
            stopLossPrice
        };
    }
}

module.exports = RiskEngine;
module.exports.CRYPTO_TAKER_FEE_PCT = CRYPTO_TAKER_FEE_PCT;
