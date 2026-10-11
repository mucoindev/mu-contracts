// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IMuOTCLike {
    function fillOrder(uint256 id) external;
    function cancelOrder(uint256 id) external;
}

/// @notice Malicious ERC-20: when armed, every transfer tries to call back into MuOTC
///         (fillOrder or cancelOrder on `targetId`). The callback's outcome is recorded
///         (try/catch) so a test can prove it was blocked while the outer call completed,
///         or (bubble mode) the callback's revert is re-thrown. Test only.
contract ReentrantERC20 is ERC20 {
    enum Action {
        None,
        Fill,
        Cancel
    }

    IMuOTCLike public otc;
    Action public action;
    uint256 public targetId;
    bool public bubble;

    uint256 public attempts;
    bool public reentrySucceeded;
    bytes public reentryError;

    constructor() ERC20("Evil", "EVIL") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address otc_, Action action_, uint256 targetId_, bool bubble_) external {
        otc = IMuOTCLike(otc_);
        action = action_;
        targetId = targetId_;
        bubble = bubble_;
        attempts = 0;
        reentrySucceeded = false;
        delete reentryError;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (action == Action.None || from == address(0)) return;
        Action a = action;
        action = Action.None; // one attempt per arm
        attempts++;
        bytes memory data = a == Action.Fill
            ? abi.encodeCall(IMuOTCLike.fillOrder, (targetId))
            : abi.encodeCall(IMuOTCLike.cancelOrder, (targetId));
        (bool ok, bytes memory ret) = address(otc).call(data);
        if (ok) {
            reentrySucceeded = true;
        } else {
            reentryError = ret;
            if (bubble) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
        }
    }
}
