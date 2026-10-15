/**
 * dsh-context-budget — 移植 Codex TokenBudget 机制到 DSH。
 *
 * 对标（Codex 源码级核实 2026-09-16，openai/codex main）：
 *  ① 剩余预算告知：Codex 注入 "You have N tokens left" + get_context_remaining 工具
 *     → 这里用 systemPrompt.context provider（每轮装配同步渲染）+ remaining 工具。
 *  ② 换窗不摘要 + 旧窗可检索：Codex 同一 rollout 内新开 context window，
 *     history/notes 工具检索旧窗口 → DSH 压缩本就是无损 shadow（旧事件永久保留在
 *     session.jsonl.zstd），所以这里提供 history_search/history_read 工具直接检索
 *     转录原文，notes 工具做跨压缩检查点（对标 Codex notes:* 协议：临近压缩先写
 *     checkpoint，压缩后可恢复）。
 *
 * 数据来源（双路，转录为真相源）：
 *  - contextWindow/压缩次数/usage：优先从转录 request/context、compaction/end、
 *    usage 事件派生（summarizeBudget，自包含不依赖监听器是否触发）；
 *    session/event 监听器做增量缓存加速。
 *  - 当前压力：ctx.tokenMeter.measure(session)（服务可用时）→ usage 回退。
 *
 * 规范：资源注册全部挂 ctx.effect（热重载/卸载自动清理）。
 * 工具 schema 精简：description 短句，细节放 tool result。
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { locateTranscript, loadEvents, searchEvents, formatHit, renderEventRange, summarizeBudget, type TEvent } from './transcript.js'
import { setNotesDir, appendNote, readNotes, formatNotes } from './notes.js'
import { writeRolloverFlag, readRolloverFlag, deleteRolloverFlag } from './rollover.js'

export const name = 'dsh-context-budget'
// 注意：'compaction' 禁止写入 inject——在未装配压缩引擎的 host 上（compaction-basic
// disabled），缺失依赖会让 fiber 永久 pending，叠加注入器 waitFiberStable 缺陷曾把
// 会话永久卡死（2026-09-16 事故）。rollover 处改用 ctx.get('compaction') 可选读取。
export const inject = ['tools', 'systemPrompt']

export interface Config {
  enabled: boolean
  injectBudgetLine: boolean
  reminderRemainingPct: number
  maxSearchHits: number
  notesDir: string
  /** preset realm 模式：只注册换窗标志消费者（引擎仅在 isolate realm 内可解析），不注册工具/provider */
  realmRollover: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  injectBudgetLine: z.boolean().default(true),
  // DSH 压缩在已用 ≥80%（thresholdRatio 0.8×window）触发；提醒须早于它，
  // 默认剩余 ≤30%（已用 ≥70%）即预警，给模型留出写 notes 检查点的窗口。
  reminderRemainingPct: z.number().default(30),
  maxSearchHits: z.number().default(20),
  notesDir: z.string().default(''),
  realmRollover: z.boolean().default(false),
})

interface SessionState {
  contextWindow?: number
  compactions?: number
  lastUsageTotal?: number
}

interface Budget {
  id: string
  used?: number
  contextWindow?: number
  compactions: number
  transcript?: string
}

/** realm 模式实例：装进 preset 的 compaction 组（isolate realm），只消费换窗标志文件。
 *  引擎服务被 isolate 在 realm 内，root/agent.ctx 均不可见——realm 实例自己的 ctx 才能解析。 */
function registerRealmRollover(ctx: Context): void {
  const anyCtx = ctx as any
  ctx.effect(() => anyCtx.on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    try {
      const agent = payload?.agent
      const id = String(agent?.session?.id ?? '')
      const flag = id ? readRolloverFlag(id) : null
      if (flag && Date.now() - flag.ts < 10 * 60 * 1000) {
        deleteRolloverFlag(id)
        const engine = (() => {
          try { const e = anyCtx.compaction; return e && typeof e.compactIfNeeded === 'function' ? e : undefined } catch { return undefined }
        })()
        if (!engine) {
          appendNote(id, { source: 'auto', tag: 'new-window', text: '换窗失败：realm 内未能解析 ctx.compaction。' })
        } else {
          try {
            const result = await engine.compactIfNeeded(agent, 'context-overflow', payload.signal)
            if (result) {
              appendNote(id, { source: 'auto', tag: 'new-window', text: `换窗已执行：shadowed seq ${result.shadowedRange?.start}-${result.shadowedRange?.end}（约 ${result.shadowedTokenCount} tokens）。旧轮次可用 history_search 检索。` })
            } else {
              appendNote(id, { source: 'auto', tag: 'new-window', text: '换窗请求已处理：引擎判定当前无可安全压缩的范围（返回 null，常见于会话内容全部处于保留区），继续原上下文。' })
            }
          } catch (e: any) {
            const msg = e instanceof Error ? e.message : String(e)
            appendNote(id, { source: 'auto', tag: 'new-window', text: `换窗失败：压缩引擎异常 — ${String(msg).slice(0, 200)}` })
          }
        }
      }
    } catch { /* realm 监听器永不阻塞轮次 */ }
    return next()
  }), 'dsh-context-budget: realm rollover listener')
}

export function apply(ctx: Context, config: Config): void {
  if (!config.enabled) return
  setNotesDir(config.notesDir)
  if (config.realmRollover) { registerRealmRollover(ctx); return }
  const anyCtx = ctx as any
  const states = new Map<string, SessionState>()
  const rolloverRequests = new Set<string>() // new_window 置位，pre-step 边界消费
  let lastSession: any = null

  const sid = (session: any): string => String(session?.id ?? '')
  const stateOf = (id: string): SessionState => {
    let st = states.get(id)
    if (!st) { st = {}; states.set(id, st) }
    return st
  }

  /** 压缩引擎解析：CompactionEngine 为 per-context 服务；本机 compaction-basic 可能 disabled（引擎缺席）。
   *  代理属性读对未装配服务会 throw，逐路 try；agent 作用域优先、插件根作用域兜底。 */
  const resolveEngine = (agentCtx?: any): any => {
    for (const c of [agentCtx, anyCtx]) {
      if (!c) continue
      try { const e = c.compaction; if (e && typeof e.compactIfNeeded === 'function') return e } catch { /* proxy throw */ }
      try { const e = typeof c.get === 'function' ? c.get('compaction') : undefined; if (e && typeof e.compactIfNeeded === 'function') return e } catch { /* noop */ }
    }
    return undefined
  }

  // ── durable 事件观察（增量缓存，加速 provider；非真相源） ──
  ctx.effect(() => (ctx as any).on('session/event', (session: any, event: any) => {
    try {
      const id = sid(session)
      if (!id || !event || typeof event.type !== 'string') return undefined
      lastSession = session
      const st = stateOf(id)
      const type: string = event.type
      if (type === 'request/context') {
        const cw = event?.data?.contextWindow ?? event?.data?.context?.contextWindow
        if (typeof cw === 'number' && cw > 0) st.contextWindow = cw
      } else if (type === 'compaction/end') {
        st.compactions = (st.compactions ?? 0) + 1
        try {
          appendNote(id, {
            source: 'auto', tag: 'compaction', compactions: st.compactions,
            text: `第 ${st.compactions} 次压缩完成。压缩前的全部轮次原文仍保留在会话转录中，可用 history_search / history_read 找回；任务状态见此前的 model 检查点。`,
          })
        } catch { /* notes 写失败不影响主流程 */ }
      } else if (type === 'assistant/message') {
        const u = event?.data?.usage
        if (u && typeof u.totalTokens === 'number') st.lastUsageTotal = u.totalTokens
        else if (u && typeof u.inputTokens === 'number') st.lastUsageTotal = u.inputTokens + (u.outputTokens ?? 0)
      } else if (type === 'assistant/chunk') {
        const c = event?.chunk ?? event?.data?.chunk
        if (c?.type === 'usage' && c.usage && typeof c.usage.totalTokens === 'number') st.lastUsageTotal = c.usage.totalTokens
      }
    } catch { /* 观察者永不抛出 */ }
    return undefined
  }), 'dsh-context-budget: session/event observer')

  // ── ③ 模型主动换窗：new_window 置标志，pre-step 边界强制压缩 ──
  // 时机选 pre-step：此时上一个工具调用/结果已配对入日志，压缩范围平衡安全；
  // 通道选 context-overflow：文档明确「可低于常规阈值强制有效压缩」（compactNow 要求 idle，工具内调用会 busy）。
  ctx.effect(() => (ctx as any).on('agent/pre-step', async (payload: any, next: () => Promise<any>) => {
    try {
      const agent = payload?.agent
      const id = sid(agent?.session)
      if (id && rolloverRequests.has(id)) {
        rolloverRequests.delete(id)
        const lg = typeof anyCtx.logger === 'function' ? anyCtx.logger('dsh-context-budget') : anyCtx.logger
        const engine = resolveEngine(agent?.ctx)
        if (!engine || typeof engine.compactIfNeeded !== 'function') {
          // root 无引擎是常态（引擎被 preset isolate realm 隔离）——文件标志留给 realm 实例消费，
          // 90s 未消费由 stale 看门狗落「未消费」记录。此处静默让位，不写误导性失败笔记。
          try { lg?.info?.('[context-budget] rollover: no root-visible engine; deferring to realm instance') } catch { /* noop */ }
        } else {
          try {
            const result = await engine.compactIfNeeded(agent, 'context-overflow', payload.signal)
            if (result) {
              appendNote(id, { source: 'auto', tag: 'new-window', text: `换窗已执行：shadowed seq ${result.shadowedRange?.start}-${result.shadowedRange?.end}（约 ${result.shadowedTokenCount} tokens）。旧轮次可用 history_search 检索。` })
              try { lg?.info?.('[context-budget] rollover: compacted ' + JSON.stringify(result.shadowedRange)) } catch { /* noop */ }
            } else {
              appendNote(id, { source: 'auto', tag: 'new-window', text: '换窗请求已处理：引擎判定当前无可安全压缩的范围（返回 null，常见于会话内容全部处于保留区），继续原上下文。' })
              try { lg?.info?.('[context-budget] rollover: engine returned null (no compactable range)') } catch { /* noop */ }
            }
          } catch (e: any) {
            const msg = e instanceof Error ? e.message : String(e)
            appendNote(id, { source: 'auto', tag: 'new-window', text: `换窗失败：压缩引擎异常 — ${String(msg).slice(0, 200)}` })
            try { lg?.warn?.('[context-budget] rollover failed: ' + msg) } catch { /* noop */ }
          }
        }
      }
      // stale 标志看门狗：realm 实例超 90s 未消费 → 落「未消费」记录并清标志（root 引擎可见的 host 已在上面分支消费）
      if (id) {
        const flag = readRolloverFlag(id)
        if (flag && Date.now() - flag.ts > 90_000) {
          deleteRolloverFlag(id)
          rolloverRequests.delete(id)
          appendNote(id, { source: 'auto', tag: 'new-window', text: '换窗标志未消费（>90s）：当前 preset 未含 realm 换窗实例或引擎不可用，换窗未执行——请用 handoff 移交子会话。' })
        }
      }
    } catch { /* 监听器自身异常不阻塞轮次 */ }
    return next()
  }), 'dsh-context-budget: pre-step rollover')

  /** 事件来源：目标会话在进程内时优先 snapshotEvents（免解压、永远最新）；否则读转录文件。 */
  const eventsFor = (session: any, id: string, staleOkMs = 0): TEvent[] | null => {
    try {
      if (id && session && sid(session) === id && typeof session.snapshotEvents === 'function') {
        const snap = session.snapshotEvents()
        if (Array.isArray(snap)) return snap as TEvent[]
      }
    } catch { /* 快照不可用 → 回退转录 */ }
    const loaded = loadEvents(id, staleOkMs)
    return loaded ? loaded.events : null
  }

  /** 汇总预算：tokenMeter（当前压力）+ 转录派生（窗口/压缩/usage 兜底）+ 监听缓存。 */
  const getBudget = (session: any, staleOkMs = 0): Budget => {
    const id = sid(session)
    const st = states.get(id) ?? {}
    const b: Budget = { id, compactions: st.compactions ?? 0 }
    // 当前压力：tokenMeter 优先
    try {
      const m = anyCtx.tokenMeter?.measure?.(session)
      if (m && typeof m.totalTokens === 'number' && m.totalTokens > 0) b.used = m.totalTokens
    } catch { /* 回退到 usage */ }
    // 转录/快照派生（真相源）：contextWindow / compactions / usage 兜底
    if (id) {
      try {
        const events = eventsFor(session, id, staleOkMs)
        if (events) {
          const sum = summarizeBudget(events)
          if (sum.contextWindow != null) b.contextWindow = sum.contextWindow
          b.compactions = Math.max(b.compactions, sum.compactions)
          if (b.used == null) b.used = sum.lastUsageTotal
        }
        b.transcript = locateTranscript(id) ?? undefined
      } catch { /* 转录不可读 → 用监听缓存 */ }
    }
    if (b.contextWindow == null && st.contextWindow != null) b.contextWindow = st.contextWindow
    if (b.used == null) b.used = st.lastUsageTotal
    return b
  }

  // ── ① 预算感知注入：每轮装配同步渲染；低于阈值换成 Codex 式提醒 ──
  const budgetLine = (c: any): string => {
    if (!config.injectBudgetLine) return ''
    try {
      const session = c?.agent?.session ?? lastSession
      if (!session) return ''
      const b = getBudget(session, 1500) // provider 走 stale-ok 缓存，限频解压
      const hint = '全部历史轮次原文均已保留：history_search 检索 / history_read 读原文 / notes 写读检查点。'
      if (b.used == null || b.contextWindow == null) {
        return b.used != null || b.compactions > 0
          ? `[上下文预算] 已用约 ${b.used ?? '?'} tokens${b.contextWindow ? `/${b.contextWindow}` : ''}；压缩 ${b.compactions} 次。${hint}`
          : ''
      }
      const rem = Math.max(0, b.contextWindow - b.used)
      const pct = Math.round((rem / b.contextWindow) * 100)
      if (pct <= config.reminderRemainingPct) {
        return `[上下文预算] ⚠ 剩余约 ${rem} tokens（${pct}%），逼近压缩阈值（压缩后旧轮次移出上下文但不删除，全文可检索）。请先用 notes 写入检查点（任务目标/关键约束/已完成/下一步）；可调 new_window 请求立即换窗（执行结果落 notes），或 handoff 移交全新子会话；压缩后用 history_search 找回旧轮次原文。`
      }
      return `[上下文预算] 已用约 ${b.used}/${b.contextWindow} tokens，剩余 ${pct}%；压缩 ${b.compactions} 次。${hint}`
    } catch { return '' }
  }
  ctx.effect(() => anyCtx.systemPrompt?.context?.({
    name: 'context-budget',
    order: 95,
    text: budgetLine,
  }), 'dsh-context-budget: budget context provider')

  // ── 工具面（4 个）：remaining / history_search / history_read / notes ──
  const strOutput = {
    schema: { type: 'string' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: String(value) }],
  }
  const currentSession = (exec: any): any => exec?.agent?.session ?? lastSession

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_remaining',
    description: '查询当前会话上下文预算：窗口/已用/剩余/压缩次数/转录路径',
    parameters: {},
    output: strOutput,
    async execute(_args: object, exec: any) {
      const session = currentSession(exec)
      const b = getBudget(session)
      const lines: string[] = [`session_id: ${b.id || '(未知)'}`]
      if (b.used != null) lines.push(`已用: ~${b.used} tokens${b.contextWindow ? ` / 窗口 ${b.contextWindow}` : ''}`)
      if (b.used != null && b.contextWindow != null) {
        const rem = Math.max(0, b.contextWindow - b.used)
        lines.push(`剩余: ~${rem} tokens (${Math.round((rem / b.contextWindow) * 100)}%)`)
        if ((rem / b.contextWindow) * 100 <= config.reminderRemainingPct) {
          lines.push(`⚠ 低于提醒阈值 ${config.reminderRemainingPct}%：建议立即用 notes 写任务状态检查点（目标/约束/进度/下一步）。`)
        }
      } else {
        lines.push('剩余: 暂无法测量（尚无 usage/窗口数据）')
      }
      lines.push(`压缩次数: ${b.compactions}（DSH 压缩为无损 shadow：旧轮次仅移出上下文，原文永久保留在转录中）`)
      lines.push(`转录文件: ${b.transcript ?? (b.id ? (locateTranscript(b.id) ?? '未找到') : '未找到')}`)
      const notes = readNotes(b.id, 3)
      lines.push(notes.length ? `最近检查点: ${notes[notes.length - 1].text.slice(0, 120)}` : '检查点笔记: 暂无（用 notes 工具写入）')
      return lines.join('\n')
    },
  })), 'dsh-context-budget: remaining tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_history_search',
    description: '检索本会话完整转录（含已被压缩移出上下文的旧轮次原文），大小写不敏感子串匹配',
    parameters: {
      query: { type: 'string', required: true, description: '检索子串' },
      limit: { type: 'integer', description: '最大命中数，默认 20，上限 50' },
      types: { type: 'string', description: '事件类型过滤（逗号分隔），如 user/message,tool/call' },
      session_id: { type: 'string', description: '默认当前会话' },
    },
    output: strOutput,
    async execute(args: { query: string; limit?: number; types?: string; session_id?: string }, exec: any) {
      const session = currentSession(exec)
      const id = args.session_id || sid(session)
      const events = eventsFor(session, id)
      if (!events) return `未找到会话转录（session_id=${id || '空'}）。转录路径规则 ~/.dsh/sessions/<workspace-slug>/<session-uuid>/session.jsonl.zstd`
      const limit = Math.min(Math.max(args.limit ?? config.maxSearchHits, 1), 50)
      const types = args.types ? args.types.split(',').map(s => s.trim()).filter(Boolean) : undefined
      const hits = searchEvents(events, args.query, { limit, types })
      const head = `转录 ${locateTranscript(id) ?? '进程内会话快照'}（共 ${events.length} 个事件），query="${args.query}" 命中 ${hits.length} 条：`
      if (!hits.length) return `${head}\n（无命中。可用 history_read 按 seq 范围直接浏览原文。）`
      return `${head}\n${hits.map(formatHit).join('\n')}\n→ 用 history_read(from_seq,to_seq) 读取命中处原文。`
    },
  })), 'dsh-context-budget: history_search tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_history_read',
    description: '按 seq 范围读取会话转录事件原文（默认最近 20 条有意义事件）',
    parameters: {
      from_seq: { type: 'integer', description: '起始 seq（含）' },
      to_seq: { type: 'integer', description: '结束 seq（含）' },
      limit: { type: 'integer', description: '最多返回事件数，默认 20' },
      session_id: { type: 'string', description: '默认当前会话' },
    },
    output: strOutput,
    async execute(args: { from_seq?: number; to_seq?: number; limit?: number; session_id?: string }, exec: any) {
      const session = currentSession(exec)
      const id = args.session_id || sid(session)
      const events = eventsFor(session, id)
      if (!events) return `未找到会话转录（session_id=${id || '空'}）`
      const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
      const body = renderEventRange(events, args.from_seq, args.to_seq, limit)
      return `转录 ${locateTranscript(id) ?? '进程内会话快照'}\n${body || '（范围内无事件）'}`
    },
  })), 'dsh-context-budget: history_read tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_notes',
    description: '跨压缩检查点笔记：write 写入任务状态（临近压缩前必写），read 读回。压缩后凭此快速恢复',
    parameters: {
      action: { type: 'string', required: true, description: 'write 或 read' },
      text: { type: 'string', description: 'write 时必填：任务目标/关键约束/已完成/下一步' },
      tag: { type: 'string', description: '可选标签，如 checkpoint/handoff' },
      session_id: { type: 'string', description: '默认当前会话' },
    },
    output: strOutput,
    async execute(args: { action: string; text?: string; tag?: string; session_id?: string }, exec: any) {
      const id = args.session_id || sid(currentSession(exec))
      if (!id) return '无法确定当前会话 id（工具执行环境未挂 agent），请显式传 session_id'
      if (args.action === 'write') {
        if (!args.text || !args.text.trim()) return 'write 需要 text 参数'
        const file = appendNote(id, { source: 'model', tag: args.tag || 'checkpoint', text: args.text.trim() })
        const st = states.get(id)
        return `检查点已写入 ${file}（当前压缩次数 ${st?.compactions ?? 0}）。该笔记独立于上下文压缩，永久保留。`
      }
      if (args.action === 'read') return formatNotes(id, readNotes(id, 20))
      return `未知 action "${args.action}"（支持 write / read）`
    },
  })), 'dsh-context-budget: notes tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_new_window',
    description: '主动换窗：写入检查点并在下一步开始前强制压缩（旧轮次不删除、仍可检索）。对标 Codex new_context',
    parameters: {
      checkpoint: { type: 'string', description: '可选：换窗前写入 notes 的任务状态（目标/约束/进度/下一步）' },
    },
    output: strOutput,
    async execute(args: { checkpoint?: string }, exec: any) {
      const session = currentSession(exec)
      const id = sid(session)
      if (!id) return '无法确定当前会话 id，无法换窗'
      const b = getBudget(session)
      if (args.checkpoint && args.checkpoint.trim()) {
        appendNote(id, { source: 'model', tag: 'pre-new-window', text: args.checkpoint.trim() })
      }
      appendNote(id, {
        source: 'auto', tag: 'new-window',
        text: `模型主动请求换窗（已用 ${b.used ?? '?'}/${b.contextWindow ?? '?'} tokens，压缩 ${b.compactions} 次）。换窗后：notes read 读检查点，history_search 检索换窗前原文。`,
      })
      // 双通道：内存标志（root 可见引擎的 host 兜底）+ 文件标志（preset realm 实例消费；isolate 边界唯一可靠通道）
      rolloverRequests.add(id)
      writeRolloverFlag(id)
      return `换窗已请求：下一步开始前将尝试强制压缩，执行结果自动落 notes（用 notes {action:'read'} 查看，应为「换窗已执行」或「无可安全压缩的范围」）。若 notes 出现「换窗标志未消费」说明本会话 preset 未挂换窗 realm——改用 handoff 移交子会话。旧轮次原文始终保留，history_search 可检索。`
    },
  })), 'dsh-context-budget: new_window tool')

  ctx.effect(() => ctx.tools.register(defineTool({
    name: '_dsh_external_dsh_context_budget_handoff',
    description: '跨会话移交：写移交检查点并生成给 subagent/新会话的接续 prompt（旧会话保持可检索）',
    parameters: {
      task: { type: 'string', required: true, description: '接续会话要执行的任务描述' },
      checkpoint: { type: 'string', description: '可选：补充任务状态（目标/约束/进度/下一步）' },
    },
    output: strOutput,
    async execute(args: { task: string; checkpoint?: string }, exec: any) {
      const session = currentSession(exec)
      const id = sid(session)
      if (!id) return '无法确定当前会话 id，无法移交'
      const text = [args.task.trim(), args.checkpoint?.trim()].filter(Boolean).join('\n')
      const file = appendNote(id, { source: 'model', tag: 'handoff', text })
      const prompt = [
        `你是接替会话 ${id} 的接续会话。任务：${args.task.trim()}`,
        `第一步：调用 _dsh_external_dsh_context_budget_notes {action:'read', session_id:'${id}'} 读取移交检查点。`,
        `需要移交前对话细节时：调用 _dsh_external_dsh_context_budget_history_search {query:'关键词', session_id:'${id}'} 检索原文（history_read 按 seq 读）。`,
        args.checkpoint?.trim() ? `补充状态：${args.checkpoint.trim()}` : '',
        `完成后按三态回报：完成（附验证）/ 阻塞（附原因）/ 部分完成（附清单）。`,
      ].filter(Boolean).join('\n')
      return `移交检查点已写入 ${file}\n请用以下 prompt 调用 subagent 工具（或交给用户开新会话）：\n---\n${prompt}\n---`
    },
  })), 'dsh-context-budget: handoff tool')
}
