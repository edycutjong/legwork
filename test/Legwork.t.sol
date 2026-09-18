// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Legwork} from "../contracts/Legwork.sol";
import {Rejector} from "../contracts/Rejector.sol";

/// Payee that re-enters `execute` from its receive hook. `strict` propagates the inner failure;
/// otherwise it swallows it (and still gets paid — the guard, not the payee, decides).
contract ReenteringPayee {
    Legwork public lw;
    uint256 public id;
    bool public strict;
    bool public innerReverted;

    constructor(Legwork _lw, bool _strict) { lw = _lw; strict = _strict; }
    function arm(uint256 _id) external { id = _id; }

    receive() external payable {
        (bool ok,) = address(lw).call(abi.encodeWithSelector(Legwork.execute.selector, id));
        innerReverted = !ok;
        if (strict) require(ok, "reenter");
    }
}

/// Executor whose receive refuses the payout.
contract RefusingExecutor {
    Legwork public lw;
    constructor(Legwork _lw) { lw = _lw; }
    function go(uint256 id) external { lw.execute(id); }
    receive() external payable { revert("no"); }
}

/// Executor that burns some gas in receive and tries to re-enter cancel (must fail on the guard).
contract BusyExecutor {
    Legwork public lw;
    bool public cancelFailed;
    constructor(Legwork _lw) { lw = _lw; }
    function go(uint256 id) external { lw.execute(id); }
    function cancelIt(uint256 id) external { lw.cancel(id); }
    receive() external payable {
        uint256 s;
        for (uint256 i; i < 50; i++) s += i; // a few hundred gas, spent after the measurement point
        (bool ok,) = address(lw).call(abi.encodeWithSelector(Legwork.cancel.selector, uint256(1)));
        cancelFailed = !ok || s == 0; // one storage write; inside the 30k executor stipend
    }
}

/// Payer that refuses native USDC back (its own problem: it can never cancel).
contract RefusingPayer {
    Legwork public lw;
    constructor(Legwork _lw) payable { lw = _lw; }
    function create(address payee) external returns (uint256) { return lw.create{value: 0.05 ether}(payee, 0.01 ether, 60, 0.01 ether, 100 gwei); }
    function cancel(uint256 id) external { lw.cancel(id); }
    receive() external payable { revert("no"); }
}

/// Payer whose receive re-enters `execute` on another order while its own cancel is paying out.
contract ReenteringPayer {
    Legwork public lw;
    uint256 public other;
    bool public innerOk;
    constructor(Legwork _lw) payable { lw = _lw; }
    function create(address payee) external returns (uint256) { return lw.create{value: 0.05 ether}(payee, 0.01 ether, 60, 0.01 ether, 100 gwei); }
    function cancel(uint256 id, uint256 _other) external { other = _other; lw.cancel(id); }
    receive() external payable {
        (bool ok,) = address(lw).call(abi.encodeWithSelector(Legwork.execute.selector, other));
        innerOk = ok;
    }
}

/// Payee that spends most of its 30k stipend and still accepts.
contract HungryPayee {
    uint256 public sink;
    receive() external payable { sink += 1; } // one cold SSTORE (~22k) inside the 30k stipend
}

/// Executor that burns gas in its receive without re-entering.
contract GasBurningExecutor {
    Legwork public lw;
    uint256 public sink;
    constructor(Legwork _lw) { lw = _lw; }
    function go(uint256 id) external { lw.execute(id); }
    receive() external payable { sink += 1; } // ~22k of work after the measurement point
}

contract LegworkTest is Test {
    uint256 constant OVERHEAD = 32_503; // the production constant (deploy/arc-mainnet.json)
    uint256 constant CEIL = 120_000;
    uint256 constant BASEFEE = 20 gwei;

    Legwork lw;
    address payer = makeAddr("payer");
    address payee = makeAddr("payee");
    address exec = makeAddr("exec");
    address stranger = makeAddr("stranger");

    event Created(uint256 indexed id, address indexed payer, address indexed payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice, uint128 deposit);
    event Executed(uint256 indexed id, address indexed executor, uint256 gasMetered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid);
    event Paused(uint256 indexed id, address indexed executor, uint8 reason);
    event Resumed(uint256 indexed id);
    event ToppedUp(uint256 indexed id, uint128 amount, uint128 deposit);
    event Cancelled(uint256 indexed id, uint128 returned);

    function setUp() public {
        lw = new Legwork(OVERHEAD);
        vm.fee(BASEFEE);
        vm.txGasPrice(BASEFEE);
        vm.deal(payer, 10 ether);
        vm.deal(exec, 1 ether);
        vm.deal(stranger, 1 ether);
        vm.warp(1_700_000_000);
        vm.roll(100);
    }

    // ------------------------------------------------------------ helpers

    function _create(address _payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGp, uint256 value)
        internal
        returns (uint256 id)
    {
        vm.prank(payer);
        id = lw.create{value: value}(_payee, amount, interval, tip, maxGp);
    }

    /// The `live` order shape: 0.02 / 60 s / tip 0.01 / 100 Gwei / deposit 0.10.
    function _live() internal returns (uint256) {
        return _create(payee, 0.02 ether, 60, 0.01 ether, 100 gwei, 0.10 ether);
    }

    function _order(uint256 id) internal view returns (Legwork.Order memory o) {
        (bool ok, bytes memory d) = address(lw).staticcall(abi.encodeWithSelector(lw.orders.selector, id));
        require(ok);
        o = abi.decode(d, (Legwork.Order));
    }

    function _min3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256 m) {
        m = a < b ? a : b;
        if (c < m) m = c;
    }

    // ------------------------------------------------------------ create

    function test_create_recordsOrderAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit Created(1, payer, payee, 0.02 ether, 60, 0.01 ether, 100 gwei, 0.10 ether);
        uint256 id = _live();
        assertEq(id, 1);
        Legwork.Order memory o = _order(id);
        assertEq(o.payer, payer);
        assertEq(o.payee, payee);
        assertEq(o.nextDue, uint48(block.timestamp), "first run due immediately");
        assertEq(o.createdBlock, uint48(block.number));
        assertEq(o.deposit, 0.10 ether);
        assertEq(lw.status(id), 1, "Due");
        assertEq(lw.needed(id), 0.02 ether + 0.01 ether + CEIL * BASEFEE);
        assertEq(lw.priceCap(id), 2 * BASEFEE);
        assertEq(address(lw).balance, 0.10 ether);
    }

    function test_create_rejectsBadParams() public {
        vm.startPrank(payer);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.create{value: 1 ether}(address(0), 1, 60, 0, 100 gwei);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.create{value: 1 ether}(payee, 0, 60, 0, 100 gwei);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.create{value: 1 ether}(payee, 1, 0, 0, 100 gwei);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.create{value: 1 ether}(payee, 1, 60, 0, 0);
        vm.stopPrank();
    }

    function test_create_rejectsUnderfundedDeposit() public {
        uint256 need = 0.02 ether + 0.01 ether + CEIL * BASEFEE; // 0.0324
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Legwork.Underfunded.selector, need - 1, need));
        lw.create{value: need - 1}(payee, 0.02 ether, 60, 0.01 ether, 100 gwei);
        // exactly `need` is accepted
        vm.prank(payer);
        uint256 id = lw.create{value: need}(payee, 0.02 ether, 60, 0.01 ether, 100 gwei);
        assertEq(lw.status(id), 1);
    }

    // ------------------------------------------------------------ execute: happy path

    function test_execute_paysPayeeRepaysExecutorAdvancesSchedule() public {
        uint256 id = _live();
        uint256 payeeBefore = payee.balance;
        uint256 execBefore = exec.balance;
        uint48 due0 = _order(id).nextDue;

        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(id);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "exactly one event on the paid branch");
        assertEq(logs[0].topics[0], keccak256("Executed(uint256,address,uint256,uint256,uint256,uint256,uint48,bool)"));
        (uint256 metered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid) =
            abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));

        assertTrue(paid);
        assertEq(price, BASEFEE, "honest executor priced at gasprice");
        assertEq(refund, metered * price);
        assertEq(tip, 0.01 ether);
        assertEq(nextDue, due0 + 60);
        assertGt(metered, OVERHEAD, "the window measured something");
        assertLt(metered, CEIL, "clamp did not bind");

        assertEq(payee.balance - payeeBefore, 0.02 ether, "payee got exactly amount");
        assertEq(exec.balance - execBefore, refund + tip, "executor got refund + tip in one leg");
        Legwork.Order memory o = _order(id);
        assertEq(o.deposit, 0.10 ether - 0.02 ether - 0.01 ether - refund, "deposit conservation");
        assertEq(o.nextDue, due0 + 60);
        assertFalse(o.paused);
        assertEq(lw.status(id), 2, "Waiting");
        assertEq(address(lw).balance, o.deposit);
    }

    function test_execute_anyoneIncludingThePayee() public {
        uint256 id = _live();
        vm.deal(payee, 1 ether);
        uint256 before = payee.balance;
        vm.prank(payee, payee);
        lw.execute(id);
        // the payee collected amount + refund + tip
        assertGt(payee.balance - before, 0.02 ether + 0.01 ether);
    }

    // ------------------------------------------------------------ execute: reverts

    function test_execute_revertsNotDue() public {
        uint256 id = _live();
        vm.prank(exec);
        lw.execute(id);
        uint48 due = _order(id).nextDue;
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(Legwork.NotDue.selector, due));
        lw.execute(id);
        // same second, still not due; one second before due, still not due; at due, ok
        vm.warp(due - 1);
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(Legwork.NotDue.selector, due));
        lw.execute(id);
        vm.warp(due);
        vm.prank(exec);
        lw.execute(id);
    }

    function test_execute_sameTimestampSecondCallRevertsNotDue() public {
        // Arc timestamps are non-decreasing: two blocks can share one. Two executes in that second: one period.
        uint256 id = _live();
        vm.prank(exec);
        lw.execute(id);
        vm.roll(block.number + 1); // new block, same timestamp
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Legwork.NotDue.selector, _order(id).nextDue));
        lw.execute(id);
    }

    function test_execute_missedPeriodsAreCaughtUpOnePerExecute() public {
        uint256 id = _create(payee, 0.001 ether, 60, 0.0001 ether, 100 gwei, 1 ether);
        uint48 due0 = _order(id).nextDue;
        vm.warp(due0 + 600); // ten periods late
        for (uint256 i = 1; i <= 5; i++) {
            vm.prank(exec);
            lw.execute(id);
            assertEq(_order(id).nextDue, due0 + uint48(60 * i), "anchored schedule, one period per execute");
        }
        assertEq(lw.status(id), 1, "still due: periods are owed");
    }

    function test_execute_revertsUnderfundedNeverPartial() public {
        // deposit covers one honest run exactly; a second run is Underfunded with nothing moved
        uint256 need = 0.02 ether + 0.01 ether + CEIL * BASEFEE;
        uint256 id = _create(payee, 0.02 ether, 60, 0.01 ether, 100 gwei, need);
        vm.prank(exec);
        lw.execute(id);
        Legwork.Order memory o = _order(id);
        assertEq(lw.status(id), 3, "Underfunded");
        vm.warp(o.nextDue);
        uint256 payeeBefore = payee.balance;
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(Legwork.Underfunded.selector, uint256(o.deposit), need));
        lw.execute(id);
        assertEq(payee.balance, payeeBefore, "no partial payment");
        assertEq(_order(id).deposit, o.deposit);
    }

    function test_execute_preCheckUsesExecutorsOwnPrice() public {
        // funded to exactly one honest run: Due for a basefee executor, Underfunded for one pricing above it
        uint256 need = 0.02 ether + 0.01 ether + CEIL * BASEFEE;
        uint256 id = _create(payee, 0.02 ether, 60, 0.01 ether, 100 gwei, need);
        assertEq(lw.status(id), 1);
        vm.txGasPrice(30 gwei);
        vm.prank(exec);
        vm.expectRevert(abi.encodeWithSelector(Legwork.Underfunded.selector, need, 0.03 ether + CEIL * 30 gwei));
        lw.execute(id);
        vm.txGasPrice(BASEFEE);
        vm.prank(exec);
        lw.execute(id);
    }

    function test_execute_revertsNoOrderAndIsPaused() public {
        vm.prank(exec);
        vm.expectRevert(Legwork.NoOrder.selector);
        lw.execute(42);
        uint256 id = _create(address(new Rejector()), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        vm.prank(exec);
        lw.execute(id); // pauses
        vm.warp(block.timestamp + 60);
        vm.prank(exec);
        vm.expectRevert(Legwork.IsPaused.selector);
        lw.execute(id);
    }

    // ------------------------------------------------------------ execute: payee failure → pause

    function test_execute_rejectingPayeePausesRepaysExecutorKeepsAmount() public {
        Rejector r = new Rejector();
        uint256 id = _create(address(r), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        uint256 execBefore = exec.balance;
        uint48 due0 = _order(id).nextDue;

        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 2, "Paused then Executed");
        assertEq(logs[0].topics[0], keccak256("Paused(uint256,address,uint8)"));
        assertEq(uint256(logs[0].topics[1]), id);
        assertEq(address(uint160(uint256(logs[0].topics[2]))), exec);
        assertEq(abi.decode(logs[0].data, (uint8)), 1);
        assertEq(logs[1].topics[0], keccak256("Executed(uint256,address,uint256,uint256,uint256,uint256,uint48,bool)"));
        (uint256 metered,, uint256 refund, uint256 tip, uint48 nextDue, bool paid) =
            abi.decode(logs[1].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertFalse(paid);
        assertEq(nextDue, due0 + 60, "nextDue stays advanced");
        assertLt(metered, CEIL);

        assertEq(address(r).balance, 0, "payee got nothing");
        assertEq(exec.balance - execBefore, refund + tip, "executor repaid + tipped");
        Legwork.Order memory o = _order(id);
        assertTrue(o.paused);
        assertEq(o.deposit, 0.05 ether - 0.01 ether - refund, "amount stayed in the deposit; tip and refund left");
        assertEq(lw.status(id), 4, "Paused");
    }

    function test_execute_reenteringPayeeIsBlocked() public {
        // strict: the payee propagates the guard's revert -> its call fails -> order pauses, nothing paid
        ReenteringPayee p = new ReenteringPayee(lw, true);
        uint256 id = _create(address(p), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        p.arm(id);
        vm.prank(exec);
        lw.execute(id);
        Legwork.Order memory o = _order(id);
        assertTrue(o.paused, "re-entrant payee -> its call failed -> order paused");
        assertEq(address(p).balance, 0);
        assertEq(o.nextDue, uint48(block.timestamp) + 60, "exactly one period advanced");

        // lenient: the payee swallows the inner revert -> it is paid once; the inner execute never ran
        ReenteringPayee q = new ReenteringPayee(lw, false);
        uint256 id2 = _create(address(q), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        q.arm(id2);
        vm.prank(exec);
        lw.execute(id2);
        Legwork.Order memory o2 = _order(id2);
        assertTrue(q.innerReverted(), "inner execute hit the guard");
        assertFalse(o2.paused);
        assertEq(address(q).balance, 0.01 ether, "paid exactly once");
        assertEq(o2.nextDue, uint48(block.timestamp) + 60, "exactly one period advanced");
    }

    // ------------------------------------------------------------ execute: executor edge cases

    function test_execute_refusingExecutorRevertsWhole() public {
        uint256 id = _live();
        RefusingExecutor e = new RefusingExecutor(lw);
        Legwork.Order memory before = _order(id);
        vm.expectRevert(Legwork.PayoutFailed.selector);
        e.go(id);
        Legwork.Order memory after_ = _order(id);
        assertEq(after_.deposit, before.deposit, "no state change");
        assertEq(after_.nextDue, before.nextDue);
        assertEq(payee.balance, 0);
    }

    function test_execute_contractExecutorCannotReenterCancel() public {
        uint256 id = _live();
        BusyExecutor e = new BusyExecutor(lw);
        e.go(id);
        assertTrue(e.cancelFailed(), "cancel from inside execute hit the guard");
        assertEq(_order(id).payer, payer, "order still exists");
        assertGt(address(e).balance, 0.01 ether, "executor still got refund + tip");
    }

    // ------------------------------------------------------------ execute: price caps

    function test_execute_priceCappedAtTwiceBasefee() public {
        uint256 id = _live();
        vm.txGasPrice(60 gwei); // 3x the base fee
        vm.recordLogs();
        vm.prank(exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered, uint256 price, uint256 refund,,,) = abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertEq(price, 2 * BASEFEE, "capped at 2 x basefee");
        assertEq(refund, metered * 2 * BASEFEE);
    }

    function test_execute_priceCappedAtMaxGasPrice() public {
        // the `capped` order: maxGasPrice 20 Gwei, executed at 30 Gwei
        uint256 id = _create(payee, 0.01 ether, 60, 0.01 ether, 20 gwei, 0.05 ether);
        vm.txGasPrice(30 gwei);
        vm.recordLogs();
        vm.prank(exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered, uint256 price, uint256 refund,,,) = abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertEq(price, 20 gwei, "capped at maxGasPrice");
        assertEq(refund, metered * 20 gwei);
        assertLt(refund, metered * 30 gwei, "executor eats the difference");
    }

    function test_execute_maxGasPriceBelowBasefeeStillExecutes() public {
        uint256 id = _create(payee, 0.01 ether, 60, 0.01 ether, 5 gwei, 0.05 ether);
        assertEq(lw.priceCap(id), 5 gwei);
        assertEq(lw.needed(id), 0.02 ether + CEIL * 5 gwei);
        vm.recordLogs();
        vm.prank(exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (, uint256 price,,,,) = abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertEq(price, 5 gwei, "paid below cost, as the payer chose");
    }

    // ------------------------------------------------------------ payer paths

    function test_topUp_payerOnlyAndAddsDeposit() public {
        uint256 id = _live();
        vm.prank(stranger);
        vm.expectRevert(Legwork.NotPayer.selector);
        lw.topUp{value: 0.01 ether}(id);
        vm.prank(payer);
        vm.expectEmit(true, false, false, true);
        emit ToppedUp(id, 0.05 ether, 0.15 ether);
        lw.topUp{value: 0.05 ether}(id);
        assertEq(_order(id).deposit, 0.15 ether);
        vm.prank(payer);
        vm.expectRevert(Legwork.NoOrder.selector);
        lw.topUp{value: 1}(99);
    }

    function test_resume_payerOnlyRestartsFromNow() public {
        uint256 id = _create(address(new Rejector()), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        vm.prank(payer);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.resume(id); // not paused
        vm.prank(exec);
        lw.execute(id);
        assertTrue(_order(id).paused);
        vm.prank(stranger);
        vm.expectRevert(Legwork.NotPayer.selector);
        lw.resume(id);
        vm.warp(block.timestamp + 1000);
        vm.prank(payer);
        vm.expectEmit(true, false, false, true);
        emit Resumed(id);
        lw.resume(id);
        Legwork.Order memory o = _order(id);
        assertFalse(o.paused);
        assertEq(o.nextDue, uint48(block.timestamp));
        assertEq(lw.status(id), 1, "Due again");
    }

    function test_cancel_payerOnlyReturnsWholeRemainderEvenWithPeriodDue() public {
        uint256 id = _live();
        vm.prank(exec);
        lw.execute(id);
        uint256 remainder = _order(id).deposit;
        vm.warp(_order(id).nextDue + 5); // a period is due and stays unpaid
        vm.prank(stranger);
        vm.expectRevert(Legwork.NotPayer.selector);
        lw.cancel(id);
        uint256 before = payer.balance;
        vm.prank(payer);
        vm.expectEmit(true, false, false, true);
        emit Cancelled(id, uint128(remainder));
        lw.cancel(id);
        assertEq(payer.balance - before, remainder);
        assertEq(_order(id).payer, address(0), "slots cleared");
        assertEq(lw.status(id), 0, "None");
        assertEq(address(lw).balance, 0);
        vm.prank(exec);
        vm.expectRevert(Legwork.NoOrder.selector);
        lw.execute(id);
    }

    function test_views_revertOnUnknownOrder() public {
        vm.expectRevert(Legwork.NoOrder.selector);
        lw.needed(7);
        vm.expectRevert(Legwork.NoOrder.selector);
        lw.priceCap(7);
        assertEq(lw.status(7), 0);
    }

    // ------------------------------------------------------------ audit-round additions

    function test_topUp_rejectsUint128Overflow() public {
        uint256 id = _live();
        vm.deal(payer, type(uint256).max);
        vm.prank(payer);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.topUp{value: type(uint128).max}(id);
    }

    function test_create_rejectsDepositAboveUint128() public {
        vm.deal(payer, type(uint256).max);
        vm.prank(payer);
        vm.expectRevert(Legwork.BadParams.selector);
        lw.create{value: uint256(type(uint128).max) + 1}(payee, 0.01 ether, 60, 0, 100 gwei);
    }

    function test_cancel_revertsPayoutFailedForARefusingPayer() public {
        RefusingPayer rp = new RefusingPayer{value: 1 ether}(lw);
        uint256 id = rp.create(payee);
        vm.expectRevert(Legwork.PayoutFailed.selector);
        rp.cancel(id);
        assertEq(_order(id).payer, address(rp), "order untouched; executors can still drain it by running it");
    }

    function test_cancel_reenteringPayerCannotBreakConservation() public {
        // cancel deletes before it pays (CEI). A payer whose receive re-enters execute on another order just
        // executes that order normally; the cancelled order is already gone and the balance stays conserved.
        uint256 other = _live();
        ReenteringPayer rp = new ReenteringPayer{value: 1 ether}(lw);
        uint256 id = rp.create(payee);
        uint256 before = address(lw).balance;
        rp.cancel(id, other);
        assertTrue(rp.innerOk(), "inner execute ran");
        assertEq(_order(id).payer, address(0), "cancelled order is gone");
        Legwork.Order memory o = _order(other);
        assertEq(address(lw).balance, o.deposit, "contract balance == the one remaining deposit");
        assertEq(before - address(lw).balance, 0.05 ether + 0.02 ether + 0.01 ether + (o.deposit == 0 ? 0 : (0.10 ether - 0.03 ether - o.deposit)), "returned + paid + tipped + refunded");
    }

    function test_execute_hungryPayeeWithinStipendIsPaidAndMetered() public {
        HungryPayee hp = new HungryPayee();
        uint256 id = _create(address(hp), 0.01 ether, 60, 0.01 ether, 100 gwei, 0.05 ether);
        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered,,,,, bool paid) = abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertTrue(paid);
        assertEq(hp.sink(), 1);
        assertGt(metered, 20_000 + OVERHEAD, "the payee's SSTORE is inside the measured window -> refunded to the executor");
        assertLt(metered, CEIL);
    }

    function test_execute_contractExecutorsReceiveIsNotMetered() public {
        // same order shape, EOA executor vs a contract executor that does ~22k of work in its receive:
        // the metered figure must not include that work (it runs after the measurement point).
        uint256 warm = _live();
        uint256 a = _live();
        uint256 b = _live();
        vm.prank(exec, exec);
        lw.execute(warm); // the payee now exists and is warm for both measured runs (no 25k new-account cost)
        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(a);
        (uint256 meteredEoa,,,,,) = abi.decode(vm.getRecordedLogs()[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        GasBurningExecutor ge = new GasBurningExecutor(lw);
        vm.recordLogs();
        ge.go(b);
        (uint256 meteredContract,,,,,) = abi.decode(vm.getRecordedLogs()[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertEq(ge.sink(), 1);
        // the difference is only the warm/cold access pattern of the two callers, never the 22k SSTORE
        uint256 diff = meteredContract > meteredEoa ? meteredContract - meteredEoa : meteredEoa - meteredContract;
        assertLt(diff, 5_000, "receive work is not in the metered window");
    }

    // ------------------------------------------------------------ fuzz

    /// Refund arithmetic over price / deposit / amount / tip for a benign payee: the clamp never binds,
    /// refund == metered * min(gasprice, 2*basefee, maxGasPrice), and the deposit is conserved.
    function testFuzz_refundArithmeticBenignPayee(uint64 gasPrice, uint64 basefee, uint48 maxGp, uint96 amount, uint96 tip, uint128 extra)
        public
    {
        gasPrice = uint64(bound(gasPrice, 1, 100_000 gwei));
        basefee = uint64(bound(basefee, 1, 100_000 gwei));
        maxGp = uint48(bound(maxGp, 1, type(uint48).max));
        amount = uint96(bound(amount, 1, 1_000 ether));
        tip = uint96(bound(tip, 0, 1_000 ether));
        vm.fee(basefee);
        vm.txGasPrice(gasPrice);
        uint256 price = _min3(gasPrice, 2 * uint256(basefee), maxGp);
        // fund for the executor's own price plus whatever extra the fuzzer adds (deposit must fit uint128)
        uint256 value = uint256(amount) + tip + CEIL * _max(price, _min2(basefee, maxGp)) + bound(extra, 0, 1_000 ether);
        vm.deal(payer, value);
        vm.prank(payer);
        uint256 id = lw.create{value: value}(payee, amount, 60, tip, maxGp);
        _executeAndCheck(id, value, amount, tip, price);
    }

    function _executeAndCheck(uint256 id, uint256 value, uint256 amount, uint256 tip, uint256 price) internal {
        uint256 execBefore = exec.balance;
        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered, uint256 p, uint256 refund, uint256 t,, bool paid) =
            abi.decode(logs[logs.length - 1].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertTrue(paid);
        assertEq(p, price, "I3: price == min(gasprice, 2*basefee, maxGasPrice)");
        assertLt(metered, CEIL, "I7: clamp never binds for a benign payee");
        assertEq(refund, metered * price, "refund == metered * price");
        assertEq(t, tip);
        assertEq(exec.balance - execBefore, refund + tip);
        assertEq(_order(id).deposit, value - amount - tip - refund, "I1: deposit conservation");
        assertEq(address(lw).balance, _order(id).deposit);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) { return a > b ? a : b; }
    function _min2(uint256 a, uint256 b) internal pure returns (uint256) { return a < b ? a : b; }

    /// I3 over the whole uint48 field for both the executor's gasprice and the payer's cap.
    function testFuzz_priceCapHoldsOverFullRange(uint48 gasPrice, uint48 maxGp, uint48 basefee) public {
        gasPrice = uint48(bound(gasPrice, 1, type(uint48).max));
        maxGp = uint48(bound(maxGp, 1, type(uint48).max));
        basefee = uint48(bound(basefee, 1, type(uint48).max));
        vm.fee(basefee);
        vm.txGasPrice(gasPrice);
        uint256 price = _min3(gasPrice, 2 * uint256(basefee), maxGp);
        uint256 value = 0.02 ether + CEIL * _max(price, _min2(basefee, maxGp));
        vm.deal(payer, value);
        vm.prank(payer);
        uint256 id = lw.create{value: value}(payee, 0.01 ether, 60, 0.01 ether, maxGp);
        assertEq(lw.priceCap(id), (2 * uint256(basefee)) < maxGp ? 2 * uint256(basefee) : maxGp);
        vm.recordLogs();
        vm.prank(exec, exec);
        lw.execute(id);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered, uint256 p, uint256 refund,,,) =
            abi.decode(logs[0].data, (uint256, uint256, uint256, uint256, uint48, bool));
        assertEq(p, price);
        assertLe(p, gasPrice);
        assertLe(p, 2 * uint256(basefee));
        assertLe(p, maxGp);
        assertEq(refund, metered * p);
        assertLe(refund, value, "refund bounded by the deposit");
    }
}

