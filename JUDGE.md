# For reviewers — Legwork on Arc mainnet

**Standing USDC orders anyone can run — and be repaid the exact gas, in the same dollar, in the same transaction.**

Live page: **https://edycutjong.github.io/legwork-arc/#/judge** (this file, as a page — no auth, no cookies, no wallet needed to read).
Arc mainnet, chain 5042. No backend, no oracle, no keeper network, nothing mocked: every number on the site is read from the chain in the browser.

## The 60-second path

1. Open the seeded order [`#/o/1`](https://edycutjong.github.io/legwork-arc/#/o/1) — it is Due; the card quotes the deposit, the reserve and the refund cap from the latest base fee.
2. Press **Execute — anyone can** with any wallet holding a few cents of USDC on Arc (the page offers to add the chain). One transaction.
3. Read the receipt: the payee's amount, your refund (`gasMetered × price`), the tip, the real fee from the receipt, and the drift between them — side by side, decoded in the browser.
4. No wallet? Open the committed hero run [`#/o/5/tx/0x2f6a…0c95`](https://edycutjong.github.io/legwork-arc/#/o/5/tx/0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95) — the same receipt, read from the chain (the order has since been cancelled; the receipt has not).

## Receipts

| | |
|---|---|
| Contract | [`0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb`](https://explorer.arc.io/address/0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb) · `OVERHEAD = 32503` (the page footer reads it from the chain) · on-chain runtime bytecode == `forge build` with the immutable filled (`python3 scripts/preflight.py --bytecode`) |
| Hero run | [`0x2f6a352d…0c95`](https://explorer.arc.io/tx/0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95) — `gasUsed` 58,415 = `gasMetered` 58,415 · drift **0** · refund ÷ real fee **1.000000** |
| Bench | 30 consecutive real executes on one order with 1-second periods: drift 0 on **30/30**, refund ÷ fee 1.000000 on 30/30, `gasUsed` p50 = p95 = 58,415; 5 rows by the payee collecting its own payment (`proof/rows.csv`, `proof/results.json`) |
| Branches | refusing payee → [Paused, executor still repaid](https://explorer.arc.io/tx/0xd07f9fb9f06deeab35a0e795ab0440f8150fb60e4f816993d57bee6a1470dc64) · not due → [revert, 24,323 gas](https://explorer.arc.io/tx/0x4fc9a3af02079e9bad40001108936c268a8269c88c231e6633517db854f556a6) · capped price → [executor eats the difference](https://explorer.arc.io/tx/0x6595b5a60548ab65b879f9012142764f3118d582fdc29d5dc8da2b457d413c98) |
| Spend | 0.1944 USDC of gas over 107 mainnet transactions; all 107 receipts committed under [`proof/receipts/`](./proof/receipts/) |
| Tests | **42 Foundry** (34 unit · 2 fuzz × 512 · 6 invariants × 64 runs × depth 32) · **36 vitest** incl. **4 fast-check properties × 5,000 = 20,000 generated cases** on the refund arithmetic and the log reducer · Playwright end-to-end on desktop + mobile incl. live mainnet reads |

## Reproduce (no key needed)

```sh
git clone https://github.com/edycutjong/legwork-arc && cd legwork-arc && git submodule update --init
forge test && npm install && npm test && npm run recheck && python3 scripts/preflight.py --bytecode
```

`npm run recheck` recomputes all 75 committed execute receipts from raw chain data — six equalities per row, exit code is the
verdict. `npm run bench -- --n 5` repeats the bench for about a cent of real gas and needs a funded keystore (`.env.example`).

## What we do not claim

- Executors are two wallets of ours in practice (the page button, the bench script, the demo payee). Nobody else has run an order yet.
- All bench rows sit at Arc's 20 Gwei base fee; the `2 × basefee` cap is exercised by tests and one capped receipt, not by the bench.
- The drift bound (≤ 50 gas, measured 0) holds for plain-account executors; a contract executor's own code runs outside the metered window and pays for itself.
- Explorer source verification was not attempted (its API sits behind a challenge page); the runtime bytecode is checked byte-for-byte against the build instead.
- The contract's `status` / `needed` / `priceCap` views read `block.basefee`, which a bare `eth_call` sees as 0 on Arc's RPC; the page computes the same arithmetic from the block's `baseFeePerGas` and never uses them.

## Links

- Repository: https://github.com/edycutjong/legwork-arc
- Live app: https://edycutjong.github.io/legwork-arc/
- [`DEMO.md`](./DEMO.md) — every edge case with one mainnet transaction · [`ARCHITECTURE.md`](./ARCHITECTURE.md) — the contract line by line · [`README.md`](./README.md)
