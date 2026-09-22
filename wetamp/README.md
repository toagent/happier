# WeTAMP 定制

本目录是 Happier 私有 fork 的 WeTAMP 定制入口，由用户明确指定。目标是让 Y700 通过本机控制面统一调度 `twin-control`、`twin-dev`、`mac-mini` 上的 Claude Code、Codex、OpenCode，并在 Happier 原生 diff 与本机 code-server 中审查同一份代码变更，同时持续跟进 Happier 上游升级。

`twin-agent/` 是统一调度器的 Git 源码事实源；`~/.lan-dev-machine/twin-agent/` 仅是本机 MCP 运行投影，不得在运行目录形成无法回收到 Git 的独立改动。

- [Y700 Android 定制路线](plans/y700-private-android-customization.md)：完整需求、源码落点、实施阶段与验收；修订 3 已获批准并开始执行。
- [上游升级约定](UPSTREAM.md)：定制边界、源码合并、组件兼容、数据升级与回退。

私有 APK 与三机 CLI 已有测试部署；完整的三机交互会话、同源审查和上游升级验收仍以每批真机证据为准。App 的设置 > 文件与源代码管理 > code-server 可配置审查机器、HTTPS 地址和授权根目录，即使 SCM 写操作关闭也可进入；原生 diff 工具栏仅为同 server、同机器且位于该目录内的会话提供打开入口。远端执行结果尚未物化为本机 review workspace，不能将远端目录直接填入本机 code-server。

## 目录边界

```text
wetamp/
  README.md
  UPSTREAM.md
  plans/
    y700-private-android-customization.md
  config/       # 非敏感 App 配置和 Gradle 国内镜像规则
  assets/       # 后续实施：自有图标、启动图等资源
  scripts/      # 调用上游现有脚本的构建与校验入口
  upstream/     # 后续实施：已验证基线、定制接入点与每次升级证据
```

`config/app.cjs` 通过上游 `EXPO_APP_LOCAL_CONFIG_PATH` 接入，删除上游 Firebase/EAS 身份并关闭 Expo OTA。`scripts/build-android-apk.sh` 固定 Node 22、JDK 17、Android SDK 36，以及腾讯云的 Gradle 分发和 Maven 镜像；执行时会清除所有代理环境变量。JitPack 独有的 `AndroidMath:v1.1.0` 和 `BlurView:version-2.0.6` 分别从 `gitclone.com`、GitCode 国内 Git 镜像按固定提交构建为本地 Maven AAR；Gradle 对这两个坐标只读取 `$GRADLE_USER_HOME/local-maven`。`sherpa-onnx:v1.12.25` 的 Android 原生包通过 `gh-proxy.com` 国内镜像直连下载，命中官方 SHA-256 后才原子写入 Gradle 构建缓存。签名文件与密码必须保存在仓库外。

```bash
wetamp/scripts/build-android-apk.sh --install
```

`--install` 会将 arm64 release APK 安装到当前连接的 Android 设备；不传该参数时只构建和校验 `wetamp/dist/` 下的 APK。`assets/` 与 `upstream/` 仍按实际需要创建，不建立空目录或占位实现。

上游 `apps/`、`packages/` 继续拥有 App、CLI、server、协议和 provider 实现。需要接线的定制在这些 owner 内做可审查改动，相关单测就近放置，`wetamp/upstream/` 记录原因、接入点与验证入口。不把上游实现复制到本目录，不靠批量覆盖文件安装定制，不生成第二套锁文件和独立依赖树。

所有资料按私有库版本控制管理；签名私钥、密码、服务端凭据和设备个人数据存放在仓库外。本目录不替代根及各包的工程规则；文档位置按本次用户要求使用 `wetamp/`。
