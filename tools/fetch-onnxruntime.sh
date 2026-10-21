#!/usr/bin/env bash
# Downloads Microsoft's official ONNX Runtime (used for the offline models) into
# src-tauri/onnxruntime/, where the app bundle picks it up. Run once before building.
# Works on Linux and on Windows (Git Bash).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=1.31.0
DEST=src-tauri/onnxruntime
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    NAME="onnxruntime-win-x64-$VERSION"; ARCHIVE="$NAME.zip"
    SHA256=3958d8a44984160692c1b4ffd0de3cb48f8c39f9d34bb31e433db06e30b82195
    LIB="lib/onnxruntime.dll"; OUT=onnxruntime.dll ;;
  *)
    NAME="onnxruntime-linux-x64-$VERSION"; ARCHIVE="$NAME.tgz"
    SHA256=cc5c72baf5ae5c8238a6841f0897227be2d02826b9cf98eaf02fdefaeeb03a57
    LIB="lib/libonnxruntime.so.$VERSION"; OUT=libonnxruntime.so ;;
esac

if [ -f "$DEST/$OUT" ]; then echo "ONNX Runtime already present."; exit 0; fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/$ARCHIVE" "https://github.com/microsoft/onnxruntime/releases/download/v$VERSION/$ARCHIVE"
echo "$SHA256  $tmp/$ARCHIVE" | sha256sum -c --quiet
case "$ARCHIVE" in
  *.zip) unzip -q "$tmp/$ARCHIVE" -d "$tmp" ;;
  *) tar -xzf "$tmp/$ARCHIVE" -C "$tmp" ;;
esac
mkdir -p "$DEST"
cp "$tmp/$NAME/$LIB" "$DEST/$OUT"
echo "ONNX Runtime $VERSION installed in $DEST."
