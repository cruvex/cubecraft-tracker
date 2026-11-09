#!/usr/bin/env bash
# Builds the Rust API, runs it on 4702 and compares it with a Bun API already running on 4701.
#   DATABASE__URL=postgres://... api/tools/run-compare.sh [path regex]
cd "$(dirname "$0")/.." || exit 1
cargo build 2>&1 | grep -E '^(warning: unused|error|warning: `)|Finished' | tail -12
[ "${PIPESTATUS[0]}" -eq 0 ] || exit 1
SERVER__PORT=4702 SERVER__ADDRESS=127.0.0.1 RUST_LOG=warn ./target/debug/cubecraft-api > compare-server.log 2>&1 &
for _ in $(seq 1 40); do curl -sf localhost:4702/api/healthz > /dev/null && break; sleep 0.25; done
bun tools/compare.ts http://localhost:4701 http://localhost:4702 "$1"
code=$?
MSYS2_ARG_CONV_EXCL='*' taskkill /F /IM cubecraft-api.exe > /dev/null 2>&1
exit $code
