# Bosskey Trading Bot - System Context

## 1. System Architecture & Standpoint
*   **Environment:** Node.js backend managed by PM2, running on a Raspberry Pi. 
*   **Database:** PostgreSQL (`bosskey_trading`). Core tables are `system_logs`, `trade_analytics`, and `capital_pots`.
*   **Frontend:** React/Vite dashboard (port 5173) featuring Recharts data visualization, mobile responsive Tailwind CSS, and a Safe State Switcher UI modal that modifies the `.env` file between CONSTRUCTION, PAPER, and PRODUCTION modes.
*   **Broker:** Alpaca Markets.
*   **Execution:** OCO Bracket Architecture (Stop-Loss and Take-Profit) dynamically calculated using ATR limits.

## 2. Recent Resolutions
*   **Capacity Lock Cleared:** A desync between the Alpaca broker and PostgreSQL caused ghost positions. The database was manually updated to clear the 5/5 capacity limit, dropping it to 0/5.
*   **Indicator Math:** The RSI decimal bug was a false positive. The library natively returns whole numbers, so the `* 100` multiplier was reverted in `BrokerClient.js`. 
*   **Data Redundancy:** Implemented a data routing fallback from Finnhub to `yahoo-finance2` to guarantee fundamental API checks never fail.

## 3. Future Plan & Projections
*   **Immediate Goal:** Engineer an "Agent Debate" system inspired by the HKUDS/AI-Trader repository. Before capital is deployed, one AI agent will propose a trade, and a secondary agent will critique the logic to validate the momentum breakout.
*   **Deployment:** Transition the system from PAPER to PRODUCTION mode tomorrow to begin executing trades with live capital.

## 4. Strict Engineering Protocols & Code Rules
*   **Strict Problem-Solving / No Bypassing:** Never bypass checks, skip logs, take shortcuts, or rely on unverified assumptions unless it is strictly and entirely unavoidable. Always inspect raw database states and code structures rigorously.
*   **Object-Oriented Programming (OOP) Architecture:** This project is strictly structured around Object-Oriented Programming principles. Write modular classes and maintain proper class encapsulation rather than writing unstructured procedural scripts.
*   **Documentation Maintenance:** Always update all relevant README files as code changes are made.
*   **Automated Testing:** Always write, execute, and pass tests for the whole project to ensure system reliability before finalizing any code changes.
*   **Git Workflow & Release Notes:** After completing a coding session, stage, commit, and push the code to the correct repository branch following our established branching and conventional commit message structures.
*   **Release Documentation:** Maintain a `RELEASE-README.md` file for external users that details every push release using this exact structured format:
    `Date (Timestamp) | Title | Description | New Features`
