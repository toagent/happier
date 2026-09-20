#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PATCH_FILE="$REPO_ROOT/wetamp/patches/androidmath-v1.1.0-cn-build.patch"
GRADLE_INIT="$REPO_ROOT/wetamp/config/gradle-cn.init.gradle"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home}"
GRADLE_USER_HOME="${GRADLE_USER_HOME:-$HOME/.cache/wetamp/gradle}"
LOCAL_MAVEN_REPO="${WETAMP_LOCAL_MAVEN_REPO:-$GRADLE_USER_HOME/local-maven}"
CACHE_ROOT="${WETAMP_ANDROIDMATH_CACHE:-$HOME/.cache/wetamp/androidmath}"

ANDROIDMATH_VERSION="v1.1.0"
ANDROIDMATH_COMMIT="170d8e373f3a345727ef1ada2ec34907de1fa1c8"
ANDROIDMATH_MIRROR="https://gitclone.com/github.com/gregcockroft/AndroidMath.git"
ARTIFACT_DIR="$LOCAL_MAVEN_REPO/com/github/gregcockroft/AndroidMath/$ANDROIDMATH_VERSION"
AAR_PATH="$ARTIFACT_DIR/AndroidMath-$ANDROIDMATH_VERSION.aar"
POM_PATH="$ARTIFACT_DIR/AndroidMath-$ANDROIDMATH_VERSION.pom"
SHA_PATH="$AAR_PATH.sha256"
PROVENANCE_PATH="$ARTIFACT_DIR/AndroidMath-$ANDROIDMATH_VERSION.provenance"

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset npm_config_proxy npm_config_https_proxy yarn_proxy yarn_https_proxy

require_file() {
    if [[ ! -f "$1" ]]; then
        echo "Missing required file: $1" >&2
        exit 1
    fi
}

require_file "$PATCH_FILE"
require_file "$GRADLE_INIT"
require_file "$JAVA_HOME/bin/java"

if [[ -f "$AAR_PATH" && -f "$POM_PATH" && -f "$SHA_PATH" && -f "$PROVENANCE_PATH" ]] \
    && rg -q "^source_commit=$ANDROIDMATH_COMMIT$" "$PROVENANCE_PATH"; then
    expected_sha="$(awk '{ print $1 }' "$SHA_PATH")"
    actual_sha="$(shasum -a 256 "$AAR_PATH" | awk '{ print $1 }')"
    if [[ -n "$expected_sha" && "$expected_sha" == "$actual_sha" ]]; then
        echo "AndroidMath $ANDROIDMATH_VERSION already prepared: $AAR_PATH"
        exit 0
    fi
fi

mkdir -p "$CACHE_ROOT" "$ARTIFACT_DIR"
WORK_DIR="$(mktemp -d "$CACHE_ROOT/build.XXXXXX")"
cleanup() {
    if [[ -n "${WORK_DIR:-}" && "$WORK_DIR" == "$CACHE_ROOT"/build.* ]]; then
        rm -rf -- "$WORK_DIR"
    fi
}
trap cleanup EXIT

SOURCE_DIR="$WORK_DIR/source"
GIT_TERMINAL_PROMPT=0 \
GIT_CONFIG_GLOBAL=/dev/null \
GIT_CONFIG_NOSYSTEM=1 \
git -c http.proxy= -c https.proxy= clone \
    --depth 1 \
    --branch "$ANDROIDMATH_VERSION" \
    "$ANDROIDMATH_MIRROR" \
    "$SOURCE_DIR"

actual_commit="$(git -C "$SOURCE_DIR" rev-parse HEAD)"
if [[ "$actual_commit" != "$ANDROIDMATH_COMMIT" ]]; then
    echo "AndroidMath mirror resolved $actual_commit; expected $ANDROIDMATH_COMMIT" >&2
    exit 1
fi

git -C "$SOURCE_DIR" apply --check "$PATCH_FILE"
git -C "$SOURCE_DIR" apply "$PATCH_FILE"

(
    cd "$SOURCE_DIR"
    env \
        JAVA_HOME="$JAVA_HOME" \
        ANDROID_HOME="$SDK_ROOT" \
        ANDROID_SDK_ROOT="$SDK_ROOT" \
        GRADLE_USER_HOME="$GRADLE_USER_HOME" \
        ./gradlew \
        --no-daemon \
        --stacktrace \
        --init-script "$GRADLE_INIT" \
        :mathdisplaylib:assembleRelease
)

BUILD_AAR="$SOURCE_DIR/mathdisplaylib/build/outputs/aar/mathdisplaylib-release.aar"
require_file "$BUILD_AAR"

abi_list="$(unzip -Z1 "$BUILD_AAR" | sed -n 's#^jni/\([^/]*\)/.*#\1#p' | sort -u)"
if [[ "$abi_list" != "arm64-v8a" ]]; then
    echo "AndroidMath AAR contains unexpected ABIs: ${abi_list:-none}" >&2
    exit 1
fi
if ! unzip -Z1 "$BUILD_AAR" | rg -q '^classes\.jar$'; then
    echo "AndroidMath AAR does not contain classes.jar" >&2
    exit 1
fi

POM_TMP="$WORK_DIR/AndroidMath-$ANDROIDMATH_VERSION.pom"
printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<project xmlns="http://maven.apache.org/POM/4.0.0" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 https://maven.apache.org/xsd/maven-4.0.0.xsd">' \
    '  <modelVersion>4.0.0</modelVersion>' \
    '  <groupId>com.github.gregcockroft</groupId>' \
    '  <artifactId>AndroidMath</artifactId>' \
    "  <version>$ANDROIDMATH_VERSION</version>" \
    '  <packaging>aar</packaging>' \
    '  <dependencies>' \
    '    <dependency>' \
    '      <groupId>org.jetbrains.kotlin</groupId>' \
    '      <artifactId>kotlin-stdlib-jdk7</artifactId>' \
    '      <version>1.9.21</version>' \
    '      <scope>runtime</scope>' \
    '    </dependency>' \
    '  </dependencies>' \
    '</project>' > "$POM_TMP"

PROVENANCE_TMP="$WORK_DIR/AndroidMath-$ANDROIDMATH_VERSION.provenance"
printf '%s\n' \
    "source_commit=$ANDROIDMATH_COMMIT" \
    "source_tag=$ANDROIDMATH_VERSION" \
    "source_mirror=$ANDROIDMATH_MIRROR" \
    "build_patch=wetamp/patches/$(basename "$PATCH_FILE")" \
    'network=direct domestic mirrors; proxy variables and global Git config disabled' > "$PROVENANCE_TMP"

install -m 0644 "$BUILD_AAR" "$AAR_PATH"
install -m 0644 "$POM_TMP" "$POM_PATH"
install -m 0644 "$SOURCE_DIR/LICENSE" "$ARTIFACT_DIR/AndroidMath-$ANDROIDMATH_VERSION.LICENSE"
install -m 0644 "$PROVENANCE_TMP" "$PROVENANCE_PATH"
aar_sha="$(shasum -a 256 "$AAR_PATH" | awk '{ print $1 }')"
printf '%s  %s\n' "$aar_sha" "$AAR_PATH" > "$SHA_PATH"

echo "AndroidMath $ANDROIDMATH_VERSION prepared from $ANDROIDMATH_COMMIT"
echo "AAR: $AAR_PATH"
echo "SHA-256: $aar_sha"
