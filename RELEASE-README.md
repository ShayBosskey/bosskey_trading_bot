# Release Log

Schema: `Date (Timestamp) | Title | Description | New Features`

---

**2026-09-03 (16:18:28 CEST)** | Agent Debate Engine & Live Dashboard Wiring | Pre-launch hardening pass ahead of the PRODUCTION mode cutover: gated trade execution behind a two-agent AI debate, fixed a fundamentals routing gap and a broken portfolio-history query, and brought project documentation up to date. | 
- **Agent Debate Engine (`src/AIEngine.js`, `TradingBot.js`)**: Replaced the single-shot AI call with a two-agent debate (HKUDS/AI-Trader pattern). Agent A (Trader) proposes a setup with a confidence score; Agent B (Risk Auditor) critiques it for slippage, volume, and false-breakout risk and must explicitly approve before `TradingBot.js` will submit an OCO bracket order. Any Agent B rejection or Gemini API error fails closed to HOLD — capital is never deployed on an unaudited proposal.
- **Fundamental Data Fallback (`src/BrokerClient.js`)**: Verified `fetchFundamentals` routes cleanly from Finnhub to `yahoo-finance2` on any Finnhub failure (non-OK response or thrown error), and that the fallback payload is remapped to Finnhub's `{c, d, dp}` shape so downstream callers see a consistent structure. Covered with new fallback tests.
- **Live Dashboard Analytics (`src/DashboardAPI.js`)**: Fixed a `ReferenceError`-causing bug in `/api/v1/portfolio` (`pool.query` on an undefined `pool`) and corrected the closed-trade history query to select `opened_at`/`closed_at`/`net_profit` — the fields `PerformanceMetrics.jsx` actually reads. The equity curve now renders the real trade history instead of always falling back to the sample timeline.
- **Order Safety Guard (`src/BrokerClient.js`)**: `executeBuyOrder`'s share-count guard used `qty < 1`, which is `false` for `NaN` — a corrupted or non-numeric allocation would have silently passed through as a malformed order. Now checked with `!Number.isFinite(qty) || qty < 1`. Found while investigating the `active_capital = NaN` issue below.
- **Testing**: Added `Systest/AIEngine.test.js` (5 tests covering the debate approve/veto/fail-closed paths) and extended `Systest/BrokerClient.test.js` with 3 fundamentals-fallback tests. Full suite: 5 suites / 14 tests passing. Dashboard `npm run lint` and `npm run build` both pass clean.

---

## ⚠️ Flagged before PRODUCTION cutover — NOT resolved in this release

Discovered while implementing the above; these are launch blockers, not code-review nitpicks, and were intentionally left untouched pending a decision from the project owner:

- **`capital_pots.active_capital` is corrupted to `NaN` in the live database.** Root cause: five `trade_analytics` rows closed on 2026-09-02 with `net_profit = NULL`; `Settlement.js` summed them with `parseFloat(null)` → `NaN`, then persisted `active_capital = active_capital + NaN`, which poisons the column permanently since every future settlement adds to it. Until this is manually repaired, `TradingBot.js` will compute `NaN` position sizes on every cycle.
- **Capacity lock is actually 3/5 (ISRL, RDAC, RIBBU currently OPEN), not 0/5.** Worth reconciling against the Alpaca broker state before assuming 5 free slots at launch.
- **`BrokerClient.executeBuyOrder` posts to a hardcoded paper endpoint** (`https://paper-api.alpaca.markets/v2/orders`), and the SDK client is constructed with `paper: true`. Switching `SYSTEM_MODE` to `PRODUCTION` via the dashboard does **not** change where bracket orders are sent — they will still fill on the paper account.
