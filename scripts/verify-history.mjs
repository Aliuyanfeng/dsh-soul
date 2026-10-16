// scripts/verify-history.mjs — 变更审计层行为自检（纯函数 + 真实文件系统）
//
// 与 verify-config.mjs 的分工：那边校验「配置本身」的纯函数与源文本契约，这里校验
// lib/history.mjs —— 记录文件长什么样、坏掉了会怎样、回滚会算出什么补丁。
//
// 这个模块的失败模式都很安静，所以断言必须打在「安静的错误」上：
//
//   - 回滚算出**一份从未存在过的混合状态**（记录与配置不同步时无脑反向撤销）；
//   - 只记了部分变化（预设库的增删改被 diffKeys 式的逻辑跳过）；
//   - 一条手改坏了的行让整个列表打不开；
//   - 「原样再存一遍」也留下一条「覆盖了预设」的假记录。
//
// 零依赖，直接 `node scripts/verify-history.mjs` 运行。

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HISTORY_ACTIONS,
  HISTORY_SOURCES,
  HISTORY_VERSION,
  MAX_BYTES,
  MAX_ENTRIES,
  MAX_READ_BYTES,
  MAX_READ_LINES,
  appendHistoryEntry,
  auditFields,
  buildHistoryEntry,
  clearHistoryFile,
  createEntryId,
  diffFields,
  diffPersonas,
  findEntryIndex,
  hasPersonaEvents,
  hashConfig,
  historyPathFor,
  normalizeHistoryEntry,
  parseHistoryText,
  planRollback,
  pruneEntries,
  randomSuffix,
  readHistoryFile,
  recordHistoryEntry,
  serializeEntry,
  toHistoryResponse
} from '../lib/history.mjs'
import { DEFAULT_CONFIG, PERSONA_FIELDS } from '../lib/config.mjs'
import { assertCount } from './lib/skip-report.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-soul-history-'))
// 断言条数写死：新增/删除用例时数字必须一起改。
// 「本次真的跑了这么多」与「我以为跑了这么多」不是同一件事 —— 少跑的那几条
// 看起来和黄了没区别，所以 assertCount 不一致时整脚本判失败。
const EXPECTED_ASSERTIONS = 41
let fileSeq = 0
function freshPath(label = 'soul-config.history.jsonl') {
  fileSeq += 1
  return join(root, `${fileSeq}-${label}`)
}

// 固定基准时间：断言里出现时间戳时，用常量比用 Date.now() 更能暴露「按时间排序」这类
// 不该存在的依赖（同毫秒与时钟回拨在真实机器上都会发生）。
const BASE_MS = Date.parse('2026-01-01T00:00:00.000Z')
let seq = 0

function makeEntry(overrides = {}) {
  seq += 1
  const at = new Date(BASE_MS + seq * 1000).toISOString()
  const built = buildHistoryEntry({
    id: createEntryId(BASE_MS + seq * 1000, 'abcdef'),
    at,
    source: 'web',
    action: 'save',
    configHash: hashConfig(DEFAULT_CONFIG),
    before: { nickname: '旧' },
    after: { nickname: '新' },
    ...overrides
  })
  // 构造失败会让后续断言集体静默通过（拿着 null 到处跑），所以在这里就炸。
  assert.ok(built, `测试用例构造失败：${JSON.stringify(overrides)}`)
  return built
}

let passed = 0
async function check(name, fn) {
  let counted
  try {
    counted = await fn()
  } catch (error) {
    // 失败时点名用例：否则只有一条孤零零的 AssertionError，看不出是哪一处在报。
    // `stack` 与 `message` 都要改 —— 未捕获错误打印的是 stack，首行在构造时已写死。
    error.message = `【${name}】${error.message}`
    error.stack = `【${name}】${error.stack}`
    throw error
  }
  if (counted === false) return
  passed++
  console.log(`  ✓ ${name}`)
}

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }
})

console.log('契约常量与投影')

await check('auditFields 与 DEFAULT_CONFIG 的键一一对应，且不含 personas', () => {
  const fields = auditFields()
  assert.deepEqual(fields, Object.keys(DEFAULT_CONFIG).sort(), '应从 DEFAULT_CONFIG 推导，避免将来加字段时两边漂移')
  assert.ok(!fields.includes('personas'), 'personas 不是活动配置字段，它的变化单独记为事件')
  assert.ok(Object.isFrozen(fields) === false, 'auditFields() 返回副本，调用方改它不该影响内部状态')
  fields.push('注入的键')
  assert.ok(!auditFields().includes('注入的键'), '每次调用都应返回独立副本')
})

await check('来源与动作是枚举白名单，覆盖设计文档列出的全部取值', () => {
  assert.deepEqual(HISTORY_SOURCES.slice().sort(), ['command', 'persona', 'restorePersona', 'rollback', 'service', 'tool', 'web'])
  for (const action of ['save', 'reset', 'use', 'savePreset', 'deletePreset', 'restorePreset', 'nickname', 'enable', 'disable', 'set', 'confirm', 'setPersona', 'update']) {
    assert.ok(HISTORY_ACTIONS.includes(action), `动作 ${action} 应被接受（index.mjs 有这条写路径）`)
  }
})

await check('historyPathFor 把配置路径换成兄弟文件，不改动其余部分', () => {
  assert.equal(historyPathFor('/home/u/.dsh/soul-config.json'), '/home/u/.dsh/soul-config.history.jsonl')
  assert.equal(historyPathFor('C:\\Users\\u\\.dsh\\soul-config.json'), 'C:\\Users\\u\\.dsh\\soul-config.history.jsonl')
  // 不以外层 .json 结尾时只做追加：路径是照约定拼出来的，不该猜用户意图
  assert.equal(historyPathFor('/tmp/other'), '/tmp/other.history.jsonl')
  assert.equal(historyPathFor(''), '.history.jsonl')
})

await check('createEntryId 形态固定，随机段长度为 6', () => {
  const id = createEntryId(BASE_MS, randomSuffix())
  assert.match(id, /^[0-9a-z]{1,12}-[0-9a-f]{6}$/, `实际得到 ${id}`)
  assert.match(randomSuffix(), /^[0-9a-f]{6}$/)
  assert.notEqual(randomSuffix(), randomSuffix(), '同一毫秒内两次写入必须拿到不同的 id')
})

console.log('指纹')

await check('hashConfig 与键的插入顺序无关（否则回滚会把正常状态判成漂移）', () => {
  const a = { style: 'humorous', emoji: 'more', nickname: '张三' }
  const b = { nickname: '张三', emoji: 'more', style: 'humorous' }
  assert.equal(hashConfig(a), hashConfig(b), '同一份配置在「写入时构造」与「读盘后重建」两条路径上键序不同')
  assert.notEqual(hashConfig(a), hashConfig({ ...a, style: 'casual' }))
  assert.notEqual(hashConfig(a), hashConfig({ ...a, emoji: 'less' }))
  assert.notEqual(hashConfig(a), hashConfig({ ...a, nickname: '李四' }))
  assert.equal(hashConfig(a), hashConfig({ ...a, personas: { 老张: { style: 'roast' } } }), '预设库变化不该动摇活动的配置指纹')
  assert.equal(hashConfig(a), hashConfig({ ...a, 内部缓存: 1 }), '内存态字段不该参与指纹')
  assert.equal(hashConfig(null), hashConfig({}), '非对象按空对象处理，不抛')
  // 今天 AUDIT_FIELDS 全是标量，所以上面那条其实靠「投影按键名顺序遍历」就已成立；
  // 这一条才真正钉住 canonicalize 的深度排序 —— 它是给将来出现结构化字段时兜底的，
  // 少了它，「嵌套对象键序不同」会算出两个指纹并把正常状态判成漂移。
  assert.equal(
    hashConfig({ style: { a: 1, b: 2 } }),
    hashConfig({ style: { b: 2, a: 1 } }),
    '指纹必须对嵌套对象的键序也不敏感'
  )
})

console.log('差分')

await check('diffFields 只记发生变化的字段，未变的字段两侧都不出现', () => {
  const prev = { ...DEFAULT_CONFIG, nickname: '张三', style: 'professional' }
  const next = { ...prev, nickname: '李四' }
  const { before, after } = diffFields(prev, next)
  assert.deepEqual(before, { nickname: '张三' })
  assert.deepEqual(after, { nickname: '李四' })
  assert.ok(!('style' in before) && !('style' in after), '没变的字段不该出现在记录里')
  assert.equal(Object.keys(diffFields(prev, prev).before).length, 0, '没有变化时两侧都应为空')
})

await check('diffFields 跳过 personas，也跳过白名单外的键', () => {
  const prev = { ...DEFAULT_CONFIG, personas: { 甲: { style: 'roast' } } }
  const next = { ...prev, personas: { 甲: { style: 'roast' }, 乙: { style: 'casual' } }, 未知键: 1 }
  const { before, after } = diffFields(prev, next)
  assert.equal(Object.keys(before).length, 0)
  assert.equal(Object.keys(after).length, 0, '预设库与未知键都不能被当成活动配置的变化')
})

await check('diffFields 只记存在的一侧（undefined 无法用 JSON 表达）', () => {
  const { before, after } = diffFields({ style: 'humorous' }, { emoji: 'more' })
  assert.deepEqual(before, { style: 'humorous' })
  assert.deepEqual(after, { emoji: 'more' })
  const gone = diffFields({ ...DEFAULT_CONFIG, nickname: '张三' }, { ...DEFAULT_CONFIG, nickname: undefined })
  assert.deepEqual(gone.before, { nickname: '张三' })
  assert.deepEqual(gone.after, {}, '「切到 undefined」不记，否则回滚会被一条不存在的值误导')
})

await check('diffPersonas 记下新增、覆盖与删除，且覆盖与删除都带原内容', () => {
  const prev = {
    甲: { style: 'roast', updatedAt: '2026-01-01T00:00:00.000Z' },
    乙: { style: 'casual' },
    丙: { style: 'humorous' }
  }
  const next = {
    甲: { style: 'roast', updatedAt: '2026-01-01T00:00:00.000Z' },
    乙: { style: 'professional' },
    丁: { style: 'efficient' }
  }
  const events = diffPersonas(prev, next)
  assert.deepEqual(events.added, ['丁'])
  assert.deepEqual(events.removed, [{ name: '丙', entry: { style: 'humorous' } }], '删除是唯一不可逆的操作，原内容必须留底')
  assert.deepEqual(events.updated, [{ name: '乙', entry: { style: 'casual' } }], '覆盖同样会丢掉原内容')
  assert.ok(hasPersonaEvents(events))
  assert.ok(!hasPersonaEvents(diffPersonas(prev, prev)), '没有变化时不该报事件')
  assert.ok(!hasPersonaEvents(undefined), '缺席按「没有事件」处理')
})

await check('只改了 updatedAt 不算覆盖（「原样再存一遍」不该留下假记录）', () => {
  const prev = { 甲: { style: 'roast', emoji: 'more', updatedAt: '2026-01-01T00:00:00.000Z' } }
  const next = { 甲: { style: 'roast', emoji: 'more', updatedAt: '2026-06-06T06:06:06.000Z' } }
  const events = diffPersonas(prev, next)
  assert.deepEqual(events.updated, [], '更新元数据不等于覆盖内容；假记录会让时间线失去可信度')
  assert.ok(!hasPersonaEvents(events))
})

await check('diffPersonas 忽略保留键，不把原型污染键当成预设名', () => {
  // 用 JSON.parse 造出**自有**的 __proto__ 属性 —— 对象字面量里的 `__proto__: {...}`
  // 只是在设置原型，根本不会产生一个可枚举的自有键，那种写法测不到任何东西。
  const injected = JSON.parse('{"__proto__": {"style": "roast"}, "constructor": {"style": "casual"}, "正常": {"style": "humorous"}}')
  assert.deepEqual(diffPersonas({}, injected).added, ['正常'])
  // 反方向：injected → {} 会删掉「正常」，但保留键仍不得作为删除记录出现
  // （否则一次原型污染键就能在时间线上留下一行指向 Object.prototype 的删除）。
  assert.deepEqual(diffPersonas(injected, {}).removed.map((item) => item.name), ['正常'])
  assert.equal(Object.prototype.style, undefined, '读取过程不得污染 Object.prototype')
})

console.log('条目构造与校验')

await check('buildHistoryEntry 组装出规范条目，字段按白名单投影', () => {
  const entry = makeEntry({
    before: { style: 'professional', 未知键: 'x' },
    after: { style: 'humorous', 未知键: 'y' },
    personas: { added: ['甲'], updated: [], removed: [] }
  })
  assert.equal(entry.v, HISTORY_VERSION)
  assert.deepEqual(entry.before, { style: 'professional' })
  assert.deepEqual(entry.after, { style: 'humorous' })
  assert.deepEqual(entry.personas, { added: ['甲'], updated: [], removed: [] })
  assert.deepEqual(Object.keys(entry).sort(), ['action', 'after', 'at', 'before', 'configHash', 'id', 'personas', 'source', 'v'])
  // label：可选的人类可读上下文（如「应用了哪个预设」）。没传就不该出现这个键 ——
  // 空字符串的 label 比没有 label 更糟，它会在界面上渲染成一个悬空的「：」。
  const labeled = makeEntry({ label: '苏格拉底式提问者' })
  assert.equal(labeled.label, '苏格拉底式提问者')
  assert.equal('label' in makeEntry({}), false, '没给 label 的条目不得带空 label 键')
  assert.equal(makeEntry({ label: '  ' }).label, undefined, '空白 label 丢弃 —— 不能留下一个看起来「有上下文」的空串')
})

await check('label 超长丢弃但不拒绝整条记录（它只影响显示，不影响指纹与回滚）', () => {
  const good = makeEntry({ label: 'x'.repeat(121) })
  const entry = normalizeHistoryEntry(good)
  assert.ok(entry, 'label 超长不得让整条记录被丢 —— 丢一条真实变更比丢一句文案严重得多')
  assert.equal(entry.label, undefined)
  const fine = normalizeHistoryEntry(makeEntry({ label: 'x'.repeat(120) }))
  assert.equal(fine.label, 'x'.repeat(120), '恰好在上限内的 label 必须保留')
})

await check('normalizeHistoryEntry 对形状可疑的条目一律丢弃（它会被写回配置）', () => {
  const good = makeEntry({})
  assert.ok(normalizeHistoryEntry(good), '合法条目必须通过')
  const broken = [
    null,
    'not an object',
    [],
    { ...good, v: 2 },
    { ...good, v: '1' },
    { ...good, id: 'no-dash' },
    { ...good, id: `${'x'.repeat(70)}-abcdef` },
    { ...good, id: 'abc-ABCDEF' },
    { ...good, at: 'not a date' },
    { ...good, at: 1234 },
    { ...good, at: 'x'.repeat(41) },
    { ...good, source: 'webhook' },
    { ...good, source: 'WEB' },
    { ...good, action: 'delete' },
    { ...good, configHash: 'abc' },
    { ...good, configHash: 'A'.repeat(64) },
    { ...good, before: {}, after: {}, personas: { added: [], updated: [], removed: [] } }
  ]
  for (const raw of broken) {
    assert.equal(normalizeHistoryEntry(raw), null, `应被丢弃：${JSON.stringify(raw)}`)
  }
})

await check('normalizeHistoryEntry 一律丢弃原型污染键（它会进配置）', () => {
  const good = makeEntry({})
  const entry = normalizeHistoryEntry(JSON.parse(JSON.stringify({ ...good, 额外字段: 1 })))
  assert.equal(entry.额外字段, undefined, '未知字段不该被透传')
  const polluted = normalizeHistoryEntry({
    ...good,
    before: JSON.parse('{"style": "casual", "__proto__": {"污染": true}}'),
    personas: JSON.parse('{"added": [], "updated": [], "removed": [{"name": "甲", "entry": {"style": "roast"}}]}')
  })
  assert.deepEqual(polluted.before, { style: 'casual' })
  assert.equal(Object.prototype.污染, undefined)
  assert.deepEqual(Object.keys(polluted.before), ['style'])
})

await check('归一条目时过滤保留键与超长预设名', () => {
  const entry = normalizeHistoryEntry({
    ...makeEntry({}),
    personas: {
      added: ['好名字', '', 'x'.repeat(31)],
      updated: [{ name: 'constructor', entry: {} }, { name: '乙', entry: { style: 'casual', 额外: 1 } }],
      removed: [{ name: '甲', entry: { style: 'roast', 额外: 1 } }, 'not an object']
    }
  })
  assert.deepEqual(entry.personas.added, ['好名字'], '空名与超长名丢弃')
  assert.deepEqual(entry.personas.updated, [{ name: '乙', entry: { style: 'casual' } }], '保留键当预设名要丢弃，条目内容按白名单投影')
  assert.deepEqual(entry.personas.removed, [{ name: '甲', entry: { style: 'roast' } }])
})

console.log('JSONL 解析')

await check('serializeEntry / parseHistoryText 往返一致', () => {
  const first = makeEntry({ before: { nickname: '张三' }, after: { nickname: '李四' } })
  const second = makeEntry({ source: 'command', action: 'set', before: { emoji: 'default' }, after: { emoji: 'more' } })
  const { entries, dropped, truncated } = parseHistoryText(first && second ? `${serializeEntry(first)}${serializeEntry(second)}` : '')
  assert.equal(dropped, 0)
  assert.equal(truncated, false)
  assert.deepEqual(entries, [first, second], '解析结果必须与写入的原对象等价')
  assert.equal(serializeEntry(first).endsWith('\n'), true, '每条记录占一行')
  assert.equal(parseHistoryText('').entries.length, 0, '空文件不是坏文件')
  assert.equal(parseHistoryText('').truncated, false)
})

await check('坏行被丢弃并计数，好行照常可用', () => {
  const good = makeEntry({})
  const text = [
    serializeEntry(good),
    '{ 这不是 JSON\n',
    '\n',
    '   \n',
    '[1,2,3]\n',
    `${JSON.stringify({ ...good, v: 9 })}\n`,
    serializeEntry(good)
  ].join('')
  const { entries, dropped } = parseHistoryText(text)
  assert.equal(entries.length, 2, '一条坏行不该让整个列表打不开')
  assert.equal(dropped, 3, '坏 JSON / 形状不对的行计入 dropped；空行不算')
})

await check('超长行被丢弃，不会把内存吃满', () => {
  const good = makeEntry({})
  const huge = `${JSON.stringify({ ...makeEntry({}), 填充: 'x'.repeat(64 * 1024) })}\n`
  const { entries, dropped } = parseHistoryText(`${serializeEntry(good)}${huge}`)
  assert.equal(entries.length, 1)
  assert.equal(dropped, 1)
})

await check('末尾没有换行 ⇒ 报告 truncated 且丢掉那半行', () => {
  const good = makeEntry({})
  const half = `${JSON.stringify(makeEntry({}))}`.slice(0, 40)
  const { entries, dropped, truncated } = parseHistoryText(`${serializeEntry(good)}${half}`)
  assert.equal(truncated, true, '上次追加被打断必须如实上报，planRollback 会据此拒绝回滚')
  assert.equal(dropped, 1)
  assert.deepEqual(entries, [good])
})

await check('超过 MAX_READ_LINES 时丢掉最老的，保留最近的，并与 dropped 分开计数', () => {
  const total = MAX_READ_LINES + 5
  let text = ''
  const ids = []
  for (let i = 0; i < total; i++) {
    const entry = makeEntry({ id: createEntryId(BASE_MS + i, 'abcdef') })
    ids.push(entry.id)
    text += serializeEntry(entry)
  }
  const { entries, dropped, trimmed } = parseHistoryText(text)
  assert.equal(entries.length, MAX_READ_LINES)
  assert.equal(trimmed, 5, '被窗口切掉的是合法条目，不是坏行')
  assert.equal(dropped, 0, '把合法行算进 dropped 会让 UI 报「有 5 行无法解析」，而文件里一个坏行都没有')
  assert.equal(entries[0].id, ids[5], '日志的价值集中在最近，从头截断会把最该看到的几条丢掉')
  assert.equal(entries[entries.length - 1].id, ids[ids.length - 1])
  const response = toHistoryResponse({ entries, dropped, trimmed, truncated: false, trimmedHead: false, error: null }, null)
  assert.match(response.warning, new RegExp(`最近的 ${MAX_READ_LINES} 条`))
})

await check('pruneEntries 保留尾部并保序（顺序是 planRollback 的判据）', () => {
  const entries = []
  for (let i = 0; i < MAX_ENTRIES + 50; i++) entries.push(makeEntry({ id: createEntryId(BASE_MS + i, 'abcdef') }))
  const pruned = pruneEntries(entries)
  assert.equal(pruned.length, MAX_ENTRIES)
  assert.equal(pruned[0].id, entries[50].id)
  assert.equal(pruned[pruned.length - 1].id, entries[entries.length - 1].id)
  assert.deepEqual(pruned.map((e) => e.id), entries.slice(50).map((e) => e.id), '不得重排')
  assert.equal(pruneEntries(entries.slice(0, 3)).length, 3)
  assert.deepEqual(pruneEntries(null), [])
})

await check('findEntryIndex 按 id 定位，找不到返回 -1', () => {
  const a = makeEntry({})
  const b = makeEntry({})
  const list = [a, b]
  assert.equal(findEntryIndex(list, a.id), 0)
  assert.equal(findEntryIndex(list, b.id), 1)
  assert.equal(findEntryIndex(list, '什么都没有-abcdef'), -1)
  assert.equal(findEntryIndex(null, a.id), -1)
})

console.log('文件读写')

await check('文件不存在 ⇒ 空列表且不算错误', async () => {
  const read = await readHistoryFile(freshPath())
  assert.deepEqual(read.entries, [])
  assert.equal(read.error, null, '第一次记录之前的正常状态')
  assert.equal(read.dropped, 0)
  assert.equal(read.truncated, false)
})

await check('追加后可读回；目录会自动创建', async () => {
  const p = join(root, 'nested', 'deep', 'soul-config.history.jsonl')
  const first = makeEntry({})
  const second = makeEntry({})
  await appendHistoryEntry(p, first)
  await appendHistoryEntry(p, second)
  const read = await readHistoryFile(p)
  assert.equal(read.error, null)
  assert.deepEqual(read.entries, [first, second], '物理顺序 = 时间顺序（最老在前）')
  assert.ok(readFileSync(p, 'utf8').endsWith('\n'), '每条记录都以换行结尾（否则下次读取会报 truncated）')
})

await check('记录路径是一个目录 ⇒ 报错而不是安静地读成「还没有记录」', async () => {
  const p = freshPath('dir-as-history')
  mkdirSync(p) // 真的建个目录：路径不存在走的是 ENOENT 那条分支，测不到这里要覆盖的行为
  const read = await readHistoryFile(p)
  // 目录能被打开发、size 为 0。不显式判断的话会读成空列表 —— UI 上永远显示
  // 「还没有变更记录」，而用户无从知道文件根本读不了。
  assert.deepEqual(read.entries, [])
  assert.equal(typeof read.error, 'string', `必须给出可展示的原因，实际得到 ${JSON.stringify(read.error)}`)
  assert.match(read.error, /目录/)
  const response = toHistoryResponse(read, null)
  assert.match(response.warning, /目录/, '警告要能传到 UI')
})

// 造一个「每行等长」的记录文件：读取窗口切在哪里，只由行长与文件长度决定，
// 于是两个边界都能被精确构造出来（不靠碰运气调余数）。
//
//   行长整除 MAX_READ_BYTES  ⇒ 起点必然落在行首，首行完整
//   行长不整除              ⇒ 起点必然落在行中间，首行是半行
//
// 返回的 ids 与文件里的行一一对应（最老在前），这样期望值可以写成精确的 id 序列 ——
// 只断言条数的话，「丢首行」与「少读一行」会互相掩盖。
function buildUniformLines(lineBytes, count) {
  const base = makeEntry({ id: createEntryId(BASE_MS, 'abcdef'), before: { nickname: '' }, after: { nickname: 'x' } })
  const emptyLen = Buffer.byteLength(serializeEntry(base))
  assert.ok(lineBytes > emptyLen, `行长 ${lineBytes} 必须大于基础行长 ${emptyLen}，否则补不出目标长度`)
  const ids = []
  let text = ''
  for (let i = 0; i < count; i++) {
    const id = createEntryId(BASE_MS + i, 'abcdef')
    ids.push(id)
    text += serializeEntry(
      makeEntry({ id, at: new Date(BASE_MS + i * 1000).toISOString(), before: { nickname: 'a'.repeat(lineBytes - emptyLen) }, after: { nickname: 'x' } })
    )
  }
  assert.equal(Buffer.byteLength(text), lineBytes * count, '测试用例必须造出等长行')
  return { text, ids, size: lineBytes * count }
}

// 两个窗口边界用例的行长都必须让「窗口内的行数」落在 MAX_READ_LINES 以下。
// 否则条数上限会先把老条目整个切掉，两个边界算出的结果完全相同 ——
// 断言看着在跑，其实对任何一边都没有判别力（这正是本文件被自己抓到的第二次教训）。
function windowLinesFor(lineBytes, count) {
  const size = lineBytes * count
  const start = size - MAX_READ_BYTES
  assert.ok(start > 0, '文件必须大于读取窗口，否则走不到尾部读取这条路')
  const remainder = start % lineBytes
  const cut = remainder === 0 ? 0 : lineBytes - remainder
  const windowLines = Math.floor((MAX_READ_BYTES - cut) / lineBytes)
  assert.ok(windowLines < MAX_READ_LINES, `窗口 ${windowLines} 行撞上了条数上限 ${MAX_READ_LINES}，断言会失去判别力`)
  return { cut, windowLines }
}

await check('切在行中间 ⇒ 丢掉那半行（不能把半截 JSON 当成记录）', async () => {
  // 9000 不整除 MAX_READ_BYTES（4194304），窗口起点必然落在某一行内部。
  // 这条路径覆盖「首行是半行」：不丢的话 JSON.parse 失败，会变成 dropped=1 的误报。
  const lineBytes = 9000
  const count = Math.ceil(MAX_READ_BYTES / lineBytes) + 8
  const { text, ids } = buildUniformLines(lineBytes, count)
  const { cut, windowLines } = windowLinesFor(lineBytes, count)
  assert.ok(cut > 0, '本用例必须切在行中间')
  const p = freshPath('huge-mid-line')
  writeFileSync(p, text, 'utf8')
  const read = await readHistoryFile(p)
  assert.equal(read.error, null)
  assert.equal(read.trimmedHead, true, '超出上限时要如实上报「只读了一部分」')
  assert.equal(read.dropped, 0, '被窗口切掉的头不算坏行 —— 它只是没被读到')
  assert.equal(read.trimmed, 0, '窗口没撞上条数上限，不该有 trimmed')
  assert.equal(read.truncated, false)
  assert.equal(read.entries.length, windowLines, `半行被丢掉后应剩 ${windowLines} 条`)
  assert.deepEqual(read.entries.map((e) => e.id), ids.slice(ids.length - read.entries.length), '返回的必须是连续的尾部，不能中间挖洞')
  assert.equal(read.entries[read.entries.length - 1].id, ids[ids.length - 1], '最新的那条永远在')
})

await check('★ 切在行首 ⇒ 首行是完整的，必须保留（别用「一律丢首行」偷懒）', async () => {
  // 8192 整除 MAX_READ_BYTES（4194304 = 8192 × 512）⇒ 起点正好落在行首。
  // 一律丢首行的话，这里会静默少一条 —— 少的那条会让 planRollback 的指纹校验失败，
  // 表现为「回滚突然说记录和配置对不上」，而用户什么都没做错。
  // 行长的选择有约束：窗口内的行数（512）必须低于 MAX_READ_LINES，否则条数上限先动手，
  // 「有没有丢首行」就淹没在「被上限切掉」里了。
  const lineBytes = 8192
  const count = MAX_READ_BYTES / lineBytes + 8
  const { text, ids } = buildUniformLines(lineBytes, count)
  const { cut, windowLines } = windowLinesFor(lineBytes, count)
  assert.equal(cut, 0, '本用例必须切在行首')
  const p = freshPath('huge-line-aligned')
  writeFileSync(p, text, 'utf8')
  const read = await readHistoryFile(p)
  assert.equal(read.error, null)
  assert.equal(read.trimmedHead, true, '只读了尾部这件事与首行完不完整无关，都要上报')
  assert.equal(read.dropped, 0)
  assert.equal(read.trimmed, 0)
  assert.equal(read.truncated, false)
  assert.equal(read.entries.length, windowLines, `行首对齐时必须保留每一个完整行（期望 ${windowLines} 条，实际 ${read.entries.length}）`)
  // 精确到 id：被窗口切掉的是最前面 8 条，之后的每一条都必须在
  assert.deepEqual(read.entries.map((e) => e.id), ids.slice(8))
})

await check('recordHistoryEntry 正常追加，超限时压实并保留最近的 MAX_ENTRIES 条', async () => {
  const p = freshPath('compact')
  const first = makeEntry({})
  const result = await recordHistoryEntry(p, first)
  assert.deepEqual(result, { compacted: false, kept: 0, dropped: 0 }, '幸福路径只有一次 stat，不做压实')
  assert.equal((await readHistoryFile(p)).entries.length, 1)

  // 造一个超过字节阈值、且坏行混在其中的文件：压实应顺手扔掉坏行（自愈），
  // 但 dropped 的计数必须在**读取时**就报告出去，不能等到压实才发现行少了。
  // 坏行放在**末尾**：条数超过 MAX_READ_LINES 时开头会被窗口切掉，
  // 那时的行属于「没读到」而不是「读不懂」，放进 dropped 就成了误报。
  const junk = '{ 手改坏的行\n'
  const filler = serializeEntry(makeEntry({ id: createEntryId(BASE_MS, 'abcdef'), before: { bio: 'x'.repeat(40) }, after: { bio: 'y'.repeat(40) } }))
  const times = Math.ceil(MAX_BYTES / Buffer.byteLength(filler)) + 10
  writeFileSync(p, filler.repeat(times) + junk, 'utf8')
  const last = makeEntry({})
  const compacted = await recordHistoryEntry(p, last)
  assert.equal(compacted.compacted, true, '超过字节阈值必须压实')
  assert.equal(compacted.dropped, 1, '坏行计数要如实回报')
  const after = await readHistoryFile(p)
  assert.equal(after.error, null)
  assert.equal(after.entries.length, MAX_ENTRIES, '压实后只保留最近的 MAX_ENTRIES 条')
  assert.equal(after.entries[after.entries.length - 1].id, last.id, '刚写的那条绝不能丢')
  assert.equal(after.dropped, 0, '压实后坏行消失（自愈），不再重复计数')
  assert.ok(!readFileSync(p, 'utf8').includes('手改坏的行'))
})

await check('clearHistoryFile 返回被清掉的条数并删除文件', async () => {
  const p = freshPath('clear')
  assert.equal(await clearHistoryFile(p), 0, '文件不存在时清空是幂等的')
  await appendHistoryEntry(p, makeEntry({}))
  await appendHistoryEntry(p, makeEntry({}))
  assert.equal(await clearHistoryFile(p), 2)
  assert.equal(existsSync(p), false, '留空文件会让「有没有记录」多出第三种状态')
  assert.equal(await clearHistoryFile(p), 0)
})

console.log('回滚规划')

await check('目标条目不存在 ⇒ missing（不猜「大概是指这一条」）', () => {
  const entry = makeEntry({})
  const plan = planRollback([entry], DEFAULT_CONFIG, '什么都没-abcdef')
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'missing')
  assert.deepEqual(plan.patch, {})
  assert.equal(planRollback([], DEFAULT_CONFIG, 'x-abcdef').reason, 'missing')
})

await check('单条变更撤销 ⇒ 还原 before 的值（含点最新那条）', () => {
  const c0 = { ...DEFAULT_CONFIG }
  const c1 = { ...c0, style: 'humorous' }
  const entry = makeEntry({ configHash: hashConfig(c1), before: { style: 'professional' }, after: { style: 'humorous' } })
  const plan = planRollback([entry], c1, entry.id)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.patch, { style: 'professional' })
  assert.deepEqual(plan.reversed, [entry.id], '点的那条本身必须被撤销，否则它对最新一条永远是空操作')
  assert.deepEqual({ ...c1, ...plan.patch }, c0)
  assert.deepEqual(plan.skipped, [])
})

await check('撤销最新一条必须真的改掉它（不能因为「已在那个状态」而无操作）', () => {
  // 行上写着「style: professional → humorous」，点「撤销」就必须让 style 回到 professional。
  // 曾经的实现算的是「这条刚做完的样子」= 当前状态本身，于是这行的撤销按钮是个摆设。
  const c0 = { ...DEFAULT_CONFIG }
  const c1 = { ...c0, nickname: '新' }
  const c2 = { ...c1, headingLists: 'more' }
  const e1 = makeEntry({ configHash: hashConfig(c1), before: { nickname: '' }, after: { nickname: '新' } })
  const e2 = makeEntry({ configHash: hashConfig(c2), before: { headingLists: 'default' }, after: { headingLists: 'more' } })

  const newest = planRollback([e1, e2], c2, e2.id)
  assert.equal(newest.ok, true)
  assert.deepEqual(newest.patch, { headingLists: 'default' }, '撤销最新一条应只退掉它自己那次改动')
  assert.deepEqual({ ...c2, ...newest.patch }, c1)

  const older = planRollback([e1, e2], c2, e1.id)
  assert.deepEqual(older.patch, { headingLists: 'default', nickname: '' }, '撤销较早一条要连带撤销它之后的')
  assert.deepEqual({ ...c2, ...older.patch }, c0)
})

await check('目标条目之后还有多次改动 ⇒ 逐条反向撤销，算出「那时之前」的状态', () => {
  const c0 = { ...DEFAULT_CONFIG }
  const c1 = { ...c0, style: 'humorous' }
  const c2 = { ...c1, emoji: 'more' }
  const c3 = { ...c2, tables: 'less' }
  const e1 = makeEntry({ configHash: hashConfig(c1), before: { style: 'professional' }, after: { style: 'humorous' } })
  const e2 = makeEntry({ configHash: hashConfig(c2), before: { emoji: 'default' }, after: { emoji: 'more' } })
  const e3 = makeEntry({ configHash: hashConfig(c3), before: { tables: 'default' }, after: { tables: 'less' } })

  const toC0 = planRollback([e1, e2, e3], c3, e1.id)
  assert.equal(toC0.ok, true)
  assert.deepEqual(toC0.patch, { style: 'professional', emoji: 'default', tables: 'default' })
  assert.deepEqual(toC0.reversed, [e3.id, e2.id, e1.id], '从新到旧撤销，含目标条目')
  assert.deepEqual({ ...c3, ...toC0.patch }, c0, '结果必须精确等于那一刻的配置')

  const toC1 = planRollback([e1, e2, e3], c3, e2.id)
  assert.deepEqual({ ...c3, ...toC1.patch }, c1)

  const toC2 = planRollback([e1, e2, e3], c3, e3.id)
  assert.deepEqual({ ...c3, ...toC2.patch }, c2)
})

await check('撤销动作本身也能被撤销（链式语义自洽）', () => {
  const c0 = { ...DEFAULT_CONFIG }
  const c1 = { ...c0, replyLength: 'concise' }
  const c2 = { ...c1, headingLists: 'more' }
  const e1 = makeEntry({ configHash: hashConfig(c1), before: { replyLength: 'normal' }, after: { replyLength: 'concise' } })
  const e2 = makeEntry({ configHash: hashConfig(c2), before: { headingLists: 'default' }, after: { headingLists: 'more' } })
  const plan = planRollback([e1, e2], c2, e1.id)
  const restored = { ...c2, ...plan.patch }
  assert.deepEqual(restored, c0)
  // 撤销动作自己也会记一条（source='rollback'），于是它能被再撤销回去。
  // 注意记的是**被替换掉的值**（c2 的），不是那条补丁本身 —— before/after 描述的是
  // 配置在两个状态之间的迁移，不是「怎么写」。写错这一处会让撤销不可逆。
  const undo = makeEntry({
    source: 'rollback',
    action: 'set',
    configHash: hashConfig(restored),
    before: { replyLength: 'concise', headingLists: 'more' },
    after: { replyLength: 'normal', headingLists: 'default' }
  })
  const back = planRollback([e1, e2, undo], restored, undo.id)
  assert.equal(back.ok, true)
  assert.deepEqual(back.patch, { replyLength: 'concise', headingLists: 'more' })
  assert.deepEqual({ ...restored, ...back.patch }, c2, '撤销之后仍然可以撤销回去')
})

await check('配置与记录不同步 ⇒ 拒绝（宁可报错，也不算出没存在过的状态）', () => {
  const c1 = { ...DEFAULT_CONFIG, style: 'humorous' }
  const entry = makeEntry({ configHash: hashConfig(c1), before: { style: 'professional' }, after: { style: 'humorous' } })
  const drifted = { ...c1, style: 'casual' }
  const plan = planRollback([entry], drifted, entry.id)
  assert.equal(plan.ok, false)
  assert.equal(plan.reason, 'diverged')
  assert.deepEqual(plan.patch, {}, '拒绝时必须没有补丁，调用方才能安全地什么都不做')

  // 与审计无关的字段变化不该动摇链条（用户存了个预设、或外观调整）
  assert.equal(planRollback([entry], { ...c1, personas: { 甲: { style: 'roast' } } }, entry.id).ok, true)
})

await check('链条中间断掉也要拒绝（一次没记上的变更不能被忽略）', () => {
  const c0 = { ...DEFAULT_CONFIG }
  const c1 = { ...c0, style: 'humorous' }
  const c2 = { ...c1, emoji: 'more' }
  const c3 = { ...c2, tables: 'less' }
  const e1 = makeEntry({ configHash: hashConfig(c1), before: { style: 'professional' }, after: { style: 'humorous' } })
  // e2 的指纹被手改成别的（等价于「有一次变更没能记下」）
  const e2 = makeEntry({ configHash: hashConfig({ ...c2, tables: 'less' }), before: { emoji: 'default' }, after: { emoji: 'more' } })
  const e3 = makeEntry({ configHash: hashConfig(c3), before: { tables: 'default' }, after: { tables: 'less' } })
  const plan = planRollback([e1, e2, e3], c3, e1.id)
  assert.equal(plan.ok, false, '撤销链假设记录与配置同步；断链时撤销会产出混合状态')
  assert.equal(plan.reason, 'diverged')
})

await check('记录里出现当前 schema 不接受的值 ⇒ skipped 如实回报，不写入也不静默丢弃', () => {
  const c1 = { ...DEFAULT_CONFIG, style: 'humorous', emoji: 'more' }
  const entry = makeEntry({ configHash: hashConfig(c1), before: { style: '绝无此风格', emoji: 'default' }, after: { style: 'humorous', emoji: 'more' } })
  const plan = planRollback([entry], c1, entry.id)
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.patch, { emoji: 'default' }, '非法值必须被 sanitizeConfig 拦下')
  assert.deepEqual(plan.skipped, ['style'], '被拦下的字段名要回报给用户')
})

await check('回滚补丁不会把记录里的未知字段或保留键带进配置', () => {
  const c1 = { ...DEFAULT_CONFIG, nickname: '新' }
  const raw = {
    ...makeEntry({ configHash: hashConfig(c1), before: { nickname: '旧' }, after: { nickname: '新' } }),
    before: { nickname: '旧', 未知字段: 'x', __proto__: { 污染: true }, personas: { 甲: {} } }
  }
  const entry = normalizeHistoryEntry(raw)
  const plan = planRollback([entry], c1, entry.id)
  assert.deepEqual(plan.patch, { nickname: '旧' })
  assert.equal(Object.getPrototypeOf(plan.patch), Object.prototype)
  assert.equal(Object.prototype.污染, undefined, '原型污染键必须在读侧就被剔掉')
})

console.log('读取结果的对外形状')

await check('toHistoryResponse 倒序输出并汇总警告', () => {
  const a = makeEntry({})
  const b = makeEntry({})
  const clean = toHistoryResponse({ entries: [a, b], dropped: 0, truncated: false, trimmedHead: false, error: null }, null)
  assert.deepEqual(clean.entries, [b, a], '最新在前：倒序只在服务端做一次，避免两边规则漂移')
  assert.equal(clean.max, MAX_ENTRIES)
  assert.equal(clean.warning, null)

  const messy = toHistoryResponse(
    { entries: [a], dropped: 3, truncated: true, trimmedHead: true, error: '读取失败（EACCES）' },
    '磁盘写满'
  )
  assert.equal(messy.entries.length, 1)
  assert.match(messy.warning, /读取失败（EACCES）/)
  assert.match(messy.warning, /变更记录写入失败：磁盘写满/)
  assert.match(messy.warning, /末尾不完整/)
  assert.match(messy.warning, /只读取了最近的部分/)
  assert.match(messy.warning, /有 3 行无法解析/)
})

console.log('模块边界')

await check('lib/history.mjs 不依赖 cordis、不引用提示词编译（可独立加载并测试）', () => {
  const text = readFileSync(new URL('../lib/history.mjs', import.meta.url), 'utf8')
  assert.ok(!/from\s+'cordis'/.test(text), '审计层必须能脱离宿主被加载')
  assert.ok(!/compilePrompt|systemPrompt|injectPromptToAllAgents/.test(text), '记录内容绝不进提示词（隐私边界）')
  assert.ok(!/console\./.test(text), '库模块不打印；诊断经返回值交给调用方')
  // 上面两条只看代码，所以先把注释行剔掉 —— 否则「说明隐私边界的注释」本身
  // 会被当成违反边界（这条断言第一次跑就是这么红的）。
  const code = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
  assert.ok(!/提示词|prompt/i.test(code), `只有代码不该提到提示词，实际代码里出现：${(code.match(/.*(提示词|prompt).*/i) || [])[0]}`)
})

if (!assertCount('verify-history', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
