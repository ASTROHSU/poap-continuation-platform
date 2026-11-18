// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssociationBadgesUpgradeableV2} from "./AssociationBadgesUpgradeableV2.sol";

/// @title AssociationBadgesUpgradeableV3
/// @notice Updates the public collection name to the 底加 brand.
/// @dev Adds no storage and preserves every event, balance, claim nonce, and permission.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract AssociationBadgesUpgradeableV3 is AssociationBadgesUpgradeableV2 {
    function name() external pure virtual override returns (string memory) {
        return unicode"底加（TĪ-TSIA）：有來過，就會記底加";
    }

    function symbol() external pure virtual override returns (string memory) {
        return "HERE";
    }

    function implementationVersion() external pure virtual override returns (uint64) {
        return 3;
    }
}
