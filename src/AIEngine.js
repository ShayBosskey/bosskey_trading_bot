require('dotenv').config({ path: '../.env' });
const { GoogleGenAI } = require('@google/genai');

class AIEngine {
    constructor() {
        this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
	// 3.5 Flash is the main engine, 3.1 Flash-Lite is the instant fallback
        this.models = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
    }

    async evaluateBatch(marketData, activeCapital) {
        const maxLoss = (activeCapital * 0.01).toFixed(2);
        const prompt = `
            You are a strict financial trading AI. 
            Active capital: $${activeCapital}. 
            Max risk per trade is 1% ($${maxLoss} max loss). Assume a 2% stop-loss.
            
            Batch Market Data:
            ${JSON.stringify(marketData)}
            
            Directives:
            1. ETHICS: Disqualify any company known for severe unethical practices.
            2. EVALUATION: Calculate risk-to-reward for the remaining assets.
            3. SELECTION: Pick the single best candidate. If none are viable, choose HOLD.
            
            Output ONLY valid JSON containing: "action" (BUY or HOLD), "target_symbol" (ticker or "NONE"), "confidence_score" (1-100), and "reasoning" (brief sentence).
        `;

        for (const model of this.models) {
            try {
                console.log(`[AI Engine] Routing evaluation through ${model}...`);
                const response = await this.ai.models.generateContent({
                    model: model,
                    contents: prompt,
                });
                
                // Strip markdown formatting if the AI wraps the JSON in code blocks
                const cleanText = response.text.replace(/```json/g, '').replace(/```/g, '').trim();
                return JSON.parse(cleanText);
            } catch (err) {
                console.warn(`[AI Engine] ${model} failed: ${err.message}. Engaging fallback protocol...`);
            }
        }
        throw new Error("All AI models failed or rate limits exceeded.");
    }
}

module.exports = AIEngine;
