// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

/// @notice 6-decimal ERC-20 (USDC-like). Test only.
contract MockERC20Six is MockERC20 {
    constructor(string memory name_, string memory symbol_) MockERC20(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }
}
