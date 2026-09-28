jest.mock('../src/DatabaseClient', () => {
    return jest.fn().mockImplementation(() => ({
        connect: jest.fn().mockResolvedValue(undefined),
        disconnect: jest.fn().mockResolvedValue(undefined),
        client: { query: jest.fn().mockResolvedValue({ rows: [] }) }
    }));
});

const VALID_TOKEN = 'a'.repeat(64);
process.env.ADMIN_API_TOKEN = VALID_TOKEN;

const app = require('../src/DashboardAPI');

describe('Dashboard API mode-switch authentication', () => {
    let server;
    let base;

    beforeAll(done => {
        server = app.listen(0, () => {
            base = `http://127.0.0.1:${server.address().port}`;
            done();
        });
    });

    afterAll(done => { server.close(done); });

    const postMode = (body, headers = {}) => fetch(`${base}/api/v1/system/mode`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });

    test('rejects an unauthenticated mode switch', async () => {
        // The original endpoint accepted this and would have flipped the bot live.
        const res = await postMode({ targetMode: 'PRODUCTION' });
        expect(res.status).toBe(401);
    });

    test('rejects an incorrect bearer token', async () => {
        const res = await postMode({ targetMode: 'PAPER' }, { authorization: 'Bearer wrong-token' });
        expect(res.status).toBe(403);
    });

    test('a valid token still cannot reach PRODUCTION without the explicit confirmation', async () => {
        const res = await postMode({ targetMode: 'PRODUCTION' }, { authorization: `Bearer ${VALID_TOKEN}` });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toMatch(/confirm/);
    });

    test('rejects an invalid mode name even with a valid token', async () => {
        const res = await postMode({ targetMode: 'GOD_MODE' }, { authorization: `Bearer ${VALID_TOKEN}` });
        expect(res.status).toBe(400);
    });

    test('fails closed when ADMIN_API_TOKEN is not configured', async () => {
        delete process.env.ADMIN_API_TOKEN;
        const res = await postMode({ targetMode: 'PAPER' }, { authorization: `Bearer ${VALID_TOKEN}` });
        expect(res.status).toBe(503);
        process.env.ADMIN_API_TOKEN = VALID_TOKEN;
    });

    test('read-only status endpoint stays public', async () => {
        const res = await fetch(`${base}/api/v1/system/status`);
        expect(res.status).toBe(200);
    });
});
