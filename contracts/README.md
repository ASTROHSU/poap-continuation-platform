# AssociationBadges contracts

The platform uses a self-owned ERC-1155 contract. Each event is a token ID, each collector may claim
one unit, and a relayer can pay Base gas using a short-lived EIP-712 authorization issued by the
Worker.

Two implementations are retained:

- `AssociationBadges.sol` is the immutable first deployment used by the current Base event.
- `AssociationBadgesUpgradeable.sol` is the next UUPS proxy implementation. It keeps the same claim
  model and adds explorer-compatible collection name/symbol getters, ERC-7572 collection metadata,
  owner-controlled metadata updates, a global emergency pause, and owner-authorized upgrades.

An existing immutable contract cannot be converted into a proxy. Deploying the proxy creates a new
contract address; the application must aggregate both addresses so previously issued badges remain
visible.

## Local verification

```bash
npm ci
npm test
npm run build
```

The proxy test suite verifies initialization, sponsored claims, one-per-wallet enforcement,
pause/unpause behavior, metadata administration, owner-only upgrades, and state preservation.

## Immutable Base Sepolia deployment

Store the deployer key in Hardhat's encrypted keystore instead of an `.env` file:

```bash
npx hardhat keystore set BASE_SEPOLIA_PRIVATE_KEY
```

Fund that deployer with Base Sepolia ETH, then provide the claim signer's public address:

```bash
CLAIM_SIGNER_ADDRESS=0x... \
npm run deploy:base-sepolia
```

The contract owner defaults to the deployer, which should be the issuer's administrative wallet.
Set `CONTRACT_OWNER_ADDRESS` only when a different owner is intentional. `CLAIM_SIGNER_ADDRESS`
is the public address derived from the separate Worker signing secret. Neither private key is
committed.

## Upgradeable UUPS deployment

Deploy to Base Sepolia first. Collection-level metadata must already be available over HTTPS:

```bash
CLAIM_SIGNER_ADDRESS=0x... \
CONTRACT_METADATA_URI=https://your-domain.example/media/live/events/association-badges/metadata.json \
npm run deploy:proxy:base-sepolia
```

The deploy script records both the stable proxy address and the replaceable implementation address.
It also verifies and records the collection name, symbol, and contract-level metadata URI so an
incomplete explorer identity is caught before deployment.
For Base mainnet it refuses to send a transaction unless the explicit confirmation variable is set:

```bash
CONFIRM_MAINNET_DEPLOY=base-mainnet \
CLAIM_SIGNER_ADDRESS=0x... \
CONTRACT_METADATA_URI=https://your-domain.example/media/live/events/association-badges/metadata.json \
npm run deploy:proxy:base-mainnet
```

The proxy owner is intentionally the only administrator. It can create or disable events, rotate the
claim signer, update metadata, pause/unpause the contract, and authorize an implementation upgrade.
The relayer and claim signer do not receive ownership or upgrade authority.

Before every upgrade, add an implementation contract, run the complete tests, review storage-layout
compatibility, and test on Base Sepolia. A mainnet upgrade is separately gated:

```bash
PROXY_ADDRESS=0x... \
UPGRADE_CONTRACT_NAME=AssociationBadgesUpgradeable \
CONFIRM_MAINNET_UPGRADE=base-mainnet \
npm run upgrade:proxy:base-mainnet
```

`pause()` is the emergency stop. While paused it blocks claims, mints, burns, and transfers;
`unpause()` restores normal operation. Already minted ownership is not deleted.

## Create one event token

Upload and verify the event metadata before making the onchain configuration:

```bash
CONTRACT_ADDRESS=0x... \
TOKEN_ID=1 \
MAX_SUPPLY=100 \
METADATA_URI=https://your-domain.example/media/live/events/first-test/metadata.json \
npm run event:create:base-sepolia
```

Token IDs must be unique within the contract. The owner can later disable or re-enable claims without
changing past mints. On the proxy implementation, `setEventMetadataURI()` can repair or migrate a
token's metadata URL, and `setContractURI()` updates ERC-7572 collection-level metadata. These calls
change presentation only; they do not change owners, balances, or supply.

## Verify an immutable deployment

Use the exact constructor addresses recorded by the deployment script:

```bash
npx hardhat verify \
  --network baseSepolia \
  0xCONTRACT \
  0xOWNER \
  0xCLAIM_SIGNER
```
