// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Demo payee that refuses every payment — exercises Legwork's pause path on mainnet.
contract Rejector {
    receive() external payable { revert(); }
}
