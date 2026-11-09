// Real-world context for the agents, from the Alpaca News API (Benzinga feed,
// included with the existing Alpaca market-data key). Replaces the Finnhub
// earnings check: an imminent earnings report shows up here as a headline,
// and Agent B is told to veto on it.
//
// News is a veto input only. It never feeds RiskEngine sizing or stop levels.

const NEWS_URL = 'https://data.alpaca.markets/v1beta1/news';
const HTTP_TIMEOUT_MS = 8000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const LOOKBACK_HOURS = 24;
const MAX_SYMBOL_ITEMS = 6;
const MAX_MACRO_ITEMS = 10;
const MAX_SUMMARY_CHARS = 240;

// Broad tape plus sector proxies for the themes SHEFA tracks: AI/semis (SMH, NVDA),
// power-grid demand (XLU utilities), rates/macro (SPY, QQQ), crypto mood (BTCUSD).
const MACRO_SYMBOLS = ['SPY', 'QQQ', 'SMH', 'NVDA', 'XLU', 'BTCUSD'];

// The ledger and order API write crypto as "BTC/USD"; the news feed tags "BTCUSD".
function toNewsSymbol(symbol) {
    return String(symbol).replace('/', '');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function stripHtml(text) {
    return String(text || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m)
        .replace(/\s+/g, ' ')
        .trim();
}

class NewsClient {
    constructor({ fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
        this.fetch = fetchImpl;
        this.now = now;
        this.cache = new Map(); // query -> { at, items }
    }

    async #query(params, maxItems) {
        const qs = new URLSearchParams({
            start: new Date(this.now() - LOOKBACK_HOURS * 3600 * 1000).toISOString(),
            limit: '50',
            sort: 'desc',
            ...params,
        });
        const key = `${params.symbols || '*'}|${maxItems}`;
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.at < CACHE_TTL_MS) return cached.items;

        const response = await this.fetch(`${NEWS_URL}?${qs}`, {
            headers: {
                'APCA-API-KEY-ID': process.env.ALPACA_API_KEY,
                'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
                accept: 'application/json',
            },
            signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
        if (!response.ok) throw new Error(`Alpaca News API Error: ${response.status}`);

        const body = await response.json();
        const seen = new Set();
        const items = [];
        for (const n of body.news || []) {
            const headline = stripHtml(n.headline);
            if (!headline || seen.has(headline)) continue;
            seen.add(headline);
            items.push({
                at: n.created_at,
                headline,
                summary: stripHtml(n.summary).slice(0, MAX_SUMMARY_CHARS),
                symbols: (n.symbols || []).slice(0, 6),
            });
            if (items.length >= maxItems) break;
        }

        this.cache.set(key, { at: this.now(), items });
        return items;
    }

    // Never throws: a news outage must not block trading, but the agents are told
    // the context is missing (available=false) instead of seeing a silent blank.
    async getContext(symbol) {
        const [symbolNews, macroNews] = await Promise.allSettled([
            this.#query({ symbols: toNewsSymbol(symbol) }, MAX_SYMBOL_ITEMS),
            this.#query({ symbols: MACRO_SYMBOLS.join(',') }, MAX_MACRO_ITEMS),
        ]);

        for (const r of [symbolNews, macroNews]) {
            if (r.status === 'rejected') console.warn(`[NewsClient] ${symbol}: ${r.reason?.message || r.reason}`);
        }

        return {
            available: symbolNews.status === 'fulfilled' || macroNews.status === 'fulfilled',
            symbol: symbolNews.status === 'fulfilled' ? symbolNews.value : [],
            macro: macroNews.status === 'fulfilled' ? macroNews.value : [],
        };
    }
}

module.exports = NewsClient;
module.exports.toNewsSymbol = toNewsSymbol;
module.exports.MACRO_SYMBOLS = MACRO_SYMBOLS;
