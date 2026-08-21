const Config = require('../src/Config');

describe('System Configuration & Safety Controls', () => {
    
    const originalEnv = process.env;

    beforeEach(() => {
        jest.resetModules();
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    test('isTradingAllowed should return FALSE when in CONSTRUCTION mode', () => {
        process.env.SYSTEM_MODE = 'CONSTRUCTION';
        expect(Config.isTradingAllowed()).toBe(false);
    });

    test('isTradingAllowed should return TRUE when in PAPER mode', () => {
        process.env.SYSTEM_MODE = 'PAPER';
        expect(Config.isTradingAllowed()).toBe(true);
    });

    test('isTradingAllowed should return TRUE when in PRODUCTION mode', () => {
        process.env.SYSTEM_MODE = 'PRODUCTION';
        expect(Config.isTradingAllowed()).toBe(true);
    });
});
