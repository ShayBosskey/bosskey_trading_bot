const {
    localDate, addDays, daysBetween, clampWeight, alignPlan, computeTargets, judge, cleanText
} = require('../src/StrategySync');
const { strategyPlanPrompt } = require('../src/AIEngine');

describe('StrategySync date helpers', () => {
    test('local date uses Europe/Zurich, not UTC', () => {
        // 23:30 UTC on Nov 10 is already Nov 11 in Zurich.
        expect(localDate(new Date('2026-11-10T23:30:00Z'))).toBe('2026-11-11');
    });
    test('adds days across a month boundary', () => {
        expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
        expect(daysBetween('2026-11-10', '2026-12-31')).toBe(51);
    });
});

describe('StrategySync arithmetic (Node owns every dollar figure)', () => {
    const today = '2026-11-10';
    const deadline = '2026-12-31';
    const dates = Array.from({ length: 30 }, (_, i) => addDays(today, i + 1));

    test('even pace spreads the remaining fund over every day to the deadline', () => {
        const plan = dates.map(date => ({ date, weight: 1 }));
        const { rows, requiredNetPerDay, daysLeft } = computeTargets({ fund: 0, goalUsd: 600, today, deadline, plan, share: 0.10 });
        expect(daysLeft).toBe(51);
        // $600 of fund at 10% = $6000 of net over 51 days.
        expect(requiredNetPerDay).toBeCloseTo(6000 / 51, 2);
        expect(rows).toHaveLength(30);
        // 30 of 51 days carry 30/51 of the goal.
        expect(rows.at(-1).targetFundTotal).toBeCloseTo(600 * 30 / 51, 0);
    });

    test('model weights shift effort between days but never change the total', () => {
        const even = computeTargets({ fund: 0, goalUsd: 600, today, deadline, plan: dates.map(date => ({ date, weight: 1 })), share: 0.10 });
        const skewed = computeTargets({
            fund: 0, goalUsd: 600, today, deadline, share: 0.10,
            plan: dates.map((date, i) => ({ date, weight: i % 7 >= 5 ? 0.5 : 1.5 })),
        });
        const sum = r => r.rows.reduce((s, x) => s + x.targetNet, 0);
        expect(sum(skewed)).toBeCloseTo(sum(even), 0);
        expect(skewed.rows[0].targetNet).toBeGreaterThan(skewed.rows[5].targetNet);
    });

    test('a goal already reached plans zero targets', () => {
        const { rows } = computeTargets({ fund: 700, goalUsd: 600, today, deadline, plan: [{ date: dates[0], weight: 1 }] });
        expect(rows[0].targetNet).toBe(0);
    });

    test('a passed deadline plans nothing', () => {
        const { rows } = computeTargets({ fund: 0, goalUsd: 600, today: '2027-01-02', deadline, plan: [{ date: '2027-01-03', weight: 1 }] });
        expect(rows).toEqual([]);
    });
});

describe('StrategySync model-output hygiene', () => {
    test('weights are clamped and garbage becomes 1', () => {
        expect(clampWeight(9)).toBe(2);
        expect(clampWeight(0)).toBe(0.25);
        expect(clampWeight('abc')).toBe(1);
        expect(clampWeight(undefined)).toBe(1);
    });

    test('plan aligns by date, falls back to order when every date is wrong, and fills gaps', () => {
        const dates = ['2026-11-11', '2026-11-12'];
        expect(alignPlan(dates, [{ date: '2026-11-12', weight: 1.5, focus: 'b' }]).map(d => d.weight)).toEqual([1, 1.5]);
        // No usable dates at all -> trust the order.
        expect(alignPlan(dates, [{ weight: 0.5 }, { weight: 2 }]).map(d => d.weight)).toEqual([0.5, 2]);
        expect(alignPlan(dates, null)).toEqual([
            { date: '2026-11-11', weight: 1, focus: null },
            { date: '2026-11-12', weight: 1, focus: null },
        ]);
    });

    test('focus text is stripped of control characters and truncated', () => {
        expect(cleanText('a\u0007\n b', 50)).toBe('a b');
        expect(cleanText('x'.repeat(200), 140)).toHaveLength(140);
        expect(cleanText(42, 10)).toBeNull();
    });

    test('a day is HIT only when settled net reaches its target', () => {
        expect(judge(100, 100)).toBe('HIT');
        expect(judge(100, 99.99)).toBe('MISSED');
    });

    test('the prompt forbids the model from producing dollar figures', () => {
        const p = strategyPlanPrompt({
            goalTitle: 'Upgrade', deadline: '2026-12-31', daysLeft: 51, onTrack: 'x', today: '2026-11-10',
            todayLine: 'y', recentDays: [], dates: ['2026-11-11'],
        });
        expect(p).toMatch(/Do NOT write any dollar amounts/);
        expect(p).toContain('2026-11-11');
        expect(p).toContain('No settled trades yet.');
    });
});
