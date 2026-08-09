// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Ownable2StepUpgradeable} from "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import {ERC1155Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/ERC1155Upgradeable.sol";
import {ERC1155PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155PausableUpgradeable.sol";
import {ERC1155SupplyUpgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC1155/extensions/ERC1155SupplyUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title AssociationBadgesUpgradeable
/// @notice Upgradeable ERC-1155 attendance badges with sponsored, issuer-authorized claims.
/// @dev One token ID represents one event. Deploy behind an ERC-1967 UUPS proxy.
contract AssociationBadgesUpgradeable is
    Initializable,
    ERC1155Upgradeable,
    ERC1155SupplyUpgradeable,
    ERC1155PausableUpgradeable,
    Ownable2StepUpgradeable,
    EIP712Upgradeable,
    UUPSUpgradeable
{
    /// @dev Optional ERC-1155 collection identity getters used by block explorers and wallets.
    ///      ERC-1155 does not require name/symbol; token-level metadata remains canonical.
    string private constant _COLLECTION_NAME = unicode"兆量富足教育協會數位紀念";
    string private constant _COLLECTION_SYMBOL = "STEVE";

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
    string private _contractMetadataUri;

    error AlreadyClaimed(uint256 tokenId, address account);
    error AuthorizationExpired(uint256 deadline);
    error EventAlreadyExists(uint256 tokenId);
    error EventDoesNotExist(uint256 tokenId);
    error EventInactive(uint256 tokenId);
    error InvalidAddress();
    error InvalidAuthorization();
    error InvalidMaxSupply();
    error InvalidMetadataURI();
    error NonceAlreadyUsed(bytes32 nonce);
    error OwnershipRenouncementDisabled();
    error SupplyExhausted(uint256 tokenId);

    event ClaimSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event ContractURIUpdated();
    event EventConfigured(uint256 indexed tokenId, uint256 maxSupply, string metadataUri);
    event EventMetadataUpdated(uint256 indexed tokenId, string previousUri, string newUri);
    event EventStatusChanged(uint256 indexed tokenId, bool active);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address initialClaimSigner,
        string calldata initialContractURI
    ) external initializer {
        if (initialOwner == address(0) || initialClaimSigner == address(0)) {
            revert InvalidAddress();
        }
        if (bytes(initialContractURI).length == 0) revert InvalidMetadataURI();

        __ERC1155_init("");
        __ERC1155Supply_init();
        __ERC1155Pausable_init();
        __Ownable_init(initialOwner);
        __Ownable2Step_init();
        __EIP712_init("AssociationBadges", "1");

        claimSigner = initialClaimSigner;
        _contractMetadataUri = initialContractURI;
        emit ClaimSignerUpdated(address(0), initialClaimSigner);
        emit ContractURIUpdated();
    }

    function createEvent(uint256 tokenId, uint128 maxSupply, string calldata metadataUri)
        external
        onlyOwner
    {
        if (_events[tokenId].maxSupply != 0) revert EventAlreadyExists(tokenId);
        if (maxSupply == 0) revert InvalidMaxSupply();
        if (bytes(metadataUri).length == 0) revert InvalidMetadataURI();

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

    function setEventMetadataURI(uint256 tokenId, string calldata newMetadataUri)
        external
        onlyOwner
    {
        EventConfig storage config = _events[tokenId];
        if (config.maxSupply == 0) revert EventDoesNotExist(tokenId);
        if (bytes(newMetadataUri).length == 0) revert InvalidMetadataURI();

        string memory previousUri = config.metadataUri;
        config.metadataUri = newMetadataUri;
        emit EventMetadataUpdated(tokenId, previousUri, newMetadataUri);
        emit URI(newMetadataUri, tokenId);
    }

    function setClaimSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidAddress();
        address previousSigner = claimSigner;
        claimSigner = newSigner;
        emit ClaimSignerUpdated(previousSigner, newSigner);
    }

    /// @notice Emergency stop for claims, mints, burns, and transfers.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
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

    /// @notice Human-readable collection name for explorer and wallet compatibility.
    function name() external pure returns (string memory) {
        return _COLLECTION_NAME;
    }

    /// @notice Short collection identifier for explorer and wallet compatibility.
    function symbol() external pure returns (string memory) {
        return _COLLECTION_SYMBOL;
    }

    /// @notice ERC-7572 collection-level metadata URI.
    function contractURI() external view returns (string memory) {
        return _contractMetadataUri;
    }

    function setContractURI(string calldata newContractURI) external onlyOwner {
        if (bytes(newContractURI).length == 0) revert InvalidMetadataURI();
        _contractMetadataUri = newContractURI;
        emit ContractURIUpdated();
    }

    function uri(uint256 tokenId) public view override returns (string memory) {
        return _events[tokenId].metadataUri;
    }

    /// @notice A simple implementation marker for deployment and upgrade verification.
    function implementationVersion() external pure virtual returns (uint64) {
        return 1;
    }

    /// @dev Avoids accidentally losing upgrade, pause, and signer-rotation authority.
    function renounceOwnership() public pure override {
        revert OwnershipRenouncementDisabled();
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    )
        internal
        override(ERC1155Upgradeable, ERC1155SupplyUpgradeable, ERC1155PausableUpgradeable)
    {
        super._update(from, to, ids, values);
    }

    // Reserved for future AssociationBadges storage additions.
    uint256[45] private __gap;
}
