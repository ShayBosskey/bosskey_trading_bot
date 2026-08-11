# Bosskey Trading Bot 🤖

An autonomous, quantitative day trading algorithm powered by Node.js, the Alpaca V3 API, and Gemini AI. This system features multi-threaded market scanning, dynamic risk allocation via the Kelly Criterion, bidirectional trading (Long/Short), and automated PostgreSQL capital settlement.

---

## 📊 System Architecture & Data Flow

The system is fully modular and wrapped in a global error-catching net.

[Cron Job Trigger] 
       │
       ▼
 ┌──────────────┐      [Tickers.js] (Universe of 40+ AI/Tech Stocks)
 │ TradingBot.js│───────────┐
 └──────────────┘           ▼
       │              ┌──────────────┐
       │              │ BrokerClient │──> Multi-threaded Alpaca API Scan
       │              └──────────────┘    (Finds #1 Market Mover)
       ▼                    │
 ┌──────────────┐           │
 │ AIEngine.js  │<──────────┘
 └──────────────┘
 (Calculates 20 SMA & 14 RSI -> Gemini AI generates BUY, SELL_SHORT, or HOLD)
       │
       ▼
 [Risk Manager] -> Applies Kelly Criterion for Position Sizing
       │
       ▼
 [BrokerClient] -> Executes Trade via Alpaca
       │
       ▼
 [PostgreSQL]   -> Logs entry into 'trade_analytics' table
       │
       ▼
 [Notifier.js]  -> Pushes native Android alert via ntfy.sh

---

## 🧠 Advanced Algorithmic Logic

### 1. Multi-Threaded Ticker Scanning
Instead of sequentially checking stocks, the bot queries the Alpaca API for snapshots of the entire TICKER_UNIVERSE simultaneously. It filters the data to find the single asset with the highest absolute intraday momentum (positive or negative) and feeds it to the AI.

### 2. Bidirectional Trading (Short Selling)
The bot profits in both bull and bear markets. 
* BUY: Executed when the SMA is trending up and RSI is favorable. 
* SELL_SHORT: Executed when the SMA shows a strong downtrend and RSI is overbought. The bot borrows shares to sell high, and the liquidator buys them back at the end of the day.

### 3. Dynamic Position Sizing (The Kelly Criterion)
The bot abandons flat-rate risk. It scales the capital it risks based on the AI's confidence score (p) using a modified Kelly formula:
f* = 2p - 1
If the AI is 80% confident (0.8), f* = 0.6. The bot will allocate 60% of its maximum allowable risk to that specific trade.

---

## ⏱️ The Automation Schedule (Crontab)

The bot operates strictly via Linux Cron Jobs, mapped to standard US Market hours (translated to CEST).

* 15:35 | TradingBot.js : Market Entry. Runs 5 minutes after NY opening bell.
* 21:55 | Liquidator.js : Hard Close. Forcefully closes all open Long and Short positions.
* 21:58 | Settlement.js : Capital Distribution. Updates PostgreSQL database pots.

Crontab Configuration:

    # Execute Trade Evaluation (Monday-Friday at 15:35)
    35 15 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node TradingBot.js >> /home/adminbosskey/bosskey_trading_bot/execution.log 2>&1

    # Execute Hard Close Liquidation (Monday-Friday at 21:55)
    55 21 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node src/Liquidator.js >> /home/adminbosskey/bosskey_trading_bot/execution.log 2>&1

    # Execute Capital Settlement (Monday-Friday at 21:58)
    58 21 * * 1-5 cd /home/adminbosskey/bosskey_trading_bot && /usr/bin/node src/Settlement.js >> /home/adminbosskey/bosskey_trading_bot/execution.log 2>&1

---

## 💰 The 60/20/10/10 Settlement Rule
Profits are mathematically distributed nightly to ensure compounding growth and tax safety:
* 60% Active Capital: Reinvested into the algorithm.
* 20% Emergency Reserve: Drawdown protection.
* 10% Tax Vault: Reserved for potential Swiss ESTV liabilities.
* 10% Personal Payout: Liquid profit to be wired to a checking account.
*(Losses are absorbed 100% by Active Capital to shield the vaults).*
