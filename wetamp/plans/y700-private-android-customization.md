# Y700 私有 Android App 定制路线

- 状态：APPROVED_EXECUTION；合约修订：3；日期：2026-09-22。
- 存放位置：依用户最新指定，方案与 WeTAMP 定制资料统一放在仓库 `wetamp/`，覆盖此前 `.project/plans/` 的默认位置建议。
- 用户要求：基于已复刻的 Happier 私有库定制；Y700 以触屏和手机热点为主；远程操控本机统一调度 `twin-control`、`twin-dev`、`mac-mini` 上的 Claude Code / Codex / OpenCode；任务代码变更在 App 原生查看，并由本机 code-server 打开同一审查副本；定制必须支持持续合并、验证和交付上游升级。
- 本次授权：用户于 2026-09-22 明确要求以无人值守方式继续实现、测试、部署和验证，直至达到生产应用场景；授权执行 P0-P4 中服务这些结果的本地实现、三机 runner/daemon 配置、构建、Y700 安装和真实链路验证。用户随后要求所有改动回归本机 Git，并保持在修改分支的最新代码上，因此允许按验证通过的批次在当前 `dev` 分支提交；仍未授权 `git push`、公开发布源码、匿名公网暴露、清除 Y700 现有数据或绕过既有认证/E2EE。
- 实现批准记录：合约修订 3 由用户当前指令批准执行。本机是唯一控制面和源码事实源；修订 2 的双机目标由三机统一调度取代，其余仍适用的触屏、热点、签名、上游升级和真实验收要求继续保留。
- 修订 3 的硬边界：三机共享一个 FIFO 且总并发最多 3；远端 worker 不直接写本机主 checkout；不使用 Unison、SSHFS 或持续双向同步主工作区；任务级审查副本只从执行结果单向物化；执行机器与审查机器分别显示；基线失配时允许查看，但自动应用必须失败并明确标记 stale/conflict。
- 前序关系：修订工作区 `_bmad-output/planning-artifacts/y700-remote-ai-2026-09-20/SOLUTION.md` 与 `ARCHITECTURE-SPINE.md` 的建议。保留现成 App、原生任务入口、三端、E2EE、统一远端队列；将 code-server 明确放回本机；撤回默认远端 review 快照发布器及预先拆分 `packages/twin-control` / `packages/twin-review` 的建议。旧文档作为历史调研保留，不作为当前实施依据。

## 1. 定制结论

继续使用现有 React Native / Expo App、CLI 和 server。Y700 只连接本机控制面；本机在一个调度 owner 中选择本机、开发机或 Mac mini worker，并把所有任务审查结果物化回本机。远端集成涉及现有 twin-agent 调度器、Happier 会话生命周期和 review workspace，不能只改 Android 界面。

完整目标包含三台机器的三种 Agent；分阶段交付不等于把远端 worker 降为只读查看，或用一次性后台 job 冒充可继续对话的会话。所有创建、resume、fork、继续对话、停止、权限处理和断线恢复均由 App 的真实 Happier session 生命周期呈现；code-server 仅承接同一任务审查副本的深入编辑。

## 2. 当前源码与环境证据

私有仓库 `https://github.com/toagent/happier`，本次 HEAD `56fd1ce5b`，分支 `dev` 跟踪 `origin/dev`。UI/server 标称 `0.2.12`，CLI `0.2.13`；这些 package 版本不等于已通过对应稳定发布验证。仅配置 origin；本次未 fetch、切换或创建分支。

| 能力 | 现有 owner / 证据 | 定制判断 |
| --- | --- | --- |
| App 身份覆盖 | `apps/ui/app.config.js`：`EXPO_APP_LOCAL_CONFIG_PATH`、`app.local.js`、`EXPO_APP_NAME`、`EXPO_ANDROID_PACKAGE`、scheme、link host、EAS 与 updates 配置 | 用配置覆盖，保留上游默认配置；无须全仓改名 |
| 原生基础 | `apps/ui/package.json`：Expo 54、React Native 0.81.5、expo-web-browser、react-native-webview、Android 与 typecheck 脚本 | 继续现有技术栈；首个交付包必须脱离 Metro/USB 运行 |
| 三种 AI | `apps/cli/src/backends/catalog.ts` 注册 claude/codex/opencode；`backends/<provider>/` 为执行实现 | 不再写模型聊天客户端；保留 provider 配置并分别实测 |
| 新会话与选机器 | `components/sessions/new/hooks/useCreateNewSession.ts` → `sync/ops/machines.ts` 的 `machineSpawnNewSession` → machine RPC | 复用机器/目录/Agent 选择；默认主力本机，记住项目选择 |
| 实际执行 | `apps/cli/src/api/machine/rpcHandlers.ts` 调用 `spawnSession`，`apps/cli/src/daemon/startDaemon.ts` 拥有启动和恢复生命周期 | 队列限制必须落实在执行路径，不能只禁用 App 按钮 |
| 平板布局 | `components/navigation/shell/SidebarNavigator.tsx`、`utils/platform/responsive.ts`、`viewportClass.ts`、`components/appShell/panes/` | 已有侧栏和面板；在原 owner 调整宽度/收起规则 |
| 待处理 | `components/inbox/useInboxContentModel.ts` 聚合 approval、需要关注的会话与 review，会带机器/工作区上下文 | 沿用 Inbox，不另建一套待处理状态 |
| 原生审查 | `components/sessions/files/views/SessionScmReviewDetailsView.tsx` 组合 ChangedFilesReview、评论草稿、SCM snapshot；`reviews/comments/useReviewComposerHandoff.ts` 返回输入区 | 扩展已有审查页并验证评论发送链路，不重新造 diff 编辑器 |
| 弱网与刷新 | `sync/engine/pending/pendingQueueV2.ts` 使用持久 outbox 与服务器确认；`scm/refresh/useScmAdaptivePolling.ts` 根据 AppState 暂停刷新 | 优先验证和调整现有机制，不增加另一套消息队列 |
| 外部链接 | `utils/url/openExternalUrl.ts` 原生分支调用 Linking.openURL | 现有函数不是 Android Custom Tabs；code-server 的应用内浏览入口需要明确接入 |

表中未以 `apps/` 开头的 UI 路径均相对 `apps/ui/sources/`。以上是源码能力与落点，不代表 Y700 实测通过。

首次调查时没有安装根/UI node_modules，没有生成 `apps/ui/android`，没有 `apps/ui/app.local.js`。本次迁移前发现用户已修改 `.gitignore` 来忽略 `.idea/`，保留原样。本文已从被忽略的 `.project/plans/` 迁入 Git 可跟踪的 `wetamp/plans/`，尚未暂存或提交。

本次开发机只读探测：M3 Max / 48 GB / 可用约 435 GiB；Node 26.8.2、Yarn 1.22.22、Bun 1.4.2、Temurin JDK 17 已安装。但常规 Android SDK 不存在、sdkmanager 不在 PATH、jenv shim 损坏，依赖源探测被失效代理 `127.0.0.1:7890` 阻断。adb 文件存在但版本命令未正常返回。不能现在宣称开发机可构建 APK；JDK17 也不代表当前 fork 的 Gradle 配置已兼容。

同日此前核验的设备记录：Y700 TB323FU，Android 16/API36、arm64-v8a、1904×3040，density override 482。粗算约 632×1009 dp，实际布局须读取应用窗口与 inset；不能按 3040 像素当作宽屏桌面。此前本机 code-server 为 `127.0.0.1:8842`，域名配置 `review.toagent.io` 指向它；本轮未再次测外网访问。本文不将这些历史配置当作新部署或热点连通证明。

## 3. 必须满足的使用结果

| ID | 用户可见结果 | 完成证据 |
| --- | --- | --- |
| R1 | 自有 Android APK，基于此私有 fork；任务全程原生操作 | Y700 脱离 USB/Metro，通过热点创建任务、回复、停止和处理权限 |
| R2 | 三机各三种 Agent 可调度，执行机器/项目/Agent 身份明确 | 九条目标路径实际执行、追问、权限处理与停止；不能将九个入口显示当通过 |
| R3 | 每个任务在本机有精确基线的 review workspace，App 原生 diff 与 code-server 查看同一目录 | 远端和本机任务各制造一组含二进制文件的改动；App、review workspace 与 code-server 内容一致；stale 基线仍可查看但拒绝自动应用 |
| R4 | 触屏、旋转、软键盘和长输出可用 | Y700 横竖屏、分屏、键盘打开、大字体和长 diff 的实际操作录像/记录 |
| R5 | 热点断线与锁屏不中断 Mac 工作，恢复不重复执行 | 发送后断网/切热点、锁屏、杀 App 后重开，历史及草稿恢复，启动次数不重复 |
| R6 | 本机、开发机、Mac mini 的 App 会话与 MCP 任务共用一个本机调度 FIFO，总并发最多 3 | 跨三机混合提交四个任务，前三个占槽、第四个按 FIFO 排队；create/resume/fork/后台恢复/取消/重连均不旁路 |
| R7 | 个人构建身份、升级与通知可控 | 包名/签名/配置核验，覆盖安装保留配对；自有推送真实到达；无上游 OTA 覆盖 |
| R8 | 私有定制可持续跟进 Happier 上游代码升级 | 按 [上游升级约定](../UPSTREAM.md) 记录精确来源与定制接入点，完成一次真实候选版本合并及受影响功能/数据升级验证；合并无冲突不等于兼容通过 |

本机仍为唯一控制面和源码事实源。生产任务从本机仓库记录 base commit、工作树快照身份和 binary-safe patch；worker 只处理隔离副本，返回结果后由本机创建任务级 review workspace。`remote_workspace` 仍可服务独立的远端项目，但不得作为 Y700 三机生产链的代码事实源，也不得直接映射到本机 code-server。不能依据三台机器同名路径或文件同步推断 Git 状态一致。现有 Git 提交、推送边界继续适用。

## 4. 产品与技术设计建议

### 4.1 App 的第一屏与 Y700 布局

第一屏回到最近项目/会话；高频入口保留会话、待处理、变更与机器，但先在现有导航/Inbox/会话工具栏组织，不预先重写成全新四 Tab 系统。

- 新任务默认本机，选择机器、项目目录、Claude/Codex/OpenCode；常用项目置顶，提供“实现、评审、测试”等输入模板，模板不隐藏权限和目标目录。
- 竖屏默认会话主区，侧栏可收起；横屏展示项目/会话列表与主区，审查替换主区或使用既有面板。约 8.8 英寸设备不默认强塞三栏。
- 输入法打开、Android 分屏或大字体导致宽度不足时自动采用窄布局；同一会话不因旋转重新创建。按实际可用宽度布局，不硬编码 Y700 型号。
- 沿用现有 Unistyles、Text/TextInput、pane 状态和国际化；主要触控区域至少 48 dp，批准与停止分开，长工具输出可折叠，代码块和 diff 支持横向查看/换行选择。
- 输入法语音转文字可先作为中文输入方式；不为首版增加新的付费语音模型链路。社交等低频项是否隐藏通过现有功能配置决定，不删 provider 或恢复核心。

### 4.2 本机 code-server 与原生审查

默认在现有 ChangedFilesReview 阅读文件和 diff，复用评论草稿/回到输入区的链路。新增“在本机 code-server 打开”动作，使用会话实际工作区目录；目录只允许来自已认证机器会话与已配置项目范围，构造 URL 时编码参数，密码不放 URL。

新增配置应归现有设置 schema 与机器/工作区上下文：保存本机 review base URL，不将 `review.toagent.io` 散落到组件。URL 构造放 `utils/url/` 小型工具；界面按钮留在 `components/sessions/files/`。具体设置字段与文件名由实施时沿现有 schema 确定。

Android 默认通过现有 `expo-web-browser` 依赖接入 Custom Tabs，进入 code-server 审查后返回原任务。任务创建与批准仍在原生 App。若要聊天与完整 IDE 固定同屏，可先使用 Android 分屏；首版不默认加入 WebView 的认证、下载与编辑器兼容维护负担。

三种审查来源必须明确：

1. 本机任务：code-server 打开真实工作区或该任务本机 worktree，无需复制到开发机。
2. `twin-dev` / `mac-mini` 的 `local_snapshot`：从任务记录的本机 base 与快照建立 review worktree，应用 worker 返回的同一个 binary-safe patch。获准后才允许把该 patch 应用到实际目标并运行最小验证；review worktree 与主 checkout 必须有不同身份和状态。
3. `remote_workspace`：仅用于不以本机仓库为事实源的独立远端项目，不进入本计划的 Y700 生产任务入口。若未来需要本机深入审查，必须另行显式导入基线与改动；不能把远端绝对路径交给本机 code-server，也不能调用本机 `apply_job_patch` 改无对应基线的项目。

远端任务的 review workspace 是完成 R3 所必需的任务投影，本机任务可直接使用既有任务 worktree。审查投影只单向物化，不自动反向同步；App 显示执行机器、审查机器、目录、基线、同步状态与数据时间。底层 HEAD 或快照变化时保留可读副本并标记 stale/conflict，不能假装旧 diff 仍代表当前主工作区，也不能自动应用。

### 4.3 远端执行：唯一需要跨仓打通的核心

已核对 `~/.lan-dev-machine/twin-agent/server.mjs`、`twin-agent-remote` 与 README：当前为单一 `TWIN_AGENT_SSH_HOST` 的 prompt/job 接口，具备 FIFO、超时、取消、进度、patch 与验收统计；没有 worker 参数，也没有暴露通用的持续会话输入/权限回复接口。当前批处理执行策略含 Codex ephemeral、Claude bare、OpenCode pure；不能把它直接暴露给 App 并据此承诺完整交互会话、hooks 与插件。

建议使用以下职责边界：

```mermaid
flowchart LR
    A[Y700 定制 App] --> S[本机自托管 Happier server]
    S --> L[本机 Happier daemon / 调度集成]
    L --> Q[唯一 twin-agent FIFO / 总共 3 槽位]
    Q --> W1[twin-control worker]
    Q --> W2[twin-dev worker]
    Q --> W3[mac-mini worker]
    W1 --> V[本机 task review workspace]
    W2 --> V
    W3 --> V
    V --> D[App 原生 SCM diff]
    V --> C[本机 code-server]
```

这是目标拓扑；多 worker adapter、Happier 交互 runner 与 review materializer 尚不存在。队列决定何时与在哪台机器运行，Happier 继续决定 session 消息、加密、权限交互和 provider 生命周期。App 仅呈现目标、执行机、审查机和状态，不另起 HTTP 调度服务或第二队列。

Happier 侧适配放在 CLI 既有 `src/integrations/` 下的 twin domain，通过现有 machine/session RPC 进入本机调度 owner；协议新增调度目标、执行机、审查机和 review 状态时遵循 `packages/protocol` 的能力协商，UI 经现有 ops 调用。twin-agent 扩展为配置驱动的三 worker adapter，并让同一个 FIFO 同时接收既有一次性任务和 Happier runner；本机 worker 走受控本地 adapter，远端 worker 走受控 SSH adapter，三者不各自维护队列。

运行中的交互会话计入现有三个槽位，等待用户回复时亦不可伪装为已退出；明确结束后释放，后续 resume 再排队。App 失联不等于取消。既有 job timeout 不应被未经讨论地套用为所有交互会话寿命；该阶段先确定用户等待、硬超时、退出、恢复的具体行为再实现。

启动限制必须覆盖新建、resume、fork、后台恢复、handoff 以及已有 daemon 的直接 spawn；兼容失败返回可解释的不可用状态，不能回退直启。不能仅在新建页面打补丁。所有批处理/MCP 与 App 交互会话共享同一个队列 owner。

旧 CLI 不认识新能力时，三机调度入口保持不可用，本机既有直接会话继续工作。新 UI 仅在本机 CLI/daemon 明确宣告能力后发送调度字段；不得静默替换成一次性 job。已有原生 pending outbox、spawn nonce 和 session 恢复 owner 继续负责同一会话发送/启动去重，避免再造客户端 ID、消息队列或恢复日志。

### 4.4 网络、后台和升级

首选 Tailscale 内 HTTPS 访问本机 Happier server 与 code-server，保留应用认证/E2EE。本机网络或服务不可达时展示连接问题并保留已加载内容；不自动把控制面切到开发机。Mac 长任务独立于 Y700 前后台；本机睡眠、断电或重启前未解锁会影响可用性，需要真实验证。

手机热点在 Y700 上表现为 Wi-Fi，不能仅靠 Wi-Fi 类型启用大附件/后台预取。提供显式省流偏好，默认按需加载 diff/附件，沿用现有 AppState 和缓存刷新 owner。先记录一次固定任务的流量、恢复时间和滚动表现，再依据实测优化，不承诺未经测量的流量或延迟数字。

私有构建配置建议放可追踪的 `wetamp/config/app.cjs`，通过现有 `EXPO_APP_LOCAL_CONFIG_PATH` 加载。构建入口从当前 checkout 计算绝对路径，兼顾本地、隔离工作区和 CI，不硬编码个人目录；Expo 资源路径、EAS 上传范围和配置解析在 P0 验证。配置文件与构建入口尚未创建。包名可用 `io.toagent.remote`，名称暂用 `ToAgent Remote`，两者均为待发布前确定的建议值。独立 scheme/link host、签名、Expo/FCM 身份、server URL；不借用上游 OTA、Firebase 和 EAS 身份。首轮可关闭 OTA，用同签名的 release APK 升级；启用自有 OTA 留到 APK 基线可靠之后。

通知复用现有 expo-notifications 与服务端通知链路，使用自有项目凭据，默认仅提示有待处理事项。Google 服务包存在不等于热点可送达；锁屏、后台、杀 App 与系统强行停止分别记录结果。推送不足时 App 恢复仍须补齐待处理，不以永久前台保活掩盖缺口。

### 4.5 上游升级与定制隔离

以 [wetamp/README.md](../README.md) 为定制入口，[wetamp/UPSTREAM.md](../UPSTREAM.md) 为升级流程与兼容验收的唯一维护约定。`wetamp/` 集中保存专属方案、配置、品牌资源和维护脚本；上游 App、CLI、server、provider、协议及状态 owner 继续沿用原目录，不复制到 `wetamp/`。

优先使用上游已存在的配置入口和 canonical owner。新增 UI/CLI 逻辑仍归对应包，必要接线有测试和升级记录；不从根 `wetamp/` 跨包导入业务实现，也不为隔离形式另造一套状态或 provider。通用修复保持通用、便于以后回馈上游；私有产品默认值通过 WeTAMP 配置限定，不将上游消费者强制改为私人工作流。

升级可维护性同时覆盖源码合并、UI/CLI/server 混合版本、已有数据、APK 签名/包名和回退。不得以目录分离承诺永远无冲突，也不得把尚未执行的升级验证写成兼容成功。上游替换 owner 时按最终行为适配接入点，不永久冻结旧实现。

## 5. 分阶段实施与验收

| 阶段 | 范围与 owner | 可验收产出及依赖 |
| --- | --- | --- |
| P0：原版基线 + 自有安装包 | `wetamp/config/`、`wetamp/scripts/`（计划新增），`apps/ui/app.config.js` 现有覆盖入口和 build scripts | 确认当前 fork/上游来源/锁文件/Node 兼容版本，建立定制接入点记录；修复所选构建机 SDK/JDK/代理；生成配置检查包名、server URL、updates、FCM；构建并安装可独立运行的签名 APK。UI/CLI/server/provider 版本记录完整。R1/R7/R8 基础 |
| P1：本机三端可用 | `sessions/new`、现有 server 配置与 CLI daemon/provider | 本机自托管 server 配对；三个 provider 分别完成真实任务、追问、权限拒绝/允许与停止；核对本机 AGENTS、MCP、hooks、skills 加载，不假定包装后自动一致。R1/R2 本机部分 |
| P2：Y700 审查与操作 | SidebarNavigator/panes、Inbox、SessionScmReviewDetailsView、settings、URL 工具 | 横竖屏/键盘、大字体；原生 diff/评论返回同一会话；Custom Tabs 打开本机实际目录，返回保留草稿与位置。R3 本机部分/R4 |
| P3：三机统一调度与同源审查 | Happier CLI twin domain、必要 protocol/ops、现有 twin-agent scheduler/runner、本机 review materializer | 把单 host FIFO 扩为三 worker 单队列；落通三种 provider 的 create/resume/fork/追问/批准/停止/恢复；MCP 与 App 混合任务总并发 3。远端完成后从精确基线物化本机 review workspace，App diff 与 code-server 同源。R2/R3/R6 |
| P4：热点日常验收与升级 | 现有 pending/sync、SCM 刷新、通知、APK 构建配置；`wetamp/UPSTREAM.md` 的升级流程 | 断网恢复不重复执行；锁屏期间 Mac 继续工作；自有推送/深链接；覆盖升级保留配对/密钥。按热点实测调整省流与预取；对真实上游候选完成一次合并、受影响混合版本和数据升级验证，留存结果。完成 R5/R7/R8，复跑受影响 R1–R4/R6 |

P0 首包可先验证身份与前台操作，推送未接通必须标明，不能将其算完整交付。P3 可以独立研究接缝，但不得在 P1 未证明 Happier 三端核心可用时大规模改写调度。P0/P1 为最先应执行的一批工作。

现有自动化资产按变更使用：

- 身份配置：`apps/ui/sources/__tests__/config/appConfig.easDefaults.test.ts`、`googleServices.variantPackages.test.ts`、`easJson.androidGradleCommands.test.ts`。
- 机器/发送：`useCreateNewSession.daemonUnavailable.test.tsx`、`sync/ops/machines.spawn.errorMapping.test.ts`、pending outbox replay/acknowledgement 测试；新增断线后重复提交不重复启动的跨边界场景。
- UI：`SidebarNavigator.collapsed.test.tsx`、`SessionScmReviewDetailsView.snapshotSWR.test.tsx`、`ChangedFilesReviewDiffBlock.nativeReadingAnchor.test.tsx`；调整对应 owner 后运行精确切片。
- CLI：`apps/cli/src/api/apiMachine.spawnSession.test.ts`、`apps/cli/src/daemon/startDaemon.tmuxSpawn.integration.test.ts` 及受影响生命周期测试。P3 添加队列混合调用/取消/恢复的真实边界测试。
- 类型检查：`yarn workspace @happier-dev/app typecheck`；触及 CLI 时 `yarn workspace @happier-dev/cli typecheck`，使用仓库脚本，不用裸 tsc。
- 真机：根 `yarn test:e2e:mobile:android:connected-machine` 与 `yarn test:e2e:mobile:android:validated` 为现有入口，按 harness 前置条件配置，不能声称可无配置运行。自动化不覆盖的热点/推送/code-server 输入法场景需人工触屏验收。

## 6. 决策、限制与完成标准

已明确的用户决定：私有 Happier fork、自定义 Android App、触屏/热点优先、三机三种 Agent、本机单一调度控制面、本机 code-server 与 App 同源审查、资料写入 `wetamp/`、兼容后续上游升级。上述任何一个不能由实现者自行删减。

修订 3 已批准的实现约束：本机自托管 Happier server、Custom Tabs 打开本机 review workspace、现有 ChangedFilesReview 作为原生审查 owner、一个 twin-agent FIFO、三 worker adapter、Happier runner 复用真实 session 生命周期。实现细节可沿现有 owner 调整；不得通过直接启动任一远端 AI、把 batch job 伪装成 session 或把远端路径交给本机 code-server 来规避集成。

发布前需固定：正式 App 名/包名、签名保管与备份、自有 Expo/FCM 项目、HTTPS 服务地址。包名/签名在已有用户数据后修改涉及重新安装或迁移，不能当普通文案调整；首次试验包与正式包应明确区分。Android 回退需同签名且更高 versionCode 的回退构建，并验证数据兼容，不能承诺直接降级覆盖。

P3 的实现裁量仅限于现有 scheduler/runner 内的精确模块边界、配置文件形状和内部类型名称。交互等待沿 Happier session 生命周期，不复用一次性 job hard timeout；运行会话占槽，明确停止/退出后释放，resume/fork 重新排队。review materializer 必须校验 base、patch 与目标路径，任何失配进入可读但不可自动应用的 stale/conflict 状态。

不默认加入：独立聊天服务、第二队列、新 Kotlin App、全仓品牌替换、Unison/SSHFS/三机主工作区双向同步、让远端直接写本机主 checkout、全量重写导航、独立 review 发布服务、未测量的“省流倍数”。保留现有许可证与第三方声明。

R1–R8 的外层行为均有实际证据才算完成。单测通过、界面按钮存在、模拟 provider、单次局域网成功、远端 exit_code=0 或 Git 合并无冲突都不能替代真实双机/三端/热点/升级验收。记录已测版本、设备、网络、操作与结果；任何未通过项明确保留，不标全量完成。

## 7. 执行跟踪（非设计合约）

- 源码与环境调查：已完成；开发机任务 `20260920052109-adf29b`，Codex，只读，93 秒，已回收并验收，无 patch。
- 规划：DRAFT 已形成；自查确认现有 UI/SCM/Inbox 可复用、原始 spawn 旁路风险、远端批处理不等于交互会话、code-server 目录一致性及构建环境缺口。
- 2026-09-20 用户追加要求已纳入修订 2：迁入 `wetamp/`，补 R8、定制归属、上游合并/混合版本/数据与回退验证。只修订文档，未执行上游升级。
- P0：IN_PROGRESS；P1-P4：PLANNED，按依赖逐步实施。
- 本次验证：源码/配置只读核对；文档空白与链接路径检查；未安装依赖、未运行产品单测/typecheck、未构建 APK、未部署或真机验证。
- 2026-09-22 后续现场证据：Y700 上已用同一 Android Debug 签名覆盖安装包含 `AgentInput` 容器宽度修复的 0.2.12 测试包，设备 `base.apk` 与测试包 SHA-256 一致（`841860328b831bffc192c06b69bd18278a27e62ccea15faf85f31b86260e4e93`）。在临时 2550x1904 横屏中，约 526dp 主面板的旧包输入操作栏折两行、高 519px；新包为可滑动单行、高 419px；原始竖屏和中文软键盘下输入与发送键可见。`agentInput` 98 文件/642 测试、UI typecheck 通过。正式签名 APK 构建成功，但因历史设备包为 Debug 签名，直接 `adb install -r` 报 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`；未卸载、未清除配对数据，R7 签名升级尚未验收。`/tmp/y700-composer-old-526dp.png` 与 `/tmp/y700-composer-new-526dp.png` 为同设备同设置对照。此条不改变 R1-R8 的完成标准。
- 2026-09-22 修订 3 启动证据：当前 Happier HEAD 为 `d190f9a5afee38a7492e0af4cee18a03e04dcc2c`，并已复核与 `origin/dev` ahead/behind 为 `0/0`；Y700 ADB 在线；Tailscale 四节点在线；本机 code-server `127.0.0.1:8842` 返回登录跳转。现有 twin-agent 健康检查显示三种 CLI 可用、FIFO 上限 3，但仍只有一个 `TWIN_AGENT_SSH_HOST`。`mac-mini` Tailscale 在线但 SSH 公钥未授权。旧 job 清理阻塞和大仓基线初始化超时均已完成 RED->GREEN；Happier 大仓 `local_snapshot` 已经 MCP 重载后的真实任务验证。运行目录此前不受 Git 管理，本轮开始将可维护源码与测试回收到 `wetamp/twin-agent/`，部署目录只作为运行投影。
