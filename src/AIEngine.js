const { GoogleGenAI } = require('@google/genai');

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_FALLBACK_MODEL = process.env.OPENROUTER_FALLBACK_MODEL || 'meta-llama/llama-3.1-8b-instruct';

// Gemini errors that mean "the model is temporarily unusable", not "the request was bad".
// Only these should trigger a reroute to OpenRouter - anything else (auth, bad request, parse
// failure) should keep failing the normal way so it surfaces instead of being masked.
function isRetryableGeminiError(error) {
    const status = error?.status ?? error?.statusCode ?? error?.code;
    if (status === 429 || status === 503) return true;

    const message = String(error?.message || '');
    return /\b429\b|\b503\b|RESOURCE_EXHAUSTED|quota exceeded|service unavailable/i.test(message);
}

function stripJSONFence(rawText) {
    return rawText.replace(/```json/gi, '').replace(/```/g, '').trim();
}

class AIEngine {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        this.openRouterApiKey = process.env.OPENROUTER_API_KEY;
    }

    async #generateWithGemini(prompt) {
        const response = await this.ai.models.generateContent({
            model: 'gemini-3.5-flash',
            contents: prompt,
            config: {
                responseMimeType: "application/json",
            }
        });

        return response.text;
    }

    // Fallback path: same prompt, same "return strict JSON" instructions already baked into
    // the prompt text, just routed through OpenRouter's OpenAI-compatible chat endpoint.
    async #generateWithOpenRouter(prompt) {
        if (!this.openRouterApiKey) {
            throw new Error('OpenRouter fallback unavailable: OPENROUTER_API_KEY is not configured.');
        }

        const response = await fetch(OPENROUTER_ENDPOINT, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.openRouterApiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://github.com/ShayBosskey',
                'X-Title': 'Bosskey Trading Bot'
            },
            body: JSON.stringify({
                model: OPENROUTER_FALLBACK_MODEL,
                messages: [{ role: 'user', content: prompt }]
            })
        });

        if (!response.ok) {
            throw new Error(`OpenRouter fallback responded with status: ${response.status}`);
        }

        const data = await response.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) {
            throw new Error('OpenRouter fallback returned no message content.');
        }

        return content;
    }

    async #generateJSON(prompt) {
        let rawText;

        try {
            rawText = await this.#generateWithGemini(prompt);
        } catch (error) {
            if (!isRetryableGeminiError(error)) {
                throw error;
            }

            console.warn(`[AIEngine] Gemini primary call failed (${error.status || error.message}). Rerouting through OpenRouter fallback (${OPENROUTER_FALLBACK_MODEL})...`);
            rawText = await this.#generateWithOpenRouter(prompt);
            console.log(`[AIEngine] OpenRouter fallback succeeded.`);
        }

        // Normalize output shape: strip any markdown fencing so both providers' responses
        // parse into the same JSON structure the Agent Debate logic expects downstream.
        return JSON.parse(stripJSONFence(rawText));
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
            // Both Gemini and the OpenRouter fallback are unavailable - this is an API
            // outage, not a trading decision. Do NOT mask it as a HOLD proposal (that
            // would let downstream logic treat "AI is down" as "no setup found" and
            // bypass Agent B entirely). Log it as critical and let it halt the cycle.
            console.error(`[Agent A CRITICAL]: AI evaluation unavailable for ${marketData.symbol} - ${error.message}`);
            throw new Error(`Agent A (Trader) unavailable for ${marketData.symbol}: ${error.message}`);
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
