const { CommandParser, ACTIONS } = require('../src/CommandParser');

const llmReply = (action) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify({ action }) } }) });

describe('CommandParser', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });
    const parser = () => new CommandParser({ ollamaUrl: 'http://ollama:11434', model: 'qwen2.5:1.5b' });

    test.each([
        ['Halt trading.', ACTIONS.HALT_TRADING],
        ['please stop all trading now', ACTIONS.HALT_TRADING],
        ['Switch to paper.', ACTIONS.SWITCH_TO_PAPER],
        ['Status report.', ACTIONS.STATUS_REPORT],
        ['Acknowledged.', ACTIONS.ACKNOWLEDGE]
    ])('keyword match: "%s" -> %s without calling the LLM', async (said, expected) => {
        global.fetch = jest.fn();
        await expect(parser().parse(said)).resolves.toEqual({ action: expected, via: 'keyword' });
        expect(global.fetch).not.toHaveBeenCalled();
    });

    test('a negation is never keyword-matched - it goes to the LLM', async () => {
        expect(CommandParser.matchKeywords("don't stop trading")).toBeNull();
        global.fetch = jest.fn().mockResolvedValue(llmReply('ACKNOWLEDGE'));
        await expect(parser().parse("Don't stop trading")).resolves.toEqual({ action: ACTIONS.ACKNOWLEDGE, via: 'llm' });
    });

    test('sends a JSON-schema enum so the model can only pick an allowed action', async () => {
        global.fetch = jest.fn().mockResolvedValue(llmReply('HALT_TRADING'));
        await parser().parse('shut the whole thing down');
        const body = JSON.parse(global.fetch.mock.calls[0][1].body);
        expect(body.format.properties.action.enum).toEqual(Object.values(ACTIONS));
        expect(body.options.temperature).toBe(0);
    });

    test('an out-of-list LLM answer becomes UNKNOWN', async () => {
        global.fetch = jest.fn().mockResolvedValue(llmReply('SWITCH_TO_PRODUCTION'));
        await expect(parser().parse('go live with real money')).resolves.toEqual({ action: ACTIONS.UNKNOWN, via: 'llm' });
    });

    test('Ollama being down becomes UNKNOWN, not a crash', async () => {
        global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED'));
        jest.spyOn(console, 'error').mockImplementation(() => {});
        await expect(parser().parse('do the thing')).resolves.toEqual({ action: ACTIONS.UNKNOWN, via: 'none' });
    });

    test('empty transcript is UNKNOWN', async () => {
        await expect(parser().parse('   ')).resolves.toEqual({ action: ACTIONS.UNKNOWN, via: 'none' });
    });
});
