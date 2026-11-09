const Capacity = require('../src/Capacity');

const dbWith = symbols => ({ query: jest.fn().mockResolvedValue({ rows: symbols.map(symbol => ({ symbol })) }) });

describe('Capacity (5 crypto / 3 equity)', () => {
    test('classifies Alpaca crypto pairs by their slash', () => {
        expect(Capacity.assetClassOf('BTC/USD')).toBe('crypto');
        expect(Capacity.assetClassOf('AAPL')).toBe('equity');
    });

    test('counts each market against its own limit only', async () => {
        const db = dbWith(['BTC/USD', 'ETH/USD', 'AAPL', 'MSFT', 'NVDA']);

        const equity = await Capacity.getCapacity(db, 'equity');
        expect(equity).toMatchObject({ open: 3, max: 3, available: 0, heldSymbols: ['AAPL', 'MSFT', 'NVDA'] });

        const crypto = await Capacity.getCapacity(db, 'crypto');
        expect(crypto).toMatchObject({ open: 2, max: 5, available: 3, heldSymbols: ['BTC/USD', 'ETH/USD'] });
    });

    test('a full crypto book does not block equities', async () => {
        const db = dbWith(['BTC/USD', 'ETH/USD', 'SOL/USD', 'DOGE/USD', 'LTC/USD']);
        expect(await Capacity.hasFreeSlot(db, 'crypto')).toBe(false);
        expect(await Capacity.hasFreeSlot(db, 'equity')).toBe(true);
    });

    test('never reports negative availability when over the limit', async () => {
        const db = dbWith(['A', 'B', 'C', 'D']);
        expect((await Capacity.getCapacity(db, 'equity')).available).toBe(0);
    });

    test('rejects an unknown asset class', async () => {
        await expect(Capacity.getCapacity(dbWith([]), 'forex')).rejects.toThrow('Unknown asset class');
    });
});
