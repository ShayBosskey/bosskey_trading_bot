# Bosskey Trading Bot (v1.3 OCO Bracket Architecture)

An autonomous, multi-position quantitative trading system built for Bosskey Industries. Powered by Node.js, PostgreSQL, Alpaca API, and Google Gemini AI.

## Core Architecture

The system operates on a Dynamic Multi-Fill model, executing trades based on Momentum Breakouts. Risk is managed entirely broker-side using One-Cancels-Other (OCO) Bracket Orders calculated via historical volatility.

* **TradingBot.js**: Runs every 15 minutes during market hours. Scans the Alpaca Top 50 Movers, filters out currently held assets and penny stocks. Evaluates setups using Gemini AI.
* **RiskEngine.js**: Calculates the 14-day Average True Range (ATR) to measure exact asset volatility. Dynamically sets Stop-Loss (2x ATR) and Take-Profit (3x ATR) to ensure mathematical risk-to-reward ratios regardless of asset class.
* **BrokerClient.js**: Submits execution commands directly to Alpaca via HTTP Fetch. Wraps the BUY, TAKE-PROFIT, and STOP-LOSS orders into a single Bracket Order, eliminating local execution latency and internet dropout risk.
* **FundamentalClient.js**: Integrates with the Finnhub API to filter out Event Risk. Rejects any technical momentum setup if the underlying company is scheduled to report earnings within the next 5 days.
* **Config.js**: Manages environmental safety. Controls Operational Modes (CONSTRUCTION, PAPER, PRODUCTION) to prevent unauthorized live trading.
* **Settlement.js**: Runs daily after market close to sweep closed trades and distribute profits into Capital Pots.

* **DashboardAPI.js**: A persistent Express.js REST API daemonized via PM2. Exposes system health, portfolio metrics, and logs over port 3000 to serve the frontend web dashboard.

## Services & Daemons
The REST API runs continuously in the background. Do not manage it via Cron.
* Start API: `pm2 start src/DashboardAPI.js --name "bosskey-api"`
* Monitor Logs: `pm2 logs bosskey-api`
* Restart API: `pm2 restart bosskey-api`

## Operational Modes

Controlled via the `.env` file (`SYSTEM_MODE`):
* `CONSTRUCTION`: All trading is hard-locked. Used for development and testing.
* `PAPER`: Executes trades against the Alpaca Paper API.
* `PRODUCTION`: Executes live capital trades.

## Testing Architecture (Systest)

The project utilizes `Jest` for automated testing and API mocking.
* Run tests via: `npm test`
* Validates configuration safety, broker payload formatting, and risk mathematics.

## CronJob Schedule (CEST - Swiss Local Time)

\`\`\`bash
# Dynamic Multi-Fill Bot (15-min intervals during market hours)
45,00,15,30 15-21 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node TradingBot.js >> execution.log 2>&1

# Daily Batch Settlement (After market close)
15 22 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node src/Settlement.js >> execution.log 2>&1
\`\`\`
