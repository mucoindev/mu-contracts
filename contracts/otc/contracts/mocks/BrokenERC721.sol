// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @notice ERC-721 that reports IERC721 but whose `transferFrom` silently does nothing
///         once `broken` is set. MuOTC's ownerOf check must catch it. Test only.
contract BrokenERC721 is ERC721 {
    bool public broken;

    constructor() ERC721("Broken", "BRK") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        if (broken) return;
        super.transferFrom(from, to, tokenId);
    }
}
