// Verified source recovered from Routescan/Snowtrace (Avalanche C-Chain 43114)
// Address: 0x12127E06c0A2C82368BFC9C5a05E86B24429838a
// Label (docs-notes): New Rewards Contract (incl MUV)
// ContractName: MuRewards  Compiler: v0.8.0+commit.c7dfd78e  Optimization: 0 runs=200  EVM:   License: 
// ConstructorArguments: (none)
// Retrieved: 2026-10-11T02:21:56.931Z

// ===== File: contracts/MuRewards.sol =====
// OpenZeppelin Contracts v4.4.1 (token/ERC20/IERC20.sol)
// SPDX-License-Identifier: MIT


pragma solidity ^0.8.0;

/**
 * @dev Interface of the ERC20 standard as defined in the EIP.
 */
interface IERC20 {
    /**
     * @dev Returns the amount of tokens in existence.
     */
    function totalSupply() external view returns (uint256);

    /**
     * @dev Returns the amount of tokens owned by `account`.
     */
    function balanceOf(address account) external view returns (uint256);

    /**
     * @dev Moves `amount` tokens from the caller's account to `recipient`.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transfer(address recipient, uint256 amount) external returns (bool);

    /**
     * @dev Returns the remaining number of tokens that `spender` will be
     * allowed to spend on behalf of `owner` through {transferFrom}. This is
     * zero by default.
     *
     * This value changes when {approve} or {transferFrom} are called.
     */
    function allowance(address owner, address spender) external view returns (uint256);

    /**
     * @dev Sets `amount` as the allowance of `spender` over the caller's tokens.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * IMPORTANT: Beware that changing an allowance with this method brings the risk
     * that someone may use both the old and the new allowance by unfortunate
     * transaction ordering. One possible solution to mitigate this race
     * condition is to first reduce the spender's allowance to 0 and set the
     * desired value afterwards:
     * https://github.com/ethereum/EIPs/issues/20#issuecomment-263524729
     *
     * Emits an {Approval} event.
     */
    function approve(address spender, uint256 amount) external returns (bool);

    /**
     * @dev Moves `amount` tokens from `sender` to `recipient` using the
     * allowance mechanism. `amount` is then deducted from the caller's
     * allowance.
     *
     * Returns a boolean value indicating whether the operation succeeded.
     *
     * Emits a {Transfer} event.
     */
    function transferFrom(
        address sender,
        address recipient,
        uint256 amount
    ) external returns (bool);

    /**
     * @dev Emitted when `value` tokens are moved from one account (`from`) to
     * another (`to`).
     *
     * Note that `value` may be zero.
     */
    event Transfer(address indexed from, address indexed to, uint256 value);

    /**
     * @dev Emitted when the allowance of a `spender` for an `owner` is set by
     * a call to {approve}. `value` is the new allowance.
     */
    event Approval(address indexed owner, address indexed spender, uint256 value);
}



interface IMuOre{
    function getHolders() external view returns (address[] memory);
    function getHoldersCount() external view returns (uint256);
}

interface IMuVault{
    function getHolders() external view returns (address[] memory);
    function getHoldersCount() external view returns (uint256);
}

contract MuRewards{
    IMuOre _iMuOre;
    IERC20 _muOre;

    IMuVault _iMuVault;
    IERC20 _muVault;

    uint256 public muVaultMultiplier;

    
    constructor(){
        _iMuOre = IMuOre(0x561f2209eA45023d796bF42F0402B33bc26610ce);
        _muOre = IERC20(0x561f2209eA45023d796bF42F0402B33bc26610ce);

        _iMuVault = IMuVault(0xdbA664085ae73CF4E4eb57954BDC88Be297B1f09);
        _muVault = IERC20(0xdbA664085ae73CF4E4eb57954BDC88Be297B1f09);

        muVaultMultiplier = 5;
    }


   

    function MU_REWARDS_PAYMENT(address token) public virtual  {
        IERC20 tokenContract = IERC20(token);
        uint256 total_payment = tokenContract.balanceOf(address(this)) * 10**10;
        uint256 payment_sliver = total_payment/getPaymentSlivers();
        uint256 payment_shares = 0;
        uint256 reward_payment = 0;
        //pay MU Ore Holders
        address[] memory payees  = _iMuOre.getHolders();
        for(uint256 i = 0; i < payees.length; i++){
            if(_muOre.balanceOf(payees[i]) > 0){

                if(payees[i] == 0xdbA664085ae73CF4E4eb57954BDC88Be297B1f09){
                        //skip the Mu Vault address
                }else{
                    payment_shares = _muOre.balanceOf(payees[i]);
                    reward_payment = (payment_shares * payment_sliver)/10**10;
                    tokenContract.transfer(payees[i], reward_payment);
                }
                
                
            }
            
        }

        //pay MU Valut Holders
        address[] memory payeesV  = _iMuVault.getHolders();
        for(uint256 i = 0; i < payeesV.length; i++){
            if(_muVault.balanceOf(payeesV[i]) > 0){        
                    payment_shares = _muVault.balanceOf(payeesV[i]);
                    reward_payment = ((payment_shares * muVaultMultiplier) * payment_sliver)/10**10;
                    tokenContract.transfer(payeesV[i], reward_payment);
            }
            
        }
    }

    function get_MUV_multiplier()  public virtual view returns(uint256){
        return(muVaultMultiplier);
    }
     function set_MUV_multiplier(uint256 m) public virtual{
         if(msg.sender == 0xcf084Bf66d2fCF8721bEcA538F2eC0CB1c06A0bb)
            muVaultMultiplier = m;
    }

    function getPaymentSlivers()  public virtual view returns(uint256){
        return(getTrueOre() + (getVault() * muVaultMultiplier));
    }

    function getTrueOre()  public virtual view returns(uint256){
        return(_muOre.totalSupply() - _muVault.totalSupply());
    }
     function getOre()  public virtual view returns(uint256){
        return(_muOre.totalSupply());
    }
     function getVault()  public virtual view returns(uint256){
        return(_muVault.totalSupply());
    }

   
    
    function withdrawlOverride(address token) public virtual  {
            IERC20 tokenContract = IERC20(token);
            tokenContract.transfer(0xF243d79910cBd70a0eaF405b08E80065a67D5e14, tokenContract.balanceOf(address(this)));    
    }

    
   

}