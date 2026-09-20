#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

SHERPA_VERSION="v1.12.25"
ARCHIVE_NAME="sherpa-onnx-$SHERPA_VERSION-android.tar.bz2"
EXPECTED_SHA256="63bb7e3b1ba24d9ea9b7f29471c526f0b657d1c529d51f5f3c74c9ccc0686fbd"
MIRROR_BASE="${WETAMP_SHERPA_MIRROR_BASE:-https://gh-proxy.com/https://github.com/k2-fsa/sherpa-onnx/releases/download}"
TARGET_DIR="$REPO_ROOT/packages/sherpa-native/android/build/sherpa-onnx/$SHERPA_VERSION"
ARCHIVE_PATH="$TARGET_DIR/$ARCHIVE_NAME"
CHECKSUM_PATH="$TARGET_DIR/checksum.txt"
DOWNLOAD_PATH=""

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset npm_config_proxy npm_config_https_proxy yarn_proxy yarn_https_proxy

archive_sha256() {
    shasum -a 256 "$1" | awk '{ print $1 }'
}

archive_is_valid() {
    local archive_path="$1"
    local entries

    [[ -f "$archive_path" ]] || return 1
    [[ "$(archive_sha256 "$archive_path")" == "$EXPECTED_SHA256" ]] || return 1
    entries="$(tar -tjf "$archive_path")" || return 1
    rg -q '^\./jniLibs/arm64-v8a/libonnxruntime\.so$' <<<"$entries" || return 1
    rg -q '^\./jniLibs/arm64-v8a/libsherpa-onnx-c-api\.so$' <<<"$entries"
}

write_checksum() {
    local checksum_tmp
    checksum_tmp="$(mktemp "$TARGET_DIR/checksum.txt.download.XXXXXX")"
    printf '%s\t%s\n' "$ARCHIVE_NAME" "$EXPECTED_SHA256" > "$checksum_tmp"
    mv -f -- "$checksum_tmp" "$CHECKSUM_PATH"
}

cleanup() {
    case "${DOWNLOAD_PATH:-}" in
        "$TARGET_DIR/$ARCHIVE_NAME.download."*) rm -f -- "$DOWNLOAD_PATH" ;;
    esac
}
trap cleanup EXIT

mkdir -p "$TARGET_DIR"

if archive_is_valid "$ARCHIVE_PATH"; then
    write_checksum
    echo "sherpa-onnx $SHERPA_VERSION already prepared: $ARCHIVE_PATH"
    exit 0
fi

DOWNLOAD_PATH="$(mktemp "$TARGET_DIR/$ARCHIVE_NAME.download.XXXXXX")"
DOWNLOAD_URL="${MIRROR_BASE%/}/$SHERPA_VERSION/$ARCHIVE_NAME"

echo "Downloading sherpa-onnx $SHERPA_VERSION from the direct mirror"
curl --noproxy '*' \
    --fail \
    --location \
    --show-error \
    --progress-bar \
    --connect-timeout 20 \
    --output "$DOWNLOAD_PATH" \
    "$DOWNLOAD_URL"

actual_sha256="$(archive_sha256 "$DOWNLOAD_PATH")"
if [[ "$actual_sha256" != "$EXPECTED_SHA256" ]]; then
    echo "sherpa-onnx sha256 mismatch: expected=$EXPECTED_SHA256 actual=$actual_sha256" >&2
    exit 1
fi
if ! archive_is_valid "$DOWNLOAD_PATH"; then
    echo "sherpa-onnx archive is missing the required arm64-v8a libraries" >&2
    exit 1
fi

mv -f -- "$DOWNLOAD_PATH" "$ARCHIVE_PATH"
DOWNLOAD_PATH=""
write_checksum

echo "sherpa-onnx $SHERPA_VERSION prepared: $ARCHIVE_PATH"
echo "SHA-256: $EXPECTED_SHA256"
