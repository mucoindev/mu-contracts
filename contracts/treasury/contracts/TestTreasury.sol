// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract TestToken is ERC20 {
    uint8 private immutable digits;
    bool public fee;
    constructor(uint8 d) ERC20("Test","TEST"){digits=d;}
    function decimals() public view override returns(uint8){return digits;}
    function mint(address to,uint n) external {_mint(to,n);}
    function setFee(bool value) external {fee=value;}
    function _update(address from,address to,uint n) internal override {
        if(fee&&from!=address(0)&&to!=address(0)&&n>100){super._update(from,address(0),n/100);n-=n/100;}
        super._update(from,to,n);
    }
    function deposit() external payable {_mint(msg.sender,msg.value);}
}
contract TestRouter {
    TestToken public pair;
    bool public exists=true;
    uint public lastSwap;
    constructor(){pair=new TestToken(18);}
    function factory() external view returns(address){return address(this);}
    function getPair(address,address) external view returns(address){return exists?address(pair):address(0);}
    function setExists(bool b) external {exists=b;}
    function swapExactTokensForTokens(uint n,uint min,address[] calldata path,address to,uint deadline) external returns(uint[] memory out){
        require(block.timestamp<=deadline,"expired");require(n>=min,"slippage");
        TestToken(path[0]).transferFrom(msg.sender,address(this),n);TestToken(path[path.length-1]).mint(to,n);lastSwap=n;
        out=new uint[](2);out[0]=n;out[1]=n;
    }
    function addLiquidity(address a,address b,uint ad,uint bd,uint am,uint bm,address to,uint deadline) external returns(uint,uint,uint){
        require(block.timestamp<=deadline&&ad>=am&&bd>=bm,"slippage");
        TestToken(a).transferFrom(msg.sender,address(this),ad);TestToken(b).transferFrom(msg.sender,address(this),bd);
        pair.mint(to,ad);return(ad,bd,ad);
    }
    function removeLiquidity(address a,address b,uint n,uint am,uint bm,address to,uint deadline) external returns(uint,uint){
        require(block.timestamp<=deadline&&n>=am&&n>=bm,"slippage");
        pair.transferFrom(msg.sender,address(this),n);TestToken(a).transfer(to,n);TestToken(b).transfer(to,n);return(n,n);
    }
}

contract TestMuPriceOracle {
    uint256 public getMugUSDPrice=8e18;
    uint256 public getMuUSDprice=2e16;
    function setPrices(uint256 mug,uint256 mu) external { getMugUSDPrice=mug; getMuUSDprice=mu; }
}
contract TestPricePair {
    address public token0; address public token1;
    uint112 private r0; uint112 private r1;
    constructor(address a,address b,uint112 aReserve,uint112 bReserve) { token0=a;token1=b;r0=aReserve;r1=bReserve; }
    function getReserves() external view returns(uint112,uint112,uint32) { return (r0,r1,uint32(block.timestamp)); }
    function setReserves(uint112 a,uint112 b) external { r0=a;r1=b; }
}
