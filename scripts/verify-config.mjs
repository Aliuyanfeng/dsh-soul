// scripts/verify-config.mjs — 配置层纯函数自检（npm run verify）
//
// 覆盖 lib/config.mjs 的 migrateConfig / sanitizeConfig：
//   - 旧版本 style+tone 迁移、废弃字段清理、特质脏数据回退
//   - 白名单 / 类型 / 长度 / 枚举校验的接受与拒绝路径
// 覆盖 lib/personas.mjs 的内置人设与合并 / 匹配语义（含「应用后必须命中自己」闭环）。
// 另含清单契约自检：插件图标（DSH 在 app-boot 的 iconOf 中判定）、前后端契约一致性。
// 零依赖，直接 `node scripts/verify-config.mjs` 运行。

import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_CONFIG,
  FIELD_LIMITS,
  HISTORY_MAX_ENTRIES_DEFAULT,
  HISTORY_MAX_ENTRIES_MAX,
  HISTORY_MAX_ENTRIES_MIN,
  LANGUAGE_VALUES,
  PERSONA_FIELDS,
  PERSONA_NAME_MAX,
  PROFILE_FIELDS,
  PROMPT_INPUT_FIELDS,
  REPLY_LENGTH_VALUES,
  STYLE_VALUES,
  TRAIT_VALUES,
  clampHistoryMaxEntries,
  migrateConfig,
  normalizePersonas,
  sanitizeConfig,
  sanitizePersonaName
} from '../lib/config.mjs'
import { MAX_ENTRIES, auditFields } from '../lib/history.mjs'
import {
  BUILTIN_PERSONAS,
  builtinPersonaNames,
  declaredPersonaKeys,
  isBuiltinPersona,
  mergePersonas,
  personaMatches,
  resolvePersona
} from '../lib/personas.mjs'
import { assertCount, skipNote } from './lib/skip-report.mjs'

// 基线运行应跑出的断言数。跑完时校验，防止「脚本加/删用例」与文档口径悄悄脱节。
//
// 注意：本脚本没有环境相关的跳过分支（只读仓库内的文件与纯函数，不依赖浏览器 / DSH /
// 平台能力），所以链里的 `--strict` 对它是空操作 —— 这是**事实描述**，不是缺陷。
// 它的数字由这里的 assertCount 守住；需要 --strict 的是那些有跳过能力的脚本。
const EXPECTED_ASSERTIONS = 141

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failures.push({ name, err })
    console.log(`  ✗ ${name}`)
    console.log(`      ${String(err && err.message || err).split('\n')[0]}`)
  }
}

// 按括号配平取出从 anchor 起的那一个对象字面量。
// 扫描时会跳过字符串与行注释 —— 文案里出现的 `{n}` 占位符、行尾的 `// {` 之类
// 都不该影响配平（否则「取出来的对象」会一路吃到文件末尾）。
function extractObject(source, anchor) {
  const at = source.indexOf(anchor)
  if (at === -1) return ''
  let i = source.indexOf('{', at)
  if (i === -1) return ''
  const from = i
  let depth = 0
  let quote = null
  for (; i < source.length; i++) {
    const c = source[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return source.slice(from, i + 1) }
  }
  return source.slice(from)
}

// 键必须是「行首（允许缩进）的 key:」—— 只按 `\w+:` 扫会把文案里的冒号误判成键
// （例如 'Use /soul: show' 里的 soul）。
function objectKeys(text) {
  const keys = new Set()
  for (const m of text.matchAll(/^[ \t]*(?:'([^']+)'|"([^"]+)"|([A-Za-z_$][\w$]*))\s*:/gm)) {
    keys.add(m[1] ?? m[2] ?? m[3])
  }
  return keys
}

// 剥离行注释 / 块注释（字符串内容保留——它们是真实代码的一部分）。
// **长度保持不变**：被剥掉的字符以空格占位。这样剥离结果与原串共享同一套下标，
// extractCall 才能先在剥离文本上定位锚点、再回原串切片。
// 所有「对源码做正则断言」的地方都应先过这一步：否则把真实调用注释掉、在注释里留下
// 同样的字样，断言就被 satisfies（M5 类漏洞，变异实验实测可绕过）。
function stripComments(source) {
  const out = source.split('')
  let i = 0
  let quote = null
  const blank = (from, to) => { for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ' }
  while (i < source.length) {
    const c = source[i]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      blank(i, nl === -1 ? source.length : nl)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const to = end === -1 ? source.length : end + 2
      blank(i, to)
      i = to
      continue
    }
    i++
  }
  return out.join('')
}

// 从 anchor 起按括号配平取出**完整调用**文本。定位与配平都在**去注释后**的文本上进行
// （注释里的 anchor 与不等宽括号都不该影响判定），再回**原串**切片 —— stripComments
// 刻意保持长度不变，两套文本共享同一套下标。
// anchor 可带可不带 `(`：`skipExit(` 与 `e('span', { ... }`（调用括号在 anchor 内）都支持，
// 一律取「anchor 起点之后的第一个 `(`」作为配平起点。
// 之所以不用缩进/固定窗口猜终点：后者会随代码重排而捕获越界或假失败（徽标断言曾用
// `\s{22}` 定界，实测把摘要列、操作区全部吞进捕获，断言失去判断力）。
function extractCall(source, anchor) {
  const stripped = stripComments(source)
  const at = stripped.indexOf(anchor)
  if (at === -1) return ''
  let open = -1
  for (let i = at; i < stripped.length; i++) {
    if (stripped[i] === '(') { open = i; break }
    if (stripped[i] === '\n' && i > at + anchor.length) return ''
  }
  if (open === -1) return ''
  let depth = 0
  let quote = null
  for (let i = open; i < stripped.length; i++) {
    const c = stripped[i]
    if (quote) {
      if (c === '\\') { i++; continue }
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return source.slice(at, i + 1) }
  }
  return ''
}

// 取某个具名文案表内 zh / en 各自的键集（表名 → 在表内定位 `zh: {` / `en: {`）。
function tableLangKeys(source, tableName, lang) {
  const at = source.indexOf(`const ${tableName} = {`)
  if (at === -1) return new Set()
  return objectKeys(extractObject(source.slice(at), lang === 'zh' ? 'zh: {' : 'en: {'))
}

console.log('migrateConfig')

check('非对象输入返回默认配置', () => {
  assert.deepEqual(migrateConfig(null), DEFAULT_CONFIG)
  assert.deepEqual(migrateConfig(undefined), DEFAULT_CONFIG)
})

check('正常配置原样保留并补齐默认值', () => {
  const config = migrateConfig({ enabled: false, nickname: '小明', style: 'roast', language: 'en' })
  assert.equal(config.enabled, false)
  assert.equal(config.nickname, '小明')
  assert.equal(config.style, 'roast')
  assert.equal(config.language, 'en')
  assert.equal(config.headingLists, 'default')
  assert.equal(config.emoji, 'default')
})

check('v0.1.x style+tone 组合迁移', () => {
  assert.equal(migrateConfig({ style: 'professional', tone: 'formal' }).style, 'professional')
  assert.equal(migrateConfig({ style: 'casual', tone: 'neutral' }).style, 'casual')
  assert.equal(migrateConfig({ style: 'humorous', tone: 'informal' }).style, 'humorous')
})

check('v0.1.x 旧 style 名迁移（friendly→casual，academic→professional）', () => {
  assert.equal(migrateConfig({ style: 'friendly', tone: 'neutral' }).style, 'casual')
  assert.equal(migrateConfig({ style: 'academic', tone: 'formal' }).style, 'professional')
})

check('废弃字段 tone / presets / examples 清理', () => {
  const config = migrateConfig({ nickname: 'x', tone: 'formal', presets: [1], examples: 'y' })
  assert.equal('tone' in config, false)
  assert.equal('presets' in config, false)
  assert.equal('examples' in config, false)
})

check('特质脏数据回退为默认值', () => {
  const config = migrateConfig({ headingLists: 'always', emoji: 1 })
  assert.equal(config.headingLists, 'default')
  assert.equal(config.emoji, 'default')
})

console.log('sanitizeConfig')

check('合法补丁全部通过', () => {
  const { patch, errors } = sanitizeConfig({
    enabled: false,
    nickname: '小明',
    occupation: '工程师',
    bio: '写代码的',
    style: 'humorous',
    headingLists: 'more',
    emoji: 'less',
    language: 'en',
    customInstructions: '保持简洁'
  })
  assert.deepEqual(errors, {})
  assert.equal(patch.enabled, false)
  assert.equal(patch.nickname, '小明')
  assert.equal(patch.occupation, '工程师')
  assert.equal(patch.style, 'humorous')
  assert.equal(patch.headingLists, 'more')
  assert.equal(patch.emoji, 'less')
  assert.equal(patch.language, 'en')
  assert.equal(patch.customInstructions, '保持简洁')
})

check('未知字段静默丢弃（不进入 patch，也不报错）', () => {
  const { patch, errors } = sanitizeConfig({ nickname: 'x', hacked: 'junk', presets: [1] })
  assert.deepEqual(errors, {})
  assert.deepEqual(patch, { nickname: 'x' })
})

check('类型错误被拒绝：enabled 非布尔、文本非字符串', () => {
  const { errors } = sanitizeConfig({ enabled: 'yes', nickname: 123 })
  assert.ok(errors.enabled)
  assert.ok(errors.nickname)
})

check('枚举错误被拒绝：style / headingLists / emoji / language', () => {
  const { errors } = sanitizeConfig({ style: 'hacker', headingLists: 'always', emoji: 'max', language: 'jp' })
  assert.ok(errors.style)
  assert.ok(errors.headingLists)
  assert.ok(errors.emoji)
  assert.ok(errors.language)
})

check('超长文本被拒绝且不截断', () => {
  const { errors, patch } = sanitizeConfig({
    nickname: '名'.repeat(FIELD_LIMITS.nickname + 1),
    customInstructions: 'a'.repeat(FIELD_LIMITS.customInstructions + 1)
  })
  assert.ok(errors.nickname)
  assert.ok(errors.customInstructions)
  assert.equal('nickname' in patch, false)
  assert.equal('customInstructions' in patch, false)
})

check('长度上限边界值通过', () => {
  const { errors } = sanitizeConfig({
    nickname: '名'.repeat(FIELD_LIMITS.nickname),
    bio: 'b'.repeat(FIELD_LIMITS.bio),
    customInstructions: 'a'.repeat(FIELD_LIMITS.customInstructions)
  })
  assert.deepEqual(errors, {})
})

check('文本字段首尾空白被 trim，空白串视为清除', () => {
  const { patch, errors } = sanitizeConfig({ nickname: '  小明  ', bio: '   ' })
  assert.deepEqual(errors, {})
  assert.equal(patch.nickname, '小明')
  assert.equal(patch.bio, '')
})

check('非对象输入整体拒绝', () => {
  assert.ok(sanitizeConfig([1, 2]).errors._)
  assert.ok(sanitizeConfig('x').errors._)
  assert.ok(sanitizeConfig(null).errors._)
})

console.log('requireToolConfirmation / 人设预设')

check('sanitizeConfig：requireToolConfirmation 布尔校验', () => {
  const { patch, errors } = sanitizeConfig({ requireToolConfirmation: true })
  assert.deepEqual(errors, {})
  assert.equal(patch.requireToolConfirmation, true)
  assert.ok(sanitizeConfig({ requireToolConfirmation: 'yes' }).errors.requireToolConfirmation)
})

check('sanitizePersonaName：trim、长度与保留键拒绝', () => {
  assert.equal(sanitizePersonaName('  工作模式 '), '工作模式')
  assert.equal(sanitizePersonaName(''), null)
  assert.equal(sanitizePersonaName('   '), null)
  assert.equal(sanitizePersonaName('x'.repeat(31)), null)
  assert.equal(sanitizePersonaName('__proto__'), null)
  assert.equal(sanitizePersonaName(123), null)
  assert.equal(sanitizePersonaName(null), null)
})

check('normalizePersonas：剔除保留键与非对象条目', () => {
  const raw = JSON.parse('{"__proto__":{"a":1},"work":{"style":"roast"},"bad":1}')
  const out = normalizePersonas(raw)
  assert.deepEqual(Object.keys(out).sort(), ['work'])
  assert.deepEqual(normalizePersonas(null), {})
  assert.deepEqual(normalizePersonas([1, 2]), {})
})

check('migrateConfig：personas 归一化透传，缺省时保持缺席；确认模式脏数据回退', () => {
  const config = migrateConfig({ personas: { work: { style: 'roast' } } })
  assert.deepEqual(config.personas, { work: { style: 'roast' } })
  const clean = migrateConfig({ nickname: 'x' })
  assert.equal('personas' in clean, false)
  const dirty = migrateConfig({ requireToolConfirmation: 'yes' })
  assert.equal(dirty.requireToolConfirmation, false)
})

console.log('特质：表格 / 回复长度')

const indexSource = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
// 断言一律对**去注释后**的源码做匹配：注释里写一句 // const VERSION = '0.0.0' 或
// // await writeConfigFile(...) 就能骗过裸正则（M5 类，变异实验实测可绕过）。
// stripComments 长度保持不变，因此位置与字符串内容都不受影响。
const indexCode = stripComments(indexSource)

// 从 index.mjs 的 PROMPT_TEXT 中按缩进切片取出某个文案子表（zh / en 各一处）。
// 用「块数量必须为 2」做结构断言：文案表若被重构或改名，这里会直接失败而不是静默放过。
function promptTextBlocks(key) {
  const re = new RegExp(`\\n    ${key}: \\{\\n([\\s\\S]*?)\\n    \\\},`, 'g')
  return [...indexCode.matchAll(re)].map((m) => m[1])
}

check('DEFAULT_CONFIG 含表格与回复长度的默认值', () => {
  assert.equal(DEFAULT_CONFIG.tables, 'default')
  assert.equal(DEFAULT_CONFIG.replyLength, 'normal')
})

check('sanitizeConfig：表格与回复长度合法值通过', () => {
  const { patch, errors } = sanitizeConfig({ tables: 'more', replyLength: 'detailed' })
  assert.deepEqual(errors, {})
  assert.equal(patch.tables, 'more')
  assert.equal(patch.replyLength, 'detailed')
})

check('sanitizeConfig：表格与回复长度非法枚举被拒绝', () => {
  assert.ok(sanitizeConfig({ tables: 'always' }).errors.tables)
  assert.ok(sanitizeConfig({ replyLength: 'verbose' }).errors.replyLength)
  assert.equal('tables' in sanitizeConfig({ tables: 'x' }).patch, false)
  assert.equal('replyLength' in sanitizeConfig({ replyLength: 'x' }).patch, false)
})

check('migrateConfig：表格与回复长度脏数据回退为默认值', () => {
  const dirty = migrateConfig({ tables: 'max', replyLength: 3 })
  assert.equal(dirty.tables, 'default')
  assert.equal(dirty.replyLength, 'normal')
})

check('PERSONA_FIELDS 覆盖新增的两个维度（人设预设可保存与还原）', () => {
  assert.ok(PERSONA_FIELDS.includes('tables'))
  assert.ok(PERSONA_FIELDS.includes('replyLength'))
})

check('提示词文案：zh / en 均含表格与回复长度，且块数量恰为 2', () => {
  for (const key of ['tables', 'replyLength']) {
    const blocks = promptTextBlocks(key)
    assert.equal(blocks.length, 2, `${key} 文案块数量应为 2（zh / en）`)
    for (const block of blocks) {
      assert.match(block, /.{20,}/, `${key} 文案块不应为空`)
    }
  }
  const tables = promptTextBlocks('tables')
  for (const block of tables) {
    assert.ok(block.includes('more:') && block.includes('less:'), 'tables 文案应含 more / less')
    assert.equal(block.includes('default:'), false, 'tables=default 不应产生提示词文案')
  }
})

check('提示词文案：replyLength 的 normal（适中）不产生任何文案', () => {
  // 这是「新增维度不改变现有用户行为」的核心不变量：
  // buildBehavior 仅在文案表命中时 push，所以 normal 必须没有对应键。
  const blocks = promptTextBlocks('replyLength')
  for (const block of blocks) {
    assert.ok(block.includes('concise:') && block.includes('detailed:'), 'replyLength 文案应含 concise / detailed')
    assert.equal(block.includes('normal:'), false, 'replyLength=normal 不应产生提示词文案')
  }
})

console.log('输入框光轨')

check('DEFAULT_CONFIG 含光轨默认值', () => {
  assert.equal(DEFAULT_CONFIG.trailEnabled, true)
  assert.equal(DEFAULT_CONFIG.trailColor, '#679EFE')
  assert.equal(DEFAULT_CONFIG.trailSpeed, 'slow')
  assert.equal(DEFAULT_CONFIG.trailWidth, 'thin')
})

check('sanitizeConfig：光轨字段全部通过，颜色归一化为大写', () => {
  const { patch, errors } = sanitizeConfig({
    trailEnabled: false,
    trailColor: '#679efe',
    trailSpeed: 'fast',
    trailWidth: 'thick'
  })
  assert.deepEqual(errors, {})
  assert.equal(patch.trailEnabled, false)
  assert.equal(patch.trailColor, '#679EFE')
  assert.equal(patch.trailSpeed, 'fast')
  assert.equal(patch.trailWidth, 'thick')
})

check('sanitizeConfig：非法颜色被拒绝（缺 # / 位数不符 / 关键字 / 非字符串 / 空串）', () => {
  assert.ok(sanitizeConfig({ trailColor: '679EFE' }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: '#679EF' }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: '#679EFFF' }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: 'red' }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: 123 }).errors.trailColor)
  assert.ok(sanitizeConfig({ trailColor: '' }).errors.trailColor)
  assert.equal('trailColor' in sanitizeConfig({ trailColor: 'bad' }).patch, false)
})

check('sanitizeConfig：trailEnabled 非布尔、速度与粗细非法枚举被拒绝', () => {
  assert.ok(sanitizeConfig({ trailEnabled: 'yes' }).errors.trailEnabled)
  assert.ok(sanitizeConfig({ trailSpeed: 'turbo' }).errors.trailSpeed)
  assert.ok(sanitizeConfig({ trailWidth: 'huge' }).errors.trailWidth)
})

check('migrateConfig：光轨脏数据回退为默认值', () => {
  const dirty = migrateConfig({ trailEnabled: 'yes', trailColor: 'blue', trailSpeed: 'turbo', trailWidth: 9 })
  assert.equal(dirty.trailEnabled, true)
  assert.equal(dirty.trailColor, '#679EFE')
  assert.equal(dirty.trailSpeed, 'slow')
  assert.equal(dirty.trailWidth, 'thin')
})

check('migrateConfig：合法光轨配置保留，颜色转大写', () => {
  const config = migrateConfig({ trailEnabled: false, trailColor: '#aabbcc', trailSpeed: 'fast', trailWidth: 'thick' })
  assert.equal(config.trailEnabled, false)
  assert.equal(config.trailColor, '#AABBCC')
  assert.equal(config.trailSpeed, 'fast')
  assert.equal(config.trailWidth, 'thick')
})

// —— 变更记录保留条数（0.8.0 打磨）——
// 这条字段与其它容量参数的区别：它同时被三处消费（压实上限、响应里的 max、UI 表单），
// 任一处漏读都会出现「显示的和实际的不一致」，而那种不一致用户是察觉不到的
// —— 他只会发现「说好保留 50 条，怎么还能撤销到很早之前」。
check('DEFAULT_CONFIG 含变更记录条数默认值，且与 lib/history.mjs 的常量一致', () => {
  assert.equal(DEFAULT_CONFIG.historyMaxEntries, 200)
  assert.equal(HISTORY_MAX_ENTRIES_DEFAULT, 200)
  // 两条常量分居两个模块，各有各的用途（一个是配置默认值，一个是压实兜底）。
  // 数值必须相等，否则「没传上限」时的行为会与默认配置不符。
  assert.equal(MAX_ENTRIES, HISTORY_MAX_ENTRIES_DEFAULT, 'lib/history.mjs 的兜底必须等于配置默认值')
  assert.equal(HISTORY_MAX_ENTRIES_MIN, 50)
  assert.equal(HISTORY_MAX_ENTRIES_MAX, 500)
})

check('clampHistoryMaxEntries：区间内原样、越界夹取、非整数返回 null', () => {
  assert.equal(clampHistoryMaxEntries(200), 200)
  assert.equal(clampHistoryMaxEntries(50), 50)
  assert.equal(clampHistoryMaxEntries(500), 500)
  // 夹取而不是拒绝：容量参数越界时放宽比报错更符合直觉（用户要 30，给 50 是可解释的）
  assert.equal(clampHistoryMaxEntries(30), 50)
  assert.equal(clampHistoryMaxEntries(100000), 500)
  assert.equal(clampHistoryMaxEntries(0), 50)
  assert.equal(clampHistoryMaxEntries(-5), 50)
  // 非整数 / 非数字交给调用方决定：这里「猜」会把脏数据和手误混为一谈
  assert.equal(clampHistoryMaxEntries(50.5), null)
  assert.equal(clampHistoryMaxEntries('100'), null, '字符串不做隐式转换：表单里传字符串是调用方的 bug')
  assert.equal(clampHistoryMaxEntries(NaN), null)
  assert.equal(clampHistoryMaxEntries(Infinity), null)
  assert.equal(clampHistoryMaxEntries(null), null)
  assert.equal(clampHistoryMaxEntries(undefined), null)
})

check('sanitizeConfig：变更记录条数越界夹取、非整数才拒绝', () => {
  assert.equal(sanitizeConfig({ historyMaxEntries: 100 }).patch.historyMaxEntries, 100)
  assert.equal(sanitizeConfig({ historyMaxEntries: 30 }).patch.historyMaxEntries, 50, '越界夹取，不报错')
  assert.equal(sanitizeConfig({ historyMaxEntries: 9000 }).patch.historyMaxEntries, 500)
  assert.equal(sanitizeConfig({ historyMaxEntries: 30 }).errors.historyMaxEntries, undefined)
  assert.ok(sanitizeConfig({ historyMaxEntries: 12.5 }).errors.historyMaxEntries)
  assert.ok(sanitizeConfig({ historyMaxEntries: '200' }).errors.historyMaxEntries)
  assert.ok(sanitizeConfig({ historyMaxEntries: null }).errors.historyMaxEntries)
  assert.equal('historyMaxEntries' in sanitizeConfig({ historyMaxEntries: 'x' }).patch, false)
})

check('migrateConfig：变更记录条数非数字回退默认值、是数字则一律夹取', () => {
  // 磁盘配置是**不可信输入**：手改过的 null、字符串都会原样读进来。
  // 判据只有一条 ——「是数字就夹取，不是数字才回退」。刻意不给 0 / 负数开特例：
  //   · 与 sanitizeConfig 必须同策略，否则同一个 0 走 HTTP 变成 50、走手改配置变成 200，
  //     同一个输入两种结果，是脏数据能钻过去的缝；
  //   · 0 的意图方向是「少留一点」，夹到下限 50 顺着这个方向；
  //     若回退成默认值 200 反而把保留窗口**变大**了，与用户的意思正好相反。
  assert.equal(migrateConfig({}).historyMaxEntries, 200)
  assert.equal(migrateConfig({ historyMaxEntries: null }).historyMaxEntries, 200)
  assert.equal(migrateConfig({ historyMaxEntries: 'abc' }).historyMaxEntries, 200)
  assert.equal(migrateConfig({ historyMaxEntries: '200' }).historyMaxEntries, 200, '字符串不当数字用')
  assert.equal(migrateConfig({ historyMaxEntries: 12.5 }).historyMaxEntries, 200, '小数不是合法条数')
  assert.equal(migrateConfig({ historyMaxEntries: 0 }).historyMaxEntries, 50)
  assert.equal(migrateConfig({ historyMaxEntries: -100 }).historyMaxEntries, 50)
  assert.equal(migrateConfig({ historyMaxEntries: 10 }).historyMaxEntries, 50)
  assert.equal(migrateConfig({ historyMaxEntries: 99999 }).historyMaxEntries, 500)
  assert.equal(migrateConfig({ historyMaxEntries: 400 }).historyMaxEntries, 400)
})

// 这条是「UI 与后端契约」的地基：设置页的下拉选项必须全部落在服务端接受的区间内。
// 只在客户端加一档 1000，用户选中后保存会被夹成 500 —— 界面显示 1000、实际存 500。
check('变更记录条数：设置页下拉选项全部落在合法区间内，且必含默认档', () => {
  const clientText = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')
  const block = clientText.match(/const HISTORY_MAX_ENTRIES_OPTIONS = \[([^\]]*)\]/)?.[1] ?? ''
  assert.ok(block !== '', '找不到 client/index.mjs 的 HISTORY_MAX_ENTRIES_OPTIONS')
  const options = block.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
  assert.ok(options.length >= 2, '至少要有两个档位，否则这个设置项没有选择余地')
  for (const n of options) {
    assert.ok(n >= HISTORY_MAX_ENTRIES_MIN && n <= HISTORY_MAX_ENTRIES_MAX, `档位 ${n} 超出服务端接受的 ${HISTORY_MAX_ENTRIES_MIN}–${HISTORY_MAX_ENTRIES_MAX}`)
    assert.equal(clampHistoryMaxEntries(n), n, `档位 ${n} 被服务端夹取，说明两端对不上`)
  }
  assert.ok(options.includes(HISTORY_MAX_ENTRIES_DEFAULT), `选项里必须有默认档 ${HISTORY_MAX_ENTRIES_DEFAULT}`)
  // 客户端那份默认值也必须与后端一致（表单初值用它）
  assert.match(clientText, /const HISTORY_MAX_ENTRIES_DEFAULT = 200/, '客户端默认值必须与 lib/config.mjs 一致')
})

check('变更记录条数：config 双语文案键齐全，且 UI 真的用了它', () => {
  const clientText = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')
  for (const key of ['history.maxEntries', 'history.maxEntriesHint', 'history.maxEntriesDefault', 'history.maxEntriesOption']) {
    // 中英各一份：漏一份会让 makeFallbackT 把裸键名渲染到屏幕上
    const hits = clientText.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `文案键 ${key} 应为中英各一份，实际 ${hits} 份`)
  }
  assert.match(clientText, /id: 'soul-historyMaxEntries'/, '设置页必须有这个下拉的 id（label 的 htmlFor 指向它）')
  assert.match(clientText, /htmlFor: 'soul-historyMaxEntries'/, 'label 必须关联到控件，否则点标签不会聚焦')
})

console.log('插件清单与图标')
// DSH 读取 package.json 的 icon 字段（app-boot 的 readPluginMeta / iconOf），
// 在插件管理列表与侧栏入口渲染。图标缺失只是回退默认插图，但路径写错、
// 或没进 files 白名单，就会出现「仓库里有、装完没有」的静默失败，故固化为检查。
const manifestPath = fileURLToPath(new URL('../package.json', import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const packageRoot = resolve(manifestPath, '..')
const iconRef = typeof manifest.icon === 'string' ? manifest.icon : ''
const iconPath = iconRef ? resolve(packageRoot, iconRef) : ''
const iconRelative = iconRef ? relative(packageRoot, iconPath) : ''

check('清单：icon 为包内相对路径，且指向真实文件', () => {
  assert.ok(iconRef, 'package.json 缺少 icon 字段')
  // 宿主的判定（dsh-app-boot 的 iconOf）：
  //   1) 绝对路径、Windows 盘符、以及任何带 URL scheme 的值直接抛错
  //   2) 以 manifest 所在目录的 realpath 为根，relative(root, realpath(target)) 不得为 ..
  assert.equal(isAbsolute(iconRef), false, 'icon 必须是相对路径（会随包一起发布）')
  assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/.test(iconRef), false, 'icon 不能是带 scheme 的 URL（宿主只接受相对路径）')
  assert.equal(statSync(iconPath).isFile(), true, `icon 指向的不是文件：${iconRef}`)
  const outside = relative(realpathSync(packageRoot), realpathSync(iconPath))
  assert.equal(
    outside === '..' || outside.startsWith(`..${sep}`) || isAbsolute(outside),
    false,
    'icon 不能通过符号链接逃出包目录'
  )
})

check('清单：icon 扩展名在宿主白名单内（SVG / PNG / JPEG / WebP）', () => {
  assert.ok(
    ['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(extname(iconPath).toLowerCase()),
    `宿主只接受 SVG / PNG / JPEG / WebP，当前为 ${extname(iconPath) || '（无扩展名）'}`
  )
})

check('清单：icon 体积不超过 256 KiB（宿主上限，超出会拒绝装载）', () => {
  const { size } = statSync(iconPath)
  assert.ok(size > 0, 'icon 不应为空文件')
  assert.ok(size <= 256 * 1024, `icon 为 ${size} 字节，超过宿主上限 262144 字节`)
})

check('清单：icon 落在 files 白名单内（会随 npm 包一起发布）', () => {
  assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0, 'package.json 缺少 files 白名单')
  const topLevel = iconRelative.split(sep)[0]
  assert.ok(manifest.files.includes(topLevel), `files 白名单应包含 ${topLevel}，否则图标不会进发布包`)
})

// 插件列表里显示的**名称**不等于包名：DSH 的 readPluginMeta 先读
// `<包>/locale/<lang>.json` 的 `meta.title` / `meta.description`，读不到才回退到
// package.json 的 name / description（见 dsh-app-boot 的 readPluginMeta / dictionariesOf）。
// 三件事任一漏掉都会**静默回退成包名**（不报错、只是显示成 dsh-soul）：
//   ① locale 目录没进 files 白名单 → 发布包里没有它
//   ② exports 没声明 "./locale/*.json" → 子路径解析被 exports 挡住
//   ③ JSON 结构不是 { meta: { title } } → dictionariesOf 读 meta?.title 取不到
check('清单：插件展示名走 locale/*.json（否则静默回退成包名）', () => {
  const localeDir = resolve(packageRoot, 'locale')
  assert.equal(existsSync(localeDir), true, '缺少 locale/ 目录：插件列表会显示包名 dsh-soul 而不是自定义名称')
  const localeFiles = readdirSync(localeDir).filter((f) => f.endsWith('.json'))
  assert.ok(localeFiles.length > 0, 'locale/ 下没有任何 .json')

  // ① files 白名单必须带上 locale
  assert.ok(
    manifest.files.includes('locale'),
    'files 白名单应包含 locale，否则发布包里没有它、展示名静默回退成包名'
  )
  // ② exports 必须放行子路径（本包有 exports 字段，未声明的子路径会被挡住）
  const exportKeys = Object.keys(manifest.exports || {})
  assert.ok(
    exportKeys.includes('./locale/*.json'),
    'exports 必须声明 "./locale/*.json"，否则 resolvePluginResource 解析不到该子路径'
  )

  // ③ 结构必须是 { meta: { title, description } }，且英文必须有（LocalizedText 要求 en 回退）
  for (const file of localeFiles) {
    const raw = JSON.parse(readFileSync(resolve(localeDir, file), 'utf8'))
    const lang = file.slice(0, -5)
    assert.equal(/^[a-z][a-z\d-]*$/i.test(lang), true, `${file} 的文件名必须是语言 id`)
    assert.ok(raw.meta && typeof raw.meta === 'object', `${file} 必须把字段包在 meta 里（dictionariesOf 读 meta?.title）`)
    assert.equal(typeof raw.meta.title, 'string', `${file}: meta.title 必须是字符串`)
    assert.ok(raw.meta.title.trim().length > 0, `${file}: meta.title 不能为空`)
  }
  const en = JSON.parse(readFileSync(resolve(localeDir, 'en.json'), 'utf8'))
  assert.ok(en.meta.title, '必须有 locale/en.json（宿主以它作为英文回退与目录锚点）')
  assert.notEqual(
    en.meta.title,
    manifest.name,
    '英文展示名不应等于包名：那样与「回退成包名」无法区分，等于这条契约没生效'
  )
})

check('清单：展示名能被宿主真实解析（readPluginMeta 行为层）', () => {
  // 上游所有结构检查都只是「形状对」；真正要紧的是宿主解析出来的 title 不是包名回退值。
  // 本机能定位到 dsh-app-boot 时直接调它的 readPluginMeta（该函数是导出的），
  // 拿不到就 skipNote —— 与其它环境相关断言同一口径。
  // check() 回调是同步的，所以这里用 createRequire 加载（dsh-app-boot 是 CJS），
  // 不用动态 import —— 否则会踩到「同步回调里出现 await」的语法错误。
  //
  // 解析不能只从包目录出发：dsh-app-boot 是 DSH 的嵌套依赖，不在本包 node_modules 里，
  // 单点解析必然 MODULE_NOT_FOUND（与调用真实 dsh-tools 那条断言同一坑）。这里按
  // verify-compat 的 anchors 思路显式发现：包目录 → cwd → DSH profiles 下各 profile。
  let readPluginMeta = null
  try {
    const anchors = [packageRoot, process.cwd()]
    const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
    if (existsSync(profiles)) {
      for (const p of readdirSync(profiles)) anchors.push(join(profiles, p))
    }
    for (const anchor of anchors) {
      try {
        const boot = createRequire(join(anchor, 'noop.js'))('@deepseek-ai/dsh-app-boot')
        if (typeof boot?.readPluginMeta === 'function') { readPluginMeta = boot.readPluginMeta; break }
      } catch { /* 换下一个 anchor */ }
    }
  } catch { /* 本机未装 DSH：交由 skipNote 报告 */ }
  if (typeof readPluginMeta !== 'function') {
    if (!skipNote('verify-config', 1, '本机未解析到 dsh-app-boot，展示名只做结构层校验（行为层需真实宿主）', '安装 DSH 后重跑即可覆盖行为层')) {
      failures.push({ name: '展示名行为层（需真实 dsh-app-boot）', err: new Error('--strict 下跳过按失败处理') })
    }
    return
  }
  const meta = readPluginMeta(manifest.name, pathToFileURL(join(packageRoot, 'noop.js')).href)
  assert.ok(meta, '宿主 readPluginMeta 返回 undefined：展示元数据完全没被读到')
  assert.equal(meta.error, undefined, `宿主解析展示元数据时报错：${meta.error}`)
  const title = meta.title
  assert.ok(title, '宿主未解析出 title（会显示包名回退值）')
  const resolved = typeof title === 'string' ? { en: title } : title
  assert.notEqual(resolved.en, manifest.name, '宿主解析出的英文 title 仍是包名：locale 未被读取')
  const en = JSON.parse(readFileSync(resolve(packageRoot, 'locale/en.json'), 'utf8'))
  assert.equal(resolved.en, en.meta.title, '宿主解析出的 title 与 locale/en.json 不一致')
  // 中文也应可用（dictionariesOf 会扫描 locale/ 下的所有 .json）
  const zhPath = resolve(packageRoot, 'locale/zh.json')
  if (existsSync(zhPath)) {
    const zh = JSON.parse(readFileSync(zhPath, 'utf8'))
    assert.equal(resolved.zh, zh.meta.title, '宿主解析出的中文 title 与 locale/zh.json 不一致')
  }
})

const iconSvg = iconRef ? readFileSync(iconPath, 'utf8') : ''

check('图标：SVG 自带命名空间，且 viewBox 为正方形', () => {
  assert.match(iconSvg, /<svg[\s>]/, 'icon 不是 SVG 文档')
  assert.match(iconSvg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, 'SVG 缺少 xmlns，脱离独立文档渲染时会失败')
  const viewBox = iconSvg.match(/viewBox="([\d.\-\s]+)"/)
  assert.ok(viewBox, 'SVG 缺少 viewBox，无法按容器尺寸缩放')
  const parts = viewBox[1].trim().split(/\s+/).map(Number)
  assert.equal(parts.length, 4, 'viewBox 应为 4 个数字')
  assert.equal(parts[2], parts[3], 'viewBox 应为正方形（图标显示区是方的，非方会被拉伸或留白）')
})

check('图标：不含脚本、位图与外部引用（发布物第一方自足）', () => {
  assert.equal(/<script/i.test(iconSvg), false, 'SVG 不应内嵌脚本')
  assert.equal(/<image[\s>]/i.test(iconSvg), false, 'SVG 不应内嵌位图')
  assert.equal(/<foreignObject/i.test(iconSvg), false, 'SVG 不应使用 foreignObject')
  assert.equal(/(?:href|xlink:href)\s*=/i.test(iconSvg), false, 'SVG 不应包含任何链接引用')
  const withoutXmlns = iconSvg.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '')
  assert.equal(/https?:\/\//i.test(withoutXmlns), false, 'SVG 不应引用外部资源（xmlns 除外）')
})

check('图标：渐变引用都能解析到已定义的 id', () => {
  const defined = new Set([...iconSvg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]))
  const refs = [...iconSvg.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1])
  assert.ok(refs.length > 0, '图标应使用渐变填充，以适配浅色 / 深色主题')
  for (const ref of refs) {
    assert.ok(defined.has(ref), `引用了未定义的 id：${ref}`)
  }
})

// ==================== 内置人设预设 ====================

console.log('\n内置人设预设')

check('内置人设非空，名称合法且不超上限', () => {
  const names = builtinPersonaNames()
  assert.ok(names.length >= 4, `内置人设过少：${names.length}`)
  for (const name of names) {
    assert.equal(sanitizePersonaName(name), name, `内置名不合法：${name}`)
    assert.ok(name.length <= PERSONA_NAME_MAX, `内置名超长：${name}`)
    assert.ok(name.trim() === name, `内置名含首尾空白：${name}`)
  }
})

check('内置人设（含默认）只声明 PERSONA_FIELDS 内的键', () => {
  // 「默认」也是内置项（声明 6 维，language 豁免），用 mergePersonas 统一取视图，
  // 避免直接索引 BUILTIN_PERSONAS（默认不在其中 ⇒ undefined 崩）。
  const view = mergePersonas(null)
  for (const name of builtinPersonaNames()) {
    for (const key of Object.keys(view[name])) {
      if (key === 'builtin') continue
      assert.ok(PERSONA_FIELDS.includes(key), `${name} 含非人设字段：${key}`)
    }
  }
})

check('内置人设不声明「关于你」、输出语言与总开关', () => {
  // 「关于你」的三个字段根本不在 PERSONA_FIELDS 里（见下面「预设范围」一组），这里
  // 另外钉住内置数据本身也不写；language 在预设范围内，但内置是给任何语言用户共用的
  // 通用人格，写死会让另一种语言的用户应用一次就被强行切回；enabled 是总开关，
  // 预设不该能替你关掉个性化。
  const view = mergePersonas(null)
  for (const name of builtinPersonaNames()) {
    for (const key of [...PROFILE_FIELDS, 'language', 'enabled']) {
      assert.equal(key in view[name], false, `${name} 不应声明 ${key}`)
    }
  }
})

// ==================== 预设范围：「关于你」不属于预设 ====================

check('预设范围只含人设，与「关于你」无交集', () => {
  // 总纲：三个身份字段不在 PERSONA_FIELDS 里，于是保存（快照）/ 应用（取键）/
  // 匹配（判据）/ 磁盘归一化四条路径都会自然地把它们排除在外 —— 不止内置预设，
  // 用户自建预设也一样。
  assert.deepEqual(PROFILE_FIELDS, ['nickname', 'occupation', 'bio'])
  for (const key of PROFILE_FIELDS) {
    assert.equal(PERSONA_FIELDS.includes(key), false, `「关于你」的 ${key} 不应出现在 PERSONA_FIELDS`)
  }
  // 反向防空过：人设维度必须还在，否则「无交集」会因为 PERSONA_FIELDS 被误清空而假通过
  assert.ok(PERSONA_FIELDS.includes('style'), 'style 应在预设范围内')
  assert.ok(PERSONA_FIELDS.includes('customInstructions'), 'customInstructions 应在预设范围内')
  // 输出语言属于人设（决定 Agent 用什么语言作答）：自建预设会保存并在应用时还原它
  assert.ok(PERSONA_FIELDS.includes('language'), 'language 应在预设范围内')
  assert.equal(PERSONA_FIELDS.includes('enabled'), false, 'enabled 是全局开关，不进预设')
  assert.deepEqual(
    [...PROMPT_INPUT_FIELDS].sort(),
    [...new Set(['enabled', ...PROFILE_FIELDS, ...PERSONA_FIELDS])].sort(),
    '编译读取范围应恰好等于「总开关 + 关于你 + 人设」'
  )
})

check('用户自建预设里残留的「关于你」一律不算数（匹配与取值都忽略）', () => {
  // 历史数据或手改文件都可能残留这些键：既不该影响 ★ 匹配，也不该被应用。
  const legacy = { nickname: '老昵称', occupation: '老职业', bio: '老简介', style: 'roast', updatedAt: 'x' }
  assert.deepEqual(declaredPersonaKeys(legacy), ['style'], '「关于你」不应算作已声明字段')
  assert.equal(
    personaMatches(legacy, { ...DEFAULT_CONFIG, style: 'roast', nickname: '换了个人' }),
    true,
    '残留的「关于你」不应影响匹配'
  )
})

check('normalizePersonas 剥离历史预设里的「关于你」，保留人设字段与元数据', () => {
  const out = normalizePersonas({
    历史预设: {
      nickname: '老昵称',
      occupation: '老职业',
      bio: '老简介',
      style: 'roast',
      headingLists: 'less',
      updatedAt: 'T'
    },
    脏条目: 'not-an-object'
  })
  assert.deepEqual(Object.keys(out), ['历史预设'], '非对象条目应被剔除')
  assert.deepEqual(Object.keys(out['历史预设']).sort(), ['headingLists', 'style', 'updatedAt'])
  assert.equal('nickname' in out['历史预设'], false, '历史遗留的昵称应被剥离')
  // 走真实读取路径（migrateConfig → normalizePersonas）同样生效
  const migrated = migrateConfig({ personas: { 历史预设: { nickname: '老昵称', style: 'roast' } } })
  assert.deepEqual(migrated.personas['历史预设'], { style: 'roast' })
})

check('预设的保存与应用都只遍历 PERSONA_FIELDS 这一份白名单', () => {
  // 宿主侧唯一的两处取键：数据源必须是常量而不是各自硬编码一份字段表，
  // 否则「预设范围」的增删会出现两套互相漂移的语义。
  const snapshot = indexCode.match(/function personaSnapshotOf\(config\) \{([\s\S]*?)\n\}/)
  assert.ok(snapshot, '缺少 personaSnapshotOf')
  assert.ok(/for \(const key of PERSONA_FIELDS\)/.test(snapshot[1]), '快照必须按 PERSONA_FIELDS 取键')
  const pick = indexCode.match(/function pickPersonaValues\(persona\) \{([\s\S]*?)\n\}/)
  assert.ok(pick, '缺少 pickPersonaValues')
  assert.ok(/for \(const key of PERSONA_FIELDS\)/.test(pick[1]), '应用必须按 PERSONA_FIELDS 取键')
  // 反向：两处都不得出现硬编码的身份字段（否则会绕过白名单）
  for (const key of PROFILE_FIELDS) {
    assert.equal(snapshot[1].includes(key), false, `快照不应涉及 ${key}`)
    assert.equal(pick[1].includes(key), false, `应用不应涉及 ${key}`)
  }
})

check('内置人设的枚举值与文本长度合法，且都有自定义指令', () => {
  const enums = {
    style: STYLE_VALUES,
    headingLists: TRAIT_VALUES,
    emoji: TRAIT_VALUES,
    tables: TRAIT_VALUES,
    replyLength: REPLY_LENGTH_VALUES
  }
  const view = mergePersonas(null)
  for (const name of builtinPersonaNames()) {
    const entry = view[name]
    for (const [field, allowed] of Object.entries(enums)) {
      if (!(field in entry)) continue
      assert.ok(allowed.includes(entry[field]), `${name}.${field} 非法取值：${entry[field]}`)
    }
    // customInstructions 是人格差异的主要载体：枚举字段只能表达「更啰嗦 / 更简洁」
    // 这类粗粒度倾向，所以内置预设必须有它。
    // 「默认」是唯一例外 —— 出厂状态没有附加指令，空串即其本义。
    if (name !== '默认') {
      assert.equal(typeof entry.customInstructions, 'string', `${name} 缺少 customInstructions`)
      assert.ok(entry.customInstructions.length > 0, `${name} 的 customInstructions 为空`)
    } else {
      assert.equal(entry.customInstructions, '', '默认人设的 customInstructions 应为空串')
    }
    assert.ok(
      entry.customInstructions.length <= FIELD_LIMITS.customInstructions,
      `${name} 的 customInstructions 超长（${entry.customInstructions.length} > ${FIELD_LIMITS.customInstructions}）`
    )
  }
})

check('内置人设都能通过 sanitizeConfig（数据本身合法）', () => {
  for (const name of builtinPersonaNames()) {
    const { errors } = sanitizeConfig(resolvePersona(name, {}))
    assert.deepEqual(errors, {}, `${name} 未通过校验：${JSON.stringify(errors)}`)
  }
})

check('mergePersonas：内置优先并带 builtin 标记，用户条目不受影响', () => {
  const names = builtinPersonaNames()
  const merged = mergePersonas({ '极简主义者': { style: 'roast' }, 我的预设: { style: 'casual' } })
  assert.equal(Object.keys(merged).length, names.length + 1, '同名用户条目应被内置遮蔽而非并存')
  assert.equal(merged['极简主义者'].style, BUILTIN_PERSONAS['极简主义者'].style, '同名时应取内置内容')
  assert.equal(merged['极简主义者'].builtin, true)
  assert.equal(merged['我的预设'].builtin, undefined, '用户预设不应带 builtin 标记')
  assert.deepEqual(merged['我的预设'], { style: 'casual' })
  for (const name of names) assert.equal(merged[name].builtin, true, `${name} 应带 builtin 标记`)
  // 非对象输入不应抛错
  assert.equal(Object.keys(mergePersonas(null)).length, names.length)
  assert.equal(Object.keys(mergePersonas('x')).length, names.length)
})

check('isBuiltinPersona / resolvePersona 的判定与优先级', () => {
  const names = builtinPersonaNames()
  assert.equal(isBuiltinPersona(names[0]), true)
  assert.equal(isBuiltinPersona('不存在的名字'), false)
  assert.equal(isBuiltinPersona(123), false)
  assert.equal(isBuiltinPersona(null), false)
  // names[0] 是「默认」（不在 BUILTIN_PERSONAS 字面量里，经 personaEntry 解析）。
  // resolvePersona 的历史语义是【纯净条目】（不含 builtin 标记），所以这里用
  // resolve 自身对称对比：同名用户条目必须被内置内容遮蔽。
  const direct = resolvePersona(names[0], {})
  assert.deepEqual(resolvePersona(names[0], { [names[0]]: { style: 'roast' } }), direct)
  assert.deepEqual(resolvePersona('我的预设', { '我的预设': { style: 'casual' } }), { style: 'casual' })
  assert.equal(resolvePersona('不存在', { '我的预设': { style: 'casual' } }), null)
  assert.equal(resolvePersona(undefined, {}), null)
})

check('应用内置预设后能命中它自己（★ 标记闭环）', () => {
  // 这条是「预设能用」的最小闭环：应用 → 表单回读 → 列表应显示 ★。
  // 若匹配语义写成全字段相等，apply 会失败而这条会立刻报出来。
  for (const name of builtinPersonaNames()) {
    const entry = resolvePersona(name, {})
    const { patch } = sanitizeConfig(entry)
    const applied = { ...DEFAULT_CONFIG, ...patch }
    assert.equal(personaMatches(entry, applied), true, `${name} 应用后匹配不上自己`)
  }
})

check('匹配是部分覆盖语义：已声明字段敏感、未声明字段免疫', () => {
  const entry = resolvePersona('极简主义者', {})
  const applied = { ...DEFAULT_CONFIG, ...sanitizeConfig(entry).patch }
  assert.equal(personaMatches(entry, DEFAULT_CONFIG), false, '未应用时不应匹配')
  assert.equal(personaMatches(entry, { ...applied, style: 'casual' }), false, '改动已声明字段后不应匹配')
  assert.equal(
    personaMatches(entry, { ...applied, customInstructions: `${applied.customInstructions}x` }),
    false,
    '自定义指令变化后不应匹配'
  )
  assert.equal(personaMatches(entry, { ...applied, language: 'en' }), true, '预设未声明 language，语言变化不应影响匹配')
  assert.equal(personaMatches(entry, { ...applied, nickname: '小明' }), true, '预设未声明 nickname，改昵称不应影响匹配')
})

check('未声明任何字段的条目不匹配（避免匹配一切）', () => {
  assert.equal(personaMatches({}, DEFAULT_CONFIG), false)
  assert.equal(personaMatches({ updatedAt: 'x', builtin: true }, DEFAULT_CONFIG), false)
  assert.equal(personaMatches(null, DEFAULT_CONFIG), false)
  assert.deepEqual(declaredPersonaKeys({ style: 'casual', updatedAt: 'x', builtin: true, extra: 1 }), ['style'])
})

// ==================== 前后端契约一致性 ====================

console.log('\n前后端契约一致性')

const clientSource = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')
const clientCode = stripComments(clientSource)

// 真实 @deepseek-ai/dsh-tools（若本机可解析）：用于行为层校验 set_persona 的 schema。
// ESM 顶层 await；解析不到（CI / 未装 DSH）时为 null，行为层以 skipNote 报告。
//
// 解析不能用 createRequire(插件 package.json) 单点：dsh-tools 是 **peer 依赖**，不在
// 插件 node_modules 里，从插件目录解析注定 MODULE_NOT_FOUND（首次实现即踩此坑：
// skipNote 提示「未安装」却依然显示 ✓，靠 --strict 才暴露）。这里按 verify-compat 的
// anchors 思路显式发现：插件目录 → cwd → DSH profiles 下各 profile → 逐级向上。
let defineTool = null
try {
  const here = fileURLToPath(new URL('..', import.meta.url))
  const anchors = [here, process.cwd()]
  const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
  if (existsSync(profiles)) {
    for (const p of readdirSync(profiles)) anchors.push(join(profiles, p))
  }
  let resolved = null
  for (const anchor of anchors) {
    try {
      resolved = createRequire(join(anchor, 'noop.js')).resolve('@deepseek-ai/dsh-tools')
      break
    } catch { /* 换下一个 anchor */ }
  }
  if (!resolved) throw new Error('not found')
  ;({ defineTool } = await import(pathToFileURL(resolved).href))
} catch { /* 未装 DSH：行为层跳过（skipNote 在用到它的 check 里报告） */ }
if (defineTool) console.log('  · 已定位真实 @deepseek-ai/dsh-tools，set_persona 将做行为层校验')

check('客户端摘要的默认值表与宿主 DEFAULT_CONFIG 逐项一致', () => {
  const block = clientCode.match(/const META_FIELD_DEFAULTS = \{([\s\S]*?)\}/)
  assert.ok(block, '客户端缺少 META_FIELD_DEFAULTS')
  const pairs = [...block[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]])
  assert.ok(pairs.length >= 5, `默认值表条目过少：${pairs.length}`)
  for (const [field, value] of pairs) {
    assert.equal(
      value,
      String(DEFAULT_CONFIG[field]),
      `客户端 ${field} 默认值 ${value} 与宿主 DEFAULT_CONFIG 的 ${DEFAULT_CONFIG[field]} 不一致（摘要会显示相反的结果）`
    )
  }
})

check('客户端轮询在页面不可见时暂停（不只在「变可见」时刷新）', () => {
  // 此前 `visibilitychange` 只处理了「变可见」这一半（`if (visible) refresh()`），
  // 而 `setInterval(refresh, 2000)` 无条件执行 ⇒ 后台标签页每 2s 仍发两个请求。
  // 修法是把守卫放进 refresh 本身（interval 与 focus 都走它，一处覆盖两条路径）。
  const effect = clientCode.match(/const refresh = \(\) => \{([\s\S]*?)\n\s{8}\}/)
  assert.ok(effect, '找不到设置页的 refresh 函数')
  const body = effect[1]
  assert.ok(
    /document\.visibilityState !== 'visible'/.test(body),
    'refresh 必须自己检查页面可见性，否则 setInterval 在后台标签页仍会持续请求'
  )
  // 守卫必须在发请求之前
  const guardAt = body.indexOf("document.visibilityState !== 'visible'")
  const firstRequest = body.indexOf('controller.loadConfig()')
  assert.ok(firstRequest > 0, 'refresh 应调用 controller.loadConfig()')
  assert.ok(
    guardAt < firstRequest,
    '可见性守卫必须排在发起请求之前，否则等于没拦'
  )
  // 防回归：定时器仍应存在（别把轮询整个删掉当成"修好"）
  assert.ok(/setInterval\(refresh, 2000\)/.test(clientCode), '设置页应保留 2s 轮询（外部写入路径靠它补齐）')
})

check('客户端摘要覆盖的字段集合固定', () => {
  const block = clientCode.match(/const META_FIELD_VALUES = \{([\s\S]*?)\}/)
  assert.ok(block, '客户端缺少 META_FIELD_VALUES')
  const fields = [...block[1].matchAll(/(\w+):/g)].map((m) => m[1]).sort()
  assert.deepEqual(fields, ['emoji', 'headingLists', 'language', 'replyLength', 'tables'])
})

check('客户端为内置预设提供中英双语文案键', () => {
  const keys = [
    'personas.builtin',
    'personas.hint',
    'meta.replyLength.concise',
    'meta.replyLength.detailed',
    'meta.headingLists.more',
    'meta.headingLists.less',
    'meta.emoji.more',
    'meta.emoji.less',
    'meta.tables.more',
    'meta.tables.less',
    'meta.language.zh',
    'meta.language.en'
  ]
  for (const key of keys) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 应在 zh / en 各出现一次，实际 ${hits} 次`)
  }
})

check('「人设变更需确认」提示如实描述审批面板与完全权限下的建议', () => {
  // 该提示曾经过时：主路径已从「/soul confirm 文本确认」改为**宿主审批面板**
  // （composer takeover，Enter 允许 / Esc 拒绝），文案却仍只说文本流程。
  //
  // 三条必须同时出现，否则用户会被误导：
  //   ① 主路径是审批面板（而不是只有文本确认）
  //   ② 通道不可用（策略 never）时退化为文本确认
  //   ③ 完全权限下建议关闭本开关 —— 因为此时面板不会出现、每次都要手输命令
  const all = [...clientSource.matchAll(/'hint\.toolConfirm':\s*'([^']*)'/g)].map((m) => m[1])
  assert.equal(all.length, 2, `hint.toolConfirm 应中英各一份，实际 ${all.length} 份`)
  const [zh, en] = all
  // ① 审批面板
  assert.match(zh, /审批面板/, '中文提示应说明主路径是审批面板（否则用户不知道会弹面板）')
  assert.match(en, /approval panel/, '英文提示应说明主路径是审批面板')
  // ② 退化路径
  assert.match(zh, /\/soul confirm/, '中文提示应说明通道不可用时退化为 /soul confirm')
  assert.match(en, /\/soul confirm/, '英文提示应说明退化路径')
  assert.match(zh, /never/, '中文提示应点明触发退化的策略（never）')
  assert.match(en, /never/, '英文提示应点明触发退化的策略（never）')
  // ③ 完全权限下的建议
  assert.match(zh, /建议关闭/, '中文提示应给出「完全权限下建议关闭」的建议')
  assert.match(en, /turning this switch off is recommended/, '英文提示应给出同样的建议')
  // 长度上限：tooltip 是向上弹出的浮层，过长会盖住大半个分组。
  // 实测（chrome 渲染）：124 字 ≈ 108px 高。这里按字符数设一条粗粒度上限，
  // 防止后续追加内容把浮层撑到不可用。
  assert.ok(zh.length <= 160, `中文提示过长（${zh.length} 字），实测每 19 字一行，超过 160 字会盖住大半个分组`)
  assert.ok(en.length <= 400, `英文提示过长（${en.length} 字符）`)
})

check('客户端卡牌把「内置」徽标放在插画区，不进操作区', () => {
  // 竖版卡牌（方案 B）的结构是：
  //   .soul-persona-art  插画区 —— 图 + 渐变遮罩 + 徽标 + 位置指示 + 名称/摘要
  //   .soul-persona-body 信息区 —— 效果栏 + 操作按钮
  // 徽标属于「这个预设从哪来」的信息，应随名称在插画区；放操作区会占掉按钮列位。
  // 定界必须用括号配平（extractCall），不能用缩进/固定窗口：曾用 `\s{22}` 猜终点，
  // 而真实闭合是 24 空格 ⇒ 捕获吞掉后续内容，断言退化成「徽标在这一块里」（H4）。
  const artCell = extractCall(clientSource, "e('div', { className: 'soul-persona-art' }")
  assert.ok(artCell !== '', '找不到插画区渲染块')
  assert.ok(/soul-persona-badge/.test(artCell), '内置标记未渲染在插画区（应随名称展示）')
  assert.ok(
    /soul-persona-name/.test(artCell) && /soul-persona-meta/.test(artCell),
    '名称与摘要应压在插画上（方案 B 的卡面构图）'
  )
  // 徽标不得出现在操作区块里
  const actionsCell = extractCall(clientSource, "e('div', { className: 'soul-persona-actions' }")
  assert.ok(actionsCell !== '', '找不到操作区渲染块')
  assert.equal(
    /soul-persona-badge/.test(actionsCell),
    false,
    '徽标不应出现在操作区（会占掉「使用」的列位）'
  )
  // 效果栏必须在信息区内（放插画区会压在图上看不清）
  const bodyCell = extractCall(clientSource, "e('div', { className: 'soul-persona-body' }")
  assert.ok(/soul-persona-eff/.test(bodyCell), '效果栏应在信息区（.soul-persona-body）内')
  // 「删除」已移到**卡背**（用户反馈正面三钮拥挤、43px 窄条夹在中间观感差）。
  // 正面现在两类卡都是「使用 + 详情」两钮 —— 断言改为：
  //   ① 正面**不得**再有删除按钮或空占位（slot 是旧布局的产物）
  //   ② 正面「使用」必须在、且不依赖占位对齐（flex 布局天然同列）
  const actionsBlock = actionsCell
  assert.equal(
    actionsBlock.includes('soul-persona-danger') || actionsBlock.includes('soul-persona-slot'),
    false,
    '正面操作区不应再有删除按钮或空占位（删除已移到卡背；正面两钮与内置卡一致）'
  )
  assert.ok(
    actionsBlock.includes('handleUsePersona(name)') && actionsBlock.includes('soul-persona-details'),
    '正面操作区应有「使用」与「详情」'
  )
})

// 解析宿主主题包（dsh-client-ui-theme），供「CSS 引用的 token 必须真实存在」这条断言使用。
// 与 dsh-tools / dsh-app-boot 同样的 anchors 思路：单点解析必失败（peer/嵌套依赖）。
const loadThemeCss = () => {
  const anchors = [packageRoot, process.cwd()]
  try {
    const profiles = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles')
    if (existsSync(profiles)) for (const p of readdirSync(profiles)) anchors.push(join(profiles, p))
  } catch { /* 忽略：下面按 anchor 逐个尝试 */ }
  for (const anchor of anchors) {
    try {
      const req = createRequire(join(anchor, 'noop.js'))
      const entry = req.resolve('@deepseek-ai/dsh-client-ui-theme')
      // 主题的 token 定义在 lib/client.js（入口可能指向别处，故顺带扫同目录）
      const dir = dirname(entry)
      for (const file of [entry, join(dir, 'client.js'), join(dir, 'index.js')]) {
        if (existsSync(file)) {
          const text = readFileSync(file, 'utf8')
          if (text.includes('--dsw-radius-xl')) return text
        }
      }
    } catch { /* 换下一个 anchor */ }
  }
  return null
}

check('客户端 CSS 引用的每个 --dsw-* token 都在宿主主题里真实存在', () => {
  // 这是一类**静默失效**：CSS 里写了一个宿主不存在的变量名，var() 会回退成继承值
  // （实测：不存在的 token ⇒ color 变成 rgb(0,0,0)，即黑色），不报错、不警告，
  // 只在视觉上「颜色不对」。本插件曾用 `--dsw-alias-label-error` 表达错误色，
  // 而宿主根本没有这个 token（宿主用 `--dsw-alias-state-error-primary`）⇒ 错误提示、
  // 危险按钮、快捷开关失败态**全部渲染成黑色**，且 200+ 项断言全绿。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  assert.ok(cssBlock !== '', '找不到客户端 CSS 块')
  const used = [...new Set([...cssBlock.matchAll(/var\((--dsw-[\w-]+)/g)].map((m) => m[1]))]
  assert.ok(used.length > 0, '客户端 CSS 未引用任何主题 token（应使用 var(--dsw-*) 而非硬编码颜色）')

  const theme = loadThemeCss()
  if (theme === null) {
    if (!skipNote('verify-config', 1, '本机未解析到 @deepseek-ai/dsh-client-ui-theme，CSS token 未做存在性校验', '安装 DSH 后重跑即可覆盖')) {
      failures.push({ name: 'CSS token 存在性（需真实主题包）', err: new Error('--strict 下跳过按失败处理') })
    }
    return
  }
  const missing = used.filter((t) => !new RegExp(`${t}\\s*:`).test(theme))
  assert.deepEqual(
    missing,
    [],
    `CSS 引用了宿主主题里不存在的 token（var() 会静默回退成继承值）：${missing.join(', ')}`
  )
  // 反向也钉一条：曾用错的那个 token 不得再出现（防止回退）
  assert.ok(
    !used.includes('--dsw-alias-label-error'),
    '--dsw-alias-label-error 在宿主主题里不存在（应为 --dsw-alias-state-error-primary）'
  )
})

check('设置页样式对齐宿主栏目：无外层盒子，分组用卡片', () => {
  // 宿主其余设置栏目（models / plugins / plugin-inventory）都不用外框：
  // 内容直接落在 options 容器自带的 `padding:0 24px 24px` 里，分组靠「卡片」表达
  // （.5px 描边 + settings-card-* + radius-xl）。此前 `.soul-section` 自带
  // margin/padding/border/background，等于在宿主内边距里又套一层盒子 —— 这是观感
  // 与其它栏目不统一最直接的原因。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const section = cssBlock.match(/\.soul-section\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(section !== '', '找不到 .soul-section 规则')
  for (const prop of ['padding', 'border', 'background']) {
    assert.equal(
      new RegExp(`(^|;)${prop}:`).test(section),
      false,
      `.soul-section 不应自带 ${prop}（宿主的设置内容区已提供内边距，再套一层盒子就与其它栏目不一致）`
    )
  }
  assert.ok(/max-width:\s*\d+px/.test(section), '.soul-section 应限制最大宽度（宿主各栏目用 720~760px 限制行长）')
  assert.ok(/display:flex/.test(section), '.soul-section 应为纵向弹性列（宿主各栏目同构）')

  // 分组（折叠区）必须用宿主卡片 token，而不是普通边框 + 小圆角
  const accordion = cssBlock.match(/\.soul-accordion\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(accordion !== '', '找不到 .soul-accordion 规则')
  assert.ok(/settings-card-stroke/.test(accordion), '分组应使用 settings-card-stroke 描边（宿主卡片统一色）')
  assert.ok(/settings-card-fill/.test(accordion), '分组应使用 settings-card-fill 底色')
  assert.ok(/radius-xl/.test(accordion), '分组应使用 radius-xl 圆角（与宿主卡片一致）')

  // 标题规格对齐：宿主栏目标题是 16px / 500 / lh24，不是 600
  const title = cssBlock.match(/\.soul-section h3\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/font-size:16px/.test(title), '栏目标题应为 16px（与宿主一致）')
  assert.ok(/font-weight:500/.test(title), '栏目标题字重应为 500（宿主用 500，600 会显得更重）')

  // 字段标签规格对齐：宿主 fieldLabel 是 12px / 500 / lh18
  const fieldLabel = cssBlock.match(/\.soul-field label\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/font-size:12px/.test(fieldLabel), '字段标签应为 12px（宿主 fieldLabel 同规格）')
  assert.ok(/line-height:18px/.test(fieldLabel), '字段标签行高应为 18px（与宿主一致）')

  // 语义色必须走宿主的状态色族，而不是硬编码。
  // 两条容易误报的路径都要排掉（本条初版就被它们误伤过）：
  //   ① 注释里提到的旧值（如「原先硬编码 #f6ffed」）—— 先剥注释；
  //   ② var(--token, #fallback) 里的兜底值 —— 那是刻意保留的降级，不算硬编码。
  const stripped = stripComments(cssBlock)
  let withoutFallbacks = ''
  for (let i = 0; i < stripped.length; i++) {
    if (stripped.startsWith('var(', i)) {
      // 括号配平跳过整个 var(...)（内部可能嵌套 color-mix(...)）
      let depth = 0
      let j = i + 3
      for (; j < stripped.length; j++) {
        if (stripped[j] === '(') depth++
        else if (stripped[j] === ')') { depth--; if (depth === 0) break }
      }
      withoutFallbacks += 'var()'
      i = j
      continue
    }
    withoutFallbacks += stripped[i]
  }
  const hardcoded = [...withoutFallbacks.matchAll(/#[0-9a-fA-F]{3,8}\b/g)].map((m) => m[0])
  assert.deepEqual(
    hardcoded,
    [],
    `CSS 不应硬编码颜色（深色主题下会失效）：${[...new Set(hardcoded)].join(', ')}`
  )
})

check('卡牌操作按钮：主操作突出（实心主色），删除为次要小按钮', () => {
  // 卡牌的主操作是「使用」——它需要足够的视觉权重（实心主按钮 + 较大高度），
  // 而不是列表行里那种 28px 透明底的文字按钮（那是**列表**的规格，
  // 卡牌上会显得太小、不够突出）。
  // 「删除」是次要的破坏性操作：定宽小按钮 + 描边危险色，形成主次对比。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const btn = cssBlock.match(/\.soul-persona-action\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(btn !== '', '找不到 .soul-persona-action 规则')
  for (const [pattern, why] of [
    [/background:var\(--dsw-alias-button-primary-fill\)/, '「使用」应为实心主按钮底（用主题主按钮 token）'],
    [/color:var\(--dsw-alias-label-primary-foreground\)/, '主按钮文字应为反色前景（保证对比度）'],
    [/flex:1 1 auto/, '主按钮应弹性占满可用宽度（卡牌主操作要显眼）'],
    [/font-weight:600/, '主按钮字重应为 600（突出主操作）']
  ]) {
    assert.ok(pattern.test(btn), why)
  }
  // 高度必须足够大：按钮偏小是这一版明确修过的问题 ⇒ 校验量级而非「有 height」
  const h = Number((btn.match(/height:(\d+)px/) ?? [])[1] ?? 0)
  assert.ok(h >= 32, `主按钮高度应 ≥32px（当前 ${h}px，卡牌上过小会不突出且难点）`)
  const fs = Number((btn.match(/font-size:(\d+)px/) ?? [])[1] ?? 0)
  assert.ok(fs >= 13, `主按钮字号应 ≥13px（当前 ${fs}px）`)
  // hover 反馈必须存在
  assert.match(cssBlock, /\.soul-persona-action:hover:not\(:disabled\)\{[^}]*filter:brightness/, '主按钮应有 hover 反馈')
  // 删除：定宽（不占满）+ 描边危险色，明显小于主按钮
  const danger = cssBlock.match(/\.soul-persona-danger\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/state-error-primary/.test(danger), '删除按钮色应为 state-error-primary')
  assert.match(danger, /flex:0 0 \d+px/, '删除按钮应定宽（不占满，避免与主操作抢视觉权重）')
  assert.match(danger, /background:transparent/, '删除按钮应为透明底（次要操作）')
  assert.match(danger, /border:\.5px solid/, '删除按钮应有描边（次要按钮的视觉语言）')
  assert.ok(
    /\.soul-persona-danger:hover:not\(:disabled\)\{[^}]*interactive-bg-hover-danger/.test(cssBlock),
    '删除按钮 hover 应使用 interactive-bg-hover-danger'
  )
  // 操作区应为 flex（主按钮弹性 + 删除定宽），不再是两条固定轨道的网格
  const actions = cssBlock.match(/\.soul-persona-actions\{([^}]*)\}/)?.[1] ?? ''
  assert.match(actions, /display:flex/, '操作区应为弹性布局（主按钮占满、删除定宽）')
  // 内置预设不渲染删除按钮，「使用」自然占满
  assert.match(cssBlock, /\.soul-persona-slot\{display:none\}/, '内置预设的删除位应完全不占空间（.soul-persona-slot 隐藏）')

  // 卡片必须是堆叠容器（一次只展示一张），而不是纵向列表
  const card = cssBlock.match(/\.soul-persona-card\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(card !== '', '找不到 .soul-persona-card 规则')
  assert.ok(/position:absolute/.test(card), '卡片应绝对定位在堆叠容器里（否则高度会随张数跳动）')
  assert.ok(/settings-card-stroke/.test(card), '卡片描边应用 settings-card-stroke（与宿主卡片一致）')
  assert.match(card, /border-radius:var\(--dsw-radius-xl\)/, '卡片应用 radius-xl 圆角（卡牌观感，与宿主卡片一致）')
  const stack = cssBlock.match(/\.soul-persona-stack\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/position:relative/.test(stack), '堆叠容器应为相对定位（作为卡片的定位基准）')
  // 高度必须**足够容纳一张卡片**：只断言「有 min-height」不够 —— 改成 0 也能过（实测），
  // 而 0 会让内容溢出、切换时跳动，因此校验量级。
  const stackH = Number((stack.match(/min-height:\s*(\d+)px/) ?? [])[1] ?? 0)
  assert.ok(stackH >= 100, `堆叠容器 min-height 应 ≥100px（当前 ${stackH}px，过小会导致内容溢出/切换跳动）`)
  // 叠层必须真的错开：偏移量过小就只露一条缝、看不出「一叠卡片」。
  // 校验内联 transform 里的偏移系数，避免「改了数值而断言没跟上」（实测 0 偏移能骗过旧写法）。
  const offMatch = clientSource.match(/translateX\(\$\{offset \* (\d+)\}px\)/)
  assert.ok(offMatch, '找不到卡片叠层偏移的写法（内联 transform）')
  // 竖版卡牌宽 260px，偏移要更大才能露出完整的卡边 ⇒ 下限提高到 60px
  assert.ok(
    Number(offMatch[1]) >= 60,
    `叠层横向偏移应 ≥60px（当前 ${offMatch[1]}px，过小则叠层与当前卡重叠成一坨）`
  )
  // 叠层容器的竖直错位（让背景卡稍微下沉，形成卡堆纵深）
  assert.match(
    clientSource,
    /translateY\(\$\{Math\.abs\(offset\) \* \d+\}px\)/,
    '叠层应有竖直错位（背景卡下沉，形成卡堆纵深）'
  )
  // 滑动过渡必须存在（用户要的「滑动特效」），且要尊重 reduced-motion
  assert.match(card, /transition:[^;}]*transform/, '卡片应有 transform 过渡（滑动特效）')
  // reduced-motion 规则里有嵌套的 `{}`（多选择器），用 `[^}]*\}\}` 这类简易正则匹配不到，
  // 因此改为「取 media 规则起点后的整段，再逐条查」。
  const rmAt = cssBlock.indexOf('@media (prefers-reduced-motion:reduce)')
  assert.ok(rmAt > 0, '缺少 prefers-reduced-motion 规则')
  const rm = cssBlock.slice(rmAt)
  assert.ok(
    /\.soul-persona-card\{animation:none!important;transition:none\}/.test(rm),
    '卡片的滑动/入场动效必须在 prefers-reduced-motion 下关闭'
  )
  // 来源区分交给徽标，不给卡片加底色（宿主不给行容器加 hover 底色）。
  // 判定要**只看背景声明**：`[data-builtin]` 选择器还承担布局用途
  // （无插画的自定义预设改单列），若只按选择器存在与否判断会误报。
  const builtinRules = cssBlock.match(/\.soul-persona-card\[data-builtin[^{]*\{[^}]*\}/g) ?? []
  const builtinBackgrounds = builtinRules.filter((r) => /background/.test(r))
  assert.deepEqual(
    builtinBackgrounds,
    [],
    `不应给内置卡片加底色（宿主用 rowTag 区分来源；灰底在白色卡片群里会被误读成 hover 态）：${builtinBackgrounds.join(' ')}`
  )
})

check('当前生效的人设：按钮文字变「使用中」且样式区别于其它卡片', () => {
  // 起因：点「使用」后再次进入设置页，只有名称前的 ★ 能表明哪张卡是当前配置，
  // 而按钮一律写「使用」，不够醒目。现改为当前生效那张的按钮文字变「使用中」+
  // 描边式样式（透明底 + 品牌色），与其它卡片的实心主色按钮形成对比。
  // 三重标识：★（名称前）+「使用中」文字 + 描边样式。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  // ① 词典键必须中英各一份（双语对齐断言只保证键集一致，不保证此键存在）
  assert.match(clientSource, /'personas\.active': '使用中'/, '缺少中文「使用中」文案键')
  assert.match(clientSource, /'personas\.active': 'Active'/, '缺少英文「Active」文案键')
  // ② 按钮文字按 activePersona 切换
  assert.match(
    clientSource,
    /name === activePersona \? t\('personas\.active'\) : t\('personas\.use'\)/,
    '生效中的预设应把按钮文字换成「使用中」（否则与其它卡片无从区分）'
  )
  // ③ 生效中的按钮加独立类名，且该类名按 activePersona 切换
  assert.match(
    clientSource,
    /className: name === activePersona \? 'soul-persona-action soul-persona-active' : 'soul-persona-action'/,
    '生效中的按钮应带 soul-persona-active 类（供样式区分）'
  )
  // ④ 该类名的样式必须真的区分：透明底 + 品牌色文字（不是照抄实心主色）
  const active = cssBlock.match(/\.soul-persona-active\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(active !== '', '找不到 .soul-persona-active 规则')
  assert.match(active, /background:transparent/, '「使用中」按钮应为透明底（区别于实心主色）')
  assert.match(active, /color:var\(--dsw-alias-brand-primary\)/, '「使用中」按钮文字应用品牌色')
  assert.match(active, /box-shadow:inset/, '用 inset box-shadow 画描边（基类 border:0，加 border 会让尺寸变化导致布局跳动）')
  assert.equal(
    /border:/.test(active),
    false,
    '不得用 border 画描边（会改变盒模型尺寸，「使用中」与其它按钮不等高）'
  )
  // ⑤ 仍然可点击（不是 disabled）—— 重复应用是无副作用的幂等操作
  assert.equal(
    /soul-persona-active[^}]*cursor:default/.test(cssBlock),
    false,
    '「使用中」按钮不应显示为不可点击（重复应用是幂等的，禁用会让人以为卡住）'
  )
})

check('卡片堆叠轮播：一次一张 + 位置指示 + 可点翻页（补偿列表的可扫读性）', () => {
  // 卡片堆叠的代价是「一次只见一张」——8 个预设要翻 7 次才能看全，而列表本可一眼扫完。
  // 因此必须同时提供：① 位置指示（i / n）② 可点的前后翻页 ③ 圆点直达。
  // 这条断言就是钉住这三处补偿，以及「只渲染 3 张」的层叠上限。
  assert.match(clientSource, /for \(let offset = -1; offset <= 1; offset\+\+\)/, '应只渲染当前张与左右各一张（层叠上限 3）')
  assert.match(clientSource, /const index = Math\.min\(Math\.max\(personaIndex, 0\), total - 1\)/, '索引必须夹取（预设被删除后可能越界）')
  assert.match(clientSource, /'aria-label': t\('personas\.prev'\)/, '上一张按钮缺少 aria-label')
  assert.match(clientSource, /'aria-label': t\('personas\.next'\)/, '下一张按钮缺少 aria-label')
  assert.match(clientSource, /disabled: index === 0/, '首张时「上一张」应禁用')
  assert.match(clientSource, /disabled: index === total - 1/, '末张时「下一张」应禁用')
  assert.match(clientSource, /className: 'soul-persona-card-pos'/, '缺少位置指示（i / n）')
  assert.match(clientSource, /className: 'soul-persona-dot'/, '缺少圆点直达指示器')
  assert.match(clientSource, /'aria-selected': i === index/, '圆点应暴露 aria-selected（读屏可知当前项）')
  // 非当前卡片不得被读屏读到，也不该可点（避免念出重复内容 / 误触）
  assert.match(clientSource, /'aria-hidden': current \? undefined : 'true'/, '非当前卡片应 aria-hidden')
  // 词典键必须齐全（zh/en 有逐键对齐断言兜底，但这里先确认被引用）
  for (const key of ['personas.prev', 'personas.next']) {
    assert.ok(clientSource.includes(`'${key}'`), `缺少词典键 ${key}`)
  }
})

check('人设插画：宿主路由存在、只服务内置人设名、缺图回退占位', () => {
  // 图放 assets/personas/<人设名>.<ext>，客户端按名请求 /api/soul/persona-art/<名>。
  // 三条安全/健壮性契约：
  //   ① 路由必须是 prefix（路径里带名字），且只接受 GET；
  //   ② 名字经 isBuiltinPersona 白名单校验 —— 这是防路径穿越的**结构手段**
  //      （用户可控的名字若不校验，`../package.json` 就能读到包内任意文件）；
  //   ③ 缺图回退 placeholder.svg，而不是 404/破图。
  assert.ok(/path: '\/api\/soul\/persona-art'/.test(indexCode), 'index.mjs 未注册人设插画路由')
  // 用**剥过注释**的 indexCode 定位：原始源码的文件头注释里也写了同一路径用作说明，
  // 直接 indexOf/lastIndexOf 会命中注释、把断言判错（初版就这样误报过）。
  const regAt = indexCode.lastIndexOf("path: '/api/soul/persona-art'")
  assert.ok(regAt > 0, '找不到插画路由的注册处')
  const regStart = indexCode.lastIndexOf('register(', regAt)
  const artRoute = indexCode.slice(Math.max(0, regStart), regAt + 1400)
  assert.match(artRoute, /kind: 'prefix'/, '插画路由应为 prefix（路径含人设名）')
  assert.match(artRoute, /req\.method !== 'GET'/, '插画路由应校验方法')
  assert.ok(
    /!isBuiltinPersona\(name\)/.test(indexCode),
    'resolvePersonaArt 必须用 isBuiltinPersona 做白名单校验（防路径穿越的结构手段）'
  )
  assert.ok(/placeholder\.svg/.test(indexCode), '缺少缺图回退（placeholder.svg）')
  assert.ok(/ART_MIME/.test(indexCode), '应显式给出 MIME 表（否则浏览器可能按 octet-stream 下载）')
  assert.equal(
    /join\(dir, name\)/.test(indexCode),
    false,
    '不得用未经白名单校验的请求名直接拼路径'
  )
})

check('人设插画：客户端对所有卡片都渲染 img（不再限定内置）', () => {
  // 此前渲染是 `builtin && e('img', ...)` —— 自建预设完全不出图。
  // 本版统一出图；若哪天又被加上条件，自建卡会退回空白渐变底。
  const artIdx = clientSource.indexOf("'soul-persona-art' }")
  assert.ok(artIdx > 0, '找不到插画区渲染处')
  const artSlice = clientSource.slice(artIdx, artIdx + 900)
  assert.equal(
    /builtin && e\('img', \{[\s\S]{0,60}className: 'soul-persona-art-img'/.test(artSlice),
    false,
    '不得再用 builtin 条件限制出图（自建预设也要显示默认贴图）'
  )
  assert.match(
    artSlice,
    /e\('img', \{[\s\S]{0,80}className: 'soul-persona-art-img'/,
    '所有卡片都应渲染插画 img'
  )
  // onError 兜底仍须保留（路由不可用时退化为渐变底而非破图）
  assert.match(artSlice, /onError:/, '插画应保留 onError 兜底隐藏')
})

check('人设插画：自建预设走专用默认贴图，且名字不参与路径拼接', () => {
  // 本版只做样式调整：自建预设此前完全不出图（只有渐变底），现在统一出图，
  // 由宿主对**非内置名**返回固定贴图。用户上传本地图片是后续版本功能。
  //
  // 安全不变量：非内置名**一律返回固定文件**，名字不参与 join ⇒
  // 路径穿越从结构上不可能（不是靠字符串替换去猜）。
  // ⚠️ 按**函数定义**定位，不能按路由注册处切：resolvePersonaArt 定义在文件前部
  // （插画常量区），而路由注册在文件后部的 apply 里 —— 按注册处切片会截掉函数体，
  // 断言于是「找不到判据」而误报（初版正是如此）。
  const fnAt = indexCode.indexOf('function resolvePersonaArt(')
  assert.ok(fnAt > 0, '找不到 resolvePersonaArt 定义')
  const artRoute = indexCode.slice(fnAt, indexCode.indexOf('function personasWithArt('))
  // ① 常量存在
  assert.match(indexCode, /const CUSTOM_ART_FILE = 'custom-placeholder\.webp'/, '缺少自建预设默认贴图的文件名常量')
  // ② 非内置名分支：返回 CUSTOM_ART_FILE，且**不**用 name 拼路径
  const branchAt = artRoute.indexOf('!isBuiltinPersona(name)')
  assert.ok(branchAt > 0, '缺少「非内置名」判据')
  // 该分支的结束位置：按名拼路径的循环开始处
  const loopAt = artRoute.indexOf('for (const ext of ART_EXTENSIONS)')
  assert.ok(loopAt > branchAt, '「非内置名」分支应在按名查找之前')
  const customBranch = artRoute.slice(branchAt, loopAt)
  assert.match(customBranch, /CUSTOM_ART_FILE/, '非内置名分支应返回专用默认贴图')
  assert.equal(
    /join\([^)]*name/.test(customBranch),
    false,
    '非内置名分支不得用 name 拼路径（否则路径穿越可能）'
  )
  // ③ 文件真实存在且规格与内置插画一致（否则静默回退、卡片一片空白）
  const customFile = resolve(packageRoot, 'assets/personas/custom-placeholder.webp')
  assert.equal(existsSync(customFile), true, '缺少 assets/personas/custom-placeholder.webp')
  // WebP 文件头：RIFF....WEBP（不引入图像库解析，头部足够确认格式）
  const head = readFileSync(customFile).subarray(0, 12)
  assert.equal(head.subarray(0, 4).toString('ascii'), 'RIFF', 'custom-placeholder.webp 不是 RIFF 容器')
  assert.equal(head.subarray(8, 12).toString('ascii'), 'WEBP', 'custom-placeholder.webp 不是 WebP')
  // MIME 必须按扩展名取，不能写死（格式变过一次：svg → webp）
  assert.match(
    indexCode,
    /const ext = CUSTOM_ART_FILE\.slice\(CUSTOM_ART_FILE\.lastIndexOf\('\.'\)\)/,
    '自定义贴图的 MIME 应按扩展名取（写死会在换格式后让浏览器下载而非渲染）'
  )
  // ④ 与内置缺图占位必须区分（同图会让「官方提供」与「自己配的」无从分辨）
  assert.notEqual(
    readFileSync(customFile).length,
    readFileSync(resolve(packageRoot, 'assets/personas/placeholder.svg')).length,
    '自建预设贴图不得与内置缺图占位相同（两者语义不同：自己配的 vs 官方提供）'
  )
})

check('所有破坏性端点都校验 HTTP 方法（GET 不得触发写入）', () => {
  // 发版前安全收口时实测发现的真实缺陷：/api/soul/config/reset **完全没有**方法
  // 校验，任何 HTTP 方法都会执行破坏性写入（重置配置、必要时丢弃并备份损坏文件）。
  //
  // 为什么这条风险等级不低：**GET 不是「安全」的同义词** —— 浏览器预取、爬虫、
  // <img src>、链接预览、代理探测都会发 GET。缺少校验意味着一个 GET 就能重置
  // 用户配置。同期的 personas/save、personas/delete 都有校验，此处属遗漏。
  //
  // 两类端点的判定方式不同，必须分开校验（用同一把尺子会误报）：
  //   ① 读写复用（/api/soul/config）：显式 `if (method === 'GET') … else if (POST)'
  //      —— 未覆盖的方法自然落空，不需前置 405；
  //   ② 纯写（reset / save / use / delete）：必须**前置**拦截非 POST 并回 405，
  //      否则任何方法都会执行写入。
  const bodyOf = (path) => {
    const at = indexCode.indexOf(`path: '${path}'`)
    assert.ok(at > 0, `找不到路由 ${path}`)
    const next = indexCode.indexOf("path: '/api/soul/", at + 10)
    return indexCode.slice(at, next > at ? next : at + 4000)
  }

  // ① 读写复用端点的契约：两条分支都在
  const cfgBody = bodyOf('/api/soul/config')
  assert.match(cfgBody, /if \(req\.method === 'GET'\) \{/, '/api/soul/config 应有显式 GET 分支')
  assert.match(cfgBody, /\} else if \(req\.method === 'POST'\) \{/, '/api/soul/config 应有显式 POST 分支')

  // ② 纯写端点的契约：前置拦截非 POST 且回 405
  for (const path of ['/api/soul/config/reset', '/api/soul/personas/save', '/api/soul/personas/use', '/api/soul/personas/delete']) {
    const body = bodyOf(path)
    assert.match(
      body,
      /if \(req\.method !== 'POST'\) \{/,
      `${path} 是纯写端点，必须前置校验 req.method !== 'POST'（否则 GET 也能触发写入）`
    )
    assert.match(body, /405/, `${path} 的方法校验应返回 405`)
  }
})

check('人设插画：文件规格达标（≤256KiB / 命名与人设一致 / 无孤儿文件）', () => {
  // 宿主对插件资源有 256KiB 上限；文件名必须与内置人设名完全一致，
  // 否则运行时查不到、静默回退占位图。
  const artDir = resolve(packageRoot, 'assets/personas')
  assert.equal(existsSync(artDir), true, '缺少 assets/personas 目录')
  assert.equal(existsSync(resolve(artDir, 'placeholder.svg')), true, '缺少 placeholder.svg（缺图时要回退到它）')
  const files = readdirSync(artDir)
  const names = builtinPersonaNames()
  const withArt = names.filter((n) => files.some((f) => f.startsWith(`${n}.`)))
  assert.ok(withArt.length > 0, '至少要有一个内置人设配了插画（否则这条契约没有样本）')
  for (const n of withArt) {
    const file = files.find((f) => f.startsWith(`${n}.`))
    const size = statSync(resolve(artDir, file)).size
    assert.ok(size <= 256 * 1024, `assets/personas/${file} 为 ${size} 字节，超过宿主上限 262144 字节`)
    assert.ok(size > 0, `assets/personas/${file} 是空文件`)
    const ext = extname(file).toLowerCase()
    assert.ok(
      ['.webp', '.png', '.jpg', '.jpeg', '.svg'].includes(ext),
      `assets/personas/${file} 的扩展名不在宿主白名单内`
    )
  }
  // 目录里不得有多余文件（拼错的名字永远不会被用到，属于静默垃圾）
  const allowed = new Set([
    ...names.flatMap((n) => ['.webp', '.png', '.jpg', '.jpeg', '.svg'].map((e) => `${n}${e}`)),
    // 两张兜底图：内置缺图 → 鲸鱼；自建预设 → 调色板（形态区分来源）
    'placeholder.svg',
    'custom-placeholder.webp'
  ])
  const orphan = files.filter((f) => !allowed.has(f))
  assert.deepEqual(orphan, [], `assets/personas 下有未被使用到的文件（名字拼错？）：${orphan.join(', ')}`)
})

check('人设插画：竖版卡牌（插画为主视觉），自定义预设用专用默认贴图', () => {
  // 卡牌竖版 —— 插画占卡面顶部的正方形主视觉，名称/摘要压在其上，
  // 效果与按钮在下方的信息区。**所有卡片都出图**：内置按人设名查找，自建用宿主
  // 返回的专用默认贴图（调色板，与官方鲸鱼区分来源）；图未就绪时露出渐变底。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const card = cssBlock.match(/\.soul-persona-card\{([^}]*)\}/)?.[1] ?? ''
  assert.match(card, /flex-direction:column/, '卡牌应为纵向布局（竖版卡：上插画下信息）')
  // 卡片**不能**有 overflow:hidden —— CSS 规范规定 overflow != visible 会强制
  // transform-style: flat，真 3D 翻转会被压平。裁切职责已下沉到 face。
  assert.equal(
    /overflow/.test(card),
    false,
    '卡牌不得有 overflow（会强制 transform-style:flat，3D 翻转失效）；裁切应交给 .soul-persona-face'
  )
  assert.match(
    cssBlock.match(/\.soul-persona-face\{([^}]*)\}/)?.[1] ?? '',
    /overflow:hidden/,
    'face 应承接裁切职责（overflow:hidden + border-radius:inherit）'
  )
  // 插画区：正方形 + 渐变兜底底
  const art = cssBlock.match(/\.soul-persona-art\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(art !== '', '找不到 .soul-persona-art 规则')
  assert.match(art, /aspect-ratio:1\/1/, '插画区应为正方形（卡面主视觉）')
  assert.match(art, /width:100%/, '插画区应占满卡宽')
  assert.match(art, /background:linear-gradient/, '插画区应有渐变兜底底（图未就绪/加载失败时不留空白）')
  assert.match(art, /overflow:hidden/, '插画区应裁掉溢出部分')
  const img = cssBlock.match(/\.soul-persona-art-img\{([^}]*)\}/)?.[1] ?? ''
  assert.match(img, /object-fit:cover/, 'img 应用 object-fit:cover（否则非方形图会变形）')
  assert.match(img, /position:absolute/, 'img 应绝对定位铺满插画区')
  // 渐变遮罩：名称压在图上必须有对比度保证
  const veil = cssBlock.match(/\.soul-persona-art-veil\{([^}]*)\}/)?.[1] ?? ''
  assert.match(veil, /linear-gradient/, '插画底部应有渐变遮罩（否则浅色插画上白字看不清）')
  // 名称压在插画上，用主题的固定白（不是硬编码 #fff）
  const nameRule = cssBlock.match(/\.soul-persona-name\{([^}]*)\}/)?.[1] ?? ''
  assert.match(nameRule, /color:var\(--dsw-static-neutral-bluish-00/, '图上文字应用主题固定白 token（不得硬编码 #fff）')
  // 信息区：效果栏 + 操作区
  const body = cssBlock.match(/\.soul-persona-body\{([^}]*)\}/)?.[1] ?? ''
  assert.match(body, /flex-direction:column/, '信息区应纵向排列')
  const eff = cssBlock.match(/\.soul-persona-eff\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(eff !== '', '找不到效果栏规则 .soul-persona-eff')
  assert.match(eff, /-webkit-line-clamp/, '效果栏应限制行数（卡面空间有限）')
  // 客户端侧：只给内置人设渲染 img，且带 onError 兜底与懒加载
  assert.match(
    clientSource,
    // 所有卡片都出图：内置走按名查找的插画，自建走宿主返回的专用默认贴图。
    // （此前只在 builtin 时才渲染 img —— 本版改为统一出图，仅样式调整。）
    /e\('img', \{[\s\S]{0,80}className: 'soul-persona-art-img'/,
    '所有预设都应渲染插画（自建预设由宿主返回专用默认贴图）'
  )
  assert.match(
    clientSource,
    /\/api\/soul\/persona-art\/\$\{encodeURIComponent\(name\)\}/,
    '插画 URL 应对人设名做 encodeURIComponent'
  )
  assert.match(clientSource, /onError: \(ev\) => \{ ev\.target\.style\.display = 'none' \}/, 'img 需要 onError 兜底（路由不可用时不显示破图）')
  assert.match(clientSource, /loading: 'lazy'/, '插画应懒加载（打开设置页时不必一次请求全部图）')
  // 效果栏文本来源：优先 customInstructions（人格差异的主要载体）
  assert.match(clientSource, /const personaEffectText = /, '缺少效果栏文本函数')
})

check('操作区贴底对齐（摘要长短不一时按钮不错位）', () => {
  // 摘要（效果栏）行数可能 1~3 行，卡片高度固定 ⇒ 操作区必须贴底，
  // 否则效果栏短的那张卡按钮会浮在中间，与其它卡不齐。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const actions = cssBlock.match(/\.soul-persona-actions\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/margin-top:auto/.test(actions), '操作区应 margin-top:auto 贴底，避免效果栏长短导致按钮错位')
  // 效果栏本身要能撑开剩余空间、且限制行数（保证卡片高度可预期）
  const eff = cssBlock.match(/\.soul-persona-eff\{([^}]*)\}/)?.[1] ?? ''
  assert.match(eff, /-webkit-line-clamp:(\d+)/, '效果栏应限制行数')
  const clamp = Number((eff.match(/-webkit-line-clamp:(\d+)/) ?? [])[1] ?? 0)
  assert.ok(clamp >= 2 && clamp <= 4, `效果栏行数应在 2~4 之间（当前 ${clamp}）`)
  // 信息区应能纵向撑满卡片（否则 margin-top:auto 无参照）
  const body = cssBlock.match(/\.soul-persona-body\{([^}]*)\}/)?.[1] ?? ''
  assert.match(body, /flex:1/, '信息区应 flex:1 撑满卡片剩余高度')
})

check('成功内联绿字 + 失败内联红字（宿主 savedNotice/error 同款），不用 toast', () => {
  // 查证（dsh-client-ui-settings-models/lib/client.js）：宿主设置页**从不使用
  // toast**（Toast 引用 = 0）。成功与失败都是设置页内的一行内联文字，完全对称：
  //   成功 → .savedNotice（state-success-primary、12px/18px、role:status、
  //          aria-live:polite），位于标题/简介之后、分组列表之前；
  //   失败 → .error（state-error-primary、12px/18px、role:alert），
  //          就地出现，共 11 处使用。
  // 因此本插件的成功（绿）与失败（红）也用同一形态承载，互斥显示。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  // ① 成功绿字
  assert.match(clientSource, /savedNotice && e\('p', \{/, '成功提示应为内联 <p>')
  assert.match(clientSource, /role: 'status'/, '成功绿字应有 role=status（宿主同款）')
  assert.match(clientSource, /'aria-live': 'polite'/, '成功绿字应有 aria-live=polite（宿主同款）')
  const notice = cssBlock.match(/\.soul-saved-notice\{([^}]*)\}/)?.[1] ?? ''
  assert.match(notice, /color:var\(--dsw-alias-state-success-primary\)/, '绿字颜色应为 state-success-primary（宿主同款）')
  assert.match(notice, /font-size:12px;line-height:18px/, '绿字规格应为 12px/18px（宿主同款）')
  // ② 失败红字（与绿字对称）
  assert.match(clientSource, /errorNotice && e\('p', \{/, '失败提示应为内联 <p>（宿主设置页不用 toast）')
  assert.match(clientSource, /role: 'alert'/, '失败红字应有 role=alert（宿主同款）')
  const errRule = cssBlock.match(/\.soul-error-notice\{([^}]*)\}/)?.[1] ?? ''
  assert.match(errRule, /color:var\(--dsw-alias-state-error-primary\)/, '红字颜色应为 state-error-primary（宿主同款）')
  assert.match(errRule, /font-size:12px;line-height:18px/, '红字规格应为 12px/18px（宿主同款）')
  // ③ 互斥：失败压过成功（用户要看最新一次操作的结果）
  assert.match(clientSource, /!errorNotice && savedNotice && e\('p', \{/, '失败时应只显示红字（成功绿字被压过）')
  assert.match(clientSource, /setSavedNotice\(null\)\s*\n\s*setErrorNotice\(text\)/, 'showError 应先清成功提示再写失败')
  // ④ 生命周期：绿字在开始编辑（dirty）时清除（宿主语义）
  assert.match(clientSource, /if \(dirty\) setSavedNotice\(null\)/, '绿字应在开始编辑（dirty）时清除（宿主语义）')
  // ⑤ 不得再有任何 toast（宿主设置页 Toast 引用 = 0）
  assert.equal(/ui\.Toast/.test(clientCode), false, '不应再引用 ui.Toast（宿主设置页从不使用 toast）')
  assert.equal(/\.soul-toast/.test(cssBlock), false, '不应残留自绘的 .soul-toast 样式')
  assert.equal(/showToast/.test(clientCode), false, '不应残留 showToast 调用（成功/失败都走内联文字）')
  // ⑥ 文案键：notice.*（成功）与 toast.*（失败）双语齐备
  for (const k of ['notice.saved', 'notice.noChanges', 'notice.reset', 'notice.resetRecovered', 'notice.personaSaved', 'notice.personaUsed', 'notice.personaDeleted']) {
    assert.ok(clientSource.includes(`'${k}':`), `缺少成功文案键 ${k}`)
  }
  for (const k of ['toast.saveFailed', 'toast.resetFailed', 'toast.personaPartial']) {
    assert.ok(clientSource.includes(`'${k}':`), `缺少失败文案键 ${k}`)
  }
})

check('客户端的动效尊重 prefers-reduced-motion（光轨 / 圆点）', () => {
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const reduced = cssBlock.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\}/g) ?? []
  assert.ok(reduced.length > 0, '客户端没有任何 prefers-reduced-motion 规则')
  const all = reduced.join('')
  // 自绘动效的元素必须自己停：光轨层、快捷开关圆点。
  // 提示条**不在此列** —— 已改用宿主的 ui.Toast，它的 Toast.module.css 自带
  // reduced-motion 分支（去掉滑入、保留延迟淡出）。所以这里反向断言：
  // 只要还存在 .soul-toast 规则，就说明有人在自绘提示条。
  for (const [needle, why] of [
    ['.soul-trail-layer', '光轨流动'],
    ['.soul-quick-toggle', '快捷开关圆点的脉冲']
  ]) {
    assert.ok(all.includes(needle), `prefers-reduced-motion 未覆盖 ${needle}（${why}）`)
  }
  assert.equal(
    /\.soul-toast/.test(cssBlock),
    false,
    '不应再自绘提示条（.soul-toast）—— 已改用宿主 ui.Toast，动效与 reduced-motion 由宿主负责'
  )
})

check('客户端预设行摘要不读「关于你」，且三处共用同一份实现', () => {
  // 行摘要显示「这个预设会改变什么」。身份字段已不属于预设，摘要再显示昵称就会
  // 与「应用它不会动昵称」自相矛盾。
  //
  // 0.9.0-d 起这个函数提到模块级（personaRowMetaOf，多一个 t 参数），因为会话 tab
  // 与工作区卡片也要用同一份措辞。判据随之改到新名字 —— 守的语义一字未变。
  const block = clientCode.match(/const personaRowMetaOf = \(entry, t\) => \{([\s\S]*?)return parts\.join/)
  assert.ok(block, '缺少 personaRowMetaOf（模块级版本）')
  for (const key of PROFILE_FIELDS) {
    assert.equal(block[1].includes(`row.${key}`), false, `预设行摘要不应读取 ${key}`)
  }
  // 反向防空过：摘要仍要读人设维度，否则「不读身份字段」会因为整个函数被掏空而假通过
  assert.ok(/row\.style/.test(block[1]), '预设行摘要仍应读 style')
  // 三处必须共用同一份实现：设置页 / 会话 tab / 工作区卡片各自写一份的话，
  // 同一个预设会在三处显示三种摘要（本项目已因手工同步的清单踩过两次）。
  assert.equal(
    (clientCode.match(/const personaRowMetaOf = /g) || []).length,
    1,
    'personaRowMetaOf 只能有一份实现'
  )
  assert.ok(
    /const personaRowMeta = \(entry\) => personaRowMetaOf\(entry, t\)/.test(clientCode),
    '设置页应薄包装到模块级实现，不得保留第二份'
  )
})

check('服务端五条写路径都拒绝内置名，读取路径都走合并库', () => {
  // HTTP 保存 / 删除各一处，/soul 命令的 save / del 各一处，
  // 再加 0.8.0-c 的「恢复预设」——它也是一条写路径。
  // 恢复路径这一处不是冗余防御：记录文件按契约是**不可信输入**（可以被人手改），
  // 手工塞进 removed 列表里的内置名若不拦，就会造出一个遮蔽内置预设的同名自定义条目。
  const rejections = indexCode.split('isBuiltinPersona(personaName)').length - 1
  assert.equal(rejections, 5, `内置名拒绝点应为 5 处（HTTP 2 + 命令层 2 + 恢复预设 1），实际 ${rejections} 处`)
  assert.ok(indexCode.split('mergePersonas(').length - 1 >= 3, '预设库读取应统一走 mergePersonas')
  assert.ok(/resolvePersona\(personaName, config\.personas\)/.test(indexCode), '命令层 use 未走 resolvePersona')
  assert.ok(/resolvePersona\(personaName, current\.personas\)/.test(indexCode), 'HTTP use 未走 resolvePersona')
})

check('匹配逻辑只在纯模块实现一份（不留本地重复实现）', () => {
  assert.equal(
    indexCode.includes('function declaredPersonaKeys'),
    false,
    'index.mjs 不应自带 declaredPersonaKeys——已下沉到 lib/personas.mjs，两份实现会漂移'
  )
  assert.ok(/personaMatches\(/.test(indexCode), 'index.mjs 应调用 personaMatches 做 ★ 判定')
})

// ---------- 提示词预览（草稿编译）----------

// 抽出参与提示词编译的全部函数源码：compilePrompt 及其两个子构建器。
// 只扫部分函数会漏掉字段，故三者一起扫。
function promptCompilerSource() {
  const chunks = []
  for (const name of ['buildUserProfile', 'buildBehavior', 'compilePrompt']) {
    const matched = indexCode.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(matched, `index.mjs 中找不到函数 ${name}`)
    chunks.push(matched[0])
  }
  return chunks.join('\n')
}

check('草稿预览端点复用保存路径的校验与编译，且不落盘、不注入', () => {
  const matched = indexCode.match(/path: '\/api\/soul\/prompt\/preview'[\s\S]*?\n    \}\)/)
  assert.ok(matched, '缺少 /api/soul/prompt/preview 端点')
  const body = matched[0]
  assert.ok(/sanitizeConfig\(parsed\.body\)/.test(body), '草稿预览未复用 sanitizeConfig（未校验的草稿会编出误导性提示词）')
  assert.ok(/compilePrompt\(draft\)/.test(body), '草稿预览未调用 compilePrompt')
  assert.ok(/req\.method !== 'POST'/.test(body), '草稿预览应限制为 POST')
  assert.equal(/saveConfig\(/.test(body), false, '草稿预览不得落盘（不应调用 saveConfig）')
  assert.equal(/refreshPromptAndInject\(/.test(body), false, '草稿预览不得注入会话（不应调用 refreshPromptAndInject）')
})

check('客户端「参与编译的字段」与宿主 compilePrompt 实际读取的字段一致', () => {
  const block = clientCode.match(/const PROMPT_FIELD_KEYS = \[([\s\S]*?)\]/)
  assert.ok(block, '客户端缺少 PROMPT_FIELD_KEYS')
  const clientKeys = [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()

  // 「参与编译的字段」由配置层单点定义（总开关 + 关于你 + 人设）。这里刻意**不**用
  // PERSONA_FIELDS —— 预设能覆盖的字段与编译读取的字段是两回事，混用会在改预设范围
  // 时把这条契约连带改错。
  const driven = new Set(PROMPT_INPUT_FIELDS)
  const hostKeys = [...new Set([...promptCompilerSource().matchAll(/config\.(\w+)/g)].map((m) => m[1]))]
    .filter((key) => driven.has(key))
    .sort()

  assert.deepEqual(
    clientKeys,
    hostKeys,
    'PROMPT_FIELD_KEYS 与实际参与编译的字段不一致：漏字段会让预览显示陈旧内容，多字段会触发无谓重编译'
  )
  assert.ok(clientKeys.length >= 5, `参与编译的字段过少：${clientKeys.length}`)
})

check('NON_PROMPT_FIELDS 由 DEFAULT_CONFIG 减去 PROMPT_INPUT_FIELDS 推导，且编译源码读取的字段全部已登记', () => {
  // 这一对断言是**互相依存**的，缺一条另一条就会变成空话：
  //   - 「推导」保证新增字段默认被当成影响提示词（方向安全：最坏多刷新一次，
  //     而不是「改了不生效」）；
  //   - 但推导只有在「compilePrompt 只读 PROMPT_INPUT_FIELDS 里的字段」为真时才安全。
  //     若将来有人往 compilePrompt 里加了一个 config.X 却忘了登记进 PROMPT_INPUT_FIELDS，
  //     那个字段会被推导进 NON_PROMPT_FIELDS —— 于是「改了它，提示词不变」，
  //     而且没有任何报错。这是本插件最坏的一类静默失败，所以必须在这里钉死。

  // ① 不得退回手写清单：index.mjs 里该常量必须由 DEFAULT_CONFIG 与 PROMPT_INPUT_FIELDS 推出
  const derived = indexCode.match(/const NON_PROMPT_FIELDS = new Set\([\s\S]*?\)\n/)
  assert.ok(derived, 'index.mjs 缺少 NON_PROMPT_FIELDS 定义')
  assert.ok(/Object\.keys\(DEFAULT_CONFIG\)/.test(derived[0]), 'NON_PROMPT_FIELDS 必须由 Object.keys(DEFAULT_CONFIG) 推导，不得手写清单')
  assert.ok(/PROMPT_INPUT_FIELDS\.includes/.test(derived[0]), 'NON_PROMPT_FIELDS 必须用 PROMPT_INPUT_FIELDS 做筛选')
  assert.equal(
    /'trailEnabled'|'trailColor'/.test(derived[0]),
    false,
    'NON_PROMPT_FIELDS 里不得再出现手写的字段名（这正是漏掉 requireToolConfirmation / historyMaxEntries 的成因）'
  )
  assert.ok(/from '\.\/lib\/config\.mjs'|PROMPT_INPUT_FIELDS,/.test(indexCode), 'index.mjs 应 import PROMPT_INPUT_FIELDS')

  // ② 推导的安全前提：编译源码读取的每个 config.X 都必须在 PROMPT_INPUT_FIELDS 里
  const registered = new Set(PROMPT_INPUT_FIELDS)
  const readKeys = [...new Set([...promptCompilerSource().matchAll(/config\.(\w+)/g)].map((m) => m[1]))]
  assert.ok(readKeys.length >= 8, `编译源码里解析到的字段过少：${readKeys.length}（正则或函数边界可能已失效）`)
  const unregistered = readKeys.filter((key) => !registered.has(key))
  assert.deepEqual(
    unregistered,
    [],
    `提示词编译读取了未登记的字段：${unregistered.join(', ')}。` +
      '它们会被推导进 NON_PROMPT_FIELDS，导致「改了配置但提示词不更新」且不报错。' +
      '若确属提示词字段，请加进 lib/config.mjs 的 PROMPT_INPUT_FIELDS；' +
      '若确实不影响提示词，请把读取从这几个函数里移出去。'
  )

  // ③ 两个集合必须互补且覆盖 DEFAULT_CONFIG 全键（推导语法错了会两边都漏）
  const all = Object.keys(DEFAULT_CONFIG)
  const promptSide = all.filter((key) => registered.has(key))
  const nonPromptSide = all.filter((key) => !registered.has(key))
  assert.equal(promptSide.length + nonPromptSide.length, all.length, 'DEFAULT_CONFIG 键分类不完整')
  assert.deepEqual(promptSide.slice().sort(), [...PROMPT_INPUT_FIELDS].sort(), 'PROMPT_INPUT_FIELDS 里出现了 DEFAULT_CONFIG 之外的键')
  // 不写死数字：列出**必须**落在非提示词一侧的字段。
  //
  // 0.8.1 及以前这里钉的是 `nonPromptSide.length === 6`。加一个配置字段就得改数字 ——
  // 而那正是「数字变了再改成新数字」的仪式：它防不住真正的错误（漏登记一个**提示词**
  // 字段，那由上面 ② 守），只会在每次加字段时逼人改常量。改为按语义断言。
  const mustBeNonPrompt = ['requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth', 'historyMaxEntries', 'workspaces']
  for (const key of mustBeNonPrompt) {
    assert.equal(
      registered.has(key),
      false,
      `${key} 不应出现在 PROMPT_INPUT_FIELDS —— 它不影响提示词文本，登记进去会让「改它」无谓地重启提示词并向活动会话注入`
    )
  }
  // workspaces 尤其危险：它是**复合结构**且由工作区标识作键。若把它算进提示词字段，
  // 每加一个工作区都会向所有活动会话注入一条「配置已更新」。
  assert.equal(all.includes('workspaces'), true, 'DEFAULT_CONFIG 应包含 workspaces（0.9.0）')
})

check('客户端复刻的枚举常量与宿主 lib/config.mjs 逐项一致', () => {
  // 浏览器模块表不允许 client/index.mjs import lib/config.mjs，所以客户端必须**复刻**
  // 一份常量；这些常量本身写着「与 lib/config.mjs 的合法值保持一致」，但那只是注释。
  // 漂移后果各不相同且都不报错：
  //   - 少了取值：下拉框少一档，用户在界面上根本选不到该能力
  //   - 多了取值：界面能选、宿主 sanitizeConfig 拒绝 ⇒ 保存报 400
  //   - 换了取值：与宿主枚举错位，脏检查与保存载荷对不上
  // 因此这里从两端各取一次真相再比对：宿主用 import 到的真实值，客户端按源文本解析。
  const specs = [
    ['STYLE_VALUES', STYLE_VALUES],
    ['TRAIT_VALUES', TRAIT_VALUES],
    ['REPLY_LENGTH_VALUES', REPLY_LENGTH_VALUES],
    ['LANGUAGE_VALUES', LANGUAGE_VALUES]
  ]
  for (const [name, hostValues] of specs) {
    const m = clientCode.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
    assert.ok(m, `客户端缺少 ${name}`)
    const clientValues = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
    assert.ok(clientValues.length > 0, `客户端 ${name} 解析为空`)
    assert.deepEqual(
      clientValues,
      hostValues,
      `客户端 ${name} 与宿主不一致（客户端 ${JSON.stringify(clientValues)} / 宿主 ${JSON.stringify(hostValues)}）`
    )
  }
})

check('客户端 FIELD_KEYS 覆盖宿主全部配置字段（dirty 门控不漏字段）', () => {
  // FIELD_KEYS 驱动 dirty 判定与保存载荷。漏一个字段的后果是静默的：
  // 改那个字段后「保存」按钮可能仍被禁用（看起来像界面卡住），或保存结果被判成「无变化」。
  //
  // 0.8.1 起 FIELD_KEYS 由两段组合而成（`[...FORM_FIELD_KEYS, ...EXTERNALLY_MANAGED_FIELDS]`）：
  // 「保留条数」搬去插件详情页后不再属于设置页表单，但**仍然是一个配置字段**，
  // 必须继续被这张全集表覆盖。所以这里按组合语义解析，而不是要求它仍是单个数组字面量
  // —— 断言要守的是「全集对不对」，不是「写法长什么样」。
  const parseKeys = (name) => {
    const m = clientCode.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`))
    assert.ok(m, `客户端缺少 ${name}`)
    return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  }
  const m = clientCode.match(/const FIELD_KEYS = \[([^\]]*)\]/)
  assert.ok(m, '客户端缺少 FIELD_KEYS')
  const clientKeys = m[1].includes('...')
    // 组合式：把每个展开项按同名常量解析出来再拼起来
    ? m[1].split(',').flatMap((part) => {
      const spread = part.trim().match(/^\.\.\.(\w+)$/)
      return spread ? parseKeys(spread[1]) : part.trim().match(/'([^']*)'/g) || []
    }).map((x) => x.replace(/'/g, ''))
    : parseKeys('FIELD_KEYS')
  const hostFields = Object.keys(DEFAULT_CONFIG).sort()
  assert.deepEqual(
    [...clientKeys].sort(),
    hostFields,
    'FIELD_KEYS 必须与宿主 DEFAULT_CONFIG 的字段集合完全相同（漏字段会让 dirty 检测失效）'
  )
  // 顺序无关紧要但重复有害：同一字段出现两次会让 dirty 判定重复计算。
  assert.equal(new Set(clientKeys).size, clientKeys.length, 'FIELD_KEYS 含重复字段')
  // 组合式写法下，两段不得交叉：表单字段与「别处管理」的字段是互斥集合，
  // 交叉会让「这个字段归谁管」变成两处都要读才能回答。
  const formKeys = parseKeys('FORM_FIELD_KEYS')
  const externalKeys = parseKeys('EXTERNALLY_MANAGED_FIELDS')
  assert.deepEqual(
    formKeys.filter((k) => externalKeys.includes(k)),
    [],
    'FORM_FIELD_KEYS 与 EXTERNALLY_MANAGED_FIELDS 不得有交集'
  )
  // dirty 判定必须只用表单段：拿全集去比，会让表单对一个它并不持有的字段反复比较。
  // （全集里可能包含表单没有的字段，那样 dirty 会恒为真或恒为假 —— 都不是想要的语义。）
  const dirtyExpr = clientCode.match(/const dirty = (\w+)\.some\(/)
  assert.ok(dirtyExpr, '应能读到 dirty 的判定表达式')
  assert.equal(dirtyExpr[1], 'FORM_FIELD_KEYS', 'dirty 必须只看 FORM_FIELD_KEYS（表单实际持有的字段）')
})

check('预设应用只有一条实现路径，且非法字段必须回报（HTTP 与 /soul use 共用）', () => {
  // 两条应用路径（POST /api/soul/personas/use 与 /soul use）此前各自内联一份
  // `sanitizeConfig(pickPersonaValues(entry))`，且都只取 patch、把 errors 丢掉 ⇒
  // 「部分应用」被报成成功（实测：style / emoji 被静默丢弃，仍返回 ok:true）。
  // 现已收口到 applyPersonaEntry。这里钉三件事：
  //   ① 该校验全仓只允许出现在收口函数里（再写一份必漏 errors）；
  //   ② 两条路径都真的走收口函数；
  //   ③ 收口函数把 errors 换算成 invalid / applied 回报，且调用方真的消费。
  // 一律匹配**去注释后**的源码：注释里写着「applied 是…」就能让裸 includes 恒真
  // （本条初版正是这么写的，被自己的变异实验抓到 —— 与 M5 同一漏洞类别）。
  const bare = stripComments(indexSource)
  const inlined = [...bare.matchAll(/sanitizeConfig\(pickPersonaValues\(entry\)\)/g)].length
  assert.equal(inlined, 1, `预设取值校验只应有一处实现（收口在 applyPersonaEntry），实际 ${inlined} 处`)
  const uses = [...bare.matchAll(/await applyPersonaEntry\(ctx, entry\)/g)].length
  assert.equal(uses, 2, `HTTP 与 /soul use 都应走 applyPersonaEntry，实际 ${uses} 处`)
  const body = stripComments(extractObject(indexSource, 'async function applyPersonaEntry'))
  assert.ok(body !== '', '找不到 applyPersonaEntry')
  for (const token of ['invalid', 'applied', 'Object.keys(errors)']) {
    assert.ok(body.includes(token), `applyPersonaEntry 未回报 ${token}：非法字段会被静默丢弃`)
  }
  assert.ok(/invalid\.length > 0/.test(bare), '命令路径未按 invalid 分支提示（usePartial / useAllInvalid）')
  assert.ok(/invalid \}/.test(bare), 'HTTP 响应未带出 invalid')
  // 双语文案表必须提供这两个键，否则部分应用时界面上没有对应文案
  for (const lang of ['zh', 'en']) {
    const keys = tableLangKeys(indexSource, 'COMMAND_MESSAGES', lang)
    for (const key of ['usePartial', 'useAllInvalid']) {
      assert.ok(keys.has(key), `COMMAND_MESSAGES.${lang} 缺少 ${key}`)
    }
  }
})

check('命令层的三处行为契约（覆盖列 / 键名大小写 / 昵称兜底）', () => {
  // ① `/soul list` 不得再显示预设的「关于你」：v0.7.1 起预设不含 nickname，
  //    normalizePersonas 也会剥离它 ⇒ 显示 `昵称=${entry.nickname || '-'}` 恒为
  //    `昵称=-`，是一列永远没有信息的死数据。改为报告覆盖了几个维度。
  const listBody = extractObject(indexCode, "if (first === 'list')")
  assert.ok(listBody !== '', '找不到 /soul list 分支')
  assert.equal(/entry\.nickname/.test(listBody), false, '/soul list 不得再读 entry.nickname（预设已不含该字段，会恒显示「-」）')
  assert.ok(/listCovers/.test(listBody), '/soul list 应报告覆盖的维度数（listCovers）')
  // ② 键名忽略大小写，且必须**映射回真实字段名**：直接 toLowerCase 会把 headingLists
  //    压成 headinglists 反而匹配不上白名单，所以查表还原（STYLE → style）。
  assert.ok(/COMMAND_FIELD_BY_LOWER/.test(indexCode), '缺少字段名小写索引表')
  assert.ok(/normalizeSetKey\(rawKey\)/.test(indexCode), '/soul set 未对键名做大小写归一化')
  assert.ok(
    /new Map\(Object\.keys\(DEFAULT_CONFIG\)\.map/.test(indexCode),
    '字段名索引表应由 DEFAULT_CONFIG 生成（手写列表会漂移）'
  )
  // ③ 昵称兜底是**刻意的设计**：非关键字输入整体视为昵称（/soul help 会写昵称）。
  //    这条断言把设计钉住，避免有人顺手加 help/status 关键字而无声改变语义。
  assert.ok(
    /!COMMAND_KEYWORDS\.has\(first\)[\s\S]{0,400}?sanitizeConfig\(\{ nickname: raw \}\)/.test(indexCode),
    '非关键字输入应整体视为昵称（该行为是设计，改动需同步文档与断言）'
  )
  for (const key of ['help', 'status', 'version']) {
    assert.equal(
      new RegExp(`COMMAND_KEYWORDS = new Set\\(\\[[^\\]]*'${key}'`).test(indexCode),
      false,
      `COMMAND_KEYWORDS 不应包含 ${key}：那会改变「非关键字即昵称」的既有语义`
    )
  }
})

check('0.9.0-f 回收命令：/soul sessions 默认 dry-run，只有 --apply 才删', () => {
  // 关键字必须登记，否则整串会被当成昵称（`/soul sessions` 会把昵称改成 "sessions"）
  assert.match(indexCode, /COMMAND_KEYWORDS = new Set\(\[[^\]]*'sessions'/, 'COMMAND_KEYWORDS 应包含 sessions')

  const body = indexCode.match(/if \(first === 'sessions'\)[\s\S]*?\n          \}/)
  assert.ok(body, '找不到 /soul sessions 分支')
  // ① 默认 dry-run：不传 --apply 时绝不能删除任何东西
  assert.match(body[0], /--apply/, '应识别 --apply 开关')
  assert.match(body[0], /planSessionGc\(ctx\)/, '应复用与 HTTP 路由同一个规划函数（两处判定必须一致）')
  // ② 反向：命令分支里**不得**出现任何直接删除文件的调用 ——
  //    删除只能发生在已经显式 apply 的路径上，而这条命令默认不 apply。
  assert.equal(
    /rm\(|unlink|rmSync/.test(body[0]),
    false,
    '/soul sessions 不得直接删文件：它的职责是出报告，真删由显式 apply 的路径执行'
  )

  // ③ 报告文案必须区分「扫描不可用」与「没有可回收项」——两者都表现为"没东西"
  const zhTable = indexSource.slice(indexSource.indexOf('  zh: {'))
  const report = zhTable.match(/sessionsGcReport:[\s\S]*?\n    \},/)
  assert.ok(report, '缺少 sessionsGcReport 文案')
  assert.match(report[0], /plan\.scanComplete/, '报告必须区分扫描是否完整')
  assert.match(report[0], /--apply/, 'dry-run 时必须告诉用户怎么真删')
})

check('枚举值 trim 与文本字段同规则', () => {
  // 文本字段本来就 trim（见上面的 TEXT_FIELDS 断言），枚举不 trim 会让
  // `/soul set style= humorous`（= 后带空格）被拒，而 `bio= 张三` 却能成功 ——
  // 同一命令里两套规则。这里直接对真实 sanitizeConfig 断言行为。
  assert.equal(sanitizeConfig({ style: ' humorous' }).patch.style, 'humorous')
  assert.equal(sanitizeConfig({ replyLength: ' concise ' }).patch.replyLength, 'concise')
  assert.equal(sanitizeConfig({ trailSpeed: ' fast' }).patch.trailSpeed, 'fast')
  // 防空过：trim 不能把非法值放进来
  assert.ok(sanitizeConfig({ style: '  humorous  ' }).errors.style === undefined)
  assert.ok(sanitizeConfig({ style: 'bogus' }).errors.style !== undefined, '非法枚举仍须被拒')
  assert.ok(sanitizeConfig({ style: '' }).errors.style !== undefined, '空串仍须被拒')
})

check('客户端标题徽标的版本号与 package.json 一致', () => {
  // 宿主端已由下一条断言钉住「唯一来源 package.json」；客户端因为拿不到该模块系统，
  // 只能复刻一个字面量显示在标题右上角。这处漂移此前**完全无人看管**（实测：把它改成
  // 9.9.9 后整套 verify 依然全绿），而症状是界面上写着错误的版本号。
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const m = clientCode.match(/const VERSION = '([^']+)'/)
  assert.ok(m, '客户端缺少 VERSION 常量')
  assert.equal(
    m[1],
    manifest.version,
    `客户端标题徽标显示 v${m[1]}，而 package.json 是 ${manifest.version}（升版本时漏改这一处）`
  )
})

check('客户端版本号是唯一需要手工同步的常量（不再新增同类副本）', () => {
  // VERSION 是历史遗留的复刻点（上面一条断言已保证它与 package.json 一致）。
  // 除此之外不应再出现别的版本常量，否则每加一处就多一处漏改风险。
  const hits = [...clientSource.matchAll(/const\s+(?:PLUGIN_)?VERSION\s*=/g)].length
  assert.equal(hits, 1, `客户端版本常量应恰好 1 处（VERSION），实际 ${hits} 处`)
})

check('客户端在有未保存编辑时预览草稿，否则预览已生效提示词', () => {
  assert.ok(/async previewPrompt\(draft\)/.test(clientCode), '控制器缺少 previewPrompt')
  assert.ok(/await controller\.previewPrompt\(promptDraft\(\)\)/.test(clientCode), '未调用草稿预览端点')
  assert.ok(/const promptDirty = PROMPT_FIELD_KEYS\.some\(/.test(clientCode), 'promptDirty 应由 PROMPT_FIELD_KEYS 判定（改光轨不该让预览变成草稿）')
  // 只断言下面的三元语法不够：把 asDraft 写死成 false 也能让三元看起来「正确」，
  // 但预览就永远只看已生效内容了。必须把「草稿判定来源于 promptDirty」这一环钉住。
  assert.ok(/const asDraft = promptDirty\b/.test(clientCode), 'asDraft 必须取自 promptDirty，否则预览会永远停留在已生效内容')
  assert.ok(/asDraft\s*\?\s*await controller\.previewPrompt/.test(clientCode), '草稿分支未按 asDraft 选择端点')
})

check('提示词预览的编译入口唯一（避免重复请求与过期闭包）', () => {
  assert.equal(
    clientCode.includes('if (showPrompt) await loadPrompt()'),
    false,
    '保存/重置/应用预设处理器内不应再直接编译预览——刷新统一由 effect 驱动，两处调用会重复请求并可能用到过期闭包'
  )
  const effect = clientCode.match(
    /const promptSettled = React\.useRef\(false\)[\s\S]*?\}, \[showPrompt, promptDraftKey, promptDirty\]\)/
  )
  assert.ok(effect, '缺少预览驱动 effect')
  assert.equal(
    effect[0].split('void loadPrompt()').length - 1,
    2,
    'effect 应有两个编译触发点：刚展开时立即一次、此后防抖一次'
  )
})

check('提示词预览新增文案键中英各一份', () => {
  for (const key of ['prompt.titleDraft', 'prompt.summaryDraft', 'prompt.invalid']) {
    const hits = clientSource.split(`'${key}':`).length - 1
    assert.equal(hits, 2, `${key} 应在 zh / en 各出现一次，实际 ${hits} 次`)
  }
})

// ---------- 系统提示词插值 ----------

check('系统提示词 section 显式关闭宿主插值', () => {
  // 用括号配平取 section(...) 的**整个选项对象**，而不是「anchor 起 1500 字符」的
  // 固定窗口：窗口式取法在注册点与选项之间多出约 1100 字符（注释或代码）后就会
  // 把 interpolate 推出窗口而假失败，且附近再出现一个 section 注册时可能锚错对象。
  const opts = stripComments(extractObject(indexSource, 'spCtx.systemPrompt.section('))
  assert.ok(opts !== '', '找不到 spCtx.systemPrompt.section(...) 调用')
  // 先确认锚对了对象（否则下面的断言可能对着别的 section 通过）
  assert.ok(/name:\s*'soul:persona'/.test(opts), 'section 选项对象里没有 soul:persona（锚点异常）')
  assert.ok(
    /interpolate:\s*false/.test(opts),
    'section 必须显式写 interpolate: false —— 宿主默认开启且是严格模式，' +
      '用户只要在「自定义指令」里写出一对完整的 {{...}} 就会让 renderPrompt 抛错；' +
      '该错位于 agent.step() 开头且无 try/catch ⇒ 该会话每一轮都失败'
  )
  assert.equal(/interpolate:\s*true/.test(opts), false, 'interpolate 不得为 true')
})

// ---------- 配置持久化（原子写 / 损坏不覆盖）----------

const storeSource = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')
const storeCode = stripComments(storeSource)

check('配置读取区分「文件不存在」与「文件损坏」，失败时不缓存', () => {
  const matched = indexCode.match(/async function loadConfig\(\)[\s\S]*?\n\}/)
  assert.ok(matched, 'index.mjs 中找不到 loadConfig')
  const body = matched[0]
  assert.ok(/readConfigFile\(/.test(body), 'loadConfig 应经由 lib/store.mjs 读取（失败类型的判定在那里）')
  assert.ok(/configLoadFailure = failure/.test(body), 'loadConfig 必须记录失败，供写入路径拒绝保存')
  assert.ok(/return \{ \.\.\.DEFAULT_CONFIG \}/.test(body), '失败时回退默认值（保证插件与设置页仍可用）')

  const failBlock = body.match(/if \(failure\) \{[\s\S]*?\n  \}/)
  assert.ok(failBlock, '找不到 loadConfig 的失败分支')
  assert.equal(
    /configCache\s*=/.test(failBlock[0]),
    false,
    '失败分支不得写入 configCache：缓存了默认值，用户修好文件后不重启就恢复不了'
  )
})

check('「是否允许写入」的判定只在 lib/store.mjs 实现一份', () => {
  assert.equal(
    /function configWriteRefusal|function describeConfigFailure/.test(indexCode),
    false,
    'index.mjs 不应自带失败说明 / 拒绝判定的实现——写入路径有四条，本地再写一份必然漂移'
  )
  assert.ok(
    /configWriteRefusal\(configLoadFailure, configPath\(\)\)/.test(indexCode),
    'saveConfig 应调用 configWriteRefusal 决定是否拒绝写入'
  )
})

check('配置写入只有一条路径：lib/store.mjs 的「临时文件 + rename」', () => {
  assert.equal(
    /from 'node:fs\/promises'/.test(indexCode),
    false,
    'index.mjs 不应直接操作文件系统——原子写必须收口在 lib/store.mjs，否则会被绕过'
  )
  assert.ok(/await writeConfigFile\(configPath\(\), clean\)/.test(stripComments(indexSource)), 'saveConfig 应经由 writeConfigFile 写入（匹配去注释后的源码：注释里留字样不算）')
  assert.ok(
    /writeFile\(tmpPath[\s\S]*?rename\(tmpPath, filePath\)/.test(storeCode),
    'lib/store.mjs 的写入必须是「先写 .tmp、再 rename 覆盖」；直接 writeFile 会在中断时留下截断的 JSON'
  )
})

check('set_persona 的输出 schema 能被真实 dsh-tools 的 DSL 接受（注册不失败）', () => {
  // 背景：DSH 的 schema DSL 与 JSON Schema 不同 —— 根级不支持 required（作者错误
  // "schema.required is not supported by the value schema DSL"）、object 属性必须显式
  // 声明 additionalProperties。两者都曾让 defineTool 抛错，再被 .catch() 吞成一条 warn
  // ⇒ set_persona 静默不注册（Agent 无法改人设），而 196 项断言全绿 —— 因为全链
  // 只有 dsh-llm 桩、从未用真实 DSL 校验过 schema。本条就是那个缺口。
  const toolCall = extractCall(indexSource, 'defineTool(')
  assert.ok(toolCall !== '', 'index.mjs 应调用 defineTool 注册 set_persona')
  // 结构层（去注释后）：不得出现根级 required；对象属性必须带 additionalProperties
  const outputSchema = toolCall.slice(toolCall.indexOf('output:'))
  assert.equal(
    /required:\s*\[/.test(outputSchema),
    false,
    'set_persona 输出 schema 不得使用根级 required（DSH DSL 不支持，defineTool 会抛错且被静默吞掉）'
  )
  assert.ok(
    /ok:\s*\{[^}]*required:\s*true/.test(outputSchema),
    'set_persona 输出的 ok 必须用属性级 required: true 声明必填（DSL 的唯一写法）'
  )
  assert.ok(
    /changes:\s*\{[^{}]*additionalProperties:\s*false/.test(outputSchema.replace(/\s+/g, ' ')),
    'set_persona 输出的 changes（object）必须显式声明 additionalProperties: false'
  )
  // 行为层：本机能解析到真实 @deepseek-ai/dsh-tools 时，用**真实 defineTool** 校验
  // schema —— 这是「结构对了但 DSL 仍拒收」这类回归的唯一可靠判据。
  // （顶层 await 已解析；本机未装 DSH 时为 null，CI 上走结构层即可。）
  if (defineTool) {
    // 从真实源码整体抽出 defineTool({...}) 的**定义对象**并求值 —— 不用文本切片去抠
    // render 的函数体（那种写法对括号/箭头/注释极脆弱，初版就在这里求值失败）。
    // 抽出的对象含 parameters / output（schema + render）/ execute，求值后即为宿主
    // 实际会拿到的形状。
    const defText = extractObject(indexSource, 'defineTool(')
    assert.ok(defText !== '', '无法从 index.mjs 抽出 defineTool 的定义对象')
    let definition
    try {
      // 定义对象的 enum 引用了宿主常量（STYLE_VALUES / TRAIT_VALUES / …），求值时注入
      // 真实 import 值 —— 它们本身已由上面「客户端复刻常量 == 宿主定义」那条断言覆盖。
      // eslint-disable-next-line no-new-func
      definition = new Function(
        'STYLE_VALUES', 'TRAIT_VALUES', 'REPLY_LENGTH_VALUES', 'LANGUAGE_VALUES',
        `return (${defText})`
      )(STYLE_VALUES, TRAIT_VALUES, REPLY_LENGTH_VALUES, LANGUAGE_VALUES)
    } catch (err) {
      assert.fail(`defineTool 的定义对象求值失败：${err.message}`)
    }
    assert.ok(definition?.output?.schema, '定义对象缺少 output.schema')
    assert.equal(
      typeof definition.output.render,
      'function',
      'set_persona 的 output 必须提供 render（宿主每次工具成功执行后都会无条件调用它）'
    )

    let tool = null
    assert.doesNotThrow(
      () => {
        tool = defineTool({
          name: 'set_persona',
          description: 'verify-config schema 契约探针',
          parameters: definition.parameters,
          output: definition.output,
          async execute() { return { ok: true } }
        })
      },
      '真实 dsh-tools 的 defineTool 拒绝了 set_persona 的输出 schema（工具将静默注册失败）'
    )

    // 行为层第二段：逐种返回值走一遍 render —— 复刻宿主 createSuccessResult 的必经一步。
    // 缺 render 时 defineTool 仍会把 undefined 包成函数 ⇒ 注册照样通过，但每次成功
    // 调用都在渲染阶段抛 `TypeError: userRender is not a function`（被包成
    // projectionError("render")）—— 这正是「断言只到注册、没到能用」漏掉的那一步。
    for (const value of [
      { ok: true, message: '已更新' },
      { ok: true, message: '提议待确认', pending: true, changes: { style: 'casual' } },
      { ok: false, message: '操作失败：字段非法' },
      { ok: true, message: '配置无变化，未做修改' }
    ]) {
      let rendered
      assert.doesNotThrow(
        () => { rendered = tool.output.render({}, value) },
        `工具结果渲染失败（值：${JSON.stringify(value)}）—— 宿主每次成功执行都会走这里`
      )
      assert.ok(Array.isArray(rendered) && rendered.length > 0, 'output.render 应返回非空数组（DSH 内容块约定）')
      assert.equal(rendered[0].type, 'text', 'output.render 的首个内容块应为 text')
      assert.equal(typeof rendered[0].text, 'string', 'output.render 的 text 必须是字符串')
      assert.ok(rendered[0].text.length > 0, 'output.render 不得返回空文本（模型会看不到任何反馈）')
    }
    return
  }
  if (!skipNote('verify-config', 1, '本机未安装 @deepseek-ai/dsh-tools，set_persona 仅做结构层校验（行为层需真实 DSL）', '安装 DSH 后重跑即可覆盖行为层')) {
    failures.push({ name: 'set_persona schema 行为层（需真实 dsh-tools）', err: new Error('--strict 下跳过按失败处理') })
  }
})

check('set_persona 的模型侧描述必须中英并列', () => {
  // 工具 schema 只在 apply 时注册一次，而宿主 registry 对同名重注册会抛
  // `tool "set_persona" is already registered`（实测 dsh-tools 源码）⇒ 语言切换时
  // **无法**原地换描述。所以描述必须中英并列，覆盖 zh / en 两种界面语言。
  //
  // 只检查 **parameters** 块里的描述：output.schema 的 description 是给宿主/渲染层
  // 用的结构化标注（如「实际发生变化的字段」），不是模型读的自然语言说明 —— 把它
  // 一并纳入会误报（本条初版就这么写的，被断言自己抓出来了）。
  const toolCall = stripComments(extractCall(indexSource, 'defineTool('))
  assert.ok(toolCall !== '', '找不到 defineTool 调用')
  const paramsStart = toolCall.indexOf('parameters:')
  const paramsEnd = toolCall.indexOf('output:', paramsStart)
  assert.ok(paramsStart > 0 && paramsEnd > paramsStart, '无法定位 parameters 块')
  const params = toolCall.slice(paramsStart, paramsEnd)
  const descriptions = [...params.matchAll(/description:\s*\n?\s*((?:'[^']*'\s*\+?\s*)+)/g)]
    .map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join(''))
    .filter((text) => text.length > 0)
  assert.ok(descriptions.length >= 8, `模型侧描述条目过少：${descriptions.length}`)
  for (const text of descriptions) {
    assert.ok(/[\u4e00-\u9fff]/.test(text), `工具描述缺少中文：${text.slice(0, 40)}`)
    assert.ok(/[A-Za-z]{3,}/.test(text), `工具描述缺少英文（zh/en 两种界面都要能读）：${text.slice(0, 40)}`)
  }
})

check('配置损坏时上报原因（设置页不必等一次失败的保存才知道）', () => {
  assert.ok(
    /configError: configLoadFailure \? describeConfigFailure\(configLoadFailure\) : null/.test(indexCode),
    'GET /api/soul/config 应带回 configError，否则用户只会看到「人设无故被重置」'
  )
  assert.ok(
    /s\.error = typeof payload\.configError === 'string'[\s\S]{0,120}?typeof payload\.deliveryWarning === 'string'/.test(clientCode),
    '客户端应同时展示 configError（读不出来）与 deliveryWarning（送不到会话）——两者症状相同、处理方式不同'
  )
})

// ---------- 损坏配置的逃生口（重置）----------

check('移除损坏配置只有一条实现：lib/store.mjs 的 moveAsideConfigFile', () => {
  assert.ok(
    /export async function moveAsideConfigFile\(filePath\)[\s\S]*?await rename\(filePath, target\)/.test(storeCode),
    '必须用 rename 把损坏文件移开——只 copyFile 保留原文件的话，读取仍判定为损坏，重置依然被拒'
  )
  assert.equal(
    /rename\(configPath\(\)|unlink\(configPath\(\)/.test(indexCode),
    false,
    'index.mjs 不应自己搬移/删除配置文件，收口在 lib/store.mjs'
  )
})

check('重置是配置损坏时的逃生口：先移开损坏文件，再复用同一条写入路径', () => {
  // 签名带 source 形参（0.8.0 起用于变更记录的归属），故匹配式允许括号内有内容
  const matched = indexCode.match(/async function resetConfigWithEscape\([\s\S]*?\) \{[\s\S]*?\n\}/)
  assert.ok(matched, 'index.mjs 中找不到 resetConfigWithEscape')
  const body = matched[0]
  assert.ok(/moveAsideConfigFile\(configPath\(\)\)/.test(body), '重置应先移开损坏文件（＝备份到 .corrupt）')
  assert.ok(/configLoadFailure = null/.test(body), '移开之后必须清掉失败标记，否则 saveConfig 仍会拒绝')
  assert.ok(/commitConfig\(/.test(body), '重置应复用 commitConfig，而不是另写一份「读—改—写」')
  assert.ok(
    /commitConfig\([\s\S]*?,\s*source\)/.test(body),
    'source 形参必须穿透给 commitConfig——否则重置动作在变更记录里失去归属'
  )
  assert.ok(
    /catch[\s\S]*?configLoadFailure = failure[\s\S]*?throw/.test(body),
    '写入失败必须恢复失败标记，否则会把「文件仍然不可用」误报成正常'
  )
})

check('两个重置入口都走逃生口（HTTP 与斜杠命令）', () => {
  const route = indexCode.match(/path: '\/api\/soul\/config\/reset'[\s\S]*?\n    \}\)/)
  assert.ok(route, '找不到 /api/soul/config/reset 端点')
  assert.ok(/resetConfigWithEscape\(/.test(route[0]), 'HTTP 重置必须走逃生口')
  assert.ok(/backupPath/.test(route[0]), 'HTTP 重置应回传备份路径，供界面如实说明数据去哪了')
  assert.ok(
    /resetConfigWithEscape\(\{ source: 'web', action: 'reset' \}\)/.test(route[0]),
    'HTTP 重置必须标注来源 web/reset，否则变更记录里认不出这次重置从哪来'
  )

  const resetBranch = indexCode.match(/if \(first === 'reset'\)[\s\S]*?\n          \}/)
  assert.ok(resetBranch, "找不到 /soul reset 分支")
  assert.ok(/resetConfigWithEscape\(/.test(resetBranch[0]), '/soul reset 必须走逃生口')
  assert.ok(/backupPath/.test(resetBranch[0]), '/soul reset 应告知备份位置')
  assert.ok(
    /resetConfigWithEscape\(\{ source: 'command', action: 'reset' \}\)/.test(resetBranch[0]),
    '/soul reset 必须标注来源 command/reset——与网页重置是两个入口，记录里要分得开'
  )

  assert.equal(
    /commitConfig\(current => defaultConfigPreservingPersonas\(current\)\)/.test(indexCode),
    false,
    '不得再有绕过逃生口的重置路径——否则损坏状态下会走到一条必然失败的写'
  )
})

check('提交即留痕：唯一漏斗的每个调用点都自带来源归属', () => {
  // 0.8.0 的变更记录要回答「谁改的」。事后从配置差异里推不出来，所以来源必须由
  // 调用方显式给出 —— 这条断言守的就是「显式」二字：既不许缺，也不许给默认值兜底。
  const signature = indexCode.match(/async function commitConfig\(([^)]*)\)/)
  assert.ok(signature, 'index.mjs 中找不到 commitConfig')
  assert.match(signature[1], /mutate,\s*source/, 'commitConfig 必须有 source 形参')
  assert.equal(
    /source\s*=\s*[^,)]/.test(signature[1]),
    false,
    'source 不得有默认值——默认值会让「忘了标注』的调用点静默算作某个来源，比缺来源更糟'
  )

  // 全部来源标注：18 处调用点各一个。数量写死是刻意的——新增写路径时这里会红，
  // 提醒作者同时决定它的来源归属，而不是让它悄悄落进默认桶。
  // （0.8.0-c 加了两条撤销路径：撤销本身也写配置，于是「我撤销过一次」也留下一条
  // 记录，审计因此是链条而不是快照，能看出「改了、撤了、又改回去」。）
  const expected = [
    ["{ source: 'web', action: 'save' }", 'HTTP 保存配置'],
    ["{ source: 'web', action: 'reset' }", 'HTTP 重置'],
    ["{ source: 'web', action: 'savePreset' }", 'HTTP 保存预设'],
    ["{ source: 'web', action: 'deletePreset' }", 'HTTP 删除预设'],
    ["{ source: 'persona', action: 'use', label: entry && typeof entry.name === 'string' ? entry.name : undefined }", '应用预设（两条入口共用，label 带预设名）'],
    ["{ source: 'command', action: 'nickname' }", '/soul <昵称>'],
    ["{ source: 'command', action: 'reset' }", '/soul reset'],
    ["{ source: 'command', action: 'enable' }", '/soul enable'],
    ["{ source: 'command', action: 'disable' }", '/soul disable'],
    ["{ source: 'command', action: 'savePreset' }", '/soul save'],
    ["{ source: 'command', action: 'deletePreset' }", '/soul del'],
    ["{ source: 'command', action: 'set' }", '/soul set'],
    ["{ source: 'command', action: 'confirm' }", '/soul confirm'],
    ["{ source: 'tool', action: 'setPersona' }", 'set_persona 工具'],
    ["{ source: 'service', action: 'update' }", 'soulConfig.updateConfig'],
    ["{ source: 'service', action: 'reset' }", 'soulConfig.resetConfig'],
    ["{ source: 'rollback', action: 'rollback' }", 'HTTP 撤销'],
    ["{ source: 'restorePersona', action: 'restorePreset' }", 'HTTP 恢复预设'],
    // 0.9.0：工作区覆盖的两条写入路径（绑定 / 解绑）。
    // 两者都走 commitConfig —— 所以它们**也进审计**：用户改了「这个项目用什么人设」，
    // 在变更记录里应当可查（这与 workspaces 字段不进 AUDIT_FIELDS 不矛盾：
    // 字段差分看不见它，但"谁在什么时候提交了一次配置"仍然留痕）。
    ["{ source: 'web', action: 'save' }", 'HTTP 保存（含工作区绑定 / 解绑）']
  ]
  const found = expected.filter(([literal]) => indexCode.includes(literal))
  assert.deepEqual(
    found.map(([literal]) => literal),
    expected.map(([literal]) => literal),
    `缺少来源标注：${expected.filter(([l]) => !indexCode.includes(l)).map(([, who]) => who).join('、')}`
  )
  // 反向：不得有**未登记**的写路径。
  //
  // 判据从"字面量出现次数"改为"去重后与登记表逐一比对"：同一段标注源码里出现多次
  // （例如工作区绑定与解绑共用 `{ source: 'web', action: 'save' }`）是**正常**的 ——
  // 它仍然是同一条写路径语义。真正要拦的是"出现了表里没有的标注"。
  //
  // 正则只取到 `action: 'xx'` 为止（不吞后面的 `, label: ...`）：persona 那条带 label，
  // 用整段匹配会得到与登记表不同的串，报出一个假失败。
  const foundSets = new Set(
    [...indexCode.matchAll(/\{ source: '([a-z][A-Za-z]*)', action: '([A-Za-z]*)'/g)]
      .map((m) => `{ source: '${m[1]}', action: '${m[2]}' }`)
  )
  const registered = new Set(
    expected.map(([literal]) => {
      const m = literal.match(/\{ source: '([^']+)', action: '([^']+)'/)
      return m ? `{ source: '${m[1]}', action: '${m[2]}' }` : literal
    })
  )
  const unregistered = [...foundSets].filter((literal) => !registered.has(literal))
  assert.deepEqual(
    unregistered,
    [],
    `发现未登记的写路径标注：${unregistered.join('、')}。新写路径必须同时登记到本表，否则审计无从判断来源。`
  )

  // 关联性（光有标注不够，还要落在对的地方）：抽几个有稳定锚点的切片来钉，
  // 防止「标注都在，但张冠李戴」——例如把 confirm 的标注挪到 set 上。
  const personaApply = indexCode.match(/async function applyPersonaEntry\(ctx, entry\)[\s\S]*?\n\}/)?.[0] ?? ''
  assert.match(personaApply, /\{ source: 'persona', action: 'use', label: entry && typeof entry\.name === 'string' \? entry\.name : undefined \}/, 'applyPersonaEntry 的来源应是 persona/use 且 label 带预设名')
  const toolSlice = indexSource.match(/defineTool\([\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(toolSlice, /\{ source: 'tool', action: 'setPersona' \}/, 'set_persona 工具的来源应是 tool/setPersona')
  assert.match(indexCode, /updateConfig[\s\S]*?\{ source: 'service', action: 'update' \}/, 'updateConfig 的来源应是 service/update')
  assert.match(indexCode, /resetConfig\(\)[\s\S]*?resetConfigWithEscape\(\{ source: 'service', action: 'reset' \}\)/, 'resetConfig 服务的来源应是 service/reset')
  // 两条撤销路径的来源必须靠在自己的路由切片里（两条路由都调 commitConfig，
  // 标注写反了在「16 处齐不齐」这种判据下完全看不出来）
  const rollbackRoute = indexCode.match(/path: '\/api\/soul\/history\/rollback'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(rollbackRoute, /\{ source: 'rollback', action: 'rollback' \}/, '撤销路由的来源应是 rollback/rollback')
  const restoreRoute = indexCode.match(/path: '\/api\/soul\/history\/restore-persona'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(restoreRoute, /\{ source: 'restorePersona', action: 'restorePreset' \}/, '恢复预设路由的来源应是 restorePersona/restorePreset')

  // 重置的 source 必须由 commitConfig 的形参穿透，而不是在内部写死 —— 否则三个重置
  // 入口（网页 / 命令 / 服务）会在记录里退化成同一个来源。
  const escape = indexCode.match(/async function resetConfigWithEscape\(([^)]*)\)[\s\S]*?\n\}/)
  assert.ok(escape, '找不到 resetConfigWithEscape')
  assert.match(escape[1], /source/, 'resetConfigWithEscape 必须接收 source')
  assert.match(escape[0], /commitConfig\([\s\S]*?,\s*source\)/, 'source 必须穿透给 commitConfig')
})

check('留痕时机在配置落盘之后，且失败不得连带配置写失败', () => {
  const body = indexCode.match(/async function commitConfig\([^)]*\)[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(body !== '', '找不到 commitConfig 函数体')
  const saveAt = body.indexOf('await saveConfig(next)')
  const auditAt = body.indexOf('await auditCommit(')
  assert.ok(saveAt !== -1 && auditAt !== -1, 'commitConfig 应在 saveConfig 之后调用 auditCommit')
  assert.ok(
    saveAt < auditAt,
    '留痕必须在配置落盘之后：反过来的话「配置写失败」会留下一条描述没发生过的变更的记录'
  )

  // 差分基准必须是 saveConfig 的**返回值**（已剔除 tone / presets / examples 等废弃字段），
  // 而不是 mutate 的产物 —— 后者会把那些字段误报成变更。
  assert.match(
    body,
    /auditCommit\(current,\s*config,/,
    'auditCommit 的第二个参数应是 saveConfig 返回的 config，而不是 mutate 的中间产物'
  )

  const audit = indexCode.match(/async function auditCommit\([^)]*\)[\s\S]*?\n\}/)?.[0] ?? ''
  assert.ok(audit !== '', '找不到 auditCommit')
  assert.match(audit, /try\s*\{/, 'auditCommit 必须自带 try —— 审计失败不能往外抛')
  assert.match(
    audit,
    /catch[\s\S]*?lastHistoryFailure\s*=/,
    '审计失败必须记进 lastHistoryFailure（经诊断端点回传），不得静默吞掉'
  )
  assert.equal(
    /catch[\s\S]*?throw/.test(audit),
    false,
    '审计失败绝不能向上抛：那会把「记不下来」升级成「改不了」，而配置写入才是核心功能'
  )

  // 没变东西就不记：否则每次点「保存」都刷一条噪声条目。
  // 关键是把「真的没变」与「条目构造失败」分成两条路：后者是调用点漏标 source 的代码
  // 缺陷，若被当成「无变化」跳过，表现就是「配置改了、记录里没有、也没有任何告警」。
  assert.match(
    audit,
    /const changedAny =[\s\S]*?if \(!changedAny\)/,
    '「什么都没变」必须在构造条目之前用字段差分判掉，不能靠 buildHistoryEntry 返回 null 来表达'
  )
  assert.match(audit, /if \(!entry\)/, '有变化却构造不出条目时应有独立分支')
  // 匹配到 **非 null** 的赋值：`lastHistoryFailure = null` 不算「报出来了」——
  // 那恰好是「静默跳过」的写法，而它也能被更松的正则放过。
  assert.match(
    audit,
    /if \(!entry\)[\s\S]*?lastHistoryFailure\s*=\s*`/,
    '条目构造失败必须带原因记进 lastHistoryFailure（赋 null 等于静默跳过）'
  )
  assert.ok(
    /lastHistoryFailure\s*=\s*null/.test(audit),
    '记录成功（或无需记录）时应清掉上一次的失败原因，否则旧告警会永远挂着'
  )

  // 路径：与配置同目录的兄弟文件，由 lib/history.mjs 推导，index.mjs 不自己拼字符串。
  assert.match(indexCode, /function historyPath\(\)[\s\S]*?historyPathFor\(configPath\(\)\)/, 'historyPath 应由 historyPathFor(configPath()) 推导')
  assert.equal(
    /\.history\.jsonl/.test(indexCode),
    false,
    '文件名后缀是 lib/history.mjs 的契约，index.mjs 里不该再有一份字面副本（改一处忘一处会写到别的文件）'
  )
})

check('变更记录四条路由：方法校验、撤销语义、恢复预设的护栏', () => {
  // 契约里最容易退化的两处：一是写路由忘了校验 req.method（GET 也能触发写入，
  // 来自 /api/soul/config/reset 的真实教训）；二是撤销把「读记录」放到队列外，
  // 于是并发时规划建立在已被别人改过的配置上。
  const routes = ['/api/soul/history', '/api/soul/history/rollback', '/api/soul/history/restore-persona', '/api/soul/history/clear']
  for (const path of routes) {
    const body = indexCode.match(new RegExp(`path: '${path.replace(/\//g, '\\/')}'[\\s\\S]*?\\n    \\}\\)`))?.[0] ?? ''
    assert.ok(body !== '', `缺少路由 ${path}`)
    const expected = path === '/api/soul/history' ? 'GET' : 'POST'
    assert.match(body, new RegExp(`req\\.method !== '${expected}'`), `${path} 必须显式校验 req.method === ${expected}`)
    assert.match(body, /send\(res, 405, \{ ok: false, error: 'Method not allowed' \}\)/, `${path} 的方法不符应返回 405`)
  }

  const rollback = indexCode.match(/path: '\/api\/soul\/history\/rollback'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  // 撤销必须是**异步 mutate**：只有 mutate 体内能保证「读记录 → 规划 → 写配置」在同一队列
  // 任务里。同步 mutate 签名的写法会迫使调用方在入队前读记录，那正是竞态窗口。
  assert.match(rollback, /commitConfig\(async \(current\) => \{/, '撤销必须用 async mutate，在队列内读记录')
  assert.match(rollback, /if \(read\.error\) throw httpError\(500/, '记录读不出来必须中止，不能按「空记录」继续')
  assert.match(rollback, /planRollback\(read\.entries, current, id\)/, '撤销必须走 planRollback（链式指纹校验）')
  assert.match(rollback, /plan\.reason === 'missing'[\s\S]*?throw httpError\(400/, '找不到 id 应回 400')
  assert.match(rollback, /throw httpError\(409,/, '记录与配置对不上应回 409（不给一个猜出来的结果）')
  assert.ok(
    /Object\.keys\(plan\.patch\)\.length === 0\) return \{ \.\.\.current \}/.test(rollback),
    '补丁为空是合法结果（目标改动已被后续改回来），应原样返回而不是报错'
  )
  assert.match(rollback, /promptChanged\.length > 0\) refreshPromptAndInject/, '撤销后必须按同一门控刷新提示词')

  const restore = indexCode.match(/path: '\/api\/soul\/history\/restore-persona'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.match(restore, /sanitizePersonaName\(item\.name\)/, '恢复预设必须重新校验名字（记录是不可信输入）')
  assert.match(restore, /isBuiltinPersona\(personaName\)/, '恢复预设必须拒绝内置名')
  assert.match(restore, /hasOwn\(personas, personaName\)/, '同名已存在必须拒绝，不得静默覆盖用户后来的编辑')
  assert.match(restore, /skipped\.push\(\{ name: personaName, reason: 'exists' \}\)/, '跳过原因要如实回报，不能只报成功的')
  // 空白名这条分支只在记录被手改时才可达（normalizePersonaEvents 只看「非空且不超长」，
  // 而 '   ' 三条空格满足它、sanitizePersonaName 才拒绝）。恰恰因此必须回报 ——
  // 一条「恢复了 2 个」的成功消息里不说有 1 个没恢复，是最容易被忽略的那种漏报。
  assert.match(
    restore,
    /skipped\.push\(\{ name: item\.name, reason: 'invalid-name' \}\)/,
    '名字非法的条目也要报进 skipped（它在记录被手改时可达，不能只报能恢复的）'
  )
  assert.match(restore, /if \(restored\.length === 0\)[\s\S]*?throw httpError\(400/, '一个都没恢复时应回 400 而不是空成功')

  const clear = indexCode.match(/path: '\/api\/soul\/history\/clear'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  // 清空若不入队，就会与并发的追加撞在一起 —— 最坏是「刚清完又冒出一条」。
  assert.match(clear, /enqueueConfigWrite\(async \(\) => \{/, '清空必须借配置写队列串行')
  assert.match(clear, /clearHistoryFile\(historyPath\(\)\)/, '清空应走 clearHistoryFile')
  assert.match(clear, /lastHistoryFailure = null/, '清空后应清掉上一次的写入失败告警')
})

check('重置失败不得被报成成功', () => {
  const handler = clientCode.match(/const handleReset = async \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(handler, '找不到客户端的 handleReset')
  assert.ok(/if \(!payload\)/.test(handler[0]), 'handleReset 必须区分失败（resetConfig 失败时返回 undefined）')
  assert.ok(/toast\.resetFailed/.test(handler[0]), '失败时应用失败提示，而不是无条件报「已重置」')
  assert.ok(/payload\.backupPath/.test(handler[0]), '有备份时应提示「已备份」，避免用户以为数据凭空消失')
})

// ---------- 配置生效链路的可观测性 ----------

check('注入失败必须留下可观测记录，不得静默返回', () => {
  const matched = indexCode.match(/function injectPromptToAllAgents\(ctx, config\)[\s\S]*?\n\}/)
  assert.ok(matched, 'index.mjs 中找不到 injectPromptToAllAgents')
  const body = matched[0]
  assert.ok(/deliveryState\.injectionProblem = reason/.test(body), 'agents 不可用时必须记录原因')
  assert.equal(
    /if \(!agents \|\| typeof agents\.list !== 'function'\) \{\s*return\s*\}/.test(body),
    false,
    'agents 不可用不得直接裸 return——这正是「改了人设不生效却毫无线索」的来源'
  )
  assert.ok(/warnOnce\(/.test(body), '应经 logger 告警（同因只告一次，避免刷屏）')
  assert.ok(/delivered\+\+/.test(body) && /failed\+\+/.test(body), '应如实统计成功与失败数')
  assert.equal(/console\.(warn|error)\(/.test(body), false, '不要用被注释掉的 console——统一走 ctx.logger')
})

check('诊断端点 /api/soul/status 暴露两条通道', () => {
  const matched = indexCode.match(/path: '\/api\/soul\/status'[\s\S]*?\n    \}\)/)
  assert.ok(matched, '应注册 GET /api/soul/status')
  const body = matched[0]
  assert.ok(/channels:/.test(body), '应分别报告两条通道')
  assert.ok(/section:/.test(body) && /injection/.test(body), 'section 与 injection 都要有')
  assert.ok(/sectionRegisteredAt/.test(indexCode), 'section 的注册状态必须被记录')
})

check('「送不到会话」与「读不出来」是两种问题，分开上报', () => {
  assert.ok(
    /deliveryWarning: deliveryProblemText\(config\)/.test(indexCode),
    'GET /api/soul/config 应带回 deliveryWarning'
  )
  assert.ok(
    /deliveryWarning: deliveryProblemText\(updated\)/.test(indexCode),
    'POST /api/soul/config 也应带回——保存成功但送不到会话时要让用户看见'
  )
  assert.ok(/deliveryProblemText\(config\)/.test(indexCode), '/soul show 应展示送达状态')
  assert.ok(/t\.deliveryLabel/.test(indexCode), '/soul show 应带「送达」标签行')
  // delivery* 文案键**只定义在 COMMAND_MESSAGES**（PROMPT_TEXT 里没有）。
  // deliveryProblemText 必须从 commandMessages 取表：此前误用 promptTextOf，
  // 'agents-service-unavailable' 分支返回 undefined（JSON 序列化丢字段，故障不可见）、
  // 'inject-failed' 分支抛 TypeError（保存已落盘却报 HTTP 500）—— 变异实验均实测复现。
  const dpt = stripComments(extractObject(indexSource, 'function deliveryProblemText'))
  assert.ok(dpt !== '', '找不到 deliveryProblemText 函数体')
  assert.ok(
    /commandMessages\(config\)/.test(dpt),
    'deliveryProblemText 必须用 commandMessages 取文案（delivery* 键只在 COMMAND_MESSAGES；用 promptTextOf 会拿到 undefined 并在 inject-failed 时抛 TypeError）'
  )
  assert.equal(
    /promptTextOf\(config\)/.test(dpt),
    false,
    'deliveryProblemText 不得再从 PROMPT_TEXT 取 delivery 文案（该表没有这些键）'
  )
  // 两张表必须真的提供这两个键（防「改了取表方向、键又缺失」的二次回归）
  for (const table of ['COMMAND_MESSAGES']) {
    for (const lang of ['zh', 'en']) {
      const keys = tableLangKeys(indexSource, table, lang)
      for (const key of ['deliveryNoAgentsService', 'deliveryInjectFailed']) {
        assert.ok(
          keys.has(key),
          `${table}.${lang} 缺少 ${key}：deliveryProblemText 的两个分支都会拿不到文案`
        )
      }
    }
  }
})

check('版本号不新增需手工同步的常量（唯一来源 package.json）', () => {
  assert.ok(
    /createRequire\(import\.meta\.url\)\('\.\/package\.json'\)\.version/.test(indexCode),
    'host 端版本应直接取自 package.json'
  )
  assert.equal(
    /const\s+(PLUGIN_)?VERSION\s*=\s*'0\./.test(indexCode),
    false,
    '不要再写一个版本常量——需要手工同步的地方已经有三处'
  )
})

// ---------- 双语文案与校验链完整性 ----------

check('host 双语文案表逐键对齐（PROMPT_TEXT / COMMAND_MESSAGES）', () => {
  for (const table of ['PROMPT_TEXT', 'COMMAND_MESSAGES']) {
    const zh = tableLangKeys(indexSource, table, 'zh')
    const en = tableLangKeys(indexSource, table, 'en')
    assert.ok(zh.size > 10, `${table} 的 zh 键数异常：${zh.size}`)
    assert.deepEqual(
      [...zh].sort(),
      [...en].sort(),
      `${table} 的 zh / en 必须逐键对齐（少一个键就是另一种语言下少一句话）`
    )
  }
})

check('client 双语文案表逐键对齐', () => {
  const zh = objectKeys(extractObject(clientSource, 'const zh = {'))
  const en = objectKeys(extractObject(clientSource, 'const en = {'))
  assert.ok(zh.size > 50, `client zh 键数异常：${zh.size}`)
  assert.deepEqual([...zh].sort(), [...en].sort(), 'client i18n 的 zh / en 必须逐键对齐')
})

check('校验链与 --strict 链覆盖同一组脚本，且严格语义真在各脚本里实现', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const entries = (cmd) => [...String(cmd).matchAll(/scripts\/([\w.-]+\.mjs)(\s+--strict)?/g)]
    .map((m) => ({ file: m[1], strict: Boolean(m[2]) }))
  const chain = entries(pkg.scripts['verify'])
  const strict = entries(pkg.scripts['verify:strict'])
  assert.ok(chain.length >= 5, `verify 链应覆盖全部脚本，实际 ${chain.length}`)
  assert.deepEqual(
    strict.map((e) => e.file),
    chain.map((e) => e.file),
    'verify:strict 必须与 verify 逐项同序，否则 --strict 会漏掉某些脚本'
  )
  assert.ok(
    strict.every((e) => e.strict),
    'verify:strict 的每一项都必须带 --strict，否则那一项仍会「跳过即通过」'
  )
  // 链覆盖必须有下限且与 scripts 目录对账：只比对「两条链互相同序」时，对称地删掉
  // 一个脚本（两条链一起删）两条链依然相等、CI 照样绿 —— 覆盖声明没有任何机器保证。
  const onDisk = readdirSync(new URL('../scripts', import.meta.url))
    .filter((f) => /^verify-[\w-]+\.mjs$/.test(f))
    .sort()
  assert.deepEqual(
    [...new Set(chain.map((e) => e.file))].sort(),
    onDisk,
    'verify 链必须覆盖 scripts 目录下的全部 verify-*.mjs（对称删脚本不应被静默放过）'
  )
  for (const { file } of [...chain, ...strict]) {
    const url = new URL(`../scripts/${file}`, import.meta.url)
    assert.ok(existsSync(url), `package.json 引用了不存在的脚本：${file}`)
    // 去注释后再匹配：把真实调用注释掉、在注释里留下同样字样，不应被视为满足。
    // （M5 类漏洞：正断言只查「字样出现」时，注释里的字样同样命中。）
    const src = stripComments(readFileSync(url, 'utf8'))
    // 光在 package.json 里写上 `--strict` 是不够的 —— 脚本必须真的实现那套语义：
    //   ① 引入 skip-report（跳过与断言数的唯一实现）；
    //   ② 把「本脚本有多少断言」交给它，并**消费其结果**：跑完时
    //      `if (!assertCount(...))`，或像 verify-compat 那样把 nominal（随环境浮动的
    //      检查数）交给 `skipExit(..., NOMINAL_ASSERTIONS, ...)`。两者取其一 ——
    //      compat 的检查数取决于本机装了什么，精确相等不适用。
    //     只检测「字样出现」是不够的：调用被注释掉、或 assertCount 返回值被丢弃
    //    （打印了不一致却仍 return 0），都曾实测绕过 —— 所以必须匹配**消费形态**。
    assert.ok(
      // 必须是一条**真正的 import 语句**，不能只在注释里出现这段路径 —— 否则把 import
      // 注掉、留下一行注释，这条断言照样通过（判断力对照实测过这个漏法）。
      /^\s*import\b[^\n]*from '\.\/lib\/skip-report\.mjs'/m.test(src),
      `${file} 必须真正 import ./lib/skip-report.mjs，否则跳过语义与断言数都无人守`
    )
    const consumesCount = /!\s*assertCount\(/.test(src)
    const skipExitCall = extractCall(src, 'skipExit(')
    const reportsNominal = skipExitCall !== '' && /NOMINAL_ASSERTIONS/.test(skipExitCall)
    assert.ok(
      consumesCount || reportsNominal,
      `${file} 必须把断言数交给 skip-report 并消费其结果（if (!assertCount(...)) 或 skipExit(..., NOMINAL_ASSERTIONS, ...)）；返回值被丢弃或只剩注释均不算`
    )
    if (reportsNominal && !consumesCount) {
      assert.ok(
        /const\s+NOMINAL_ASSERTIONS\s*=/.test(src),
        `${file} 引用 NOMINAL_ASSERTIONS 但未声明该常量`
      )
    }
    assert.equal(
      /process\.argv\.includes\('--strict'\)/.test(src),
      false,
      `${file} 不得自己解析 --strict（必须走 skip-report 的 strictMode()，否则两处判定会漂移）`
    )
  }
})

check('删除预设用内联二次确认，不得用原生 confirm', () => {
  // 原生 window.confirm 在 webview 里可能把文档焦点留在异常状态 —— 症状是
  // 「页面看得见却点不动、下拉框与输入框都失效」，最小化再恢复才好（用户实测）。
  // 宿主自己的设置页也不用原生 confirm。故改为内联二次确认。
  assert.equal(
    /globalThis\.confirm\s*\(|window\.confirm\s*\(/.test(clientCode),
    false,
    '不得调用原生 confirm（webview 里会留下焦点异常，改用内联二次确认）'
  )
  // 必须存在待确认状态，且第一次点击只进入待确认、不真删
  assert.match(clientSource, /const \[pendingDelete, setPendingDelete\] = React\.useState\(null\)/, '缺少 pendingDelete 状态')
  assert.match(
    clientSource,
    /if \(pendingDelete !== name\) \{[\s\S]{0,80}?setPendingDelete\(name\)[\s\S]{0,40}?return/,
    '首次点击应只进入待确认态并返回（不得直接删除）'
  )
  // 必须有超时复位兜底：否则「确认删除？」会一直挂着，用户过一会儿随手一点就真删了
  assert.match(
    clientSource,
    /setTimeout\(\(\) => setPendingDelete\(null\), \d+\)/,
    '二次确认需要超时复位（否则待确认态会一直挂着，容易误删）'
  )
  // 按钮要有可见的待确认反馈（文案 + 独立类名）
  assert.match(clientSource, /t\('personas\.confirmDeleteShort'\)/, '待确认态按钮缺少文案')
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  assert.ok(/soul-persona-danger-armed/.test(cssBlock), '待确认态按钮应有独立样式（描边→实心危险色），否则与普通「删除」无从区分')
  const armed = cssBlock.match(/\.soul-persona-danger-armed\{([^}]*)\}/)?.[1] ?? ''
  assert.match(armed, /state-error-primary/, '待确认态应使用实心危险色')
  // 中英文案键各一份
  assert.match(clientSource, /'personas\.confirmDeleteShort': '确认删除？'/, '缺中文待确认文案')
  assert.match(clientSource, /'personas\.confirmDeleteShort': 'Confirm delete\?'/, '缺英文待确认文案')
})


check('set_persona 接入宿主原生审批（三态 + 文本退化）', () => {
  // 需求：确认模式不要再让用户手敲 /soul confirm，而是走宿主原生的审批面板
  //（输入框处的「允许一次 / 拒绝」）。
  //
  // 为什么复用宿主审批：面板、键盘（Enter 允许 / Esc 拒绝）、读屏、一次性授权
  // 语义都由宿主实现，且 ask/decided 会写入会话审计日志。自绘弹框要把这些全部
  // 重做一遍且必然有差异。
  //
  // 关键：**客户端无需注册 answerer** —— dsh-web-app 的默认依赖里已包含
  // @deepseek-ai/dsh-client-ui-approval，它自己注册了 approval/request 的应答者。
  // 本插件只作为 asker 发起请求。
  //
  // 三态：
  //   allowed-once → 'allowed'     ⇒ 继续落盘
  //   rejected     → 'rejected'    ⇒ 不落盘并如实告知
  //   cancelled / unavailable → 'unavailable' ⇒ 退化到 /soul confirm 文本流程

  // ① 工具 execute 必须接住第二个参数 exec（agent / callId / signal 都在里面）
  assert.match(
    indexCode,
    /async execute\(args, exec\) \{/,
    'execute 必须接住 exec 参数（否则拿不到 agent，审批无法路由到会话）'
  )
  // ② 服务解析：多候选（agent 的 agent-scoped ctx 优先，注册工具的 ctx 兜底），
  //    任一命中即用；全部拿不到则退化。
  //
  //    实测教训：最初用 registerTools 的**根 ctx** 取服务，ctx.get('approval') 返回
  //    undefined ⇒ 每次都退化成文本流程，看起来像「功能没生效」。
  //    权威写法见 dsh-tools 自己的 serviceAsk：用持有 tools 的 ctx 取审批服务。
  assert.match(indexCode, /\.get\('approval'\)/, '应通过 get(\'approval\') 取审批服务')
  assert.match(
    indexCode,
    /const candidates = \[\]/,
    '服务解析应逐候选尝试（单一 ctx 取不到时会静默退化）'
  )
  assert.match(
    indexCode,
    /if \(agent && typeof agent\.ctx === 'object'[^\n]*candidates\.push\(agent\.ctx\)/,
    'agent 的 agent-scoped ctx 应作为首选候选（审批需路由到该 agent 的会话）'
  )
  assert.match(
    indexCode,
    /if \(ctx && typeof ctx\.get === 'function'\) candidates\.push\(ctx\)/,
    '注册工具的 ctx 应作为兜底候选'
  )
  // 调用处必须传「注册工具的 ctx」而不是 apply 的根 ctx
  assert.match(
    indexCode,
    /requestToolApproval\(toolsCtx, exec, proposalChanges\)/,
    '审批调用应传 toolsCtx（注册工具的 ctx），传根 ctx 会取不到审批服务'
  )
  // ③ agent 缺失时必须退化而不是硬发请求 —— 宿主客户端靠 agent 解析会话归属，
  //    拿不到会放弃应答（dsh-client-ui-approval 里 scopeOf(owner) === undefined ⇒ next()）
  assert.match(
    indexCode,
    /const agent = exec && exec\.agent\s*\n\s*if \(!agent\) return 'unavailable'/,
    'exec.agent 缺失时必须退化为文本流程（否则审批必然无人应答）'
  )
  // ④ 三态映射：只有 allowed-once 算批准；rejected 单独处理；其余（含 cancelled）退化
  // 逐字校验映射函数的**完整实现**（只钉片段会让「cancelled 被当作批准」这类
  // 严重语义错误漏网 —— 判断力验证实测）
  const mapAt = indexCode.indexOf('function approvalOutcomeOf(')
  assert.ok(mapAt > 0, '缺少 approvalOutcomeOf')
  const mapEnd = indexCode.indexOf('\n}', mapAt)
  const mapFn = indexCode.slice(mapAt, mapEnd > mapAt ? mapEnd : mapAt + 600)
  assert.match(mapFn, /if \(outcome === 'allowed-once'\) return 'allowed'/, 'allowed-once 应映射为 allowed')
  assert.match(mapFn, /if \(outcome === 'rejected'\) return 'rejected'/, 'rejected 应映射为 rejected')
  assert.match(mapFn, /return 'unavailable'/, '其余结果应归为 unavailable 以走退化')
  // 关键：只有 allowed-once 能返回 'allowed'（approvalOutcomeOf 内 'allowed' 只应出现一次）
  assert.equal(
    (mapFn.match(/return 'allowed'/g) || []).length,
    1,
    "approvalOutcomeOf 里只允许 allowed-once 返回 'allowed'（cancelled 若也返回 allowed，撤回的请求会被应用）"
  )
  assert.equal(
    /cancelled[^\n]*return 'allowed'/.test(mapFn),
    false,
    'cancelled 绝不能映射为 allowed'
  )
  // ⑤ 请求字段必须完整：agent 必传，callId / signal 有则传，reason + displayReason 齐备
  assert.match(indexCode, /toolName: 'set_persona'/, '审批请求应带上工具名')
  assert.match(indexCode, /displayReason: \{/, '应提供 displayReason（宿主按 UI 语言选取）')
  assert.ok(indexCode.includes("zh: '人设变更需要你的确认'"), '缺中文 displayReason')
  assert.ok(indexCode.includes("en: 'Persona change requires your confirmation'"), '缺英文 displayReason')
  // ⑥ 异常不得让人设变更彻底失败，必须退化
  // 用切片判断（catch 块内的注释行数不固定，跨行正则太脆）
  const fnAt = indexCode.indexOf('async function requestToolApproval')
  const fnEnd = indexCode.indexOf('\n}', fnAt)
  const approvalFn = indexCode.slice(fnAt, fnEnd > fnAt ? fnEnd : fnAt + 2000)
  const catchAt = approvalFn.indexOf('} catch {')
  assert.ok(catchAt > 0, 'requestToolApproval 应有 catch 兜底')
  assert.match(
    approvalFn.slice(catchAt),
    /return 'unavailable'/,
    '审批链路异常应退化为文本流程，而不是让变更失败'
  )
  // ⑦ 退化路径必须保留 /soul confirm 提议（纯 TUI / 无 Web UI 场景唯一的确认途径）
  assert.match(indexCode, /pendingPersonaProposal = \{ patch: proposalChanges/, '退化时必须保留 /soul confirm 提议')
  // ⑧ 拒绝与退化都要有对应文案，且中英各一份
  assert.match(indexCode, /return \{ ok: false, message: T0\.toolRejected \}/, 'rejected 应返回失败并说明原因')
  assert.equal((indexCode.match(/toolRejected:/g) || []).length, 2, 'toolRejected 文案应中英各一份')
  // ⑧b 策略预判：'rejected' 把两件事混在一起（用户真的拒绝 / 通道被策略禁用而无人被询问），
  //     必须在发起请求前先读策略，否则会向用户报告一件从未发生的事
  //     （实测踩过：policy=never 时提示「你在审批面板中拒绝了」，而用户根本没看到面板）。
  assert.match(
    indexCode,
    /function resolveApprovalPolicy\(approval, agent\)/,
    '应能读取当前生效的审批策略（用于区分「通道禁用」与「用户拒绝」）'
  )
  // 算法必须与宿主 effectivePolicy 一致：overrideOf(session) ?? config.policy ?? 'ask'
  const policyFnAt = indexCode.indexOf('function resolveApprovalPolicy(')
  const policyFn = indexCode.slice(policyFnAt, policyFnAt + 900)
  assert.match(policyFn, /approval\.overrideOf\(session\)/, '策略算法应先读会话级覆盖')
  assert.match(policyFn, /approval\.config && approval\.config\.policy/, '再读部署默认策略')
  assert.match(policyFn, /return 'ask'/, "不可读时应保守回落到 'ask'（失败方向是「多问一次」而非「静默改配置」）")
  assert.match(
    indexCode,
    /if \(resolveApprovalPolicy\(approval, agent\) === 'never'\) return 'policy-disabled'/,
    "策略为 never 时应返回 policy-disabled（走文本确认），而不是让宿主的 'rejected' 冒充用户拒绝"
  )
  assert.equal((indexCode.match(/toolApprovalDisabled:/g) || []).length, 2, 'toolApprovalDisabled 文案应中英各一份')
  // ⑨ 确认模式关闭时不得调用审批
  const decideAt = indexCode.indexOf('const verdict = await requestToolApproval')
  const guardAt = indexCode.lastIndexOf('if (snapshot.requireToolConfirmation) {', decideAt)
  assert.ok(guardAt > 0 && guardAt < decideAt, '审批调用必须在 requireToolConfirmation 分支内')
  // 退化分支必须**真实可达**：判据是非 allowed/rejected 的结果，而不是恒假条件
  //（判断力验证实测：把判据改成 if (false) 能悄悄删掉退化路径，纯 TUI 场景
  //  就再也没有确认途径了）
  const branchSlice = indexCode.slice(decideAt, decideAt + 1400)
  assert.match(
    branchSlice,
    /if \(verdict === 'rejected'\)/,
    '应有 rejected 分支（用户拒绝 ⇒ 不落盘并告知）'
  )
  assert.match(
    branchSlice,
    /if \(verdict === 'unavailable' \|\| verdict === 'policy-disabled'\) \{/,
    '应有 unavailable / policy-disabled 分支（退化到 /soul confirm 文本流程，纯 TUI 场景唯一途径）'
  )
  // 通道被禁用时必须给出准确说明，不得谎称用户拒绝
  assert.match(
    branchSlice,
    /verdict === 'policy-disabled' \? `\$\{T0\.toolApprovalDisabled\}/,
    'policy-disabled 时应追加「通道被禁用」说明（此前会误报为「用户拒绝」）'
  )
  assert.equal(
    /if \(false\)/.test(branchSlice),
    false,
    '退化分支不得是恒假条件'
  )
})

check('每个内置预设都声明全 6 个人格维度（language 豁免）', () => {
  // 声明列表同时驱动应用与匹配，两者需求相反：应用希望「少声明不越权」，
  // 匹配希望「全声明才严格」。早期只声明要改的维度 ⇒ 匹配退化成宽松比较：
  // 改一个未声明的特质后 ★ 仍挂着，且同一动作结果随预设而变（实测：改 emoji
  // 在「极简主义者」上丢 ★、在「苏格拉底式提问者」上不丢）⇒ 用户无法形成稳定预期。
  // 现统一为全量声明，语义单一：**改任何特质 ⇒ 不再属于该预设**。
  const DIMS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'customInstructions']
  const view = mergePersonas(null)
  for (const name of builtinPersonaNames()) {
    const declared = declaredPersonaKeys(view[name]).filter((k) => k !== 'language')
    for (const dim of DIMS) {
      assert.ok(declared.includes(dim), `${name} 未声明 ${dim}（全量声明才能保证「改任何特质都丢 ★」）`)
    }
    // language 仍必须豁免（跨语言共用的通用人格）
    assert.equal('language' in view[name], false, `${name} 不应声明 language（会把另一种语言的用户切走）`)
  }
  // 行为闭环：应用后匹配自己，改任何一个特质维度都失去匹配
  for (const name of builtinPersonaNames()) {
    const entry = view[name]
    const applied = { ...DEFAULT_CONFIG }
    for (const dim of DIMS) applied[dim] = entry[dim]
    assert.equal(personaMatches(entry, applied), true, `${name} 应用后应匹配自己`)
    for (const dim of DIMS) {
      if (dim === 'customInstructions') continue
      const edited = { ...applied, [dim]: applied[dim] === 'default' ? 'more' : 'default' }
      assert.equal(
        personaMatches(entry, edited),
        false,
        `${name}：改 ${dim} 后应失去匹配（★ 必须消失）`
      )
    }
    // language 改了不该丢 ★（豁免）
    assert.equal(
      personaMatches(entry, { ...applied, language: applied.language === 'zh' ? 'en' : 'zh' }),
      true,
      `${name}：改 language 不应失去匹配（内置预设不声明它）`
    )
  }
})

check('手风琴不得裁剪向上弹出的提示（几何验证，非字符串检查）', () => {
  // 用户实测：Agent 工具分组「人设变更需确认」右侧的 hover 提示被上方遮住一部分。
  //
  // 根因：.soul-accordion{overflow:hidden}（本为把触发器的方形 hover 背景裁进圆角）。
  // 而该分组里提示是**第一个元素**，上方只有 14px 内边距，提示高约 72px 必然越界，
  // 越界部分被裁掉。实测数据（真实 Chrome）：旧实现裁掉 19px，修复后 0px。
  //
  // 为什么不用字符串断言：有没有 overflow:hidden 不等于会不会被裁（取决于提示高度、
  // 上方留白、祖先链）。这类「视觉被遮挡」必须量几何。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  // ① 容器不得用 overflow:hidden 裁剪
  assert.equal(
    /\.soul-accordion\{[^}]*overflow:hidden/.test(cssBlock),
    false,
    '手风琴容器不得 overflow:hidden（会裁掉向上弹出的 .soul-hint-tip）'
  )
  // ② 不裁剪后，触发器必须自己补圆角（否则 hover 背景外溢成直角）
  assert.match(
    cssBlock.match(/\.soul-accordion-trigger\{([^}]*)\}/)?.[1] ?? '',
    /border-radius:calc\(var\(--dsw-radius-xl\) - \.5px\)/,
    '触发器须补顶圆角（替代容器的裁剪）'
  )
  // ③ 收起态只有一个触发器 ⇒ 四角都要圆
  assert.match(
    cssBlock,
    /\.soul-accordion:not\(\.soul-accordion-open\) \.soul-accordion-trigger\{border-radius:calc\(var\(--dsw-radius-xl\) - \.5px\)\}/,
    '收起态触发器四角都要圆'
  )
})

check('底栏开关始终展示当前人设（未匹配时显示「自定义」）', () => {
  // 需求：底栏「个性化已启用」后面必须给出「现在用的是哪套人设」。
  // 此前只有匹配到预设才缀名字，未匹配（手改过特质）就留空 —— 等于没回答；
  // 而「未匹配预设」这种说法听着像报错。现在：有匹配显示预设名，否则「自定义」。
  assert.match(clientSource, /enabled && e\('span', \{ className: 'soul-quick-toggle-name' \}/, '底栏应始终（启用时）渲染人设名')
  assert.match(
    clientSource,
    /activePersona \|\| t\('quick\.custom'\)/,
    '未匹配到预设时应回退显示「自定义」（不能留空）'
  )
  // 关闭个性化时不显示（人设此刻不生效，挂名字会误导）
  assert.match(clientSource, /enabled && e\('span', \{ className: 'soul-quick-toggle-name' \}/, '关闭个性化时不得显示人设名')
  // 名字限宽（自建预设上限 30 字，不限宽会撑开底栏）
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  assert.match(
    cssBlock.match(/\.soul-quick-toggle-name\{([^}]*)\}/)?.[1] ?? '',
    /max-width:9em/,
    '底栏人设名必须限宽（否则长名会撑开底栏）'
  )
  // 文案键双语齐备
  assert.ok(clientSource.includes("'quick.custom': '自定义'"), '缺中文「自定义」文案')
  assert.ok(clientSource.includes("'quick.custom': 'Custom'"), '缺英文「Custom」文案')
})

check('配置偏离任何预设时，卡片区给出「存为新预设」出口', () => {
  // 全量声明后「改任何特质都丢 ★」⇒ activeName=null 成为常见状态。
  // 它诚实但没有出路：用户刚调出来的配置无处安放。故在预设分组里给
  // 一句话说明 + 直接打开命名弹层的入口。
  assert.match(clientSource, /activePersona === null && personaNames !== null && !personasError/, '偏离判据：无匹配且列表已就绪（加载中/失败不算）')
  assert.match(clientSource, /className: 'soul-drift'/, '缺少偏离提示块')
  assert.match(clientSource, /'personas\.drift'/, '缺少偏离说明文案')
  assert.match(clientSource, /t\('personas\.driftAction'\)/, '缺少「存为新预设」按钮')
  // 按钮必须复用已有的命名弹层（不是另造一套保存流程）
  assert.match(
    clientSource,
    /onClick: \(\) => \{ setPersonaName\(''\); setShowSavePersona\(true\) \}/,
    '出口按钮应打开已有的命名弹层（复用 setShowSavePersona）'
  )
  // 文案键双语齐备
  assert.ok(clientSource.includes("'personas.drift': '当前配置与任何预设都不一致。'"), '缺中文偏离文案')
  assert.ok(clientSource.includes("'personas.driftAction': '存为新预设'"), '缺中文按钮文案')
  assert.ok(clientSource.includes("'personas.drift': 'The current config matches no preset.'"), '缺英文偏离文案')
  assert.ok(clientSource.includes("'personas.driftAction': 'Save as new preset'"), '缺英文按钮文案')
  // 样式：弱化提示条 + 描边式次要按钮（不与「使用」抢视觉）
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  assert.match(cssBlock, /\.soul-drift\{[^}]*background:var\(--dsw-alias-bg-module-platform\)/, '偏离提示应用内嵌底（与宿主只读区同款）')
  assert.match(cssBlock, /\.soul-drift-action\{[^}]*border:\.5px solid var\(--dsw-alias-brand-primary\)/, '出口按钮应为描边式次要按钮')
})

check('卡背（详情面）展示全部维度与全文，且不动卡片 transform', () => {
  // 需求：正面效果栏是截断的（首句 + 60 字 + 3 行 clamp），用户要「全部展示」，
  // 故加卡背展示 6 个维度 + customInstructions 全文。
  //
  // 最关键的架构约束：**卡背不得是轮播的第 N+1 张**，而是当前卡的另一种「面」——
  // 否则 total 要变 2N，位置指示/圆点/go() 全要改。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const frontIdx = clientSource.indexOf("className: 'soul-persona-face soul-persona-face-front'")
  const backIdx = clientSource.indexOf("className: 'soul-persona-face soul-persona-face-back'")
  assert.ok(frontIdx > 0, '缺少正面 face')
  assert.ok(backIdx > frontIdx, '缺少背面 face')
  // 切片边界不能用固定字符数：卡背内容一长（比如加了删除按钮）就被截断，
  // 断言会「看不到」新增元素而误报（实测踩过：2600 字符截掉了删除按钮）。
  // 改到下一个稳定锚点（侧边卡渲染循环）为界。
  const backEnd = clientSource.indexOf('const cards = []', backIdx)
  const backBlock = clientSource.slice(backIdx, backEnd > backIdx ? backEnd : backIdx + 4000)
  // ① 翻面状态绑人设名（不是索引）：删除/刷新后同名卡仍是同一张，绑索引会翻错面
  assert.match(clientSource, /const \[flippedName, setFlippedName\] = React\.useState\(null\)/, '翻面状态应绑人设名')
  // ② 卡片自身 transform 必须保持叠层偏移原样，且**不得**出现 rotateY
  //    （翻转交给中间的 .soul-persona-flipper，见下 —— 写进卡片就会与叠层偏移
  //     抢同一个 transform，偏移几何会变脆）
  assert.match(clientSource, /transform: `translateX\(\$\{offset \* 92\}px\) translateY/, '叠层偏移 transform 应保持原样')
  const cardRule = cssBlock.match(/\.soul-persona-card\{([^}]*)\}/)?.[1] ?? ''
  assert.equal(/rotateY/.test(cardRule), false, '卡片规则不得含 rotateY（会与叠层偏移抢同一个 transform）')
  // 真 3D 翻转：翻转发生在中间的 .soul-persona-flipper 上（职责分离），
  // 卡片管叠层位置、flipper 管翻到哪一面。
  assert.match(
    cssBlock.match(/\.soul-persona-flipper\{([^}]*)\}/)?.[1] ?? '',
    /transform-style:preserve-3d/,
    '翻转容器必须 preserve-3d（否则两个面无法构成 3D 空间）'
  )
  assert.match(
    cssBlock,
    /\[data-flipped="true"\] \.soul-persona-flipper\{transform:rotateY\(180deg\)\}/,
    '翻面应把 flipper 转到 rotateY(180deg)'
  )
  // perspective 必须在翻转元素的父级（卡片）上才生效
  assert.match(cardRule, /perspective:/, '卡片应设 perspective（3D 景深必须挂在翻转元素的父级）')
  // 背面要预先转 180°，两个面才各朝一边
  assert.match(
    cssBlock.match(/\.soul-persona-face-back\{([^}]*)\}/)?.[1] ?? '',
    /transform:rotateY\(180deg\)/,
    '背面应预先 rotateY(180deg)（否则两面同向、翻转后看到镜像）'
  )
  // 两个面都要隐藏背面，否则会看到反面内容的镜像
  assert.match(cssBlock.match(/\.soul-persona-face\{([^}]*)\}/)?.[1] ?? '', /backface-visibility:hidden/, '面须 backface-visibility:hidden')
  // ③ 背面必须由维度 key 列表驱动渲染（写死易漏项）
  assert.match(clientSource, /const PERSONA_DIM_KEYS = \['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language'\]/, '缺少维度 key 列表')
  assert.match(backBlock, /PERSONA_DIM_KEYS\.map/, '背面应由 PERSONA_DIM_KEYS 驱动渲染')
  // ④ 全文**不截断**（正面才截断）
  // 0.9.0-d 起提到模块级（personaFullTextOf，多一个 t 参数）—— 会话 tab 的右栏详情
  // 与设置页卡背必须显示**逐字相同**的全文，各写一份必然漂移。
  const fullFn = clientSource.match(/const personaFullTextOf = \(entry, t\) => \{[\s\S]*?\n    \}/)?.[0] ?? ''
  assert.ok(fullFn !== '', '找不到 personaFullTextOf 实现（模块级版本）')
  assert.equal(/slice\(/.test(fullFn), false, '全文函数不得做 slice 截断（截断是正面效果栏的行为）')
  // ⑤ 滚动必须落在全文块自己身上，不能放 face 上
  //    （放 face 上会让「返回」按钮跟着滚出视野 —— 实测确认）。
  //    face 的裁切/背面隐藏由公共 .soul-persona-face 规则提供，背面专属规则
  //    只管 padding/排布，不能把两者混为一谈（以前误把 overflow:hidden 断言
  //    钉在 back 专属规则，真 3D 改造后裁切移回公共 face 规则就误报了）。
  const faceRule = cssBlock.match(/\.soul-persona-face\{([^}]*)\}/)?.[1] ?? ''
  assert.match(faceRule, /overflow:hidden/, '每一面自身应裁切内容（圆角图片/卡背滚动边界）')
  assert.match(faceRule, /backface-visibility:hidden/, '每一面应隐藏自己的背面（避免镜像内容漏出）')
  const backFace = cssBlock.match(/\.soul-persona-face-back\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(backFace !== '', '找不到背面专属规则')
  assert.equal(/overflow-y:auto|overflow:auto/.test(backFace), false, '滚动不得放在 face 上（会让「返回」一起滚出视野）')
  assert.match(
    cssBlock.match(/\.soul-persona-fulltext\{([^}]*)\}/)?.[1] ?? '',
    /overflow-y:auto/,
    '全文块自己应可滚动（339 字占 272px，卡片仅 372px）'
  )
  // ⑥ 背面只阅读：不得有使用/删除，但必须有「返回」
    // ⑥ 背面是「查看 / 管理」面：**不得有「使用」**（高频操作留正面），
    //    但**必须有「删除」**（仅自建卡；从正面移到这里 —— 用户反馈正面三钮拥挤）
    //    与「返回」并排在底部按钮行。
    assert.equal(/handleUsePersona/.test(backBlock), false, '背面不得放「使用」按钮（高频操作留正面）')
    assert.ok(
      /handleDeletePersona\(name\)/.test(backBlock) && backBlock.includes('soul-persona-back-del'),
      '背面应有「删除」按钮（仅自建卡渲染，二次确认逻辑不变）'
    )
    assert.ok(backBlock.includes('setFlippedName(null)'), '背面缺少「返回」')
    // 卡背整面点击=返回 ⇒ 「删除」必须 stopPropagation（否则确认删除会被返回打断）
    assert.match(
      backBlock,
      /ev\?\.stopPropagation\(\)\s*\n\s*void handleDeletePersona\(name\)/,
      '卡背「删除」应 stopPropagation（卡背整面点击=返回，不挡住会打断删除确认）'
    )
    // 整面点击返回：必须排除「拖选文字」（卡背有可滚动全文，用户可能拖选复制）
    assert.match(
      backBlock,
      /globalThis\.getSelection\?\.\(\)/,
      '卡背整面点击返回前必须检查文字选区（否则拖选文字会误触发返回）'
    )
    assert.match(backBlock, /sel\.isCollapsed/, '选区判据应看 isCollapsed')
    // 底部按钮行容器：返回弹性占满 + 删除定宽
    assert.match(
      cssBlock.match(/\.soul-persona-back-actions\{([^}]*)\}/)?.[1] ?? '',
      /margin-top:auto/,
      '卡背按钮行应 margin-top:auto 贴底'
    )
    assert.match(
      cssBlock.match(/\.soul-persona-back-del\{([^}]*)\}/)?.[1] ?? '',
      /flex:0 0 \d+px/,
      '卡背删除应定宽（次要管理操作，不与返回抢宽）'
    )
  assert.ok(backBlock.includes('setFlippedName(null)'), '背面缺少「返回」')
  // ⑦ 卡背徽标必须重置为 static：.soul-persona-badge 是 absolute（为压插画而设），
  //    在卡背 flex 行里会脱离流与名称重叠（实测徽标 [44,77] 压住名称）
  assert.match(
    cssBlock,
    /\.soul-persona-back-head \.soul-persona-badge\{position:static/,
    '卡背徽标必须重置 position:static（否则与名称重叠）'
  )
  // ⑧ 名称宽度自适应：flex:1 会撑满整行并把徽标挤到同一位置
  assert.match(
    cssBlock.match(/\.soul-persona-back-name\{([^}]*)\}/)?.[1] ?? '',
    /flex:0 1 auto/,
    '卡背名称应 flex:0 1 auto（flex:1 会撑满整行导致徽标重叠）'
  )
  // ⑨ 详情入口只在当前卡上出现（叠层两张不给点）
  assert.match(clientSource, /current && e\('button', \{[\s\S]{0,200}?soul-persona-details/, '「详情」入口应只在当前卡上渲染')
  // ⑩ 「返回」按钮的选择器必须带祖先前缀（提高权重），不能只写单类。
  //    原因：基类 .soul-persona-action 有 flex:1 1 auto，而单类选择器权重相同 ⇒
  //    后声明者胜；本规则排在基类之前，于是 flex:none 被覆盖，按钮变成弹性元素。
  //    后果（实测）：自定义预设指令较短时剩余空间把按钮**拉伸到 98px**（正常 35px）；
  //    长文本时又被压缩到 21px。加前缀后与声明顺序无关。
  // 「返回」现在在卡背按钮行里弹性占满（flex:1 1 auto），删除定宽并行。
  // 权重教训仍在：返回按钮的 flex:1 与基类 .soul-persona-action 语义一致，不再冲突；
  // 行容器 .soul-persona-back-actions 必须存在且贴底（margin-top:auto）。
  assert.match(
    cssBlock.match(/\.soul-persona-back-btn\{([^}]*)\}/)?.[1] ?? '',
    /flex:1 1 auto/,
    '「返回」应在卡背按钮行里弹性占满（删除定宽并行）'
  )
  // ⑪ 整面点击翻面：正面 face 自带 onClick（当前卡任意处点击翻到卡背，用户需求）；
  //    「使用」按钮必须 stopPropagation（点了就该用，不能顺带翻面）。
  //    ⚠️ onClick 必须限定 current —— 否则点叠层侧边卡时，点击先冒泡到它 face 的
  //    setFlippedName(侧边卡名)，再冒泡到卡片 go() 翻页 ⇒ 翻页后它成了当前卡 ⇒
  //    直接以背面姿态出现（用户实测：切下一个人设时自动翻面了）。
  const frontFace = clientSource.slice(
    clientSource.indexOf("className: 'soul-persona-face soul-persona-face-front'"),
    clientSource.indexOf("className: 'soul-persona-face soul-persona-face-back'")
  )
  assert.match(frontFace, /onClick: \(current && !flipped\)/, '整面点击必须限定当前卡（否则点侧边卡翻页后会以背面出现）')
  assert.match(frontFace, /ev\?\.stopPropagation\(\)/, '「使用」按钮应 stopPropagation（点使用不能顺带翻面）')
  // cursor:pointer 只提示当前卡（叠层卡点击是翻页，不是翻面）
  assert.match(
    cssBlock,
    /\.soul-persona-card\[data-current="true"\]:not\(\[data-flipped="true"\]\) \.soul-persona-face-front\{cursor:pointer\}/,
    'cursor:pointer 应只给当前卡的正面（叠层卡的点击是翻页）'
  )
})

check('「存为预设」入口与「保存设置」并列，且点开才问名字', () => {
  // 用户反馈原位置「比较迷茫」：它被塞在预设列表最下面，而用户此时的心理模型是
  // 「我在看别人的预设」；真正保存的却是「关于你/特质」里的字段（在别的分组里）。
  // 方案 A：移到「保存设置」旁做同级动作，点开才问名字，并明确列出保存范围。
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  // ① 预设列表里不得再有那个输入框（旧位置已移除）
  assert.equal(/soul-persona-save/.test(cssBlock), false, '预设列表里的「保存为预设」输入框样式应已移除（入口已移到保存按钮旁）')
  // ② 与「保存设置」并排出现
  const buttons = extractCall(clientSource, "e('div', { className: 'soul-buttons' }")
  assert.ok(buttons !== '', '找不到保存按钮区')
  assert.match(buttons, /t\('button\.save'\)/, '保存按钮区应有「保存设置」')
  assert.match(buttons, /t\('personas\.saveAs'\)/, '「存为预设…」应与「保存设置」并列（同一按钮区）')
  // ③ 点开才问名字：按钮点击只打开弹层，不直接保存
  assert.match(
    clientSource,
    /onClick: \(\) => \{ setPersonaName\(''\); setShowSavePersona\(true\) \}/,
    '「存为预设…」应只打开命名弹层（不是先填名字才能点）'
  )
  assert.match(clientSource, /showSavePersona && e\('div', \{/, '缺少命名弹层渲染分支')
  // ④ 弹层必须说明「会保存什么 / 不会保存什么」—— 这是消除困惑的关键
  assert.match(clientSource, /t\('personas\.saveCovers'\)/, '弹层应说明会保存哪些字段')
  assert.match(clientSource, /t\('personas\.saveExcludes'\)/, '弹层应说明不含「关于你」（这正是困惑来源）')
  // ⑤ 弹层要能关闭：遮罩点击 + 取消按钮 + Esc
  assert.match(clientSource, /onClick: \(\) => \{ setShowSavePersona\(false\); setPersonaName\(''\) \}/, '弹层应可关闭（遮罩/取消）')
  assert.match(clientSource, /ev\.key === 'Escape'/, '弹层应支持 Esc 关闭')
  // ⑥ 中英文案键齐备
  for (const [k, zh, en] of [
    ['personas.saveAs', '存为预设…', 'Save as persona…'],
    ['personas.saveConfirm', '保存', 'Save'],
    ['button.cancel', '取消', 'Cancel']
  ]) {
    assert.ok(clientSource.includes(`'${k}': '${zh}'`), `缺中文文案 ${k}`)
    assert.ok(clientSource.includes(`'${k}': '${en}'`), `缺英文文案 ${k}`)
  }
})

check('变更记录分组：字段标签覆盖全部审计字段，且只渲染服务端已倒序的记录', () => {
  // 这一组把服务端记录**逐字段**画给用户看。画的是 `before`/`after` 里的键名 ——
  // 键名是英文标识符，一旦某个键没有对应文案，界面上就会明晃晃写着 `trailWidth`。
  // 静态断言检查不了「新增配置字段时会不会漏」，所以这里做的是**覆盖率**断言：
  // 以 `AUDIT_FIELDS` 为唯一真源，比对客户端标签表。
  //
  // ⚠️ 不能用「正则从 DEFAULT_CONFIG 源码里抓键」：那会把**刻意排除**在审计之外的
  // 字段也算进来（`personas` 与 0.9.0 的 `workspaces`）。它们不进 AUDIT_FIELDS，
  // 也就永远不会出现在时间线的 before/after 里 —— 要求它们有标签是在要求一件
  // 没用的事，而多出来的标签又会触发下面「多出来的标签指向不存在的字段」。
  // 所以直接用运行时导出的可审计字段清单（默认导出即审计字段）。
  const auditKeys = auditFields()
  assert.ok(auditKeys.length >= 16, `可审计字段至少应有 16 个，实际 ${auditKeys.length}`)
  // 反向确认「排除」是真的生效了：这两个字段绝不该出现在审计里
  for (const excluded of ['personas', 'workspaces']) {
    assert.equal(
      auditKeys.includes(excluded),
      false,
      `${excluded} 不得进 AUDIT_FIELDS —— 复合结构在字段差分里读不出意义，且它随外部标识增删会让历史回滚失效`
    )
  }

  // 收尾的 `}` 是缩进的（客户端里的块都在函数体内），用顶格 `\n}` 会一路吞到远处
  // ——首版就是这么把 231 个键算进来的。
  const labelsBlock = clientCode.match(/const HISTORY_FIELD_LABELS = \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
  assert.ok(labelsBlock !== '', '找不到客户端 HISTORY_FIELD_LABELS')
  const labelKeys = [...labelsBlock.matchAll(/([A-Za-z][A-Za-z0-9]*):\s*'([^']+)'/g)].map((m) => m[1])
  for (const key of auditKeys) {
    assert.ok(labelKeys.includes(key),
      `审计字段 ${key} 没有历史标签 —— 变更记录里会把它显示成裸键名（新增配置字段时必须同步 HISTORY_FIELD_LABELS）`)
  }
  assert.equal(labelKeys.length, auditKeys.length,
    `HISTORY_FIELD_LABELS 有 ${labelKeys.length} 项、审计字段有 ${auditKeys.length} 个 —— 多出来的标签指向了不存在的字段`)

  // 值标签只允许查**已存在的**文案键：拼错一个键名，词典回退会把键名本身画到屏幕上。
  for (const m of labelsBlock.matchAll(/'((?:field|trail|toggle)\.[A-Za-z]+)'/g)) {
    assert.ok(clientSource.includes(`'${m[1]}': `), `标签指向的文案键 ${m[1]} 不存在`)
  }
  // 枚举值必须与设置页共用同一份取值表：各写一份迟早会把 'casual' 显示成键名。
  const enumBlock = clientCode.match(/const HISTORY_ENUM_VALUES = \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
  assert.ok(enumBlock !== '', '找不到 HISTORY_ENUM_VALUES（枚举值的文案来源）')
  for (const [field, constName] of [
    ['style', 'STYLE_VALUES'],
    ['headingLists', 'TRAIT_VALUES'],
    ['emoji', 'TRAIT_VALUES'],
    ['tables', 'TRAIT_VALUES'],
    ['replyLength', 'REPLY_LENGTH_VALUES'],
    ['trailSpeed', 'TRAIL_SPEED_VALUES'],
    ['trailWidth', 'TRAIL_WIDTH_VALUES']
  ]) {
    assert.match(enumBlock, new RegExp(`\\b${field}:\\s*${constName}\\b`),
      `变更记录的 ${field} 取值表应复用 ${constName}，不得另写一份`)
  }

  // 倒序是服务端的契约（toHistoryResponse 里 reverse 过一次）。客户端再排一次
  // 会把「最新在前」悄悄翻成「最旧在前」—— 用户看到的将是几年前的改动排第一行。
  // （0.8.1 双入口后，列表渲染在插件详情页组件 SoulHistorySection 内，
  // 缩进为 6 空格 —— 原设置页手风琴内是 8 空格，匹配缩进要跟着搬。）
  const listBlock = clientSource.match(/e\('ul', \{ className: 'soul-history-list' \},([\s\S]*?)\n\s{16}\)\)?,/)?.[1] ?? ''
  assert.ok(listBlock !== '', '找不到变更记录列表的渲染')
  assert.equal(/\.reverse\(\)|\.sort\(/.test(listBlock), false,
    '变更记录列表不得在客户端重排 —— 服务端已经按时间倒序返回')
  // 时间必须是相对时间：记录里存的是 ISO 字符串，直接画出来没人读得下去。
  assert.match(clientCode, /const historyTimeText = \(rawAt\)/, '缺少相对时间格式化函数')
  assert.match(clientCode, /!Number\.isFinite\(at\)\) return String\(rawAt\)/,
    '相对时间解析失败时应原样显示，而不是画出 NaN')
  // 时钟回拨（或服务端时间略快）会让差值变负 —— 「-3 分钟前」会被读成记录坏了。
  assert.match(clientCode, /if \(diff < 60 \* 1000\) return t\('history\.timeJustNow'\)/,
    '差值小于一分钟（含负数）都该显示「刚刚」')

  // 0.8.0 打磨：折叠行必须带 label（应用了哪个预设）——不然「应用预设 · 自定义指令」
  // 答不了用户最常问的那句「我切到哪个人设了」。
  assert.match(clientCode, /entry\.label === 'string' && entry\.label !== ''/,
    '折叠摘要必须使用条目的 label（预设名），旧记录无 label 时原样省略')
  assert.ok(clientSource.includes(`'history.labelSuffix': '：{label}'`) ||
    clientSource.includes(`'history.labelSuffix': ': {label}'`),
    '缺少 history.labelSuffix 文案键（zh+en）')
  // 展开详情必须是「展开即全文」：原值块 + 新值块各自铺开，长文本换行显示。
  assert.match(clientCode, /soul-history-diff-value/, '展开详情缺少全文值块（.soul-history-diff-value）')
  assert.match(clientCode, /soul-history-diff-tag/, '值块前必须有「原值/新值」标签（.soul-history-diff-tag）')
  // 旧的 grid + 箭头布局已被竖排全文取代；残留的 from/to 箭头类名说明只改了一半。
  assert.equal(/soul-history-diff-from|soul-history-diff-to|soul-history-diff-arrow/.test(clientCode), false,
    '旧的 88px 网格省略布局残留（soul-history-diff-from/to/arrow）—— 全文块已取代它')
})

// ---------- 工作区绑定（0.8.1-b）----------

check('工作区绑定：provider 每轮按会话 cwd 解析，且必须是同步的', () => {
  const opts = stripComments(extractObject(indexSource, 'spCtx.systemPrompt.section('))
  assert.ok(opts !== '', '找不到 spCtx.systemPrompt.section(...) 调用')

  // section 的 text 回调**必须读装配上下文**。宿主侧的原话是
  // `text: typeof entry.text === "function" ? entry.text(context) : entry.text`
  // （dsh-system-prompt/lib/index.js），也就是每个 step 都会重新求值一次 ——
  // 这正是「改配置后下一轮生效」这条通道的机制。不看入参就退化成全局一份文本，
  // 工作区绑定会**静默失效**：设置页显示绑定成功，会话里拿到的却是全局人设。
  assert.match(
    opts,
    /text:\s*\(?\s*assembly\s*\)?\s*=>/,
    'section 的 text 必须是接受装配上下文的函数（不看 assembly 就无法按 cwd 解析绑定）'
  )
  // 0.9.0 起 text 回调先取 `const agent = assembly && assembly.agent` 再传下去
  // （因为要同时取 sessionId 与 cwd）。判据因此松绑为「必须经 assembly 取到 agent 且
  // 对 undefined 安全」—— 而不是锁死 `cwdOfAgent(assembly && assembly.agent)` 这一种写法。
  // 守的语义没变：不看入参就退化成全局一份文本；不对 undefined 安全就在诊断装配时抛错。
  assert.match(
    opts,
    /assembly\s*&&\s*assembly\.agent/,
    'text 回调必须从 assembly 取 agent（宿主在诊断装配时不传 agent，故须用 && 容忍 undefined）'
  )
  assert.match(opts, /cwdOfAgent\(/, 'text 回调必须经 cwdOfAgent 取会话目录')
  assert.match(opts, /configForScope\(/, 'text 回调必须经 configForScope 合成该作用域生效的配置')
  assert.equal(/async\s*\(?\s*assembly/.test(opts), false, 'text 回调不得是 async')
  assert.equal(/await /.test(opts), false, 'text 回调内不得出现 await')

  // 宿主是**同步**调用 text 的（`section.text(context)` 位于一个非 async 的 map 回调里）。
  // 返回 Promise 会被当成 section 文本对象直接塞进提示词 —— 坏得无声无息。
  // 因此 realpath 这种异步 I/O 只能出现在**键**侧（loadBindings），不能出现在这里。
  assert.equal(
    /realpath|resolveDirIdentity/.test(opts),
    false,
    'text 回调里不得做 realpath（异步 I/O）：它必须是同步的，身份解析只能在 loadBindings() 对键做一次'
  )
  // 「保存后下一轮立即生效」的前提是**每次求值都重新取当前配置**，而不是把配置
  // 闭包进回调（那样只在注册时读一次，之后永远用旧值）。
  //
  // 0.9.0-a 起取法从「直接读 configCache」改为 `snapshotConfig()`：后者返回
  // `{ revision, value }` 的快照，保证同一轮装配只用一份配置（configCache 由写队列
  // 整体替换，一次装配里多次读可能读到两个版本）。所以这里不锁死写法，而是钉住
  // 两个本质：① 回调里调用了快照函数；② 这个函数内部确实读模块级 configCache。
  assert.match(
    opts,
    /snapshotConfig\(\)/,
    'text 回调应经 snapshotConfig() 取当前配置快照（每轮重新取，且同一轮只用一份）'
  )
  const snapshotFn = indexSource.match(/function snapshotConfig\(\)\s*\{[\s\S]*?\n\}/)
  assert.ok(snapshotFn, '找不到 snapshotConfig() 的实现')
  assert.match(
    snapshotFn[0],
    /configCache \|\| DEFAULT_CONFIG/,
    'snapshotConfig 必须读模块级 configCache —— 否则保存后下一轮拿不到新配置'
  )
  // 反向：不得把配置固化进闭包（那是「注册时读一次」的错误形态）
  assert.equal(
    /const\s+\w+\s*=\s*configCache\b[^]*?text:/.test(opts),
    false,
    '不得在 section 注册前把 configCache 固化进闭包 —— 那样保存后不会生效'
  )
})

check('0.9.0-a 配置快照：修订号单调递增，装配只取一次快照', () => {
  // 为什么需要这条：system prompt 的 section.text 由宿主**同步**、且**每个 step 都调用**
  // 一次。configCache 由写队列整体替换，若一次装配里读了两次配置（例如先取 base、
  // 再在合成函数里又读一遍），装配期间发生写入就会让**同一轮用上两个版本**。
  // 症状是「System Prompt Updated 已出现、模型却仍用旧昵称」——过去只能靠猜。

  // ① 修订号存在且只在一处自增
  const bumps = [...indexSource.matchAll(/bumpConfigRevision\(\)/g)]
  assert.ok(bumps.length >= 2, `修订号应在读盘与写入后各 +1（实际 ${bumps.length} 处调用）`)
  assert.match(indexSource, /let configRevision = 0/, '缺少单调修订号的初始值')
  // 反向：不得有第二处直接自增（那会让「+1 的时机」散落成多处）。
  // 判据要把 bumpConfigRevision **自己**的实现体排除掉 —— 它当然要 += 1。
  const bumpBody = indexSource.match(/function bumpConfigRevision\(\)\s*\{[\s\S]*?\n\}/)
  assert.ok(bumpBody, '找不到 bumpConfigRevision() 的实现')
  const outsideBump = indexSource.replace(bumpBody[0], '')
  const direct = [...outsideBump.matchAll(/configRevision\s*\+\+|configRevision\s*\+=/g)]
  assert.equal(direct.length, 0, '只允许经 bumpConfigRevision() 自增，不得在别处直接改 configRevision')

  // ② 读盘成功与写入成功都必须 bump —— 漏一处就会出现「改了配置但修订号不动」
  const loadBody = indexSource.match(/async function loadConfig\(\)[\s\S]*?\n\}/)
  assert.ok(loadBody, '找不到 loadConfig')
  assert.match(loadBody[0], /bumpConfigRevision\(\)/, 'loadConfig 读盘成功后必须 bump')
  const saveBody = indexSource.match(/async function saveConfig\(config\)[\s\S]*?\n\}/)
  assert.ok(saveBody, '找不到 saveConfig')
  assert.match(saveBody[0], /bumpConfigRevision\(\)/, 'saveConfig 写盘成功后必须 bump')
  // 「损坏」分支刻意不 bump：它没有替换 configCache，修订号不该前进
  assert.equal(
    /failure\)\s*\{[^}]*bumpConfigRevision/.test(loadBody[0]),
    false,
    '读盘失败（配置损坏）不得 bump —— 它没有替换缓存'
  )

  // ③ 快照必须同时给出 revision 与 value，且 value 回落 DEFAULT_CONFIG
  const snap = indexSource.match(/function snapshotConfig\(\)\s*\{[\s\S]*?\n\}/)
  assert.ok(snap, '找不到 snapshotConfig()')
  assert.match(snap[0], /revision:\s*configRevision/, '快照应带上当时的修订号')
  assert.match(snap[0], /value:\s*configCache \|\| DEFAULT_CONFIG/, '快照应带上当时的配置值')
  assert.equal(/await/.test(snap[0]), false, 'snapshotConfig 必须同步 —— revision 与 value 之间不能有 await')

  // ④ 装配路径：快照先取，之后只用它。这是本步的核心契约。
  const opts = stripComments(extractObject(indexSource, 'spCtx.systemPrompt.section('))
  assert.match(opts, /const snap = snapshotConfig\(\)/, 'text 回调应先取一次快照')
  assert.match(opts, /snap\.value/, '合成配置时必须用快照里的值，而不是重新读 configCache')
  // 反向：text 回调体内不得再出现裸的 configCache 读取（那就是"第二个版本"的入口）
  assert.equal(
    /configCache/.test(opts),
    false,
    'text 回调内不得直接读 configCache —— 必须经快照，否则同一轮可能用上两个版本'
  )
  // ⑤ 快照的版本号要落到诊断状态，否则「哪一版进了模型」仍然无处可查
  assert.match(opts, /lastAssembledRevision = snap\.revision/, '应把本轮使用的修订号记进诊断状态')
  assert.match(
    indexSource,
    /lastAssembledRevision: deliveryState\.lastAssembledRevision/,
    '状态端点应外发 lastAssembledRevision，否则新字段只是死数据'
  )
})

check('工作区绑定：注入通道逐 agent 编译，不共用一份全局文本', () => {
  const matched = indexCode.match(/function injectPromptToAllAgents\(ctx, config\)[\s\S]*?\n\}/)
  assert.ok(matched, 'index.mjs 中找不到 injectPromptToAllAgents')
  const body = matched[0]

  // 草案 §6.3：配置不再全局唯一之后，算一份文本发给所有人就是**把 A 项目的人设
  // 注入 B 项目的会话** —— 比不注入更糟（不注入时它至少还是全局配置，与用户以为的一致）。
  const loopAt = body.indexOf('for (const agent of listed)')
  assert.ok(loopAt !== -1, '找不到遍历活动会话的循环')
  const loop = body.slice(loopAt)
  assert.match(
    loop,
    /configForCwd\(\s*config\s*,\s*cwdOfAgent\(\s*agent\s*\)\s*\)/,
    '编译必须发生在循环体内、按该 agent 的 cwd 解析 —— 循环外算一份就和绑定功能互相抵消'
  )
  // 反证：循环外不得再有 compilePrompt（否则那份文本会被复用给所有会话）
  assert.equal(
    /const prompt = compilePrompt\(config\)/.test(body.slice(0, loopAt)),
    false,
    '循环外不得预先编译一份全局文本'
  )
  // 逐 agent 编译不得以破坏可观测性为代价（与上面那条断言同一组契约）
  assert.ok(/delivered\+\+/.test(body) && /failed\+\+/.test(body), '仍应如实统计成功与失败数')
  assert.match(
    body,
    /configForCwd\(config, cwdOfAgent\(agent\)\)[\s\S]{0,120}?const prompt = compilePrompt\(perAgent\)/,
    '应当先用该会话的 cwd 合成配置、再编译（顺序反了等于还是全局文本）'
  )
})

check('工作区绑定：合成配置只覆盖人设字段，全局总开关不被覆盖', () => {
  // 0.9.0 起解析链收口在 configForScope（工作区层 → 目录回退 → 全局），
  // configForCwd 退化为「不带工作区层的薄包装」。断言对象随之移动，
  // 但守的三件事一字未变：白名单、同一套校验、enabled 不可触碰。
  const fn = stripComments(extractObject(indexSource, 'function configForScope'))
  assert.ok(fn !== '', '找不到 configForScope 函数体')
  assert.match(fn, /resolveBindingForCwd\(/, '目录回退层必须仍按目录解析绑定')
  assert.match(
    fn,
    /pickPersonaValues\(persona\)/,
    '必须用 pickPersonaValues 走白名单 —— 直接展开条目会把磁盘上残留的「关于你」写回活动配置'
  )
  assert.match(fn, /sanitizeConfig\(/, '合成的补丁要经同一套校验（与 /personas/use 的取值语义逐字段一致）')
  // 工作区层同样必须是**部分覆盖 + 白名单**，不能把整个 workspaces 对象铺进配置。
  assert.match(fn, /mergeWorkspaceOverride\(/, '工作区层必须经 mergeWorkspaceOverride 合并（部分覆盖 + 白名单）')
  // `enabled` 不属于任何覆盖范围：关掉插件后，绑定的目录也不该偷偷注入人设。
  assert.equal(
    /\benabled\b/.test(fn),
    false,
    'configForScope 不得触碰 enabled —— 全局总开关必须始终说话'
  )
  // 反向：薄包装只该转调，不该自己再实现一遍合并（两份实现必然漂移）
  const thin = stripComments(extractObject(indexSource, 'function configForCwd'))
  assert.ok(thin !== '', '找不到 configForCwd 薄包装')
  assert.match(thin, /configForScope\(/, 'configForCwd 应转调 configForScope，不得保留第二份合并实现')
  const cwdOf = stripComments(extractObject(indexSource, 'function cwdOfAgent'))
  assert.ok(cwdOf !== '', '找不到 cwdOfAgent 函数体')
  assert.match(
    cwdOf,
    /agent\?\.session\?\.header\?\.cwd/,
    'cwdOfAgent 必须用可选链容忍 undefined —— 宿主在诊断装配时不传 agent（absent on diagnostics）'
  )
  assert.match(
    cwdOf,
    /typeof cwd === 'string' && cwd\.trim\(\) !== ''/,
    '空串 / 非字符串的 cwd 必须当成「没有会话信息」，否则 normalizeDirPath 会拿它去匹配'
  )
})

check('0.9.0-b 工作区层：sessionId → workspaceId 索引接入，且失败安全', () => {
  // 这组是**接线**断言。零依赖纯函数层的正确性由 verify-scope 守着，但"接线有没有接上"
  // 是另一回事 —— 判断力对照实测：把装配里的索引查询改成常量 null、把 sessionId 取成
  // null、删掉事件重建、甚至把工作区层整段短路，全部漏网（因为没有任何断言看住接线）。
  // 接线错了的症状是"工作区绑定了却从不生效"，且不报错。

  // ① sessionId 的取值：agent.id 就是 sessionId（宿主 typert lookup 以 SessionId 为 wire 类型）
  const sidFn = stripComments(extractObject(indexSource, 'function sessionIdOfAgent'))
  assert.ok(sidFn !== '', '找不到 sessionIdOfAgent')
  assert.match(sidFn, /agent\?\.id/, 'sessionId 必须取自 agent.id —— 宿主注册 typert lookup 时用的正是该字段')
  assert.match(sidFn, /typeof id === 'string'/, '必须校验类型：非字符串的 id 不能当索引键')

  // ② 索引查询确实发生在装配路径里，且结果传给了 configForScope
  const opts = stripComments(extractObject(indexSource, 'spCtx.systemPrompt.section('))
  assert.match(
    opts,
    /sessionWorkspaceIndex\.get\(sessionId\)/,
    '装配时必须查 sessionWorkspaceIndex —— 否则工作区层永远命中不到'
  )
  assert.match(
    opts,
    /configForScope\(\s*snap\.value\s*,\s*cwdOfAgent\(agent\)\s*,\s*workspaceId\s*,/,
    'configForScope 必须收到 workspaceId（第三个参数）—— 漏传就退化成只有 cwd 回退'
  )
  // 反向：索引未命中时要能退化，不能因为查不到就抛错
  assert.match(opts, /\|\|\s*null/, '索引未命中必须退化成 null（走 cwd 回退），不得抛错')

  // ③ 索引重建的三个时机，缺一个都会让「工作区改了却不生效」
  const reg = stripComments(extractObject(indexSource, 'function registerWorkspaceIndex'))
  assert.ok(reg !== '', '找不到 registerWorkspaceIndex')
  assert.match(reg, /rebuildWorkspaceIndex\(ctx\)/, '必须调用重建函数')
  assert.match(reg, /ctx\.on\('domain\/changed'/, '必须订阅宿主的工作区域变更事件')
  assert.match(reg, /pendingWorkspaceRescan/, '必须有"装配未命中就重扫"的兜底 —— 事件改名时否则会静默停止更新')
  assert.match(reg, /ctx\.effect\(/, '定时器必须挂在 ctx.effect 里，否则插件卸载后仍在跑')

  // ④ 重建本身必须递归安全：服务缺席返回 false 而不是抛错
  const rebuild = stripComments(extractObject(indexSource, 'function rebuildWorkspaceIndex'))
  assert.ok(rebuild !== '', '找不到 rebuildWorkspaceIndex')
  assert.match(rebuild, /typeof registry\.list !== 'function'/, '服务缺席必须优雅降级（返回 false），不能让插件装配失败')
  assert.match(rebuild, /try\s*\{/, 'list() 与 sessionIds getter 都可能抛错，必须包 try')

  // ⑤ 工作区层与目录层的顺序：workspace 优先，目录回退
  const scope = stripComments(extractObject(indexSource, 'function configForScope'))
  const wsAt = scope.indexOf('resolveWorkspaceOverride')
  const dirAt = scope.indexOf('resolveBindingForCwd')
  assert.ok(wsAt !== -1 && dirAt !== -1, 'configForScope 必须同时含工作区层与目录回退层')
  assert.ok(wsAt < dirAt, '工作区层必须排在目录回退**之前** —— 顺序反了会让稳定的 workspaceId 被目录字符串盖掉')
  // 反向：工作区层的判断不能是死代码（短路让它永不生效）
  assert.equal(/if \(false\)|if \(!false\)/.test(scope), false, '不得用常量短路工作区层')
})

check('0.9.0-c 会话层：装配走内存缓存，回收只认 sessionPersistence', () => {
  // 同 0.9.0-b 的教训：纯函数层测好了不等于接上了。这组守**接线**。

  // ① 装配路径必须把会话覆盖传进 configForScope（第四个参数）
  const opts = stripComments(extractObject(indexSource, 'spCtx.systemPrompt.section('))
  // 正则不能用 `[^)]*` 跨越参数里的括号（`cwdOfAgent(agent)` 就有 `)`）。
  // 改为从调用名开始取一段，再要求 workspaceId 与 sessionOverride 按序出现。
  const callMatch = opts.match(/configForScope\([\s\S]{0,200}?\)\n/)
  assert.ok(callMatch, '找不到 configForScope 的调用')
  assert.match(
    callMatch[0],
    /workspaceId[\s\S]{0,60}sessionOverride/,
    'configForScope 的调用应依次传入 workspaceId 与会话覆盖 —— 漏传 sessionOverride 则会话层永不生效'
  )
  assert.match(opts, /sessionOverridesOrNull\(/, '装配必须查会话覆盖缓存')
  // 反向：装配里绝不能读盘（同步调用，返回 Promise 会被当成提示词文本）
  assert.equal(/readSessionScope|await /.test(opts), false, '装配路径不得读盘、不得有 await')

  // ② 缓存未命中时**不能**阻塞：它必须返回 null 并排一次后台加载
  const fn = stripComments(extractObject(indexSource, 'function sessionOverridesOrNull'))
  assert.ok(fn !== '', '找不到 sessionOverridesOrNull')
  assert.match(fn, /sessionOverridesKnown\.has/, '必须区分「已知没有覆盖」与「还没加载过」')
  assert.match(fn, /void loadSessionOverride\(/, '未命中时应排一次后台加载（不阻塞本轮）')
  assert.match(fn, /return null/, '未命中必须返回 null（本轮按上层走），不得抛错')

  // ③ 写入路径必须**先写缓存再刷新提示词**（否则紧接着的那轮装配读到旧值）
  const route = stripComments(indexSource)
  const cacheAt = route.indexOf('sessionOverrides.set(sessionId, override)')
  const refreshAt = route.indexOf('refreshPromptAndInject(ctx, await loadConfig())', cacheAt)
  assert.ok(cacheAt !== -1, '设置会话覆盖后必须同步更新缓存')
  assert.ok(refreshAt > cacheAt, '缓存更新必须排在 refreshPromptAndInject **之前**')

  // ④ 回收：默认 dry-run，且判定依据是 sessionPersistence
  const gc = stripComments(extractObject(indexSource, 'async function planSessionGc'))
  assert.ok(gc !== '', '找不到 planSessionGc')
  assert.match(gc, /ctx\.get\('sessionPersistence'\)/, '回收必须以 sessionPersistence 为判定依据')
  // 这是设计红线：agents.list 是 live registry，会话切走就消失
  assert.equal(
    /agents\.list|\bctx\.get\('agents'\)/.test(gc),
    false,
    '回收绝不能用 agents.list() 判定会话已删除 —— 那是 live registry，会误删正在使用的覆盖'
  )
  assert.match(gc, /scanComplete/, '必须计算本轮扫描是否完整')
  assert.match(
    gc,
    /presentOnDisk: scanComplete \? stored\.has\(sessionId\) : false/,
    '扫描不完整时 presentOnDisk 必须为 false，让状态机走「不做判定」分支'
  )
  // 反向：扫描不完整时绝不能写孤儿标记（否则一次临时故障会把所有条目刷上时间）
  assert.match(gc, /decision\.action === 'mark' \|\| decision\.action === 'clear-mark'/, '只有这两种动作才落盘')
  // dry-run 是默认：只有显式 apply:true 才删
  const applyGuard = stripComments(indexSource).match(/const apply = parsed\.body && parsed\.body\.apply === true/)
  assert.ok(applyGuard !== null, '必须只有显式 apply:true 才真正删除（默认 dry-run）')
})

check('工作区绑定：读盘只在装配路径之外，且失败不阻塞启动', () => {
  // 绑定表要单独缓存的原因：两个消费者都在**每一轮装配**上（text provider 每轮一次、
  // 注入每次保存一次）。读盘 + 最多 200 次 realpath 放进这条路径不可接受。
  const load = stripComments(extractObject(indexSource, 'async function loadBindings'))
  assert.ok(load !== '', '找不到 loadBindings 函数体')
  assert.match(load, /readBindingsFile\(/, '应经 lib/bindings.mjs 读取（损坏 / 版本的判定在那里）')
  assert.match(load, /resolveDirIdentity\(/, '应把每条键解析成身份形态（解 Junction / 符号链接）')
  assert.equal(/throw /.test(load), false, 'loadBindings 不得抛错：绑定是可选增强，读不出来不该让装配流程崩掉')
  // 失败时不写缓存（与 loadConfig 同款：用户改对文件后下次加载自动恢复），
  // 但必须把比较表清空 —— 宁可暂时不生效，也不能拿旧表继续命中。
  assert.match(
    load,
    /if \(failure\) \{[\s\S]*?bindingsCompareTable = \{\}[\s\S]*?bindingsDisplayOf = new Map\(\)[\s\S]*?return /,
    '加载失败时必须清空比较表并提前返回（不得留着旧表继续命中）'
  )
  const failBlock = load.match(/if \(failure\) \{[\s\S]*?\n  \}/)?.[0] ?? ''
  assert.equal(
    /bindingsCache\s*=/.test(failBlock),
    false,
    '失败分支不得写 bindingsCache：缓存了空表，用户修好文件后不重启就恢复不了'
  )

  // 身份键不得覆盖展示键：展示键是用户亲手写下的那个名字，优先级更高；
  // 被挡住的身份键只是少一条别名，判定方向安全。
  assert.match(
    load,
    /if \(hasOwn\(compareTable, identity\)\) continue/,
    '身份键撞上另一条展示键时应跳过 —— 覆盖会让 UI 显示用户没写过的目录名'
  )
  assert.match(
    load,
    /compareKey\(identity\) === compareKey\(dir\)\) continue/,
    '身份键与展示键相同时不应另占一个键位（否则 shadowed 会出现重复项）'
  )

  // 启动时读一次：必须在装配路径之外做完（text provider 是同步的，不能在里面 await）。
  const applyBody = stripComments(extractObject(indexSource, 'export async function apply'))
  assert.ok(applyBody !== '', '找不到 apply 函数体')
  assert.match(applyBody, /await ensureBindings\(\)/, 'apply() 应在注册 section 之前先读一次绑定表')
  const sectionAt = applyBody.indexOf('registerSystemPrompt(')
  const bindingsAt = applyBody.indexOf('await ensureBindings()')
  assert.ok(bindingsAt !== -1 && sectionAt !== -1, 'apply() 里应同时有 ensureBindings 与 registerSystemPrompt')
  assert.ok(
    bindingsAt < sectionAt,
    '读绑定表必须排在注册 section 之前 —— 注册那一刻 provider 就可能被调用，此时表还没读出来'
  )
})

check('工作区绑定：命中结果回报展示键，失效项去重后如实上报', () => {
  const fn = stripComments(extractObject(indexSource, 'function resolveBindingForCwd'))
  assert.ok(fn !== '', '找不到 resolveBindingForCwd 函数体')
  assert.match(fn, /normalizeDirPath\(cwd\)/, 'cwd 侧只做纯字符串规范化（realpath 已在键侧做过）')
  assert.match(
    fn,
    /bindingsDisplayOf\.get\(/,
    '命中后必须把身份键翻译回展示键 —— 用户不认得 realpath 吐出来的名字'
  )
  // 同一条绑定的展示键与身份键可能同时命中，不去重 UI 会把一条失效绑定画两遍。
  assert.match(fn, /const seen = new Set\(\)/, 'shadowed 需要按翻译后的 dir 去重')
  // ★ 只声明 Set 而不判 membership 等于**没有去重** —— 这两行必须成对存在。
  // 曾有变异把 `if (seen.has(dir)) continue` 整行删掉，而上面那条只认 `new Set()`
  // 的断言照样通过：断言看住了「有没有去重集合」，却没看住「有没有用它」。
  assert.match(
    fn,
    /if \(seen\.has\(dir\)\) continue/,
    '去重必须真的判 membership（`seen.add` 之前要先 `seen.has` 才 continue），否则 Set 形同虚设'
  )
  assert.match(
    fn,
    /shadowed\.push\(\{ \.\.\.item, dir \}\)/,
    'shadowed 项也要带上展示键（UI 要能说出「这条更具体的绑定为什么没生效」）'
  )
  assert.equal(
    /shadowed\.push\(\{ \.\.\.item, dir: item\.dir \}\)/.test(fn),
    false,
    'shadowed 不得保留原始键 —— 身份键会直接显示给用户'
  )
})

check('工作区绑定四条契约：同一路径只注册一次、方法分派、队列内读盘、删空不刷新', () => {
  // ---------- ① 同一 (kind, path) 只能注册一次 ----------
  //
  // 宿主 dsh-host-webserver 的 register() 对重复 (kind, path) **直接抛错**：
  //   if (table.has(route.path)) throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
  // 而注册发生在 ctx.inject 回调里 ⇒ 一次重复注册不是「后一个生效」，是**整个插件
  // 装配失败**（用户看到的是插件加载不出来，与控制台里那句重复路由毫无字面关联）。
  //
  // ⚠️ 这条是元断言：它必须自己解析出全部注册点，而不是逐个点名。曾经 GET 与 POST
  // 各写了一次 register('/api/soul/bindings')，本机假宿主用 Map.set 静默覆盖，
  // 一路绿到浏览器里才炸。
  const registrations = [...indexCode.matchAll(/webServer\.register\(\{\s*kind:\s*'(\w+)',\s*path:\s*'([^']+)'/g)].map(
    (m) => ({ kind: m[1], path: m[2] })
  )
  assert.ok(registrations.length >= 16, `注册点解析失败（只找到 ${registrations.length} 处，路由数量不该这么少）`)
  const seenRoutes = new Map()
  const duplicated = []
  for (const route of registrations) {
    const key = `${route.kind} ${route.path}`
    if (seenRoutes.has(key)) duplicated.push(key)
    seenRoutes.set(key, true)
  }
  assert.deepEqual(
    duplicated,
    [],
    `同一个 (kind, path) 被注册了多次：${JSON.stringify(duplicated)} —— 宿主会抛 ` +
      'webserver: duplicate，装配直接失败。GET/POST 必须在 handler 内按 req.method 分派。'
  )

  // ---------- ② GET / POST 共用一次注册，且两条分支都在 ----------
  const bindingsRoutes = [...indexCode.matchAll(/path: '\/api\/soul\/bindings'[\s\S]*?\n    \}\)/g)].map((m) => m[0])
  assert.equal(bindingsRoutes.length, 1, `/api/soul/bindings 应只注册一次，实际 ${bindingsRoutes.length} 次`)
  const bindings = bindingsRoutes[0]
  assert.match(bindings, /if \(req\.method === 'GET'\)/, 'GET 分支缺失：列表读不出来了')
  assert.match(bindings, /if \(req\.method !== 'POST'\)/, 'POST 之外的其它方法必须落到 405')
  assert.match(bindings, /send\(res, 405, \{ ok: false, error: 'Method not allowed' \}\)/, '方法不符应返回 405')
  // 顺序：GET 必须在 405 之前判掉，否则列表接口自己先被 405 拦住。
  assert.ok(
    bindings.indexOf("req.method === 'GET'") < bindings.indexOf("req.method !== 'POST'"),
    'GET 分支必须先于 405 判定 —— 反过来写会让读取接口自己收到 405'
  )

  const del = indexCode.match(/path: '\/api\/soul\/bindings\/delete'[\s\S]*?\n    \}\)/)?.[0] ?? ''
  assert.ok(del !== '', '缺少解绑路由')
  assert.match(del, /req\.method !== 'POST'/, '解绑必须显式校验 req.method === POST')
  assert.match(del, /send\(res, 405, \{ ok: false, error: 'Method not allowed' \}\)/, '解绑的方法不符应返回 405')

  // ---------- ③ 写路径：准入在队列外，读盘在队列内 ----------
  assert.match(bindings, /bindingRefusal\(/, '写绑定前必须过 bindingRefusal（路径非法 / 过长 / 人设不存在）')
  assert.match(bindings, /normalizeBindingEntry\(/, '写入的键值必须规范化（否则同一目录存成多条）')
  // 队列外读会与并发写形成窗口，后写覆盖前写。绑定表是**整表替换**式的读改写，
  // 这个窗口不是理论问题：设置页连点两次就是两次并发 POST。
  assert.match(
    bindings,
    /await enqueueBindingsWrite\(async \(\) => \{[\s\S]*?readBindingsFile\(bindingsPath\(\)\)/,
    '读盘必须在 enqueueBindingsWrite 队列**内**：队列外读会有窗口，后写覆盖前写'
  )
  assert.equal(
    /const read = await readBindingsFile\(bindingsPath\(\)\)[\s\S]{0,400}?await enqueueBindingsWrite/.test(bindings),
    false,
    '读盘不得在入队之前 —— 这是竞态窗口的另一种写法'
  )
  assert.match(bindings, /const isNew = !hasOwn\(table, entry\.dir\)/, '改绑与新增必须分开判定')
  // 满表时改绑仍应可用：否则用户只能先删一条再改，而删除是不可逆的。
  assert.match(
    bindings,
    /if \(isNew && Object\.keys\(table\)\.length >= MAX_BINDINGS\)/,
    '只有真新增才受上限约束 —— 满表后连改绑都做不了会让用户只能先删再绑'
  )

  // ---------- ④ 删除：按比较键命中，删空不刷新 ----------
  assert.match(del, /normalizeDirPath\(parsed\.body && parsed\.body\.dir\)/, '解绑目标要规范化')
  // 配置里存的可能是另一种写法（分隔符 / 尾分隔符 / 盘符大小写），拿原串直接
  // delete 会「点了没反应」—— 用户看到列表里那一行，点下去什么都没发生。
  assert.match(
    del,
    /Object\.keys\(table\)\.find\(dir => compareKey\(dir\) === compareKey\(target\)\)/,
    '必须按比较键找目标：拿原串 delete 会「点了没反应」'
  )
  assert.equal(/delete table\[target\]/.test(del), false, '不得用原串直接 delete')
  // 一次空解绑不该向所有活动会话注入快照：那是一条「配置已更新」的假消息。
  assert.match(
    del,
    /if \(removed\) await afterBindingsWrite\(config\)/,
    '没删掉任何东西时不得刷新提示词（空解绑会向所有会话注入一条假更新）'
  )

  // ---------- ⑤ 写后必须自己刷新：第三类会改变提示词的事实 ----------
  for (const [name, source] of [['新增/改绑', bindings], ['解绑', del]]) {
    assert.match(source, /afterBindingsWrite\(config\)/, `${name} 写完后必须触发刷新`)
  }
  const after = extractObject(indexSource, 'const afterBindingsWrite')
  assert.ok(after !== '', '找不到 afterBindingsWrite')
  // 绑定表改了但内存缓存没重载，刷新出去的仍是旧解析结果 —— 表现是「保存了却不生效」。
  assert.match(after, /await loadBindings\(\)/, '刷新前必须重载绑定表，否则刷出去的还是旧解析结果')
  assert.match(after, /refreshPromptAndInject\(ctx, fresh\)/, '绑定变更必须自己刷新提示词')
  // 绑定写不能借配置写队列：两套数据因果无关，共用队列只会把延迟叠在一起（§4.3）。
  assert.match(indexCode, /let bindingsWriteQueue = Promise\.resolve\(\)/, '绑定写应有独立的队列实例')
  assert.equal(
    /enqueueConfigWrite[\s\S]{0,200}?writeBindingsFile/.test(indexCode),
    false,
    '绑定写不得走配置写队列'
  )
})

check('工作区绑定只读视图：失效条目标注、sessions 走与会话相同的解析路径', () => {
  const view = extractObject(indexSource, 'async function bindingsView')
  assert.ok(view !== '', '找不到 bindingsView')
  // 失效引用**不自动删除**（用户可能只是临时删了预设、打算改回来），但必须显式标注 ——
  // 否则用户在目录里等一个永远不会来的人设。
  assert.match(view, /invalid\.push\(\{ dir, persona: name \}\)/, '失效引用要如实列出')
  assert.equal(/delete cache\.bindings\[/.test(view), false, '不得自动删除失效引用（设计 §4.2）')
  assert.match(view, /warning: bindingsLoadFailure/, '整表读不出来要作为 warning 回传，与「一条都没绑」区分')
  assert.match(view, /max: MAX_BINDINGS/, '要把条数上限回传（界面才能说清还有多少余量）')
  assert.match(view, /sessions: describeActiveSessions\(ctx, config\)/, '要带回活动会话的解析结果')

  const sessions = extractObject(indexSource, 'function describeActiveSessions')
  assert.ok(sessions !== '', '找不到 describeActiveSessions')
  // 列不出活动会话不是错误：设置页只是少一段「当前用的谁」，仍能管理绑定表。
  // 两个分支（agents 服务缺席 / list() 抛错）都必须**返回空列表而不是抛出去** ——
  // 读侧一抛，整个 GET /api/soul/bindings 就 500，用户连绑定表都看不到了。
  assert.match(sessions, /agents\.list\(\)/, '活动会话来自 agents.list()')
  assert.equal(/throw /.test(sessions), false, 'describeActiveSessions 不得抛错：列不出会话只是少一段信息，不该让整个读接口失败')
  assert.match(sessions, /typeof agents\.list !== 'function'\) return out/, 'agents 服务不可用时应返回空列表')
  assert.match(sessions, /catch \{[\s\S]{0,200}?return out/, 'list() 抛错时同样返回空列表，且不得把异常冒泡给 HTTP 层')
  // 生效人设必须走与真实装配**同一条路径**，否则设置页显示的人设与实际注入的可能不一致 ——
  // 那正是最难查的一类 bug。
  assert.match(sessions, /configForCwd\(config, cwd\)\.config/, '生效人设必须走 configForCwd（与真实装配同一条路径）')
  // ★ 光「算了」还不够，还得**回报出去**：sessions[].persona 是设置页回答「我这个项目
  // 现在到底是谁」的唯一来源。曾有一条变异把这一项写成 null 而全部断言照绿 ——
  // 因为断言只看 binding 名，没看生效人设。
  assert.match(
    sessions,
    /persona: findActivePersonaName\(effective\)/,
    'sessions 必须回报生效人设（不是 null、也不是全局那一个）：界面要答得出「这个会话现在是谁」'
  )
  // 只有**没有 cwd** 的分支才可以用全局配置算生效人设（那时确实没有绑定可解析）。
  // 有 cwd 的分支若也这么算，带绑定的会话会显示成全局那个名字，而注入的是绑定的人设。
  assert.equal(
    (sessions.match(/persona: findActivePersonaName\(config\)/g) || []).length,
    1,
    '用全局配置算生效人设只允许出现在「没有 cwd」那一个分支里'
  )
  // 没有 cwd 的会话要如实说出来，而不是静默省略：用户需要知道「这个会话没有目录」。
  assert.match(sessions, /cwd: null/, '没有 cwd 的会话要显式回报，不能静默跳过')
  // 「直接绑定」与「继承自上级」的判别必须在宿主做：客户端拿原始串比较时
  // Windows 上 `D:\项目A` 与 `d:\项目a` 会被判成不同目录。
  assert.match(
    sessions,
    /compareKey\(normalizeDirPath\(resolved\.dir\)\) === compareKey\(normalizeDirPath\(cwd\)\)/,
    'inherited 判别必须在宿主做，且用比较键（原始串比较在 Windows 上会误判大小写）'
  )
  assert.equal(
    /resolved\.dir === cwd/.test(sessions),
    false,
    '不得用原始串比较目录 —— 盘符大小写 / 分隔符差异会让「就是本目录」显示成「继承自上级」'
  )
})

check('工作区绑定：纯函数层不依赖宿主，隐私边界不破', () => {
  const bindingSource = readFileSync(new URL('../lib/bindings.mjs', import.meta.url), 'utf8')
  const bindingCode = stripComments(bindingSource)
  assert.equal(
    /from 'cordis'|require\('cordis'\)/.test(bindingCode),
    false,
    'lib/bindings.mjs 不得依赖 cordis —— 它要能被脚本独立加载测试'
  )
  // 绑定表里存的是**本机目录结构**，属于用户隐私：它只用于选人设，内容绝不进提示词。
  assert.equal(
    /compilePrompt|systemPrompt|injectPromptToAllAgents/.test(bindingCode),
    false,
    'lib/bindings.mjs 不得触碰提示词装配 —— 目录路径不进 system prompt'
  )
  assert.equal(/console\./.test(bindingCode), false, '纯函数层不得打印')
  // 绑定文件的读写必须复用统一原语（原子写 / 损坏处理 / 路径推导），不得各自造一份。
  assert.match(bindingCode, /from '\.\/store\.mjs'/, '应复用 lib/store.mjs 的读写原语')
  assert.match(
    bindingCode,
    /await writeConfigFile\(filePath, serializeBindings\(bindings\)\)/,
    'writeBindingsFile 必须经 writeConfigFile 原子写'
  )
  // 绑定文件是配置文件的**兄弟**：由 configPath() 推导，测试把配置指到临时目录时绑定自动跟随。
  assert.match(indexCode, /function bindingsPath\(\)[\s\S]{0,120}?bindingsPathFor\(configPath\(\)\)/,
    '绑定文件路径应由 configPath() 推导（「配置在哪、绑定就在哪」是结构事实）')
})

// ---------- 设置页「工作区绑定」：渲染层契约（0.8.1-d）----------
//
// 行为层在 verify-client C29–C33；这里守的是**源码文本才能看清**的那几条：
// uiWorkspace 必须动态注入、组件引用的每个 bindings.* 键都要在两种语言里存在、
// 每个用到的 class 都要有对应样式规则。缺任何一条都不会让任何断言变红 ——
// 只有真机上会显示成原始 key 或裸 HTML。

check('工作区绑定：uiWorkspace 只走动态 inject，静态依赖表不得含它', () => {
  // 静态数组里多一个服务 = 缺它时**整个插件不激活**（设置页与人设卡一起消失）
  const staticInject = clientCode.match(/const inject = \[[^\]]*\]/)
  assert.ok(staticInject, '应能读到静态 inject 数组')
  assert.equal(
    /uiWorkspace/.test(staticInject[0]),
    false,
    `uiWorkspace 不得进静态 inject（缺服务会让整插件不激活）：${staticInject[0]}`
  )
  assert.match(
    clientCode,
    /ctx\.inject\(\s*\['uiWorkspace'\]/,
    '必须用动态 ctx.inject([\'uiWorkspace\'], …) 获取目录点选服务'
  )
  // 只靠「按钮渲染时判空」是不够的：服务可能在按钮画出来**之后**被撤走
  // （插件卸载 / scope 卸载 / 物化顺序变化），此时点下去就是对 null 取属性，
  // 用户看到的是一个看不懂的 TypeError。handlePick 自己必须再守一次。
  assert.match(
    clientCode,
    /async function handlePick\(\)[\s\S]{0,200}if \(!directoryPicker\)/,
    'handlePick 必须自己判空（服务可能在渲染后才被撤走）'
  )
})

check('工作区绑定：SoulBindings 引用的 bindings.* 键在 zh / en 里都存在', () => {
  const zhText = extractObject(clientSource, 'const zh = {')
  const enText = extractObject(clientSource, 'const en = {')
  const zhKeys = objectKeys(zhText)
  const enKeys = objectKeys(enText)
  // 从组件源码里抓它实际用到的键（而不是手抄一份清单 —— 手抄清单不会跟着组件变）
  const at = clientCode.indexOf('function SoulBindings(props)')
  assert.ok(at !== -1, '应存在 SoulBindings 组件')
  const body = clientCode.slice(at)
  const used = new Set([...body.matchAll(/t\('(bindings\.[A-Za-z]+)'/g)].map((m) => m[1]))
  assert.ok(used.size >= 20, `SoulBindings 里抓到的 bindings.* 键数偏少：${used.size}`)
  for (const key of used) {
    assert.ok(zhKeys.has(key), `zh 词典缺键 ${key}（真机上会直接显示原始 key）`)
    assert.ok(enKeys.has(key), `en 词典缺键 ${key}（英文界面下会漏出中文或原始 key）`)
  }
  // 带占位符的文案要两种语言都带同样的占位符，否则某种语言下 {} 会原样打出来
  for (const key of ['bindings.bound', 'bindings.unbound', 'bindings.count', 'bindings.moreSessions', 'bindings.invalid']) {
    const slot = (text) => {
      const line = text.split('\n').find((l) => l.trim().startsWith(`'${key}':`))
      assert.ok(line, `${key} 应存在`)
      return [...line.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    }
    assert.deepEqual(slot(zhText), slot(enText), `${key} 的占位符在 zh / en 必须一致`)
  }
})

check('工作区绑定：组件用到的 class 都有 CSS 规则', () => {
  // 只抓「组件自己命名」的 soul-bindings-* / .soul-bindings，复用宿主式既有 class 的不算
  const at = clientCode.indexOf('function SoulBindings(props)')
  const body = clientCode.slice(at)
  const classes = new Set(
    [...body.matchAll(/className: '([^']+)'/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((c) => c === 'soul-bindings' || c.startsWith('soul-bindings-'))
  )
  assert.ok(classes.size >= 10, `抓到的绑定专属 class 数偏少：${classes.size}`)
  for (const cls of classes) {
    // 选择器可以出现在规则开头，也可以在一个**组合**选择器里（`.a,.b{`）——
    // 只认行首会把「与既有按钮共用一条描边规则」误判成「没有样式」
    assert.match(
      clientCode,
      new RegExp(`'\\.${cls}[{,:\\[ ]|,\\.${cls}[{,:\\[ ]`),
      `class .${cls} 没有样式规则（会渲染成裸 HTML）`
    )
  }
})

// 「断言数一致」与「每一项真的通过」是两回事：前者只防脚本与声明漂移，
// 后者才是校验本身。check() 里捕获的任何异常都必须让整体失败 —— 否则失败的
// check 只打印一行 ✗ 却仍退出 0，这正是「看起来绿、实际没守住」的形态。
if (failures.length > 0) {
  console.log(`\n结果：失败（${failures.length} 项未通过）。`)
  process.exit(1)
}
if (!assertCount('verify-config', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
