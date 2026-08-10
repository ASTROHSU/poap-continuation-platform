#!/bin/zsh
set -euo pipefail

export PROXY_ADDRESS="${PROXY_ADDRESS:-0x9375B610859B1a5fEeA3C7c7C45FC20712F506cB}"
export UPGRADE_CONTRACT_NAME="AssociationBadgesUpgradeableV2"
export CONFIRM_MAINNET_UPGRADE="base-mainnet"

npm run upgrade:proxy:base-mainnet
