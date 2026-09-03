const { GoogleGenAI } = require('@google/genai');

class AIEngine {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    async #generateJSON(prompt) {
        const response = await this.ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
            }
        });

        let rawText = response.text;
        // Markdown entfernen, falls die KI welches generiert
        rawText = rawText.replace(/```json/gi, '').replace(/```/g, '').trim();

        return JSON.parse(rawText);
    }

    // Agent A: proposes a trade setup from technicals.
    async proposeTradeSetup(marketData) {
        console.log(`[Agent A: Trader] Routing evaluation through gemini-3.5-flash...`);

        const prompt = `
You are a ruthless, highly disciplined quantitative trading AI for Bosskey Industries.
Analyze the following market data for a potential momentum breakout trade.

Data:
- Symbol: ${marketData.symbol}
- Current Price: ${marketData.price}
- Daily Change: ${marketData.dailyChange}%
- Volume: ${marketData.volume}
- 20-Day SMA: ${marketData.sma_20}
- 14-Day RSI: ${marketData.rsi_14}

RULES:
1. PENNY STOCK FILTER: If the Current Price or SMA is under 5.00, you MUST return HOLD. We do not trade micro-cap pump-and-dumps.
2. BUY (Momentum Breakout): If Price > 5.00 AND Daily Change is highly positive AND Price > SMA. (Note: High RSI is acceptable and often expected in a strong breakout).
3. SELL_SHORT: Only if Price > 5.00 AND Daily Change is highly negative AND Price < SMA AND RSI > 70 (Overbought).
4. HOLD: If the setup is chaotic, missing data, or fails the penny stock filter.

Output strictly in JSON format. Do NOT use quotation marks inside the reasoning string.
{
  "action": "BUY" | "SELL_SHORT" | "HOLD",
  "target_symbol": "${marketData.symbol}" | "NONE",
  "confidence_score": 1-100,
  "reasoning": "1 sentence explanation without any internal quotes"
}`;

        try {
            return await this.#generateJSON(prompt);
        } catch (error) {
            console.error(`[Agent A Error]: ${error.message}`);
            return { action: 'HOLD', target_symbol: 'NONE', confidence_score: 100, reasoning: 'Fallback due to AI error (Agent A: Trader).' };
        }
    }

    // Agent B: critiques Agent A's proposal for slippage, volume, and false-breakout risk.
    // Must explicitly approve before TradingBot is allowed to submit a bracket order.
    async auditTradeSetup(marketData, proposal) {
        console.log(`[Agent B: Risk Auditor] Reviewing proposal for ${proposal.target_symbol}...`);

        const prompt = `
You are a skeptical risk auditor for Bosskey Industries. Your job is to CHALLENGE, not rubber-stamp, trade proposals submitted by the trading agent. Assume the trader is overconfident until the evidence proves otherwise.

Trader's Proposal:
- Action: ${proposal.action}
- Target: ${proposal.target_symbol}
- Confidence: ${proposal.confidence_score}
- Reasoning: ${proposal.reasoning}

Market Data:
- Symbol: ${marketData.symbol}
- Current Price: ${marketData.price}
- Daily Change: ${marketData.dailyChange}%
- Volume: ${marketData.volume}
- 20-Day SMA: ${marketData.sma_20}
- 14-Day RSI: ${marketData.rsi_14}

AUDIT CHECKLIST:
1. Slippage Risk: Is volume high enough to fill this position without excessive slippage? Thin volume on a large percentage move is a red flag.
2. False Breakout Risk: Does the move look like a genuine breakout, or an exhausted spike likely to mean-revert (e.g. extreme RSI with weak volume confirmation)?
3. Confidence Sanity: Does the trader's confidence score match the underlying evidence, or does it look inflated relative to the setup?

Reject the proposal if any check fails materially. Approve only when the setup holds up under scrutiny.

Output strictly in JSON format. Do NOT use quotation marks inside any string field.
{
  "approved": true | false,
  "risk_score": 1-100,
  "veto_reason": "1 sentence reason if rejected, otherwise an empty string",
  "audit_notes": "1 sentence summary of the audit"
}`;

        try {
            return await this.#generateJSON(prompt);
        } catch (error) {
            console.error(`[Agent B Error]: ${error.message}`);
            // Fail closed: if the auditor cannot respond, capital is NOT deployed.
            return { approved: false, risk_score: 0, veto_reason: 'Fallback rejection due to Risk Auditor error (Agent B unavailable).', audit_notes: 'Agent B unavailable.' };
        }
    }

    // Runs the full Agent A -> Agent B debate. Agent B's approval is required
    // before the caller may treat the decision as tradeable (decision.riskApproved).
    async evaluateBatch(marketData) {
        const proposal = await this.proposeTradeSetup(marketData);
        console.log(`[Agent A: Trader] Proposal for ${marketData.symbol}: ${proposal.action} (confidence ${proposal.confidence_score})`);

        if (proposal.action === 'HOLD' || !proposal.target_symbol || proposal.target_symbol === 'NONE') {
            return {
                ...proposal,
                riskApproved: false,
                debate: { proposal, audit: null }
            };
        }

        const audit = await this.auditTradeSetup(marketData, proposal);

        if (!audit.approved) {
            console.log(`[Agent B: Risk Auditor] REJECTED ${proposal.target_symbol}: ${audit.veto_reason}`);
            return {
                action: 'HOLD',
                target_symbol: 'NONE',
                confidence_score: proposal.confidence_score,
                reasoning: `Vetoed by Risk Auditor: ${audit.veto_reason}`,
                riskApproved: false,
                debate: { proposal, audit }
            };
        }

        console.log(`[Agent B: Risk Auditor] APPROVED ${proposal.target_symbol}: ${audit.audit_notes}`);
        return {
            ...proposal,
            riskApproved: true,
            debate: { proposal, audit }
        };
    }
}

module.exports = AIEngine;
