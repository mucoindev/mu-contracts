// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {VestingWallet} from "@openzeppelin/contracts/finance/VestingWallet.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// Fixed supply, 18 decimals. No owner, minting, tax, blacklist or upgrade keys.
contract MuFixedToken is ERC20 {
    constructor(string memory name_, string memory symbol_, uint256 supply, address recipient) ERC20(name_, symbol_) {
        require(bytes(name_).length > 0 && bytes(name_).length <= 64 && bytes(symbol_).length > 0 && bytes(symbol_).length <= 12, "Invalid name");
        require(supply > 0 && recipient != address(0), "Invalid supply or recipient");
        _mint(recipient, supply);
    }
}

/// Standard linear vesting; funding is separate and beneficiary ownership is transferable.
contract MuVesting is VestingWallet {
    constructor(address beneficiary, uint64 start_, uint64 duration_) VestingWallet(beneficiary, start_, duration_) {
        require(duration_ > 0, "Duration required");
    }
}

/// Immutable-price membership. Payments go directly to the merchant; no custody.
/// Recurring debits require an explicit, bounded authorization and token allowance.
contract MuSubscription is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable token;
    address public immutable merchant;
    uint256 public immutable price;
    uint64 public immutable period;
    string public name;
    mapping(address => uint256) public paidUntil;
    mapping(address => uint256) public renewalsRemaining;
    event Paid(address indexed member, uint256 amount, uint256 expiresAt);
    event RenewalAuthorization(address indexed member, uint256 remaining);

    constructor(address token_, address merchant_, string memory name_, uint256 price_, uint64 period_) {
        require(token_.code.length > 0 && merchant_ != address(0), "Invalid payment destination");
        require(price_ > 0 && period_ >= 1 days && period_ <= 365 days, "Invalid terms");
        require(bytes(name_).length > 0 && bytes(name_).length <= 80, "Invalid name");
        token = IERC20(token_); merchant = merchant_; name = name_; price = price_; period = period_;
    }
    function active(address member) external view returns (bool) { return paidUntil[member] > block.timestamp; }
    function subscribe(uint256 periods) external nonReentrant {
        require(periods > 0 && periods <= 12, "Choose 1 to 12 periods");
        _pay(msg.sender, periods);
    }
    function authorizeRenewals(uint256 count) external {
        require(count <= 12, "At most 12 renewals");
        renewalsRemaining[msg.sender] = count;
        emit RenewalAuthorization(msg.sender, count);
    }
    function renewFor(address member) external nonReentrant {
        require(paidUntil[member] <= block.timestamp, "Membership still active");
        require(renewalsRemaining[member] > 0, "Renewal not authorized");
        renewalsRemaining[member]--;
        _pay(member, 1);
    }
    function _pay(address member, uint256 periods) private {
        uint256 from = paidUntil[member] > block.timestamp ? paidUntil[member] : block.timestamp;
        paidUntil[member] = from + periods * period;
        token.safeTransferFrom(member, merchant, price * periods);
        emit Paid(member, price * periods, paidUntil[member]);
    }
}
