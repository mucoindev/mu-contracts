// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IMuPups} from "../interfaces/IMuPups.sol";

interface IDogyReroll {
    function reroll(uint256 dogyId, uint8 table) external returns (bytes32);
}

/// @notice Malicious payment token for reentrancy tests. When armed, its
///         `transferFrom` (called by MuDogy mid-birth or mid-reroll) tries to
///         re-enter MuDogy once, records what happened, then behaves normally.
contract ReentrantMUG is ERC20 {
    enum Mode {
        Off,
        ReenterBirth, // send a Pup this token owns to MuDogy (nested birth)
        ReenterReroll // call MuDogy.reroll(targetId, 0)
    }

    IMuPups public pups;
    address public dogy;
    uint256 public targetId;
    Mode public mode;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor() ERC20("Reentrant MUG", "rMUG") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(IMuPups pups_, address dogy_, uint256 targetId_, Mode mode_) external {
        pups = pups_;
        dogy = dogy_;
        targetId = targetId_;
        mode = mode_;
        attempted = false;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (mode != Mode.Off && !attempted) {
            attempted = true;
            if (mode == Mode.ReenterBirth) {
                try pups.safeTransferFrom(address(this), dogy, targetId) {
                    reentrySucceeded = true;
                } catch (bytes memory err) {
                    reentryError = err;
                }
            } else {
                try IDogyReroll(dogy).reroll(targetId, 0) {
                    reentrySucceeded = true;
                } catch (bytes memory err) {
                    reentryError = err;
                }
            }
        }
        return super.transferFrom(from, to, value);
    }
}
