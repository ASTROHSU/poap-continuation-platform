# AssociationBadges contracts

Phase 2 uses one self-owned ERC-1155 contract. Each event is a token ID. Collectors submit their
own Base Sepolia transaction using a short-lived EIP-712 authorization issued by the Worker.

## Local verification

```bash
npm ci
npm test
npm run build
```

## Base Sepolia deployment

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

## Create one event token

Upload and verify the event metadata before making the immutable onchain configuration:

```bash
CONTRACT_ADDRESS=0x... \
TOKEN_ID=1 \
MAX_SUPPLY=100 \
METADATA_URI=https://your-domain.example/media/live/events/first-test/metadata.json \
npm run event:create:base-sepolia
```

Token IDs must be unique within the contract. The metadata URI is stored for that token ID, while
the event owner can later disable or re-enable claims without changing past mints.

## Verify the deployment

Use the exact constructor addresses recorded by the deployment script:

```bash
npx hardhat verify \
  --network baseSepolia \
  0xCONTRACT \
  0xOWNER \
  0xCLAIM_SIGNER
```
