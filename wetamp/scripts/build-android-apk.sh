#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
UI_DIR="$REPO_ROOT/apps/ui"
APP_CONFIG="$REPO_ROOT/wetamp/config/app.cjs"
GRADLE_INIT="$REPO_ROOT/wetamp/config/gradle-cn.init.gradle"
ANDROIDMATH_PREPARE="$REPO_ROOT/wetamp/scripts/prepare-androidmath.sh"
BLURVIEW_PREPARE="$REPO_ROOT/wetamp/scripts/prepare-blurview.sh"
SHERPA_PREPARE="$REPO_ROOT/wetamp/scripts/prepare-sherpa-onnx-android.sh"
ANDROID_DIR="$UI_DIR/android"
SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-$HOME/Library/Android/sdk}}"
NODE_BIN_DIR="${WETAMP_NODE_BIN_DIR:-/opt/homebrew/opt/node@22/bin}"
JAVA_HOME="${JAVA_HOME:-/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home}"
GRADLE_USER_HOME="${WETAMP_GRADLE_USER_HOME:-$HOME/.cache/wetamp/gradle}"
KEYSTORE_PATH="${WETAMP_ANDROID_KEYSTORE:-$HOME/.wetamp/credentials/toagent-remote/android-release.jks}"
KEY_ALIAS="${WETAMP_ANDROID_KEY_ALIAS:-toagent-remote}"
INSTALL_APK=0

if [[ "${1:-}" == "--install" ]]; then
    INSTALL_APK=1
elif [[ -n "${1:-}" ]]; then
    echo "Usage: $0 [--install]" >&2
    exit 2
fi

unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY
unset http_proxy https_proxy all_proxy no_proxy
unset npm_config_proxy npm_config_https_proxy yarn_proxy yarn_https_proxy

export PATH="$JAVA_HOME/bin:$NODE_BIN_DIR:$SDK_ROOT/platform-tools:$SDK_ROOT/build-tools/36.0.0:$PATH"
export JAVA_HOME ANDROID_HOME="$SDK_ROOT" ANDROID_SDK_ROOT="$SDK_ROOT" GRADLE_USER_HOME
export WETAMP_LOCAL_MAVEN_REPO="${WETAMP_LOCAL_MAVEN_REPO:-$GRADLE_USER_HOME/local-maven}"
export npm_config_registry="https://registry.npmmirror.com"
export YARN_REGISTRY="https://registry.npmmirror.com"
export EXPO_APP_LOCAL_CONFIG_PATH="$APP_CONFIG"
export HAPPIER_ANDROID_GRADLE_JVMARGS="${HAPPIER_ANDROID_GRADLE_JVMARGS:--Xmx8192m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8}"
export EXPO_NO_TELEMETRY=1 DO_NOT_TRACK=1 CI=1
export SENTRY_DISABLE_AUTO_UPLOAD=true SENTRY_ALLOW_FAILURE=true

require_file() {
    if [[ ! -f "$1" ]]; then
        echo "Missing required file: $1" >&2
        exit 1
    fi
}

require_dir() {
    if [[ ! -d "$1" ]]; then
        echo "Missing required directory: $1" >&2
        exit 1
    fi
}

require_file "$APP_CONFIG"
require_file "$GRADLE_INIT"
require_file "$ANDROIDMATH_PREPARE"
require_file "$BLURVIEW_PREPARE"
require_file "$SHERPA_PREPARE"
require_file "$JAVA_HOME/bin/java"
require_file "$SDK_ROOT/build-tools/36.0.0/apksigner"
require_file "$SDK_ROOT/build-tools/36.0.0/aapt"
require_dir "$SDK_ROOT/platforms/android-36"
require_dir "$SDK_ROOT/ndk/27.0.12077973"
require_dir "$SDK_ROOT/ndk/27.1.12297006"
require_dir "$SDK_ROOT/cmake/3.30.5"
require_file "$KEYSTORE_PATH"

if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" != "22" ]]; then
    echo "Node 22 is required; resolved $(node --version) from $(command -v node)" >&2
    exit 1
fi
if [[ "$("$JAVA_HOME/bin/java" -version 2>&1 | head -n 1)" != *'17.'* ]]; then
    echo "JDK 17 is required from JAVA_HOME=$JAVA_HOME" >&2
    exit 1
fi

KEYSTORE_PASSWORD="${WETAMP_ANDROID_KEYSTORE_PASSWORD:-}"
if [[ -z "$KEYSTORE_PASSWORD" && "$(uname -s)" == "Darwin" ]]; then
    KEYSTORE_PASSWORD="$(security find-generic-password -a toagent-remote -s io.toagent.remote.android.release -w)"
fi
if [[ -z "$KEYSTORE_PASSWORD" ]]; then
    echo "Set WETAMP_ANDROID_KEYSTORE_PASSWORD or add the io.toagent.remote.android.release Keychain item." >&2
    exit 1
fi

export WETAMP_ANDROID_KEYSTORE="$KEYSTORE_PATH"
export WETAMP_ANDROID_KEYSTORE_PASSWORD="$KEYSTORE_PASSWORD"
export WETAMP_ANDROID_KEY_ALIAS="$KEY_ALIAS"
export WETAMP_ANDROID_KEY_PASSWORD="${WETAMP_ANDROID_KEY_PASSWORD:-$KEYSTORE_PASSWORD}"

bash "$ANDROIDMATH_PREPARE"
bash "$BLURVIEW_PREPARE"
bash "$SHERPA_PREPARE"

cd "$REPO_ROOT"
yarn workspace @happier-dev/app vitest run \
    --config vitest.config.ts \
    sources/__tests__/config/appConfig.easDefaults.test.ts

yarn workspace @happier-dev/app expo prebuild --clean --platform android --no-install

WRAPPER_PROPERTIES="$ANDROID_DIR/gradle/wrapper/gradle-wrapper.properties"
require_file "$WRAPPER_PROPERTIES"
GRADLE_DISTRIBUTION_FILE="$(sed -n 's#^distributionUrl=.*/##p' "$WRAPPER_PROPERTIES")"
if [[ -z "$GRADLE_DISTRIBUTION_FILE" ]]; then
    echo "Unable to resolve Gradle distribution from $WRAPPER_PROPERTIES" >&2
    exit 1
fi
export GRADLE_DISTRIBUTION_FILE
perl -0pi -e 's#^distributionUrl=.*$#distributionUrl=https://mirrors.cloud.tencent.com/gradle/$ENV{GRADLE_DISTRIBUTION_FILE}#m' "$WRAPPER_PROPERTIES"

if rg -n 'services\.gradle\.org|google-services\.json|2a550bd7-e4d2-4f59-ab47-dcb778775cee' "$ANDROID_DIR"; then
    echo "Generated Android project still contains an upstream build identity." >&2
    exit 1
fi

cd "$ANDROID_DIR"
./gradlew \
    --no-daemon \
    --stacktrace \
    --init-script "$GRADLE_INIT" \
    -PreactNativeArchitectures=arm64-v8a \
    assembleRelease

SOURCE_APK="$ANDROID_DIR/app/build/outputs/apk/release/app-release.apk"
require_file "$SOURCE_APK"
APP_VERSION="$(node -p "require('$UI_DIR/package.json').version")"
OUTPUT_DIR="$REPO_ROOT/wetamp/dist"
OUTPUT_APK="$OUTPUT_DIR/toagent-remote-${APP_VERSION}-arm64-v8a.apk"
mkdir -p "$OUTPUT_DIR"
cp "$SOURCE_APK" "$OUTPUT_APK"

"$SDK_ROOT/build-tools/36.0.0/apksigner" verify --verbose --print-certs "$OUTPUT_APK"
"$SDK_ROOT/build-tools/36.0.0/aapt" dump badging "$OUTPUT_APK" | sed -n '1p;/native-code:/p'
shasum -a 256 "$OUTPUT_APK"

if [[ "$INSTALL_APK" == "1" ]]; then
    DEVICE_SERIAL="${WETAMP_ANDROID_SERIAL:-$(adb devices | awk '$2 == "device" { print $1 }' | head -n 1)}"
    if [[ -z "$DEVICE_SERIAL" ]]; then
        echo "No connected Android device is available for installation." >&2
        exit 1
    fi
    adb -s "$DEVICE_SERIAL" install -r "$OUTPUT_APK"
    adb -s "$DEVICE_SERIAL" shell monkey -p io.toagent.remote -c android.intent.category.LAUNCHER 1 >/dev/null
    adb -s "$DEVICE_SERIAL" shell dumpsys package io.toagent.remote | sed -n '/versionCode=/p;/versionName=/p' | head -n 4
fi

echo "APK: $OUTPUT_APK"
