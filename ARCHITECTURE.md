# Architecture — as built

One contract, one static page, three scripts. No backend, no database, no indexer, no keeper registry. Everything below is
taken from the code in this repository; line numbers refer to `contracts/Legwork.sol`.

## The contract (`contracts/Legwork.sol`, 212 lines)

```solidity
struct Order {
  address payer;  uint48 nextDue;      uint32 interval;   bool paused;   // slot 0
  address payee;  uint48 createdBlock; uint48 maxGasPrice;               // slot 1
  uint96  amount; uint96 tip;                                            // slot 2 (native wei)
  uint128 deposit;                                                       // slot 3 (native wei)
}
uint256 public immutable OVERHEAD;                 // 32503 on mainnet — gas outside the measured window
uint256 public constant PAYEE_GAS       = 30_000;  // stipend forwarded with the payee's payment
uint256 public constant REFUND_CEIL_GAS = 120_000; // clamp on metered gas; also the per-run reserve
uint256 public constant EXECUTOR_GAS    = 30_000;  // stipend forwarded with the executor's payout
uint256 public constant INTRINSIC_GAS   = 21_000;  // the part of OVERHEAD a transaction pays once
uint256 private transient _lock;                   // re-entrancy guard (tstore/tload)
uint256 private transient _txSeen;                 // set by the first execute of a transaction

function create(address payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice) external payable returns (uint256 id);
function execute(uint256 id) external;        // anyone
function topUp(uint256 id) external payable;  // payer
function resume(uint256 id) external;         // payer; paused -> false, nextDue = now
function cancel(uint256 id) external;         // payer; delete + return the whole deposit
function needed(uint256 id)   view returns (uint256); // amount + tip + REFUND_CEIL_GAS * min(basefee, maxGasPrice)
function priceCap(uint256 id) view returns (uint256); // min(2 * basefee, maxGasPrice)
function status(uint256 id)   view returns (uint8);   // 0 None · 1 Due · 2 Waiting · 3 Underfunded · 4 Paused
```

Events: `Created`, `Executed(id, executor, gasMetered, price, refund, tip, nextDue, paid)` (fixed width, emitted after the
measurement point on both branches), `Paused(id, executor, reason)` (emitted *before* the measurement point so its cost is
metered), `Resumed`, `ToppedUp`, `Cancelled`. Errors: `NoOrder NotPayer IsPaused NotDue(nextDue) Underfunded(have, need)
BadParams Reentrant PayoutFailed`.

### `execute`, line by line (lines 132–171)

```
1   uint256 g0 = gasleft();                                   // first statement of the function
2   guard: if (_lock != 0) revert Reentrant(); _lock = 1;    // transient storage
3   load order; NoOrder / IsPaused / NotDue(nextDue) checks
    if (_txSeen == 0) { _txSeen = 1; g0 += INTRINSIC_GAS; }   // the intrinsic is credited to the first execute of a tx only
4   price = tx.gasprice; cap at 2 * block.basefee; cap at o.maxGasPrice
5   need  = amount + tip + REFUND_CEIL_GAS * price; if (deposit < need) revert Underfunded(deposit, need)
6   nextDue += interval; deposit -= amount + tip; write both     // effects before interaction
7   (paid,) = payee.call{value: amount, gas: PAYEE_GAS}("")
8   if (!paid) { o.paused = true; deposit += amount; emit Paused(id, msg.sender, 1); }
9   metered = g0 - gasleft() + (OVERHEAD - INTRINSIC_GAS); clamp at REFUND_CEIL_GAS   // measurement point — nothing variable after this
10  refund  = metered * price; bound by deposit
11  o.deposit = deposit - refund
12  (ok,) = msg.sender.call{value: refund + tip, gas: EXECUTOR_GAS}(""); if (!ok) revert PayoutFailed()
13  emit Executed(id, msg.sender, metered, price, refund, tip, nextDue, paid)
14  _lock = 0
```

Why the drift is a constant: everything after line 9 is one value call with a fixed stipend, one six-word event, one
`tstore` and the return; everything before it is inside the window. The only inputs that can move `gasUsed` without
moving `metered` are calldata bytes (16 gas per non-zero byte of `id`, 4 per zero byte) and a contract executor's own code (its CALL into
`execute`, its `receive`), which it pays for itself; the 21,000 intrinsic, which a transaction pays once however many orders it
runs, is credited to the first `execute` of the transaction only (`_txSeen`). Measured: drift 0 on 35 of 36 production runs
and −6 on the paused branch (the taken jump and the `paid = false` word) — on v1 and again on v2.

## Invariants — each one is a test

| # | Statement | Where it is checked |
|---|---|---|
| I1 | Every wei that entered is still deposited or left through exactly one of payee / executor / cancel legs; `balance == Σ open deposits` | `test/Legwork.invariants.t.sol` `invariant_I1_depositConservation` (64 runs × 32 calls with a refusing payee in the mix); `testFuzz_refundArithmeticBenignPayee` |
| I2 | Executor net after tip ≥ tip − drift × price for an EOA executor | mainnet only (Foundry's single-transaction warm state cannot reproduce receipt `gasUsed`): 30/30 bench rows net = tip exactly; `npm run recheck` gates drift ≤ 50 |
| I3 | `Executed.price == min(tx.gasprice, 2·basefee, maxGasPrice)` and the executor receives exactly `refund + tip` | `invariant_I3_priceCap`, `testFuzz_priceCapHoldsOverFullRange` (full `uint48` range), `test_execute_priceCappedAt*`; `recheck` equality on every mainnet row |
| I4 | Never a partial payment: `paid == true` moved exactly `amount`; `paid == false` moved nothing and carries `Paused` | `invariant_I4_noPartialPayment`, `test_execute_revertsUnderfundedNeverPartial`, `test_execute_rejectingPayee…`; `recheck` (5) |
| I5 | Only the payer moves money out other than through `execute` | `invariant_I5_payerOnly`, `test_topUp_/resume_/cancel_payerOnly…` |
| I6 | One period per execute; same-second second call reverts `NotDue` | `invariant_I6_onePeriodPerExecute`, `test_execute_sameTimestamp…`, `test_execute_missedPeriods…`; mainnet `NotDue` receipt |
| I7 | The clamp never binds for a benign payee; deposit never underflows | `invariant_I7_clampNeverBindsForBenignPayee`, fuzz; `recheck` (4) |

42 Foundry cases (34 unit, 2 fuzz × 512 runs, 6 invariants × 64 runs × depth 32) · 32 vitest cases (the receipt decoder's fixtures are committed mainnet receipts).

## Residual risk — adversary → bound → check

| Adversary | What they can do | Bound | Check |
|---|---|---|---|
| Executor inflating `tx.gasprice` | drain the reserve faster (the surplus goes to the block beneficiary) | ≤ `2 × basefee` and ≤ `maxGasPrice` per run; ≤ `REFUND_CEIL_GAS × price` per run by the pre-check | `capped` receipt; cap tests |
| Executor who is also the block beneficiary | be paid the surplus twice (Arc does not burn the base fee) | ≤ 2× the honest fee per run; `maxGasPrice` is the payer's tighter bound | not a claim about who produces Arc's blocks |
| Payer with a refusing payee | costs an executor one attempt; the executor is repaid + tipped; the order pauses | one refund + one tip per pause | `rejecting` receipt |
| Payee that burns the whole 30k stipend | ≤ 30,000 gas extra per run, metered → refunded, inside the 120k clamp | ≈ $0.0006 per run at 20 Gwei | `test_execute_hungryPayee…` |
| Payee that needs more than 30k to accept | is never paid through Legwork: every run pauses | the payer loses one refund + tip per resume; documented limitation | `test_execute_payeeNeedingMoreThanTheStipendIsAlwaysPaused` |
| Contract executor whose `receive` reverts / burns gas | reverts the whole `execute` / pays for its own code | self-inflicted | tests |
| Contract executor batching K orders in one transaction | in v1, was over-refunded the 21,000 intrinsic K − 1 times (≈ 0.0004 USDC per extra order at 20 Gwei, inside each order's reserve) | v2 credits the intrinsic once per transaction; the ≈ 200 gas of per-call calldata it still shares is ≈ $0.000004 | `test_execute_batchedExecutorIsChargedTheIntrinsicOnce` |
| Executor starving a contract payee of gas to force a pause | cannot: the 63/64 rule makes the outer call fail whenever the payee's does | — | `test_execute_gasStarvationCannotPauseAWorkingPayee` |
| Same-block race between executors, or an execute landing after a cancel | the loser reverts (`NotDue` / `NoOrder`) and pays ≈ 24k gas; simulation does not prevent it | ≈ 0.0005 USDC per lost race | `NotDue` receipt |
| Payer contract whose `receive` refuses USDC | can never `cancel`; the deposit drains only through executors | self-inflicted | `test_cancel_revertsPayoutFailed…` |
| Integrator reading `status` / `needed` / `priceCap` through `eth_call` without a gas price | sees `Due`, a reserve of 0 and a cap of 0 (the RPC simulates at base fee 0) | views only; `execute` uses the real base fee and reverts `Underfunded` where the view said `Due` | pass `--gas-price` to `cast call`; the page computes from `baseFeePerGas` instead |
| Public RPC unavailable or no longer anonymous | the page cannot read; nothing on chain changes | one external dependency, no fallback | `docs/FRICTION-LOG.md` |
| `tx.gasprice ≠ effectiveGasPrice` on a future client | drift stops being constant | `recheck` equality (3) fails on the first such row | `scripts/recheck-receipts.ts` |
| Opcode repricing after a client upgrade | constant drift reappears | redeploy with a new constructor argument | calibration procedure in `DEMO.md` |

## The page (`src/`, Vite + TypeScript + viem, static `dist/`)

```
window.ethereum ──(sign only)──▶ src/app/wallet.ts ──▶ create / execute / topUp / resume / cancel
                                                            │
rpc.mainnet.arc.io ◀── src/app/rpc.ts ── eth_call orders/OVERHEAD · Multicall3 list (newest 200)
                       │                 (status / needed / priceCap are computed locally from baseFeePerGas — the contract's
                       │                  views read block.basefee, which an eth_call without a gas price sees as 0)
                       │                 eth_getBlockByNumber (baseFeePerGas) · eth_gasPrice
                       │                 eth_getLogs (≤ 9,000-block windows from BOTH ends — the head and createdBlock — 8 on open, more on demand)
                       │                 eth_getTransactionReceipt (one poll: finality is at inclusion)
                       ▼
src/lib/orders.ts   pure arithmetic: needed / priceCap / refundOf / status / runsLeft / foldEvents / usdc18
src/lib/receipt.ts  receipt → five lines (payee · refund · tip · real fee · net), drift, both EIP-7708 legs
src/lib/scan.ts     the bounded two-ended scanner (no RPC inside; tested with a stub)
src/app/views/home.ts   #/        new-order form (reserve quoted from the latest base fee) + open orders
src/app/views/order.ts  #/o/<id>  sheet · countdown · Execute (anyone) · receipt · runs · payer controls
```

Reading needs no wallet. The injected provider is touched only when the user signs; if Arc is missing it is offered with
`wallet_addEthereumChain` (0x13b2, symbol USDC, 18 decimals). Every transaction the page sends uses priority 0 and
`maxFeePerGas = max(eth_gasPrice, 20 Gwei)` — the honest executor's price, so the `2 × basefee` cap never binds for it.

## Scripts (`scripts/`, tsx + viem; keys decrypted from a Foundry keystore in a child `cast` process, never printed)

| Script | Role |
|---|---|
| `orders.ts` | seeds `live` / `rejecting` / `capped`, runs each once, prints the DEMO rows; `--not-due` produces the reverted receipt on a 1-hour order |
| `meter-bench.ts` | N consecutive real executes on one 1-second order (25 by the payer wallet + 5 by the payee), rows → `proof/rows.csv`, p50/p95 → `proof/results.json`, exit 1 if drift > 50 or ratio outside ± 0.02 |
| `recheck-receipts.ts` | read-only: recompute every committed execute receipt (six equalities), exit code is the verdict |
| `preflight.py` | readiness gate: counts, placeholders, private material, live URL, every DEMO hash has a receipt, `--bytecode` identity |

## What is deliberately not here

A keeper daemon (the page button and the bench script are the two executors that exist), batched execution (one order per
transaction keeps the metering exact), a paymaster (the order already repays the executor), ERC-20 allowances (the deposit is
native), a server of any kind.
