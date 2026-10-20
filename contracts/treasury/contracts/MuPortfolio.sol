// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IPortfolioLB {
    struct Path { uint256[] pairBinSteps; uint8[] versions; address[] tokenPath; }
    function swapExactTokensForTokens(uint256 amountIn, uint256 minOut, Path calldata path, address to, uint256 deadline) external returns (uint256);
}
interface IPortfolioV1 {
    function factory() external view returns (address);
    function addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256) external returns(uint256,uint256,uint256);
    function removeLiquidity(address,address,uint256,uint256,uint256,address,uint256) external returns(uint256,uint256);
}
interface IPortfolioFactory { function getPair(address,address) external view returns(address); }
interface IPortfolioWrapped { function deposit() external payable; }

/// @notice Wallet-owned investment lots. A buy, its MU Gold fee, and optional
/// V1 liquidity deposit either all succeed or all revert. No admin withdrawal,
/// upgrade key, arbitrary call facility, or discretionary asset rescue exists.
contract MuPortfolio is ReentrancyGuard {
    using SafeERC20 for IERC20;
    address public immutable usdc;
    address public immutable mug;
    address public immutable feeRecipient;
    address public immutable router;
    address public immutable liquidityRouter;
    address public immutable factory;
    address public immutable aggregator;
    address public immutable wrappedNative;
    uint256 public constant FEE_BPS = 10;
    mapping(address => bool) public supported;
    uint256 public positionCount;
    mapping(address => uint256[]) private ownerIds;

    struct Swap { address target; uint256 minOut; bytes data; IPortfolioLB.Path path; }
    struct Leg { address token; uint256 amountIn; Swap swap; }
    struct Funding { address token; uint256 amount; Swap swap; }
    struct Position {
        address owner;
        uint64 createdAt;
        uint64 closedAt;
        uint8 exitKind; // 0 open, 1 sold for USDC, 2 withdrawn in kind
        string name;
        uint256 totalUSDC;
        uint256 feeUSDC;
        uint256 feeMUG;
        address[] tokens;
        uint256[] costs;
        uint256[] bought;
        uint256[] held;
        address pair;
        uint256 lp;
        uint256 proceeds;
        uint256[] exitAmounts;
        uint256 exitedLp;
        address sourceToken;
        uint256 sourceAmount;
        uint256 reserveUSDC;
        uint64 openedBlock;
        uint64 closedBlock;
    }
    mapping(uint256 => Position) private positions;
    event Opened(uint256 indexed id, address indexed owner, uint256 totalUSDC, uint256 feeMUG, address pair, uint256 lp);
    event Closed(uint256 indexed id, address indexed owner, uint8 kind, uint256 proceeds);

    constructor(address usdc_, address mug_, address recipient_, address router_, address lpRouter_, address aggregator_, address[] memory assets) {
        require(usdc_.code.length > 0 && mug_.code.length > 0 && router_.code.length > 0 && lpRouter_.code.length > 0 && recipient_ != address(0), "configuration");
        require(assets.length > 0 && assets.length <= 6 && aggregator_.code.length > 0, "assets");
        usdc = usdc_; mug = mug_; feeRecipient = recipient_; router = router_; liquidityRouter = lpRouter_;
        aggregator = aggregator_; wrappedNative = assets[0];
        supported[usdc_] = true;
        factory = IPortfolioV1(lpRouter_).factory();
        require(factory.code.length > 0, "factory");
        for (uint256 i; i < assets.length; ++i) {
            require(assets[i].code.length > 0 && assets[i] != usdc_ && !supported[assets[i]], "asset");
            supported[assets[i]] = true;
        }
    }
    function ownerPositionCount(address owner) external view returns(uint256) { return ownerIds[owner].length; }
    function ownerPositionId(address owner, uint256 index) external view returns(uint256) { return ownerIds[owner][index]; }
    function getPosition(uint256 id) external view returns(Position memory) { require(positions[id].owner != address(0), "position"); return positions[id]; }

    function _path(IPortfolioLB.Path calldata path, address from, address to) private pure {
        uint256 n = path.tokenPath.length;
        require(n >= 2 && n <= 7 && path.tokenPath[0] == from && path.tokenPath[n - 1] == to, "path");
        require(path.versions.length == n - 1 && path.pairBinSteps.length == n - 1, "hops");
    }
    function _swap(address from, address to, uint256 amount, uint256 minOut, IPortfolioLB.Path calldata path, address recipient, uint256 deadline) private returns(uint256 received) {
        require(amount > 0 && minOut > 0, "minimum");
        _path(path, from, to);
        uint256 beforeBalance = IERC20(to).balanceOf(recipient);
        IERC20(from).forceApprove(router, amount);
        IPortfolioLB(router).swapExactTokensForTokens(amount, minOut, path, recipient, deadline);
        IERC20(from).forceApprove(router, 0);
        received = IERC20(to).balanceOf(recipient) - beforeBalance;
        require(received >= minOut, "output");
    }
    function _trade(address from, address to, uint256 amount, Swap calldata quote, uint256 deadline) private returns(uint256 output) {
        require(from != to && amount > 0 && quote.minOut > 0, "trade");
        uint256 beforeIn = IERC20(from).balanceOf(address(this));
        if (quote.target == router) {
            output = _swap(from,to,amount,quote.minOut,quote.path,address(this),deadline);
        } else {
            require(quote.target == aggregator, "router");
            uint256 beforeOut = IERC20(to).balanceOf(address(this));
            IERC20(from).forceApprove(aggregator,amount);
            (bool success,bytes memory reason) = aggregator.call(quote.data);
            if (!success) { assembly ("memory-safe") { revert(add(reason,32),mload(reason)) } }
            IERC20(from).forceApprove(aggregator,0);
            output = IERC20(to).balanceOf(address(this)) - beforeOut;
            require(output >= quote.minOut, "aggregator output");
        }
        require(IERC20(from).balanceOf(address(this)) + amount == beforeIn, "exact input");
    }

    /// @param lpMinimums Minimum token A, token B, and LP received; all nonzero for liquidity.
    function open(Funding calldata funding, uint256 total, string calldata name, Leg[] calldata legs, Swap calldata feeSwap, bool provideLiquidity, uint256[3] calldata lpMinimums, uint256 deadline) external payable nonReentrant returns(uint256 id) {
        require(block.timestamp <= deadline && deadline <= block.timestamp + 1800, "deadline");
        require(total >= 1e6 && total <= 1e12 && bytes(name).length <= 180, "budget/name");
        require(legs.length > 0 && legs.length <= 4 && (!provideLiquidity || legs.length == 2), "legs");
        uint256 fee = total * FEE_BPS / 10000;
        uint256 sum;
        for (uint256 i; i < legs.length; ++i) {
            require(supported[legs[i].token], "unsupported");
            for (uint256 j; j < i; ++j) require(legs[j].token != legs[i].token, "duplicate");
            sum += legs[i].amountIn;
        }
        require(sum + fee == total, "allocation");
        uint256 beforeUSDC = IERC20(usdc).balanceOf(address(this));
        address source = funding.token == address(0) ? wrappedNative : funding.token;
        require(funding.amount > 0 && (source == usdc || supported[source]), "funding token");
        if (funding.token == address(0)) {
            require(msg.value == funding.amount, "native amount");
            IPortfolioWrapped(wrappedNative).deposit{value: msg.value}();
        } else {
            require(msg.value == 0, "native value");
            uint256 beforeSource = IERC20(source).balanceOf(address(this));
            IERC20(source).safeTransferFrom(msg.sender,address(this),funding.amount);
            require(IERC20(source).balanceOf(address(this)) == beforeSource + funding.amount, "funding");
        }
        uint256 funded = source == usdc ? funding.amount : _trade(source,usdc,funding.amount,funding.swap,deadline);
        require(funded >= total && funded <= 1e12, "funded budget");
        id = ++positionCount;
        Position storage p = positions[id];
        p.owner = msg.sender; p.createdAt = uint64(block.timestamp); p.name = name; p.totalUSDC = funded; p.feeUSDC = fee;
        p.sourceToken = funding.token; p.sourceAmount = funding.amount; p.reserveUSDC = funded - total;
        p.openedBlock = uint64(block.number);
        ownerIds[msg.sender].push(id);
        for (uint256 i; i < legs.length; ++i) {
            Leg calldata l = legs[i];
            require(l.amountIn > 0, "amount");
            uint256 output = l.token == usdc ? l.amountIn : _trade(usdc, l.token, l.amountIn, l.swap, deadline);
            p.tokens.push(l.token); p.costs.push(l.amountIn); p.bought.push(output); p.held.push(output);
        }
        p.feeMUG = _trade(usdc,mug,fee,feeSwap,deadline);
        IERC20(mug).safeTransfer(feeRecipient,p.feeMUG);
        if (provideLiquidity) {
            require(lpMinimums[0] > 0 && lpMinimums[1] > 0 && lpMinimums[2] > 0, "LP minimum");
            p.pair = IPortfolioFactory(factory).getPair(p.tokens[0], p.tokens[1]);
            require(p.pair != address(0), "pool");
            uint256 beforeLP = IERC20(p.pair).balanceOf(address(this));
            IERC20(p.tokens[0]).forceApprove(liquidityRouter, p.held[0]);
            IERC20(p.tokens[1]).forceApprove(liquidityRouter, p.held[1]);
            (uint256 a, uint256 b,) = IPortfolioV1(liquidityRouter).addLiquidity(p.tokens[0],p.tokens[1],p.held[0],p.held[1],lpMinimums[0],lpMinimums[1],address(this),deadline);
            IERC20(p.tokens[0]).forceApprove(liquidityRouter, 0);
            IERC20(p.tokens[1]).forceApprove(liquidityRouter, 0);
            p.held[0] -= a; p.held[1] -= b;
            p.lp = IERC20(p.pair).balanceOf(address(this)) - beforeLP;
            require(p.lp >= lpMinimums[2], "LP output");
        }
        uint256 heldUSDC;
        for (uint256 i; i < p.tokens.length; ++i) if (p.tokens[i] == usdc) heldUSDC += p.held[i];
        require(IERC20(usdc).balanceOf(address(this)) == beforeUSDC + p.reserveUSDC + heldUSDC, "unspent USDC");
        emit Opened(id, msg.sender, funded, p.feeMUG, p.pair, p.lp);
    }

    function _owned(uint256 id) private view returns(Position storage p) {
        p = positions[id];
        require(p.owner == msg.sender && p.exitKind == 0, "owner/open");
    }
    /// @notice Close one card, remove its liquidity if any, and send all USDC to its owner.
    function cashOut(uint256 id, IPortfolioLB.Path[] calldata paths, uint256[] calldata minOut, uint256[2] calldata lpMinimums, uint256 minTotal, uint256 deadline) external nonReentrant {
        Position storage p = _owned(id);
        require(block.timestamp <= deadline && deadline <= block.timestamp + 1800, "deadline");
        require(paths.length == p.tokens.length && minOut.length == p.tokens.length && minTotal > 0, "exit inputs");
        p.exitKind = 1; p.closedAt = uint64(block.timestamp);
        p.closedBlock = uint64(block.number);
        if (p.reserveUSDC > 0) { p.proceeds = p.reserveUSDC; IERC20(usdc).safeTransfer(msg.sender,p.reserveUSDC); p.reserveUSDC = 0; }
        if (p.lp > 0) {
            require(lpMinimums[0] > 0 && lpMinimums[1] > 0, "LP minimum");
            IERC20(p.pair).forceApprove(liquidityRouter, p.lp);
            (uint256 a,uint256 b) = IPortfolioV1(liquidityRouter).removeLiquidity(p.tokens[0],p.tokens[1],p.lp,lpMinimums[0],lpMinimums[1],address(this),deadline);
            IERC20(p.pair).forceApprove(liquidityRouter, 0);
            p.held[0] += a; p.held[1] += b; p.lp = 0;
        }
        for (uint256 i; i < p.tokens.length; ++i) {
            p.exitAmounts.push(p.held[i]);
            if (p.held[i] > 0) {
                if (p.tokens[i] == usdc) {
                    require(p.held[i] >= minOut[i], "output");
                    p.proceeds += p.held[i];
                    IERC20(usdc).safeTransfer(msg.sender,p.held[i]);
                } else p.proceeds += _swap(p.tokens[i],usdc,p.held[i],minOut[i],paths[i],msg.sender,deadline);
            }
            p.held[i] = 0;
        }
        require(p.proceeds >= minTotal, "total output");
        emit Closed(id,msg.sender,1,p.proceeds);
    }
    /// @notice Router-independent exit. Tokens and LP receipts go only to the card owner.
    function withdrawInKind(uint256 id) external nonReentrant {
        Position storage p = _owned(id);
        p.exitKind = 2; p.closedAt = uint64(block.timestamp);
        p.closedBlock = uint64(block.number);
        if (p.reserveUSDC > 0) { p.proceeds = p.reserveUSDC; IERC20(usdc).safeTransfer(msg.sender,p.reserveUSDC); p.reserveUSDC = 0; }
        for (uint256 i; i < p.tokens.length; ++i) {
            uint256 amount = p.held[i]; p.exitAmounts.push(amount); p.held[i] = 0;
            if (amount > 0) IERC20(p.tokens[i]).safeTransfer(msg.sender, amount);
        }
        p.exitedLp = p.lp; p.lp = 0;
        if (p.exitedLp > 0) IERC20(p.pair).safeTransfer(msg.sender,p.exitedLp);
        emit Closed(id,msg.sender,2,0);
    }
}
