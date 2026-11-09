const RiskEngine = require('../src/RiskEngine');

describe('Dynamic Risk Engine (ATR)', () => {
    test('calculates correct ATR and dynamic stop levels', () => {
        // Create 15 days of simulated historical daily bars
        // High is 105, Low is 95, Close is 100. True Range should calculate exactly to 10.
        const bars = Array(15).fill({ h: 105, l: 95, c: 100 });
        
        const atr = RiskEngine.calculateATR(bars, 14);
        expect(atr).toBe(10);

        const stops = RiskEngine.calculateDynamicStops(100, atr);
        
        // Stop Loss should be 100 - (10 * 2) = 80
        expect(stops.stopLossPrice).toBe(80); 
        
        // Take Profit should be 100 + (10 * 3) = 130
        expect(stops.takeProfitPrice).toBe(130); 
    });
});

describe('Position sizing', () => {
    test('sizes a position at confidence x 15% of active capital, in whole shares', () => {
        const { allocation, shares } = RiskEngine.calculatePositionSize(50000, 80, 10);
        expect(allocation).toBeCloseTo(6000);
        expect(shares).toBe(600);
    });
});
