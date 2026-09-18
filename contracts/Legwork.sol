// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Legwork — standing USDC orders anyone can execute.
/// @notice A payer funds an order with native USDC (18-decimal `msg.value` on Arc). When the order is due, anyone may
///         call `execute(id)`: the contract pays the payee, meters the gas the call consumed, prices it at
///         `min(tx.gasprice, 2 * block.basefee, order.maxGasPrice)` and repays the executor that amount plus the
///         payer's tip — from the same deposit, in the same transaction. Gas and payment are one asset on Arc, so
///         the refund is `metered * price` with no oracle and no second funding token.
/// @dev    `OVERHEAD` is the gas the call spends outside the measured window (intrinsic + calldata + everything after
///         the measurement point). It is calibrated on mainnet against receipt `gasUsed` and passed to the
///         constructor, so recalibration is a redeploy of identical bytecode. The transaction's intrinsic 21,000 is
///         charged once per transaction (transient flag), so a contract executor running several orders in one
///         transaction is not over-refunded for it.
contract Legwork {
    struct Order {
        address payer;        // slot 0
        uint48 nextDue;
        uint32 interval;
        bool paused;
        address payee;        // slot 1
        uint48 createdBlock;
        uint48 maxGasPrice;   // wei; 2^48 wei ≈ 281,474 Gwei
        uint96 amount;        // slot 2 (native wei)
        uint96 tip;
        uint128 deposit;      // slot 3 (native wei)
    }

    /// @notice Gas spent outside the measured window; calibrated on mainnet (see deploy/arc-mainnet.json).
    uint256 public immutable OVERHEAD;
    /// @notice Gas stipend forwarded with the payee's payment.
    uint256 public constant PAYEE_GAS = 30_000;
    /// @notice Clamp on metered gas per execute, and the per-run reserve the pre-check requires.
    uint256 public constant REFUND_CEIL_GAS = 120_000;
    /// @notice Gas stipend forwarded with the executor's payout.
    uint256 public constant EXECUTOR_GAS = 30_000;
    /// @notice The part of OVERHEAD that a transaction pays once, however many orders it executes.
    uint256 public constant INTRINSIC_GAS = 21_000;

    uint256 public nextId;
    mapping(uint256 => Order) public orders;

    uint256 private transient _lock;    // re-entrancy guard
    uint256 private transient _txSeen;  // set by the first execute of a transaction

    event Created(uint256 indexed id, address indexed payer, address indexed payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice, uint128 deposit);
    event Executed(uint256 indexed id, address indexed executor, uint256 gasMetered, uint256 price, uint256 refund, uint256 tip, uint48 nextDue, bool paid);
    event Paused(uint256 indexed id, address indexed executor, uint8 reason);
    event Resumed(uint256 indexed id);
    event ToppedUp(uint256 indexed id, uint128 amount, uint128 deposit);
    event Cancelled(uint256 indexed id, uint128 returned);

    error NoOrder();
    error NotPayer();
    error IsPaused();
    error NotDue(uint48 nextDue);
    error Underfunded(uint256 have, uint256 need);
    error BadParams();
    error Reentrant();
    error PayoutFailed();

    constructor(uint256 overhead) {
        if (overhead < INTRINSIC_GAS) revert BadParams();
        OVERHEAD = overhead;
    }

    // ---------------------------------------------------------------- payer

    /// @notice Open a standing order funded with `msg.value`. The first run is due immediately.
    function create(address payee, uint96 amount, uint32 interval, uint96 tip, uint48 maxGasPrice)
        external
        payable
        returns (uint256 id)
    {
        if (_lock != 0) revert Reentrant();
        if (payee == address(0) || amount == 0 || interval == 0 || maxGasPrice == 0) revert BadParams();
        if (msg.value > type(uint128).max) revert BadParams();
        uint256 need = _needed(amount, tip, maxGasPrice);
        if (msg.value < need) revert Underfunded(msg.value, need);
        id = ++nextId;
        Order storage o = orders[id];
        o.payer = msg.sender;
        o.nextDue = uint48(block.timestamp);
        o.interval = interval;
        o.payee = payee;
        o.createdBlock = uint48(block.number);
        o.maxGasPrice = maxGasPrice;
        o.amount = amount;
        o.tip = tip;
        o.deposit = uint128(msg.value);
        emit Created(id, msg.sender, payee, amount, interval, tip, maxGasPrice, uint128(msg.value));
    }

    /// @notice Add `msg.value` to the order's deposit.
    function topUp(uint256 id) external payable {
        if (_lock != 0) revert Reentrant();
        Order storage o = _own(id);
        uint256 deposit = uint256(o.deposit) + msg.value;
        if (deposit > type(uint128).max) revert BadParams();
        o.deposit = uint128(deposit);
        emit ToppedUp(id, uint128(msg.value), uint128(deposit));
    }

    /// @notice Un-pause an order whose payee call failed; the schedule restarts from now.
    function resume(uint256 id) external {
        if (_lock != 0) revert Reentrant();
        Order storage o = _own(id);
        if (!o.paused) revert BadParams();
        o.paused = false;
        o.nextDue = uint48(block.timestamp);
        emit Resumed(id);
    }

    /// @notice Close the order and return the whole remaining deposit to the payer.
    function cancel(uint256 id) external {
        if (_lock != 0) revert Reentrant();
        Order storage o = _own(id);
        uint128 returned = o.deposit;
        delete orders[id];
        (bool ok,) = msg.sender.call{value: returned}("");
        if (!ok) revert PayoutFailed();
        emit Cancelled(id, returned);
    }

    // ---------------------------------------------------------------- anyone

    /// @notice Run one due period of order `id`. Anyone may call; the caller is repaid metered gas + tip.
    /// @dev    The metering block is lines 1, 4-5 and 9-12 of the body. Nothing of variable cost runs after the
    ///         measurement point (line 9): one fixed value call to the executor, one fixed-width event, one tstore.
    ///         A contract executor's own code (its CALL into this function, its `receive`) is outside the window and is
    ///         its own cost; the intrinsic 21,000 is credited once per transaction.
    function execute(uint256 id) external {
        uint256 g0 = gasleft();                                                     // 1  first statement
        if (_lock != 0) revert Reentrant();                                         // 2  guard (transient)
        _lock = 1;
        Order storage o = orders[id];                                               // 3  load + checks
        if (o.payer == address(0)) revert NoOrder();
        if (o.paused) revert IsPaused();
        uint48 nextDue = o.nextDue;
        if (block.timestamp < nextDue) revert NotDue(nextDue);
        if (_txSeen == 0) { _txSeen = 1; g0 += INTRINSIC_GAS; }                     //    intrinsic credited to the first execute of a transaction only
        uint256 price = tx.gasprice;                                                // 4  price = min(gasprice, 2·basefee, maxGasPrice)
        if (price > block.basefee << 1) price = block.basefee << 1;
        if (price > o.maxGasPrice) price = o.maxGasPrice;
        uint256 amount = o.amount;
        uint256 tip = o.tip;
        uint256 deposit = o.deposit;
        {                                                                           // 5  pre-check at the executor's own price
            uint256 need = amount + tip + REFUND_CEIL_GAS * price;
            if (deposit < need) revert Underfunded(deposit, need);
        }
        nextDue += o.interval;                                                      // 6  effects before interaction
        o.nextDue = nextDue;
        deposit -= amount + tip;
        o.deposit = uint128(deposit);
        (bool paid,) = o.payee.call{value: amount, gas: PAYEE_GAS}("");             // 7  pay the payee
        if (!paid) {                                                                // 8  refused → pause; amount stays the payer's
            o.paused = true;
            deposit += amount;
            emit Paused(id, msg.sender, 1);
        }
        uint256 metered = g0 - gasleft() + (OVERHEAD - INTRINSIC_GAS);              // 9  measurement point
        if (metered > REFUND_CEIL_GAS) metered = REFUND_CEIL_GAS;
        uint256 refund = metered * price;                                           // 10 bounded by the deposit
        if (refund > deposit) refund = deposit;
        o.deposit = uint128(deposit - refund);                                      // 11
        (bool ok,) = msg.sender.call{value: refund + tip, gas: EXECUTOR_GAS}("");   // 12 repay + tip, one call
        if (!ok) revert PayoutFailed();
        emit Executed(id, msg.sender, metered, price, refund, tip, nextDue, paid); // 13 fixed width on both branches
        _lock = 0;                                                                  // 14
    }

    // ---------------------------------------------------------------- views

    /// @notice Deposit an honest executor needs for one run: `amount + tip + REFUND_CEIL_GAS * min(basefee, maxGasPrice)`.
    function needed(uint256 id) external view returns (uint256) {
        Order storage o = orders[id];
        if (o.payer == address(0)) revert NoOrder();
        return _needed(o.amount, o.tip, o.maxGasPrice);
    }

    /// @notice The most an executor can be refunded per gas right now: `min(2 * basefee, maxGasPrice)`.
    function priceCap(uint256 id) external view returns (uint256) {
        Order storage o = orders[id];
        if (o.payer == address(0)) revert NoOrder();
        uint256 cap = block.basefee << 1;
        return cap < o.maxGasPrice ? cap : o.maxGasPrice;
    }

    /// @notice 0 None · 1 Due · 2 Waiting · 3 Underfunded · 4 Paused.
    function status(uint256 id) external view returns (uint8) {
        Order storage o = orders[id];
        if (o.payer == address(0)) return 0;
        if (o.paused) return 4;
        if (o.deposit < _needed(o.amount, o.tip, o.maxGasPrice)) return 3;
        if (block.timestamp >= o.nextDue) return 1;
        return 2;
    }

    // ---------------------------------------------------------------- internal

    function _needed(uint256 amount, uint256 tip, uint256 maxGasPrice) internal view returns (uint256) {
        uint256 p = block.basefee < maxGasPrice ? block.basefee : maxGasPrice;
        return amount + tip + REFUND_CEIL_GAS * p;
    }

    function _own(uint256 id) internal view returns (Order storage o) {
        o = orders[id];
        if (o.payer == address(0)) revert NoOrder();
        if (o.payer != msg.sender) revert NotPayer();
    }
}
