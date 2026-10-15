/**
 * 换窗标志文件 IPC：root 实例（new_window 工具）写标志，preset realm 实例
 * （realmRollover: true）在 agent/pre-step 消费——跨 cordis isolate 边界的唯一可靠通道。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const FLAG_DIR = path.join(os.homedir(), '.dsh', 'context-budget', 'rollover')
const safe = (id: string): string => String(id).replace(/[^A-Za-z0-9_.-]/g, '_')
const flagPath = (sessionId: string): string => path.join(FLAG_DIR, safe(sessionId) + '.json')

export function writeRolloverFlag(sessionId: string): string {
  fs.mkdirSync(FLAG_DIR, { recursive: true })
  fs.writeFileSync(flagPath(sessionId), JSON.stringify({ ts: Date.now() }), 'utf8')
  return flagPath(sessionId)
}

export function readRolloverFlag(sessionId: string): { ts: number } | null {
  try {
    const v = JSON.parse(fs.readFileSync(flagPath(sessionId), 'utf8'))
    return v && typeof v.ts === 'number' ? v : null
  } catch { return null }
}

export function deleteRolloverFlag(sessionId: string): void {
  try { fs.rmSync(flagPath(sessionId), { force: true }) } catch { /* noop */ }
}
