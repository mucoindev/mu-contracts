// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC20Wrapper} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Wrapper.sol";
import {ERC20Votes} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorVotes} from "@openzeppelin/contracts/governance/extensions/GovernorVotes.sol";
import {GovernorVotesQuorumFraction} from "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {GovernorStorage} from "@openzeppelin/contracts/governance/extensions/GovernorStorage.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IVotes} from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// Deposit MUO 1:1 and delegate voting power. Withdrawal burns the receipt.
contract MuVotes is ERC20, ERC20Wrapper, ERC20Votes {
    constructor(IERC20 underlying_) ERC20("MU Governance Ore", "gMUO") ERC20Wrapper(underlying_) EIP712("MU Governance Ore", "1") {
        require(address(underlying_).code.length > 0, "Token required");
    }
    function clock() public view override returns (uint48) { return uint48(block.timestamp); }
    function CLOCK_MODE() public pure override returns (string memory) { return "mode=timestamp"; }
    function decimals() public view override(ERC20, ERC20Wrapper) returns(uint8) { return super.decimals(); }
    function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) { super._update(from, to, value); }
}

contract MuTimelock is TimelockController {
    constructor(address governor, uint256 delay_) TimelockController(delay_, _one(governor), _one(governor), address(0)) {}
    function _one(address a) private pure returns(address[] memory out) { out = new address[](1); out[0] = a; }
}

/// The governor alone proposes/executes through the treasury timelock.
/// There is no deployer admin. Governance settings change through proposals.
contract MuGovernor is Governor, GovernorSettings, GovernorCountingSimple, GovernorVotes, GovernorVotesQuorumFraction, GovernorTimelockControl, GovernorStorage {
    uint256 public immutable minimumQuorum;
    mapping(uint256 => string) public descriptions;
    constructor(IVotes votes_, uint48 delay_, uint32 period_, uint256 threshold_, uint256 quorumPercent_, uint256 minimumQuorum_, uint256 executionDelay_)
        Governor("MU DAO") GovernorSettings(delay_, period_, threshold_) GovernorVotes(votes_)
        GovernorVotesQuorumFraction(quorumPercent_) GovernorTimelockControl(new MuTimelock(address(this), executionDelay_)) {
        require(delay_ >= 1 hours && period_ >= 1 days && executionDelay_ >= 1 days, "Delays too short");
        require(threshold_ > 0 && minimumQuorum_ > 0 && quorumPercent_ > 0, "Participation required");
        minimumQuorum = minimumQuorum_;
    }
    function votingDelay() public view override(Governor, GovernorSettings) returns(uint256) { return super.votingDelay(); }
    function votingPeriod() public view override(Governor, GovernorSettings) returns(uint256) { return super.votingPeriod(); }
    function proposalThreshold() public view override(Governor, GovernorSettings) returns(uint256) { return super.proposalThreshold(); }
    function quorum(uint256 timepoint) public view override(Governor, GovernorVotesQuorumFraction) returns(uint256) {
        uint256 fraction = super.quorum(timepoint); return fraction > minimumQuorum ? fraction : minimumQuorum;
    }
    function state(uint256 id) public view override(Governor, GovernorTimelockControl) returns(ProposalState) { return super.state(id); }
    function proposalNeedsQueuing(uint256 id) public view override(Governor, GovernorTimelockControl) returns(bool) { return super.proposalNeedsQueuing(id); }
    function _queueOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) returns(uint48) { return super._queueOperations(id, targets, values, calldatas, descriptionHash); }
    function _executeOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) { super._executeOperations(id, targets, values, calldatas, descriptionHash); }
    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) returns(uint256) { return super._cancel(targets, values, calldatas, descriptionHash); }
    function _executor() internal view override(Governor, GovernorTimelockControl) returns(address) { return super._executor(); }
    function _propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, string memory description, address proposer) internal override(Governor, GovernorStorage) returns(uint256) {
        require(bytes(description).length > 0 && bytes(description).length <= 4000 && targets.length <= 10, "Proposal too large or empty");
        uint256 id = super._propose(targets, values, calldatas, description, proposer);
        descriptions[id] = description; return id;
    }
}
