// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Governor} from "@openzeppelin/contracts/governance/Governor.sol";
import {GovernorSettings} from "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import {GovernorCountingSimple} from "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import {GovernorTimelockControl} from "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import {GovernorStorage} from "@openzeppelin/contracts/governance/extensions/GovernorStorage.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Checkpoints} from "@openzeppelin/contracts/utils/structs/Checkpoints.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract MuTimelock is TimelockController {
    constructor(address governor, uint256 delay_) TimelockController(delay_, _one(governor), _one(governor), address(0)) {}
    function _one(address a) private pure returns(address[] memory out) { out = new address[](1); out[0] = a; }
}

/// Original MUO/MUV deposits, with no receipt token or delegation.
/// Deposits belong to members, not the separately controlled treasury.
contract MuGovernor is Governor, GovernorSettings, GovernorCountingSimple, GovernorTimelockControl, GovernorStorage, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using Checkpoints for Checkpoints.Trace208;
    using SafeCast for uint256;

    IERC20 public immutable muo;
    IERC20 public immutable muv;
    mapping(address => Checkpoints.Trace208) private _muoBalances;
    mapping(address => Checkpoints.Trace208) private _muvBalances;
    Checkpoints.Trace208 private _muoTotal;
    Checkpoints.Trace208 private _muvTotal;
    Checkpoints.Trace208 private _multipliers;
    Checkpoints.Trace208 private _quorumPercents;
    Checkpoints.Trace208 private _quorumFloors;
    mapping(address => uint256) public lockedUntil;
    mapping(uint256 => string) public descriptions;
    struct Policy { uint32 multiplier; uint32 percent; uint208 floor; }
    mapping(uint256 => Policy) public proposalPolicy;

    event Deposited(address indexed account, uint256 muoAmount, uint256 muvAmount);
    event Withdrawn(address indexed account, uint256 muoAmount, uint256 muvAmount);
    event VotingLocked(address indexed account, uint256 until);
    event MuvMultiplierChanged(uint32 multiplier);
    event QuorumChanged(uint32 percent, uint208 floor);

    constructor(IERC20 muo_, IERC20 muv_, uint48 delay_, uint32 period_, uint256 threshold_, uint32 quorumPercent_, uint208 minimumQuorum_, uint256 executionDelay_)
        Governor("MU DAO") GovernorSettings(delay_, period_, threshold_)
        GovernorTimelockControl(new MuTimelock(address(this), executionDelay_)) {
        require(address(muo_).code.length > 0 && address(muv_).code.length > 0 && muo_ != muv_, "Two voting tokens required");
        require(delay_ >= 1 hours && period_ >= 1 days && executionDelay_ >= 1 days, "Delays too short");
        require(threshold_ > 0, "Participation required");
        muo = muo_; muv = muv_;
        _multipliers.push(clock(), 4);
        _setQuorum(quorumPercent_, minimumQuorum_);
    }
    function clock() public view override returns (uint48) { return uint48(block.timestamp); }
    function CLOCK_MODE() public pure override returns (string memory) { return "mode=timestamp"; }
    function muvMultiplier() public view returns (uint32) { return uint32(_multipliers.latest()); }
    function quorumNumerator() public view returns (uint32) { return uint32(_quorumPercents.latest()); }
    function minimumQuorum() public view returns (uint208) { return _quorumFloors.latest(); }
    function deposits(address account) public view returns (uint256 muoAmount, uint256 muvAmount) {
        return (_muoBalances[account].latest(), _muvBalances[account].latest());
    }
    function totalDeposits() public view returns (uint256 muoAmount, uint256 muvAmount) {
        return (_muoTotal.latest(), _muvTotal.latest());
    }
    function deposit(uint256 muoAmount, uint256 muvAmount) external nonReentrant {
        require(muoAmount > 0 || muvAmount > 0, "Amount required");
        _depositToken(muo, _muoBalances[msg.sender], _muoTotal, muoAmount);
        _depositToken(muv, _muvBalances[msg.sender], _muvTotal, muvAmount);
        emit Deposited(msg.sender, muoAmount, muvAmount);
    }
    function _depositToken(IERC20 token, Checkpoints.Trace208 storage balances, Checkpoints.Trace208 storage total, uint256 amount) private {
        if (amount == 0) return;
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, "Exact deposit required");
        balances.push(clock(), (uint256(balances.latest()) + amount).toUint208());
        total.push(clock(), (uint256(total.latest()) + amount).toUint208());
    }
    function withdraw(uint256 muoAmount, uint256 muvAmount) external nonReentrant {
        require(clock() > lockedUntil[msg.sender], "Voting deposits locked");
        require(muoAmount > 0 || muvAmount > 0, "Amount required");
        _withdrawToken(muo, _muoBalances[msg.sender], _muoTotal, muoAmount);
        _withdrawToken(muv, _muvBalances[msg.sender], _muvTotal, muvAmount);
        emit Withdrawn(msg.sender, muoAmount, muvAmount);
    }
    function _withdrawToken(IERC20 token, Checkpoints.Trace208 storage balances, Checkpoints.Trace208 storage total, uint256 amount) private {
        if (amount == 0) return;
        balances.push(clock(), (uint256(balances.latest()) - amount).toUint208());
        total.push(clock(), (uint256(total.latest()) - amount).toUint208());
        token.safeTransfer(msg.sender, amount);
    }
    function setMuvMultiplier(uint32 multiplier) external onlyGovernance {
        require(multiplier > 1, "MUV must have higher weight");
        _multipliers.push(clock(), multiplier);
        emit MuvMultiplierChanged(multiplier);
    }
    function setQuorum(uint32 percent, uint208 floor) external onlyGovernance { _setQuorum(percent, floor); }
    function _setQuorum(uint32 percent, uint208 floor) private {
        require(percent > 0 && percent <= 100 && floor > 0, "Participation required");
        _quorumPercents.push(clock(), percent); _quorumFloors.push(clock(), floor);
        emit QuorumChanged(percent, floor);
    }
    function _past(Checkpoints.Trace208 storage trace, uint256 timepoint) private view returns (uint256) {
        require(timepoint < clock(), "Past timestamp required");
        return trace.upperLookupRecent(timepoint.toUint48());
    }
    function _power(address account, uint256 timepoint, uint256 multiplier) private view returns (uint256) {
        // A past balance alone cannot vote after its original tokens leave custody.
        return Math.min(_past(_muoBalances[account], timepoint), _muoBalances[account].latest())
            + Math.min(_past(_muvBalances[account], timepoint), _muvBalances[account].latest()) * multiplier;
    }
    function _getVotes(address account, uint256 timepoint, bytes memory) internal view override returns (uint256) {
        return _power(account, timepoint, _past(_multipliers, timepoint));
    }
    function quorum(uint256 timepoint) public view override returns (uint256) {
        uint256 supply = _past(_muoTotal, timepoint) + _past(_muvTotal, timepoint) * _past(_multipliers, timepoint);
        return Math.max(_past(_quorumFloors, timepoint), Math.mulDiv(supply, _past(_quorumPercents, timepoint), 100));
    }
    /// Proposal-specific policy is fixed at creation, including during the voting delay.
    function proposalQuorum(uint256 id) public view returns (uint256) {
        uint256 snapshot = proposalSnapshot(id);
        require(snapshot != 0, "Unknown proposal");
        Policy memory policy = proposalPolicy[id];
        uint256 at = Math.min(snapshot, clock() - 1);
        uint256 supply = _past(_muoTotal, at) + _past(_muvTotal, at) * policy.multiplier;
        return Math.max(policy.floor, Math.mulDiv(supply, policy.percent, 100));
    }
    function proposalVotingPower(uint256 id, address account) public view returns (uint256) {
        uint256 snapshot = proposalSnapshot(id);
        require(snapshot != 0, "Unknown proposal");
        return _power(account, Math.min(snapshot, clock() - 1), proposalPolicy[id].multiplier);
    }
    function _quorumReached(uint256 id) internal view override(Governor, GovernorCountingSimple) returns (bool) {
        (, uint256 forVotes, uint256 abstainVotes) = proposalVotes(id);
        return forVotes + abstainVotes >= proposalQuorum(id);
    }
    function _lock(address account, uint256 deadline) private {
        if (deadline > lockedUntil[account]) { lockedUntil[account] = deadline; emit VotingLocked(account, deadline); }
    }
    function _castVote(uint256 id, address account, uint8 support, string memory reason, bytes memory params) internal override returns (uint256) {
        _validateStateBitmap(id, _encodeStateBitmap(ProposalState.Active));
        uint256 weight = proposalVotingPower(id, account);
        require(weight > 0, "Deposit before voting opens");
        uint256 votedWeight = _countVote(id, account, support, weight, params);
        _lock(account, proposalDeadline(id));
        if (params.length == 0) emit VoteCast(account, id, support, votedWeight, reason);
        else emit VoteCastWithParams(account, id, support, votedWeight, reason, params);
        _tallyUpdated(id);
        return votedWeight;
    }
    /// Governance may move rewards/accidental assets, never approve or spend voting deposits.
    function relay(address target, uint256 value, bytes calldata data) public payable override nonReentrant {
        require(target != address(muo) && target != address(muv), "Voting tokens protected");
        super.relay(target, value, data);
        require(muo.balanceOf(address(this)) >= _muoTotal.latest() && muv.balanceOf(address(this)) >= _muvTotal.latest(), "Voting deposits protected");
    }
    function votingDelay() public view override(Governor, GovernorSettings) returns(uint256) { return super.votingDelay(); }
    function votingPeriod() public view override(Governor, GovernorSettings) returns(uint256) { return super.votingPeriod(); }
    function proposalThreshold() public view override(Governor, GovernorSettings) returns(uint256) { return super.proposalThreshold(); }
    function state(uint256 id) public view override(Governor, GovernorTimelockControl) returns(ProposalState) { return super.state(id); }
    function proposalNeedsQueuing(uint256 id) public view override(Governor, GovernorTimelockControl) returns(bool) { return super.proposalNeedsQueuing(id); }
    function _queueOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) returns(uint48) { return super._queueOperations(id, targets, values, calldatas, descriptionHash); }
    function _executeOperations(uint256 id, address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) { super._executeOperations(id, targets, values, calldatas, descriptionHash); }
    function _cancel(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, bytes32 descriptionHash) internal override(Governor, GovernorTimelockControl) returns(uint256) { return super._cancel(targets, values, calldatas, descriptionHash); }
    function _executor() internal view override(Governor, GovernorTimelockControl) returns(address) { return super._executor(); }
    function _propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, string memory description, address proposer) internal override(Governor, GovernorStorage) returns(uint256) {
        require(bytes(description).length > 0 && bytes(description).length <= 4000 && targets.length <= 10, "Proposal too large or empty");
        uint256 id = super._propose(targets, values, calldatas, description, proposer);
        proposalPolicy[id] = Policy(muvMultiplier(), quorumNumerator(), minimumQuorum());
        descriptions[id] = description;
        _lock(proposer, proposalDeadline(id));
        return id;
    }
}
