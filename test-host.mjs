/**
 * dsh-whale-memory — 宿主接线测试（假 ctx 跑 apply + HTTP 路由）。
 *
 * 运行：node test-host.mjs
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const home = mkdtempSync(join(tmpdir(), 'dsh-whale-memory-host-'))
process.env.DSH_HOME = home

const { apply } = await import('./lib/index.js')

const workspace = join(home, 'ws')
mkdirSync(join(workspace, '.dsh-meow'), { recursive: true })
const local = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
local.exec(`CREATE TABLE soul (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER)`)
local.exec(`CREATE TABLE fact (id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL, importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'active', source_session TEXT, hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_accessed_at INTEGER, project TEXT)`)
local.prepare("INSERT INTO soul (id, content, created_at, updated_at) VALUES ('s1','本地灵魂',100,200)").run()
local.close()

const sessionId = 'session-test-host'
const sessionDir = join(home, 'sessions', '--ws--', sessionId)
mkdirSync(sessionDir, { recursive: true })
const { zstdCompressSync } = await import('node:zlib')
const { writeFileSync } = await import('node:fs')
writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(JSON.stringify({
  type: 'session', version: 4, id: sessionId, createdAt: Date.now() + 60_000, cwd: workspace,
}) + '\n', 'utf8')))

const backupDir = join(home, 'backup')
mkdirSync(backupDir, { recursive: true })
writeFileSync(join(backupDir, 'memory.jsonl'), JSON.stringify({
  level: 'fact', id: 'b1', title: null, content: '备份里的事', importance: 1,
  keywords: '[]', status: 'active', created_at: 100, updated_at: 100,
}) + '\n', 'utf8')

const routes = new Map()
const listeners = new Map()
const ctx = {
  logger: { info() {}, warn() {} },
  on(event, fn) { listeners.set(event, fn); return () => {} },
  webServer: {
    register(route) { routes.set(route.path, route); return () => {} },
    registerWebSocket() {},
  },
}

await apply(ctx, { defaultOn: false, autoSummarize: true, intervalHours: 3, backupDir, summaryOnlyProjects: [] })
assert.ok(routes.has('/whale-memory/api/state'))
assert.ok(routes.has('/whale-memory/api/toggle'))
assert.ok(routes.has('/whale-memory/api/ensure'))
assert.ok(routes.has('/whale-memory/api/health'))

function request(route, { method = 'GET', url = route.path, body } = {}) {
  return new Promise((resolve) => {
    const req = {
      method,
      url,
      headers: { host: '127.0.0.1:19387', 'content-type': 'application/json' },
      socket: { remoteAddress: '127.0.0.1' },
      on(event, cb) {
        if (event === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
        return this
      },
      destroy() {},
    }
    let status = 0
    let text = ''
    const res = {
      writeHead(code) { status = code },
      end(chunk) { if (chunk !== undefined) text += chunk; resolve({ status, body: text === '' ? null : JSON.parse(text) }) },
    }
    route.handler(req, res)
  })
}

// 未见过的新会话：known=false；ensure 之后默认关
let r = await request(routes.get('/whale-memory/api/state'), { url: `/whale-memory/api/state?sessionId=${sessionId}` })
assert.equal(r.status, 200)
assert.equal(r.body.known, false)

r = await request(routes.get('/whale-memory/api/ensure'), { method: 'POST', body: { sessionId } })
assert.equal(r.status, 200)
assert.equal(r.body.on, false, '安装后新开的会话默认关')

// 打开：先导入备份，再开；门控清掉
r = await request(routes.get('/whale-memory/api/toggle'), { method: 'POST', body: { sessionId, on: true } })
assert.equal(r.status, 200, JSON.stringify(r.body))
assert.equal(r.body.on, true)
const afterPull = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
assert.ok(afterPull.prepare("SELECT id FROM fact WHERE id = 'b1'").get(), '备份条目进了本工作区')
afterPull.close()
assert.ok(readFileSync(join(backupDir, 'memory.jsonl'), 'utf8').includes('"id":"s1"'), '本地条目推回备份')

// 关闭：flush 成功 → off；门控写回
r = await request(routes.get('/whale-memory/api/toggle'), { method: 'POST', body: { sessionId, on: false } })
assert.equal(r.status, 200, JSON.stringify(r.body))
assert.equal(r.body.on, false)
const gated = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
const gate = gated.prepare('SELECT skip_inject, skip_write FROM dream_skip WHERE session_id = ?').get(sessionId)
gated.close()
assert.equal(gate.skip_inject, 1)
assert.equal(gate.skip_write, 1)

// 非 loopback 拒绝
const req = {
  method: 'GET', url: `/whale-memory/api/state?sessionId=${sessionId}`,
  headers: { host: 'evil.example:19387' }, socket: { remoteAddress: '10.0.0.1' }, on() { return this }, destroy() {},
}
const res = { writeHead(code) { this.status = code }, end() { this.done = true } }
routes.get('/whale-memory/api/state').handler(req, res)
assert.equal(res.status, 403)

// 设置页：读默认值、写覆盖值、持久化
r = await request(routes.get('/whale-memory/api/settings'), {})
assert.equal(r.status, 200)
assert.equal(r.body.config.intervalHours, 3)
assert.equal(r.body.config.defaultOn, false)
r = await request(routes.get('/whale-memory/api/settings'), { method: 'POST', body: { intervalHours: 4, defaultOn: true } })
assert.equal(r.status, 200)
assert.equal(r.body.config.intervalHours, 4)
assert.equal(r.body.config.defaultOn, true)
r = await request(routes.get('/whale-memory/api/settings'), {})
assert.equal(r.body.config.intervalHours, 4, '设置已持久化')

console.log('✅ dsh-whale-memory host wiring tests passed')
try { rmSync(home, { recursive: true, force: true }) } catch { /* ignore */ }
