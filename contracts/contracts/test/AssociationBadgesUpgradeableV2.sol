// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AssociationBadgesUpgradeable} from "../AssociationBadgesUpgradeable.sol";

/// @dev Upgrade target used only by the local proxy upgrade test.
/// @custom:oz-upgrades-unsafe-allow missing-initializer
contract AssociationBadgesUpgradeableV2 is AssociationBadgesUpgradeable {
    uint256 public v2Marker;

    function setV2Marker(uint256 marker) external onlyOwner {
        v2Marker = marker;
    }

    function implementationVersion() external pure override returns (uint64) {
        return 2;
    }
}
