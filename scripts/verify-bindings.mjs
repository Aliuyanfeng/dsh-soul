// scripts/verify-bindings.mjs — 人设工作区绑定层自检（纯函数 + 真实文件系统）
//
// 与 verify-config.mjs / verify-store.mjs / verify-history.mjs 的分工：这里只管
// lib/bindings.mjs —— 路径怎么规范化、前缀怎么匹配、坏掉的绑定表会怎样。
//
// 这个模块的失败模式**全都长得很安静**，所以断言必须打在那些安静的错误上：
//
//   - 裸 startsWith 让 `D:\项目A` 命中 `D:\项目AB`（两个在磁盘上毫无关系的目录）；
//   - 大小写折算漏做，于是 `d:\项目a` 与 `D:\项目A` 在 Windows 上被当成两条绑定；
//   - 失效人设**没有**回落到父级绑定，而是直接掉到全局（用户在子目录里静默换人）；
//   - 一条手改坏的行让整张绑定表打不开；
//   - realpath 失败（目录已删 / 网络盘离线）把整个设置页带崩。
//
// 语义显式传入（sep / caseInsensitive），不读 process.platform：CI 在 ubuntu、开发机在
// Windows，若断言跟着平台跑，两边的「绿」就不是同一件事了。
//
// 零依赖，直接 `node scripts/verify-bindings.mjs` 运行。

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BINDINGS_VERSION,
  MAX_BINDINGS,
  MAX_PATH_LENGTH,
  bindingRefusal,
  bindingsPathFor,
  compareKey,
  isAbsoluteDirPath,
  matchBindings,
  normalizeBindingEntry,
  normalizeDirPath,
  parseBindingsDocument,
  pathMatches,
  readBindingsFile,
  resolveDirIdentity,
  resolvePersonaForCwd,
  sanitizeBindings,
  serializeBindings,
  writeBindingsFile
} from '../lib/bindings.mjs'
import { DEFAULT_CONFIG, PERSONA_NAME_MAX } from '../lib/config.mjs'
import { assertCount } from './lib/skip-report.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-soul-bindings-'))
// 断言条数写死：新增/删除用例时数字必须一起改（见 skip-report.mjs 的约定 3）。
const EXPECTED_ASSERTIONS = 47

// Windows 语义与 POSIX 语义各一份，两套都在这台机器上跑 —— 平台相关的分支
// 因此不可能因为「我这里恰好是 Windows」而蒙混过关。
const WIN = { sep: '\\', caseInsensitive: true }
const POSIX = { sep: '/', caseInsensitive: false }

let fileSeq = 0
function freshPath(label = 'soul-bindings.json') {
  fileSeq += 1
  return join(root, `${fileSeq}-${label}`)
}

let passed = 0
async function check(name, fn) {
  let counted
  try {
    counted = await fn()
  } catch (error) {
    // 失败时点名用例：否则只有一条孤零零的 AssertionError，看不出是哪一处在报。
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

console.log('契约常量')

await check('契约常量与设计文档一致，且不随平台漂移', () => {
  assert.equal(BINDINGS_VERSION, 1)
  assert.equal(MAX_PATH_LENGTH, 512)
  assert.equal(MAX_BINDINGS, 200)
})

await check('bindingsPathFor 与配置文件同目录，复用它的目录而不是重读环境变量', () => {
  assert.equal(bindingsPathFor('/home/u/.dsh/soul-config.json'), '/home/u/.dsh/soul-bindings.json')
  assert.equal(bindingsPathFor('C:\\Users\\u\\.dsh\\soul-config.json'), 'C:\\Users\\u\\.dsh\\soul-bindings.json')
  // 测试里换一个配置路径，绑定文件必须跟着走 —— 否则断言会写到真实的 $DSH_HOME 上。
  assert.equal(bindingsPathFor('/tmp/xxx/soul-config.json'), '/tmp/xxx/soul-bindings.json')
})

console.log('路径规范化')

await check('normalizeDirPath 统一分隔符并去掉尾部分隔符', () => {
  assert.equal(normalizeDirPath('D:/项目A/', WIN), 'D:\\项目A')
  assert.equal(normalizeDirPath('D:\\项目A\\\\子', WIN), 'D:\\项目A\\子')
  assert.equal(normalizeDirPath('/home/u/proj/', POSIX), '/home/u/proj')
  assert.equal(normalizeDirPath('  /home/u/proj  ', POSIX), '/home/u/proj')
})

await check('normalizeDirPath 保留盘根与 POSIX 根，不把它们削成 D: 或空串', () => {
  assert.equal(normalizeDirPath('D:\\', WIN), 'D:\\')
  assert.equal(normalizeDirPath('D:/', WIN), 'D:\\')
  assert.equal(normalizeDirPath('/', POSIX), '/')
  assert.equal(normalizeDirPath('//', POSIX), '/')
})

await check('normalizeDirPath 保留 UNC 前缀，不被折叠成单斜杠', () => {
  const out = normalizeDirPath('\\\\server\\share\\', WIN)
  assert.ok(out.startsWith('\\\\'), `UNC 前缀必须保留，实际：${JSON.stringify(out)}`)
  assert.equal(out, '\\\\server\\share')
})

await check('normalizeDirPath 对非法输入返回 null，不抛错', () => {
  assert.equal(normalizeDirPath(null, WIN), null)
  assert.equal(normalizeDirPath(undefined, WIN), null)
  assert.equal(normalizeDirPath(42, WIN), null)
  assert.equal(normalizeDirPath('', WIN), null)
  assert.equal(normalizeDirPath('   ', WIN), null)
  assert.equal(normalizeDirPath('D:\\项目\0A', WIN), null, 'NUL 字节必须拒绝')
})

await check('isAbsoluteDirPath 认三种绝对形态，且拒绝盘符相对路径', () => {
  assert.equal(isAbsoluteDirPath('D:\\项目A'), true)
  assert.equal(isAbsoluteDirPath('D:/项目A'), true)
  assert.equal(isAbsoluteDirPath('/home/u'), true)
  assert.equal(isAbsoluteDirPath('\\\\server\\share'), true)
  // `D:项目A` 的含义取决于 D 盘当时的当前目录，不能当绝对路径
  assert.equal(isAbsoluteDirPath('D:项目A'), false)
  assert.equal(isAbsoluteDirPath('项目A'), false)
  assert.equal(isAbsoluteDirPath('..\\项目A'), false)
  assert.equal(isAbsoluteDirPath(''), false)
  assert.equal(isAbsoluteDirPath(null), false)
})

await check('compareKey 只在 Windows 语义下折大小写（存原样、比折叠）', () => {
  assert.equal(compareKey('D:\\项目A', WIN), 'd:\\项目a')
  assert.equal(compareKey('D:\\项目A', POSIX), 'D:\\项目A')
  // 展示形态不受影响 —— UI 上给用户看的必须是他磁盘上的名字
  assert.equal(normalizeDirPath('D:\\项目A', WIN), 'D:\\项目A')
})

console.log('前缀匹配（整个功能最容易写错的一行）')

await check('★ 路径边界：D:\\项目A 不得命中 D:\\项目AB', () => {
  assert.equal(pathMatches('D:\\项目A', 'D:\\项目A', WIN), true, '同一个目录必须命中')
  assert.equal(pathMatches('D:\\项目A\\src', 'D:\\项目A', WIN), true, '子目录必须命中')
  assert.equal(
    pathMatches('D:\\项目AB', 'D:\\项目A', WIN),
    false,
    '★ 前缀必须落在路径边界上：裸 startsWith 会让 项目A 命中 项目AB'
  )
  assert.equal(pathMatches('D:\\项目AB\\src', 'D:\\项目A', WIN), false, '★ 同上（带子目录）')
  assert.equal(pathMatches('D:\\项目A-备份', 'D:\\项目A', WIN), false, '★ 连字符同样不是边界')
})

await check('★ POSIX 下同样落在边界上', () => {
  assert.equal(pathMatches('/home/u/proj/src', '/home/u/proj', POSIX), true)
  assert.equal(pathMatches('/home/u/projX', '/home/u/proj', POSIX), false, '★ /home/u/projX 不是 /home/u/proj 的子目录')
  assert.equal(pathMatches('/home/u/pro', '/home/u/proj', POSIX), false, '反向前缀同样不成立')
})

await check('大小写折算参与匹配，但不影响展示', () => {
  assert.equal(pathMatches('d:\\项目a\\SRC', 'D:\\项目A', WIN), true)
  assert.equal(pathMatches('/Home/U/Proj', '/home/u/proj', POSIX), false, 'POSIX 大小写敏感')
})

await check('盘根作前缀时不会拼出双分隔符（D:\\\\ → D:\\\\项目A 应命中）', () => {
  assert.equal(pathMatches('D:\\项目A', 'D:\\', WIN), true)
  assert.equal(pathMatches('/', '/', POSIX), true)
  assert.equal(pathMatches('/home', '/', POSIX), true)
})

await check('pathMatches 对空串与非法输入一律返回 false，不抛错', () => {
  assert.equal(pathMatches('', 'D:\\项目A', WIN), false)
  assert.equal(pathMatches('D:\\项目A', '', WIN), false)
  assert.equal(pathMatches(null, 'D:\\项目A', WIN), false)
  assert.equal(pathMatches('D:\\项目A', undefined, WIN), false)
})

console.log('最长前缀优先')

await check('matchBindings 按具体程度从高到低返回，子绑定排在父绑定之前', () => {
  const table = {
    'D:\\项目A': '资深架构师',
    'D:\\项目A\\实验性重构': '头脑风暴伙伴',
    'D:\\项目AB': '极简主义者'
  }
  const hits = matchBindings('D:\\项目A\\实验性重构\\src', table, WIN)
  assert.deepEqual(hits.map((h) => h.dir), ['D:\\项目A\\实验性重构', 'D:\\项目A'], '最长前缀必须排在最前')
  assert.equal(hits[0].persona, '头脑风暴伙伴')

  // ★ 同一条匹配路径上，项目AB 的绑定不得混进来
  assert.deepEqual(matchBindings('D:\\项目AB\\x', table, WIN).map((h) => h.dir), ['D:\\项目AB'])
})

await check('matchBindings 对没有任何绑定的目录返回空数组，不回落成「全都命中」', () => {
  const table = { 'D:\\项目A': '资深架构师' }
  assert.deepEqual(matchBindings('E:\\别的项目', table, WIN), [])
  assert.deepEqual(matchBindings('', table, WIN), [])
  assert.deepEqual(matchBindings('D:\\项目A', null, WIN), [], '空表不得抛错')
  assert.deepEqual(matchBindings('D:\\项目A', ['D:\\项目A'], WIN), [], '数组不是绑定表')
})

await check('matchBindings 结果顺序稳定（同一份表任何时候给出同一顺序）', () => {
  // 两条绑定的目录名长度相同、深度也相同 ⇒ 只能靠兜底排序定序，否则顺序取决于
  // Object.keys 的插入顺序，UI 上表现为「每次刷新行顺序都在跳」。
  const table = { 'D:\\b项目': 'A', 'D:\\a项目': 'B' }
  const first = matchBindings('D:\\a项目\\x', table, WIN).map((h) => h.dir)
  const table2 = { 'D:\\a项目': 'B', 'D:\\b项目': 'A' }
  const second = matchBindings('D:\\a项目\\x', table2, WIN).map((h) => h.dir)
  assert.deepEqual(first, second, '插入顺序不同的等价表必须给出同样的顺序')
})

console.log('三层解析与失效引用')

await check('resolvePersonaForCwd 命中绑定且人设存在时直接生效', () => {
  const table = { 'D:\\项目A': '资深架构师' }
  const hit = resolvePersonaForCwd('D:\\项目A\\src', table, {}, WIN)
  assert.equal(hit.dir, 'D:\\项目A')
  assert.equal(hit.persona, '资深架构师')
  assert.deepEqual(hit.shadowed, [])
})

await check('★ 失效人设回落到父级绑定，而不是直接掉到全局', () => {
  const table = { 'D:\\项目A': '资深架构师', 'D:\\项目A\\子': '早就删掉的预设' }
  const hit = resolvePersonaForCwd('D:\\项目A\\子\\x', table, {}, WIN)
  assert.ok(hit, '父级绑定可用时必须回落到它')
  assert.equal(hit.persona, '资深架构师')
  assert.deepEqual(hit.shadowed, [{ dir: 'D:\\项目A\\子', persona: '早就删掉的预设', reason: 'missing-persona' }],
    '被跳过的更具体绑定必须如实报出来，否则用户在子目录里看到别的人设只会以为坏了')
})

await check('全部绑定都失效时返回 null（由调用方回落全局配置）', () => {
  const table = { 'D:\\项目A': '不存在的人设' }
  assert.equal(resolvePersonaForCwd('D:\\项目A\\x', table, {}, WIN), null)
})

await check('内置人设是合法的绑定目标（不可删但可绑）', () => {
  const { BUILTIN_PERSONAS } = { BUILTIN_PERSONAS: null }
  // 不 import 内置表：只用「苏格拉底式提问者」这个名字，它是内置的既定事实
  const table = { 'D:\\项目A': '苏格拉底式提问者' }
  const hit = resolvePersonaForCwd('D:\\项目A', table, {}, WIN)
  assert.ok(hit, '内置人设必须能被绑定命中')
  assert.equal(hit.persona, '苏格拉底式提问者')
  assert.equal(BUILTIN_PERSONAS, null)
})

await check('用户自建人设同样可被绑定命中', () => {
  const table = { 'D:\\项目A': '我的自定义人设' }
  const userPersonas = { 我的自定义人设: { style: 'casual' } }
  assert.equal(resolvePersonaForCwd('D:\\项目A', table, userPersonas, WIN).persona, '我的自定义人设')
})

console.log('绑定表校验（读侧一律当不可信输入）')

await check('sanitizeBindings 丢弃坏条目并计数，不因一条坏记录让整表失效', () => {
  const raw = {
    'D:\\项目A': '资深架构师',
    'relative': 'X',
    'D:\\B': '',
    'D:\\C': 42,
    'D:\\D': '好'.repeat(PERSONA_NAME_MAX + 1),
    'D:\\E': '__proto__'
  }
  const { bindings, dropped } = sanitizeBindings(raw, WIN)
  assert.deepEqual(bindings, { 'D:\\项目A': '资深架构师' }, '合法条目必须全部保留')
  // 逐条对应而不是「排序后比个数」：后者在两条记录互换原因时照样通过
  assert.deepEqual(
    dropped.map((d) => [d.dir, d.reason]),
    [
      ['relative', 'not-absolute'],
      ['D:\\B', 'invalid-persona'],
      ['D:\\C', 'invalid-persona'],
      ['D:\\D', 'invalid-persona'],
      ['D:\\E', 'invalid-persona']
    ]
  )
})

await check('★ 拒绝原型污染键（__proto__ / constructor / prototype）', () => {
  const raw = JSON.parse('{"__proto__":"资深架构师","constructor":"资深架构师","prototype":"资深架构师"}')
  const { bindings, dropped } = sanitizeBindings(raw, WIN)
  assert.deepEqual(Object.keys(bindings), [], '保留字一个都不能进表')
  assert.equal(dropped.length, 3)
  assert.ok(dropped.every((d) => d.reason === 'reserved-key'))
  assert.equal(Object.getPrototypeOf(bindings), Object.prototype, '原型不得被污染')
})

await check('sanitizeBindings 把同一条绑定的两种写法归一成一条', () => {
  const { bindings } = sanitizeBindings({ 'D:/项目A/': 'A', 'D:\\项目A': 'B' }, WIN)
  assert.deepEqual(Object.keys(bindings), ['D:\\项目A'], '归一化后撞车的两条只留一条')
  assert.equal(bindings['D:\\项目A'], 'B', '后出现的写法覆盖先出现的（同一条绑定，不是损坏）')
})

await check('sanitizeBindings 拒绝超长路径与相对路径，且不截断', () => {
  const longDir = 'D:\\' + 'x'.repeat(MAX_PATH_LENGTH)
  const { bindings, dropped } = sanitizeBindings({ [longDir]: '资深架构师' }, WIN)
  assert.deepEqual(bindings, {}, '超长路径必须整条拒绝 —— 截断出来的路径再也命中不了任何会话')
  assert.equal(dropped[0].reason, 'path-too-long')
})

await check('sanitizeBindings 对空表与非对象输入都能安全返回', () => {
  assert.deepEqual(sanitizeBindings(null, WIN).bindings, {})
  assert.deepEqual(sanitizeBindings(undefined, WIN).bindings, {})
  assert.deepEqual(sanitizeBindings([], WIN).dropped, [{ dir: null, reason: 'not-object' }])
  assert.deepEqual(sanitizeBindings('x', WIN).dropped, [{ dir: null, reason: 'not-object' }])
})

await check('条数超过上限后拒绝新增，但已存在的键仍可改绑', () => {
  const raw = {}
  for (let i = 0; i < MAX_BINDINGS + 3; i++) raw[`D:\\目录${i}`] = '资深架构师'
  const { bindings, dropped } = sanitizeBindings(raw, WIN)
  assert.equal(Object.keys(bindings).length, MAX_BINDINGS, '表必须有界')
  assert.equal(dropped.filter((d) => d.reason === 'too-many').length, 3)
})

console.log('绑定文件解析')

await check('parseBindingsDocument 缺省与 null 都当空表，且不算失败', () => {
  for (const value of [undefined, null]) {
    const out = parseBindingsDocument(value, WIN)
    assert.deepEqual(out.bindings, {})
    assert.equal(out.failure, null, '「还没有绑定文件」是正常状态，不是失败')
  }
})

await check('★ 版本不认识时整表忽略并给出说明，不猜测字段语义', () => {
  const out = parseBindingsDocument({ version: 99, bindings: { 'D:\\项目A': '资深架构师' } }, WIN)
  assert.deepEqual(out.bindings, {}, '版本不符时宁可暂时不生效，也不能解析出一堆假绑定')
  assert.match(out.failure, /99/)
  assert.match(out.failure, /1/)
})

await check('非对象内容与缺 version 的文档都能被安全处理', () => {
  assert.match(parseBindingsDocument([1, 2], WIN).failure, /不是一个对象/)
  assert.match(parseBindingsDocument('x', WIN).failure, /不是一个对象/)
  assert.equal(parseBindingsDocument({ bindings: { 'D:\\项目A': '资深架构师' } }, WIN).failure, null,
    'version 字段缺席按当前版本处理（早期手写文件）')
})

await check('serializeBindings 的输出能被自己读回去（读写幂等）', () => {
  const source = { 'D:\\项目A': '资深架构师', 'D:\\项目A\\子': '头脑风暴伙伴' }
  const doc = serializeBindings(source)
  assert.equal(doc.version, BINDINGS_VERSION)
  const back = parseBindingsDocument(doc, WIN)
  assert.deepEqual(back.bindings, source)
})

await check('serializeBindings 过滤保留键，且不修改调用方的对象', () => {
  // 用 JSON.parse 而不是字面量：`{"__proto__": ...}` 经 JSON.parse 会成为**自有可枚举
  // 属性**，而字面量里的 `__proto__:` 是设原型，根本进不了 Object.keys —— 那种写法下
  // 这条断言会被自己的前置条件架空（判断力对照实测过这个漏法）。
  const source = JSON.parse('{"__proto__":"X","constructor":"Y","prototype":"Z"}')
  source['D:\\项目A'] = '资深架构师'
  assert.deepEqual(
    Object.keys(source).sort(),
    ['D:\\项目A', '__proto__', 'constructor', 'prototype'].sort(),
    '前置条件：三个保留键必须真的在源对象里，否则本断言没有判别力'
  )

  const doc = serializeBindings(source)
  assert.deepEqual(Object.keys(doc.bindings), ['D:\\项目A'], '保留键一个都不能落到输出里')
  assert.ok(
    !Object.prototype.hasOwnProperty.call(doc.bindings, 'constructor'),
    'constructor 落在输出里会污染后续所有 `x.constructor` 读取'
  )
  assert.equal(Object.getPrototypeOf(doc.bindings), Object.prototype, '原型不得被污染')
  assert.ok(Object.prototype.hasOwnProperty.call(source, 'D:\\项目A'), '调用方的对象不应被就地改动')
  assert.equal(Object.keys(source).length, 4, '调用方的对象既不该增键也不该减键')
})

console.log('realpath 解析（符号链接 / Junction）')

await check('★ realpath 失败（目录已删 / 网络盘离线）时保留规范化形态，绝不抛错', async () => {
  const boom = async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) }
  const out = await resolveDirIdentity('D:\\早就不存在的目录', WIN, boom)
  assert.equal(out, 'D:\\早就不存在的目录', '离线盘不该让整个设置页崩掉')
})

await check('realpath 成功时采用解析结果，保证 Junction 与真实路径同一条绑定', async () => {
  const fake = async (p) => (p === 'D:\\链接' ? 'D:\\真实目录' : p)
  assert.equal(await resolveDirIdentity('D:\\链接', WIN, fake), 'D:\\真实目录')
  assert.equal(await resolveDirIdentity('D:\\链接\\子', WIN, fake), 'D:\\链接\\子', 'realpath 只解析它收到的整个路径')
})

await check('resolveDirIdentity 对非法输入返回 null，且不调用 realpath', async () => {
  let called = 0
  const spy = async (p) => { called++; return p }
  assert.equal(await resolveDirIdentity('', WIN, spy), null)
  assert.equal(await resolveDirIdentity(null, WIN, spy), null)
  assert.equal(called, 0, '非法输入必须在校验阶段就挡掉，不产生多余 IO')
})

console.log('写入准入')

await check('bindingRefusal 拒绝相对路径、超长路径与不存在的人设', () => {
  assert.match(bindingRefusal('相对\\目录', '资深架构师', {}), /绝对路径/)
  assert.match(bindingRefusal('D:\\' + 'x'.repeat(MAX_PATH_LENGTH), '资深架构师', {}), /过长/)
  assert.match(bindingRefusal('D:\\项目A', '并不存在的人设', {}), /不存在/)
  assert.match(bindingRefusal('D:\\项目A', '', {}), /不合法/)
})

await check('★ 人设不存在时拒绝写入（typo 不该被当成「绑定生效了」）', () => {
  const userPersonas = { 我的自定义人设: { style: 'casual' } }
  assert.equal(bindingRefusal('D:\\项目A', '我的自定义人设', userPersonas), null, '存在的自建人设必须放行')
  assert.equal(bindingRefusal('D:\\项目A', '苏格拉底式提问者', userPersonas), null, '内置人设必须放行')
  const refusal = bindingRefusal('D:\\项目A', '我的自定义人设 ', userPersonas)
  assert.equal(refusal, null, '名字两侧空白按 trim 后判定（sanitizePersonaName 的语义）')
  assert.match(bindingRefusal('D:\\项目A', '我的自定人设', userPersonas), /不存在/, '少一个字就是不存在')
})

await check('normalizeBindingEntry 归一的是「写什么」，且与 bindingRefusal 同口径', () => {
  const userPersonas = { 我的自定义人设: { style: 'casual' } }
  // 键与值两侧都要归一：只归一一边，就会出现「拒绝时按 trim 后的名字判、写进表里的是原串」
  assert.deepEqual(
    normalizeBindingEntry(' D:/项目A/ ', ' 我的自定义人设 ', userPersonas, WIN),
    { dir: 'D:\\项目A', persona: '我的自定义人设' }
  )
  assert.equal(normalizeBindingEntry('D:\\项目A', '并不存在的人设', userPersonas, WIN), null)
  assert.equal(normalizeBindingEntry('相对路径', '资深架构师', {}, WIN), null)
  assert.equal(normalizeBindingEntry('', '资深架构师', {}, WIN), null)
  // ★ 归一化后的键必须能被 matchBindings 原样命中 —— 否则「写进去的」与「匹配用的」
  // 就是两套形态，表现是「绑定保存成功但从没生效」。
  const entry = normalizeBindingEntry(' D:/项目A/ ', '资深架构师', {}, WIN)
  assert.deepEqual(
    matchBindings('D:\\项目A\\src', { [entry.dir]: entry.persona }, WIN).map((hit) => hit.dir),
    [entry.dir]
  )
  // `..` 刻意不被文本折叠（见 normalizeDirPath 注释）：折错了会命中别的目录，
  // 不折的后果只是这条绑定命中不了 —— 失败方向必须是安全的那一侧。
  assert.equal(normalizeBindingEntry('D:/项目A/../B', '资深架构师', {}, WIN).dir, 'D:\\项目A\\..\\B')
})

console.log('真实文件系统')

await check('写入后读回得到同一张表，且文件形状与设计文档一致', async () => {
  const file = freshPath()
  await writeBindingsFile(file, { 'D:\\项目A': '资深架构师' })
  const text = readFileSync(file, 'utf8')
  const doc = JSON.parse(text)
  assert.equal(doc.version, BINDINGS_VERSION)
  assert.deepEqual(doc.bindings, { 'D:\\项目A': '资深架构师' })

  const back = await readBindingsFile(file, WIN)
  assert.deepEqual(back.bindings, { 'D:\\项目A': '资深架构师' })
  assert.equal(back.failure, null)
  assert.equal(back.exists, true)
})

await check('绑定文件不存在时是「首次运行」而不是失败', async () => {
  const out = await readBindingsFile(freshPath('不存在.json'), WIN)
  assert.deepEqual(out.bindings, {})
  assert.equal(out.failure, null)
  assert.equal(out.exists, false)
})

await check('★ 绑定文件损坏时移开原文件、以空表继续，并报出备份位置', async () => {
  const file = freshPath('损坏.json')
  writeFileSync(file, '{ 这不是合法 JSON', 'utf8')
  const out = await readBindingsFile(file, WIN)
  assert.deepEqual(out.bindings, {}, '损坏时必须能继续工作（绑定是环境事实，不是用户唯一的数据副本）')
  assert.match(out.failure, /备份到/)
  assert.ok(out.movedAside && out.movedAside.endsWith('.corrupt'), '原文件必须被挪到 .corrupt')
  // 移开之后原路径不再存在 ⇒ 下一次读取回到「首次运行」的正常分支
  const again = await readBindingsFile(file, WIN)
  assert.equal(again.failure, null)
  assert.equal(again.exists, false)
})

await check('读到的坏条目只丢弃并计数，其余绑定照常生效', async () => {
  const file = freshPath('混了坏行.json')
  writeFileSync(file, JSON.stringify({
    version: BINDINGS_VERSION,
    bindings: { 'D:\\项目A': '资深架构师', '相对路径': 'X' }
  }), 'utf8')
  const out = await readBindingsFile(file, WIN)
  assert.deepEqual(out.bindings, { 'D:\\项目A': '资深架构师' })
  assert.equal(out.dropped.length, 1)
  assert.equal(out.failure, null, '个别坏条目不是文件级失败')
})

await check('写入是原子的：临时文件不会残留', async () => {
  const file = freshPath('原子.json')
  await writeBindingsFile(file, { 'D:\\项目A': '资深架构师' })
  await writeBindingsFile(file, { 'D:\\项目A': '极简主义者' })
  const { readdirSync } = await import('node:fs')
  const leftover = readdirSync(root).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftover, [], '同目录 rename 之后不应留下 .tmp')
  assert.equal((await readBindingsFile(file, WIN)).bindings['D:\\项目A'], '极简主义者')
})

console.log('端到端：目录 → 人设')

await check('★ 三层解析：目录绑定胜过全局，且不碰到兄弟目录', () => {
  const table = { 'D:\\项目A': '资深架构师', 'D:\\项目A\\实验性重构': '头脑风暴伙伴' }
  const userPersonas = {}
  const globalPersona = DEFAULT_CONFIG.style

  const resolve = (cwd) => {
    const hit = resolvePersonaForCwd(cwd, table, userPersonas, WIN)
    return hit ? hit.persona : globalPersona
  }

  assert.equal(resolve('D:\\项目A'), '资深架构师')
  assert.equal(resolve('D:\\项目A\\src\\deep\\nested'), '资深架构师', '子目录继承')
  assert.equal(resolve('D:\\项目A\\实验性重构'), '头脑风暴伙伴', '更具体的绑定优先')
  assert.equal(resolve('D:\\项目AB'), globalPersona, '★ 兄弟目录回落全局，不得被 项目A 命中')
  assert.equal(resolve('E:\\无关目录'), globalPersona, '未绑定目录回落全局')
})

await check('★ 子代理场景：子代理继承父会话 cwd ⇒ 拿到同一个人设', () => {
  // 宿主 childSessionMeta(parent, childDepth, isSeeded) 原样继承 parentHeader.cwd。
  // 这正是「目录是主键」的理由：纯会话键下子代理会静默回落全局。
  const table = { 'D:\\项目A': '资深架构师' }
  const parentCwd = 'D:\\项目A'
  const childCwd = parentCwd
  assert.equal(
    resolvePersonaForCwd(childCwd, table, {}, WIN).persona,
    resolvePersonaForCwd(parentCwd, table, {}, WIN).persona
  )
})

console.log('模块边界')

await check('lib/bindings.mjs 不依赖 cordis、不把路径写进提示词、不打印', () => {
  const text = readFileSync(new URL('../lib/bindings.mjs', import.meta.url), 'utf8')
  assert.ok(!/from\s+'cordis'/.test(text), '绑定层必须能脱离宿主被加载')
  assert.ok(!/compilePrompt|systemPrompt|injectPromptToAllAgents/.test(text), '绑定只用于选人设，绝不进提示词（隐私边界）')
  assert.ok(!/console\./.test(text), '库模块不打印；诊断经返回值交给调用方')
  const code = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(!/提示词|prompt/i.test(code), `只有代码不该提到提示词，实际代码里出现：${(code.match(/.*(提示词|prompt).*/i) || [])[0]}`)
})

await check('lib/bindings.mjs 复用 lib/store.mjs 的 IO 原语，不另造一套原子写', () => {
  const text = readFileSync(new URL('../lib/bindings.mjs', import.meta.url), 'utf8')
  assert.match(text, /import \{[^}]*readConfigFile[^}]*\} from '\.\/store\.mjs'/)
  assert.match(text, /import \{[^}]*writeConfigFile[^}]*\} from '\.\/store\.mjs'/)
  assert.match(text, /import \{[^}]*moveAsideConfigFile[^}]*\} from '\.\/store\.mjs'/)
  assert.ok(!/writeFile\(/.test(text), '原子写只有一处实现（store.mjs），这里不得直接 writeFile')
})

if (!assertCount('verify-bindings', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
