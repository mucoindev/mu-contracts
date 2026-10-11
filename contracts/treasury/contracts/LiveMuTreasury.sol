// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface ILiveMuOracle { function getMugUSDPrice() external view returns(uint256); function getMuUSDprice() external view returns(uint256); }
interface ILiveMuPair { function token0() external view returns(address); function token1() external view returns(address); function getReserves() external view returns(uint112,uint112,uint32); }
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
/// 1 MUV uses the existing MU Gold oracle price, with a governable discount.
contract LiveMuTreasury is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public immutable muv;
    IERC20 public immutable mu;
    IJoeRouter public immutable router;
    address public immutable wrappedNative;
    uint16 public discountBps = 2500;
    bool public saleOpen;
    uint256 public revision;
    uint256 public totalSold;
    ILiveMuOracle public immutable priceOracle;
    address public immutable stablecoin;
    address public immutable bitcoin;
    ILiveMuPair public immutable nativePair;
    ILiveMuPair public immutable bitcoinPair;
    mapping(address => bool) public enabled;
    event AssetSet(address indexed asset,bool enabled,uint256 revision);
    mapping(address => uint256) public totalReceived;
    event DiscountSet(uint16 discountBps,uint256 revision);
    event SaleSet(bool open,uint256 revision);
    event InventoryFunded(address indexed donor,uint256 amount);
    event Purchased(address indexed buyer,address indexed asset,uint256 muvAmount,uint256 paid,uint256 revision);
    event LiquidityDeployed(address indexed asset,address indexed pair,uint256 assetUsed,uint256 muUsed,uint256 lp);
    event LiquidityRemoved(address indexed asset,address indexed pair,uint256 lp,uint256 assetReceived,uint256 muReceived);
    event Withdrawn(address indexed token,address indexed controller,uint256 amount);

    constructor(address controller,address muv_,address mu_,address router_,address wrapped_,address oracle_,address stable_,address bitcoin_,address nativePair_,address bitcoinPair_) Ownable(controller) {
        require(muv_.code.length>0 && mu_.code.length>0 && router_.code.length>0 && wrapped_.code.length>0,"Invalid contracts");
        require(muv_!=mu_ && wrapped_!=mu_ && wrapped_!=muv_,"Invalid tokens");
        muv=IERC20(muv_); mu=IERC20(mu_); router=IJoeRouter(router_); wrappedNative=wrapped_;
        require(oracle_.code.length>0 && stable_.code.length>0 && bitcoin_.code.length>0,"Invalid pricing contracts");
        priceOracle=ILiveMuOracle(oracle_); stablecoin=stable_; bitcoin=bitcoin_;
        nativePair=ILiveMuPair(nativePair_); bitcoinPair=ILiveMuPair(bitcoinPair_);
        _validatePair(nativePair,mu_,wrapped_); _validatePair(bitcoinPair,mu_,bitcoin_);
        enabled[stable_]=true; enabled[wrapped_]=true; enabled[bitcoin_]=true;
    }
    function setDiscount(uint16 bps) external onlyOwner {
        require(bps<=5000,"Discount exceeds 50%");
        discountBps=bps; emit DiscountSet(bps,++revision);
    }
    function pricingVersion() external pure returns(uint256) { return 2; }
    function _validatePair(ILiveMuPair pair,address mu_,address asset) private view {
        address a=pair.token0(); address b=pair.token1();
        require((a==mu_ && b==asset)||(a==asset && b==mu_),"Wrong pricing pool");
    }
    function setAssetEnabled(address asset,bool value) public onlyOwner {
        require(asset==stablecoin || asset==wrappedNative || asset==bitcoin,"Unsupported asset");
        enabled[asset]=value; emit AssetSet(asset,value,++revision);
    }
    function disableAsset(address asset) external onlyOwner { setAssetEnabled(asset,false); }
    // Amount of payment token (raw units) per MUV. Stablecoin uses the same
    // USD unit as the ecosystem oracle; other assets use their MU pool ratio.
    function referencePrice(address asset) public view returns(uint256) {
        require(enabled[asset],"Asset disabled");
        uint256 mugUsd=priceOracle.getMugUSDPrice();
        require(mugUsd>0,"MU Gold price unavailable");
        if(asset==stablecoin) return Math.ceilDiv(mugUsd,1e12);
        uint256 muUsd=priceOracle.getMuUSDprice();
        require(muUsd>0,"MU price unavailable");
        ILiveMuPair pair=asset==wrappedNative?nativePair:bitcoinPair;
        (uint112 r0,uint112 r1,)=pair.getReserves();
        (uint256 muReserve,uint256 assetReserve)=pair.token0()==address(mu)?(uint256(r0),uint256(r1)):(uint256(r1),uint256(r0));
        require(muReserve>0 && assetReserve>0,"Pricing pool empty");
        uint256 muPerMuv=Math.mulDiv(mugUsd,1e18,muUsd,Math.Rounding.Ceil);
        return Math.mulDiv(muPerMuv,assetReserve,muReserve,Math.Rounding.Ceil);
    }
    // ABI-compatible read for the UI; no manual reference publication exists.
    function prices(address asset) external view returns(uint256,uint64,uint64) {
        if(!enabled[asset]) return (0,0,0);
        return (referencePrice(asset),uint64(block.timestamp),type(uint64).max);
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
        require(amount>0,"Zero amount");
        uint256 referenceCost=Math.mulDiv(amount,referencePrice(asset),1e18,Math.Rounding.Ceil);
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
        IWrappedNative(wrappedNative).deposit{value:cost}();
        _deliver(wrappedNative,amount,cost);
        if(msg.value>cost){ (bool refunded,)=msg.sender.call{value:msg.value-cost}(""); require(refunded,"Refund failed"); }
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
