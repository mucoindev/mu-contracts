// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice Test/testnet stand-in for the MU Pups "Mintpeg" contract.
/// @dev Reproduces the behaviour MuDogy depends on:
///      - sequential token ids from 0 (Mintpeg uses a Counters.Counter),
///      - `burn` reverts with `Mintpeg__InvalidTokenOwner()` unless the caller
///        OWNS the token (approved operators can not burn),
///      - `safeTransferFrom` calls `onERC721Received(operator, from, id, data)`
///        on the receiver after ownership has moved.
///      Unlike the real Mintpeg, minting is open so Fuji testers can get Pups,
///      and `mintId` can mint any free id (tests use it to simulate the Pups
///      proxy re-minting a burned id, and Pups > #349).
contract MockMintpeg is ERC721 {
    error Mintpeg__InvalidTokenOwner();

    uint256 public nextId;

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mint(address to, uint256 count) external {
        for (uint256 i = 0; i < count; ++i) {
            _mint(to, nextId++);
        }
    }

    function mintId(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    /// @notice Same rule as Mintpeg.burn: only the token's owner.
    function burn(uint256 tokenId) external {
        if (ownerOf(tokenId) != msg.sender) revert Mintpeg__InvalidTokenOwner();
        _burn(tokenId);
    }
}
