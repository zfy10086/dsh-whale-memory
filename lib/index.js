/**
 * dsh-whale-memory — Host half.
 *
 * 会话标题栏的「鲸鲸记忆」开关（客户端在 lib/client.js）。
 *
 * 语义（用户 2026-10-21 拍板）：
 *  - 开：本会话导入「鲸鲸记忆备份」并参与备份维护（M2 起实现）；带鲸鲸记忆说话。
 *  - 关：不读鲸鲸记忆、也不往回写，退成纯干活助手；关闭前先把待回写的写完（M2 起）。
 *  - 新开的会话默认关；本插件安装之前就存在的会话默认开（保持原样）。
 *  - 每 3 小时定时归纳默认开，但只在开关打开的会话里跑（M3 起）。
 *
 * 这一版（M1）先落地：会话状态持久化、meow-memory 会话门控、客户端路由。
 * 机制：开关状态存在自己的 state.json；"关"写 meow-memory 的 dream_skip
 * （skip_inject=1 / skip_write=1），"开"把它清回 0。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { zstdDecompressSync } from 'node:zlib'
import { flushWorkspace, syncWorkspace, sharedBackupDir, resolveBackupTarget, findLegacyBackups } from './sync.js'

// ────────────────────────────────────────────────────────────────────────────
// 常量与配置
// ────────────────────────────────────────────────────────────────────────────

const DSH_HOME = process.env.DSH_HOME && process.env.DSH_HOME.length > 0 ? process.env.DSH_HOME : join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'whale-memory')
const STATE_FILE = join(STATE_DIR, 'state.json')
const SETTINGS_FILE = join(STATE_DIR, 'settings.json')
const API = '/whale-memory/api'
const VERSION = '0.3.1'

// schemastery 由 DSH 宿主提供（peer）。动态 import + 兜底：副本丢了也照样启动，
// 只是设置页里没有这张卡片。
let z = null
try {
  const schemastery = await import('@deepseek-ai/schemastery')
  z = schemastery.default ?? schemastery
} catch {
  z = null
}

const LIVE_CAPABLE = z !== null && typeof z.boolean === 'function' && typeof z.boolean().volatile === 'function'
function live(schema) {
  return LIVE_CAPABLE ? schema.volatile() : schema
}

export const Config = z === null ? undefined : z.object({
  /** 设置页里的默认值：新会话默认关（用户拍板）。 */
  defaultOn: live(z.boolean().default(false).description('新会话默认是否打开（关 = 纯干活；插件安装前已有的会话不受影响）')),
  /** 每 3 小时定时归纳默认开（只对开着的会话）。 */
  autoSummarize: live(z.boolean().default(true).description('每 N 小时自动归纳一次（只在开着「鲸鲸记忆」的会话里跑）')),
  /** 归纳间隔（小时），用户要求可在设置里改。 */
  intervalHours: live(z.number().default(3).description('定时归纳间隔（小时），默认 3')),
  /** 备份文件夹；留空 = 工作区下的「鲸鲸记忆备份」，没有就用共享位置。 */
  backupDir: live(z.string().default('').description('「鲸鲸记忆备份」文件夹路径。留空 = 优先当前工作区下的「鲸鲸记忆备份」，没有就用 ~/.dsh/storages/鲸鲸记忆备份')),
  /** 这些工作项目只同步摘要（project 层 overview），细节留在各自工作区。 */
  summaryOnlyProjects: live(z.array(z.string()).default([]).description('这些工作项目只同步摘要到备份，细节留在各自工作区')),
})

export const name = 'dsh-whale-memory'
export const inject = ['webServer']

const VOLATILE_REF = Symbol.for('cosmokit.volatile.write')
function isLive(value) {
  return typeof value === 'object' && value !== null && VOLATILE_REF in value
}
function readField(config, key) {
  const value = config?.[key]
  return isLive(value) && typeof value.get === 'function' ? value.get() : value
}

function readConfig(config) {
  const pick = (key, fallback) => {
    const value = readField(config, key)
    return value === undefined ? fallback : value
  }
  const interval = Number(pick('intervalHours', 3))
  const restricted = pick('summaryOnlyProjects', [])
  return {
    defaultOn: pick('defaultOn', false) === true,
    autoSummarize: pick('autoSummarize', true) !== false,
    intervalHours: Number.isFinite(interval) && interval > 0 ? interval : 3,
    backupDir: typeof pick('backupDir', '') === 'string' ? pick('backupDir', '').trim() : '',
    projectDir: '.dsh-meow',
    summaryOnlyProjects: Array.isArray(restricted)
      ? restricted.map((s) => String(s).trim()).filter(Boolean)
      : [],
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 运行期设置（设置页写 settings.json，覆盖插件配置默认值）
// ────────────────────────────────────────────────────────────────────────────

export function readSettingsOverrides() {
  try {
    if (!existsSync(SETTINGS_FILE)) return {}
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function writeSettingsOverrides(patch) {
  ensureStateDir()
  const next = { ...readSettingsOverrides() }
  if (typeof patch.backupDir === 'string') next.backupDir = patch.backupDir.trim()
  if (typeof patch.intervalHours === 'number' && Number.isFinite(patch.intervalHours) && patch.intervalHours > 0) {
    next.intervalHours = Math.min(168, Math.max(0.1, patch.intervalHours))
  }
  if (typeof patch.autoSummarize === 'boolean') next.autoSummarize = patch.autoSummarize
  if (typeof patch.defaultOn === 'boolean') next.defaultOn = patch.defaultOn
  const tmp = `${SETTINGS_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  renameSync(tmp, SETTINGS_FILE)
  return next
}

/** 插件配置 + 设置页覆盖值。 */
function effectiveConfig(config) {
  const base = readConfig(config)
  const ov = readSettingsOverrides()
  return {
    ...base,
    // 默认路径：共享位置（设置页会预填这个值；留空也回落到它）
    backupDir: typeof ov.backupDir === 'string' ? ov.backupDir.trim() : (base.backupDir || sharedBackupDir()),
    intervalHours: typeof ov.intervalHours === 'number' && ov.intervalHours > 0 ? ov.intervalHours : base.intervalHours,
    autoSummarize: typeof ov.autoSummarize === 'boolean' ? ov.autoSummarize : base.autoSummarize,
    defaultOn: typeof ov.defaultOn === 'boolean' ? ov.defaultOn : base.defaultOn,
  }
}

function detectionFor(config) {
  const target = resolveBackupTarget(config, null)
  const legacy = target.dir === null ? [] : findLegacyBackups(null, target.dir)
  return {
    status: target.status,
    dir: target.dir ?? target.base ?? null,
    base: target.base ?? null,
    info: target.info ?? null,
    candidates: (target.candidates ?? []).map((candidate) => ({
      dir: candidate.dir,
      entryCount: candidate.entryCount,
      hasReadme: candidate.hasReadme === true,
    })),
    legacy: legacy.map((source) => ({ dir: source.dir, entryCount: source.entryCount })),
  }
}

/** 打开开关时需要告诉用户的那句话（新建/迁移）。 */
function buildNotice(result) {
  if (result === null || typeof result !== 'object') return null
  const dir = result.backupDir
  const migrated = Array.isArray(result.migratedFrom) ? result.migratedFrom.filter((p) => typeof p === 'string') : []
  const merged = Number(result.migratedCount) || 0
  if (result.created === true) {
    return migrated.length > 0
      ? `已新建「鲸鲸记忆备份」：${dir}；并从旧备份合并了 ${merged} 条`
      : `已新建「鲸鲸记忆备份」：${dir}`
  }
  if (migrated.length > 0 && merged > 0) {
    return `已把旧备份合并进：${dir}（+${merged} 条）`
  }
  return null
}

function settingsForClient(config) {
  const cfg = effectiveConfig(config)
  return {
    ok: true,
    config: {
      backupDir: cfg.backupDir,
      intervalHours: cfg.intervalHours,
      autoSummarize: cfg.autoSummarize,
      defaultOn: cfg.defaultOn,
      summaryOnlyProjects: cfg.summaryOnlyProjects,
    },
    defaults: { backupDir: sharedBackupDir(), intervalHours: 3, autoSummarize: true, defaultOn: false },
    paths: {
      shared: sharedBackupDir(),
      stateDir: STATE_DIR,
    },
    detection: detectionFor({ ...cfg, backupDir: cfg.backupDir }),
  }
}


function ensureStateDir() {
  mkdirSync(STATE_DIR, { recursive: true })
}

function emptyState() {
  return { version: 1, installedAt: null, sessions: {} }
}

export function readState() {
  try {
    ensureStateDir()
    if (!existsSync(STATE_FILE)) return emptyState()
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyState()
    if (parsed.sessions === null || typeof parsed.sessions !== 'object') parsed.sessions = {}
    if (typeof parsed.version !== 'number') parsed.version = 1
    return parsed
  } catch {
    return emptyState()
  }
}

export function writeState(state) {
  ensureStateDir()
  const tmp = `${STATE_FILE}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(tmp, STATE_FILE)
}

/** 第一次运行时把「插件安装时刻」记下来：比它早的会话默认开，比它晚的默认关。 */
function installedAtOf(state) {
  if (typeof state.installedAt !== 'number') {
    state.installedAt = Date.now()
    try { writeState(state) } catch { /* ignore */ }
  }
  return state.installedAt
}

function sessionRecord(state, sessionId) {
  const record = state.sessions[sessionId]
  return record !== null && typeof record === 'object' && typeof record.on === 'boolean' ? record : null
}

// ────────────────────────────────────────────────────────────────────────────
// 会话元信息：找不到 cwd 时直接读会话存档的第一帧（session 头里有 cwd/createdAt）
// ────────────────────────────────────────────────────────────────────────────

const sessionMetaCache = new Map()

function sessionFilePath(sessionId) {
  const dirName = sessionId.startsWith('session-') ? sessionId : `session-${sessionId}`
  const root = join(DSH_HOME, 'sessions')
  if (!existsSync(root)) return null
  for (const workspace of readdirSync(root)) {
    const candidate = join(root, workspace, dirName, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话存档是「多个 zstd 帧拼接」：切出第一帧解压，拿到 session 头。 */
function readSessionHeader(file) {
  try {
    const buf = readFileSync(file)
    const start = buf.indexOf(ZSTD_MAGIC)
    if (start < 0) return null
    const next = buf.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length)
    const end = next < 0 ? buf.length : next
    const text = zstdDecompressSync(buf.subarray(start, end)).toString('utf8')
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const event = JSON.parse(line)
        if (event?.type === 'session' && typeof event.cwd === 'string') {
          return { cwd: event.cwd, createdAt: typeof event.createdAt === 'number' ? event.createdAt : null }
        }
      } catch { /* ignore */ }
    }
    return null
  } catch {
    return null
  }
}

export function readSessionMeta(sessionId) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const cached = sessionMetaCache.get(sessionId)
  // 缓存里只有 cwd、没有 createdAt 时不能直接信：回档案头里补一次。
  if (cached !== undefined && typeof cached.createdAt === 'number') return cached
  const file = sessionFilePath(sessionId)
  const meta = file === null ? null : readSessionHeader(file)
  if (meta !== null) {
    sessionMetaCache.set(sessionId, meta)
    return meta
  }
  return cached ?? null
}

// ────────────────────────────────────────────────────────────────────────────
// meow-memory 会话门控（dream_skip）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 给某个会话写「记忆参与」门控。
 * @param {string} cwd 工作区
 * @param {string} sessionId 会话 id
 * @param {boolean} on true=清掉读/写门控；false=停读停写
 * @returns {{ok: boolean, skipped?: string, error?: string}}
 */
export function applySessionGate(cwd, sessionId, on) {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'no-cwd' }
  const dbFile = join(cwd, '.dsh-meow', 'memory.db')
  if (!existsSync(dbFile)) return { ok: true, skipped: 'no-meow-db' }
  let db
  try {
    db = new DatabaseSync(dbFile)
    db.exec(`CREATE TABLE IF NOT EXISTS dream_skip (
      session_id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      skip_dream INTEGER NOT NULL DEFAULT 0,
      skip_inject INTEGER NOT NULL DEFAULT 0,
      skip_write INTEGER NOT NULL DEFAULT 0
    )`)
    if (on) {
      // 只清 inject/write，不碰 dream 档。
      db.prepare('UPDATE dream_skip SET skip_inject = 0, skip_write = 0 WHERE session_id = ?').run(sessionId)
    } else {
      const now = Date.now()
      db.prepare(`INSERT INTO dream_skip (session_id, created_at, skip_dream, skip_inject, skip_write)
        VALUES (?, ?, 0, 1, 1)
        ON CONFLICT(session_id) DO UPDATE SET skip_inject = 1, skip_write = 1`).run(sessionId, now)
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

/** 读一下当前门控，给状态路由显示用。 */
export function readSessionGate(cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dbFile = join(cwd, '.dsh-meow', 'memory.db')
  if (!existsSync(dbFile)) return null
  let db
  try {
    db = new DatabaseSync(dbFile)
    const row = db.prepare('SELECT skip_dream, skip_inject, skip_write FROM dream_skip WHERE session_id = ?').get(sessionId)
    if (row === undefined) return { dream: false, inject: false, write: false }
    return { dream: row.skip_dream === 1, inject: row.skip_inject === 1, write: row.skip_write === 1 }
  } catch {
    return null
  } finally {
    try { db?.close() } catch { /* ignore */ }
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 启动对账 / 退出还原
//
// 门控只是「运行时缓存」：状态文件才是真相。启动时按状态重新写一遍门控；
// 退出时把自己写下的 off 门控清掉——这样即使插件被卸载，meow-memory 也回到
// 原样，不会留下一个"永远不注入"的幽灵门。
// ────────────────────────────────────────────────────────────────────────────

export function reconcileGates(resolveMeta) {
  const state = readState()
  let changed = false
  for (const [sessionId, record] of Object.entries(state.sessions)) {
    if (record === null || typeof record !== 'object') continue
    const meta = resolveMeta(sessionId)
    if (meta === null || typeof meta.cwd !== 'string') continue
    const gate = record.gate === 'off' ? 'off' : (record.gate === 'cleared' ? 'cleared' : null)
    if (record.on === false && gate !== 'off') {
      const applied = applySessionGate(meta.cwd, sessionId, false)
      if (applied.ok === true) { record.gate = 'off'; changed = true }
    } else if (record.on === true && gate === 'off') {
      const applied = applySessionGate(meta.cwd, sessionId, true)
      if (applied.ok === true) { record.gate = 'cleared'; changed = true }
    }
  }
  if (changed) writeState(state)
  return changed
}

export function clearGates(resolveMeta) {
  const state = readState()
  let changed = false
  for (const [sessionId, record] of Object.entries(state.sessions)) {
    if (record === null || typeof record !== 'object' || record.gate !== 'off') continue
    const meta = resolveMeta(sessionId)
    if (meta === null || typeof meta.cwd !== 'string') continue
    const applied = applySessionGate(meta.cwd, sessionId, true)
    if (applied.ok === true) { record.gate = 'cleared'; changed = true }
  }
  if (changed) writeState(state)
}


function stateForClient(state, config, sessionId) {
  const record = sessionRecord(state, sessionId)
  return {
    ok: true,
    version: VERSION,
    sessionId,
    known: record !== null,
    on: record === null ? null : record.on,
    config: {
      defaultOn: config.defaultOn,
      autoSummarize: config.autoSummarize,
      intervalHours: config.intervalHours,
      backupDir: config.backupDir,
    },
    pending: 0,
  }
}

/**
 * 确保会话已有一条状态（新会话按默认值补上）。不会覆盖用户已经设过的值。
 * @param {object} deps { config, resolveMeta }
 * @returns {{ state: object, record: object|null, created: boolean }}
 */
export function ensureSession(deps, sessionId) {
  const state = readState()
  const installedAt = installedAtOf(state)
  const existing = sessionRecord(state, sessionId)
  if (existing !== null) return { state, record: existing, created: false }

  const meta = deps.resolveMeta(sessionId)
  // 插件安装前就存在的会话：保持原来的行为（开）；安装后新开的：默认关。
  // 读不到创建时间时按「老会话」处理——宁可保留记忆，也不偷偷关掉。
  const beforeInstall = typeof meta?.createdAt === 'number' ? meta.createdAt < installedAt : true
  const on = beforeInstall ? true : deps.config.defaultOn
  const record = { on, updatedAt: Date.now(), lastSummaryAt: 0, lastFlushAt: 0, gate: null }
  state.sessions[sessionId] = record
  writeState(state)
  if (on === false && typeof meta?.cwd === 'string') {
    const applied = applySessionGate(meta.cwd, sessionId, false)
    if (applied.ok === true) state.sessions[sessionId].gate = 'off'
    writeState(state)
  }
  return { state, record: state.sessions[sessionId], created: true }
}

/**
 * 切开关。关之前先 flush（M2 之前是空队列，直接成功）。
 * @returns {{ ok: boolean, error?: string, blocked?: boolean, state?: object }}
 */
export function setSessionOn(deps, sessionId, on) {
  let state = readState()
  let record = sessionRecord(state, sessionId)
  if (record === null) {
    // 没记录就先按默认值补一条，再从它开始改
    ensureSession(deps, sessionId)
    state = readState()
    record = sessionRecord(state, sessionId)
    if (record === null) return { ok: false, error: 'state-init-failed' }
  }
  const meta = deps.resolveMeta(sessionId)
  const cwd = typeof meta?.cwd === 'string' ? meta.cwd : null
  const next = state.sessions[sessionId] ?? record
  if (on === false) {
    // 关闭前先把待回写的写完；失败就拒绝关闭，保持开着。
    const flush = deps.flush ? deps.flush(sessionId) : { ok: true, pending: 0 }
    if (flush.ok !== true) return { ok: false, blocked: true, error: flush.error ?? 'flush-failed' }
    next.on = false
    next.updatedAt = Date.now()
    next.lastFlushAt = Date.now()
    writeState(state)
    if (cwd !== null) {
      const applied = applySessionGate(cwd, sessionId, false)
      next.gate = applied.ok === true ? 'off' : null
      writeState(state)
    }
    return { ok: true, state: stateForClient(state, deps.config, sessionId) }
  }
  next.on = true
  next.updatedAt = Date.now()
  writeState(state)
  if (cwd !== null) {
    const applied = applySessionGate(cwd, sessionId, true)
    next.gate = applied.ok === true ? 'cleared' : null
    writeState(state)
  }
  return { ok: true, state: stateForClient(state, deps.config, sessionId) }
}

// ────────────────────────────────────────────────────────────────────────────
// HTTP
// ────────────────────────────────────────────────────────────────────────────

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function isLoopback(req) {
  const host = String(req.headers.host ?? '').toLowerCase()
  if (!host.startsWith('127.0.0.1:') && !host.startsWith('localhost:') && host !== '127.0.0.1' && host !== 'localhost' && !host.startsWith('[::1]:')) return false
  const remote = req.socket?.remoteAddress ?? ''
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body-too-large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { reject(new Error('invalid-json')) }
    })
    req.on('error', reject)
  })
}

function querySessionId(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const id = url.searchParams.get('sessionId')
    return typeof id === 'string' && id.length > 0 ? id : null
  } catch {
    return null
  }
}

// ────────────────────────────────────────────────────────────────────────────
// apply
// ────────────────────────────────────────────────────────────────────────────

export async function apply(ctx, config) {
  const log = (message, ...rest) => {
    try { ctx.logger?.info?.(message, ...rest) } catch { /* ignore */ }
    console.log(`[dsh-whale-memory] ${message}`, ...rest)
  }
  const getConfig = () => effectiveConfig(config)

  // 安装时刻落盘（决定「新会话默认关」的边界）
  try {
    const state = readState()
    installedAtOf(state)
  } catch (error) {
    log(`状态初始化失败（非致命）：${error instanceof Error ? error.message : String(error)}`)
  }

  const deps = {
    get config() { return getConfig() },
    resolveMeta(sessionId) {
      const cached = readSessionMeta(sessionId)
      return cached
    },
    // 关闭开关前：把本地新写的条目推回备份；失败就不许关。
    flush(sessionId) {
      const meta = readSessionMeta(sessionId)
      if (meta === null || typeof meta.cwd !== 'string') return { ok: false, error: 'no-workspace' }
      const result = flushWorkspace(meta.cwd, getConfig())
      if (result.ok !== true) return { ok: false, error: result.error ?? 'flush-failed' }
      return { ok: true, pending: result.pushed ?? 0 }
    },
  }

  // ── 启动对账：按状态文件把门控重新写一遍（覆盖上次异常退出留下的旧门） ──
  try {
    reconcileGates(readSessionMeta)
  } catch (error) {
    log(`启动对账失败（非致命）：${error instanceof Error ? error.message : String(error)}`)
  }

  // ── 会话事件：新会话第一次动起来时补状态（默认关就顺手写门控） ──
  const syncedOnce = new Set()
  const onSessionEvent = (session, event) => {
    const sessionId = session?.id
    if (session?.header?.origin === 'subagent') return
    const cwd = session?.header?.cwd
    if (typeof sessionId !== 'string' || sessionId.length === 0) return
    if (typeof cwd === 'string' && cwd.length > 0) {
      const cached = sessionMetaCache.get(sessionId)
      if (cached === undefined) {
        const createdAt = typeof session?.createdAt === 'number'
          ? session.createdAt
          : (typeof session?.header?.createdAt === 'number' ? session.header.createdAt : undefined)
        if (typeof createdAt === 'number') sessionMetaCache.set(sessionId, { cwd, createdAt })
        // 拿不到 createdAt 就先不缓存：resolveMeta 会去读会话档案头。
      }
    }
    if (event?.type === 'turn/start') {
      try {
        ensureSession(deps, sessionId)
        // 开着的会话：本次运行第一次动起来时把备份导入一遍（只做一次）
        const record = sessionRecord(readState(), sessionId)
        if (record !== null && record.on === true && typeof cwd === 'string' && cwd.length > 0 && !syncedOnce.has(sessionId)) {
          syncedOnce.add(sessionId)
          const timer = setTimeout(() => {
            try {
              const result = syncWorkspace(cwd, getConfig())
              if (result.ok !== true) log(`导入备份失败（${sessionId}）：${result.error ?? 'unknown'}`)
            } catch (error) {
              log(`导入备份异常：${error instanceof Error ? error.message : String(error)}`)
            }
          }, 50)
          timer.unref?.()
        }
      } catch (error) {
        log(`会话 ${sessionId} 补状态失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  const offSessionEvent = typeof ctx.on === 'function' ? ctx.on('session/event', onSessionEvent) : null

  // ── 语境更新：会话写进本地记忆后，稍等片刻把差异推回备份（不额外调模型） ──
  const pushTimers = new Map()
  const schedulePush = (workspace, delayMs = 20000) => {
    if (typeof workspace !== 'string' || workspace.length === 0) return
    const existing = pushTimers.get(workspace)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      pushTimers.delete(workspace)
      try {
        const result = flushWorkspace(workspace, getConfig())
        if (result.ok !== true) log(`回写备份失败（${workspace}）：${result.error ?? 'unknown'}`)
        else if (result.pushed > 0) log(`回写备份：+${result.pushed} 条`)
      } catch (error) {
        log(`回写备份异常：${error instanceof Error ? error.message : String(error)}`)
      }
    }, delayMs)
    timer.unref?.()
    pushTimers.set(workspace, timer)
  }

  const offTurnStopping = typeof ctx.on === 'function'
    ? ctx.on('agent/turn-stopping', ({ agent }) => {
        try {
          const sessionId = agent?.id ?? agent?.session?.header?.id
          const workspace = agent?.session?.header?.cwd
          if (typeof sessionId !== 'string' || typeof workspace !== 'string') return
          const state = readState()
          const record = sessionRecord(state, sessionId)
          if (record === null || record.on !== true) return
          schedulePush(workspace)
        } catch { /* 回调必须极快且不抛错 */ }
      })
    : null

  // ── 客户端路由 ──
  const stateRoute = {
    kind: 'exact',
    path: `${API}/state`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      const sessionId = querySessionId(req)
      if (sessionId === null) return json(res, 400, { ok: false, error: 'sessionId-required' })
      const state = readState()
      return json(res, 200, stateForClient(state, getConfig(), sessionId))
    },
  }

  const ensureRoute = {
    kind: 'exact',
    path: `${API}/ensure`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad-request' })
      }
      const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null
      if (sessionId === null) return json(res, 400, { ok: false, error: 'sessionId-required' })
      try { ensureSession(deps, sessionId) } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return json(res, 200, stateForClient(readState(), getConfig(), sessionId))
    },
  }

  const toggleRoute = {
    kind: 'exact',
    path: `${API}/toggle`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad-request' })
      }
      const sessionId = typeof body?.sessionId === 'string' && body.sessionId.length > 0 ? body.sessionId : null
      if (sessionId === null) return json(res, 400, { ok: false, error: 'sessionId-required' })
      if (typeof body?.on !== 'boolean') return json(res, 400, { ok: false, error: 'on-required' })
      // 打开：先把备份灌进本工作区（导入灵魂），再落开关。
      if (body.on === true) {
        let notice = null
        const meta = readSessionMeta(sessionId)
        if (meta !== null && typeof meta.cwd === 'string') {
          const pull = syncWorkspace(meta.cwd, getConfig())
          if (pull.ok !== true) {
            if (pull.error === 'ambiguous-backup') {
              return json(res, 409, {
                ok: false,
                error: '找到了多个像备份的文件夹，请先在设置里选一个',
                candidates: pull.candidates ?? [],
              })
            }
            if (pull.error === 'no-local-db') {
              return json(res, 409, {
                ok: false,
                error: '这个工作区还没有记忆库：先安装并启用 meow-memory，再打开开关',
              })
            }
            return json(res, 502, { ok: false, error: `导入备份失败：${pull.error ?? 'unknown'}` })
          }
          notice = buildNotice(pull)
        }
        const result = setSessionOn(deps, sessionId, body.on)
        if (result.ok !== true) return json(res, result.blocked === true ? 409 : 500, result)
        return json(res, 200, notice === null ? result.state : { ...result.state, notice })
      }
      const result = setSessionOn(deps, sessionId, body.on)
      if (result.ok !== true) return json(res, result.blocked === true ? 409 : 500, result)
      return json(res, 200, result.state)
    },
  }

  const healthRoute = {
    kind: 'exact',
    path: `${API}/health`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      return json(res, 200, { ok: true, version: VERSION, pid: process.pid })
    },
  }

  const detectRoute = {
    kind: 'exact',
    path: `${API}/detect`,
    handler: (req, res) => {
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      let path = ''
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        path = (url.searchParams.get('path') ?? '').trim()
      } catch { /* ignore */ }
      const cfg = { ...getConfig(), backupDir: path }
      return json(res, 200, { ok: true, detection: detectionFor(cfg) })
    },
  }

  const settingsRoute = {
    kind: 'exact',
    path: `${API}/settings`,
    handler: async (req, res) => {
      if (!isLoopback(req)) return json(res, 403, { ok: false, error: 'forbidden' })
      if (req.method === 'GET') return json(res, 200, settingsForClient(getConfig()))
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method-not-allowed' })
      let body
      try { body = await readJsonBody(req) } catch (error) {
        return json(res, 400, { ok: false, error: error instanceof Error ? error.message : 'bad-request' })
      }
      const patch = {}
      if (typeof body?.backupDir === 'string') patch.backupDir = body.backupDir
      if (typeof body?.intervalHours === 'number') patch.intervalHours = body.intervalHours
      if (typeof body?.autoSummarize === 'boolean') patch.autoSummarize = body.autoSummarize
      if (typeof body?.defaultOn === 'boolean') patch.defaultOn = body.defaultOn
      try {
        writeSettingsOverrides(patch)
      } catch (error) {
        return json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return json(res, 200, settingsForClient(getConfig()))
    },
  }

  const disposers = []
  if (typeof offSessionEvent === 'function') disposers.push(offSessionEvent)
  if (typeof offTurnStopping === 'function') disposers.push(offTurnStopping)
  for (const route of [stateRoute, ensureRoute, toggleRoute, healthRoute, settingsRoute, detectRoute]) {
    try { disposers.push(ctx.webServer.register(route)) } catch (error) {
      log(`路由 ${route.path} 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  log(`已挂载（${VERSION}），状态文件 ${STATE_FILE}`)

  ctx.on?.('dispose', () => {
    for (const timer of pushTimers.values()) {
      try { clearTimeout(timer) } catch { /* ignore */ }
    }
    pushTimers.clear()
    // 退出时把自己写下的 off 门控还原，别给 meow-memory 留幽灵门。
    try { clearGates(readSessionMeta) } catch { /* ignore */ }
    for (const dispose of disposers) {
      try { dispose() } catch { /* ignore */ }
    }
  })
}

// 给 test.mjs 用的内部句柄（不参与运行时）。
export const __internals = {
  DSH_HOME,
  STATE_FILE,
  readState,
  writeState,
  installedAtOf,
  ensureSession,
  setSessionOn,
  applySessionGate,
  readSessionGate,
  reconcileGates,
  clearGates,
  readSessionMeta,
  sessionFilePath,
}
