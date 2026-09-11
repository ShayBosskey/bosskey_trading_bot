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

**2026-09-03 (16:41:00 CEST)** | Capital Ledger Repair & Settlement Hardening | Root-caused and repaired a live data corruption incident in `capital_pots`, then closed the code-level gap that caused it. |
- **Data repair (live DB, approved and executed 2026-09-03)**: `capital_pots.active_capital` had been `NaN` since the 2026-09-02 20:15 settlement run. Reconstructed the correct value ($63,237.00) from 13 corroborating `TradingBot` log entries logged in the hours immediately before the corrupting settlement, and confirmed no real trades closed that day (only 5 manually-cleared "ghost position" rows with `net_profit = NULL`). Restored `active_capital = 63237.00` and set those 5 rows' `net_profit = 0.00` in a single transaction.
- **Root-cause fix (`src/Settlement.js`)**: A closed trade with a missing/non-finite `net_profit` (NULL, or Postgres's literal numeric `NaN`) is now skipped from the daily sum and logged as a warning, instead of propagating `NaN` into `dailyNetProfit`. Added a final guard that refuses to write a non-finite figure to `capital_pots` under any circumstance.
- **Testing**: Added `Systest/Settlement.test.js` (3 tests) reproducing the exact historical bug — a NULL or literal-`NaN` `net_profit` row alongside real profit — and asserting the ledger update always receives finite values. Full suite: 6 suites / 17 tests passing.
- **Capacity lock note**: confirmed 3/5 slots are actually held (ISRL, RDAC, RIBBU), not 0/5 as assumed going into this session — worth reconciling against the live Alpaca broker state before launch.

---

**2026-09-11 (04:53:06 CEST)** | OpenRouter Fallback JSON Hardening | The OpenRouter fallback (`meta-llama/llama-3.1-8b-instruct`) was connecting successfully but occasionally returning conversational text (e.g. "The stock...") instead of raw JSON, which crashed `JSON.parse()` with `Unexpected token 'T'... is not valid JSON` and took down Agent A mid-debate. |
- **Prompt hardening (`src/AIEngine.js`)**: Added a strict `STRICT_JSON_DIRECTIVE` to both the Agent A (Trader) and Agent B (Risk Auditor) prompts, explicitly forbidding conversational text, greetings, explanations, or markdown code fences, and requiring the response to begin with `{` and end with `}`.
- **Regex JSON extractor (`src/AIEngine.js`)**: `#generateJSON` now runs every model response through a `extractJSONBlock` regex pass (`/\{[\s\S]*\}/`) after the existing markdown-fence strip, pulling the JSON object out of any remaining conversational filler before `JSON.parse` runs. Applies uniformly to both the Gemini and OpenRouter response paths.
- **Notification/logging strings (`src/AIEngine.js`)**: Added a `console.warn` when extraction actually had to strip non-JSON filler (surfaces flaky-model behavior without failing the call), and reworked the parse-failure path to log a truncated snippet of the raw response and throw a clearer `AIEngine received a non-JSON response from the model` error instead of letting the raw `JSON.parse` `SyntaxError` propagate.
- **Docs**: Updated `README.md`'s `AIEngine.js` description to document the OpenRouter fallback model and the strict-JSON/regex-extraction safety net.

---

## ⚠️ Flagged before PRODUCTION cutover — NOT resolved, explicitly deferred

- **`BrokerClient.executeBuyOrder` posts to a hardcoded paper endpoint** (`https://paper-api.alpaca.markets/v2/orders`), and the SDK client is constructed with `paper: true`. Switching `SYSTEM_MODE` to `PRODUCTION` via the dashboard does **not** change where bracket orders are sent — they will still fill on the paper account. Fixing this requires a separate live-trading Alpaca API key pair (the current `.env` only holds paper keys) and a mode-based routing change in `BrokerClient.js`. Discussed 2026-09-03: explicitly deferred at the project owner's request — do not treat `SYSTEM_MODE=PRODUCTION` as executing real capital until this is revisited.
