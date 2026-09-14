# Bosskey Trading Bot (v1.3 OCO Bracket Architecture)

An autonomous, multi-position quantitative trading system built for Bosskey Industries. Powered by Node.js, PostgreSQL, Alpaca API, and Google Gemini AI.

## Core Architecture

The system operates on a Dynamic Multi-Fill model, executing trades based on Momentum Breakouts. Risk is managed entirely broker-side using One-Cancels-Other (OCO) Bracket Orders calculated via historical volatility.

* **TradingBot.js**: Runs every 15 minutes during market hours. Scans the Alpaca Top 50 Movers, filters out currently held assets and penny stocks. Evaluates setups via the AIEngine Agent Debate, and only submits a bracket order when the Risk Auditor agent explicitly approves.
* **AIEngine.js**: Two-agent debate pipeline (HKUDS/AI-Trader pattern) powered by Gemini, with an automatic fallback to OpenRouter (`meta-llama/llama-3.1-8b-instruct` by default) when Gemini is rate-limited or temporarily unavailable. Agent A (Trader) analyzes technicals and proposes a setup with a confidence score; Agent B (Risk Auditor) critiques the proposal for slippage, volume, and false-breakout risk. Both agents' prompts carry a strict "raw JSON only" directive, and every response is passed through a markdown-fence strip plus a regex `{...}` extractor before `JSON.parse` — so conversational filler occasionally returned by smaller fallback models doesn't crash the pipeline. If a response still fails to parse, the engine automatically re-prompts the model with the exact parse error and the malformed text attached, asking it to output corrected JSON; if that repair attempt also fails, it escalates once more to a dedicated, more capable repair model (`meta-llama/llama-3.3-70b-instruct`) before finally giving up. A trade is only marked `riskApproved` when Agent B signs off; any Agent B rejection or API/parse error fails closed to HOLD.
* **RiskEngine.js**: Calculates the 14-day Average True Range (ATR) to measure exact asset volatility. Dynamically sets Stop-Loss (2x ATR) and Take-Profit (3x ATR) to ensure mathematical risk-to-reward ratios regardless of asset class.
* **BrokerClient.js**: Submits execution commands directly to Alpaca via HTTP Fetch. Wraps the BUY, TAKE-PROFIT, and STOP-LOSS orders into a single Bracket Order with `time_in_force: 'gtc'`, so protection stays live for the full life of the position instead of expiring at the end of the session. Also fetches fundamentals from Finnhub with an automatic `yahoo-finance2` fallback (mapped to the same `{c, d, dp}` shape) if Finnhub is unreachable. `scanMarketMovers` reads `volume` directly from the last fetched daily bar (`bars[bars.length - 1].v`), not a nonexistent field on the screener response. Also exposes `getPositions()`, `getLastFilledOrder()`, and `getOrderHistory()`, used by `Reconciliation.js`.
* **FundamentalClient.js**: Integrates with the Finnhub API to filter out Event Risk. Rejects any technical momentum setup if the underlying company is scheduled to report earnings within the next 5 days.
* **Config.js**: Manages environmental safety. Controls Operational Modes (CONSTRUCTION, PAPER, PRODUCTION) to prevent unauthorized live trading.
* **Settlement.js**: Runs daily after market close to sweep closed trades and distribute profits into Capital Pots.
* **Reconciliation.js**: Detects drift between `trade_analytics` and Alpaca's real account state, in two passes. (1) Any DB row marked `OPEN` for a symbol Alpaca no longer holds at all is closed using the real fill price/time from Alpaca's order history. (2) Any `CLOSED` row with no `sell_price` on record (the signature of a past manual "ghost cleanup" or the historical NaN-corruption bug) is repaired using Alpaca's *complete* order history for that symbol — but only when that symbol has exactly one row anywhere in `trade_analytics`; a real closing fill repairs the row with real numbers, while no closing fill on a symbol that's still genuinely live reopens the row instead of leaving it wrongly `CLOSED`. Either way the resulting P&L is swept into `capital_pots` using the same 50/20/20/10 win-day split (or full deduction on a loss) that `Settlement.js` uses. Nothing is ever deleted — a symbol with multiple overlapping historical rows, or a broker position with no matching row at all, is always logged as a flagged anomaly for manual review rather than guessed at or removed. Defaults to a dry run; pass `--apply` to write.
* **Frontend Dashboard**: A responsive React/Vite application (port 5173). Features Recharts data visualization for Capital Pots, a live system log feed polling every 10 seconds, and a secure UI modal to seamlessly toggle the backend between CONSTRUCTION, PAPER, and PRODUCTION modes.
* **DashboardAPI.js**: A persistent Express.js REST API daemonized via PM2. Exposes system health, portfolio metrics, and logs over port 3000 to serve the frontend web dashboard.

## Services & Daemons
The REST API runs continuously in the background. Do not manage it via Cron.
* Start API: `pm2 start src/DashboardAPI.js --name "bosskey-api"`
* Monitor Logs: `pm2 logs bosskey-api`
* Restart API: `pm2 restart bosskey-api`

## Environment Loading

`Config.js`, `BrokerClient.js`, and `Settlement.js` load `.env` via `path.resolve(__dirname, '../.env')` rather than a CWD-relative path, so a cron or PM2 invocation from any working directory always loads this project's own `.env` instead of silently picking up a stray file elsewhere on disk.

## Operational Modes

Controlled via the `.env` file (`SYSTEM_MODE`):
* `CONSTRUCTION`: All trading is hard-locked. Used for development and testing.
* `PAPER`: Executes trades against the Alpaca Paper API.
* `PRODUCTION`: Executes live capital trades.

## Testing Architecture (Systest)

The project utilizes `Jest` for automated testing and API mocking.
* Run tests via: `npm test`
* Validates configuration safety, broker payload formatting, risk mathematics, fundamental data fallback, and the Agent Debate risk-approval gate.

## CronJob Schedule (CEST - Swiss Local Time)

\`\`\`bash
# Dynamic Multi-Fill Bot (15-min intervals during market hours)
45,00,15,30 15-21 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node TradingBot.js >> execution.log 2>&1

# Daily Batch Settlement (After market close)
15 22 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node src/Settlement.js >> execution.log 2>&1
\`\`\`

`Reconciliation.js` is not yet on the cron schedule — run it manually (`node src/Reconciliation.js` to preview, `--apply` to write) after any period of suspected drift between the DB and the live Alpaca account.
