# Security Policy

## Supported versions
| Version | Supported |
|---|---|
| `main` and the deployed contract `0x8E2F8AFC29e9dc127103CD6AD5BCfBe661141ccb` (Arc mainnet, 5042) | ✅ |
| the retired v1 `0x68a92aF2Be2e6A640a19508a0fe44cbc8B2C62E2` and the calibration deploy | ❌ — hold no funds, kept in the record only |

## What the contract guarantees — and the test that proves each guarantee
| Guarantee | Proved by |
|---|---|
| Deposits are conserved: Σ open deposits == contract balance, always | `invariant_I1_depositConservation` (`test/Legwork.invariants.t.sol`, 64 runs × depth 32) |
| No executor is ever refunded above `min(tx.gasprice, 2 × basefee, order.maxGasPrice)` | `invariant_I3_priceCap`, `testFuzz_priceCapHoldsOverFullRange` (512 runs over the full `uint48` range), `test_execute_priceCappedAtTwiceBasefee`, `test_execute_priceCappedAtMaxGasPrice`, and the fast-check property on `priceOf` (5,000 cases) |
| Never a partial payment: `execute` reverts `Underfunded` unless `amount + tip + reserve` is covered | `invariant_I4_noPartialPayment`, `test_execute_revertsUnderfundedNeverPartial`, `test_execute_preCheckUsesExecutorsOwnPrice` |
| One period per execute; the schedule is anchored, never drifts | `invariant_I6_onePeriodPerExecute`, `test_execute_missedPeriodsAreCaughtUpOnePerExecute`, `test_execute_sameTimestampSecondCallRevertsNotDue` |
| Only the payer can top up, resume, cancel | `invariant_I5_payerOnly`, `test_topUp_payerOnlyAndAddsDeposit`, `test_resume_payerOnlyRestartsFromNow`, `test_cancel_payerOnlyReturnsWholeRemainderEvenWithPeriodDue` |
| The refund is bounded by the deposit and by `REFUND_CEIL_GAS`; for a benign payee neither bound ever binds | `invariant_I7_clampNeverBindsForBenignPayee`, `testFuzz_refundArithmeticBenignPayee`, and the fast-check property on `refundOf` |
| Re-entrancy (payee, executor or payer re-entering any function) is blocked | `test_execute_reenteringPayeeIsBlocked`, `test_execute_contractExecutorCannotReenterCancel`, `test_reentrancy_topUpAndResumeFromInsideExecuteAreBlocked`, `test_cancel_reenteringPayerCannotBreakConservation` |
| A refusing payee pauses the order; the executor is still repaid; the amount stays the payer's | `test_execute_rejectingPayeePausesRepaysExecutorKeepsAmount` and mainnet receipt `0xd07f9fb9…dc64` |
| A batching contract executor is credited the 21,000 intrinsic once per transaction | `test_execute_batchedExecutorIsChargedTheIntrinsicOnce` (the v1 → v2 fix) |
| Gas-starving a working payee cannot force a pause | `test_execute_gasStarvationCannotPauseAWorkingPayee` (200 gas limits swept) |
| The deployed runtime bytecode is this source with the immutable filled | `python3 scripts/preflight.py --bytecode` |

Known, documented limits (not vulnerabilities): the `2 × basefee` cap is a bound on a block producer who also executes, not a
fix; a contract payee needing more than the 30,000-gas stipend is paused on every run; a payer that is a contract refusing native
USDC cannot cancel. See README → *Honest limits*.

## Reporting a vulnerability
Please **do not** open a public issue for security vulnerabilities. Report privately:

- Email **edy.cu@live.com**, or
- GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) (Security → Report a vulnerability).

You will get an acknowledgment within 48 hours and a resolution timeline after triage. The contract holds only small demo
deposits; if a finding lets an executor drain a deposit beyond its reserve, the demo orders will be cancelled first and the
fix deployed as a new address (the contract is not upgradeable — that is deliberate).
