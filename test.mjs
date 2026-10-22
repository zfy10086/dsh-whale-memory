/**
 * dsh-whale-memory — 本地冒烟测试（不依赖 DSH 运行时）。
 *
 * 覆盖：状态文件、默认开/关判定（安装前/安装后的会话）、meow-memory 门控写入、
 * 切换开关、关闭前 flush 失败则拒绝关闭。
 *
 * 运行：
 *   node test.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'

const home = mkdtempSync(join(tmpdir(), 'dsh-whale-memory-test-'))
process.env.DSH_HOME = home

const mod = await import('./lib/index.js')
const { __internals: I } = mod

function makeSession(sessionId, cwd, createdAt) {
  const workspaceDir = `--${cwd.replace(/[:\\/]/g, '-')}--`
  const dir = join(home, 'sessions', workspaceDir, sessionId)
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    type: 'session',
    version: 4,
    id: sessionId,
    createdAt,
    cwd,
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
  })
  const frame = zstdCompressSync(Buffer.from(header + '\n', 'utf8'))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), frame)
}

function makeWorkspaceDb(cwd) {
  mkdirSync(join(cwd, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(cwd, '.dsh-meow', 'memory.db'))
  db.exec(`CREATE TABLE IF NOT EXISTS dream_skip (
    session_id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    skip_dream INTEGER NOT NULL DEFAULT 0,
    skip_inject INTEGER NOT NULL DEFAULT 0,
    skip_write INTEGER NOT NULL DEFAULT 0
  )`)
  db.close()
}

const deps = {
  config: { defaultOn: false, autoSummarize: true, intervalHours: 3, backupDir: '' },
  resolveMeta: I.readSessionMeta,
  flush: () => ({ ok: true, pending: 0 }),
}

try {
  // 初始状态：第一次读会记下安装时刻
  const state0 = I.readState()
  assert.equal(state0.version, 1)
  const installedAt = I.installedAtOf(I.readState())
  assert.equal(typeof installedAt, 'number')

  const workspace = join(home, 'ws')
  makeWorkspaceDb(workspace)
  const oldSession = 'session-old'
  const newSession = 'session-new'
  makeSession(oldSession, workspace, installedAt - 60_000)
  makeSession(newSession, workspace, installedAt + 60_000)

  // 安装前就有的会话 → 默认开，且不碰门控
  const old = I.ensureSession(deps, oldSession)
  assert.equal(old.record.on, true, 'old session defaults on')
  assert.deepEqual(I.readSessionGate(workspace, oldSession), { dream: false, inject: false, write: false }, 'old session gate untouched')
  {
    const db = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
    const row = db.prepare('SELECT COUNT(*) AS n FROM dream_skip WHERE session_id = ?').get(oldSession)
    db.close()
    assert.equal(row.n, 0, 'old session must not create a dream_skip row')
  }

  // 安装后新开的会话 → 默认关，写入 skip_inject/skip_write
  const fresh = I.ensureSession(deps, newSession)
  assert.equal(fresh.record.on, false, 'new session defaults off')
  let gate = I.readSessionGate(workspace, newSession)
  assert.deepEqual(gate, { dream: false, inject: true, write: true }, 'new session gate is off')

  // 打开：门控清回 0
  const turnedOn = I.setSessionOn(deps, newSession, true)
  assert.equal(turnedOn.ok, true)
  assert.equal(turnedOn.state.on, true)
  gate = I.readSessionGate(workspace, newSession)
  assert.deepEqual(gate, { dream: false, inject: false, write: false }, 'on clears gates')
  assert.equal(I.readState().sessions[newSession].on, true, 'state persisted on')

  // 关闭：flush 成功后才落状态
  const turnedOff = I.setSessionOn(deps, newSession, false)
  assert.equal(turnedOff.ok, true)
  assert.equal(turnedOff.state.on, false)
  gate = I.readSessionGate(workspace, newSession)
  assert.deepEqual(gate, { dream: false, inject: true, write: true }, 'off sets gates')

  // 关闭时 flush 失败 → 拒绝关闭，保持开着
  I.setSessionOn(deps, newSession, true)
  const blocked = I.setSessionOn({
    ...deps,
    flush: () => ({ ok: false, error: 'backup-unreachable' }),
  }, newSession, false)
  assert.equal(blocked.ok, false)
  assert.equal(blocked.blocked, true)
  assert.equal(I.readState().sessions[newSession].on, true, 'refuse to turn off when flush fails')
  gate = I.readSessionGate(workspace, newSession)
  assert.deepEqual(gate, { dream: false, inject: false, write: false }, 'gates stay on when flush fails')

  // 退出还原 / 启动对账：off 门控可被清掉，启动后又按状态补回
  const gateSession = 'session-gate'
  makeSession(gateSession, workspace, installedAt + 30_000)
  I.ensureSession(deps, gateSession)
  assert.deepEqual(I.readSessionGate(workspace, gateSession), { dream: false, inject: true, write: true }, 'fresh off session gate')
  I.clearGates(I.readSessionMeta)
  assert.deepEqual(I.readSessionGate(workspace, gateSession), { dream: false, inject: false, write: false }, 'dispose clears our gates')
  assert.equal(I.readState().sessions[gateSession].gate, 'cleared')
  I.reconcileGates(I.readSessionMeta)
  assert.deepEqual(I.readSessionGate(workspace, gateSession), { dream: false, inject: true, write: true }, 'startup reconcile re-applies off gate')
  assert.equal(I.readState().sessions[gateSession].gate, 'off')

  // 未知会话：先补默认（安装后 → 关），再切换
  const unknown = 'session-unknown'
  makeSession(unknown, workspace, installedAt + 90_000)
  const boot = I.ensureSession(deps, unknown)
  assert.equal(boot.record.on, false)
  const flipped = I.setSessionOn(deps, unknown, true)
  assert.equal(flipped.ok, true)
  assert.equal(flipped.state.on, true)

  // 状态文件是原子写且可重新读
  const reread = I.readState()
  assert.equal(reread.sessions[newSession].on, true)
  assert.equal(reread.sessions[unknown].on, true)

  console.log('✅ dsh-whale-memory smoke tests passed')
} finally {
  try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
}
