/**
 * dsh-whale-memory — 备份同步测试（M2）。
 *
 * 运行：node test-sync.mjs
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-whale-memory-sync-'))

const { syncWorkspace, flushWorkspace, resolveBackupDir, looksLikeBackup, seedPersonaIfEmpty, readSeedMarker } = await import('./lib/sync.js')

const COMMON = (extra = '') => `(
  id TEXT PRIMARY KEY, title TEXT, content TEXT NOT NULL,
  importance INTEGER NOT NULL DEFAULT 1, keywords TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active', source_session TEXT,
  hit_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, last_accessed_at INTEGER${extra}
)`

function makeLocalDb(workspace, rows) {
  mkdirSync(join(workspace, '.dsh-meow'), { recursive: true })
  const db = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
  db.exec(`CREATE TABLE soul ${COMMON()}`)
  db.exec(`CREATE TABLE fact ${COMMON(', project TEXT')}`)
  db.exec(`CREATE TABLE user ${COMMON()}`)
  for (const r of rows) {
    if (r.level === 'soul') {
      db.prepare('INSERT INTO soul (id, title, content, importance, keywords, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(r.id, r.title ?? null, r.content, r.importance ?? 2, r.keywords ?? '[]', r.status ?? 'active', r.created_at ?? 100, r.updated_at ?? 100)
    } else if (r.level === 'fact') {
      db.prepare('INSERT INTO fact (id, title, content, importance, keywords, status, created_at, updated_at, project) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(r.id, r.title ?? null, r.content, r.importance ?? 1, r.keywords ?? '[]', r.status ?? 'active', r.created_at ?? 100, r.updated_at ?? 100, r.project ?? null)
    }
  }
  db.close()
}

function makeSnapshot(file, rows) {
  mkdirSync(dirname(file), { recursive: true })
  const db = new DatabaseSync(file)
  db.exec(`CREATE TABLE soul ${COMMON()}`)
  db.exec(`CREATE TABLE fact ${COMMON(', project TEXT')}`)
  for (const r of rows) {
    if (r.level === 'soul') {
      db.prepare('INSERT INTO soul (id, title, content, importance, keywords, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(r.id, r.title ?? null, r.content, r.importance ?? 2, r.keywords ?? '[]', r.status ?? 'active', r.created_at ?? 100, r.updated_at ?? 100)
    } else if (r.level === 'fact') {
      db.prepare('INSERT INTO fact (id, title, content, importance, keywords, status, created_at, updated_at, project) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(r.id, r.title ?? null, r.content, r.importance ?? 1, r.keywords ?? '[]', r.status ?? 'active', r.created_at ?? 100, r.updated_at ?? 100, r.project ?? null)
    }
  }
  db.close()
}

const workspace = join(process.env.DSH_HOME, 'ws')
const backupDir = join(process.env.DSH_HOME, 'backup')
const config = { backupDir, projectDir: '.dsh-meow', summaryOnlyProjects: [] }

try {
  // 备份侧：一条 fact
  mkdirSync(backupDir, { recursive: true })
  writeFileSync(join(backupDir, 'memory.jsonl'), JSON.stringify({
    level: 'fact', id: 'b1', title: null, content: '备份里的事实', importance: 1,
    keywords: '[]', status: 'active', created_at: 100, updated_at: 100,
  }) + '\n', 'utf8')
  writeFileSync(join(backupDir, 'README.md'), '# 鲸鲸记忆备份\n', 'utf8')

  // 本地侧：一条 soul
  makeLocalDb(workspace, [{ level: 'soul', id: 's1', content: '我是鲸鲸', updated_at: 200 }])

  const first = syncWorkspace(workspace, config)
  assert.equal(first.ok, true, first.error)
  assert.equal(first.pushed, 1, '本地新条目推到备份')
  assert.equal(first.pulled, 1, '备份条目拉进本地')
  const jsonl = readFileSync(join(backupDir, 'memory.jsonl'), 'utf8')
  assert.ok(jsonl.includes('"id":"s1"'), '备份里有本地条目')
  assert.ok(jsonl.includes('"id":"b1"'), '备份原有条目还在')

  // 本地写入会更新的条目 → flush 推回备份
  {
    const db = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
    db.prepare("UPDATE soul SET content = ?, updated_at = ? WHERE id = 's1'").run('我是鲸鲸（改）', 300)
    db.close()
  }
  const flush = flushWorkspace(workspace, config)
  assert.equal(flush.ok, true)
  assert.equal(flush.pushed, 1)
  assert.ok(readFileSync(join(backupDir, 'memory.jsonl'), 'utf8').includes('我是鲸鲸（改）'))

  // 冲突：同 id 同 updated_at 不同内容 → 记冲突，本地保留
  {
    const db = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
    db.prepare("UPDATE fact SET content = ?, updated_at = 500 WHERE id = 'b1'").run('本地版本')
    db.close()
  }
  writeFileSync(join(backupDir, 'memory.jsonl'), [
    JSON.stringify({ level: 'fact', id: 'b1', title: null, content: '备份版本', importance: 1, keywords: '[]', status: 'active', created_at: 100, updated_at: 500 }),
    JSON.stringify({ level: 'soul', id: 's1', title: null, content: '我是鲸鲸（改）', importance: 2, keywords: '[]', status: 'active', created_at: 100, updated_at: 300 }),
  ].join('\n') + '\n', 'utf8')
  const conflicted = syncWorkspace(workspace, config)
  assert.equal(conflicted.ok, true)
  assert.equal(conflicted.conflicts.length, 1, '同时间戳不同内容 = 冲突')
  {
    const db = new DatabaseSync(join(workspace, '.dsh-meow', 'memory.db'))
    const row = db.prepare("SELECT content FROM fact WHERE id = 'b1'").get()
    db.close()
    assert.equal(row.content, '本地版本', '冲突时本地内容不被覆盖')
  }

  // 快照重建
  assert.ok(existsSync(join(backupDir, 'snapshots')), '写回后重建了快照目录')
  assert.ok(readFileSync(join(backupDir, 'memory.jsonl'), 'utf8').length > 0)

  // 从旧备份迁移：workspace2 下有「鲸鲸记忆备份」，目标 backup2 不存在
  const workspace2 = join(process.env.DSH_HOME, 'ws2')
  makeLocalDb(workspace2, [])
  const legacy = join(workspace2, '鲸鲸记忆备份')
  makeSnapshot(join(legacy, 'snapshots', 'memory-20260101.db'), [
    { level: 'fact', id: 'f2', content: '旧快照的事', updated_at: 150 },
  ])
  writeFileSync(join(legacy, 'README.md'), '# 老备份\n', 'utf8')
  const newBackup = join(process.env.DSH_HOME, 'backup2')
  const imported = syncWorkspace(workspace2, { ...config, backupDir: newBackup })
  assert.equal(imported.ok, true, imported.error)
  assert.equal(imported.created, true, '目标不存在 → 新建')
  assert.ok(imported.migratedFrom.includes(legacy), '认出了旧备份')
  assert.equal(imported.pulled, 1, '旧快照里的事进新工作区')
  assert.ok(readFileSync(join(newBackup, 'README.md'), 'utf8').includes('老备份'), 'README 一起补过去')
  assert.ok(readFileSync(join(newBackup, 'memory.jsonl'), 'utf8').includes('"id":"f2"'))

  // 按内容识别：备份目录认得出；普通目录认不出
  assert.equal(looksLikeBackup(backupDir).ok, true, '有 jsonl 的目录像备份')
  const plainDir = join(process.env.DSH_HOME, 'plain')
  mkdirSync(plainDir, { recursive: true })
  writeFileSync(join(plainDir, 'readme.md'), '# 普通说明\n', 'utf8')
  assert.equal(looksLikeBackup(plainDir).ok, false, '只有普通 README 不算备份')

  // 路径解析：配置优先；没配置时用共享位置（工作区的旧备份只作为迁移来源）
  assert.equal(resolveBackupDir({ backupDir }, workspace), backupDir)
  assert.equal(resolveBackupDir({ backupDir: '' }, workspace), join(process.env.DSH_HOME, 'storages', '鲸鲸记忆备份'))

  // 多个候选 → ambiguous，不乱选
  const multiBase = join(process.env.DSH_HOME, 'multi')
  mkdirSync(join(multiBase, 'a'), { recursive: true })
  mkdirSync(join(multiBase, 'b'), { recursive: true })
  writeFileSync(join(multiBase, 'a', 'memory.jsonl'), JSON.stringify({ level: 'fact', id: 'a1', content: 'a', updated_at: 1 }) + '\n', 'utf8')
  writeFileSync(join(multiBase, 'b', 'memory.jsonl'), JSON.stringify({ level: 'fact', id: 'b1', content: 'b', updated_at: 1 }) + '\n', 'utf8')
  const ambiguous = syncWorkspace(workspace, { ...config, backupDir: multiBase })
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.error, 'ambiguous-backup')

  // ── 新设备接生：空库 + 空备份 → 写下三条人设，并留标记 ──
  {
    const ws3 = join(process.env.DSH_HOME, 'ws3')
    makeLocalDb(ws3, [])
    const seedDir = join(process.env.DSH_HOME, 'backup3')
    mkdirSync(seedDir, { recursive: true })
    const dbFile = join(ws3, '.dsh-meow', 'memory.db')

    const first = seedPersonaIfEmpty(dbFile, { dir: seedDir, sessionId: 'seed-1', now: 1000 })
    assert.equal(first.ok, true, first.error)
    assert.equal(first.seeded, true, '空库 → 接生')
    assert.deepEqual([...first.levels].sort(), ['rules', 'soul', 'user'], '三层都写了')
    {
      const db = new DatabaseSync(dbFile)
      assert.equal(db.prepare('SELECT count(*) AS n FROM soul').get().n, 1, 'soul 一条')
      assert.equal(db.prepare('SELECT count(*) AS n FROM user').get().n, 1, 'user 一条')
      assert.equal(db.prepare('SELECT count(*) AS n FROM rules').get().n, 1, 'rules 一条')
      const soul = db.prepare("SELECT content, importance FROM soul WHERE id = 'whale-seed-soul'").get()
      assert.ok(soul.content.includes('鲸鲸'), '人设内容写进去了')
      assert.equal(soul.importance, 4, 'soul importance=4')
      db.close()
    }
    assert.ok(readSeedMarker(seedDir) !== null, '备份目录留下接生标记')

    // 第二次：标记在 → 不再写
    const second = seedPersonaIfEmpty(dbFile, { dir: seedDir, now: 2000 })
    assert.equal(second.seeded, false)
    assert.equal(second.reason, 'already-marked')

    // 已有 soul 的工作区：绝不覆盖（手动 force 也不行）
    const ws4 = join(process.env.DSH_HOME, 'ws4')
    makeLocalDb(ws4, [{ level: 'soul', id: 'keep', content: '我原来的鲸鲸' }])
    const guarded = seedPersonaIfEmpty(join(ws4, '.dsh-meow', 'memory.db'), { dir: seedDir, force: true })
    assert.equal(guarded.seeded, false)
    assert.equal(guarded.reason, 'has-soul')
    {
      const db = new DatabaseSync(join(ws4, '.dsh-meow', 'memory.db'))
      assert.equal(db.prepare('SELECT count(*) AS n FROM soul').get().n, 1, '没有多出第二个「我」')
      assert.equal(db.prepare("SELECT content FROM soul WHERE id = 'keep'").get().content, '我原来的鲸鲸', '原内容没被改')
      db.close()
    }

    // 没有本地库 → no-local-db
    const missing = seedPersonaIfEmpty(join(process.env.DSH_HOME, 'nope', '.dsh-meow', 'memory.db'), {})
    assert.equal(missing.ok, false)
    assert.equal(missing.error, 'no-local-db')
  }

  console.log('✅ dsh-whale-memory sync tests passed')
} finally {
  try { rmSync(process.env.DSH_HOME, { recursive: true, force: true }) } catch { /* ignore */ }
}
