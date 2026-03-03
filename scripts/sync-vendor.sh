#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/TeideDB/teide.git"
VENDOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/vendor/teide"
TMP_DIR="$(mktemp -d)"

cleanup() { rm -rf "$TMP_DIR"; }
trap cleanup EXIT

# Skip if vendor already populated (use `npm run clean` to force re-sync)
if [ -d "$VENDOR_DIR/src" ] && [ -d "$VENDOR_DIR/include" ]; then
    echo "vendor/teide/ already exists, skipping sync (run 'npm run clean' to re-sync)"
    exit 0
fi

echo "Cloning Teide C core from $REPO_URL ..."
git clone --depth=1 "$REPO_URL" "$TMP_DIR/teide"

mkdir -p "$VENDOR_DIR"
cp -R "$TMP_DIR/teide/include" "$VENDOR_DIR/include"
cp -R "$TMP_DIR/teide/src" "$VENDOR_DIR/src"

echo "Vendor sync complete: $VENDOR_DIR"
