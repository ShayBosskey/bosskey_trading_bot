# Bosskey Trading Bot (v1.3 OCO Bracket Architecture)

An autonomous, multi-position quantitative trading system built for Bosskey Industries. Powered by Node.js, PostgreSQL, Alpaca API, and Google Gemini AI.

## Core Architecture

The system operates on a Dynamic Multi-Fill model, executing trades based on Momentum Breakouts. Risk is managed entirely broker-side using One-Cancels-Other (OCO) Bracket Orders calculated via historical volatility.

* **TradingBot.js**: Runs every 15 minutes during market hours. Scans the Alpaca Top 50 Movers, filters out currently held assets and penny stocks. Evaluates setups via the AIEngine Agent Debate, and only submits a bracket order when the Risk Auditor agent explicitly approves. Candidates are evaluated 5 s apart, and each one is isolated in its own `try/catch`: a symbol that errors (unparseable AI reply, broker rejection) is logged and skipped, the rest of the run continues, and one "Symbols Skipped" push summarises the failures.
* **AIEngine.js**: Two-agent debate pipeline (HKUDS/AI-Trader pattern) powered by Gemini, with an automatic fallback to OpenRouter (`meta-llama/llama-3.1-8b-instruct` by default) when Gemini is rate-limited or temporarily unavailable. On a 429/503 Gemini is retried with exponential backoff (2 s, then 5 s) before falling back, except for the free tier's daily quota (`GenerateRequestsPerDay...`, 20 requests/day), which falls back immediately. OpenRouter calls request `response_format: { type: 'json_object' }`, which stops the 8B model from emitting unquoted string values. Agent A (Trader) analyzes technicals and proposes a setup with a confidence score; Agent B (Risk Auditor) objectively evaluates the proposal's liquidity and risk. It sees today's volume, the 20-day average daily volume, and the exact position TradingBot would place (shares, notional, % of average daily volume, via `RiskEngine.calculatePositionSize`). Both agents' prompts carry a strict "raw JSON only" directive, and every response is passed through a markdown-fence strip plus a regex `{...}` extractor before `JSON.parse` — so conversational filler occasionally returned by smaller fallback models doesn't crash the pipeline. If a response still fails to parse, the engine automatically re-prompts the model with the exact parse error and the malformed text attached, asking it to output corrected JSON; if that repair attempt also fails, it escalates once more to a dedicated, more capable repair model (`meta-llama/llama-3.3-70b-instruct`) before finally giving up. A trade is only marked `riskApproved` when Agent B signs off; any Agent B rejection or API/parse error fails closed to HOLD.
* **RiskEngine.js**: Calculates the 14-day Average True Range (ATR) to measure exact asset volatility. Dynamically sets Stop-Loss (2x ATR) and Take-Profit (3x ATR) to ensure mathematical risk-to-reward ratios regardless of asset class.
* **BrokerClient.js**: Submits execution commands directly to Alpaca via HTTP Fetch. Wraps the BUY, TAKE-PROFIT, and STOP-LOSS orders into a single Bracket Order with `time_in_force: 'gtc'`, so protection stays live for the full life of the position instead of expiring at the end of the session. `scanMarketMovers` reads `volume` directly from the last fetched daily bar (`bars[bars.length - 1].v`), not a nonexistent field on the screener response. Each setup also carries `avg_volume_20`, the mean of the 20 daily bars before today. Also exposes `getPositions()`, `getLastFilledOrder()`, and `getOrderHistory(symbol, { nested })`, used by `Reconciliation.js` and `PositionsSync.js`; `nested: true` rolls bracket legs up under their entry order.
* **NewsClient.js**: Pulls the last 24h of headlines from the Alpaca News API (Benzinga feed, included with the Alpaca data key): symbol news plus a macro/sector feed (SPY, QQQ, SMH, NVDA, XLU, BTCUSD). Cached for 10 minutes and never throws; an outage is reported to the agents as `available: false`. Replaces the old Finnhub earnings filter: imminent earnings now surface as headlines and Agent B vetoes on them.
* **CryptoTradingBot.js**: SHEFA's 24/7 crypto entry cycle (one scan per run; PM2 `crypto-trading-bot`, every 15 min). Scans Alpaca's tradable USD pairs (stablecoins excluded) through `BrokerClient.scanCryptoMarket`, gating on spread (≤30 bps) and bid depth within 1% of mid (≥2× the largest possible position). Venue volume on Alpaca is thin, so depth is the exit-liquidity measure. Agents A/B get crypto payloads (24h change, venue volume, depth, spread, realized volatility, hourly ATR/SMA/RSI, BTC regime). Approved trades then pass hard gates in code (target ≥3× round-trip cost, notional ≤50% of bid depth, min order size), and the loop refuses to buy unless the exit engine's heartbeat is fresh and live. Fractional GTC limit entry; the row stores qty, stop/target and entry order id. `--dry-run` places nothing; `--max=N` caps candidates.
* **CryptoExitEngine.js**: Long-running PM2 process (`crypto-exit-engine`, see `ecosystem.config.js`) that enforces each crypto row's stop/target with market sells, because Alpaca has no crypto brackets. Self-heals via PM2 restarts, jittered WebSocket reconnects, a dead-link watchdog, REST polling while the stream is down, and crash recovery of half-finished exits. Writes `run/crypto-exit-engine.heartbeat.json`.
* **Capacity.js**: Separate position limits per market, 5 crypto (symbols with a slash, e.g. `BTC/USD`) and 3 equities, re-checked right before every order.
* **SHEFA news gate (AIEngine.js)**: both agents speak as SHEFA and receive the fenced news block. News can only veto: Agent A's `confidence_score` (which drives RiskEngine sizing) stays technical-only, with news going to `news_sentiment`, and an auditor `news_risk: "high"` is enforced as a veto in code.
* **Config.js**: Manages environmental safety. Controls Operational Modes (CONSTRUCTION, PAPER, PRODUCTION) to prevent unauthorized live trading.
* **PositionsSync.js**: Runs every 15 minutes (cron) and closes `OPEN` rows the broker no longer holds. The exit is taken only from the filled take-profit/stop-loss legs of that row's own bracket entry order (the filled entry-side order with the row's qty, filled closest before `opened_at`), so other trades in the same symbol are never counted. Rows it can't tie to a bracket are flagged for manual review. Never touches `capital_pots`.
* **Settlement.js**: Runs daily after market close to sweep closed trades and distribute profits into Capital Pots.
* **Reconciliation.js**: Detects drift between `trade_analytics` and Alpaca's real account state, in two passes. (1) Any DB row marked `OPEN` for a symbol Alpaca no longer holds at all is closed using the real fill price/time from Alpaca's order history. (2) Any `CLOSED` row with no `sell_price` on record (the signature of a past manual "ghost cleanup" or the historical NaN-corruption bug) is repaired using Alpaca's *complete* order history for that symbol — but only when that symbol has exactly one row anywhere in `trade_analytics`; a real closing fill repairs the row with real numbers, while no closing fill on a symbol that's still genuinely live reopens the row instead of leaving it wrongly `CLOSED`. Either way the resulting P&L is swept into `capital_pots` using the same 50/20/20/10 win-day split (or full deduction on a loss) that `Settlement.js` uses. Nothing is ever deleted — a symbol with multiple overlapping historical rows, or a broker position with no matching row at all, is always logged as a flagged anomaly for manual review rather than guessed at or removed. Defaults to a dry run; pass `--apply` to write.
* **Frontend Dashboard**: A responsive React/Vite application (port 5173). Features Recharts data visualization for Capital Pots, a live system log feed polling every 10 seconds, and a secure UI modal to seamlessly toggle the backend between CONSTRUCTION, PAPER, and PRODUCTION modes.
* **DashboardAPI.js**: A persistent Express.js REST API daemonized via PM2. Exposes system health, portfolio metrics, and logs over port 3000 to serve the frontend web dashboard.
* **ErrorHandler.js / VoiceEscalator.js**: `attachGlobalErrorLogger(scriptName)` catches uncaught exceptions/rejections, sends an ntfy push, and asks the voice escalation bridge to phone the owner (`VoiceEscalator`, a no-op unless `ESCALATION_TOKEN` is set in `.env`). It never throws and is capped at a 3 s timeout, so a down bridge can't block the crash path. Attached by `TradingBot.js`, `Settlement.js` and `PositionsSync.js`; it fires only for errors that escape each script's own `try/catch` (those still send their existing push).
* **Voice Escalation Stack (`escalation/`)**: A local Docker stack (Asterisk, Piper TTS, whisper.cpp, Ollama, and a Node bridge) that calls the owner's SIP phone over Tailscale, reads out the failure in SHEFA's voice (British female, Piper `en_GB-alba-medium`), transcribes the spoken reply, and after a keypad confirmation can halt trading (`CONSTRUCTION`) or switch to `PAPER` through the Dashboard API. It can never select `PRODUCTION`. See `escalation/README.md` for the architecture and the step-by-step deployment guide.

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
