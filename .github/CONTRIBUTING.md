# Contributing

Thanks for your interest in improving Legwork.

## Getting started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-change`
2. `git submodule update --init` (forge-std), `npm install`
3. `npm run dev` for the page; `forge test` for the contract. Reading needs no key — the page and every test run against
   the public Arc RPC or against committed receipts. Only `npm run orders` / `npm run bench` write to mainnet and need a
   funded keystore (`cp .env.example .env`, see the comments there).

## Before you open a PR
- `npm run ci` passes (lint, typecheck, unit + property tests with coverage, audit).
- `forge test` passes; if you touch `contracts/`, say in the PR whether `OVERHEAD` (the calibrated immutable) is affected —
  anything inside the measured window of `execute` changes gas but not the constant; anything outside it needs a re-calibration
  on mainnet (three runs, `DEMO.md` §Calibration).
- `npm run e2e` passes (Playwright, desktop + mobile; the `live:` specs skip themselves if the RPC is unreachable).
- `python3 scripts/preflight.py` passes — it fails when the README's test counts stop matching what the runners report.
- Name tests after the behaviour they pin (`test_execute_batchedExecutorIsChargedTheIntrinsicOnce`), not after a number.
- Keep commits conventional (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, `ci:`); `release.yml` derives the version from them.

## Reporting bugs / requesting features
Open an issue using the provided templates. For anything touching how the refund is computed, include the transaction hash —
`npm run recheck` can then be pointed at it.
