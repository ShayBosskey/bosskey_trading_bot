const { GoogleGenAI } = require('@google/genai');

class AIEngine {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    }

    async evaluateBatch(marketData) {
        console.log(`[AI Engine] Routing evaluation through gemini-3.5-flash...`);
        
        const prompt = `
You are a ruthless, highly disciplined quantitative trading AI for Bosskey Industries.
Analyze the following market data for a potential momentum breakout trade.

Data:
- Symbol: ${marketData.symbol}
- Current Price: ${marketData.price}
- Daily Change: ${marketData.dailyChange}%
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
        } catch (error) {
            console.error(`[AI Error]: ${error.message}`);
            return { action: 'HOLD', target_symbol: 'NONE', confidence_score: 100, reasoning: 'Fallback due to AI error.' };
        }
    }
}

module.exports = AIEngine;
