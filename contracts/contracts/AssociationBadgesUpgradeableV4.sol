// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssociationBadgesUpgradeableV3} from "./AssociationBadgesUpgradeableV3.sol";

/// @title AssociationBadgesUpgradeableV4
/// @notice Lets the owner raise (never lower) the max supply of existing events.
/// @dev Adds no storage and preserves every event, balance, claim nonce, and permission.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract AssociationBadgesUpgradeableV4 is AssociationBadgesUpgradeableV3 {
    error MaxSupplyNotIncreased(uint256 tokenId, uint256 currentMaxSupply, uint256 newMaxSupply);

    event EventMaxSupplyIncreased(
        uint256 indexed tokenId,
        uint256 previousMaxSupply,
        uint256 newMaxSupply
    );

    /// @notice Raises every listed event to `newMaxSupply`. Reverts the whole batch if any
    ///         event does not exist or would not strictly increase.
    function increaseMaxSupply(uint256[] calldata tokenIds, uint128 newMaxSupply)
        external
        onlyOwner
    {
        for (uint256 i = 0; i < tokenIds.length; i++) {
            EventConfig storage config = _events[tokenIds[i]];
            uint128 previous = config.maxSupply;
            if (previous == 0) revert EventDoesNotExist(tokenIds[i]);
            if (newMaxSupply <= previous) {
                revert MaxSupplyNotIncreased(tokenIds[i], previous, newMaxSupply);
            }
            config.maxSupply = newMaxSupply;
            emit EventMaxSupplyIncreased(tokenIds[i], previous, newMaxSupply);
        }
    }

    function implementationVersion() external pure virtual override returns (uint64) {
        return 4;
    }
}
