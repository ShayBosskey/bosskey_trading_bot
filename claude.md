# Bosskey Trading Bot - Project Context & Guidelines

## System Overview
* Backend: Node.js application running on a Raspberry Pi via PM2.
* Broker & Data: Alpaca Markets (Trading API), Finnhub (Fundamentals), yahoo-finance2 (Fallback).
* Database: PostgreSQL database named `bosskey_trading`. Core tables include `system_logs`, `trade_analytics`, and `capital_pots`.
* Dashboard: React/Vite dashboard running on port 5173 with Recharts components, mobile-responsive Tailwind CSS, and a Safe State Switcher for `.env` modes.
* Modes: `SYSTEM_MODE` can be `CONSTRUCTION`, `PAPER`, or `PRODUCTION`.

## Engineering Rules & Design Patterns
1. Strict Object-Oriented Programming (OOP): Maintain clean class encapsulation (e.g., `TradingBot`, `BrokerClient`, `AIEngine`). Do not write procedural scripts.
2. No Shortcuts or Unverified Assumptions: Never bypass logging, skip error handling, or assume database states. Always inspect raw database tables or logs before executing changes.
3. Automated Testing: Write, execute, and verify full test runs across the project before declaring a task complete.
4. Documentation Hygiene: Keep all `README.md` files updated alongside code edits.
5. Release Log Requirement: Maintain a `RELEASE-README.md` file in the root directory detailing every push using this exact schema: `Date (Timestamp) | Title | Description | New Features`.
6. Git Workflow: After coding sessions, stage, commit, and push updates using conventional commit messages and the established branching strategy.

## Key File Locations
* `TradingBot.js`: Core bot execution loop and trade orchestration.
* `src/AIEngine.js`: Prompt generation and AI reasoning pipeline, including OpenRouter fallback and JSON-repair re-prompting.
* `src/BrokerClient.js`: Indicator calculation, Alpaca order submission, fundamental data fetches, and live-position/order-history lookups used by reconciliation.
* `src/Reconciliation.js`: Compares `trade_analytics` against Alpaca's live `GET /v2/positions` and full order history. Run via `node src/Reconciliation.js` (dry run, default) or `node src/Reconciliation.js --apply` to write. Two passes: closes a DB-`OPEN` row for a symbol Alpaca no longer holds (using a verified real fill), and repairs/reopens a `CLOSED` row with no `sell_price` on record (a past ghost-cleanup or NaN-corruption signature) — but only ever for a symbol with exactly one row in the whole table. Never deletes a row: a symbol with multiple overlapping rows, or a live broker position with no matching row, is always flagged for manual review instead of guessed at.
* `src/DashboardAPI.js`: Express REST API serving dashboard telemetry over port 3000.

## Environment Loading
* `Config.js`, `BrokerClient.js`, and `Settlement.js` load `.env` via `path.resolve(__dirname, '../.env')`, not a CWD-relative path — this must stay `__dirname`-relative so cron/PM2 invocations from any working directory load the project's own `.env`, never a stray file elsewhere on disk.
