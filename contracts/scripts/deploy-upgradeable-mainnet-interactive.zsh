#!/bin/zsh
set -euo pipefail
umask 077

read -rs "BASE_MAINNET_PRIVATE_KEY?請輸入 Base 主網部署私鑰（畫面不會顯示）："
print
export BASE_MAINNET_PRIVATE_KEY
export CONFIRM_MAINNET_DEPLOY=base-mainnet
trap 'unset BASE_MAINNET_PRIVATE_KEY CONFIRM_MAINNET_DEPLOY' EXIT INT TERM

CLAIM_SIGNER_ADDRESS="${CLAIM_SIGNER_ADDRESS:?CLAIM_SIGNER_ADDRESS is required}" \
CONTRACT_METADATA_URI="${CONTRACT_METADATA_URI:?CONTRACT_METADATA_URI is required}" \
npm run deploy:proxy:base-mainnet
