const { splitWinningDay, effectiveShares, SHEFA_FUND_SHARE } = require('../src/PotSplit');
const { renderBanner } = require('../src/Banner');

jest.mock('../src/DatabaseClient', () => jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    client: { query: jest.fn().mockResolvedValue({ rows: [] }) }
})));

describe('PotSplit', () => {
    test('SHEFA fund takes 10% of a winning day off the top', () => {
        expect(SHEFA_FUND_SHARE).toBe(0.10);
        const s = splitWinningDay(200);
        expect(s.shefa_fund).toBeCloseTo(20);
        expect(s.active_capital).toBeCloseTo(90);
        expect(s.emergency_reserve).toBeCloseTo(36);
        expect(s.tax_vault).toBeCloseTo(36);
        expect(s.personal_payout).toBeCloseTo(18);
    });

    test('effective shares sum to 100%', () => {
        const total = Object.values(effectiveShares()).reduce((a, b) => a + b, 0);
        expect(total).toBeCloseTo(1);
        expect(effectiveShares().active_capital).toBeCloseTo(0.45);
    });
});

describe('/api/v1/system/health', () => {
    const app = require('../src/DashboardAPI');
    let server;
    let base;
    beforeAll(done => { server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; done(); }); });
    afterAll(done => { server.close(done); });

    test('returns CPU, memory and root-disk figures', async () => {
        const res = await fetch(`${base}/api/v1/system/health`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.cpu.usagePct).toBeGreaterThanOrEqual(0);
        expect(body.cpu.usagePct).toBeLessThanOrEqual(100);
        expect(body.memory.usedPct).toBeGreaterThan(0);
        expect(body.memory.usedBytes).toBeLessThanOrEqual(body.memory.totalBytes);
        expect(body.disk.mount).toBe('/');
        expect(body.disk.usedPct).toBeGreaterThan(0);
        expect(body.host.cores).toBeGreaterThan(0);
    });

    test('portfolio exposes the pot split in force', async () => {
        const res = await fetch(`${base}/api/v1/portfolio`);
        const body = await res.json();
        expect(body.potShares.shefa_fund).toBeCloseTo(0.10);
    });
});

describe('startup banner', () => {
    test('greets Sir Elkayam and names the service', () => {
        const plain = renderBanner('Test Service', { color: false });
        expect(plain).toContain('Welcome, Sir Elkayam.');
        expect(plain).toContain('S H E F A');
        expect(plain).toContain('Test Service online');
        expect(plain).not.toContain('\x1b[');
    });
});
