// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC1155} from "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import {ERC1155Supply} from "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @title AssociationBadges
/// @notice One ERC-1155 token ID per association event, claimed with a short-lived issuer signature.
contract AssociationBadges is ERC1155, ERC1155Supply, Ownable2Step, EIP712 {
    struct EventConfig {
        uint128 maxSupply;
        bool active;
        string metadataUri;
    }

    bytes32 public constant CLAIM_TYPEHASH =
        keccak256("Claim(address account,uint256 tokenId,uint256 deadline,bytes32 nonce)");

    mapping(uint256 tokenId => EventConfig config) private _events;
    mapping(uint256 tokenId => mapping(address account => bool claimed)) public hasClaimed;
    mapping(bytes32 nonce => bool used) public usedNonces;

    address public claimSigner;

    error AlreadyClaimed(uint256 tokenId, address account);
    error AuthorizationExpired(uint256 deadline);
    error EventAlreadyExists(uint256 tokenId);
    error EventDoesNotExist(uint256 tokenId);
    error EventInactive(uint256 tokenId);
    error InvalidAddress();
    error InvalidAuthorization();
    error InvalidMaxSupply();
    error NonceAlreadyUsed(bytes32 nonce);
    error SupplyExhausted(uint256 tokenId);

    event ClaimSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event EventConfigured(uint256 indexed tokenId, uint256 maxSupply, string metadataUri);
    event EventStatusChanged(uint256 indexed tokenId, bool active);

    constructor(address initialOwner, address initialClaimSigner)
        ERC1155("")
        Ownable(initialOwner)
        EIP712("AssociationBadges", "1")
    {
        if (initialOwner == address(0) || initialClaimSigner == address(0)) {
            revert InvalidAddress();
        }
        claimSigner = initialClaimSigner;
        emit ClaimSignerUpdated(address(0), initialClaimSigner);
    }

    function createEvent(uint256 tokenId, uint128 maxSupply, string calldata metadataUri)
        external
        onlyOwner
    {
        if (_events[tokenId].maxSupply != 0) revert EventAlreadyExists(tokenId);
        if (maxSupply == 0) revert InvalidMaxSupply();
        if (bytes(metadataUri).length == 0) revert InvalidAuthorization();

        _events[tokenId] = EventConfig({
            maxSupply: maxSupply,
            active: true,
            metadataUri: metadataUri
        });
        emit EventConfigured(tokenId, maxSupply, metadataUri);
        emit URI(metadataUri, tokenId);
    }

    function setEventActive(uint256 tokenId, bool active) external onlyOwner {
        if (_events[tokenId].maxSupply == 0) revert EventDoesNotExist(tokenId);
        _events[tokenId].active = active;
        emit EventStatusChanged(tokenId, active);
    }

    function setClaimSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previousSigner = claimSigner;
        claimSigner = newSigner;
        emit ClaimSignerUpdated(previousSigner, newSigner);
    }

    function claim(
        uint256 tokenId,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        _claim(msg.sender, tokenId, deadline, nonce, signature);
    }

    /// @notice Lets a relayer pay gas while the signed collector remains the token recipient.
    function claimFor(
        address account,
        uint256 tokenId,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) external {
        if (account == address(0)) revert InvalidAddress();
        _claim(account, tokenId, deadline, nonce, signature);
    }

    function _claim(
        address account,
        uint256 tokenId,
        uint256 deadline,
        bytes32 nonce,
        bytes calldata signature
    ) internal {
        EventConfig storage config = _events[tokenId];
        if (config.maxSupply == 0) revert EventDoesNotExist(tokenId);
        if (!config.active) revert EventInactive(tokenId);
        if (block.timestamp > deadline) revert AuthorizationExpired(deadline);
        if (hasClaimed[tokenId][account]) revert AlreadyClaimed(tokenId, account);
        if (usedNonces[nonce]) revert NonceAlreadyUsed(nonce);
        if (totalSupply(tokenId) >= config.maxSupply) revert SupplyExhausted(tokenId);

        bytes32 structHash = keccak256(
            abi.encode(CLAIM_TYPEHASH, account, tokenId, deadline, nonce)
        );
        if (ECDSA.recover(_hashTypedDataV4(structHash), signature) != claimSigner) {
            revert InvalidAuthorization();
        }

        usedNonces[nonce] = true;
        hasClaimed[tokenId][account] = true;
        _mint(account, tokenId, 1, "");
    }

    function eventConfig(uint256 tokenId)
        external
        view
        returns (uint128 maxSupply, bool active, string memory metadataUri)
    {
        EventConfig storage config = _events[tokenId];
        if (config.maxSupply == 0) revert EventDoesNotExist(tokenId);
        return (config.maxSupply, config.active, config.metadataUri);
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _events[tokenId].metadataUri;
    }

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply) {
        super._update(from, to, ids, values);
    }
}
