#!/bin/sh
# Starts a local Solana validator with the escrow program loaded, on ports that avoid common clashes.
# Usage: escrow/scripts/local-validator.sh   (stop it with: pkill -f solana-test-validator)
set -e
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"
rm -rf /tmp/wrk-ledger
exec solana-test-validator --reset --ledger /tmp/wrk-ledger --gossip-port 8870 --dynamic-port-range 8871-8890 --rpc-port 8899 \
  --bpf-program 8swdg4fKWMoqhcNLW4CS9hLdararEUKbjA8yB5Z3n9Qd target/deploy/wrk_escrow.so
