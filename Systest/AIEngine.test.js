jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({
        models: { generateContent: jest.fn() }
    }))
}));

const AIEngine = require('../src/AIEngine');

describe('Agent Debate Engine (Trader vs Risk Auditor)', () => {
    let engine;
    let generateContentMock;

    const marketData = {
        symbol: 'TEST',
        price: 10,
        dailyChange: '5.00',
        volume: 1000000,
        sma_20: 9,
        rsi_14: 65
    };

    beforeEach(() => {
        engine = new AIEngine();
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    test('a HOLD proposal from Agent A short-circuits without consulting Agent B', async () => {
        generateContentMock.mockResolvedValueOnce({
            text: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 50, reasoning: 'No setup.' })
        });

        const decision = await engine.evaluateBatch(marketData);

        expect(generateContentMock).toHaveBeenCalledTimes(1);
        expect(decision.action).toBe('HOLD');
        expect(decision.riskApproved).toBe(false);
        expect(decision.debate.audit).toBeNull();
    });

    test('a BUY proposal is only tradeable once Agent B approves', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'TEST', confidence_score: 80, reasoning: 'Breakout.' }) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: true, risk_score: 20, veto_reason: '', audit_notes: 'Volume supports the move.' }) });

        const decision = await engine.evaluateBatch(marketData);

        expect(generateContentMock).toHaveBeenCalledTimes(2);
        expect(decision.action).toBe('BUY');
        expect(decision.target_symbol).toBe('TEST');
        expect(decision.riskApproved).toBe(true);
    });

    test('Agent B veto downgrades a BUY proposal to HOLD', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'TEST', confidence_score: 80, reasoning: 'Breakout.' }) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: false, risk_score: 90, veto_reason: 'Thin volume creates high slippage risk.', audit_notes: 'Rejected.' }) });

        const decision = await engine.evaluateBatch(marketData);

        expect(decision.action).toBe('HOLD');
        expect(decision.target_symbol).toBe('NONE');
        expect(decision.riskApproved).toBe(false);
        expect(decision.reasoning).toContain('Thin volume creates high slippage risk.');
    });

    test('fails closed (rejects) when the Risk Auditor call errors', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'TEST', confidence_score: 80, reasoning: 'Breakout.' }) })
            .mockRejectedValueOnce(new Error('Gemini timeout'));

        const decision = await engine.evaluateBatch(marketData);

        expect(decision.action).toBe('HOLD');
        expect(decision.riskApproved).toBe(false);
    });

    test('fails closed when the Trader call errors', async () => {
        generateContentMock.mockRejectedValueOnce(new Error('Gemini timeout'));

        const decision = await engine.evaluateBatch(marketData);

        expect(generateContentMock).toHaveBeenCalledTimes(1);
        expect(decision.action).toBe('HOLD');
        expect(decision.riskApproved).toBe(false);
    });
});
