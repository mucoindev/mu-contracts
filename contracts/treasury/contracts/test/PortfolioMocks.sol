// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPortfolioLB} from "../MuPortfolio.sol";
contract PortfolioToken is ERC20 {
    constructor() ERC20("Test", "TEST") {}
    function mint(address to,uint256 n) external { _mint(to,n); }
    function burn(address from,uint256 n) external { _burn(from,n); }
    function deposit() external payable { _mint(msg.sender,msg.value); }
}
contract PortfolioSwapMock {
    bool public fail;
    function setFail(bool b) external { fail=b; }
    function swapExactTokensForTokens(uint256 n,uint256 min,IPortfolioLB.Path calldata p,address to,uint256) external returns(uint256) {
        require(!fail && n >= min,"swap failed");
        IERC20(p.tokenPath[0]).transferFrom(msg.sender,address(this),n);
        PortfolioToken(p.tokenPath[p.tokenPath.length-1]).mint(to,n);
        return n;
    }
    function aggregate(address from,address to,uint256 n,address recipient,uint256 output) external {
        IERC20(from).transferFrom(msg.sender,address(this),n);
        PortfolioToken(to).mint(recipient,output);
    }
}
contract PortfolioPoolMock is PortfolioToken {
    address public a; address public b;
    constructor(address a_,address b_) { a=a_; b=b_; }
    function add(uint256 x,uint256 y,address recipient) external { _mint(recipient,x < y ? x : y); }
    function remove(uint256 n,address recipient) external { _burn(msg.sender,n); IERC20(a).transfer(recipient,n); IERC20(b).transfer(recipient,n); }
}
contract PortfolioLPFactoryMock {
    address public pair;
    constructor(address p) { pair=p; }
    function getPair(address,address) external view returns(address) { return pair; }
}
contract PortfolioLPMock {
    address public factory; PortfolioPoolMock public pair;
    constructor(address a,address b) { pair=new PortfolioPoolMock(a,b); factory=address(new PortfolioLPFactoryMock(address(pair))); }
    function addLiquidity(address a,address b,uint256 x,uint256 y,uint256 minA,uint256 minB,address to,uint256) external returns(uint256,uint256,uint256) {
        uint256 n=x < y ? x:y; require(n>=minA && n>=minB,"LP min");
        IERC20(a).transferFrom(msg.sender,address(pair),n); IERC20(b).transferFrom(msg.sender,address(pair),n);
        pair.add(n,n,to); return(n,n,n);
    }
    function removeLiquidity(address,address,uint256 n,uint256 minA,uint256 minB,address to,uint256) external returns(uint256,uint256) {
        require(n>=minA && n>=minB,"LP min"); pair.transferFrom(msg.sender,address(this),n); pair.remove(n,to); return(n,n);
    }
}
