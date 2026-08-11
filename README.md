# Bosskey Trading Bot 🤖📈

An autonomous, quantitative day trading algorithm powered by Node.js, the Alpaca V3 API, and Gemini AI. This system executes a complete daily trading lifecycle, managing market entry, hard-close liquidation, and automated profit distribution using a PostgreSQL database.

---

## 🏛️ System Architecture

The architecture is fully modular, object-oriented, and secured by a global error-catching wrapper.

* **`TradingBot.js`**: The master orchestrator. Runs in the afternoon, pulls live market data, queries the AI, and executes market BUY orders.
* **`src/AIEngine.js`**: The intelligence layer. Prompts the Gemini model with live technical indicators to generate confidence scores and trading decisions.
* **`src/BrokerClient.js`**: The execution layer. Handles all direct communication with the Alpaca V3 API.
* **`src/Liquidator.js`**: The risk manager. Forcefully liquidates all open positions right before the market closes to eliminate overnight risk.
* **`src/Settlement.js`**: The accountant. Calculates daily realized P&L and distributes capital across the PostgreSQL pots.
* **`src/Notifier.js`**: The communication layer. Sends real-time push notifications to Android devices via the ntfy.sh protocol.
* **`src/ErrorHandler.js`**: The global safety net. Wraps all scripts to catch unhandled exceptions and send instant crash reports.
* **`export_analytics.sh`**: A one-click bash script that exports the PostgreSQL trade ledger to a CSV file for Grafana or Excel analysis.

---

## 🧠 Core Strategy & Logic

The bot operates strictly as a day trader. It never holds positions overnight. 

### 1. Market Entry (15:35 CEST)
The bot waits for the opening bell volatility to settle. It calculates two primary technical indicators:
* **20-Day SMA (Simple Moving Average):** Determines the macroeconomic trend.
* **14-Day RSI (Relative Strength Index):** Identifies overbought or oversold conditions.
The AI Engine evaluates these indicators against the active capital and outputs a definitive `BUY` or `HOLD` signal with a confidence score.

### 2. Market Exit (21:55 CEST)
Five minutes before the New York closing bell, the `Liquidator.js` script initiates a hard close. It queries Alpaca for all open positions, sells them at market price, logs the profit margins to the `trade_analytics` table, and converts the portfolio entirely to cash.

### 3. Capital Settlement (21:58 CEST)
Daily profits are aggressively managed to ensure compounding growth while protecting against drawdowns and tax liabilities. The `Settlement.js` script distributes realized profits according to the 60/20/10/10 rule:
* **60% Active Capital:** Reinvested into the trading engine to compound daily buying power.
* **20% Emergency Reserve:** A drawdown shield to protect baseline capital during losing streaks.
* **10% Tax Vault:** Set aside in cash to cover potential ESTV professional trading tax liabilities.
* **10% Personal Payout:** Liquid cash out for personal use.
* *Note: Losing days are subtracted entirely from Active Capital to protect the vaults.*

---

## ⚙️ Deployment & Setup

### Prerequisites
* Node.js (v18+)
* PostgreSQL (v14+)
* An Alpaca Trading Account (Paper or Live)
* A Gemini API Key
* The ntfy Android App

### Environment Variables
Create a `.env` file in the root directory with the following exact keys:

```text
# Alpaca Broker
ALPACA_API_KEY=your_key_here
ALPACA_SECRET_KEY=your_secret_here

# AI Engine
GEMINI_API_KEY=your_key_here

# Database
DB_HOST=localhost
DB_PORT=5432
DB_NAME=bosskey_trading
DB_USER=your_user
DB_PASSWORD=your_password
