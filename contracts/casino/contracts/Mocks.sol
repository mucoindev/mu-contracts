// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {MuCasino, ICoordinator} from './MuCasino.sol';
contract MockMUG is ERC20 {
    constructor() ERC20('Mock MU Gold', 'MUG') { _mint(msg.sender, 100000 ether); }
}
contract MockCoordinator is ICoordinator {
    uint256 public counter;
    mapping(uint256 => address) public consumers;
    function requestRandomWords(Request calldata req) external returns (uint256) {
        require(req.requestConfirmations == 10 && req.callbackGasLimit == 150000 && req.numWords == 1, 'Wrong VRF config');
        require(keccak256(req.extraArgs) == keccak256(abi.encodeWithSelector(bytes4(keccak256('VRF ExtraArgsV1')), true)), 'Wrong args');
        consumers[++counter] = msg.sender; return counter;
    }
    function fulfill(uint256 id, uint256 word) external {
        uint256[] memory words = new uint256[](1); words[0] = word;
        MuCasino(consumers[id]).rawFulfillRandomWords(id, words);
    }
}
