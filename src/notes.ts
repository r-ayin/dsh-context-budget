/**
 * 会话级检查点笔记（对标 Codex notes:* 工具，全本地）。
 * 每会话一个 JSONL：~/.dsh/context-budget/notes/<sessionId>.jsonl
 * 跨压缩存活：压缩只 shadow surface，本文件独立于转录，永远可读写。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface NoteEntry {
  ts: number
  tag?: string
  source: string   // 'model' | 'auto'
  text: string
  compactions?: number
}

let NOTES_DIR = path.join(os.homedir(), '.dsh', 'context-budget', 'notes')

export function setNotesDir(dir: string): void {
  if (dir && dir.trim()) NOTES_DIR = dir.trim()
}

export function notesFile(sessionId: string): string {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(NOTES_DIR, `${safe}.jsonl`)
}

export function appendNote(sessionId: string, entry: Omit<NoteEntry, 'ts'>): string {
  const file = notesFile(sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const line = JSON.stringify({ ts: Date.now(), ...entry }) + '\n'
  fs.appendFileSync(file, line, 'utf8')
  return file
}

export function readNotes(sessionId: string, limit = 20): NoteEntry[] {
  const file = notesFile(sessionId)
  let text: string
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out: NoteEntry[] = []
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t) as NoteEntry) } catch { /* skip */ }
  }
  return out.slice(-limit)
}

export function formatNotes(sessionId: string, entries: NoteEntry[]): string {
  if (!entries.length) return `（暂无检查点笔记：${notesFile(sessionId)}）`
  const head = `检查点笔记（最近 ${entries.length} 条，${notesFile(sessionId)}）：`
  const body = entries.map((n, i) => {
    const t = new Date(n.ts).toISOString()
    return `#${i + 1} [${t}] (${n.source}${n.tag ? '/' + n.tag : ''}) ${n.text}`
  }).join('\n')
  return `${head}\n${body}`
}
