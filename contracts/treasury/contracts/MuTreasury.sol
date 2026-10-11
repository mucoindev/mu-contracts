// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IWrappedNative { function deposit() external payable; }
interface IJoeRouter {
    function factory() external view returns (address);
    function swapExactTokensForTokens(uint amountIn,uint amountOutMin,address[] calldata path,address to,uint deadline) external returns(uint[] memory);
    function addLiquidity(address a,address b,uint ad,uint bd,uint am,uint bm,address to,uint deadline) external returns(uint,uint,uint);
    function removeLiquidity(address a,address b,uint liquidity,uint am,uint bm,address to,uint deadline) external returns(uint,uint);
}
interface IJoeFactory { function getPair(address,address) external view returns(address); }

/// Existing MUV inventory only. Payments and LP positions belong to this treasury.
/// Owner is the treasury controller (a wallet initially, transferable to DAO governance).
/// Published reference prices are controller-approved snapshots, NOT a live spot oracle.
contract MuTreasury is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable muv;
    IERC20 public immutable mu;
    IJoeRouter public immutable router;
    address public immutable wrappedNative;
    uint16 public discountBps = 2500;
    bool public saleOpen;
    uint256 public revision;
    uint256 public totalSold;
    struct Price { uint256 referencePerMuv; uint64 publishedAt; uint64 validUntil; }
    mapping(address => Price) public prices;
    mapping(address => uint256) public totalReceived;
    event ReferenceSet(address indexed asset,uint256 referencePerMuv,uint64 validUntil,uint256 revision);
    event DiscountSet(uint16 discountBps,uint256 revision);
    event SaleSet(bool open,uint256 revision);
    event InventoryFunded(address indexed donor,uint256 amount);
    event Purchased(address indexed buyer,address indexed asset,uint256 muvAmount,uint256 paid,uint256 revision);
    event LiquidityDeployed(address indexed asset,address indexed pair,uint256 assetUsed,uint256 muUsed,uint256 lp);
    event LiquidityRemoved(address indexed asset,address indexed pair,uint256 lp,uint256 assetReceived,uint256 muReceived);
    event Withdrawn(address indexed token,address indexed controller,uint256 amount);

    constructor(address controller,address muv_,address mu_,address router_,address wrapped_) Ownable(controller) {
        require(muv_.code.length>0 && mu_.code.length>0 && router_.code.length>0 && wrapped_.code.length>0,"Invalid contracts");
        require(muv_!=mu_ && wrapped_!=mu_ && wrapped_!=muv_,"Invalid tokens");
        muv=IERC20(muv_); mu=IERC20(mu_); router=IJoeRouter(router_); wrappedNative=wrapped_;
    }
    function setDiscount(uint16 bps) external onlyOwner {
        require(bps<=5000,"Discount exceeds 50%");
        discountBps=bps; emit DiscountSet(bps,++revision);
    }
    function setReference(address asset,uint256 referencePerMuv,uint64 validUntil) external onlyOwner {
        require(asset.code.length>0 && asset!=address(muv) && asset!=address(mu),"Invalid asset");
        require(referencePerMuv>0 && validUntil>block.timestamp && validUntil<=block.timestamp+7 days,"Invalid reference");
        prices[asset]=Price(referencePerMuv,uint64(block.timestamp),validUntil);
        emit ReferenceSet(asset,referencePerMuv,validUntil,++revision);
    }
    function disableAsset(address asset) external onlyOwner {
        delete prices[asset]; emit ReferenceSet(asset,0,0,++revision);
    }
    function setSaleOpen(bool open) external onlyOwner {
        saleOpen=open; emit SaleSet(open,++revision);
    }
    function fundInventory(uint256 amount) external nonReentrant {
        require(amount>0,"Zero amount");
        uint256 beforeBalance=muv.balanceOf(address(this));
        muv.safeTransferFrom(msg.sender,address(this),amount);
        require(muv.balanceOf(address(this))-beforeBalance==amount,"Transfer fee unsupported");
        emit InventoryFunded(msg.sender,amount);
    }
    function quote(address asset,uint256 amount) public view returns(uint256 payment) {
        Price memory p=prices[asset];
        require(amount>0 && p.referencePerMuv>0 && block.timestamp<p.validUntil,"Reference unavailable or expired");
        uint256 referenceCost=Math.mulDiv(amount,p.referencePerMuv,1e18,Math.Rounding.Ceil);
        payment=Math.mulDiv(referenceCost,10000-discountBps,10000,Math.Rounding.Ceil);
    }
    function _check(address asset,uint256 amount,uint256 maxPayment,uint256 expectedRevision,uint256 deadline) private view returns(uint256 cost) {
        require(saleOpen,"Sale paused");
        require(block.timestamp<=deadline && deadline<=block.timestamp+20 minutes,"Quote expired");
        require(expectedRevision==revision,"Terms changed; refresh quote");
        require(amount<=muv.balanceOf(address(this)),"Insufficient MUV inventory");
        cost=quote(asset,amount); require(cost<=maxPayment,"Payment exceeds limit");
    }
    function buy(address asset,uint256 amount,uint256 maxPayment,uint256 expectedRevision,uint256 deadline) external nonReentrant {
        uint256 cost=_check(asset,amount,maxPayment,expectedRevision,deadline);
        uint256 beforeBalance=IERC20(asset).balanceOf(address(this));
        IERC20(asset).safeTransferFrom(msg.sender,address(this),cost);
        require(IERC20(asset).balanceOf(address(this))-beforeBalance==cost,"Transfer fee unsupported");
        _deliver(asset,amount,cost);
    }
    function buyNative(uint256 amount,uint256 expectedRevision,uint256 deadline) external payable nonReentrant {
        uint256 cost=_check(wrappedNative,amount,msg.value,expectedRevision,deadline);
        require(msg.value==cost,"Send exact AVAX amount");
        IWrappedNative(wrappedNative).deposit{value:cost}();
        _deliver(wrappedNative,amount,cost);
    }
    function _deliver(address asset,uint256 amount,uint256 cost) private {
        totalSold+=amount; totalReceived[asset]+=cost;
        muv.safeTransfer(msg.sender,amount);
        emit Purchased(msg.sender,asset,amount,cost,revision);
    }
    /// Separate treasury decision. All swap output, LP and unused assets remain here.
    function deployLiquidity(address asset,uint256 budget,uint256 swapAmount,bool viaWrapped,uint256 minMuOut,uint256 minAssetUsed,uint256 minMuUsed,uint256 deadline) external onlyOwner nonReentrant {
        require(asset!=address(mu) && asset!=address(muv) && asset.code.length>0,"Invalid asset");
        require(budget>swapAmount && swapAmount>0 && minMuOut>0 && minAssetUsed>0 && minMuUsed>0,"Invalid limits");
        require(deadline>=block.timestamp,"Invalid deadline");
        require(IERC20(asset).balanceOf(address(this))>=budget,"Insufficient reserve");
        address pair=IJoeFactory(router.factory()).getPair(asset,address(mu));
        require(pair!=address(0),"Create pool first");
        require(!viaWrapped || asset!=wrappedNative,"Invalid path");
        address[] memory path=new address[](viaWrapped?3:2); path[0]=asset; path[path.length-1]=address(mu);
        if(viaWrapped) path[1]=wrappedNative;
        IERC20(asset).forceApprove(address(router),swapAmount);
        uint256 beforeMu=mu.balanceOf(address(this));
        router.swapExactTokensForTokens(swapAmount,minMuOut,path,address(this),deadline);
        uint256 acquired=mu.balanceOf(address(this))-beforeMu;
        require(acquired>=minMuOut,"Insufficient swap output");
        IERC20(asset).forceApprove(address(router),budget-swapAmount);
        mu.forceApprove(address(router),acquired);
        (uint256 a,uint256 m,uint256 lp)=router.addLiquidity(asset,address(mu),budget-swapAmount,acquired,minAssetUsed,minMuUsed,address(this),deadline);
        require(lp>0,"No LP received");
        IERC20(asset).forceApprove(address(router),0); mu.forceApprove(address(router),0);
        emit LiquidityDeployed(asset,pair,a,m,lp);
    }
    function removeLiquidity(address asset,uint256 lp,uint256 minAsset,uint256 minMu,uint256 deadline) external onlyOwner nonReentrant {
        require(lp>0 && minAsset>0 && minMu>0,"Invalid limits");
        require(deadline>=block.timestamp,"Invalid deadline");
        address pair=IJoeFactory(router.factory()).getPair(asset,address(mu));
        require(pair!=address(0),"Pool unavailable");
        IERC20(pair).forceApprove(address(router),lp);
        (uint256 a,uint256 m)=router.removeLiquidity(asset,address(mu),lp,minAsset,minMu,address(this),deadline);
        IERC20(pair).forceApprove(address(router),0);
        emit LiquidityRemoved(asset,pair,lp,a,m);
    }
    /// Owner can recover reserves, MUV or LP for governance-approved redeployment.
    function withdraw(address token,uint256 amount) external onlyOwner nonReentrant {
        require(amount>0,"Zero amount");
        IERC20(token).safeTransfer(owner(),amount); emit Withdrawn(token,owner(),amount);
    }
    /// Losing the controller would permanently immobilize protocol assets.
    function renounceOwnership() public override onlyOwner { revert("Transfer controller instead"); }
}
