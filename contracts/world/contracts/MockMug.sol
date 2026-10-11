// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
/// @dev Local test fixture only; never part of the production deployment artifact.
contract MockMug is ERC20 {
    bool public taxed;
    address public callback;
    bytes public callbackData;
    bool public callbackBlocked;
    constructor() ERC20("Mock MUG", "MUG") { _mint(msg.sender, 1_000_000 ether); }
    function setTaxed(bool value) external { taxed = value; }
    function setCallback(address target, bytes calldata data) external { callback = target; callbackData = data; }
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (callback != address(0)) { (bool ok,) = callback.call(callbackData); callbackBlocked = !ok; }
        _spendAllowance(from, msg.sender, amount);
        if (taxed && amount > 1) { _transfer(from, to, amount - 1); _burn(from, 1); }
        else _transfer(from, to, amount);
        return true;
    }
}
