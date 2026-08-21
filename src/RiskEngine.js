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
