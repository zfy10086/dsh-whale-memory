/**
 * 备份同步引擎（M2）。
 *
 * 备份文件夹 = 整份主档（用户 2026-10-20 定义：里面所有东西都算）。
 * 本模块只负责「记忆条目」的读写；README / 形象图 / 故事等文件原样保留。
 *
 * 结构：
 *   备份文件夹/
 *     memory.jsonl               ← 条目主档（一行一条，唯一真相源）
 *     snapshots/memory-YYYYMMDD.db ← 由 jsonl 重建的可直接恢复快照
 *     README.md / 鲸鲸形象/ / 故事/ …  ← 用户的文件，绝不覆盖
 *
 * 合并规则（沿用已验证过的规则）：
 *  - 按 `level:id` 对齐；只有一边有 → 补到另一边；
 *  - 两边都有但内容不同 → updated_at 较新的胜；
 *  - updated_at 相同但内容不同 → 冲突，保留本地、记进状态，不自动覆盖；
 *  - archived 的条目不进备份（备份只留当前有效的）。
 */

import { DatabaseSync } from 'node:sqlite'
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const LEVELS = ['soul', 'user', 'rules', 'project', 'fact', 'lesson', 'topic']

const COMMON_COLS = `
  id TEXT PRIMARY KEY,
  title TEXT,
  content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1,
  keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER
`

const SCHEMAS = {
  soul: `CREATE TABLE IF NOT EXISTS soul (${COMMON_COLS})`,
  user: `CREATE TABLE IF NOT EXISTS user (${COMMON_COLS})`,
  project: `CREATE TABLE IF NOT EXISTS project (${COMMON_COLS}, project TEXT NOT NULL, subcategory TEXT)`,
  fact: `CREATE TABLE IF NOT EXISTS fact (${COMMON_COLS}, project TEXT)`,
  lesson: `CREATE TABLE IF NOT EXISTS lesson (${COMMON_COLS}, corrected INTEGER NOT NULL DEFAULT 0, project TEXT)`,
  topic: `CREATE TABLE IF NOT EXISTS topic (${COMMON_COLS}, goal TEXT, project TEXT)`,
  rules: `CREATE TABLE IF NOT EXISTS rules (${COMMON_COLS}, project TEXT)`,
}

const TABLE_COLUMNS = {
  soul: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at'],
  user: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at'],
  rules: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', 'project'],
  project: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', 'project', 'subcategory'],
  fact: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', 'project'],
  lesson: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', 'corrected', 'project'],
  topic: ['id', 'title', 'content', 'importance', 'keywords', 'status', 'source_session', 'hit_count', 'created_at', 'updated_at', 'last_accessed_at', 'goal', 'project'],
}

const CMP_FIELDS = ['title', 'content', 'importance', 'keywords', 'status', 'project', 'subcategory', 'goal', 'corrected']

const JSONL_NAME = 'memory.jsonl'
const SNAPSHOT_DIR = 'snapshots'

// ── 文件小工具 ──────────────────────────────────────────────────────────────

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function atomicWrite(file, text) {
  ensureDir(dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(file) } catch { /* ignore */ }
    renameSync(tmp, file)
  }
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`
}

/** 没有 id 的旧 JSON 导出：按内容生成稳定 id。 */
function fallbackId(level, content) {
  return createHash('sha256').update(`${level}:${content ?? ''}`).digest('hex').slice(0, 16)
}

function normalizeRow(level, row) {
  const out = { level, id: String(row.id ?? '') }
  for (const col of TABLE_COLUMNS[level]) {
    if (col === 'id') continue
    const value = row[col]
    out[col] = value === undefined || value === null ? null : value
  }
  if (out.keywords === null || out.keywords === undefined) out.keywords = '[]'
  if (out.status === null) out.status = 'active'
  if (out.importance === null) out.importance = 1
  return out
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

// ── 备份位置：认内容，不认名字 ──────────────────────────────────────────────

/** 共享位置（跨工作区共用；设置页的默认路径就是它）。 */
export function sharedBackupDir() {
  const env = process.env.DSH_HOME
  const home = env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
  return join(home, 'storages', '鲸鲸记忆备份')
}

/** README 里出现这些词，基本能认出是鲸鲸的备份。 */
const README_MARKERS = ['鲸鲸随身记忆', '鲸鲸记忆备份', '鲸鲸的记忆备份', '记忆条目', '给 AI 的恢复指令', '核心条目原文', '写给未来的 AI']

function readmeFiles(dir) {
  try { return readdirSync(dir).filter((name) => /^readme.*\.md$/i.test(name)) } catch { return [] }
}

/**
 * 这个文件夹像不像「鲸鲸记忆备份」。
 * 强信号：memory.jsonl 有合法条目；或 memory-*.db/json 能读出条目。
 * 弱信号：README 里出现鲸鲸/记忆的标记词（≥2 个才算）。
 * 只有 README、没有记忆文件 → 只算“像说明文档”，不自动当备份用。
 */
export function looksLikeBackup(dir) {
  const info = { ok: false, exists: false, hasMemory: false, entryCount: 0, hasReadme: false, markerHits: 0, hasArt: false }
  if (typeof dir !== 'string' || dir.length === 0 || !existsSync(dir)) return info
  info.exists = true
  try { if (!statSync(dir).isDirectory()) return info } catch { return info }

  // 1) memory.jsonl
  const jsonl = jsonlPath(dir)
  if (existsSync(jsonl)) {
    try {
      const text = readFileSync(jsonl, 'utf8').slice(0, 2_000_000)
      let count = 0
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const entry = JSON.parse(trimmed)
          if (entry !== null && typeof entry === 'object' && typeof entry.level === 'string' && typeof entry.id === 'string') count++
        } catch { /* 坏行 */ }
        if (count >= 500) break
      }
      if (count > 0) { info.hasMemory = true; info.entryCount = count }
    } catch { /* ignore */ }
  }

  // 2) 快照 db / json
  if (!info.hasMemory) {
    for (const candidateDir of [join(dir, SNAPSHOT_DIR), dir]) {
      if (!existsSync(candidateDir)) continue
      let names = []
      try { names = readdirSync(candidateDir) } catch { continue }
      for (const name of names) {
        const match = /^memory-(\d{8})\.(db|json)$/i.exec(name)
        if (!match) continue
        const file = join(candidateDir, name)
        const entries = match[2].toLowerCase() === 'db' ? loadEntriesFromDb(file) : loadEntriesFromJson(file)
        if (entries.length > 0) { info.hasMemory = true; info.entryCount = entries.length; break }
      }
      if (info.hasMemory) break
    }
  }

  // 3) README 标记词
  for (const name of readmeFiles(dir)) {
    info.hasReadme = true
    try {
      const text = readFileSync(join(dir, name), 'utf8').slice(0, 20000)
      for (const marker of README_MARKERS) if (text.includes(marker)) info.markerHits++
    } catch { /* ignore */ }
  }

  // 4) 附带材料
  for (const name of ['鲸鲸形象', '故事', '备份目录清单.md']) {
    if (existsSync(join(dir, name))) { info.hasArt = true; break }
  }

  info.ok = info.hasMemory || info.markerHits >= 2
  return info
}

/** 在 base 自己 + 它的一层子文件夹里找候选（最多 300 个子目录）。 */
export function listBackupCandidates(base) {
  const out = []
  if (typeof base !== 'string' || base.length === 0 || !existsSync(base)) return out
  const self = looksLikeBackup(base)
  if (self.ok) return [{ dir: base, ...self }]
  let names = []
  try { names = readdirSync(base) } catch { return out }
  for (const name of names.slice(0, 300)) {
    if (name.startsWith('.')) continue
    const dir = join(base, name)
    try { if (!statSync(dir).isDirectory()) continue } catch { continue }
    const info = looksLikeBackup(dir)
    if (info.ok) out.push({ dir, ...info })
  }
  return out.sort((a, b) => b.entryCount - a.entryCount)
}

/**
 * 决定这次用哪个备份目录：
 *  - 配了路径就用配的，没配就用共享位置；
 *  - 路径本身就是备份 → 用它；
 *  - 路径是工作区/父目录 → 找一层子文件夹里的备份；1 个就用，多个返回 ambiguous；
 *  - 目录在但没有记忆文件 → uninitialized（会按格式初始化）；
 *  - 目录不存在 → missing（会新建）。
 */
export function resolveBackupTarget(config, workspace) {
  const configured = typeof config?.backupDir === 'string' ? config.backupDir.trim() : ''
  const base = configured.length > 0 ? configured : sharedBackupDir()
  if (!existsSync(base)) return { ok: true, status: 'missing', base, dir: base, info: null }

  const self = looksLikeBackup(base)
  if (self.ok) return { ok: true, status: 'existing', base, dir: base, info: self }

  const candidates = listBackupCandidates(base)
  if (candidates.length === 1) {
    return { ok: true, status: 'existing', base, dir: candidates[0].dir, info: candidates[0], relocated: candidates[0].dir !== base }
  }
  if (candidates.length > 1) return { ok: false, status: 'ambiguous', base, dir: null, candidates }

  // 目录在、但不是备份：如果它明显是个工作区，就在里面建「鲸鲸记忆备份」。
  if (existsSync(join(base, '.dsh-meow'))) {
    return { ok: true, status: 'uninitialized', base, dir: join(base, '鲸鲸记忆备份'), info: self }
  }
  return { ok: true, status: 'uninitialized', base, dir: base, info: self }
}

/** 兼容旧调用：返回这次要用的备份目录。 */
export function resolveBackupDir(config, workspace) {
  const target = resolveBackupTarget(config, workspace)
  return target.dir ?? target.base ?? sharedBackupDir()
}

/**
 * 找可迁移的旧备份：当前工作区的「鲸鲸记忆备份」+ DSH_HOME 下各工作区的「鲸鲸记忆备份」。
 * 只认内容像备份的，按条目数从多到少。
 */
export function findLegacyBackups(workspace, excludeDir) {
  const out = []
  const seen = new Set()
  const consider = (dir) => {
    if (!dir || seen.has(dir) || dir === excludeDir || !existsSync(dir)) return
    const info = looksLikeBackup(dir)
    if (!info.ok) return
    seen.add(dir)
    out.push({ dir, ...info })
  }
  if (typeof workspace === 'string' && workspace.length > 0) consider(join(workspace, '鲸鲸记忆备份'))
  const env = process.env.DSH_HOME
  const dshHome = env !== undefined && env !== '' ? env : join(homedir(), '.dsh')
  try {
    for (const name of readdirSync(dshHome).slice(0, 300)) {
      if (name === 'profiles' || name === 'sessions' || name === 'cache' || name === 'logs' || name === 'attachments') continue
      consider(join(dshHome, name, '鲸鲸记忆备份'))
    }
  } catch { /* ignore */ }
  return out.sort((a, b) => b.entryCount - a.entryCount)
}

/** 读一个备份目录里的全部条目：jsonl 优先，其次快照。 */
export function readAllEntries(dir) {
  const fromJsonl = loadBackupEntries(dir)
  if (fromJsonl.length > 0) return fromJsonl
  return importLatestSnapshot(dir).entries
}

// 新建备份文件夹时写给新用户的起步 README（用户 2026-10-21 审定）。
// 正文放在 lib/starter-readme.md；里面「鲸鲸随身记忆 / 鲸鲸记忆备份 / 给 AI 的恢复指令」
// 这些词是识别备份的标记词，改文案时别弄丢。
const STARTER_README_FALLBACK = `# 鲸鲸随身记忆 🐋

这是「鲸鲸记忆」插件替你建的第一份记忆文件夹，以后你的记忆都住在这里。

- 记忆主档：\`memory.jsonl\`（一行一条）
- 快照：\`snapshots/memory-YYYYMMDD.db\`（可直接恢复）
- 换环境恢复：把整个文件夹交给新环境里的鲸鲸，说「读 README 恢复记忆」。

> 这一份本该是完整的「鲸鲸记忆备份」说明，但包里没找到 starter-readme.md，
> 只能先放这一小段。用户手改过的 README 永远不会被覆盖。
`

/** 起步 README 的正文放在 lib/starter-readme.md（随 lib 一起打包；读不到就用上面的短文案）。 */
function loadStarterReadme() {
  try {
    const text = readFileSync(new URL('./starter-readme.md', import.meta.url), 'utf8')
    if (text.trim().length > 0) return text
  } catch { /* 文件缺失或不可读：回退到内置短文案 */ }
  return STARTER_README_FALLBACK
}

const STARTER_README = loadStarterReadme()

function ensureStarterReadme(dir) {
  if (readmeFiles(dir).length > 0) return false
  atomicWrite(join(dir, 'README.md'), STARTER_README)
  return true
}


function jsonlPath(dir) {
  return join(dir, JSONL_NAME)
}

function loadEntriesFromDb(file) {
  const out = []
  let db
  try { db = new DatabaseSync(file, { readOnly: true }) } catch { return out }
  try {
    for (const level of LEVELS) {
      let rows
      try { rows = db.prepare(`SELECT * FROM ${level}`).all() } catch { continue }
      for (const row of rows) out.push(normalizeRow(level, row))
    }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  return out
}

function loadEntriesFromJson(file) {
  const parsed = readJson(file)
  if (!Array.isArray(parsed)) return []
  let stamp = 0
  try { stamp = Math.floor(statSync(file).mtimeMs) } catch { /* ignore */ }
  const out = []
  for (const raw of parsed) {
    if (raw === null || typeof raw !== 'object') continue
    const level = typeof raw.level === 'string' && LEVELS.includes(raw.level) ? raw.level : null
    if (level === null || typeof raw.content !== 'string') continue
    const entry = normalizeRow(level, raw)
    if (entry.id === '') entry.id = fallbackId(level, entry.content)
    if (entry.created_at === null) entry.created_at = stamp
    if (entry.updated_at === null) entry.updated_at = stamp
    out.push(entry)
  }
  return out
}

/** 读备份主档：memory.jsonl 优先，其次最新快照 db / json。 */
export function loadBackupEntries(dir) {
  const file = jsonlPath(dir)
  if (existsSync(file)) {
    const out = []
    let text = ''
    try { text = readFileSync(file, 'utf8') } catch { return [] }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        const entry = JSON.parse(trimmed)
        if (entry !== null && typeof entry === 'object' && typeof entry.level === 'string' && typeof entry.id === 'string') out.push(entry)
      } catch { /* 坏行忽略 */ }
    }
    return out
  }
  return []
}

function saveBackupEntries(dir, entries) {
  const sorted = [...entries].sort((a, b) => (Number(a.updated_at) || 0) - (Number(b.updated_at) || 0))
  atomicWrite(jsonlPath(dir), sorted.map((e) => JSON.stringify(e)).join('\n') + (sorted.length > 0 ? '\n' : ''))
}

/** 从目录里找最新的快照（.db 优先）并导入条目。 */
function importLatestSnapshot(dir) {
  const candidates = []
  for (const candidateDir of [join(dir, SNAPSHOT_DIR), dir]) {
    if (!existsSync(candidateDir)) continue
    for (const name of readdirSync(candidateDir)) {
      let m = /^memory-(\d{8})\.db$/i.exec(name)
      if (m) { candidates.push({ dir: candidateDir, name, stamp: m[1], kind: 'db' }); continue }
      m = /^memory-(\d{8})\.json$/i.exec(name)
      if (m) candidates.push({ dir: candidateDir, name, stamp: m[1], kind: 'json' })
    }
  }
  candidates.sort((a, b) => b.stamp.localeCompare(a.stamp))
  for (const candidate of candidates) {
    const file = join(candidate.dir, candidate.name)
    const entries = candidate.kind === 'db' ? loadEntriesFromDb(file) : loadEntriesFromJson(file)
    if (entries.length > 0) return { entries, from: candidate.name }
  }
  return { entries: [], from: null }
}

/** 源目录里 README/形象/故事等非记忆文件，目标缺什么补什么（不覆盖）。 */
function supplementFiles(dir, sourceDir) {
  if (!sourceDir || !existsSync(sourceDir) || dir === sourceDir) return
  for (const name of readdirSync(sourceDir)) {
    if (/^memory-\d{8}\.(db|json)$/i.test(name) || name === JSONL_NAME || name === SNAPSHOT_DIR) continue
    const from = join(sourceDir, name)
    const to = join(dir, name)
    if (existsSync(to)) continue
    try {
      const info = statSync(from)
      if (info.isDirectory()) {
        ensureDir(to)
        for (const inner of readdirSync(from)) {
          const f = join(from, inner)
          try { if (statSync(f).isFile()) copyFileSync(f, join(to, inner)) } catch { /* ignore */ }
        }
      } else if (info.isFile()) {
        copyFileSync(from, to)
      }
    } catch { /* ignore */ }
  }
}

/**
 * 准备这次要用的备份目录：
 *  - 不存在 → 新建（并给同学生成起步 README；绝不复制别人的形象/故事）；
 *  - 存在但没有记忆主档 → 从旧备份/快照补出 memory.jsonl；
 *  - 缺 README/形象/故事 → 从最完整的旧备份补（不覆盖已有文件）；
 *  - 旧备份里有更新的条目 → 按 id + updated_at 合并进来（只增/更新，不删）。
 * @returns {{ dir: string, created: boolean, migratedFrom: string[], merged: number, imported: number }}
 */
export function prepareBackupTarget(target, workspace) {
  const dir = target.dir
  const created = !existsSync(dir)
  if (created) ensureDir(dir)

  // 迁移只做一次：目标里放一个标记，避免以后每次都把旧备份重新并进来
  // （否则用户手动删掉的条目，会被旧备份反复“复活”）。
  const markerPath = join(dir, '.migration.json')
  const migratedBefore = existsSync(markerPath)
  const legacy = migratedBefore ? [] : findLegacyBackups(workspace, dir)
  if (legacy.length > 0) supplementFiles(dir, legacy[0].dir)

  let imported = { entries: [], from: null }
  if (!existsSync(jsonlPath(dir))) {
    for (const source of legacy) {
      const entries = readAllEntries(source.dir)
      if (entries.length > 0) { imported = { entries, from: source.dir }; break }
    }
    if (imported.entries.length === 0) imported = importLatestSnapshot(dir)
    saveBackupEntries(dir, imported.entries)
  }

  let merged = 0
  if (legacy.length > 0) {
    const map = new Map(loadBackupEntries(dir).map((entry) => [entryKey(entry), entry]))
    for (const source of legacy) {
      for (const entry of readAllEntries(source.dir)) {
        const key = entryKey(entry)
        const existing = map.get(key)
        if (existing === undefined) { map.set(key, entry); merged++ }
        else if ((Number(entry.updated_at) || 0) > (Number(existing.updated_at) || 0)) { map.set(key, entry); merged++ }
      }
    }
    if (merged > 0) {
      const list = [...map.values()]
      saveBackupEntries(dir, list)
      rebuildSnapshot(dir, list)
    }
  }

  ensureStarterReadme(dir)
  ensureDir(join(dir, SNAPSHOT_DIR))
  if (!migratedBefore) {
    try {
      atomicWrite(markerPath, `${JSON.stringify({
        at: Date.now(),
        from: legacy.map((source) => source.dir),
        merged,
      }, null, 2)}\n`)
    } catch { /* 标记写失败不拖垮同步 */ }
  }
  return { dir, created, migratedFrom: legacy.map((source) => source.dir), merged, imported, migrated: !migratedBefore }
}

/** 兼容旧调用：初始化一个目录（不再按旧 sourceDir 逻辑复制）。 */
export function ensureBackupDir(dir, workspace) {
  const target = { ok: true, status: existsSync(dir) ? 'uninitialized' : 'missing', base: dir, dir }
  return prepareBackupTarget(target, workspace)
}

// ── 本地活库 ────────────────────────────────────────────────────────────────

function localDbFile(workspace, projectDir) {
  return join(workspace, projectDir || '.dsh-meow', 'memory.db')
}

function openLocalDb(workspace, projectDir) {
  const file = localDbFile(workspace, projectDir)
  if (!existsSync(file)) return null
  try {
    const db = new DatabaseSync(file)
    db.exec('PRAGMA busy_timeout = 5000')
    // 新工作区可能只有部分表：补齐，免得拉取条目时 no such table。
    for (const level of LEVELS) {
      try { db.exec(SCHEMAS[level]) } catch { /* ignore */ }
    }
    return db
  } catch {
    return null
  }
}

export function readLocalEntries(db) {
  if (!db) return []
  const out = []
  for (const level of LEVELS) {
    let rows
    try { rows = db.prepare(`SELECT * FROM ${level}`).all() } catch { continue }
    for (const row of rows) out.push(normalizeRow(level, row))
  }
  return out
}

export function writeLocalEntry(db, entry) {
  const cols = TABLE_COLUMNS[entry.level]
  if (!cols) return
  const placeholders = cols.map(() => '?').join(', ')
  const sql = `INSERT OR REPLACE INTO ${entry.level} (${cols.join(', ')}) VALUES (${placeholders})`
  const values = cols.map((col) => {
    if (col === 'id') return entry.id
    const v = entry[col]
    return v === undefined ? null : v
  })
  db.prepare(sql).run(...values)
}

// ── 合并 ────────────────────────────────────────────────────────────────────

function entryKey(entry) {
  return `${entry.level}:${entry.id}`
}

function sameContent(a, b) {
  for (const field of CMP_FIELDS) {
    const av = a[field] === undefined ? null : a[field]
    const bv = b[field] === undefined ? null : b[field]
    if (JSON.stringify(av) !== JSON.stringify(bv)) return false
  }
  return true
}

function projectListOf(field) {
  if (!field) return []
  return String(field).split(',').map((s) => s.trim()).filter(Boolean)
}

/** 工作项目只留摘要：project 层只同步 overview，其它层里挂在该项目下的不同步。 */
function isRestricted(entry, restricted) {
  if (!Array.isArray(restricted) || restricted.length === 0) return false
  const projects = projectListOf(entry.project)
  if (projects.length === 0) return false
  if (!projects.some((p) => restricted.includes(p))) return false
  if (entry.level === 'project') return entry.subcategory !== 'overview'
  return true
}

function mergeEntries(localEntries, backupEntries, restricted) {
  const localMap = new Map(localEntries.map((e) => [entryKey(e), e]))
  const backupMap = new Map(backupEntries.map((e) => [entryKey(e), e]))
  const toBackup = []
  const toLocal = []
  const toBackupRemove = []
  const conflicts = []

  for (const [key, backup] of backupMap) {
    if (backup.status === 'archived') toBackupRemove.push(key)
  }

  for (const [key, local] of localMap) {
    const backup = backupMap.get(key)
    if (backup === undefined) {
      if (local.status !== 'archived' && !isRestricted(local, restricted)) toBackup.push(local)
      continue
    }
    if (sameContent(local, backup)) continue
    const lu = Number(local.updated_at) || 0
    const bu = Number(backup.updated_at) || 0
    // 本地归档 = 用户删了这条：备份里也不该留着（除非备份那边更新，说明它被复活过）
    if (local.status === 'archived') {
      if (lu >= bu) toBackupRemove.push(key)
      else if (backup.status !== 'archived') toLocal.push(backup)
      continue
    }
    if (lu > bu) {
      if (!isRestricted(local, restricted)) toBackup.push(local)
    } else if (bu > lu) {
      if (backup.status !== 'archived') toLocal.push(backup)
    } else {
      conflicts.push({
        key,
        level: local.level,
        id: local.id,
        localUpdatedAt: lu,
        backupUpdatedAt: bu,
        localContent: String(local.content).slice(0, 160),
        backupContent: String(backup.content).slice(0, 160),
      })
    }
  }

  for (const [key, backup] of backupMap) {
    if (localMap.has(key)) continue
    if (backup.status === 'archived') continue
    toLocal.push(backup)
  }

  const pushedKeys = new Set(toBackup.map(entryKey))
  const removeKeys = toBackupRemove.filter((key) => !pushedKeys.has(key))

  return { toBackup, toLocal, toBackupRemove: removeKeys, conflicts }
}

function rebuildSnapshot(dir, entries) {
  const snapDir = join(dir, SNAPSHOT_DIR)
  ensureDir(snapDir)
  const file = join(snapDir, `memory-${today()}.db`)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  try { unlinkSync(tmp) } catch { /* ignore */ }
  const db = new DatabaseSync(tmp)
  try {
    for (const level of LEVELS) db.exec(SCHEMAS[level])
    db.exec('BEGIN')
    for (const entry of entries) {
      try { writeLocalEntry(db, entry) } catch { /* 单条坏数据不拖垮快照 */ }
    }
    db.exec('COMMIT')
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
  try {
    renameSync(tmp, file)
  } catch {
    try { unlinkSync(file) } catch { /* ignore */ }
    renameSync(tmp, file)
  }
  return file
}

/**
 * 同步一次。
 * @param {string} workspace 工作区
 * @param {object} config 配置（backupDir / projectDir / summaryOnlyProjects）
 * @param {{direction?: 'both'|'push'|'pull', sourceDir?: string}} [options]
 */
export function syncWorkspace(workspace, config, options = {}) {
  if (typeof workspace !== 'string' || workspace.length === 0) return { ok: false, error: 'no-workspace' }
  const target = resolveBackupTarget(config, workspace)
  if (target.ok !== true) {
    return {
      ok: false,
      error: 'ambiguous-backup',
      base: target.base,
      candidates: (target.candidates ?? []).map((candidate) => ({ dir: candidate.dir, entryCount: candidate.entryCount })),
    }
  }
  const prep = prepareBackupTarget(target, workspace)
  const dir = prep.dir

  const db = openLocalDb(workspace, config.projectDir)
  if (db === null) {
    return { ok: false, error: 'no-local-db', backupDir: dir }
  }
  try {
    const localEntries = readLocalEntries(db)
    const backupEntries = loadBackupEntries(dir)
    const restricted = Array.isArray(config.summaryOnlyProjects) ? config.summaryOnlyProjects : []
    const { toBackup, toLocal, toBackupRemove, conflicts } = mergeEntries(localEntries, backupEntries, restricted)

    const direction = options.direction === 'push' || options.direction === 'pull' ? options.direction : 'both'
    const pushedEntries = direction === 'pull' ? [] : toBackup
    const pulledEntries = direction === 'push' ? [] : toLocal

    if (pushedEntries.length > 0 || toBackupRemove.length > 0) {
      const backupMap = new Map(backupEntries.map((e) => [entryKey(e), e]))
      for (const key of toBackupRemove) backupMap.delete(key)
      for (const entry of pushedEntries) backupMap.set(entryKey(entry), entry)
      const merged = [...backupMap.values()]
      saveBackupEntries(dir, merged)
      rebuildSnapshot(dir, merged)
    }

    if (pulledEntries.length > 0) {
      db.exec('BEGIN')
      try {
        for (const entry of pulledEntries) writeLocalEntry(db, entry)
        db.exec('COMMIT')
      } catch (error) {
        try { db.exec('ROLLBACK') } catch { /* ignore */ }
        throw error
      }
    }

    return {
      ok: true,
      backupDir: dir,
      created: prep.created,
      migratedFrom: prep.migratedFrom,
      migratedCount: prep.merged,
      initialized: prep.imported,
      pushed: pushedEntries.length,
      pulled: pulledEntries.length,
      removed: toBackupRemove.length,
      conflicts,
      backupCount: loadBackupEntries(dir).length,
      localCount: localEntries.length,
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), backupDir: dir }
  } finally {
    try { db.close() } catch { /* ignore */ }
  }
}

/** 只往备份推（关闭开关前用）。 */
export function flushWorkspace(workspace, config) {
  return syncWorkspace(workspace, config, { direction: 'push' })
}
