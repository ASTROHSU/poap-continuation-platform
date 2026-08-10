// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssociationBadgesUpgradeable} from "./AssociationBadgesUpgradeable.sol";

/// @title AssociationBadgesUpgradeableV2
/// @notice Collection identity update for the Association's UUPS ERC-1155 proxy.
/// @dev Adds no storage and preserves every V1 event, balance, claim nonce, and permission.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract AssociationBadgesUpgradeableV2 is AssociationBadgesUpgradeable {
    function symbol() external pure override returns (string memory) {
        return "TW";
    }

    function implementationVersion() external pure override returns (uint64) {
        return 2;
    }
}
