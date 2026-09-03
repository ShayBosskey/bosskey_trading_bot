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
* `src/AIEngine.js`: Prompt generation and AI reasoning pipeline.
* `src/BrokerClient.js`: Indicator calculation, Alpaca order submission, and fundamental data fetches.
* `src/DashboardAPI.js`: Express REST API serving dashboard telemetry over port 3000.
