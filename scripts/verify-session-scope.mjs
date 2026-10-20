// scripts/verify-session-scope.mjs — 会话级覆盖与回收状态机（纯函数 + 真实文件系统）
//
// 为什么需要它：会话覆盖的失效形态几乎全是**静默且不可逆**的：
//   · 把 `enabled` 覆盖掉 ⇒ 关掉插件却没关干净；
//   · 文件名不哈希 ⇒ 路径穿越 / 字符集问题；
//   · 内容与文件名不互校 ⇒ 改个文件名就能读到别人的覆盖；
//   · 用 `agents.list()` 判定删除 ⇒ **误删正在使用的设置**（最严重，且用户永久丢失）；
//   · 扫描不完整时仍然回收 ⇒ 一次临时故障清空所有覆盖。
// 最后两条是"删错了救不回来"的类型，所以这里把状态机穷举了一遍。
//
// 零依赖，直接 `node scripts/verify-session-scope.mjs` 运行。

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { assertCount } from './lib/skip-report.mjs'
import {
  FILE_HASH_LENGTH,
  MAX_SESSION_ID_LENGTH,
  ORPHAN_GRACE_MS,
  SESSION_DIR_NAME,
  SESSION_ENVELOPE_ONLY_FIELDS,
  SESSION_OVERRIDE_FIELDS,
  SESSION_SCOPE_VERSION,
  createSessionScopeDoc,
  decideSessionScopeFate,
  isSessionId,
  listSessionScopes,
  parseSessionScopeDoc,
  quarantineSessionScope,
  readSessionScope,
  sanitizeSessionOverride,
  sessionFileName,
  sessionScopeDirFor,
  sessionScopePathFor,
  writeSessionScope
} from '../lib/session-scope.mjs'

const EXPECTED_ASSERTIONS = 23

let passed = 0
function check(name, fn) {
  try {
    fn()
  } catch (error) {
    error.message = `【${name}】${error.message}`
    error.stack = `【${name}】${error.stack}`
    throw error
  }
  passed++
  console.log(`  ✓ ${name}`)
}

const DAY = 24 * 3600 * 1000

// ==================== 键与文件名 ====================

check('sessionId 必须是非空短字符串，且不能是路径', () => {
  assert.equal(isSessionId('session-abc'), true)
  assert.equal(isSessionId(''), false)
  assert.equal(isSessionId('   '), false)
  assert.equal(isSessionId(null), false)
  assert.equal(isSessionId(42), false)
  assert.equal(isSessionId('a/b'), false, '含斜杠不得当 id')
  assert.equal(isSessionId('a\\b'), false, '含反斜杠不得当 id')
  assert.equal(isSessionId('..'), false, '路径穿越形态必须拒绝')
  assert.equal(isSessionId('.'), false)
  assert.equal(isSessionId('x'.repeat(MAX_SESSION_ID_LENGTH + 1)), false)
})

check('文件名是定长哈希，且不泄漏原始 id', () => {
  const id = 'session-very-secret-id-123'
  const name = sessionFileName(id)
  assert.equal(name.length, FILE_HASH_LENGTH + '.json'.length)
  assert.match(name, /^[0-9a-f]{32}\.json$/)
  assert.equal(name.includes('secret'), false, '文件名不得包含原始 id')
  // 同一 id 稳定、不同 id 不同
  assert.equal(sessionFileName(id), name)
  assert.notEqual(sessionFileName(id + 'x'), name)
})

check('sidecar 目录与配置同级', () => {
  assert.equal(
    sessionScopeDirFor('/home/u/.dsh/soul-config.json'),
    join('/home/u/.dsh', SESSION_DIR_NAME)
  )
  const p = sessionScopePathFor('/home/u/.dsh/soul-config.json', 'session-a')
  assert.equal(p, join('/home/u/.dsh', SESSION_DIR_NAME, sessionFileName('session-a')))
  // 换一个配置位置，sidecar 跟着走（测试把配置指到临时目录时自动隔离）
  assert.match(sessionScopePathFor('/tmp/x/soul-config.json', 'a'), /^.*tmp.*x.*$/)
})

// ==================== 覆盖项校验 ====================

check('覆盖项只保留白名单字段，包封字段被丢弃', () => {
  const { override, dropped } = sanitizeSessionOverride({
    style: 'humorous',
    replyLength: 'concise',
    enabled: false,        // 包封字段：越界
    nickname: 'x',          // 「关于你」不在范围内
    historyMaxEntries: 1
  })
  // ⚠️ 这里必须**同时**断言两件事，缺一不可：
  //   · dropped 里有它  → 调用方能如实告诉用户"你的这个字段被忽略了"；
  //   · override 里没有它 → 它真的没被带进配置。
  // 只断言前者会漏掉"记了一笔却又悄悄应用"的形态（判断力对照实测：把 continue 换成
  // 「记录但继续赋值」时，只查 dropped 的版本全部漏网）。
  assert.deepEqual(override, { style: 'humorous', replyLength: 'concise' })
  assert.deepEqual(dropped.slice().sort(), ['enabled', 'historyMaxEntries', 'nickname'])
  for (const key of SESSION_ENVELOPE_ONLY_FIELDS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(override, key),
      false,
      `${key} 绝不能出现在会话覆盖里 —— 全局总开关必须始终由全局配置说话`
    )
  }
  // 反向：即便只传包封字段，也必须被整条拒绝（不能因为"有输入"就当有覆盖）
  for (const field of SESSION_ENVELOPE_ONLY_FIELDS) {
    const only = sanitizeSessionOverride({ [field]: true })
    assert.equal(only.override, null, `只传 ${field} 时必须归一成「没有覆盖」`)
    assert.deepEqual(only.dropped, [field], `${field} 仍要出现在 dropped 里，便于如实提示`)
  }
})

check('空覆盖 / 非对象归一成 null', () => {
  assert.equal(sanitizeSessionOverride({}).override, null)
  assert.equal(sanitizeSessionOverride(null).override, null)
  assert.equal(sanitizeSessionOverride('x').override, null)
  assert.equal(sanitizeSessionOverride([]).override, null)
  assert.equal(sanitizeSessionOverride({ enabled: true }).override, null, '只有包封字段时等于没有覆盖')
})

check('白名单与包封字段不重叠', () => {
  for (const field of SESSION_ENVELOPE_ONLY_FIELDS) {
    assert.equal(
      SESSION_OVERRIDE_FIELDS.includes(field),
      false,
      `${field} 是包封字段，不得出现在会话可覆盖白名单里`
    )
  }
})

// ==================== 文档解析 ====================

check('新建 doc 含版本、原始 id 与时间戳', () => {
  const now = Date.parse('2026-10-19T06:00:00Z')
  const doc = createSessionScopeDoc('session-a', { style: 'casual' }, now)
  assert.equal(doc.schemaVersion, SESSION_SCOPE_VERSION)
  assert.equal(doc.sessionId, 'session-a')
  assert.deepEqual(doc.overrides, { style: 'casual' })
  assert.equal(doc.createdAt, new Date(now).toISOString())
  assert.equal(doc.updatedAt, doc.createdAt)
})

check('解析：版本不认识 / sessionId 不符 / 形状不对都给出 failure 且不产出 override', () => {
  const good = {
    schemaVersion: SESSION_SCOPE_VERSION,
    sessionId: 'session-a',
    overrides: { style: 'casual' }
  }
  assert.deepEqual(parseSessionScopeDoc(good, 'session-a').override, { style: 'casual' })

  const badVersion = parseSessionScopeDoc({ ...good, schemaVersion: 999 }, 'session-a')
  assert.equal(badVersion.override, null)
  assert.match(badVersion.failure, /版本/)

  // 这条最关键：改个文件名就能让某个会话读到另一个会话的覆盖
  const mismatch = parseSessionScopeDoc({ ...good, sessionId: 'session-b' }, 'session-a')
  assert.equal(mismatch.override, null)
  assert.match(mismatch.failure, /不符/)

  assert.equal(parseSessionScopeDoc(null, 'a').override, null)
  assert.equal(parseSessionScopeDoc('x', 'a').override, null)
  assert.equal(parseSessionScopeDoc([], 'a').override, null)
})

check('解析：孤儿标记的形状校验（坏时间按未标记处理）', () => {
  const base = {
    schemaVersion: SESSION_SCOPE_VERSION,
    sessionId: 'session-a',
    overrides: { style: 'casual' }
  }
  const iso = new Date(Date.now() - 3 * DAY).toISOString()
  assert.deepEqual(parseSessionScopeDoc({ ...base, orphan: { firstSeenAt: iso } }, 'session-a').orphan, {
    firstSeenAt: iso,
    lastScannedAt: iso
  })
  // 时间不可解析 ⇒ 当作未标记（宁可重新计时多留 30 天）
  assert.equal(parseSessionScopeDoc({ ...base, orphan: { firstSeenAt: 'not-a-date' } }, 'session-a').orphan, null)
  assert.equal(parseSessionScopeDoc({ ...base, orphan: {} }, 'session-a').orphan, null)
  assert.equal(parseSessionScopeDoc(base, 'session-a').orphan, null, '缺字段 = 从未标记')
})

// ==================== 回收状态机（核心）====================

check('状态机：会话存在 → keep（无标记）/ clear-mark（有标记）', () => {
  const now = Date.now()
  assert.equal(decideSessionScopeFate({ orphan: null, presentOnDisk: true, scanComplete: true, now }).action, 'keep')
  const withMark = { firstSeenAt: new Date(now - 40 * DAY).toISOString() }
  const cleared = decideSessionScopeFate({ orphan: withMark, presentOnDisk: true, scanComplete: true, now })
  assert.equal(cleared.action, 'clear-mark', '会话重新出现必须撤销孤儿标记')
  assert.equal(cleared.orphan, null)
})

check('★ 状态机：扫描不完整时永不标记、永不回收', () => {
  const now = Date.now()
  // 即便已有超龄标记，扫描不完整也只能 keep —— 「没看到」不等于「不存在」
  const old = { firstSeenAt: new Date(now - 100 * DAY).toISOString() }
  const r = decideSessionScopeFate({ orphan: old, presentOnDisk: false, scanComplete: false, now })
  assert.equal(r.action, 'keep', '扫描不完整时绝不允许回收')
  assert.equal(r.orphan, old, '也不得改写标记（那会把"没检查"记成"检查过"）')
  // 首次缺席同理
  assert.equal(
    decideSessionScopeFate({ orphan: null, presentOnDisk: false, scanComplete: false, now }).action,
    'keep'
  )
})

check('状态机：首次缺席 → mark，不删除', () => {
  const now = Date.now()
  const r = decideSessionScopeFate({ orphan: null, presentOnDisk: false, scanComplete: true, now })
  assert.equal(r.action, 'mark')
  assert.ok(r.orphan.firstSeenAt)
  assert.equal(r.orphan.firstSeenAt, r.orphan.lastScannedAt)
})

check('状态机：宽限期内 → keep，并刷新 lastScannedAt', () => {
  const now = Date.now()
  const first = new Date(now - 10 * DAY).toISOString()
  const r = decideSessionScopeFate({
    orphan: { firstSeenAt: first, lastScannedAt: first },
    presentOnDisk: false,
    scanComplete: true,
    now
  })
  assert.equal(r.action, 'keep')
  assert.equal(r.orphan.firstSeenAt, first, 'firstSeenAt 必须保持不变（否则永远等不到 30 天）')
  assert.ok(Date.parse(r.orphan.lastScannedAt) >= now - 1000, 'lastScannedAt 应被刷新')
})

check('状态机：满宽限期且扫描完整 → collect', () => {
  const now = Date.now()
  const r = decideSessionScopeFate({
    orphan: { firstSeenAt: new Date(now - 31 * DAY).toISOString() },
    presentOnDisk: false,
    scanComplete: true,
    now
  })
  assert.equal(r.action, 'collect')
})

check('状态机：边界 —— 恰好 30 天当天可回收，差一天不可', () => {
  const now = Date.now()
  const exact = decideSessionScopeFate({
    orphan: { firstSeenAt: new Date(now - ORPHAN_GRACE_MS).toISOString() },
    presentOnDisk: false,
    scanComplete: true,
    now
  })
  assert.equal(exact.action, 'collect', '恰好满 30 天应可回收')
  const shy = decideSessionScopeFate({
    orphan: { firstSeenAt: new Date(now - ORPHAN_GRACE_MS + DAY).toISOString() },
    presentOnDisk: false,
    scanComplete: true,
    now
  })
  assert.equal(shy.action, 'keep', '差一天不可回收')
})

check('状态机：标记时间损坏 → 重新计时而不是立刻回收', () => {
  const now = Date.now()
  const r = decideSessionScopeFate({
    orphan: { firstSeenAt: 'garbage' },
    presentOnDisk: false,
    scanComplete: true,
    now
  })
  assert.equal(r.action, 'mark', '无法判断年龄时必须重新计时（宁可多留 30 天）')
})

// ==================== 文件读写（真实文件系统）====================

check('读写往返：写进去能读出来，override 一致', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soul-session-scope-'))
  try {
    const configPath = join(dir, 'soul-config.json')
    const sessionId = 'session-roundtrip'
    const filePath = sessionScopePathFor(configPath, sessionId)
    const doc = createSessionScopeDoc(sessionId, { style: 'casual', replyLength: 'concise' })
    await writeSessionScope(filePath, doc)

    const back = await readSessionScope(filePath, sessionId)
    assert.equal(back.exists, true)
    assert.equal(back.failure, null)
    assert.deepEqual(back.override, { style: 'casual', replyLength: 'concise' })

    // 原子写：临时文件不应残留
    const names = await listSessionScopes(sessionScopeDirFor(configPath))
    assert.equal(names.length, 1, `目录里应只有一份 sidecar，实际 ${names.map((n) => n.name).join(',')}`)
    assert.equal(names[0].name.endsWith('.tmp'), false, '不得残留临时文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('读不存在的 sidecar：exists=false 且不报错（首次使用就是没有覆盖）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soul-session-scope-'))
  try {
    const filePath = sessionScopePathFor(join(dir, 'soul-config.json'), 'never-existed')
    const r = await readSessionScope(filePath, 'never-existed')
    assert.equal(r.exists, false)
    assert.equal(r.override, null)
    assert.equal(r.failure, null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('损坏的 sidecar：如实报 failure，不静默当空覆盖', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soul-session-scope-'))
  try {
    const configPath = join(dir, 'soul-config.json')
    const sessionId = 'session-corrupt'
    const filePath = sessionScopePathFor(configPath, sessionId)
    // 裸 writeFile 不会建目录（那是 writeSessionScope 的职责），所以先 mkdir ——
    // 这条用例要的是「文件存在但内容坏」，不是「目录不存在」。
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, '{ this is not json', 'utf8')

    const r = await readSessionScope(filePath, sessionId)
    assert.equal(r.exists, true)
    assert.ok(r.failure !== null, '损坏必须如实报告 —— 静默当空覆盖会让用户以为设置丢了')
    assert.equal(r.override, null)
    // 文件仍然在（读路径不产生副作用）
    assert.ok(await readFile(filePath, 'utf8'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('隔离：quarantine 把文件改名，原路径不再存在', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soul-session-scope-'))
  try {
    const configPath = join(dir, 'soul-config.json')
    const sessionId = 'session-quarantine'
    const filePath = sessionScopePathFor(configPath, sessionId)
    await writeSessionScope(filePath, createSessionScopeDoc(sessionId, { style: 'casual' }))

    const moved = await quarantineSessionScope(filePath)
    assert.ok(moved !== null, 'quarantine 应返回新路径')
    // 复用 lib/store.mjs 的既有约定 `<file>.corrupt` —— 不另造后缀：
    // 同一个仓库里两种"损坏备份"命名，运维时得同时记得两个。
    assert.match(moved, /\.corrupt$/)
    // 原路径已不存在 ⇒ 读取回到「首次运行」分支
    const after = await readSessionScope(filePath, sessionId)
    assert.equal(after.exists, false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

check('listSessionScopes：目录不存在返回空数组，只收 .json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soul-session-scope-'))
  try {
    const missing = join(dir, 'nope')
    assert.deepEqual(await listSessionScopes(missing), [], '目录不存在应返回空数组而不是抛错')

    const real = join(dir, 'exists')
    await writeSessionScope(join(real, 'a.json'), createSessionScopeDoc('a', { style: 'casual' }))
    await writeFile(join(real, 'b.txt'), 'x', 'utf8')
    const listed = await listSessionScopes(real)
    assert.deepEqual(listed.map((f) => f.name), ['a.json'], '只应收集 .json 文件')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ==================== 模块边界 ====================

check('纯函数层不依赖宿主；且不把 agents.list 当删除证据', async () => {
  const { readFileSync } = await import('node:fs')
  const source = readFileSync(new URL('../lib/session-scope.mjs', import.meta.url), 'utf8')
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/from 'cordis'|require\('cordis'\)/.test(code), false, '不得依赖 cordis')
  assert.equal(/console\./.test(code), false, '纯函数层不得打印')
  // 这条是设计红线：agents.list 是 live registry，会话切走就消失，用它判定会误删。
  assert.equal(
    /agents\.list|ctx\.agents/.test(code),
    false,
    '不得引用 agents —— 会话是否删除只能由调用方用 sessionPersistence 判定'
  )

})

check('sidecar 记下用户实际点选的预设名（不靠字段反查）', () => {
  // 背景：覆盖项只存字段，而「当前生效的是哪个预设」若靠字段反查，
  // 两个预设声明相同字段时结果取决于**名称排序** —— 实测用户自建
  // 「游戏策划与开发专家」与内置「自驱型协作者」字段一致时，
  // 点了后者却显示前者。记下名字把"猜"变成"知道"。
  const doc = createSessionScopeDoc('s1', { style: 'professional' }, 1700000000000, '自驱型协作者')
  assert.equal(doc.personaName, '自驱型协作者', 'sidecar 必须记下预设名')
  assert.equal(doc.overrides.style, 'professional', '字段照旧存（模型只认字段）')
  assert.equal('personaName' in createSessionScopeDoc('s1', { style: 'professional' }, 1700000000000, ''), false,
    '空名字不该写入（老 sidecar 保持形状一致）')
  assert.equal('personaName' in createSessionScopeDoc('s1', { style: 'professional' }, 1700000000000, null), false,
    'null 不该写入')

  // 读侧：解析出来
  const parsed = parseSessionScopeDoc({
    schemaVersion: SESSION_SCOPE_VERSION,
    sessionId: 's1',
    overrides: { style: 'professional' },
    personaName: '自驱型协作者',
    createdAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:13:20.000Z'
  }, 's1')
  assert.equal(parsed.personaName, '自驱型协作者', '读侧必须取回预设名')
  assert.equal(parsed.failure, null, '带 personaName 的 sidecar 应能正常解析')

  // 老 sidecar（没有该字段）⇒ personaName 为 null，调用方退回反查
  const legacy = parseSessionScopeDoc({
    schemaVersion: SESSION_SCOPE_VERSION,
    sessionId: 's1',
    overrides: { style: 'professional' },
    createdAt: '2023-11-14T22:13:20.000Z',
    updatedAt: '2023-11-14T22:13:20.000Z'
  }, 's1')
  assert.equal(legacy.personaName, null, '老 sidecar 没有该字段时应为 null（调用方退回反查）')
  assert.equal(legacy.failure, null, '老 sidecar 仍应能正常解析')
  assert.ok(legacy.override, '老 sidecar 的覆盖项不该丢')
})

if (!assertCount('verify-session-scope', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
