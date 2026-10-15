# dsh-context-budget 设计定稿（v1.0，2026-09-16）

> 状态：已实现、已注入、已端到端验证。本文件替代 v0.1 草案的全部 TBD。

## 调研结论（决定架构的三个事实）

1. **DSH 压缩是无损 shadow**（dsh-compaction-basic）：thresholdRatio 0.8×contextWindow 触发，摘要仅遮蔽 surface，旧事件永久保留在 ~/.dsh/sessions/<slug>/<id>/session.jsonl.zstd → 「归档旧会话」不需要插件做，只需给模型检索工具。
2. **systemPrompt.context provider** 渲染进请求尾部 runtime-context snapshot（与 mneme 同块），每轮重新生成、不碰前缀缓存 → 预算行零缓存成本（实测注入前后稳态命中 ≈100%，唯一 miss 是注入时工具面+4 的一次性重建）。反面：systemPrompt.section 进 system prompt 头部，每轮变化数字会全灭缓存——特意避开。
3. **exec.agent.session**（ToolRunContext）给工具当前会话；snapshotEvents() 进程内全量快照（免解压）；ctx.tokenMeter.measure(session) 官方压力测量。

## 数据通路（双路冗余）

- 当前压力：tokenMeter.measure().totalTokens → usage 事件兜底（转录 summarizeBudget / session/event 监听缓存）
- contextWindow：request/context 事件（转录派生为主，监听缓存为辅）
- 压缩次数：compaction/end 计数（监听器 + 转录派生取 max；监听器同时自动写 auto 检查点笔记）
- 事件源：本会话 → snapshotEvents() 快路径；跨会话/resume → zstd 转录解压（CLI 优先——node zlib 对多帧 zstd 只解首帧不报错，实测坑；撕裂尾帧容忍取部分 stdout）

## 工具面（4 个，全部 defineTool + ctx.effect）

remaining / history_search / history_read / notes —— 详见 README。

## 提醒协议（对标 Codex）

- 常态：一行预算 + 检索指引（order 95，尾部 snapshot）
- 剩余 ≤ reminderRemainingPct(30%)：切换 ⚠ 文案，指示先 notes 写检查点（目标/约束/进度/下一步）再继续——早于 80% 压缩阈值，语义对齐 Codex auto_compact_fallback_prompt（"写一条 notes 再换窗"）
- compaction/end：监听器自动落 auto 检查点，压缩后 notes read + history_search 双通道恢复

## 验证记录（2026-09-16）

| 项 | 结果 |
|---|---|
| 构建（install-mode build.sh） | exit 0，两次（初版+阈值修正） |
| 注入/热重载 | dev_inject OK（host ✓），dev_reload before/after 均 active |
| 预算行活体 | 每轮 runtime context 显示，数值与转录派生一致（199822/1000000 精确吻合） |
| remaining 工具 | 活体调用 ✓（本会话 session-f11dd862） |
| history_search | 活体 ✓：24757 事件命中 3 条第 1 轮调研原文；真实压缩会话（shadowedRange 8→125873）shadow 轮次命中 5 条 |
| history_read / notes | 活体 ✓（write→read 闭环，~/.dsh/context-budget/notes/） |
| 单测 | summarizeBudget/shadowed 检索/notes 全过（/tmp/unit-budget.mjs） |
| 缓存回归 | /tmp/cache-check.mjs：注入前 74 请求 vs 后 18 请求，稳态命中 ≈100% |

## v1.1 增补（2026-09-16）：模型主动换窗 + 跨会话移交

- new_window：Codex 双通道设计的「模型主动」通道（should_roll_over = 模型请求 || 阈值强制）。实现：工具置 rolloverRequests 标志 → agent/pre-step waterfall 监听器消费 → ctx.compaction.compactIfNeeded(agent,'context-overflow',signal)（API 文档：context-overflow 通道可低于常规阈值强制有效压缩）。结果自动落 notes（shadowedRange 或 null 说明）。
- handoff：写 handoff 检查点 + 渲染接续 prompt（含旧会话 id、notes read/history_search 调用指令、三态回报要求）。不做嵌套 dispatch（ToolRuntimeScheduler 为 @internal），由模型自己调 subagent——稳健且复用现有工具的全部生命周期管理。
- ⚠ 提醒文案同步加入 new_window/handoff 指引（数字+指令配对原则）。
- 活体验证：handoff 本会话实测通过（检查点落盘+prompt 渲染正确）；new_window 由子代理在其独立会话实测（结果见验证记录）。

## v1.3 增补（2026-09-16）：realm 换窗架构（isolate 边界突破）

- 实证：compaction-basic 并非全局 disabled，而是按 preset 装在 cordis:group + isolate realm 内（code-guarded/code/dshagent/designharness/router-standard 五个用户预设均含该组）。isolate 使引擎服务只在 realm 子树可见——root 注入的插件与 agent.ctx 都解析不到（两轮子代理实测 C 分支证实）。
- 方案：双实例架构。root 实例（注入器装配）= 工具面 + 预算 provider + 标志写入 + stale 看门狗；realm 实例（preset compaction 组内 `- id: context-budget-rollover, config: {realmRollover: true}`）= 只注册 pre-step 监听，realm 内 ctx.compaction 直接可解析，消费 ~/.dsh/context-budget/rollover/<sid>.json 标志 → compactIfNeeded('context-overflow') → 结果落 notes（A 已执行/B 无可压范围/C 解析失败/D 异常 四分支全落盘）。
- 通信选文件而非内存：跨 isolate realm 无共享 JS 作用域，文件标志是唯一可靠通道（10min 过期保护 + 90s stale 看门狗防静默丢失）。
- preset 补丁经「对照解析+行数+唯一性」三重校验（js-yaml 会被既有 !!js 标签卡死，改用 eemeli/yaml 对照解析原文件成功才校验补丁版）。5 预设全部 PATCHED。
- ⚠ provider 文案不再按 root 引擎探测分支（realm 隔离下永远探测失败会误报），统一为「逼近压缩阈值+行动指引」。

## v1.4 终验（2026-09-17）：realm 独立包 A 分支实弹通过

- 架构定稿：主包（root 注入，工具面+预算 provider+标志写入+stale 看门狗）+ dsh-context-budget-realm（preset compaction 组内，inject:['compaction'] 声明式等待——裸属性读在 realm 内两次实测失败后的正解，command-compact 同款路径）。
- 实弹证据（金丝雀会话 304db5e4）：42590/1000000 tokens 的小会话（远低于任何压缩阈值）调 new_window → realm 实例消费标志 → compactIfNeeded('context-overflow') 真实执行 → notes 落「换窗已执行：shadowed seq 9-12（约 10611 tokens）」+ session/event 监听器落「第 1 次压缩完成」自动检查点。Codex「模型主动提前换窗」语义完整复现。
- 裸属性读失败根因存档：cordis Service 经 ctx.reflect.provide(name, this, this[Service.check]) 注册（带可用性谓词），非 inject 声明的属性读在 realm 内解析不到 'compaction'；inject 声明式等待是唯一可靠路径。root 侧 inject 'compaction' 会因引擎不在 root 平面而永久 pending（2026-09-16 卡死事故），故拆独立包、realm 专用。
- 验证协议修正：realm 消费者在下一 step 的 pre-step 才跑，「new_window 同轮立即 read notes」会误判无结果；需隔 step 复读。

## 已知边界（非阻塞）

- 阈值 ⚠ 文案与 compaction 自动笔记未在活体压缩中触发（本会话用量 20% 远未到 80%）；逻辑经单测+真实压缩会话数据验证，待自然触发复核。
- 转录解压全量加载，超大转录（>80MB）扫描时跳过；工具路径无此限制但首次解压秒级。
- notes/history 全本地（Codex 是服务端 API）——VM 场景本地即最优。
