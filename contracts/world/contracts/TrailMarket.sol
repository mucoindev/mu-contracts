// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice Fixed-supply TRAIL and its official MUG-only constant-product market.
/// @dev LP principal, game backing and unsolicited donations are separate balances.
contract TrailMarket is ERC20, Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public mug;
    address public rewards;
    address public gameSigner;
    bool public paused = true;
    uint256 public constant feeBps = 100;
    uint256 public constant INITIAL_RATIO = 100;
    uint256 public constant FIXED_SUPPLY = 10_000_000 ether;
    uint256 public constant MINIMUM_LIQUIDITY = 1000;
    uint256 public reserveMug;
    uint256 public reserveTrail;
    uint256 public totalLiquidity;
    uint256 public gameBacking;
    mapping(address => uint256) public liquidityOf;
    mapping(address => mapping(uint256 => bool)) public usedNonces;

    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("Withdraw(address account,uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    event LiquidityAdded(address indexed account, uint256 mugAmount, uint256 trailAmount, uint256 shares);
    event LiquidityRemoved(address indexed account, uint256 mugAmount, uint256 trailAmount, uint256 shares);
    event Swap(address indexed account, bool mugToTrail, uint256 amountIn, uint256 amountOut, uint256 feeMug);
    event GameDeposit(address indexed account, uint256 amount);
    event GameRewardsFunded(address indexed account, uint256 amount);
    event GameWithdrawal(address indexed account, uint256 amount, uint256 nonce);
    event GameSignerChanged(address indexed signer);
    event PauseChanged(bool paused);

    constructor(address mug_, address rewards_, address gameSigner_) ERC20("Trail Coins", "TRAIL") Ownable(msg.sender) {
        require(mug_ != address(0) && rewards_ != address(0) && gameSigner_ != address(0), "Zero address");
        require(mug_.code.length != 0 && mug_ != address(this) && rewards_ != address(this), "Invalid address");
        mug = mug_;
        rewards = rewards_;
        gameSigner = gameSigner_;
        _mint(msg.sender, FIXED_SUPPLY);
    }

    modifier timely(uint256 deadline) { require(block.timestamp <= deadline, "Expired"); _; }
    modifier trading() { require(!paused, "Paused"); _; }

    function setPaused(bool value) external onlyOwner { paused = value; emit PauseChanged(value); }
    function setGameSigner(address signer) external onlyOwner {
        require(signer != address(0), "Zero address");
        gameSigner = signer;
        emit GameSignerChanged(signer);
    }

    function quoteMugForTrail(uint256 amountIn) public view returns (uint256 trailOut, uint256 feeMug) {
        if (amountIn == 0 || reserveMug == 0 || reserveTrail == 0) return (0, 0);
        feeMug = Math.mulDiv(amountIn, feeBps, 10_000, Math.Rounding.Ceil);
        uint256 net = amountIn - feeMug;
        trailOut = Math.mulDiv(reserveTrail, net, reserveMug + net);
    }

    function quoteTrailForMug(uint256 amountIn) public view returns (uint256 mugOut, uint256 feeMug) {
        if (amountIn == 0 || reserveMug == 0 || reserveTrail == 0) return (0, 0);
        uint256 gross = Math.mulDiv(reserveMug, amountIn, reserveTrail + amountIn);
        feeMug = Math.mulDiv(gross, feeBps, 10_000, Math.Rounding.Ceil);
        mugOut = gross - feeMug;
    }

    function swapMugForTrail(uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant timely(deadline) trading returns (uint256 amountOut) {
        uint256 fee;
        (amountOut, fee) = quoteMugForTrail(amountIn);
        require(amountOut != 0 && amountOut >= minOut, "Slippage");
        _takeMug(msg.sender, amountIn);
        reserveMug += amountIn - fee;
        reserveTrail -= amountOut;
        _transfer(address(this), msg.sender, amountOut);
        IERC20(mug).safeTransfer(rewards, fee);
        emit Swap(msg.sender, true, amountIn, amountOut, fee);
    }

    function swapTrailForMug(uint256 amountIn, uint256 minOut, uint256 deadline) external nonReentrant timely(deadline) trading returns (uint256 amountOut) {
        uint256 fee;
        (amountOut, fee) = quoteTrailForMug(amountIn);
        require(amountOut != 0 && amountOut >= minOut, "Slippage");
        _takeTrail(msg.sender, amountIn);
        reserveTrail += amountIn;
        reserveMug -= amountOut + fee;
        IERC20(mug).safeTransfer(msg.sender, amountOut);
        IERC20(mug).safeTransfer(rewards, fee);
        emit Swap(msg.sender, false, amountIn, amountOut, fee);
    }

    /// @dev Liquidity management stays available while paused. First LP sets 100 TRAIL / MUG.
    function addLiquidity(uint256 maxMug, uint256 maxTrail, uint256 minMug, uint256 minTrail, uint256 deadline) external nonReentrant timely(deadline) returns (uint256 shares, uint256 mugUsed, uint256 trailUsed) {
        require(maxMug > 0 && maxTrail > 0, "Zero amount");
        if (totalLiquidity == 0) {
            mugUsed = maxMug;
            trailUsed = maxMug * INITIAL_RATIO;
            require(trailUsed <= maxTrail, "Initial ratio");
            uint256 minted = Math.sqrt(mugUsed * trailUsed);
            require(minted > MINIMUM_LIQUIDITY, "Small liquidity");
            shares = minted - MINIMUM_LIQUIDITY;
            liquidityOf[address(1)] = MINIMUM_LIQUIDITY;
            totalLiquidity = MINIMUM_LIQUIDITY;
        } else {
            mugUsed = maxMug;
            trailUsed = Math.mulDiv(maxMug, reserveTrail, reserveMug);
            if (trailUsed > maxTrail) {
                trailUsed = maxTrail;
                mugUsed = Math.mulDiv(maxTrail, reserveMug, reserveTrail);
            }
            shares = Math.min(Math.mulDiv(mugUsed, totalLiquidity, reserveMug), Math.mulDiv(trailUsed, totalLiquidity, reserveTrail));
        }
        require(shares > 0 && mugUsed > 0 && trailUsed > 0, "Small liquidity");
        require(mugUsed >= minMug && trailUsed >= minTrail, "Slippage");
        _takeMug(msg.sender, mugUsed);
        _takeTrail(msg.sender, trailUsed);
        reserveMug += mugUsed;
        reserveTrail += trailUsed;
        totalLiquidity += shares;
        liquidityOf[msg.sender] += shares;
        emit LiquidityAdded(msg.sender, mugUsed, trailUsed, shares);
    }

    function removeLiquidity(uint256 shares, uint256 minMug, uint256 minTrail, uint256 deadline) external nonReentrant timely(deadline) returns (uint256 mugOut, uint256 trailOut) {
        require(shares > 0 && shares <= liquidityOf[msg.sender], "Invalid shares");
        mugOut = Math.mulDiv(reserveMug, shares, totalLiquidity);
        trailOut = Math.mulDiv(reserveTrail, shares, totalLiquidity);
        require(mugOut > 0 && trailOut > 0 && mugOut >= minMug && trailOut >= minTrail, "Slippage");
        liquidityOf[msg.sender] -= shares;
        totalLiquidity -= shares;
        reserveMug -= mugOut;
        reserveTrail -= trailOut;
        IERC20(mug).safeTransfer(msg.sender, mugOut);
        _transfer(address(this), msg.sender, trailOut);
        emit LiquidityRemoved(msg.sender, mugOut, trailOut, shares);
    }

    function fundGameRewards(uint256 amount) external nonReentrant {
        _wholeCoins(amount);
        _takeTrail(msg.sender, amount);
        gameBacking += amount;
        emit GameRewardsFunded(msg.sender, amount);
    }

    function depositGame(uint256 amount) external nonReentrant trading {
        _wholeCoins(amount);
        _takeTrail(msg.sender, amount);
        gameBacking += amount;
        emit GameDeposit(msg.sender, amount);
    }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("TrailMarket"), keccak256("1"), block.chainid, address(this)));
    }

    /// @dev The game signer authorizes ledger exits, never LP principal. Server must debit its ledger first.
    function withdrawGame(address account, uint256 amount, uint256 nonce, uint256 deadline, bytes calldata signature) external nonReentrant timely(deadline) {
        require(msg.sender == account, "Wrong account");
        _wholeCoins(amount);
        require(!usedNonces[account][nonce], "Nonce used");
        require(amount <= gameBacking, "Game backing");
        bytes32 data = keccak256(abi.encode(WITHDRAW_TYPEHASH, account, amount, nonce, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), data));
        require(ECDSA.recover(digest, signature) == gameSigner, "Invalid signature");
        usedNonces[account][nonce] = true;
        gameBacking -= amount;
        _transfer(address(this), account, amount);
        emit GameWithdrawal(account, amount, nonce);
    }

    function _wholeCoins(uint256 amount) private pure { require(amount > 0 && amount % 1 ether == 0, "Whole coins only"); }
    function _takeTrail(address account, uint256 amount) private {
        _spendAllowance(account, address(this), amount);
        _transfer(account, address(this), amount);
    }
    function _takeMug(address account, uint256 amount) private {
        uint256 beforeBalance = IERC20(mug).balanceOf(address(this));
        IERC20(mug).safeTransferFrom(account, address(this), amount);
        require(IERC20(mug).balanceOf(address(this)) == beforeBalance + amount, "Unsupported MUG transfer");
    }
}
