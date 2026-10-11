// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC165Checker} from "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";

/// @title MU OTC Counter
/// @notice Peer-to-peer escrow trading of ERC-20 tokens and ERC-721 NFTs.
///
///         A maker opens an order with `createOrder`: the asset they give is pulled into
///         escrow in the same transaction (after the listing fee is paid). Anyone (or only
///         the reserved taker) can then `fillOrder` in one transaction: the asset the maker
///         asked for goes straight from the filler to the maker and the escrowed asset goes
///         from this contract to the filler. The maker can `cancelOrder` at any time while the
///         order is open (also after it expired) to get the escrow back.
///
///         Trust model: the owner can only change the listing fee and pause new orders.
///         There is no function that moves escrowed assets anywhere except to the filler
///         (on fill) or back to the maker (on cancel). No upgradeability, no selfdestruct,
///         no rescue function. Fills and cancels keep working while paused.
///
///         Not supported: fee-on-transfer and rebasing ERC-20 tokens (rejected by a balance
///         check), native AVAX (use WAVAX), partial fills, ERC-1155.
///
///         The runtime bytecode does not depend on constructor arguments (no immutables), so
///         a deployment can be verified by keccak256 of its code.
contract MuOTC is Ownable2Step, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- types

    /// @notice Asset standard.
    enum Kind {
        ERC20,
        ERC721
    }

    /// @notice Order lifecycle. `None` means the id does not exist.
    enum Status {
        None,
        Open,
        Filled,
        Cancelled
    }

    /// @notice One side of a trade. `amountOrId` is the token amount (ERC-20, base units)
    ///         or the token id (ERC-721).
    struct Asset {
        Kind kind;
        address token;
        uint256 amountOrId;
    }

    /// @notice A stored order.
    struct Order {
        address maker;
        address taker; // 0 = open order (anyone may fill); set to the filler when filled
        Asset give; // what the maker escrowed
        Asset get; // what the maker wants in return
        uint64 createdAt;
        uint64 expiresAt; // 0 = never expires
        uint64 closedAt; // when filled or cancelled
        Status status;
    }

    // ---------------------------------------------------------------- constants

    /// @notice Upper bound for `feeAmount`: 100 whole tokens, assuming an 18-decimal fee
    ///         token (MUG). With a fee token of fewer decimals the cap is correspondingly
    ///         larger in whole tokens.
    uint256 public constant MAX_FEE = 100 ether;

    /// @dev ERC-165 interface id of IERC721.
    bytes4 private constant ERC721_INTERFACE_ID = 0x80ac58cd;

    // ---------------------------------------------------------------- storage

    /// @notice ERC-20 token the listing fee is paid in.
    address public feeToken;
    /// @notice Listing fee charged to the maker on `createOrder` (fee token base units).
    uint256 public feeAmount;
    /// @notice Where the listing fee goes. The fee is skipped when this is the zero address.
    address public feeRecipient;
    /// @notice When true, `createOrder` reverts. Fills and cancels always work.
    bool public paused;
    /// @notice Number of orders ever created. Order ids are 1..orderCount (0 never exists).
    uint256 public orderCount;

    mapping(uint256 id => Order) private _orders;

    // Set of open order ids with O(1) swap-and-pop removal.
    uint256[] private _openIds;
    mapping(uint256 id => uint256 indexPlusOne) private _openIndex;

    mapping(address maker => uint256[]) private _makerIds;
    mapping(address taker => uint256[]) private _takerIds;

    // ---------------------------------------------------------------- events

    /// @notice A new order was created and its `give` asset escrowed.
    event OrderCreated(
        uint256 indexed id,
        address indexed maker,
        address indexed taker,
        Asset give,
        Asset get,
        uint64 expiresAt
    );
    /// @notice An order was filled by `taker`.
    event OrderFilled(uint256 indexed id, address indexed maker, address indexed taker);
    /// @notice An order was cancelled by its maker and the escrow refunded.
    event OrderCancelled(uint256 indexed id, address indexed maker);
    /// @notice The listing fee settings changed.
    event FeeChanged(address token, uint256 amount, address recipient);
    /// @notice New orders were paused or unpaused.
    event Paused(bool paused);

    // ---------------------------------------------------------------- errors

    error OrdersPaused();
    error InvalidTaker();
    error InvalidExpiry();
    error NotAContract(address token);
    error ZeroAmount();
    error NotAnERC721(address token);
    error NotAnERC20(address token);
    error FeeOnTransferNotSupported(address token);
    error ERC721TransferFailed(address token, uint256 tokenId);
    error OrderNotOpen(uint256 id);
    error OrderExpired(uint256 id);
    error MakerCannotFill();
    error ReservedForAnotherWallet();
    error NotMaker();
    error FeeTooHigh(uint256 amount, uint256 max);
    error InvalidFeeRecipient();
    error UnsolicitedERC721();

    // ---------------------------------------------------------------- constructor

    /// @param feeToken_ ERC-20 the listing fee is paid in (MUG on mainnet).
    /// @param feeAmount_ Listing fee in base units (at most MAX_FEE). 0 disables the fee.
    /// @param feeRecipient_ Fee destination. The zero address disables the fee.
    constructor(address feeToken_, uint256 feeAmount_, address feeRecipient_) Ownable(msg.sender) {
        _setFee(feeToken_, feeAmount_, feeRecipient_);
    }

    // ---------------------------------------------------------------- trading

    /// @notice Create an order and escrow `give` in the same transaction.
    /// @dev Before calling, the maker must approve this contract for `give` (ERC-20
    ///      `approve` or ERC-721 `approve`/`setApprovalForAll`) and, when a fee is set, for
    ///      `feeAmount` of `feeToken`. If `give.token` is the fee token, approve
    ///      `feeAmount + give.amountOrId`. The fee is paid first, straight to
    ///      `feeRecipient`, and is not refunded on cancel.
    ///      Reverts when paused, when `taker` is the caller, when `expiresAt` is not in the
    ///      future, when a token is not a contract, when an ERC-20 amount is 0, when an
    ///      ERC-721 side's token does not report IERC721 via ERC-165, when an ERC-20 side's
    ///      token reports IERC721 (an NFT listed as an ERC-20 could never leave escrow), or
    ///      when the escrow did not arrive exactly (fee-on-transfer / rebasing tokens).
    /// @param taker Wallet allowed to fill, or the zero address for an open order.
    /// @param give Asset the maker escrows now.
    /// @param get Asset the maker receives when the order is filled.
    /// @param expiresAt Unix time from which the order can no longer be filled; 0 = never.
    /// @return id The new order id (1-based).
    function createOrder(address taker, Asset calldata give, Asset calldata get, uint64 expiresAt)
        external
        nonReentrant
        returns (uint256 id)
    {
        if (paused) revert OrdersPaused();
        if (taker == msg.sender || taker == address(this)) revert InvalidTaker();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidExpiry();
        _validateAsset(give);
        _validateAsset(get);

        // Effects.
        id = ++orderCount;
        Order storage o = _orders[id];
        o.maker = msg.sender;
        o.taker = taker;
        o.give = give;
        o.get = get;
        o.createdAt = uint64(block.timestamp);
        o.expiresAt = expiresAt;
        o.status = Status.Open;

        _openIds.push(id);
        _openIndex[id] = _openIds.length;
        _makerIds[msg.sender].push(id);
        if (taker != address(0)) _takerIds[taker].push(id);

        // Interactions: fee, then escrow (both from the maker).
        uint256 fee = feeAmount;
        address recipient = feeRecipient;
        if (fee != 0 && recipient != address(0)) {
            IERC20(feeToken).safeTransferFrom(msg.sender, recipient, fee);
        }
        _pullIntoEscrow(give);

        emit OrderCreated(id, msg.sender, taker, give, get, expiresAt);
    }

    /// @notice Fill an open order atomically: `get` goes from the caller straight to the
    ///         maker, and the escrowed `give` goes from this contract to the caller.
    /// @dev The caller must first approve this contract for the order's `get` asset.
    ///      Requires the order to be Open and not expired, the caller not to be the maker,
    ///      and (for a reserved order) the caller to be the reserved taker. For an open
    ///      order the caller is recorded as `taker`. An ERC-20 `get` must arrive at the
    ///      maker exactly (fee-on-transfer tokens revert).
    /// @param id Order id.
    function fillOrder(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert OrderNotOpen(id);
        if (_isExpired(o.expiresAt)) revert OrderExpired(id);
        address maker = o.maker;
        if (msg.sender == maker) revert MakerCannotFill();
        address taker = o.taker;
        if (taker != address(0) && taker != msg.sender) revert ReservedForAnotherWallet();

        // Effects.
        o.status = Status.Filled;
        o.closedAt = uint64(block.timestamp);
        if (taker == address(0)) {
            o.taker = msg.sender;
            _takerIds[msg.sender].push(id);
        }
        _removeOpen(id);
        Asset memory give = o.give;
        Asset memory get = o.get;

        // Interactions.
        _payDirect(get, msg.sender, maker);
        _releaseFromEscrow(give, msg.sender);

        emit OrderFilled(id, maker, msg.sender);
    }

    /// @notice Cancel an open order and refund the escrow to the maker.
    /// @dev Maker only. Works on expired orders (that is how an expired order's escrow is
    ///      reclaimed) and while paused. The listing fee is not refunded.
    /// @param id Order id.
    function cancelOrder(uint256 id) external nonReentrant {
        Order storage o = _orders[id];
        if (o.status != Status.Open) revert OrderNotOpen(id);
        if (msg.sender != o.maker) revert NotMaker();

        // Effects.
        o.status = Status.Cancelled;
        o.closedAt = uint64(block.timestamp);
        _removeOpen(id);
        Asset memory give = o.give;

        // Interactions.
        _releaseFromEscrow(give, msg.sender);

        emit OrderCancelled(id, msg.sender);
    }

    // ---------------------------------------------------------------- views

    /// @notice One order. A non-existent id returns an all-zero order with status None.
    /// @param id Order id.
    /// @return The order.
    function getOrder(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    /// @notice Several orders in one call, in the order of `ids`. Non-existent ids come back
    ///         as all-zero orders with status None.
    /// @param ids Order ids.
    /// @return orders The orders.
    function getOrders(uint256[] calldata ids) external view returns (Order[] memory orders) {
        orders = new Order[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            orders[i] = _orders[ids[i]];
        }
    }

    /// @notice Number of orders with status Open (expired-but-not-cancelled orders included).
    /// @return The count.
    function openOrderCount() external view returns (uint256) {
        return _openIds.length;
    }

    /// @notice Page through the open orders.
    /// @dev The open set is unordered: removing an order moves the last open id into its
    ///      slot, so pages can shift between calls. Expired orders stay Open (and listed)
    ///      until their maker cancels them; filter on `expiresAt` client-side. Never reverts:
    ///      an offset past the end or a zero limit returns empty arrays.
    /// @param offset Index of the first entry to return.
    /// @param limit Maximum number of entries.
    /// @return ids Order ids.
    /// @return orders Orders, aligned with `ids`.
    function getOpenOrders(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Order[] memory orders)
    {
        return _page(_openIds, offset, limit);
    }

    /// @notice Number of orders ever created by `maker`.
    /// @param maker Wallet.
    /// @return The count.
    function makerOrderCount(address maker) external view returns (uint256) {
        return _makerIds[maker].length;
    }

    /// @notice Page through every order `maker` created, oldest first (any status).
    /// @dev Never reverts: an offset past the end or a zero limit returns empty arrays.
    /// @param maker Wallet.
    /// @param offset Index of the first entry to return.
    /// @param limit Maximum number of entries.
    /// @return ids Order ids.
    /// @return orders Orders, aligned with `ids`.
    function getMakerOrders(address maker, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Order[] memory orders)
    {
        return _page(_makerIds[maker], offset, limit);
    }

    /// @notice Number of orders indexed for `taker`: orders reserved for it (at creation)
    ///         plus open orders it filled. Each order appears at most once.
    /// @param taker Wallet.
    /// @return The count.
    function takerOrderCount(address taker) external view returns (uint256) {
        return _takerIds[taker].length;
    }

    /// @notice Page through the orders indexed for `taker` (see `takerOrderCount`), in the
    ///         order they were indexed (any status).
    /// @dev Never reverts: an offset past the end or a zero limit returns empty arrays.
    /// @param taker Wallet.
    /// @param offset Index of the first entry to return.
    /// @param limit Maximum number of entries.
    /// @return ids Order ids.
    /// @return orders Orders, aligned with `ids`.
    function getTakerOrders(address taker, uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Order[] memory orders)
    {
        return _page(_takerIds[taker], offset, limit);
    }

    /// @notice Whether `who` may fill order `id` right now, judged on the order alone.
    /// @dev Does not check `who`'s balance or approval of the `get` asset (the UI handles
    ///      those as separate steps). Reasons: "not open" (also for unknown ids), "expired",
    ///      "maker cannot fill", "reserved for another wallet". `ok` comes with "".
    /// @param id Order id.
    /// @param who Prospective filler.
    /// @return ok True when the order can be filled by `who`.
    /// @return reason Human-readable reason when `ok` is false.
    function canFill(uint256 id, address who) external view returns (bool ok, string memory reason) {
        Order storage o = _orders[id];
        if (o.status != Status.Open) return (false, "not open");
        if (_isExpired(o.expiresAt)) return (false, "expired");
        if (who == o.maker) return (false, "maker cannot fill");
        if (o.taker != address(0) && o.taker != who) return (false, "reserved for another wallet");
        return (true, "");
    }

    // ---------------------------------------------------------------- owner

    /// @notice Change the listing fee. Affects orders created afterwards only.
    /// @dev Owner only. `amount` is capped at MAX_FEE. `amount == 0` or
    ///      `recipient == address(0)` disables the fee (then `token` is not checked).
    ///      Otherwise `token` must be a contract. `recipient` cannot be this contract
    ///      (fees sent here could never leave).
    /// @param token ERC-20 the fee is paid in.
    /// @param amount Fee in base units.
    /// @param recipient Fee destination.
    function setFee(address token, uint256 amount, address recipient) external onlyOwner {
        _setFee(token, amount, recipient);
    }

    /// @notice Pause or unpause new orders. Fills and cancels are never paused.
    /// @dev Owner only.
    /// @param paused_ True to block `createOrder`.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    // ---------------------------------------------------------------- ERC-721 receiver

    /// @notice ERC-721 receiver hook.
    /// @dev Accepts an NFT only while one of this contract's own functions is running (the
    ///      escrow pull in `createOrder`, for NFTs whose `transferFrom` calls this hook).
    ///      An NFT sent here directly with `safeTransferFrom` is rejected: it would belong to
    ///      no order and, with no rescue function, would be locked forever.
    /// @return The IERC721Receiver selector.
    function onERC721Received(address, address, uint256, bytes calldata) external view returns (bytes4) {
        if (!_reentrancyGuardEntered()) revert UnsolicitedERC721();
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------- internals

    function _setFee(address token, uint256 amount, address recipient) private {
        if (amount > MAX_FEE) revert FeeTooHigh(amount, MAX_FEE);
        if (recipient == address(this)) revert InvalidFeeRecipient();
        if (amount != 0 && recipient != address(0) && token.code.length == 0) revert NotAContract(token);
        feeToken = token;
        feeAmount = amount;
        feeRecipient = recipient;
        emit FeeChanged(token, amount, recipient);
    }

    function _isExpired(uint64 expiresAt) private view returns (bool) {
        return expiresAt != 0 && block.timestamp >= expiresAt;
    }

    function _validateAsset(Asset calldata a) private view {
        if (a.token.code.length == 0) revert NotAContract(a.token);
        bool isNft = ERC165Checker.supportsInterface(a.token, ERC721_INTERFACE_ID);
        if (a.kind == Kind.ERC20) {
            if (a.amountOrId == 0) revert ZeroAmount();
            if (isNft) revert NotAnERC20(a.token);
        } else if (!isNft) {
            revert NotAnERC721(a.token);
        }
    }

    /// @dev Maker -> this contract. ERC-20 must arrive exactly; ERC-721 must end up owned here.
    function _pullIntoEscrow(Asset calldata a) private {
        if (a.kind == Kind.ERC20) {
            IERC20 t = IERC20(a.token);
            uint256 before = t.balanceOf(address(this));
            t.safeTransferFrom(msg.sender, address(this), a.amountOrId);
            uint256 afterwards = t.balanceOf(address(this));
            if (afterwards < before || afterwards - before != a.amountOrId) {
                revert FeeOnTransferNotSupported(a.token);
            }
        } else {
            IERC721(a.token).transferFrom(msg.sender, address(this), a.amountOrId);
            if (IERC721(a.token).ownerOf(a.amountOrId) != address(this)) {
                revert ERC721TransferFailed(a.token, a.amountOrId);
            }
        }
    }

    /// @dev Filler -> maker, directly. ERC-20 must arrive exactly; ERC-721 must end up with `to`.
    function _payDirect(Asset memory a, address from, address to) private {
        if (a.kind == Kind.ERC20) {
            IERC20 t = IERC20(a.token);
            uint256 before = t.balanceOf(to);
            t.safeTransferFrom(from, to, a.amountOrId);
            uint256 afterwards = t.balanceOf(to);
            if (afterwards < before || afterwards - before != a.amountOrId) {
                revert FeeOnTransferNotSupported(a.token);
            }
        } else {
            IERC721(a.token).transferFrom(from, to, a.amountOrId);
            if (IERC721(a.token).ownerOf(a.amountOrId) != to) {
                revert ERC721TransferFailed(a.token, a.amountOrId);
            }
        }
    }

    /// @dev This contract -> `to`. Plain transferFrom for NFTs so a recipient contract
    ///      without an ERC-721 receiver hook can still fill or reclaim.
    function _releaseFromEscrow(Asset memory a, address to) private {
        if (a.kind == Kind.ERC20) {
            IERC20(a.token).safeTransfer(to, a.amountOrId);
        } else {
            IERC721(a.token).transferFrom(address(this), to, a.amountOrId);
        }
    }

    function _removeOpen(uint256 id) private {
        uint256 indexPlusOne = _openIndex[id];
        uint256 lastIndex = _openIds.length - 1;
        if (indexPlusOne - 1 != lastIndex) {
            uint256 lastId = _openIds[lastIndex];
            _openIds[indexPlusOne - 1] = lastId;
            _openIndex[lastId] = indexPlusOne;
        }
        _openIds.pop();
        delete _openIndex[id];
    }

    function _page(uint256[] storage list, uint256 offset, uint256 limit)
        private
        view
        returns (uint256[] memory ids, Order[] memory orders)
    {
        uint256 len = list.length;
        uint256 n;
        if (offset < len) {
            n = len - offset;
            if (limit < n) n = limit;
        }
        ids = new uint256[](n);
        orders = new Order[](n);
        for (uint256 i; i < n; ++i) {
            uint256 id = list[offset + i];
            ids[i] = id;
            orders[i] = _orders[id];
        }
    }
}
