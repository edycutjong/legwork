# Demo & proof — Legwork on Arc mainnet

Everything below happened on **Arc mainnet (chain 5042)** on 2026-09-18 from the wallet `0xA8965A47c9b6ed34F47B374f36cF6c752D24852a`.
Every hash links to the explorer and has its receipt committed under [`proof/receipts/`](./proof/receipts/); `npm run recheck`
recomputes each one. Nothing here is simulated, mocked, or from a testnet.

Contract **`0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2`** ([explorer](https://explorer.arc.io/address/0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2)) · `OVERHEAD = 32503` ·
calibration deploy `0x16B4101605c496C7Fbe54490C6467eeF996EA775` (`OVERHEAD = 31400`, kept in the record) · demo payee `0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60` · refusing payee `Rejector` `0x1c17C16177f2aC609440ea20c00D0e108F617c47`.

## The receipt this project exists for

The `live` order (#1: 0.02 USDC to the demo payee every 60 s, tip 0.01, deposit 0.10) on its first run, [`0x651700ee…5f0b`](https://explorer.arc.io/tx/0x651700ee3f058685b0cdb896a707f5e5e7e8c507076a3f0f4d6816f3d6e25f0b), block 21487558:

```
payee received     0.02 USDC        Transfer 0x68a9… → 0x352e…   (20000000000000000 wei)
executor refunded  0.0011606 USDC   Executed.refund = 58030 gas × 20 Gwei (1160600000000000 wei)
executor tipped    0.01 USDC        Executed.tip
real fee paid      0.0011606 USDC   receipt.gasUsed 58030 × effectiveGasPrice 20 Gwei — from the receipt, not from us
net                +0.01 USDC        drift = gasUsed − gasMetered = 0 gas · refund ÷ fee = 1.000000
```

The contract's own number for what the transaction cost and the receipt's number are the same to the wei. That is the whole claim;
the rest of this file is how often it held (36 production executes: drift 0 on 35, −6 gas on the one refused payment) and what happens when things go wrong.

## Try it in 30 seconds (any wallet holding a few cents of USDC on Arc)

1. Open `https://edycutjong.github.io/legwork-arc/#/o/1` (or run the page locally: `npm install && npm run dev`).
2. Press **Execute — anyone can**. The page sends `execute(1)` with priority 0 at `max(eth_gasPrice, 20 Gwei)`.
3. Read the receipt: the payee got 0.02 USDC, you got the metered gas back plus 0.01 USDC, and the real fee from the receipt is printed beside the refund.

The `live` order was funded for three runs; one was used above, so two are left for reviewers (then it reads *Underfunded — top up ≥ 0.026*, which is also a state worth seeing).
**Prerequisite:** USDC on Arc in your wallet. Getting it there from another chain is Circle's bridge (CCTP), not part of this project.

**Build your own in 60 seconds:** *New order* → payee, amount, interval, tip → **Create** (the reserve is quoted from the latest base fee) → the order card opens Due → **Execute**.

## Reproduce

```sh
git clone https://github.com/edycutjong/legwork-arc && cd legwork-arc
git submodule update --init          # forge-std
forge test                            # 36 Foundry cases: unit + 2 fuzz suites + 6 invariants (≈ 1 s)
npm install && npm test               # 32 vitest cases over the committed mainnet receipts (≈ 1 s)
npm run recheck                       # recompute every committed execute receipt from raw data; exit code is the verdict (read-only, ≈ 20 s)
python3 scripts/preflight.py --bytecode   # readiness gate + on-chain runtime code == forge build with the immutable filled
npm run bench -- --n 5                # ≈ a cent of real gas: creates, runs 5×, cancels its own order; needs a funded keystore (see .env.example)
```

`npm run recheck` output today: `39 execute receipts (36 on the production contract, 3 calibration) … production drift: min -6 max 0 gas … all checks passed`.

## Headline number

**Refund ÷ real fee = 1.000000 on all 30 bench rows** (pre-stated invariant: 1.00 ± 0.02), with **drift = 0 gas on every row** (gate: ≤ 50).
`gasUsed` p50 **58030** · p95 **58030** (min 55530, the payee-as-executor rows) · real fee p50 **0.0011606 USDC** at a 20 Gwei base fee ·
executor net after tip p50 **+0.0001 USDC** = exactly the 0.0001 tip.

## Bench — 30 consecutive real executes, one order, 1-second periods

`npm run bench` · order #5 · create [`0x2fa0ae0a…a160`](https://explorer.arc.io/tx/0x2fa0ae0af39d0470cecea9cc6e156e9ae2bdb172cb220d2fef8cdf5cb4c0a160) · rows in [`proof/rows.csv`](./proof/rows.csv) · summary [`proof/results.json`](./proof/results.json) · cancelled [`0x32615c3c…b57f`](https://explorer.arc.io/tx/0x32615c3ceeeaf5b59380e7dae646f40fc3f5a9bf497d97b02f690f75b9d0b57f) (0.0386714 USDC returned).
Order: payee = demo payee · 0.001 USDC · every 1 s · tip 0.0001 · maxGasPrice 100 Gwei · deposit 0.1085 (31 × the honest reserve). Blocks 21489888 → 21490006.

| rows | executor | gasUsed p50 / p95 | drift | price == effectiveGasPrice | ratio | executor net |
|---|---|---|---|---|---|---|
| 1–25 | the payer wallet [`0xA896…852a`](https://explorer.arc.io/address/0xA8965A47c9b6ed34F47B374f36cF6c752D24852a) | 58030 / 58030 | 0 on every row | yes, 20 Gwei on every row | 1.000000 | +0.0001 USDC (the tip) |
| 26–30 | **the payee itself** [`0x352e…AA60`](https://explorer.arc.io/address/0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60), collecting its own payment | 55530 / 55530 | 0 on every row | yes | 1.000000 | +0.0001 USDC |

First row [`0x3734f3b7…04a6`](https://explorer.arc.io/tx/0x3734f3b7b80c0fe92c422b8f64711c9fea16fa6eb37c1a289f72d68aa32b04a6) (block 21489888) · last row [`0xd1d52885…44fb`](https://explorer.arc.io/tx/0xd1d528853e0776f6a1f034f0119675825888f273023bcc3b598b4f4e3b9344fb) (block 21490006) · every row's hash is in `rows.csv` and `proof/receipts/`.
The payee's rows cost 2,500 gas less because the payee is `tx.origin` and therefore already warm — and the meter caught that too (drift 0).
A 31st execute [`0x86162547…bdb4`](https://explorer.arc.io/tx/0x861625470e447205ef4429bc9374124a76f44272c5674ad8cf05d29482c7bdb4) was sent as a `NotDue` attempt and landed as a normal run because a second had elapsed; it is a valid receipt, included by `recheck`, excluded from the 30 rows.

Methodology: no randomness to seed — the fixed inputs are the order parameters above and priority 0. p50/p95 are over the 30 rows; there is no warm-up to discard because there is no cache (each run is its own transaction). Limitation: all rows are at a 20 Gwei base fee (the only base fee observed on Arc that day), so the `2 × basefee` cap never bound in the bench; the cap is exercised by the `capped` row below and by the Foundry tests.

## Edge cases — one mainnet transaction per row

| Case | What the contract does | Receipt |
|---|---|---|
| Happy path (`live`, #1) | pays 0.02, refunds 58030 × 20 Gwei, tips 0.01, `nextDue += 60` | [`0x651700ee…5f0b`](https://explorer.arc.io/tx/0x651700ee3f058685b0cdb896a707f5e5e7e8c507076a3f0f4d6816f3d6e25f0b) — gasUsed 58030, metered 58030, drift 0, ratio 1.000000 |
| **Payee refuses** (`rejecting`, #2 → `Rejector`, whose `receive` reverts) | order **pauses**; the unpaid 0.01 stays in the deposit; the executor is still refunded 60186 × 20 Gwei + tipped 0.01; `Paused(2, executor, 1)` then `Executed(…, paid = false)`; one Transfer leg only | [`0xf4cdeb75…71b7`](https://explorer.arc.io/tx/0xf4cdeb7523c64082f9e09fa3bf738fd676bad1ef401c4f7c9622d0d41c3d71b7) — gasUsed 60180, metered 60186, drift -6, ratio 1.000100 (the executor is over-refunded by 6 gas ≈ $0.0000001 on this branch) |
| **Executor above `maxGasPrice`** (`capped`, #3: cap 20 Gwei, sent at maxFee 30 / priority 10) | refund priced at 20 Gwei while the receipt's `effectiveGasPrice` is 30 Gwei → the executor eats the difference | [`0x76d50864…3eaf`](https://explorer.arc.io/tx/0x76d508646679f86e55fbd50fe05b614a61cfa2cfa2721162abe7665f92343eaf) — gasUsed 58164, metered 58164, drift 0, price 20 vs egp 30, refund 0.00116328 vs fee 0.00174492, ratio 0.6667, net 0.009418360000000001 (tip 0.01 − 0.00058 eaten) |
| **Execute before due** (`NotDue`, #6: a 1-hour order) | reverts `NotDue(nextDue)`; nothing moves. An executor that simulates first sees it for free: `eth_call` at block 21490149 returns `0x12d2fbb9…` = `NotDue(1789733066)` | run 1 [`0x7793ef45…51aa`](https://explorer.arc.io/tx/0x7793ef458e2705c12a853a3b2ed9dcb26dfc0cd15ea190cdf7f67bb0f7ac51aa) (drift 0) · then a forced execute with a fixed gas limit [`0x703f54c8…c9f6`](https://explorer.arc.io/tx/0x703f54c8d7b65de8d8031f60a5a917e52e77551acf1d2ba701c0e3c78264c9f6) — **status 0, 24323 gas, 0.00048646 USDC lost by the executor who did not simulate** · cancel [`0x19a81aa3…7f47`](https://explorer.arc.io/tx/0x19a81aa3185f0b6d1819b4602ee4e97b5b7bdc29a2164300eade5e97798b7f47) |
| Executor above `2 × basefee` | refund capped at `2 × basefee` whatever `maxGasPrice` says | Foundry (`test_execute_priceCappedAtTwiceBasefee`, `testFuzz_priceCapHoldsOverFullRange`) — documented only on mainnet: the base fee was 20 Gwei all day and a 40+ Gwei run would only prove what the fuzz already does |
| Deposit cannot cover `amount + tip + reserve` | reverts `Underfunded(have, need)` — **never a partial payment**; the page says "top up ≥ X" | Foundry (`test_execute_revertsUnderfundedNeverPartial`); the `live` order reaches this state after its third run |
| Pricey executor on an exactly-funded order | `Underfunded` for an executor pricing above base fee, `Due` for one at base fee (the pre-check uses the executor's own price) | Foundry (`test_execute_preCheckUsesExecutorsOwnPrice`) |
| Re-entrant payee | the transient guard reverts the inner `execute`; a payee that propagates it fails and pauses the order; one that swallows it is paid once | Foundry (`test_execute_reenteringPayeeIsBlocked`) |
| Executor is a contract whose `receive` reverts | whole `execute` reverts `PayoutFailed`; no state change | Foundry (`test_execute_refusingExecutorRevertsWhole`) |
| Executor is a contract that works in `receive` | allowed; that work is after the measurement point and is not refunded | Foundry (`test_execute_contractExecutorsReceiveIsNotMetered`) |
| Same-second double execute | second reverts `NotDue` (Arc timestamps are non-decreasing; the schedule compares `≥`) | Foundry (`test_execute_sameTimestampSecondCallRevertsNotDue`) |
| Missed periods | owed and caught up one per execute; the page shows "N periods are owed" | Foundry (`test_execute_missedPeriodsAreCaughtUpOnePerExecute`) |
| Cancel with a period due | the entire remainder returns to the payer, owed period unpaid | [`0x17942d06…786f`](https://explorer.arc.io/tx/0x17942d06a5be8bee2f02ee379a15ef4d1c8818d62b6ce69a56da90a60b9b786f) (order #4, cancelled from the page) · [`0x32615c3c…b57f`](https://explorer.arc.io/tx/0x32615c3ceeeaf5b59380e7dae646f40fc3f5a9bf497d97b02f690f75b9d0b57f) (bench) |
| Runtime-blocklisted payee | same pause path as a refusing contract — Arc lets a native transfer revert "even when the sender has sufficient balance" | tested by construction (the `Rejector` row); we hold no address the protocol refuses to pay |
| First payment to a never-seen payee | +25,000 gas new-account cost — metered, so refunded; the ratio holds | the demo payee was pre-funded 0.001 ([`0x63087270…57f2`](https://explorer.arc.io/tx/0x63087270e751ba502876679396aef9872b14ebb2a92244b8da57c230d82a57f2)) so the rows above are representative; the Foundry executor-comparison test shows the 25k appearing in `metered` |

## The page did it too

Order #4 was created from the form, executed from the button and cancelled from the payer panel by a headless browser whose injected
provider forwarded `eth_sendTransaction` to a signer — the page's own code path, no script shortcut:
create [`0x32e3c9d5…f5c8`](https://explorer.arc.io/tx/0x32e3c9d59d25d31b2f01000cf1fb4f636389ae2ca3116b170e13e6ea0d59f5c8) → execute [`0xbe115310…6149`](https://explorer.arc.io/tx/0xbe115310fd76f686c2bc8ee6a3d846f3c5a39561522898d166834d9047736149) (gasUsed 58030, metered 58030, drift 0, ratio 1.000000) → cancel [`0x17942d06…786f`](https://explorer.arc.io/tx/0x17942d06a5be8bee2f02ee379a15ef4d1c8818d62b6ce69a56da90a60b9b786f).
Create → receipt on screen took three blocks of chain time; the whole flow is under a minute.

## Calibration — how `OVERHEAD` was measured

The measured window is `g0 − gasleft()`; everything outside it (intrinsic 21,000, calldata, the refund call, the event, the guard reset)
is one constant. A first deploy [`0xaf02db00…6a5a`](https://explorer.arc.io/tx/0xaf02db00fd6336ddd2946619b80226a51b08e0abb0149084593dd3f2550a6a5a) with `OVERHEAD = 31400` (the pre-build estimate) ran a scratch order three times:

| run | gasUsed | metered | drift |
|---|---|---|---|
| [`0xc97ed057…5535`](https://explorer.arc.io/tx/0xc97ed05731a9911c8bb913bffb9e48bfc2a5ff27e16451a18232e55ac2345535) | 58030 | 56927 | 1103 |
| [`0x1a9cbf7c…12c8`](https://explorer.arc.io/tx/0x1a9cbf7cee62a313b17b9db7c773a6843b53172282435c5bb4f7b7a49b1f12c8) | 58030 | 56927 | 1103 |
| [`0xf56ee66c…fc8a`](https://explorer.arc.io/tx/0xf56ee66c5b8ab8f1bf89429e0b0e91bda3f19055de1dbddcd47b02c8d072fc8a) | 58030 | 56927 | 1103 |

Drift was a constant 1,103 gas (spread 0), so the production contract [`0xc79a26e0…af68`](https://explorer.arc.io/tx/0xc79a26e0b241ca64a5d683c020abe7032bd518d1052c28ade0705655c98eaf68) was deployed with the same bytecode and
`OVERHEAD = 31400 + 1103 = 32503`. Since then: 36 production executes, drift 0 on 35 of them and −6 on the paused branch. The scratch order was cancelled [`0x3af4a231…d8c4`](https://explorer.arc.io/tx/0x3af4a231d8c759050f2650ca18a9924306eabd2740f94ad79c22bf937f03d8c4).

## Deploys and setup

| What | Address / hash |
|---|---|
| Legwork (production, `OVERHEAD` 32503) | `0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2` · [`0xc79a26e0…af68`](https://explorer.arc.io/tx/0xc79a26e0b241ca64a5d683c020abe7032bd518d1052c28ade0705655c98eaf68) · 984,847 gas · runtime keccak `0x81ae63c2a4db4b0f…` — `python3 scripts/preflight.py --bytecode` reproduces the match |
| Legwork (calibration, `OVERHEAD` 31400) | `0x16B4101605c496C7Fbe54490C6467eeF996EA775` · [`0xaf02db00…6a5a`](https://explorer.arc.io/tx/0xaf02db00fd6336ddd2946619b80226a51b08e0abb0149084593dd3f2550a6a5a) · balance 0 after the scratch cancel |
| Rejector (refusing demo payee) | `0x1c17C16177f2aC609440ea20c00D0e108F617c47` · [`0x27fd24f5…fd00`](https://explorer.arc.io/tx/0x27fd24f5a2069bf69cdda497f421eb2c2e515ab7b60a26c765093e98000dfd00) |
| Demo payee pre-fund (0.001) | [`0x63087270…57f2`](https://explorer.arc.io/tx/0x63087270e751ba502876679396aef9872b14ebb2a92244b8da57c230d82a57f2) |
| `live` #1 / `rejecting` #2 / `capped` #3 creates | [`0xe43cfe61…3a9e`](https://explorer.arc.io/tx/0xe43cfe61e4c3310f0577cbca8e1ddf05851cdfe93ec63c902a02ba37e0343a9e) / [`0x6d9989fc…daf5`](https://explorer.arc.io/tx/0x6d9989fc5e6622d6dd6df96a98c860c472a28a5130651daa05fe36bd7fffdaf5) / [`0xff7344dd…3997`](https://explorer.arc.io/tx/0xff7344dd8b19f6a593567bcfffb139421f409cb883b1db1c0bc7740ee5383997) |

Explorer source verification was not attempted from a script (the explorer's API sits behind a Cloudflare challenge); the bytecode
identity above is the substitute, and anyone can rerun it.

## Spend

Gas actually paid to block producers across the whole build — 55 transactions: two deploys, the Rejector, one pre-fund, 7 creates, 40 executes (39 successful + the reverted one), 4 cancels — **0.1081 USDC** (Σ `gasUsed × effectiveGasPrice` over the 55 files in `proof/receipts/`).
Deposits still open in the demo orders: 0.1365 USDC (they drain to whoever executes — that is the point). Amounts and tips that moved
between the builder's own wallets are not spend. Wallet before / after the build: 0.617448 → 0.305364 USDC, of which 0.1365 sits in the
contract and 0.0675 in the demo payee.
