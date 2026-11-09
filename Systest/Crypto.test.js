jest.mock('@google/genai', () => ({
    GoogleGenAI: jest.fn().mockImplementation(() => ({ models: { generateContent: jest.fn() } }))
}));

const fs = require('fs');
const BrokerClient = require('../src/BrokerClient');
const RiskEngine = require('../src/RiskEngine');
const AIEngine = require('../src/AIEngine');
const { hardGateFailure, exitEngineProblem } = require('../CryptoTradingBot');
const { HEARTBEAT_FILE } = require('../src/CryptoExitEngine');

const hourly = (n, start, step) => Array.from({ length: n }, (_, i) => {
    const c = start + step * i;
    return { o: c - step, h: c * 1.005, l: c * 0.995, c, v: 10, vw: c };
});

const json = body => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });

describe('crypto market math', () => {
    test('book depth counts only levels within the band on the right side', () => {
        const bids = [{ p: 99.5, s: 10 }, { p: 99.1, s: 10 }, { p: 98, s: 100 }];
        expect(BrokerClient.bookDepthUsd(bids, 100, 0.01, 'bid')).toBeCloseTo(995 + 991);
        expect(BrokerClient.bookDepthUsd([{ p: 100.5, s: 2 }, { p: 102, s: 5 }], 100, 0.01, 'ask')).toBeCloseTo(201);
    });

    test('realized volatility is zero for a constant-return series', () => {
        const closes = Array.from({ length: 25 }, (_, i) => 100 * 1.01 ** i);
        expect(BrokerClient.realizedVolPct(closes)).toBeCloseTo(0, 6);
    });

    test('fractional sizing floors to the trade increment', () => {
        const { qty, notional } = RiskEngine.calculateCryptoPositionSize(10000, 80, 75000, 0.0001);
        expect(qty).toBe(0.016);                      // $1200 / $75000 = 0.016
        expect(notional).toBeCloseTo(1200);
        expect(RiskEngine.cryptoRoundTripCostPct(20)).toBeCloseTo(0.7); // 0.25*2 + 0.20
    });
});

describe('scanCryptoMarket', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });

    test('drops stablecoins, wide spreads and thin bid books; ranks by 24h change', async () => {
        const assets = ['BTC/USD', 'ETH/USD', 'USDC/USD', 'WIDE/USD', 'THIN/USD'].map(symbol => ({
            symbol, tradable: true, min_order_size: '0.0001', min_trade_increment: '0.000000001', price_increment: '0.01'
        }));
        const quote = (bp, ap) => ({ latestQuote: { bp, ap } });
        const deepBids = [{ p: 99.9, s: 1000 }];
        global.fetch = jest.fn(url => {
            if (url.includes('/v2/assets')) return json(assets);
            if (url.includes('/snapshots')) return json({ snapshots: {
                'BTC/USD': quote(99.95, 100.05), 'ETH/USD': quote(99.95, 100.05),
                'WIDE/USD': quote(99, 101), 'THIN/USD': quote(99.95, 100.05)
            } });
            if (url.includes('/bars')) return json({ bars: {
                'BTC/USD': hourly(30, 90, 0.3), 'ETH/USD': hourly(30, 80, 0.7),
                'WIDE/USD': hourly(30, 80, 0.7), 'THIN/USD': hourly(30, 80, 0.7)
            } });
            if (url.includes('/orderbooks')) return json({ orderbooks: {
                'BTC/USD': { b: deepBids, a: deepBids }, 'ETH/USD': { b: deepBids, a: deepBids },
                'WIDE/USD': { b: deepBids, a: deepBids }, 'THIN/USD': { b: [{ p: 99.9, s: 1 }], a: [] }
            } });
            throw new Error(`unexpected ${url}`);
        });

        const setups = await new BrokerClient().scanCryptoMarket([], 5, { maxNotional: 1000 });

        expect(setups.map(s => s.symbol)).toEqual(['ETH/USD', 'BTC/USD']);
        expect(setups[0]).toMatchObject({ assetClass: 'crypto', price: 100.05, bid: 99.95, spread_bps: 10 });
        expect(setups[0].btc_change_24h).not.toBeNull();
    });
});

describe('crypto agent payloads', () => {
    const setup = {
        symbol: 'ETH/USD', assetClass: 'crypto', price: 100, ask: 100, bid: 99.9, spread_bps: 10,
        change_24h: 6.2, btc_change_24h: 1.1, venue_volume_24h_usd: 5000, bid_depth_1pct_usd: 50000,
        ask_depth_1pct_usd: 40000, realized_vol_24h_pct: 4.1, atr_1h: 1.2, atr_1h_pct: 1.2,
        sma_20h: 97, rsi_14h: 64, min_trade_increment: 1e-9, news: { available: true, symbol: [], macro: [] }
    };

    test('both agents see 24h volume, depth, spread, volatility and the exit plan', async () => {
        const engine = new AIEngine({ geminiMinIntervalMs: 0 });
        const gen = engine.ai.models.generateContent;
        gen.mockReset();
        gen.mockResolvedValueOnce({ text: JSON.stringify({ action: 'BUY', target_symbol: 'ETH/USD', confidence_score: 80, news_sentiment: 0.2, catalyst: 'ETF flows', reasoning: 'ok' }) })
           .mockResolvedValueOnce({ text: JSON.stringify({ approved: true, risk_score: 30, news_risk: 'low', veto_reason: '', audit_notes: 'ok' }) });

        const decision = await engine.evaluateBatch(setup, { activeCapital: 10000 });

        const [traderPrompt, auditPrompt] = gen.mock.calls.map(c => c[0].contents);
        for (const prompt of [traderPrompt, auditPrompt]) {
            expect(prompt).toContain("24h Volume on Alpaca's venue only: $5000");
            expect(prompt).toContain('bids $50000 / asks $40000');
            expect(prompt).toContain('spread 10.0 bps');
            expect(prompt).toContain('Realized Volatility (24h, from hourly returns): 4.10%');
            expect(prompt).toContain('BTC 24h Change (market regime): 1.10%');
        }
        expect(traderPrompt).toContain('LONG ONLY');
        expect(traderPrompt).not.toContain('PENNY STOCK');
        expect(auditPrompt).toContain('Quantity: 12 | Notional: $1200.00');      // fractional sizing, $1200 at $100
        expect(auditPrompt).toContain('Position as % of bid depth within 1%: 2.40%');
        expect(auditPrompt).toContain('Round-trip cost (taker fees both legs + spread): 0.600%');
        expect(decision.riskApproved).toBe(true);
    });
});

describe('crypto entry hard gates', () => {
    const setup = { price: 100, atr_1h: 1, spread_bps: 10, bid_depth_1pct_usd: 10000, min_order_size: 0.001 };

    test('passes a liquid, well-paid setup', () => {
        expect(hardGateFailure(setup, { qty: 10, notional: 1000 })).toBeNull();
    });

    test('blocks a target that does not cover 3x the round-trip cost', () => {
        // target +1.5% (1.5x ATR... 3 x $0.5) vs 0.6% cost x3 = 1.8%
        expect(hardGateFailure({ ...setup, atr_1h: 0.5 }, { qty: 10, notional: 1000 })).toMatch(/round-trip cost/);
    });

    test('blocks a position larger than half the bid depth', () => {
        expect(hardGateFailure(setup, { qty: 60, notional: 6000 })).toMatch(/bid depth/);
    });

    test('blocks a qty under the minimum order size', () => {
        expect(hardGateFailure(setup, { qty: 0.0001, notional: 0.01 })).toMatch(/minimum order size/);
    });
});

describe('exit engine heartbeat gate', () => {
    const spy = jest.spyOn(fs, 'readFileSync');
    afterAll(() => spy.mockRestore());
    const beat = obj => spy.mockImplementation(path => {
        if (path === HEARTBEAT_FILE) return JSON.stringify(obj);
        throw new Error('ENOENT');
    });

    test('a fresh live heartbeat allows entries', () => {
        beat({ at: new Date().toISOString(), dryRun: false });
        expect(exitEngineProblem()).toBeNull();
    });

    test('a stale, dry-run, or missing heartbeat blocks entries', () => {
        beat({ at: new Date(Date.now() - 10 * 60 * 1000).toISOString(), dryRun: false });
        expect(exitEngineProblem()).toMatch(/old/);
        beat({ at: new Date().toISOString(), dryRun: true });
        expect(exitEngineProblem()).toMatch(/dry-run/);
        spy.mockImplementation(() => { throw new Error('ENOENT'); });
        expect(exitEngineProblem()).toMatch(/no heartbeat/);
    });
});
