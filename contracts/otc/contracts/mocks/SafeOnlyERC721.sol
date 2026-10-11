// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721Utils} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Utils.sol";

/// @notice Non-standard ERC-721 whose plain `transferFrom` also runs the receiver check
///         (some collections do this). MuOTC must still be able to escrow it. Test only.
contract SafeOnlyERC721 is ERC721 {
    constructor() ERC721("Safe Only", "SAFE") {}

    function mint(address to, uint256 tokenId) external {
        _mint(to, tokenId);
    }

    function transferFrom(address from, address to, uint256 tokenId) public override {
        super.transferFrom(from, to, tokenId);
        ERC721Utils.checkOnERC721Received(_msgSender(), from, to, tokenId, "");
    }
}
