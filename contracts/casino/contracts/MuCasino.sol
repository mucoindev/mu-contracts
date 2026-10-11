// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';

// Wire ABI from Chainlink VRFV2PlusClient, MIT:
// github.com/smartcontractkit/chainlink-brownie-contracts/blob/main/contracts/src/v0.8/vrf/dev/libraries/VRFV2PlusClient.sol
interface ICoordinator {
    struct Request { bytes32 keyHash; uint256 subId; uint16 requestConfirmations; uint32 callbackGasLimit; uint32 numWords; bytes extraArgs; }
    function requestRandomWords(Request calldata request) external returns (uint256);
}

/// @notice All accounting is MUG wei. The UI displays 100 credits per MUG.
/// Player liabilities are reserved before randomness is requested. Owner capital withdrawals cannot touch player liabilities.
contract MuCasino is ReentrancyGuard {
    using SafeERC20 for IERC20;
    IERC20 public token;
    address public rewards;
    address public owner;
    address public coordinator;
    uint256 public subscriptionId;
    bytes32 public keyHash;
    bool public paused = true;
    uint256 public totalCredits;
    uint256 public reservedPayouts;
    uint256 public lotteryPots;
    uint256 public bankrollPrincipal;
    uint256 public totalRewardsSent;
    mapping(address => uint256) public credits;
    mapping(address => uint256) public latestBet;
    uint256 public constant TICKET = 0.1 ether; // 10 credits
    uint256 public constant MIN_BET = 0.01 ether; // 1 credit
    uint256 public roundId;
    struct Bet { address player; uint256 stake; uint256 payout; uint8 game; uint8 choice; bool settled; uint8 outcome; }
    struct Randomness { bool exists; bool ready; uint256 word; }
    struct Round { uint256 closesAt; uint256 tickets; uint256 pot; uint256 requestId; bool settled; address winner; uint256 winningTicket; }
    struct Entry { address player; uint256 end; }
    mapping(uint256 => Bet) public bets;
    mapping(uint256 => Randomness) public randomness;
    mapping(uint256 => Round) public rounds;
    mapping(uint256 => Entry[]) private entries;
    mapping(uint256 => mapping(address => uint256[])) private ownedEntries;
    mapping(uint256 => mapping(address => uint256)) public ticketsOf;
    event Deposit(address indexed player, uint256 amount);
    event Withdrawal(address indexed player, uint256 amount);
    event BetRequested(address indexed player, uint256 indexed requestId, uint8 game, uint256 stake, uint8 choice);
    event BetSettled(address indexed player, uint256 indexed requestId, uint8 outcome, uint256 payout);
    event RoundOpened(uint256 indexed id, uint256 closesAt);
    event TicketsBought(uint256 indexed id, address indexed player, uint256 count);
    event DrawRequested(uint256 indexed id, uint256 indexed requestId);
    event RoundSettled(uint256 indexed id, address indexed winner, uint256 prize, uint256 ticket);
    event BankrollFunded(address indexed sender, uint256 amount);
    event BankrollWithdrawn(uint256 amount);
    event RewardsSent(uint256 amount);
    event Paused(bool paused);

    constructor(address mug, address recipient, address vrf, uint256 sub, bytes32 lane) {
        require(mug.code.length > 0 && vrf.code.length > 0 && recipient != address(0) && sub > 0 && lane != bytes32(0), 'Invalid configuration');
        token = IERC20(mug); rewards = recipient; coordinator = vrf;
        subscriptionId = sub; keyHash = lane; owner = msg.sender;
    }
    modifier active() { require(!paused, 'New play paused'); _; }
    function setPaused(bool value) external { require(msg.sender == owner, 'Owner only'); paused = value; emit Paused(value); }
    function liabilities() public view returns (uint256) { return totalCredits + reservedPayouts + lotteryPots; }
    function availableProfit() public view returns (uint256) {
        uint256 backing = liabilities() + bankrollPrincipal;
        uint256 balance = token.balanceOf(address(this));
        return balance > backing ? balance - backing : 0;
    }
    function _receive(uint256 amount) private {
        require(amount > 0, 'Zero amount');
        uint256 beforeBalance = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        require(token.balanceOf(address(this)) == beforeBalance + amount, 'Transfer fee unsupported');
    }
    function deposit(uint256 amount) external nonReentrant active {
        _receive(amount); credits[msg.sender] += amount; totalCredits += amount; emit Deposit(msg.sender, amount);
    }
    function withdraw(uint256 amount) external nonReentrant {
        require(amount > 0 && credits[msg.sender] >= amount, 'Insufficient credits');
        credits[msg.sender] -= amount; totalCredits -= amount;
        token.safeTransfer(msg.sender, amount); emit Withdrawal(msg.sender, amount);
    }
    /// Risk capital: never counted as distributable profit or a player balance.
    function fundBankroll(uint256 amount) external nonReentrant {
        _receive(amount); bankrollPrincipal += amount; emit BankrollFunded(msg.sender, amount);
    }
    function withdrawBankroll(uint256 amount) external nonReentrant {
        require(msg.sender == owner, 'Owner only');
        require(amount > 0 && amount <= bankrollPrincipal, 'Exceeds bankroll principal');
        require(token.balanceOf(address(this)) >= liabilities() + amount, 'Player funds reserved');
        bankrollPrincipal -= amount;
        token.safeTransfer(owner, amount); emit BankrollWithdrawn(amount);
    }
    function sendProfitToRewards() external nonReentrant {
        uint256 amount = availableProfit(); require(amount > 0, 'No earned profit');
        totalRewardsSent += amount; token.safeTransfer(rewards, amount); emit RewardsSent(amount);
    }
    function _debit(uint256 amount) private {
        require(credits[msg.sender] >= amount, 'Insufficient credits');
        credits[msg.sender] -= amount; totalCredits -= amount;
    }
    function _request() private returns (uint256 id) {
        id = ICoordinator(coordinator).requestRandomWords(ICoordinator.Request({
            keyHash: keyHash, subId: subscriptionId, requestConfirmations: 10,
            callbackGasLimit: 150000, numWords: 1,
            extraArgs: abi.encodeWithSelector(bytes4(keccak256('VRF ExtraArgsV1')), true)
        }));
        require(id != 0 && !randomness[id].exists, 'Duplicate request');
        randomness[id].exists = true;
    }
    function play(uint8 game, uint8 choice, uint256 stake) external nonReentrant active returns (uint256 id) {
        require(game < 2 && choice < 2 && stake >= MIN_BET && stake <= 100 ether, 'Invalid bet');
        uint256 previous = latestBet[msg.sender];
        require(previous == 0 || bets[previous].settled, 'Settle previous bet');
        _debit(stake);
        uint256 payout = stake * 196 / 100;
        reservedPayouts += payout;
        require(token.balanceOf(address(this)) >= liabilities(), 'Bankroll too small');
        id = _request();
        bets[id] = Bet(msg.sender, stake, payout, game, choice, false, 0);
        latestBet[msg.sender] = id;
        emit BetRequested(msg.sender, id, game, stake, choice);
    }
    // A coordinator callback only stores the result. It never transfers or settles.
    function rawFulfillRandomWords(uint256 id, uint256[] calldata words) external {
        require(msg.sender == coordinator, 'Coordinator only');
        Randomness storage r = randomness[id];
        if (!r.exists || r.ready || words.length == 0) return;
        r.ready = true; r.word = words[0];
    }
    function settleBet(uint256 id) external nonReentrant {
        Bet storage b = bets[id];
        require(b.player != address(0) && !b.settled && randomness[id].ready, 'Bet not ready');
        b.settled = true;
        b.outcome = uint8(randomness[id].word % (b.game == 0 ? 2 : 6));
        bool won = b.game == 0 ? b.outcome == b.choice : b.outcome / 3 == b.choice;
        reservedPayouts -= b.payout;
        uint256 payout = won ? b.payout : 0;
        credits[b.player] += payout; totalCredits += payout;
        emit BetSettled(b.player, id, b.outcome, payout);
    }
    function openRound() external active {
        require(roundId == 0 || rounds[roundId].settled, 'Round still active');
        roundId++;
        rounds[roundId].closesAt = block.timestamp + 1 days;
        emit RoundOpened(roundId, rounds[roundId].closesAt);
    }
    function buyTickets(uint256 id, uint256 count) external nonReentrant active {
        Round storage r = rounds[id];
        require(id == roundId && id > 0 && block.timestamp < r.closesAt && r.requestId == 0, 'Sales closed');
        require(count > 0 && count <= 1000 && entries[id].length < 4096, 'Ticket limit');
        uint256 cost = count * TICKET;
        _debit(cost); r.tickets += count; r.pot += cost; lotteryPots += cost;
        ticketsOf[id][msg.sender] += count;
        ownedEntries[id][msg.sender].push(entries[id].length);
        entries[id].push(Entry(msg.sender, r.tickets));
        emit TicketsBought(id, msg.sender, count);
    }
    /// One-based inclusive ticket ranges, paginated by purchase, for a wallet.
    function getTicketRanges(uint256 id, address player, uint256 offset, uint256 limit)
        external view returns (uint256[] memory first, uint256[] memory last, uint256 purchases)
    {
        require(limit > 0 && limit <= 100, 'Page limit');
        uint256[] storage indexes = ownedEntries[id][player];
        purchases = indexes.length;
        uint256 size = offset >= purchases ? 0 : (purchases - offset < limit ? purchases - offset : limit);
        first = new uint256[](size); last = new uint256[](size);
        for (uint256 i; i < size; i++) {
            uint256 index = indexes[offset + i];
            first[i] = index == 0 ? 1 : entries[id][index - 1].end + 1;
            last[i] = entries[id][index].end;
        }
    }
    function requestDraw(uint256 id) external nonReentrant {
        Round storage r = rounds[id];
        require(id > 0 && id == roundId && !r.settled && r.requestId == 0 && block.timestamp >= r.closesAt, 'Draw unavailable');
        if (r.tickets == 0) { r.settled = true; emit RoundSettled(id, address(0), 0, 0); return; }
        r.requestId = _request(); emit DrawRequested(id, r.requestId);
    }
    function settleRound(uint256 id) external nonReentrant {
        Round storage r = rounds[id];
        require(!r.settled && r.requestId != 0 && randomness[r.requestId].ready, 'Draw not ready');
        uint256 ticket = randomness[r.requestId].word % r.tickets;
        Entry[] storage list = entries[id];
        uint256 lo; uint256 hi = list.length;
        while (lo < hi) { uint256 mid = (lo + hi) / 2; if (list[mid].end > ticket) hi = mid; else lo = mid + 1; }
        address winner = list[lo].player;
        uint256 prize = r.pot * 90 / 100;
        r.settled = true; r.winner = winner; r.winningTicket = ticket + 1;
        lotteryPots -= r.pot; credits[winner] += prize; totalCredits += prize;
        emit RoundSettled(id, winner, prize, ticket + 1);
    }
}
