# Demo & proof — Legwork on Arc mainnet

Everything below happened on **Arc mainnet (chain 5042)** on 2026-09-18, sent from the builder's wallet `0xA8965A47c9b6ed34F47B374f36cF6c752D24852a` (payer,
deployer and most executions) and, for five bench rows, from the demo payee's own wallet `0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60`.
Every hash links to the explorer and has its receipt committed under [`proof/receipts/`](./proof/receipts/); `npm run recheck`
recomputes each one. Nothing here is simulated, mocked, or from a testnet.

Production contract **`0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb`** ([explorer](https://explorer.arc.io/address/0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb)) · `OVERHEAD = 32503` ·
demo payee `0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60` · refusing payee `Rejector` `0x1c17C16177f2aC609440ea20c00D0e108F617c47` · two earlier deploys kept in the record (calibration `0x16B4101605c496C7Fbe54490C6467eeF996EA775`, v1 `0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2` — see *Corrections*).

## The receipt this project exists for

The `live` order (#1: 0.02 USDC to the demo payee every 60 s, tip 0.01, deposit 0.10) on its first run, [`0x0a598c84…d04d`](https://explorer.arc.io/tx/0x0a598c846c6a6fd0e9f07fcee1f6d643d39bb2c2483ae0e3465ee3c6775cd04d), block 21493741:

```
payee received     0.02 USDC        Transfer 0x8E2F… → 0x352e…   (20000000000000000 wei)
executor refunded  0.0011683 USDC   Executed.refund = 58415 gas × 20 Gwei (1168300000000000 wei)
executor tipped    0.01 USDC        Executed.tip
real fee paid      0.0011683 USDC   receipt.gasUsed 58415 × effectiveGasPrice 20 Gwei — from the receipt, not from us
net                +0.01 USDC        drift = gasUsed − gasMetered = 0 gas · refund ÷ fee = 1.000000
```

The contract's own number for what the transaction cost and the receipt's number are the same to the wei. That is the whole claim;
the rest of this file is how often it held (36 production executes: drift 0 on 35, −6 gas on the one refused payment — and the same
on the 36 runs of the retired v1) and what happens when things go wrong.

## Try it in 30 seconds (any wallet holding a few cents of USDC on Arc)

1. Open `https://edycutjong.github.io/legwork-arc/#/o/1` (or run the page locally: `npm install && npm run dev`).
2. Press **Execute — anyone can**. The page sends `execute(1)` with priority 0 at `max(eth_gasPrice, 20 Gwei)`.
3. Read the receipt: the payee got 0.02 USDC, you got the metered gas back plus 0.01 USDC, and the real fee from the receipt is printed beside the refund.

The `live` order was funded for three runs; one was used above, so two are left for reviewers, first come — the order has been due since 2026-09-18 and the missed periods are owed, so one wallet can take both back-to-back (then it reads *Underfunded — top up ≥ 0.026*, which is also a state worth seeing).
**Prerequisite:** USDC on Arc in your wallet. Getting it there from another chain is Circle's bridge (CCTP), not part of this project.

**Build your own in 60 seconds:** *New order* → payee, amount, interval, tip → **Create** (the reserve is quoted from the latest base fee) → the order card opens Due → **Execute**.

## Reproduce

```sh
git clone https://github.com/edycutjong/legwork-arc && cd legwork-arc
git submodule update --init          # forge-std
forge test                            # 42 Foundry cases: unit + 2 fuzz suites + 6 invariants (≈ 1 s)
npm install && npm test               # 34 vitest cases; the receipt decoder's fixtures are committed mainnet receipts (≈ 1 s)
npm run recheck                       # recompute every committed execute receipt from raw data; exit code is the verdict (read-only, ≈ 40 s)
python3 scripts/preflight.py --bytecode   # readiness gate + on-chain runtime code == forge build with the immutable filled
npm run bench -- --n 5                # ≈ a cent of real gas: creates, runs 5×, cancels its own order; needs a funded keystore (see .env.example)
```

`npm run recheck` output today: `75 execute receipts (36 on the production contract, 36 on the retired v1, 3 calibration) … production drift: min -6 max 0 gas … all checks passed`.

## Headline number

**Refund ÷ real fee = 1.000000 on all 30 bench rows** (pre-stated invariant: 1.00 ± 0.02), with **drift = 0 gas on every row** (gate: ≤ 50).
`gasUsed` p50 **58415** · p95 **58415** (min 55915, the payee-as-executor rows) · real fee p50 **0.0011683 USDC** at a 20 Gwei base fee ·
executor net after tip p50 **+0.0001 USDC** = exactly the 0.0001 tip.

## Bench — 30 consecutive real executes, one order, 1-second periods

`npm run bench` · order #6 · create [`0xbce08fa7…b3b2`](https://explorer.arc.io/tx/0xbce08fa767781e6c40c28827b046292def95039009e5b4aa94bf1f3f6b8bb3b2) · rows in [`proof/rows.csv`](./proof/rows.csv) · summary [`proof/results.json`](./proof/results.json) · cancelled [`0x37635a18…19cb`](https://explorer.arc.io/tx/0x37635a1876d2c63e731a0cdc64cfd2030a127f09553cf9c0809e343cdf5219cb) (0.040701 USDC returned).
Order: payee = demo payee · 0.001 USDC · every 1 s · tip 0.0001 · maxGasPrice 100 Gwei · deposit 0.1085 (31 × the honest reserve). Blocks 21494271 → 21494351.

| rows | executor | gasUsed p50 / p95 | drift | price == effectiveGasPrice | ratio | executor net |
|---|---|---|---|---|---|---|
| 1–25 | the payer wallet [`0xA896…852a`](https://explorer.arc.io/address/0xA8965A47c9b6ed34F47B374f36cF6c752D24852a) | 58415 / 58415 | 0 on every row | yes, 20 Gwei on every row | 1.000000 | +0.0001 USDC (the tip) |
| 26–30 | **the payee itself** [`0x352e…AA60`](https://explorer.arc.io/address/0x352e5cDea885DBCAbe850259CA8AA6759b5aAA60), collecting its own payment | 55915 / 55915 | 0 on every row | yes | 1.000000 | +0.0001 USDC |

First row [`0xf4c46a62…4164`](https://explorer.arc.io/tx/0xf4c46a623add8bd7d1835dd128b7cfb6917900553568168ab6f9513e12734164) (block 21494271) · last row [`0x43069dce…440d`](https://explorer.arc.io/tx/0x43069dce9d262d1baaf5367fb41546830b67ce7a7b8cd4b9ff9bdfa1c9ce440d) (block 21494351) · every row's hash is in `rows.csv` and `proof/receipts/`.
The payee's rows cost 2,500 gas less because the payee is `tx.origin` and therefore already warm — and the meter caught that too (drift 0).

Methodology: no randomness to seed — the fixed inputs are the order parameters above and priority 0. p50/p95 are over the 30 rows; there is no warm-up to discard because there is no cache (each run is its own transaction). Limitation: all rows are at a 20 Gwei base fee (the only base fee observed on Arc that day), so the `2 × basefee` cap never bound in the bench; the cap is exercised by the `capped` row below and by the Foundry tests. The same bench on the retired v1 (`proof/receipts/`, rows not kept as a table) gave the same picture: 30/30 drift 0, p50 58,030.

## Edge cases — one mainnet transaction per row

| Case | What the contract does | Receipt |
|---|---|---|
| Happy path (`live`, #1) | pays 0.02, refunds 58415 × 20 Gwei, tips 0.01, `nextDue += 60` | [`0x0a598c84…d04d`](https://explorer.arc.io/tx/0x0a598c846c6a6fd0e9f07fcee1f6d643d39bb2c2483ae0e3465ee3c6775cd04d) — gasUsed 58415, metered 58415, drift 0, ratio 1.000000 |
| **Payee refuses** (`rejecting`, #2 → `Rejector`, whose `receive` reverts) | order **pauses**; the unpaid 0.01 stays in the deposit; the executor is still refunded 60571 × 20 Gwei + tipped 0.01; `Paused(2, executor, 1)` then `Executed(…, paid = false)`; one Transfer leg only | [`0xd07f9fb9…dc64`](https://explorer.arc.io/tx/0xd07f9fb9f06deeab35a0e795ab0440f8150fb60e4f816993d57bee6a1470dc64) — gasUsed 60565, metered 60571, drift -6, ratio 1.000099 (the executor is over-refunded by 6 gas ≈ $0.0000001 on this branch) |
| **Executor above `maxGasPrice`** (`capped`, #3: cap 20 Gwei, sent at maxFee 30 / priority 10) | refund priced at 20 Gwei while the receipt's `effectiveGasPrice` is 30 Gwei → the executor eats the difference | [`0x6595b5a6…3c98`](https://explorer.arc.io/tx/0x6595b5a60548ab65b879f9012142764f3118d582fdc29d5dc8da2b457d413c98) — gasUsed 58549, metered 58549, drift 0, price 20 vs egp 30, refund 0.00117098 vs fee 0.00175647, ratio 0.6667, net 0.00941451 (tip 0.01 − 0.00058549 eaten) |
| **Execute before due** (`NotDue`, #7: a 1-hour order) | reverts `NotDue(nextDue)`; nothing moves. An executor that simulates first sees it for free: `eth_call` returned `NotDue(1789736240)` = creation timestamp + 3600 | run 1 [`0xb0f24f9e…7399`](https://explorer.arc.io/tx/0xb0f24f9ec801c2e68b010666a3954f6aab63e6549ba8f6761d5ee38faca87399) (drift 0) · then a forced execute with a fixed gas limit [`0x4fc9a3af…56a6`](https://explorer.arc.io/tx/0x4fc9a3af02079e9bad40001108936c268a8269c88c231e6633517db854f556a6) — **status 0, 24323 gas, 0.00048646 USDC lost by the executor who did not simulate** · cancel [`0x2bfaeae7…21d0`](https://explorer.arc.io/tx/0x2bfaeae7fc0fada15c8779561dacc774df68f399385157434627c879fad221d0) |
| Executor above `2 × basefee` | refund capped at `2 × basefee` whatever `maxGasPrice` says | Foundry (`test_execute_priceCappedAtTwiceBasefee`, `testFuzz_priceCapHoldsOverFullRange`) — documented only on mainnet: the base fee was 20 Gwei all day and a 40+ Gwei run would only prove what the fuzz already does |
| Deposit cannot cover `amount + tip + reserve` | reverts `Underfunded(have, need)` — **never a partial payment**; the page says "top up ≥ X" | Foundry (`test_execute_revertsUnderfundedNeverPartial`); the `live` order reaches this state after its third run |
| Pricey executor on an exactly-funded order | `Underfunded` for an executor pricing above base fee, `Due` for one at base fee (the pre-check uses the executor's own price) | Foundry (`test_execute_preCheckUsesExecutorsOwnPrice`) |
| A contract executor batches several orders in one transaction | the 21,000 intrinsic is credited to the first execute of the transaction only; later ones meter without it | Foundry (`test_execute_batchedExecutorIsChargedTheIntrinsicOnce`) — the v1 → v2 fix, see *Corrections* |
| An executor sends too little gas to a working contract payee | cannot pause it: the 63/64 rule makes the outer call fail too — every gas limit either reverts or pays | Foundry (`test_execute_gasStarvationCannotPauseAWorkingPayee`, 200 gas limits swept) |
| A contract payee that needs more than the 30k stipend | is paused on every run; each `resume` costs the payer one refund + tip — a documented limitation | Foundry (`test_execute_payeeNeedingMoreThanTheStipendIsAlwaysPaused`) |
| Re-entrant payee (`execute`, `topUp`, `resume`, `cancel` from inside a payment) | the transient guard reverts the inner call; a payee that propagates it fails and pauses the order; one that swallows it is paid once | Foundry (`test_execute_reenteringPayeeIsBlocked`, `test_reentrancy_topUpAndResumeFromInsideExecuteAreBlocked`, `test_execute_contractExecutorCannotReenterCancel`) |
| Executor is a contract whose `receive` reverts | whole `execute` reverts `PayoutFailed`; no state change | Foundry (`test_execute_refusingExecutorRevertsWhole`) |
| Executor is a contract that works in `receive` | allowed; that work is after the measurement point and is not refunded | Foundry (`test_execute_contractExecutorsReceiveIsNotMetered`) |
| Same-second double execute | second reverts `NotDue` (Arc timestamps are non-decreasing; the schedule compares `≥`) | Foundry (`test_execute_sameTimestampSecondCallRevertsNotDue`) |
| Missed periods | owed and caught up one per execute; the page shows "N periods are owed" | Foundry (`test_execute_missedPeriodsAreCaughtUpOnePerExecute`) |
| Cancel with a period due, cancel of a paused order | the entire remainder returns to the payer, owed period unpaid | [`0x7f511793…8675`](https://explorer.arc.io/tx/0x7f51179362b3772d6cd36a44e7053fe57e1fc9790dbad380ac81770ab0e88675) (order #4, cancelled from the page) · [`0x37635a18…19cb`](https://explorer.arc.io/tx/0x37635a1876d2c63e731a0cdc64cfd2030a127f09553cf9c0809e343cdf5219cb) (bench) · Foundry (`test_cancel_pausedOrderReturnsTheRemainder`) |
| Runtime-blocklisted payee | same pause path as a refusing contract — Arc lets a native transfer revert "even when the sender has sufficient balance" | tested by construction (the `Rejector` row); we hold no address the protocol refuses to pay |
| First payment to a never-seen payee | +25,000 gas new-account cost — metered, so refunded; the ratio holds | the demo payee was pre-funded 0.001 ([`0x63087270…57f2`](https://explorer.arc.io/tx/0x63087270e751ba502876679396aef9872b14ebb2a92244b8da57c230d82a57f2)) so the rows above are representative; `test_execute_newAccountCostIsInsideTheWindow` shows the 25k appearing in `metered` |

## The page did it too

Order #4 was created from the form, executed from the button and cancelled from the payer panel by a headless browser whose injected
provider forwarded `eth_sendTransaction` to a signer — the page's own code path, no script shortcut:
create [`0xe5f88cca…b279`](https://explorer.arc.io/tx/0xe5f88cca0b5e3684b0f98cc746c4db2d07c7734a27a3e5f360b5ed438d65b279) → execute [`0xf71fffd0…7154`](https://explorer.arc.io/tx/0xf71fffd0f3dee7e43f9df1ba87bc7f954e97d29d42a59435ead45485b5dd7154) (gasUsed 58415, metered 58415, drift 0, ratio 1.000000) → cancel [`0x7f511793…8675`](https://explorer.arc.io/tx/0x7f51179362b3772d6cd36a44e7053fe57e1fc9790dbad380ac81770ab0e88675).
Create → receipt on screen: **9.7 s** wall clock (4.7 s to the order card) — timed by the harness and recorded in `deploy/arc-mainnet.json`; the receipts prove the transactions, not the stopwatch. The harness was accidentally run twice; the repeat (order #5:
[`0x52d964dc…0bc7`](https://explorer.arc.io/tx/0x52d964dc80968c71a55784c8a7535eff63c6755862883dd6002329c13c2b0bc7) → [`0x2f6a352d…0c95`](https://explorer.arc.io/tx/0x2f6a352d11823a37ad085151067856131833ef978445fbed5941e7d17b5b0c95), drift 0 → [`0x86637f32…f75d`](https://explorer.arc.io/tx/0x86637f322dab1cea08ed60cc4ea487204042f7eb5b19bfecc4b968dc6595f75d)) is kept because it happened.

## Calibration — how `OVERHEAD` was measured

The measured window is `g0 − gasleft()`; everything outside it (intrinsic 21,000, calldata, the refund call, the event, the guard reset)
is one constant. A first deploy [`0xaf02db00…6a5a`](https://explorer.arc.io/tx/0xaf02db00fd6336ddd2946619b80226a51b08e0abb0149084593dd3f2550a6a5a) with `OVERHEAD = 31400` (the pre-build estimate) ran a scratch order three times:

| run | gasUsed | metered | drift |
|---|---|---|---|
| [`0xc97ed057…5535`](https://explorer.arc.io/tx/0xc97ed05731a9911c8bb913bffb9e48bfc2a5ff27e16451a18232e55ac2345535) | 58030 | 56927 | 1103 |
| [`0x1a9cbf7c…12c8`](https://explorer.arc.io/tx/0x1a9cbf7cee62a313b17b9db7c773a6843b53172282435c5bb4f7b7a49b1f12c8) | 58030 | 56927 | 1103 |
| [`0xf56ee66c…fc8a`](https://explorer.arc.io/tx/0xf56ee66c5b8ab8f1bf89429e0b0e91bda3f19055de1dbddcd47b02c8d072fc8a) | 58030 | 56927 | 1103 |

Drift was a constant 1,103 gas (spread 0), so `OVERHEAD = 31400 + 1103 = 32503`. The v1 deploy [`0xc79a26e0…af68`](https://explorer.arc.io/tx/0xc79a26e0b241ca64a5d683c020abe7032bd518d1052c28ade0705655c98eaf68) carried it and metered
36 runs (drift 0 on 35, −6 on the paused branch, e.g. [`0x651700ee…5f0b`](https://explorer.arc.io/tx/0x651700ee3f058685b0cdb896a707f5e5e7e8c507076a3f0f4d6816f3d6e25f0b): gasUsed 58030 = metered). The v2 deploy [`0xe2319949…dfe3`](https://explorer.arc.io/tx/0xe2319949877acaebdea9273aa7d866c0a10048d3d2f14ab6618e9a0c25fcdfe3)
changes only code *inside* the measured window (the once-per-transaction intrinsic credit), so the same constant holds: drift 0 / −6 / 0 on its seed runs and 0 on all 30 bench rows.

## Corrections

- **2026-09-18 — v1 → v2.** The second audit round found that `OVERHEAD` credits the transaction's 21,000 intrinsic on *every* `execute`
  call, so a contract executor batching K orders in one transaction was over-refunded 21,000 × (K − 1) gas — bounded by each order's
  reserve, never exploited (the only executors were the builder's two wallets), but not "exact". v2 (`0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb`) credits the intrinsic to
  the first execute of a transaction only (a transient flag). v1 (`0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2`) had its three demo orders cancelled ([`0x2dce1556…f68a`](https://explorer.arc.io/tx/0x2dce155699a4207d4fab443a5156d641fbdba922bff52d81bb5b620a49adf68a), [`0x691521c5…3049`](https://explorer.arc.io/tx/0x691521c568624929f7e60818f1118d645bf27398e57d3bbeb051703a42fa3049), [`0x3f5028ca…bed5`](https://explorer.arc.io/tx/0x3f5028ca725d020fd83fb388f8b438dad350c660387bfa34cb1b334c6ab8bed5)) and holds 0; its 36 execute receipts stay in `proof/receipts/` and `npm run recheck` still checks them.
- 2026-09-18 — `OVERHEAD` estimate 31,400 → measured 32,503 (above). The wrong number stays visible in `deploy/arc-mainnet.json` and the calibration receipts.
- 2026-09-18 — the paused branch meters 6 gas over: the executor is over-refunded by 120 Gwei ≈ $0.0000001 on a refused payment. Inside the gate; left as is.
- 2026-09-18 — on v1, one execute meant as a `NotDue` demonstration landed as a normal run (a second had passed on a 1-second order); the revert was reproduced on a 1-hour order instead, on both v1 and v2.

## Deploys and setup

| What | Address / hash |
|---|---|
| Legwork v2 (production, `OVERHEAD` 32503) | `0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb` · [`0xe2319949…dfe3`](https://explorer.arc.io/tx/0xe2319949877acaebdea9273aa7d866c0a10048d3d2f14ab6618e9a0c25fcdfe3) · 1,008,235 gas · runtime keccak `0x9ddc2eaf43975626…` — `python3 scripts/preflight.py --bytecode` reproduces the match |
| Legwork v1 (retired, `OVERHEAD` 32503) | `0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2` · [`0xc79a26e0…af68`](https://explorer.arc.io/tx/0xc79a26e0b241ca64a5d683c020abe7032bd518d1052c28ade0705655c98eaf68) · balance 0 after its orders were cancelled |
| Legwork calibration (`OVERHEAD` 31400) | `0x16B4101605c496C7Fbe54490C6467eeF996EA775` · [`0xaf02db00…6a5a`](https://explorer.arc.io/tx/0xaf02db00fd6336ddd2946619b80226a51b08e0abb0149084593dd3f2550a6a5a) · balance 0 after the scratch cancel |
| Rejector (refusing demo payee) | `0x1c17C16177f2aC609440ea20c00D0e108F617c47` · [`0x27fd24f5…fd00`](https://explorer.arc.io/tx/0x27fd24f5a2069bf69cdda497f421eb2c2e515ab7b60a26c765093e98000dfd00) |
| Demo payee pre-fund (0.001) | [`0x63087270…57f2`](https://explorer.arc.io/tx/0x63087270e751ba502876679396aef9872b14ebb2a92244b8da57c230d82a57f2) |
| v2 `live` #1 / `rejecting` #2 / `capped` #3 creates | [`0xa2b0ad0c…2157`](https://explorer.arc.io/tx/0xa2b0ad0c2c649593b7f76493440f49e84c6399c60c1662f6f4148b12b4a72157) / [`0x8ed04738…7d82`](https://explorer.arc.io/tx/0x8ed047381c404dcb58fc0076ec4105a323be2deeff112ff2212226596df27d82) / [`0xe7d33616…44f8`](https://explorer.arc.io/tx/0xe7d33616540f9055ea1b5cd6bc9140e1776a94734a93619b967fccc05dfb44f8) |

Explorer source verification was not attempted from a script (the explorer's API sits behind a Cloudflare challenge); the bytecode
identity above is the substitute, and anyone can rerun it.

## Spend

Gas actually paid to block producers across the whole build — 107 transactions (three deploys, the Rejector, one pre-fund, creates, executes incl. the two reverted ones, cancels):
**0.1944 USDC** (Σ `gasUsed × effectiveGasPrice` over `proof/receipts/` = 0.19437713). Deposits open in the v2 demo orders: 0.1365 USDC (they drain to
whoever executes — that is the point). Amounts and tips that moved between the builder's own wallets are not spend.
