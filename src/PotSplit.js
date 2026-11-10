// Single source of truth for how a winning day's net profit is split across the
// capital pots. Settlement.js applies it; the dashboard API serves it so the
// Capital Pots panel always shows the rule that is actually in force.
//
// SHEFA's upgrade fund takes its share off the top. The remainder is then split
// across the four operating pots. A losing day gives no pot anything: the loss
// comes out of active capital alone.
const SHEFA_FUND_SHARE = 0.10;

const REMAINDER_SPLIT = Object.freeze({
    active_capital: 0.50,
    emergency_reserve: 0.20,
    tax_vault: 0.20,
    personal_payout: 0.10,
});

function splitWinningDay(dailyNetProfit) {
    const shefa_fund = dailyNetProfit * SHEFA_FUND_SHARE;
    const remainder = dailyNetProfit - shefa_fund;
    return {
        shefa_fund,
        active_capital: remainder * REMAINDER_SPLIT.active_capital,
        emergency_reserve: remainder * REMAINDER_SPLIT.emergency_reserve,
        tax_vault: remainder * REMAINDER_SPLIT.tax_vault,
        personal_payout: remainder * REMAINDER_SPLIT.personal_payout,
    };
}

// Effective share of the day's net that each pot receives, e.g. active = 0.45.
function effectiveShares() {
    const rest = 1 - SHEFA_FUND_SHARE;
    const shares = { shefa_fund: SHEFA_FUND_SHARE };
    // Rounded so 0.2 * 0.9 reads as 0.18, not 0.18000000000000002.
    for (const [pot, share] of Object.entries(REMAINDER_SPLIT)) shares[pot] = Math.round(share * rest * 1e6) / 1e6;
    return shares;
}

module.exports = { SHEFA_FUND_SHARE, REMAINDER_SPLIT, splitWinningDay, effectiveShares };
