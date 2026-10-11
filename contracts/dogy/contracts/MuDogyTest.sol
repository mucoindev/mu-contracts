// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title MU Dogy Test
/// @notice Real on-chain TEST mints for the MU Dogy demo. The Pup burn and the MUG
///         payment are simulated off-chain; the server signs a voucher once a demo
///         birth is done, and the holder mints that Dogy here with the voucher.
///
/// Voucher: `signer` personal_signs (EIP-191) the 32-byte hash
///     keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, dogyId, dna))
/// so a voucher only works on this chain, on this contract, for this wallet, for
/// this Dogy id and this DNA. Each id mints once, so a voucher can not be replayed.
///
/// @dev No immutables on purpose: the deployed runtime code is byte-identical to
///      the compiled `deployedBytecode`, so a server can verify a deployment by
///      comparing keccak256(eth_getCode(address)).
contract MuDogyTest is ERC721, Ownable {
    /// @notice Address whose signature authorizes mints.
    address public signer;
    /// @notice DNA of each minted Dogy (the off-chain birth record's seed).
    mapping(uint256 dogyId => bytes32) public dna;
    /// @notice Number of Dogys minted.
    uint256 public totalMinted;

    string private _baseTokenURI;

    event Minted(uint256 indexed dogyId, address indexed owner, bytes32 dna);
    event SignerSet(address indexed signer);
    event BaseURISet(string baseURI);

    error ZeroSigner();
    error InvalidSigner(address recovered);
    error AlreadyMinted(uint256 dogyId);

    /// @param signer_ Voucher signer (the demo server's key).
    /// @param baseURI_ Metadata base, e.g. "https://new.mu.money/nft/mu-dogy-test/".
    constructor(address signer_, string memory baseURI_) ERC721("MU Dogy Test", "MUDOGYTEST") Ownable(msg.sender) {
        _setSigner(signer_);
        _baseTokenURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    /// @notice Mint Dogy `dogyId` to the caller with a voucher from `signer`.
    function mint(uint256 dogyId, bytes32 dna_, bytes calldata signature) external {
        if (_ownerOf(dogyId) != address(0)) revert AlreadyMinted(dogyId);

        bytes32 digest = keccak256(abi.encodePacked(block.chainid, address(this), msg.sender, dogyId, dna_));
        address recovered = ECDSA.recover(MessageHashUtils.toEthSignedMessageHash(digest), signature);
        if (recovered != signer) revert InvalidSigner(recovered);

        dna[dogyId] = dna_;
        unchecked {
            ++totalMinted;
        }
        _safeMint(msg.sender, dogyId);
        emit Minted(dogyId, msg.sender, dna_);
    }

    /// @notice The hash a voucher signs (before the EIP-191 prefix), for off-chain tooling.
    function voucherHash(address to, uint256 dogyId, bytes32 dna_) external view returns (bytes32) {
        return keccak256(abi.encodePacked(block.chainid, address(this), to, dogyId, dna_));
    }

    function setSigner(address newSigner) external onlyOwner {
        _setSigner(newSigner);
    }

    function setBaseURI(string calldata newBaseURI) external onlyOwner {
        _baseTokenURI = newBaseURI;
        emit BaseURISet(newBaseURI);
    }

    function _setSigner(address newSigner) private {
        if (newSigner == address(0)) revert ZeroSigner();
        signer = newSigner;
        emit SignerSet(newSigner);
    }

    function _baseURI() internal view override returns (string memory) {
        return _baseTokenURI;
    }
}
