// Verified source recovered from Routescan/Snowtrace (Avalanche C-Chain 43114)
// Address: 0x5b9438372a6641Efbd9f285ab6931E190Ed841eB
// Label (docs-notes): Mu Price Oracle (SubscriptionFactory.sol)
// ContractName: MuPriceOracle  Compiler: v0.8.7+commit.e28d00a7  Optimization: 0 runs=200  EVM:   License: 
// ConstructorArguments: 0x00000000000000000000000000000000000000000000000003c9daf5693be000000000000000000000000000000000000000000000000000f486d0a52e620000
// Retrieved: 2026-10-11T02:21:52.927Z

// ===== File: MuPriceOracle.sol =====
// File: contracts/MuPriceOracle.sol



pragma solidity ^0.8.0;


interface IMuPriceOracle{
    function get_cost_In_MUG_USD(uint256 cost) external returns(uint256);//returns the cost of something priced in USD in terms of MUG IE $300 is how many MUG
    function get_MUG_USD_price() external returns(uint256);//returns the price of MU in USD
    function get_MU_USD_price() external returns(uint256);//returns the price of MU in USD
    function get_MUG_MU_price() external returns(uint256);//return the price of MUG in MU
    function get_last_price_update_time() external returns(uint256);//gets the block timestamp with time was updated last
}

contract MuPriceOracle is IMuPriceOracle{
    uint256 public _MU_USD_price;
    uint256 public _MUG_MU_price;
    uint256 public _MUG_USD_price;
    uint256 public _last_price_update;
    address public _owner;

    constructor(uint256 mu_usd, uint256 mug_mu){
        _owner = msg.sender;
        _MU_USD_price = mu_usd;
        _MUG_MU_price = mug_mu;
        _MUG_USD_price = (_MU_USD_price * _MUG_MU_price)/10**18;
        _last_price_update = block.timestamp;
    }  
    function set_prices(uint256 mu_usd, uint256 mug_mu) public virtual{
        require(msg.sender == _owner, "You can't call this fucntion mother fucker");
        _MU_USD_price = mu_usd;
        _MUG_MU_price = mug_mu;
        _MUG_USD_price = (_MU_USD_price * _MUG_MU_price)/10**18;
        _last_price_update = block.timestamp;
    }
    function get_MU_USD_price() public virtual view override returns (uint256){
        return _MU_USD_price;
    }
    function get_MUG_MU_price() public virtual view override returns (uint256){
        return _MUG_MU_price;
    }
    function get_MUG_USD_price() public virtual view override returns (uint256){
        return _MUG_USD_price;
    }
    function get_cost_In_MUG_USD(uint256 cost) public virtual view override returns(uint256){
        return (cost/_MUG_USD_price)*10**18;
    }
    function get_last_price_update_time() public virtual view override returns (uint256){
        return _last_price_update;
    }

}