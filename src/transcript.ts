/**
 * 会话转录（session.jsonl.zstd）定位、解压、解析、检索、渲染、预算摘要。
 * DSH 压缩是「无损 shadow」：旧事件永久保留在转录里，本模块把这份
 * durable 记录暴露给模型（对标 Codex history:* 工具，全本地）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

export interface TEvent {
  type: string
  seq?: number
  time?: number
  data?: any
  chunk?: any
  [k: string]: any
}

export interface Hit {
  seq?: number
  type: string
  time?: number
  snippet: string
}

export interface BudgetSummary {
  contextWindow?: number
  compactions: number
  lastUsageTotal?: number
}

const SESSIONS_ROOT = path.join(os.homedir(), '.dsh', 'sessions')

/** 检索/阅读默认覆盖的「有意义」事件（排除 chunk 增量与打包行）。 */
const MEANINGFUL = new Set([
  'user/message', 'assistant/message', 'tool/call', 'tool/result',
  'compaction/start', 'compaction/summary', 'compaction/end', 'compaction/prune',
  'turn/start', 'turn/end',
])

interface CacheEntry { key: string; events: TEvent[]; time: number }
const cache = new Map<string, CacheEntry>()

export function locateTranscript(sessionId: string): string | null {
  if (!sessionId || sessionId === 'unknown') return null
  let slugs: string[] = []
  try { slugs = fs.readdirSync(SESSIONS_ROOT) } catch { return null }
  for (const slug of slugs) {
    for (const fname of ['session.jsonl.zstd', 'session.jsonl']) {
      const p = path.join(SESSIONS_ROOT, slug, sessionId, fname)
      try { if (fs.statSync(p).isFile()) return p } catch { /* continue */ }
    }
  }
  return null
}

function decompress(file: string): string | null {
  if (file.endsWith('.zstd')) {
    // CLI 优先：实测多帧拼接 zstd，CLI 完整解码（570 行）；node 内置 zstdDecompressSync
    // 只解首帧不报错（得 1 行）。CLI 遇尾部撕裂帧会 non-zero 退出，stdout 已有完整帧——取之。
    try {
      return execFileSync('zstd', ['-dc', file], { maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
    } catch (e: any) {
      const partial = e?.stdout
      if (partial && partial.length) return Buffer.isBuffer(partial) ? partial.toString('utf8') : String(partial)
    }
    // 兜底：node 内置 zstd（单帧场景或无 CLI 环境）
    const zstdSync = (zlib as any).zstdDecompressSync
    if (typeof zstdSync === 'function') {
      try { return zstdSync(fs.readFileSync(file), { maxOutputLength: 1 << 30 }).toString('utf8') } catch { /* give up */ }
    }
    return null
  }
  try { return fs.readFileSync(file, 'utf8') } catch { return null }
}

/** 加载并解析会话转录事件。
 *  maxAgeMs > 0 时，缓存即便 mtime 变了也在该窗口内复用（供每轮装配的 provider 省解压）。
 *  工具调用传 maxAgeMs=0 强制读最新。 */
export function loadEvents(sessionId: string, maxAgeMs = 0): { file: string; events: TEvent[] } | null {
  const file = locateTranscript(sessionId)
  if (!file) return null
  let st: fs.Stats
  try { st = fs.statSync(file) } catch { return null }
  const key = `${st.mtimeMs}:${st.size}`
  const now = Date.now()
  const hit = cache.get(sessionId)
  if (hit && (hit.key === key || (maxAgeMs > 0 && now - hit.time < maxAgeMs))) {
    return { file, events: hit.events }
  }
  const text = decompress(file)
  if (text == null) return null
  const events: TEvent[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { events.push(JSON.parse(t) as TEvent) } catch { /* skip corrupt line */ }
  }
  cache.set(sessionId, { key, events, time: now })
  while (cache.size > 3) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return { file, events }
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? '' } catch { return '' }
}

function collectStrings(v: any, out: string[], cap: number): void {
  if (out.join('').length >= cap) return
  if (typeof v === 'string') { out.push(v); return }
  if (Array.isArray(v)) { for (const it of v) collectStrings(it, out, cap); return }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) {
      if (k === 'thinking' || k === 'reasoning') continue
      collectStrings(v[k], out, cap)
    }
  }
}

export function eventText(ev: TEvent, cap = 4000): string {
  const msg = ev?.data?.message
  if (msg && typeof msg === 'object') {
    const parts: string[] = []
    const c = (msg as any).content
    if (typeof c === 'string') parts.push(c)
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (b && typeof b === 'object' && b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
      }
    }
    if (parts.length) return parts.join('\n').slice(0, cap)
  }
  if (ev.type === 'tool/call') {
    const name = ev?.data?.name ?? ''
    const args = safeJson(ev?.data?.arguments ?? ev?.data?.args ?? {})
    return `${name} ${args}`.slice(0, cap)
  }
  const out: string[] = []
  collectStrings(ev.data ?? {}, out, cap)
  return out.join(' ').slice(0, cap)
}

export function searchEvents(events: TEvent[], query: string, opts: { limit: number; types?: string[] }): Hit[] {
  const q = query.toLowerCase()
  const typeFilter = opts.types && opts.types.length ? new Set(opts.types) : null
  const hits: Hit[] = []
  for (const ev of events) {
    if (typeFilter) { if (!typeFilter.has(ev.type)) continue }
    else if (!MEANINGFUL.has(ev.type)) continue
    const text = eventText(ev)
    if (!text) continue
    const idx = text.toLowerCase().indexOf(q)
    if (idx < 0) continue
    const start = Math.max(0, idx - 100)
    const snippet = (start > 0 ? '…' : '') + text.slice(start, idx + q.length + 200).replace(/\s+/g, ' ') + '…'
    hits.push({ seq: ev.seq, type: ev.type, time: ev.time, snippet })
    if (hits.length >= opts.limit) break
  }
  return hits
}

function fmtTime(t?: number): string {
  if (typeof t !== 'number') return ''
  try { return new Date(t).toISOString() } catch { return '' }
}

export function formatHit(h: Hit): string {
  return `[seq ${h.seq ?? '-'} | ${h.type} | ${fmtTime(h.time)}] ${h.snippet}`
}

function renderOne(ev: TEvent, bodyCap: number): string {
  const role = ev?.data?.message?.role
  const header = `[seq ${ev.seq ?? '-'} | ${ev.type}${role ? ' | ' + role : ''} | ${fmtTime(ev.time)}]`
  const body = eventText(ev, bodyCap).replace(/\n{3,}/g, '\n\n')
  return `${header}\n${body}`
}

export function renderEventRange(events: TEvent[], from?: number, to?: number, limit = 20, bodyCap = 1200): string {
  let sel = events.filter(ev => typeof ev.seq === 'number' && !ev.type.includes('chunk'))
  if (from != null) sel = sel.filter(ev => (ev.seq as number) >= from)
  if (to != null) sel = sel.filter(ev => (ev.seq as number) <= to)
  const total = sel.length
  if (sel.length > limit) sel = sel.slice(sel.length - limit)
  const head = total > sel.length ? `（范围内共 ${total} 条，显示最后 ${sel.length} 条）\n` : ''
  return head + sel.map(ev => renderOne(ev, bodyCap)).join('\n---\n')
}

/** 从转录事件派生预算摘要（durable 真相源，自包含，不依赖 cordis 事件监听）。
 *  取最新 request/context 的 contextWindow、compaction/end 计数、最新 usage 的 totalTokens。 */
export function summarizeBudget(events: TEvent[]): BudgetSummary {
  let contextWindow: number | undefined
  let compactions = 0
  let lastUsageTotal: number | undefined
  for (const ev of events) {
    const t = ev.type
    if (t === 'request/context') {
      const cw = ev?.data?.contextWindow ?? ev?.data?.context?.contextWindow
      if (typeof cw === 'number' && cw > 0) contextWindow = cw
    } else if (t === 'compaction/end') {
      compactions += 1
    } else if (t === 'assistant/message') {
      const u = ev?.data?.usage
      if (u && typeof u.totalTokens === 'number') lastUsageTotal = u.totalTokens
      else if (u && typeof u.inputTokens === 'number') lastUsageTotal = u.inputTokens + (u.outputTokens ?? 0)
    } else if (t === 'assistant/chunk') {
      const c = ev?.chunk ?? ev?.data?.chunk
      if (c?.type === 'usage' && c.usage && typeof c.usage.totalTokens === 'number') lastUsageTotal = c.usage.totalTokens
    }
  }
  return { contextWindow, compactions, lastUsageTotal }
}
