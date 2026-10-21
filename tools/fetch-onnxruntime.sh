#!/usr/bin/env bash
# Downloads Microsoft's official ONNX Runtime (used for offline تشكيل) into
# src-tauri/onnxruntime/, where the app bundle picks it up. Run once before building.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.31.0
NAME="onnxruntime-linux-x64-$VERSION"
SHA256=cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57
DEST=src-tauri/onnxruntime

if [ -f "$DEST/libonnxruntime.so" ]; then echo "ONNX Runtime already present."; exit 0; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/ort.tgz" "https://github.com/microsoft/onnxruntime/releases/download/v$VERSION/$NAME.tgz"
echo "$SHA256  $tmp/ort.tgz" | sha256sum -c --quiet
tar -xzf "$tmp/ort.tgz" -C "$tmp"
mkdir -p "$DEST"
cp "$tmp/$NAME/lib/libonnxruntime.so.$VERSION" "$DEST/libonnxruntime.so"
echo "ONNX Runtime $VERSION installed in $DEST."
