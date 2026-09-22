# twin-agent

本机 Codex、Claude Code、OpenCode 共用的 stdio MCP server。它通过 `ssh twin-dev`
把任务交给孪生 Mac 上的 Codex、Claude 或 OpenCode。

`delegate_agent` 支持两种工作区模式：

- `local_snapshot`：把白名单内的本机 Git 项目同步到远端 job 隔离目录，适合以本机
  源码为事实源、需要回收 patch 的任务。
- `remote_workspace`：直接在开发机 `/Users/yong/work/_mcp_workspace/<cwd>` 工作，目录
  不存在时自动创建，适合开发机独立调研、构建、测试或维护远端项目。
- `auto`（默认）：`cwd` 是白名单内现有本机目录时选择 `local_snapshot`；否则选择
  `remote_workspace`。因此本机不存在或位于白名单外的同名路径不会被读取或上传。

核心约束：

- 本机是控制面；`local_snapshot` 任务以本机项目为源码事实源。
- `remote_workspace` 任务以开发机指定工作区为事实源，不要求本机存在同名目录。
- 默认 `read_only`；`write` 修改隔离副本还是开发机持久目录由工作区模式决定。
- 只有 `local_snapshot` 生成可应用到本机的 `changes.patch`；远端持久工作区拒绝
  `fetch_job_patch` 和 `apply_job_patch`，避免把远端状态误应用到本机。
- 远端任务在独立 `tmux` session 中运行，客户端退出不影响任务。
- 每个运行中的 CLI 都持续写入原子 `progress.json`；状态包含当前 attempt、Agent、模型、
  最近输出时间、idle 时长和输出字节数，可区分“仍在推理”与“已经卡死”。
- hard timeout 是整个 job 的总预算；read-only fallback 与主尝试共享这份预算，不会因为重试
  把用户设置的总超时翻倍。
- 完成结果保留 7 天，后续委派时自动清理过期快照。
- 完整 job 目录仍保留 7 天；终态任务的结构化指标会追加到
  `~/.twin-agent/history/jobs.jsonl`，用于长期成功率和耗时趋势，不保留项目源码或完整 prompt。
- `fetch_job_patch` 下载完整 patch，`apply_job_patch` 默认只做应用前校验。
- 三个本机客户端共享远端 FIFO 队列，默认最多同时运行 3 个 AI 任务。
- 超出并发上限的任务自动等待，运行槽位释放后按创建顺序启动。
- 排队任务共用一个 `twin-scheduler`，不再为每个任务创建每秒轮询的独立 watcher。
- `local_snapshot` 在生成 `changes.patch` 后立即压缩掉可重建源码副本，只保留结果、日志、指标和 patch。
- 本机源码根目录使用 `TWIN_AGENT_ALLOWED_ROOTS` 显式白名单，多个绝对路径按
  系统 path delimiter 分隔；它只约束 `local_snapshot`，不限制远端工作区名称。
- 白名单检查基于 `realpath`，不会因目录软链接而扩大可读范围。
- 开发机持久目录由 `TWIN_AGENT_REMOTE_WORKSPACE_ROOT` 控制，默认是
  `/Users/yong/work/_mcp_workspace`；`cwd` 会规范化为其下的安全相对路径，并由开发机
  使用 `pwd -P` 再次校验软链接没有逃逸根目录。
- 隔离快照只传输本机 Git 认可的 tracked files 与非忽略 untracked files；被
  `.gitignore` 排除的 `.env`、运行数据、模型和构建产物不会因目录扫描被上传。

## 协同效率统计

一次本机主任务使用稳定的 `collaboration_id`。首次委派前调用
`collaboration_event(action=start)`，最终回复前调用 `collaboration_event(action=finish)`；每次
`delegate_agent` 必须同时提供：

- `caller`：本机调用端，值为 `codex`、`claude` 或 `opencode`。
- `task_title`：用户可读的主任务名称。
- `local_work`：远端运行期间本机负责的工作摘要。
- `collaboration_id`：同一主任务的多次远端委派复用同一个值。

`job_status` 和 `job_result` 会返回 `queue_wait_seconds`、`run_seconds`、
`total_seconds`、`outcome` 及关联的本机工作。新任务还记录 `task_type`、`complexity`、
`model`、`timeout_seconds`、`idle_timeout_seconds`、`attempt_count`、fallback、有效 Agent/模型、
TTFT、token、成本、API 重试、结果回收延迟、prompt/final/transcript 大小、`failure_class`
和 `cancel_reason`。统计口径：

- 进程成功率 = `exit_code=0 / (exit_code=0 + exit_code!=0)`，只表示 CLI 正常退出。
- 回收终态结果并核对证据后必须调用 `evaluate_job`，记录 `accepted`、`partial` 或
  `rejected`；进程失败或取消的任务不能标记为 `accepted`。只有进程成功任务的验收覆盖率
  达到 100% 时才计算有效成功率和有效交付率。
- 报表分别展示进程成功结果的 `quality_coverage_pct` 和全部终态任务的
  `terminal_quality_coverage_pct`，失败任务的 `partial/rejected` 核对不会混入成功交付计数。
- 有效成功率 = `accepted / (accepted + partial + rejected + process_failed)`；有效交付率再把
  `cancelled` 纳入分母。未评审结果绝不自动算作有效成功。
- 精确排队耗时从 `enqueued_at` 到 `started_at`；2026-09-15 之前的旧任务没有保留
  `enqueued_at`，只能看到包含快照准备和调度的 `prestart_seconds`。
- 本机耗时来自 `collaboration_event` 的 `start` 到 `finish`，是协同任务墙钟耗时，
  不是 CPU 时间，也不会把所有 shell 命令误报为业务产出。
- tmux 状态不可读时，只有 `started_at` 的任务标记为 `unknown`，不再误报为失败。
- `job_result`、`wait_job` 和 `collect_ready_results` 会登记 `result_collected_at`；
  `collaboration_event(action=finish)` 会拒绝仍在排队、运行、状态未知或终态未回收的协同任务。

## 执行策略

`delegate_agent` 默认 `agent=auto`：

- 短任务、实现、测试、代码评审、运维、普通任务，以及标准复杂度研究/架构任务走 Codex。
- 只有长篇架构和研究任务自动走 Claude Sonnet。
- 自动路由到 Claude 的 read-only 任务最多先运行 240/480/600 秒（按复杂度），失败、空输出或
  超时后在剩余总预算内回退 Codex；显式 Agent 与 write 任务默认不自动换 Agent。
- Claude 使用 `--bare + stream-json`，Codex 使用 `--ephemeral`，OpenCode 使用 `--pure`，
  降低插件、会话持久化和非必要上下文开销。
- OpenCode 用于调用方明确指定的独立第三意见。
- 默认 hard timeout：短任务 600 秒、标准任务 1200 秒、长任务 1800 秒；默认 idle timeout
  分别为 180/300/420 秒。可用
  `timeout_seconds` 在 60 至 7200 秒内覆盖。

等待与结果回收：

```text
wait_job(job_id="...", wait_seconds=40)
collect_ready_results(collaboration_id="...", caller="codex")
```

`delegate_agent.wait_seconds` 仍限制为 0 至 120 秒，避免初始委派长时间占用 MCP 调用；耗时任务
通过 `wait_job` 服务端有界长轮询，减少 SSH 轮询。为兼容常见 MCP 客户端的 60 秒请求超时，
单次实际阻塞最多 40 秒；传入更大的值会返回 `wait_capped=1`，调用方可继续调用。未主动等待的任务完成后可由
`collect_ready_results` 一次回收。

历史隔离副本先预览、再压缩：

```bash
~/.lan-dev-machine/bin/twin-agent-remote compact dry-run
~/.lan-dev-machine/bin/twin-agent-remote compact apply
```

查询 MCP：

```text
collaboration_stats(date="2026-09-14", timezone="Asia/Taipei", include_jobs=true)
```

查询命令行：

```bash
twin-collab-report 2026-09-14 --include-jobs
twin-collab-report all --format json
```

工具：`collaboration_event`、`delegate_agent`、`collaboration_stats`、`job_status`、
`wait_job`、`job_result`、`collect_ready_results`、`cancel_job`、`list_jobs`、`fetch_job_patch`、`apply_job_patch`、
`queue_status`、`twin_agent_health`。
