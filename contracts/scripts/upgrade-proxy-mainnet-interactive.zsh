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
export UPGRADE_CONTRACT_NAME="AssociationBadgesUpgradeableV2"
export CONFIRM_MAINNET_UPGRADE="base-mainnet"

npm run upgrade:proxy:base-mainnet
