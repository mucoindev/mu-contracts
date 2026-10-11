// SPDX-License-Identifier: MIT
// LEGACY — reference copy, NOT for deployment.
//
// The SimpleOTC contract verified on Avalanche C-Chain at
// 0xC4bdf802a9b77e8e09a136d55d6A14B66e94aF10 (solc 0.8.26, optimizer off, OZ 4.9/5.x
// mix). Copied from docs/takeover/verified-src/ only so its ABI can be exported to
// src/otc/SimpleOTC.json for the app (reading old offers, reclaiming escrow). The
// contract body is unchanged; only the ReentrancyGuard import moved to its OZ 5 path
// (utils/ instead of security/), which does not change the ABI.
// MuOTC replaces it. Known problems: maker creates then deposits separately, taker
// needs deposit + finalize, fee-on-transfer tokens can drain other escrows, only
// creators are indexed, and pagination underflows when offset > length.
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract SimpleOTC is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum AssetType { TOKEN, NFT }

    struct Offer {
        address creator;
        address counterparty;
        AssetType givingType;
        address givingAsset;
        uint256 givingAmountOrId;
        AssetType receivingType;
        address receivingAsset;
        uint256 receivingAmountOrId;
        bool creatorDeposited;
        bool counterpartyDeposited;
        bool isActive;
    }

    uint256 public feeAmount;
    address public feeToken;
    address public feeRecipient;

    uint256 public nextOfferId;
    uint256 public activeOffers;
    mapping(uint256 => Offer) public offers;
    mapping(address => uint256[]) public offersByAddress;

    event OfferCreated(uint256 indexed offerId, address indexed creator, address indexed counterparty);
    event Deposited(uint256 indexed offerId, address indexed from);
    event Finalized(uint256 indexed offerId);
    event Cancelled(uint256 indexed offerId);

    constructor(address _feeToken, uint256 _feeAmount, address _feeRecipient) {
        feeToken = _feeToken;
        feeAmount = _feeAmount;
        feeRecipient = _feeRecipient;
    }

    function createOffer(
        address counterparty,
        AssetType givingType,
        address givingAsset,
        uint256 givingAmountOrId,
        AssetType receivingType,
        address receivingAsset,
        uint256 receivingAmountOrId
    ) external nonReentrant returns (uint256 offerId) {
        IERC20(feeToken).safeTransferFrom(msg.sender, feeRecipient, feeAmount);

        offerId = nextOfferId++;
        offers[offerId] = Offer({
            creator: msg.sender,
            counterparty: counterparty,
            givingType: givingType,
            givingAsset: givingAsset,
            givingAmountOrId: givingAmountOrId,
            receivingType: receivingType,
            receivingAsset: receivingAsset,
            receivingAmountOrId: receivingAmountOrId,
            creatorDeposited: false,
            counterpartyDeposited: false,
            isActive: true
        });

        offersByAddress[msg.sender].push(offerId);
        activeOffers++;
        emit OfferCreated(offerId, msg.sender, counterparty);
    }

    function deposit(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.isActive, "Inactive offer");

        if (msg.sender == offer.creator && !offer.creatorDeposited) {
            _transferIn(offer.givingType, offer.givingAsset, offer.givingAmountOrId);
            offer.creatorDeposited = true;
        } else if ((offer.counterparty == address(0) || msg.sender == offer.counterparty) && !offer.counterpartyDeposited) {
            if (offer.counterparty == address(0)) {
                offer.counterparty = msg.sender;
            } else {
                require(msg.sender == offer.counterparty, "Not authorized");
            }
            _transferIn(offer.receivingType, offer.receivingAsset, offer.receivingAmountOrId);
            offer.counterpartyDeposited = true;
        } else {
            revert("Already deposited or not authorized");
        }

        emit Deposited(offerId, msg.sender);
    }

    function finalize(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.creatorDeposited && offer.counterpartyDeposited, "Incomplete deposit");
        require(offer.isActive, "Offer inactive");

        _transferOut(offer.givingType, offer.givingAsset, offer.givingAmountOrId, offer.counterparty);
        _transferOut(offer.receivingType, offer.receivingAsset, offer.receivingAmountOrId, offer.creator);

        offer.isActive = false;
        activeOffers--;
        emit Finalized(offerId);
    }

    function cancel(uint256 offerId) external nonReentrant {
        Offer storage offer = offers[offerId];
        require(offer.isActive, "Already finalized or cancelled");
        require(msg.sender == offer.creator || msg.sender == offer.counterparty, "Not allowed");

        if (offer.creatorDeposited) {
            _transferOut(offer.givingType, offer.givingAsset, offer.givingAmountOrId, offer.creator);
        }
        if (offer.counterpartyDeposited) {
            _transferOut(offer.receivingType, offer.receivingAsset, offer.receivingAmountOrId, offer.counterparty);
        }

        offer.isActive = false;
        activeOffers--;
        emit Cancelled(offerId);
    }

    function getAllActiveOffersPaginated(uint256 offset, uint256 limit) external view returns (Offer[] memory) {
        uint256 count = 0;
        uint256 max = nextOfferId < offset + limit ? nextOfferId : offset + limit;
        Offer[] memory temp = new Offer[](limit);

        for (uint256 i = offset; i < max; i++) {
            if (offers[i].isActive) {
                temp[count] = offers[i];
                count++;
            }
        }

        Offer[] memory result = new Offer[](count);
        for (uint256 j = 0; j < count; j++) {
            result[j] = temp[j];
        }

        return result;
    }

    function getOffersByAddressPaginated(address user, uint256 offset, uint256 limit) external view returns (Offer[] memory) {
        uint256[] storage ids = offersByAddress[user];
        uint256 max = ids.length < offset + limit ? ids.length : offset + limit;
        uint256 resultCount = max - offset;

        Offer[] memory result = new Offer[](resultCount);
        for (uint256 i = 0; i < resultCount; i++) {
            result[i] = offers[ids[offset + i]];
        }
        return result;
    }

    function isFinalizable(uint256 offerId) external view returns (bool, bool, bool, bool) {
        Offer memory o = offers[offerId];
        return (
            o.creatorDeposited && o.counterpartyDeposited && o.isActive,
            o.creatorDeposited,
            o.counterpartyDeposited,
            o.isActive
        );
    }

    function _transferIn(AssetType assetType, address asset, uint256 amountOrId) internal {
        if (assetType == AssetType.TOKEN) {
            IERC20(asset).safeTransferFrom(msg.sender, address(this), amountOrId);
        } else {
            IERC721(asset).transferFrom(msg.sender, address(this), amountOrId);
        }
    }

    function _transferOut(AssetType assetType, address asset, uint256 amountOrId, address to) internal {
        if (assetType == AssetType.TOKEN) {
            IERC20(asset).safeTransfer(to, amountOrId);
        } else {
            IERC721(asset).transferFrom(address(this), to, amountOrId);
        }
    }
}
