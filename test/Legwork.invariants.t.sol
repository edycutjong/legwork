// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {Legwork} from "../contracts/Legwork.sol";
import {Rejector} from "../contracts/Rejector.sol";

/// Drives Legwork with random payers, payees (one of them refuses), executors, prices and clock jumps,
/// and keeps ghost totals the invariants are checked against.
contract Handler is Test {
    Legwork public lw;
    address[] public payers;
    address[] public payees;
    address[] public executors;
    uint256[] public ids;

    uint256 public sumIn;          // every wei that entered: create + topUp
    uint256 public sumPaid;        // payee legs
    uint256 public sumRepaid;      // refund + tip legs
    uint256 public sumReturned;    // cancel legs
    uint256 public executes;
    uint256 public pauses;
    uint256 public capViolations;      // I3
    uint256 public partialPayments;    // I4
    uint256 public unauthorizedOk;     // I5
    uint256 public scheduleViolations; // I6
    uint256 public clampBound;         // I7 (benign payee)

    address immutable rejector;

    constructor(Legwork _lw) {
        lw = _lw;
        rejector = address(new Rejector());
        for (uint256 i; i < 3; i++) {
            payers.push(makeAddr(string(abi.encodePacked("payer", i))));
            executors.push(makeAddr(string(abi.encodePacked("exec", i))));
            payees.push(makeAddr(string(abi.encodePacked("payee", i))));
        }
        payees.push(rejector);
        for (uint256 i; i < 3; i++) {
            vm.deal(payers[i], 1_000 ether);
            vm.deal(executors[i], 1 ether);
        }
    }

    function _pick(address[] storage a, uint256 seed) internal view returns (address) {
        return a[seed % a.length];
    }

    function create(uint256 seed, uint96 amount, uint32 interval, uint96 tip, uint48 maxGp, uint128 extra) external {
        amount = uint96(bound(amount, 1, 1 ether));
        interval = uint32(bound(interval, 1, 7 days));
        tip = uint96(bound(tip, 0, 0.1 ether));
        maxGp = uint48(bound(maxGp, 1 gwei, 1_000 gwei));
        uint256 need = uint256(amount) + tip + lw.REFUND_CEIL_GAS() * (block.basefee < maxGp ? block.basefee : maxGp);
        uint256 value = need + bound(extra, 0, 10 ether);
        address payer = _pick(payers, seed);
        vm.prank(payer);
        uint256 id = lw.create{value: value}(_pick(payees, seed >> 8), amount, interval, tip, maxGp);
        ids.push(id);
        sumIn += value;
    }

    function topUp(uint256 seed, uint128 value) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        value = uint128(bound(value, 0, 1 ether));
        (address payer,,,,,,,,,) = lw.orders(id);
        if (payer == address(0)) return;
        address caller = _pick(payers, seed >> 16);
        vm.deal(caller, caller.balance + value);
        vm.prank(caller);
        try lw.topUp{value: value}(id) {
            if (caller != payer) unauthorizedOk++;
            sumIn += value;
        } catch {}
    }

    function warp(uint32 dt) external {
        vm.warp(block.timestamp + bound(dt, 0, 2 days));
        vm.roll(block.number + 1);
    }

    struct Snap {
        address ex;
        address payee;
        uint256 payeeBefore;
        uint256 exBefore;
        uint48 dueBefore;
        uint32 interval;
        uint48 maxGp;
        uint96 amount;
        uint256 expectPrice;
    }

    function execute(uint256 seed, uint64 gasPrice, uint64 basefee) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        gasPrice = uint64(bound(gasPrice, 1 gwei, 200 gwei));
        basefee = uint64(bound(basefee, 1 gwei, 100 gwei));
        vm.fee(basefee);
        vm.txGasPrice(gasPrice);
        Snap memory sn;
        {
            (address payer, uint48 due, uint32 interval, bool paused, address payee,, uint48 maxGp, uint96 amount,,) = lw.orders(id);
            if (payer == address(0) || paused) return;
            sn.payee = payee; sn.dueBefore = due; sn.interval = interval; sn.maxGp = maxGp; sn.amount = amount;
        }
        sn.ex = _pick(executors, seed >> 24);
        sn.payeeBefore = sn.payee.balance;
        sn.exBefore = sn.ex.balance;
        sn.expectPrice = gasPrice;
        if (sn.expectPrice > 2 * uint256(basefee)) sn.expectPrice = 2 * uint256(basefee);
        if (sn.expectPrice > sn.maxGp) sn.expectPrice = sn.maxGp;

        vm.recordLogs();
        vm.prank(sn.ex, sn.ex);
        try lw.execute(id) {
            _afterExecute(sn);
        } catch {}
    }

    function _afterExecute(Snap memory sn) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 metered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid) =
            abi.decode(logs[logs.length - 1].data, (uint256, uint256, uint256, uint256, uint48, bool));
        executes++;
        if (price != sn.expectPrice) capViolations++;
        if (nextDue != sn.dueBefore + sn.interval) scheduleViolations++;
        uint256 got = sn.payee.balance - sn.payeeBefore;
        if (paid) {
            if (got != sn.amount) partialPayments++;
            if (sn.payee != rejector && metered >= lw.REFUND_CEIL_GAS()) clampBound++;
        } else {
            pauses++;
            if (got != 0 || logs.length != 2) partialPayments++;
        }
        uint256 repaid = sn.ex.balance - sn.exBefore;
        sumPaid += got;
        sumRepaid += repaid;
        if (repaid != refund + tip) capViolations++;
    }

    function cancel(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        (address payer,,,,,,,,, uint128 deposit) = lw.orders(id);
        if (payer == address(0)) return;
        address caller = _pick(payers, seed >> 16);
        vm.prank(caller);
        try lw.cancel(id) {
            if (caller != payer) unauthorizedOk++;
            sumReturned += deposit;
        } catch {}
    }

    function resume(uint256 seed) external {
        if (ids.length == 0) return;
        uint256 id = ids[seed % ids.length];
        (address payer,,, bool paused,,,,,,) = lw.orders(id);
        if (payer == address(0)) return;
        address caller = _pick(payers, seed >> 16);
        vm.prank(caller);
        try lw.resume(id) {
            if (caller != payer || !paused) unauthorizedOk++;
        } catch {}
    }

    function openDeposits() external view returns (uint256 total) {
        for (uint256 i; i < ids.length; i++) {
            (,,,,,,,,, uint128 deposit) = lw.orders(ids[i]);
            total += deposit;
        }
    }

    function idCount() external view returns (uint256) { return ids.length; }
}

contract LegworkInvariants is Test {
    Legwork lw;
    Handler h;

    function setUp() public {
        lw = new Legwork(32_503);
        vm.fee(20 gwei);
        vm.txGasPrice(20 gwei);
        vm.warp(1_700_000_000);
        vm.roll(100);
        h = new Handler(lw);
        targetContract(address(h));
        // the fuzzer funds whichever sender it picks; the contract under test must not be one of them
        excludeSender(address(lw));
        excludeSender(address(h));
    }

    /// I1 — deposit conservation: every wei in is either still deposited or left through exactly one of the
    ///      three legs; the contract never holds less than the open deposits.
    function invariant_I1_depositConservation() public view {
        assertEq(address(lw).balance, h.openDeposits(), "contract balance == sum of open deposits");
        assertEq(h.sumIn(), h.openDeposits() + h.sumPaid() + h.sumRepaid() + h.sumReturned(), "in == open + out");
    }

    /// I3 — the executor is never priced above min(tx.gasprice, 2 * basefee, maxGasPrice), and receives exactly refund + tip.
    function invariant_I3_priceCap() public view {
        assertEq(h.capViolations(), 0);
    }

    /// I4 — never a partial payment: paid == true moved exactly `amount`; paid == false moved nothing and carried `Paused`.
    function invariant_I4_noPartialPayment() public view {
        assertEq(h.partialPayments(), 0);
    }

    /// I5 — only the payer moves money out other than through execute.
    function invariant_I5_payerOnly() public view {
        assertEq(h.unauthorizedOk(), 0);
    }

    /// I6 — one period per execute.
    function invariant_I6_onePeriodPerExecute() public view {
        assertEq(h.scheduleViolations(), 0);
    }

    /// I7 — the metering clamp never binds for a benign payee.
    function invariant_I7_clampNeverBindsForBenignPayee() public view {
        assertEq(h.clampBound(), 0);
    }
}
