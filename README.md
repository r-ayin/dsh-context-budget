# dsh-context-budget

移植 OpenAI Codex CLI 的 TokenBudget 上下文机制到 DSH（2026-09-16，源码级对标 codex-rs main 分支）。

## 对标关系

| Codex 机制 | 本插件实现 |
|---|---|
| 注入 developer 消息 "You have N tokens left" | `systemPrompt.context` 预算行（每轮装配渲染进尾部 snapshot，不破坏前缀缓存） |
| `get_context_remaining` 工具 | `*_remaining` 工具（tokenMeter.measure + 转录派生双路） |
| 阈值提醒 TokenBudgetReminder | 剩余 ≤30% 时预算行切换为 ⚠ 提醒（早于 DSH 80% 压缩阈值，留出写检查点窗口） |
| 换窗不摘要 + 同 rollout 新窗口 | DSH 压缩本就是无损 shadow（旧事件永久留在 session.jsonl.zstd）——无需换窗，直接可检索 |
| `history.*` 检索旧窗口 | `*_history_search` / `*_history_read`（进程内 snapshotEvents 快路径 + zstd 转录解压兜底，CLI 优先解多帧） |
| `notes.*` 检查点 | `*_notes`（write/read，独立于压缩永久保留；compaction/end 自动落一条 auto 检查点） |

## 工具（注入后前缀 `_dsh_external_dsh_context_budget_`）

- `remaining` — 窗口/已用/剩余/压缩次数/转录路径
- `history_search` — 大小写不敏感子串检索全会话转录（含被压缩 shadow 的旧轮次）
- `history_read` — 按 seq 范围读事件原文
- `notes` — action=write/read 跨压缩检查点
- `new_window` — 模型主动换窗（对标 Codex new_context）：写检查点+置标志（内存+文件双通道），pre-step 边界走 compactIfNeeded('context-overflow') 强制压缩（低于阈值也能换；不用 compactNow 因其要求 agent idle）。v1.3 realm 架构：压缩引擎被 preset 隔离在 isolate realm 内（`isolate: compaction: true`），root 插件解析不到——故 preset 的 compaction 组内追加挂载本插件的 realmRollover 实例（只注册 pre-step 监听，不注册工具/provider），经 ~/.dsh/context-budget/rollover/<sid>.json 标志文件跨 isolate 边界通信；root 侧 stale 看门狗 90s 未消费即落「未消费」笔记指引 handoff
- `handoff` — 跨会话移交：写 handoff 检查点 + 生成接续 prompt（内嵌旧会话 id 与检索指令），交给 subagent 或新会话；旧会话凭 session_id 参数跨会话可检索

## 配置（loader config）

`enabled`(true) / `injectBudgetLine`(true) / `reminderRemainingPct`(30) / `maxSearchHits`(20) / `notesDir`(默认 ~/.dsh/context-budget/notes)

## 构建（本机无源码 checkout，用 install-mode）

`bash scripts/build.sh`（依赖链接自 /usr/lib/node_modules/@deepseek-ai/dsh/node_modules，tsc 探测盘上现成 typescript）→ `dev_inject_plugin {dir}` → `dev_reload_package` 热重载。

## 已验证（2026-09-16）

- 预算行活体注入（本会话每轮 runtime context 可见，数值与转录 summarizeBudget 一致）
- 4 工具活体调用通过；history_search 在 24757 事件会话命中第 1 轮旧内容
- 真实压缩会话（session-0ef7a42c，shadowedRange 8→125873）中被 shadow 的旧轮次可检索命中
- 缓存无回归：注入前后稳态命中率 ≈100%（预算行在尾部 snapshot，不碰前缀）
- 单测：summarizeBudget / shadowed 检索 / notes 读写全过
