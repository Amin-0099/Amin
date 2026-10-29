# Phase 5: Paper Trading & Signal Evaluation

## Status and scope

Phase 5 adds a paper-only signal-to-outcome workflow. It does not submit exchange orders, connect wallets, or move real funds. Paper entries and exits use a virtual EUR account and require fresh market prices. This implementation was not applied to a live database because `DATABASE_URL` was unavailable; the Drizzle schema is prepared, but the database-backed integration test remains skipped until a database is configured.

## Data model

- `radar_signals` stores a unique signal key, asset, stance, decision, confidence, observation time, reference price, entry/invalidation ideas, data status, and a JSON snapshot containing the report evidence, technical factors, momentum, source statuses, and decision context. Inserts are conflict-safe and snapshots are not updated when later radar results change.
- `radar_signal_outcomes` stores one immutable evaluation per signal and horizon (1, 24, or 168 hours), including source, evaluation timestamp, outcome price, return, directional result, invalidation, and maximum favorable/adverse movement.
- `paper_trades` stores the virtual position, its optional analysis-run or radar-signal reference, entry/exit prices, quantity, fee assumption, stop/take-profit, realized P&L, and a copy of the signal context.
- `paper_accounts` holds virtual starting and available balances. A partial unique index prevents an account from opening more than one paper position for the same radar signal.

## Signal lifecycle and evaluation

The radar endpoint records its current decisions and evaluates prior eligible signals against completed Binance hourly candles. Snapshots retain the original evidence and timestamps. Outcomes are computed only from candles strictly after the recorded observation time; the first recorded invalidation crossing takes precedence over the horizon close. A completed horizon with unavailable or incomplete live data is reported as `insufficient_data`, not estimated. Until the horizon is reached, the history endpoint reports `open`.

Radar performance is grouped by asset, signal type, stance, and horizon. Hit rates and average returns are exposed only at five or more completed outcomes per group. The same minimum sample rule is used for paper win rates, averages, and profit factors. Missing sample sizes remain `insufficient_data`; this is not a forecast or a claimed success rate. Stored snapshots are also checked for recorded missing/stale sources, source disagreement, verification mismatches, and signal conflicts.

## Paper-position lifecycle

An entry can be linked to either a completed analysis run or a recent, live, verified radar signal, but not both. A signal-linked position must match its direction, have a verification score of at least 70, contain evidence, and be no more than 90 minutes old. The current EUR entry price must also be fresh. A duplicate signal entry, invalid stop/take-profit, or insufficient virtual cash is rejected.

The virtual account reserves notional plus the entry fee. Manual exits and automatic stop/take-profit exits require a fresh price; unavailable or stale prices leave positions open. Realized P&L is gross directional P&L minus both fees. The configurable demo fee is 0–100 basis points per side, defaulting to 10. Unrealized P&L is withheld when a fresh valuation is unavailable. No exchange execution path exists.

Paper performance includes counts, net P&L, realized drawdown, and breakdowns by asset, stance, signal type, and close month. Rate and average metrics are withheld until five completed trades. Signal evaluation is independent of whether a paper position was opened.

## API and UI

- `GET /radar/signals`: recent immutable snapshots and their horizon state/results.
- `GET /radar/performance`: measured signal outcome aggregates and classified data-quality issues.
- `POST /paper/trades` and `POST /paper/trades/{positionId}/close`: open/close virtual positions, linked to a run or signal.
- `GET /paper/portfolio` and `GET /paper/performance`: virtual balances, positions, history, and measured statistics.

The dashboard labels the section and actions as PAPER / DEMO, displays freshness and unavailable values, and does not imply real execution.

## Data sources and remaining limitations

- Signal outcome evaluation uses completed Binance hourly OHLCV candles. Candle freshness/continuity must be live; missing or stale candles are not substituted.
- Current EUR position valuation uses the existing public Binance quote plus EUR/USDT conversion or CoinGecko EUR quote, with the existing provider freshness checks.
- News, social, sentiment, on-chain, and macro sources are not fabricated; absent inputs stay missing and cannot be treated as evidence.
- The database schema has not been applied in this environment. With a configured `DATABASE_URL`, apply the Drizzle schema using `pnpm --filter @workspace/db push`, then run the database-backed test with `PHASE2_DATABASE_TEST=1 pnpm test`. Do not run that test against an unintended database.
- History endpoints currently return bounded recent records; there is no pagination or export workflow. Evaluation depends on the hourly candle history the provider makes available, and signal snapshots older than that history may remain unevaluated.
- Phase 6 can add durable migration management, paginated evaluation/history, broader independent outcome validation, richer realized-equity drawdown accounting, and statistical safeguards beyond a minimum sample count. No automatic model training is implemented.
