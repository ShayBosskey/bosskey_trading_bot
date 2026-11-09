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
        engine = new AIEngine({ geminiMinIntervalMs: 0 });
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
        engine = new AIEngine({ geminiRetryDelaysMs: [], geminiMinIntervalMs: 0 });
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
        engine = new AIEngine({ geminiRetryDelaysMs: [], geminiMinIntervalMs: 0 });
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

describe('Gemini backoff before fallback', () => {
    let engine;
    let generateContentMock;
    let sleep;
    const originalFetch = global.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    const marketData = { symbol: 'TEST', price: 10, dailyChange: '5.00', volume: 1000000, sma_20: 9, rsi_14: 65 };
    const rateLimit = () => Object.assign(new Error('Quota exceeded'), { status: 429 });

    beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
        sleep = jest.fn().mockResolvedValue(undefined);
        engine = new AIEngine({ geminiRetryDelaysMs: [2000, 5000], geminiMinIntervalMs: 0, sleep });
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.OPENROUTER_API_KEY = originalApiKey;
    });

    test('waits and retries Gemini after a 429, without touching OpenRouter when the retry succeeds', async () => {
        generateContentMock
            .mockRejectedValueOnce(rateLimit())
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 40, reasoning: 'Retry worked.' }) });
        global.fetch = jest.fn();

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(sleep).toHaveBeenCalledWith(2000);
        expect(generateContentMock).toHaveBeenCalledTimes(2);
        expect(global.fetch).not.toHaveBeenCalled();
        expect(proposal.reasoning).toBe('Retry worked.');
    });

    test('backs off with growing delays, then falls through to OpenRouter once retries are exhausted', async () => {
        generateContentMock.mockRejectedValue(rateLimit());
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'Fallback.' }) } }] })
        });

        const proposal = await engine.proposeTradeSetup(marketData);

        expect(sleep.mock.calls.map(c => c[0])).toEqual([2000, 5000]);
        expect(generateContentMock).toHaveBeenCalledTimes(3);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(proposal.reasoning).toBe('Fallback.');
    });

    test('skips the backoff and falls back immediately when the daily free-tier quota is exhausted', async () => {
        generateContentMock.mockRejectedValueOnce(Object.assign(
            new Error('Quota exceeded for metric: generate_content_free_tier_requests, quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
            { status: 429 }
        ));
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'Fallback.' }) } }] })
        });

        await engine.proposeTradeSetup(marketData);

        expect(sleep).not.toHaveBeenCalled();
        expect(generateContentMock).toHaveBeenCalledTimes(1);
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('does not back off on a non-retryable Gemini error', async () => {
        generateContentMock.mockRejectedValueOnce(new Error('Invalid API key'));

        await expect(engine.proposeTradeSetup(marketData)).rejects.toThrow('Agent A (Trader) unavailable');
        expect(sleep).not.toHaveBeenCalled();
    });
});

describe('OpenRouter JSON mode and prompt hygiene', () => {
    let engine;
    let generateContentMock;
    const originalFetch = global.fetch;
    const originalApiKey = process.env.OPENROUTER_API_KEY;

    const marketData = { symbol: 'TEST', price: 10, dailyChange: '5.00', volume: 1000000, sma_20: 9, rsi_14: 65 };

    beforeEach(() => {
        process.env.OPENROUTER_API_KEY = 'test_openrouter_key';
        engine = new AIEngine({ geminiRetryDelaysMs: [], geminiMinIntervalMs: 0 });
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.OPENROUTER_API_KEY = originalApiKey;
    });

    test('requests json_object output from OpenRouter', async () => {
        generateContentMock.mockRejectedValueOnce(Object.assign(new Error('Service Unavailable'), { status: 503 }));
        global.fetch = jest.fn().mockResolvedValueOnce({
            ok: true,
            json: async () => ({ choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'ok' }) } }] })
        });

        await engine.proposeTradeSetup(marketData);

        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.response_format).toEqual({ type: 'json_object' });
    });

    test('neither agent prompt tells the model to avoid quotation marks (it caused unquoted JSON values)', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'TEST', confidence_score: 80, reasoning: 'Breakout.' }) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: false, risk_score: 50, veto_reason: 'x', audit_notes: 'x' }) });

        await engine.evaluateBatch(marketData);

        for (const [{ contents }] of generateContentMock.mock.calls) {
            expect(contents).not.toMatch(/quotation marks|internal quotes/i);
        }
    });
});

describe('Agent B audit inputs', () => {
    let engine;
    let generateContentMock;

    const marketData = { symbol: 'TEST', price: 10, dailyChange: '12.00', volume: 3000000, avg_volume_20: 1000000, sma_20: 9, rsi_14: 72 };

    beforeEach(() => {
        engine = new AIEngine({ geminiRetryDelaysMs: [], geminiMinIntervalMs: 0 });
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'TEST', confidence_score: 80, reasoning: 'Breakout.' }) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: true, risk_score: 30, veto_reason: '', audit_notes: 'ok' }) });
    });

    test('gives Agent B the average volume and the real position size TradingBot would place', async () => {
        await engine.evaluateBatch(marketData, { activeCapital: 50000 });

        const auditPrompt = generateContentMock.mock.calls[1][0].contents;
        // 50000 * 0.80 * 0.15 = $6000 -> 600 shares at $10 -> 0.06% of 1,000,000 ADV
        expect(auditPrompt).toContain('20-Day Average Daily Volume: 1000000');
        expect(auditPrompt).toContain("Today's Volume vs Average: 3.00x");
        expect(auditPrompt).toContain('Shares: 600');
        expect(auditPrompt).toContain('Notional: $6000.00');
        expect(auditPrompt).toContain('Position as % of Average Daily Volume: 0.0600%');
    });

    test('no longer primes Agent B to assume the trader is overconfident', async () => {
        await engine.evaluateBatch(marketData, { activeCapital: 50000 });

        const auditPrompt = generateContentMock.mock.calls[1][0].contents;
        expect(auditPrompt).not.toMatch(/assume the trader is overconfident|CHALLENGE, not rubber-stamp/i);
        expect(auditPrompt).toMatch(/objective risk auditor/i);
    });

    test('still audits (with unknown sizing) when no capital figure is passed', async () => {
        const decision = await engine.evaluateBatch(marketData);

        const auditPrompt = generateContentMock.mock.calls[1][0].contents;
        expect(auditPrompt).toContain('Shares: unknown');
        expect(decision.riskApproved).toBe(true);
    });
});

describe('Gemini 15 RPM pacing', () => {
    test('spaces consecutive Gemini requests at least 4s apart', async () => {
        const sleep = jest.fn().mockResolvedValue(undefined);
        const engine = new AIEngine({ geminiRetryDelaysMs: [], sleep });
        const reply = { text: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 40, reasoning: 'Paced.' }) };
        engine.ai.models.generateContent.mockReset();
        engine.ai.models.generateContent.mockResolvedValue(reply);
        const marketData = { symbol: 'TEST', price: 10, dailyChange: '5.00', volume: 1000000, sma_20: 9, rsi_14: 65 };

        await engine.proposeTradeSetup(marketData);
        expect(sleep).not.toHaveBeenCalled();

        await engine.proposeTradeSetup(marketData);
        expect(sleep).toHaveBeenCalledTimes(1);
        expect(sleep.mock.calls[0][0]).toBeGreaterThan(3900);
        expect(sleep.mock.calls[0][0]).toBeLessThanOrEqual(4000);
    });
});

describe('SHEFA news gate', () => {
    let engine;
    let generateContentMock;
    const news = {
        available: true,
        symbol: [{ at: '2026-11-09T18:00:00Z', headline: 'TEST announces $200M share offering', summary: 'Dilutive raise.' }],
        macro: [{ at: '2026-11-09T17:00:00Z', headline: 'Utilities rally on grid demand', summary: '' }],
    };
    const marketData = { symbol: 'TEST', price: 10, dailyChange: '5.00', volume: 1000000, avg_volume_20: 800000, sma_20: 9, rsi_14: 65, news };
    const buy = { action: 'BUY', target_symbol: 'TEST', confidence_score: 80, news_sentiment: -0.4, catalyst: 'offering', reasoning: 'Breakout.' };
    const promptOf = call => call[0].contents;

    beforeEach(() => {
        engine = new AIEngine({ geminiMinIntervalMs: 0 });
        generateContentMock = engine.ai.models.generateContent;
        generateContentMock.mockReset();
    });

    test('both agents receive the SHEFA persona and the fenced headlines', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify(buy) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: true, risk_score: 30, news_risk: 'low', veto_reason: '', audit_notes: 'ok' }) });

        await engine.evaluateBatch(marketData);

        for (const call of generateContentMock.mock.calls) {
            expect(promptOf(call)).toContain('You are SHEFA');
            expect(promptOf(call)).toContain('<<<NEWS');
            expect(promptOf(call)).toContain('TEST announces $200M share offering');
            expect(promptOf(call)).toContain('Utilities rally on grid demand');
        }
        expect(promptOf(generateContentMock.mock.calls[1])).toContain('News Sentiment (trader\'s read): -0.4');
    });

    test('a high news_risk is a veto even if the auditor says approved', async () => {
        generateContentMock
            .mockResolvedValueOnce({ text: JSON.stringify(buy) })
            .mockResolvedValueOnce({ text: JSON.stringify({ approved: true, risk_score: 30, news_risk: 'high', veto_reason: '', audit_notes: 'offering' }) });

        const decision = await engine.evaluateBatch(marketData);

        expect(decision.riskApproved).toBe(false);
        expect(decision.action).toBe('HOLD');
        expect(decision.reasoning).toContain('High real-world news risk');
    });

    test('formatNewsContext flags an unavailable feed instead of going silent', () => {
        expect(AIEngine.formatNewsContext({ available: false, symbol: [], macro: [] })).toContain('unavailable');
        expect(AIEngine.formatNewsContext(undefined)).toContain('not provided');
    });
});

describe('Gemini billing errors', () => {
    test('a 402 reroutes to OpenRouter immediately, without backoff', async () => {
        const sleep = jest.fn().mockResolvedValue(undefined);
        const engine = new AIEngine({ geminiRetryDelaysMs: [2000, 5000], geminiMinIntervalMs: 0, sleep });
        const originalFetch = global.fetch;
        const originalKey = process.env.OPENROUTER_API_KEY;
        process.env.OPENROUTER_API_KEY = 'k';
        engine.openRouterApiKey = 'k';
        engine.ai.models.generateContent.mockReset();
        engine.ai.models.generateContent.mockRejectedValue(Object.assign(new Error('402 Payment Required: quota exceeded'), { status: 402 }));
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ choices: [{ message: { content: JSON.stringify({ action: 'HOLD', target_symbol: 'NONE', confidence_score: 10, reasoning: 'x' }) } }] }) });

        await engine.proposeTradeSetup({ symbol: 'T', price: 10, dailyChange: '1', volume: 1, sma_20: 9, rsi_14: 50 });

        expect(sleep).not.toHaveBeenCalled();
        expect(engine.ai.models.generateContent).toHaveBeenCalledTimes(1);
        global.fetch = originalFetch;
        process.env.OPENROUTER_API_KEY = originalKey;
    });
});
