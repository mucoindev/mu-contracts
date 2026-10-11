// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IMuPups} from "../interfaces/IMuPups.sol";
import {MuDogy} from "../MuDogy.sol";

/// @notice A smart-contract wallet that holds Pups and births Dogys. Used to test
///         reentrancy through the Dogy mint callback and to demonstrate the
///         documented randomness limitation (a contract can refuse a seed).
contract ContractHolder is IERC721Receiver {
    enum Mode {
        Accept,
        Reject, // revert when the Dogy arrives
        ReenterBirth, // try a second birth from inside the Dogy mint callback
        PickyEvenSeed // accept the newborn only if its Core seed is even
    }

    IMuPups public immutable pups;
    MuDogy public immutable dogy;
    Mode public mode;
    uint256 public secondPup;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public reentryError;

    error OddSeed(bytes32 seed);

    constructor(IMuPups pups_, MuDogy dogy_) {
        pups = pups_;
        dogy = dogy_;
    }

    function setMode(Mode mode_, uint256 secondPup_) external {
        mode = mode_;
        secondPup = secondPup_;
        attempted = false;
    }

    function approveToken(IERC20 token, address spender, uint256 amount) external {
        token.approve(spender, amount);
    }

    function birth(uint256 pupId) external {
        pups.safeTransferFrom(address(this), address(dogy), pupId);
    }

    function reroll(uint256 dogyId, uint8 table) external returns (bytes32) {
        return dogy.reroll(dogyId, table);
    }

    /// @notice Reroll, then undo everything (including the MUG payment) unless the new seed is even.
    function rerollPicky(uint256 dogyId, uint8 table) external returns (bytes32 seed) {
        seed = dogy.reroll(dogyId, table);
        if (uint256(seed) % 2 != 0) revert OddSeed(seed);
    }

    function lock(uint256 dogyId, string calldata name) external {
        dogy.lock(dogyId, name);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        if (msg.sender == address(dogy)) {
            if (mode == Mode.Reject) revert("ContractHolder: rejecting Dogy");
            if (mode == Mode.ReenterBirth && !attempted) {
                attempted = true;
                try pups.safeTransferFrom(address(this), address(dogy), secondPup) {
                    reentrySucceeded = true;
                } catch (bytes memory err) {
                    reentryError = err;
                }
            }
            if (mode == Mode.PickyEvenSeed) {
                bytes32 seed = dogy.births(tokenId).seeds[0];
                if (uint256(seed) % 2 != 0) revert OddSeed(seed);
            }
        }
        return IERC721Receiver.onERC721Received.selector;
    }
}
