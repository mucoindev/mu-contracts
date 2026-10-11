// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";

/// @notice The MU Pups collection (Joepegs "Mintpeg", Avalanche C-Chain
///         0x34A0a23aA79cDEe7014E4C9aFAf20BCCe22749c0).
/// @dev Mintpeg's `burn` reverts with `Mintpeg__InvalidTokenOwner()` unless
///      `msg.sender == ownerOf(tokenId)`. Approved operators can NOT burn, so a
///      contract that wants to burn a Pup must own it first.
interface IMuPups is IERC721 {
    function burn(uint256 tokenId) external;
}
