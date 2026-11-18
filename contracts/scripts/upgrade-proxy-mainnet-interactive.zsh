#!/bin/zsh
set -euo pipefail
umask 077

if [[ -z "${BASE_MAINNET_PRIVATE_KEY:-}" ]]; then
  read -rs "BASE_MAINNET_PRIVATE_KEY?請輸入 Base 主網部署私鑰（畫面不會顯示）："
  print
  export BASE_MAINNET_PRIVATE_KEY
  trap 'unset BASE_MAINNET_PRIVATE_KEY' EXIT INT TERM
fi

export PROXY_ADDRESS="${PROXY_ADDRESS:-0x9375B610859B1a5fEeA3C7c7C45FC20712F506cB}"
export CURRENT_IMPLEMENTATION_CONTRACT_NAME="AssociationBadgesUpgradeableV3"
export EXPECTED_CURRENT_IMPLEMENTATION_VERSION="3"
export UPGRADE_CONTRACT_NAME="AssociationBadgesUpgradeableV4"
export EXPECTED_CONTRACT_NAME="底加（TĪ-TSIA）：有來過，就會記底加"
export EXPECTED_CONTRACT_SYMBOL="HERE"
export EXPECTED_IMPLEMENTATION_VERSION="4"
# 2026 donor credentials (monthly 14, quarterly 15, yearly 16): raise 200 -> 3000 in the same transaction.
export RAISE_MAX_SUPPLY_TOKEN_IDS="${RAISE_MAX_SUPPLY_TOKEN_IDS-14,15,16}"
export RAISE_MAX_SUPPLY_TO="${RAISE_MAX_SUPPLY_TO-3000}"
export CONFIRM_MAINNET_UPGRADE="base-mainnet"

npm run upgrade:proxy:base-mainnet
