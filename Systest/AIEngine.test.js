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

    test('halts (throws) instead of masking a Trader API failure as HOLD', async () => {
        generateContentMock.mockRejectedValueOnce(new Error('Gemini timeout'));

        await expect(engine.evaluateBatch(marketData)).rejects.toThrow('Agent A (Trader) unavailable');
        expect(generateContentMock).toHaveBeenCalledTimes(1);
    });
});

describe('OpenRouter fallback routing', () => {
    let engine;
    let generateContentMock;
    const originalFetch = global.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    const marketData = {
        symbol: 'TEST',
        price: 10,
        dailyChange: '5.00',
        volume: 1000000,
        sma_20: 9,
        rsi_14: 65
    };

    beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
        engine = new AIEngine();
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.OPENROUTER_API_KEY = originalApiKey;
    });

    test('reroutes to OpenRouter on a 429 and normalizes its response into the same shape', async () => {
        const rateLimitError = new Error('Quota exceeded');
        rateLimitError.status = 429;
        generateContentMock.mockRejectedValueOnce(rateLimitError);

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: '```json\n{"action":"BUY","target_symbol":"TEST","confidence_score":77,"reasoning":"Fallback breakout."}\n```' } }]
            })
        });

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(global.fetch).toHaveBeenCalledWith(
            'https://openrouter.ai/api/v1/chat/completions',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test_openrouter_key',
                    'HTTP-Referer': 'https://github.com/ShayBosskey',
                    'X-Title': 'Bosskey Trading Bot'
                })
            })
        );
        const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(requestBody.model).toBe('meta-llama/llama-3.1-8b-instruct');

        expect(proposal).toEqual({
            action: 'BUY',
            target_symbol: 'TEST',
            confidence_score: 77,
            reasoning: 'Fallback breakout.'
        });
    });

    test('reroutes to OpenRouter on a 503 as well', async () => {
        const unavailableError = new Error('Service Unavailable');
        unavailableError.status = 503;
        generateContentMock.mockRejectedValueOnce(unavailableError);

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'Fallback hold.' }) } }]
            })
        });

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(proposal.action).toBe('HOLD');
    });

    test('does not reroute non-rate-limit errors, and still halts rather than masking as HOLD', async () => {
        generateContentMock.mockRejectedValueOnce(new Error('Some other Gemini failure'));
        global.fetch = jest.fn();

        await expect(engine.proposeTradeSetup(marketData)).rejects.toThrow('Agent A (Trader) unavailable');
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('halts if OpenRouter itself is unreachable after a Gemini failure', async () => {
        const rateLimitError = new Error('Quota exceeded');
        rateLimitError.status = 429;
        generateContentMock.mockRejectedValueOnce(rateLimitError);
        global.fetch = jest.fn().mockResolvedValueOnce({ ok: false, status: 503 });

        await expect(engine.proposeTradeSetup(marketData)).rejects.toThrow('Agent A (Trader) unavailable');
    });
});

describe('Malformed JSON repair', () => {
    let engine;
    let generateContentMock;
    const originalFetch = global.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    const marketData = {
        symbol: 'TEST',
        price: 10,
        dailyChange: '5.00',
        volume: 1000000,
        sma_20: 9,
        rsi_14: 65
    };

    beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
        engine = new AIEngine();
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.OPENROUTER_API_KEY = originalApiKey;
    });

    test('re-prompts the model with the parse error when Gemini returns unparseable JSON, and succeeds on the repair reply', async () => {
        generateContentMock.mockResolvedValueOnce({ text: 'The stock looks great but here is no JSON at all.' });

        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({
                choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'Repaired.' }) } }]
            })
        });

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(global.fetch).toHaveBeenCalledTimes(1);
        const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(requestBody.model).toBe('meta-llama/llama-3.1-8b-instruct');
        expect(requestBody.messages[0].content).toContain('could not be parsed as JSON');
        expect(proposal.action).toBe('HOLD');
        expect(proposal.reasoning).toBe('Repaired.');
    });

    test('escalates to the dedicated JSON-repair model when the first repair attempt is also unparseable', async () => {
        generateContentMock.mockResolvedValueOnce({ text: 'not json' });

        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({ choices: [{ message: { content: 'still not json' } }] })
            })
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 5, reasoning: 'Fixed by big model.' }) } }]
                })
            });

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(global.fetch).toHaveBeenCalledTimes(2);
        const secondRequestBody = JSON.parse(global.fetch.mock.calls[1][1].body);
        expect(secondRequestBody.model).toBe('meta-llama/llama-3.3-70b-instruct');
        expect(proposal.reasoning).toBe('Fixed by big model.');
    });

    test('throws after exhausting repair attempts on the escalation model', async () => {
        generateContentMock.mockResolvedValueOnce({ text: 'not json' });

        global.fetch = jest.fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'still not json' } }] }) })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ choices: [{ message: { content: 'still still not json' } }] }) });

        await expect(engine.proposeTradeSetup(marketData)).rejects.toThrow('Agent A (Trader) unavailable');
        expect(global.fetch).toHaveBeenCalledTimes(2);
    });
});
