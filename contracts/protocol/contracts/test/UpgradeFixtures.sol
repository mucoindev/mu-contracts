// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {MuDogyUpgradeable} from "../MuDogyUpgradeable.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

// Test-only successor inherits the original initializer unchanged.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract MuDogyUpgradeFixture is MuDogyUpgradeable {
    uint256 public releaseNumber;
    function initializeV2(uint256 value) external reinitializer(2) onlyOwner {
        releaseNumber = value;
    }
}

contract UpgradeTimelockFixture is TimelockController {
    constructor(uint256 delay, address[] memory proposers, address[] memory executors)
        TimelockController(delay, proposers, executors, address(0)) {}
}

contract BadStorageFixture { uint256 public insertedBeforeExistingState; }
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract BadDogyLayoutFixture is BadStorageFixture, MuDogyUpgradeable {}
