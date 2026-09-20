import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

test("Android APK build prepares sherpa-onnx from a verified direct mirror download", () => {
  const buildScript = readFileSync(path.join(scriptsDir, "build-android-apk.sh"), "utf8");
  const prepareScript = readFileSync(path.join(scriptsDir, "prepare-sherpa-onnx-android.sh"), "utf8");

  assert.match(buildScript, /SHERPA_PREPARE=.*prepare-sherpa-onnx-android\.sh/);
  assert.match(buildScript, /bash "\$SHERPA_PREPARE"/);

  assert.match(prepareScript, /https:\/\/gh-proxy\.com\/https:\/\/github\.com\/k2-fsa\/sherpa-onnx\/releases\/download/);
  assert.match(prepareScript, /63bb7e3b1ba24d9ea9b7f29471c526f0b657d1c529d51f5f3c74c9ccc0686fbd/);
  assert.match(prepareScript, /unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY/);
  assert.match(prepareScript, /curl --noproxy '\*'/);
  assert.match(prepareScript, /mktemp .*\.download\./);
  assert.match(prepareScript, /mv -f -- "\$DOWNLOAD_PATH" "\$ARCHIVE_PATH"/);
});

test("Android APK build supplies BlurView from a pinned domestic Git mirror build", () => {
  const buildScript = readFileSync(path.join(scriptsDir, "build-android-apk.sh"), "utf8");
  const prepareScript = readFileSync(path.join(scriptsDir, "prepare-blurview.sh"), "utf8");
  const gradleInit = readFileSync(path.join(scriptsDir, "..", "config", "gradle-cn.init.gradle"), "utf8");

  assert.match(buildScript, /BLURVIEW_PREPARE=.*prepare-blurview\.sh/);
  assert.match(buildScript, /bash "\$BLURVIEW_PREPARE"/);

  assert.match(prepareScript, /https:\/\/gitcode\.com\/gh_mirrors\/bl\/BlurView\.git/);
  assert.match(prepareScript, /afc19dc45718b739d818af324a4cd0f85dafd653/);
  assert.match(prepareScript, /unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY/);
  assert.match(prepareScript, /GIT_CONFIG_GLOBAL=\/dev\/null/);
  assert.match(prepareScript, /:library:assembleRelease/);
  assert.match(gradleInit, /includeModule\('com\.github\.Dimezis', 'BlurView'\)/);
});

test("Android APK build pins Java tools to the validated JDK", () => {
  const buildScript = readFileSync(path.join(scriptsDir, "build-android-apk.sh"), "utf8");

  assert.match(
    buildScript,
    /export PATH="\$JAVA_HOME\/bin:\$NODE_BIN_DIR:\$SDK_ROOT\/platform-tools:/,
  );
});
