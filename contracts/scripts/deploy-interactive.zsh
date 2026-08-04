#!/bin/zsh
set -euo pipefail
umask 077

read -rs "BASE_SEPOLIA_PRIVATE_KEY?請輸入 Base Sepolia 私鑰（畫面不會顯示）："
print
export BASE_SEPOLIA_PRIVATE_KEY
trap 'unset BASE_SEPOLIA_PRIVATE_KEY' EXIT INT TERM

cd "${0:A:h}/../.."
node tools/base-sepolia/deploy.mjs
