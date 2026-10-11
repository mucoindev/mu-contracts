// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC2981} from "@openzeppelin/contracts/token/common/ERC2981.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMuPups} from "./interfaces/IMuPups.sol";

/// @title MU Dogy
/// @notice A MU Dogy is born by burning a MU Pup and paying MUG. No Pup, no Dogy.
///
/// Birth (two transactions, both signed by the Pup holder):
///   1. `MUG.approve(MuDogy, price)`
///   2. `Pups.safeTransferFrom(holder, MuDogy, pupId)`
/// In the second transaction this contract receives the Pup, takes `price` MUG
/// from the holder to the treasury, burns the Pup, snapshots the holder's MUO and
/// MUV balances, mints the next Dogy (ERC-721) to the holder and records the birth
/// with three seeds, one per re-roll table.
///
/// Re-roll tables: Core (element / pendant / guardian), Power (strength / hit
/// points / agility) and Traits (visual traits). While a Dogy is unlocked its owner
/// may `reroll(id, table)` any table any number of times. Each table climbs on its
/// own, in a straight line: the n-th reroll of a table costs
/// rerollBase + rerollStep * (n-1) MUG (2, 3, 4, 5 ... at 2 MUG and a 1 MUG step),
/// paid to the treasury. Rerolling one table never changes the other two seeds.
///
/// `lock(id, name)` (the UI's "Mint Dogy" button) finalizes the Dogy: it gets its
/// on-chain name and its seeds can never change again.
///
/// `sacrifice` is the total MUG paid for a Dogy: birth price plus every reroll.
///
/// Traits are NOT stored on-chain. Off-chain metadata (tokenURI) is derived from
/// the birth record: pupId, edition, seeds, MUO/MUV snapshot, sacrifice, name, lock.
///
/// RANDOMNESS (read before mainnet): seeds come from block.prevrandao and the
/// previous blockhash. They are NOT manipulation-proof:
///   - Block producers (validators) see and influence these values.
///   - On Avalanche C-Chain block.prevrandao carries no beacon-chain randomness,
///     so unpredictability rests on the previous blockhash, which is public
///     before the transaction executes.
///   - A holder acting through a smart contract can compute a seed in the same
///     transaction, or revert after seeing it, and so retry births and rerolls
///     for the cost of gas only (a reverted reroll refunds its MUG). This
///     undercuts escalating reroll pricing for anyone willing to do it.
/// This is acceptable only because traits are cosmetic. The upgrade path is
/// Chainlink VRF (available on Avalanche) or commit-reveal, in which the payment
/// is committed in one transaction and the seed fixed in a later one.
///
/// Owner powers are limited to pricing, treasury, metadata base URI, pause,
/// blocking specific Pups, royalties and returning Pups that were sent here by
/// plain `transferFrom` (which skips the birth hook). The owner can NOT move,
/// burn, rename or reroll anyone's Dogy, and the contract never holds user MUG:
/// every payment goes straight from the payer to the treasury.
contract MuDogy is ERC721, ERC2981, Ownable2Step, Pausable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ types

    /// @notice Re-roll tables. Pass the index (0, 1, 2) as `table`.
    enum Table {
        Core, // 0: element, pendant, guardian
        Power, // 1: strength, hit points, agility
        Traits // 2: visual traits
    }

    /// @dev Read fields by name (`births(id).seeds[1]`), not by position: the order
    ///      is chosen for storage packing.
    struct BirthRecord {
        uint16 pupId; // the burned parent Pup (0-349)
        uint64 birthTime; // block.timestamp at birth
        uint8 edition; // 1 = Pup #0-99, 2 = Pup #100-349
        bool locked; // true once lock() was called: named, no more rerolls
        uint32[3] rerollCounts; // rerolls so far, per table
        bytes32[3] seeds; // current seed, per table
        uint256 sacrifice; // total MUG wei paid for this Dogy (birth + rerolls)
        uint256 muo; // holder's MUO balance at birth (wei)
        uint256 muv; // holder's MUV balance at birth (wei)
        string name; // set by lock(), 1-32 bytes
    }

    // -------------------------------------------------------------- constants

    /// @notice Highest MU Pup token id (the collection is #0-349).
    uint256 public constant MAX_PUP_ID = 349;
    /// @notice Pups #0..EDITION_1_LAST_PUP give 1st Edition Dogys; the rest give 2nd Edition.
    uint256 public constant EDITION_1_LAST_PUP = 99;
    /// @notice Pup #349 "MU" (the real Mu Dog) is blocked at deploy until Jon decides.
    uint256 public constant LEGENDARY_PUP_ID = 349;
    /// @notice Number of re-roll tables (Core, Power, Traits).
    uint8 public constant TABLE_COUNT = 3;
    /// @notice Name length limit in bytes (UTF-8), set at lock.
    uint256 public constant MAX_NAME_BYTES = 32;
    /// @notice Royalty cap: 10% (basis points of the sale price).
    uint96 public constant MAX_ROYALTY_BPS = 1_000;
    bytes4 private constant ERC4906_INTERFACE_ID = 0x49064906;
    string private constant DEFAULT_BASE_URI = "https://new.mu.money/nft/mu-dogy/";

    // ------------------------------------------------------------- immutables

    IMuPups public immutable pups;
    IERC20 public immutable mug;
    IERC20 public immutable muo;
    IERC20 public immutable muv;

    // ---------------------------------------------------------------- storage

    /// @notice Receives every MUG payment (births and rerolls).
    address public treasury;
    /// @notice Birth price in MUG wei. 0 = free birth (test mode).
    uint256 public price;
    /// @notice Cost of the first reroll of any table, in MUG wei. Base and step both 0 = free rerolls (test mode).
    uint256 public rerollBase;
    /// @notice Each reroll of a table costs this much MUG wei more than that table's previous one (1e18 = +1 MUG; 0 = flat).
    uint256 public rerollStep;
    /// @notice Pups that can not be used for a birth (e.g. #349 "MU").
    mapping(uint256 pupId => bool) public blocked;
    /// @notice The Dogy born from a Pup, or 0 if none (Dogy ids start at 1).
    mapping(uint256 pupId => uint256 dogyId) public dogyOfPup;

    string private _baseTokenURI;
    uint256 private _nextDogyId = 1;
    mapping(uint256 dogyId => BirthRecord) private _births;

    // ----------------------------------------------------------------- events

    event Birth(
        uint256 indexed dogyId,
        address indexed owner,
        uint256 indexed pupId,
        bytes32[3] seeds,
        uint256 muo,
        uint256 muv,
        uint8 edition
    );
    event Reroll(uint256 indexed dogyId, uint8 indexed table, bytes32 newSeed, uint256 count, uint256 cost);
    event Locked(uint256 indexed dogyId, string name, bytes32[3] seeds);
    event PriceSet(uint256 price);
    event TreasurySet(address indexed treasury);
    event RerollPricingSet(uint256 rerollBase, uint256 rerollStep);
    event BaseURISet(string baseURI);
    event PupBlockedSet(uint256 indexed pupId, bool blocked);
    event RoyaltySet(address indexed receiver, uint96 feeBps);
    event PupReturned(uint256 indexed pupId, address indexed to);
    /// @dev ERC-4906. Tells marketplaces to refresh metadata.
    event MetadataUpdate(uint256 _tokenId);
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);

    // ----------------------------------------------------------------- errors

    error NotPupsContract(address caller);
    error OperatorNotHolder(address operator, address holder);
    error PupOutOfRange(uint256 pupId);
    error PupIsBlocked(uint256 pupId);
    error PupAlreadyUsed(uint256 pupId, uint256 dogyId);
    error PupNotReceived(uint256 pupId);
    error PupNotHeld(uint256 pupId);
    error NotDogyOwner(uint256 dogyId, address caller);
    error DogyLocked(uint256 dogyId);
    error InvalidTable(uint8 table);
    error InvalidName(uint256 byteLength);
    error ZeroAddress();
    error RoyaltyTooHigh(uint96 feeBps, uint96 maxBps);

    // ------------------------------------------------------------ constructor

    /// @param initialOwner Admin (use a multisig on mainnet). Ownership moves only by 2-step transfer.
    /// @param pups_ MU Pups (Mintpeg) contract.
    /// @param mug_ MUG token (birth and reroll payments).
    /// @param muo_ MUO token (snapshotted at birth).
    /// @param muv_ MUV token (snapshotted at birth).
    /// @param treasury_ Receives MUG payments.
    /// @param price_ Birth price in MUG wei (0 = free).
    /// @param rerollBase_ First reroll cost per table in MUG wei (0 = free).
    /// @param rerollStep_ MUG wei each reroll of a table adds to that table's previous one (0 = flat).
    /// @param baseURI_ Metadata base; empty = https://new.mu.money/nft/mu-dogy/
    constructor(
        address initialOwner,
        IMuPups pups_,
        IERC20 mug_,
        IERC20 muo_,
        IERC20 muv_,
        address treasury_,
        uint256 price_,
        uint256 rerollBase_,
        uint256 rerollStep_,
        string memory baseURI_
    ) ERC721("MU Dogy", "MUDOGY") Ownable(initialOwner) {
        if (
            address(pups_) == address(0) || address(mug_) == address(0) || address(muo_) == address(0)
                || address(muv_) == address(0) || treasury_ == address(0)
        ) revert ZeroAddress();

        pups = pups_;
        mug = mug_;
        muo = muo_;
        muv = muv_;

        treasury = treasury_;
        emit TreasurySet(treasury_);
        price = price_;
        emit PriceSet(price_);
        _setRerollPricing(rerollBase_, rerollStep_);

        string memory uri = bytes(baseURI_).length == 0 ? DEFAULT_BASE_URI : baseURI_;
        _baseTokenURI = uri;
        emit BaseURISet(uri);

        blocked[LEGENDARY_PUP_ID] = true;
        emit PupBlockedSet(LEGENDARY_PUP_ID, true);
    }

    // ------------------------------------------------------------------ birth

    /// @notice Birth hook. Called by the Pups contract when a holder does
    ///         `Pups.safeTransferFrom(holder, address(this), pupId)`.
    /// @dev Reverting here reverts the whole transfer, so a failed birth leaves
    ///      the Pup and the MUG with the holder.
    function onERC721Received(address operator, address from, uint256 pupId, bytes calldata)
        external
        override
        nonReentrant
        whenNotPaused
        returns (bytes4)
    {
        // Only real Pups. Any other ERC-721 (or a direct call) is refused, which
        // also stops anyone from calling this to spend a victim's MUG approval.
        if (msg.sender != address(pups)) revert NotPupsContract(msg.sender);
        // Only the holder starts a birth. An approved operator (a marketplace with
        // setApprovalForAll) can not burn someone's Pup and spend their MUG.
        if (operator != from) revert OperatorNotHolder(operator, from);
        if (pupId > MAX_PUP_ID) revert PupOutOfRange(pupId);
        if (blocked[pupId]) revert PupIsBlocked(pupId);
        // Burned Pups can not be transferred again. This guards against the Pups
        // proxy ever re-minting a burned id after an upgrade.
        uint256 existing = dogyOfPup[pupId];
        if (existing != 0) revert PupAlreadyUsed(pupId, existing);
        if (pups.ownerOf(pupId) != address(this)) revert PupNotReceived(pupId);

        uint256 dogyId = _recordBirth(from, pupId);

        uint256 cost = price;
        if (cost != 0) mug.safeTransferFrom(from, treasury, cost);
        pups.burn(pupId);
        _safeMint(from, dogyId);

        return IERC721Receiver.onERC721Received.selector;
    }

    // ----------------------------------------------------------- reroll / lock

    /// @notice Replace one table's seed on an unlocked Dogy. Costs
    ///         `nextRerollCost(dogyId, table)` MUG, paid from the caller to the
    ///         treasury (approve it first). The other tables' seeds are untouched.
    /// @param table 0 = Core, 1 = Power, 2 = Traits.
    function reroll(uint256 dogyId, uint8 table) external nonReentrant whenNotPaused returns (bytes32 newSeed) {
        if (table >= TABLE_COUNT) revert InvalidTable(table);
        _requireDogyOwner(dogyId);
        BirthRecord storage b = _births[dogyId];
        if (b.locked) revert DogyLocked(dogyId);

        uint32 n = b.rerollCounts[table] + 1;
        uint256 cost = rerollCostAt(n);
        newSeed = keccak256(
            abi.encode(
                block.prevrandao,
                blockhash(block.number - 1),
                msg.sender,
                uint256(b.pupId),
                dogyId,
                address(this),
                uint256(table),
                uint256(n),
                b.seeds[table]
            )
        );
        b.seeds[table] = newSeed;
        b.rerollCounts[table] = n;
        if (cost != 0) b.sacrifice += cost;
        emit Reroll(dogyId, table, newSeed, n, cost);
        emit MetadataUpdate(dogyId);

        if (cost != 0) mug.safeTransferFrom(msg.sender, treasury, cost);
    }

    /// @notice Finalize a Dogy ("Mint Dogy" in the UI): give it its on-chain name
    ///         (1-32 bytes of UTF-8) and freeze all three seeds forever.
    /// @dev Allowed while paused: locking moves no value and only removes options.
    ///      The name is stored as given; metadata renderers must escape it.
    function lock(uint256 dogyId, string calldata name) external {
        _requireDogyOwner(dogyId);
        uint256 len = bytes(name).length;
        if (len == 0 || len > MAX_NAME_BYTES) revert InvalidName(len);
        BirthRecord storage b = _births[dogyId];
        if (b.locked) revert DogyLocked(dogyId);

        b.locked = true;
        b.name = name;
        bytes32[3] memory seeds = b.seeds;
        emit Locked(dogyId, name, seeds);
        emit MetadataUpdate(dogyId);
    }

    /// @notice MUG cost of the next reroll of `table` on `dogyId` at current pricing.
    ///         This is what the formula gives even if the Dogy is locked; check
    ///         `births(id).locked` to know whether a reroll is still possible.
    function nextRerollCost(uint256 dogyId, uint8 table) external view returns (uint256) {
        if (table >= TABLE_COUNT) revert InvalidTable(table);
        _requireOwned(dogyId);
        return rerollCostAt(uint256(_births[dogyId].rerollCounts[table]) + 1);
    }

    /// @notice MUG cost of the n-th reroll of a table (n = 1, 2, 3 ...):
    ///         rerollBase + rerollStep * (n-1). A straight line, not a curve: a
    ///         multiplier put 24 rerolls of one table at most of the 100,000 MUG
    ///         there are. Returns type(uint256).max once the cost no longer fits,
    ///         so absurd pricing is unpayable rather than reverting. n = 0 returns 0.
    function rerollCostAt(uint256 n) public view returns (uint256) {
        if (n == 0) return 0;
        uint256 base = rerollBase;
        uint256 step = rerollStep;
        if (step != 0 && n - 1 > (type(uint256).max - base) / step) return type(uint256).max;
        return base + step * (n - 1);
    }

    // ------------------------------------------------------------------ views

    /// @notice The birth record of a Dogy. Reverts for ids that do not exist.
    function births(uint256 dogyId) external view returns (BirthRecord memory) {
        _requireOwned(dogyId);
        return _births[dogyId];
    }

    /// @notice Number of Dogys born so far (Dogys can not be burned).
    function totalSupply() external view returns (uint256) {
        return _nextDogyId - 1;
    }

    /// @notice Id the next birth will get.
    function nextDogyId() external view returns (uint256) {
        return _nextDogyId;
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721, ERC2981) returns (bool) {
        return interfaceId == ERC4906_INTERFACE_ID || super.supportsInterface(interfaceId);
    }

    // ------------------------------------------------------------------ owner

    function setPrice(uint256 newPrice) external onlyOwner {
        price = newPrice;
        emit PriceSet(newPrice);
    }

    function setTreasury(address newTreasury) external onlyOwner {
        if (newTreasury == address(0)) revert ZeroAddress();
        treasury = newTreasury;
        emit TreasurySet(newTreasury);
    }

    function setRerollPricing(uint256 newBase, uint256 newStep) external onlyOwner {
        _setRerollPricing(newBase, newStep);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseURISet(newBaseURI);
        if (_nextDogyId > 1) emit BatchMetadataUpdate(1, _nextDogyId - 1);
    }

    /// @notice Ask marketplaces to re-read metadata for a range of Dogys (ERC-4906),
    ///         e.g. after the off-chain metadata changes as Dogys grow up.
    function refreshMetadata(uint256 fromId, uint256 toId) external onlyOwner {
        emit BatchMetadataUpdate(fromId, toId);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function setBlocked(uint256 pupId, bool isBlocked) external onlyOwner {
        blocked[pupId] = isBlocked;
        emit PupBlockedSet(pupId, isBlocked);
    }

    /// @notice Default ERC-2981 royalty for every Dogy. `receiver == 0` removes it.
    function setRoyalty(address receiver, uint96 feeBps) external onlyOwner {
        if (feeBps > MAX_ROYALTY_BPS) revert RoyaltyTooHigh(feeBps, MAX_ROYALTY_BPS);
        if (receiver == address(0)) {
            _deleteDefaultRoyalty();
            emit RoyaltySet(address(0), 0);
        } else {
            _setDefaultRoyalty(receiver, feeBps);
            emit RoyaltySet(receiver, feeBps);
        }
    }

    /// @notice Return a Pup that reached this contract through plain `transferFrom`
    ///         (which skips the birth hook). A real birth burns the Pup in the same
    ///         transaction, so any Pup held here was sent by mistake.
    function returnStrandedPup(uint256 pupId, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (pups.ownerOf(pupId) != address(this)) revert PupNotHeld(pupId);
        pups.transferFrom(address(this), to, pupId);
        emit PupReturned(pupId, to);
    }

    // --------------------------------------------------------------- internal

    /// @dev Effects of a birth: allocate the id, snapshot MUO/MUV, derive the
    ///      three table seeds and write the record. No value moves here.
    function _recordBirth(address from, uint256 pupId) private returns (uint256 dogyId) {
        dogyId = _nextDogyId++;
        uint256 muoBalance = muo.balanceOf(from);
        uint256 muvBalance = muv.balanceOf(from);
        uint8 edition = pupId <= EDITION_1_LAST_PUP ? 1 : 2;

        bytes32[3] memory seeds;
        for (uint256 t = 0; t < TABLE_COUNT; ++t) {
            seeds[t] = keccak256(
                abi.encode(block.prevrandao, blockhash(block.number - 1), from, pupId, dogyId, address(this), t)
            );
        }

        BirthRecord storage b = _births[dogyId];
        b.pupId = uint16(pupId);
        b.birthTime = uint64(block.timestamp);
        b.edition = edition;
        b.seeds = seeds;
        b.sacrifice = price;
        b.muo = muoBalance;
        b.muv = muvBalance;
        dogyOfPup[pupId] = dogyId;

        emit Birth(dogyId, from, pupId, seeds, muoBalance, muvBalance, edition);
    }

    function _requireDogyOwner(uint256 dogyId) private view {
        if (_requireOwned(dogyId) != msg.sender) revert NotDogyOwner(dogyId, msg.sender);
    }

    function _setRerollPricing(uint256 newBase, uint256 newStep) private {
        rerollBase = newBase;
        rerollStep = newStep;
        emit RerollPricingSet(newBase, newStep);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
