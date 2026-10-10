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
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  DEFAULT_CONFIG,
  FIELD_LIMITS,
  LANGUAGE_VALUES,
  PERSONA_FIELDS,
  PERSONA_NAME_MAX,
  PROFILE_FIELDS,
  PROMPT_INPUT_FIELDS,
  REPLY_LENGTH_VALUES,
  STYLE_VALUES,
  TRAIT_VALUES,
  migrateConfig,
  normalizePersonas,
  sanitizeConfig,
  sanitizePersonaName
} from '../lib/config.mjs'
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
const EXPECTED_ASSERTIONS = 91

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

check('内置人设只声明 PERSONA_FIELDS 内的键', () => {
  for (const name of builtinPersonaNames()) {
    for (const key of Object.keys(BUILTIN_PERSONAS[name])) {
      assert.ok(PERSONA_FIELDS.includes(key), `${name} 含非人设字段：${key}`)
    }
  }
})

check('内置人设不声明「关于你」、输出语言与总开关', () => {
  // 「关于你」的三个字段根本不在 PERSONA_FIELDS 里（见下面「预设范围」一组），这里
  // 另外钉住内置数据本身也不写；language 在预设范围内，但内置是给任何语言用户共用的
  // 通用人格，写死会让另一种语言的用户应用一次就被强行切回；enabled 是总开关，
  // 预设不该能替你关掉个性化。
  for (const name of builtinPersonaNames()) {
    for (const key of [...PROFILE_FIELDS, 'language', 'enabled']) {
      assert.equal(key in BUILTIN_PERSONAS[name], false, `${name} 不应声明 ${key}`)
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
  for (const name of builtinPersonaNames()) {
    const entry = BUILTIN_PERSONAS[name]
    for (const [field, allowed] of Object.entries(enums)) {
      if (!(field in entry)) continue
      assert.ok(allowed.includes(entry[field]), `${name}.${field} 非法取值：${entry[field]}`)
    }
    // customInstructions 是人格差异的主要载体：枚举字段只能表达「更啰嗦 / 更简洁」
    // 这类粗粒度倾向，所以内置预设必须有它。
    assert.equal(typeof entry.customInstructions, 'string', `${name} 缺少 customInstructions`)
    assert.ok(entry.customInstructions.length > 0, `${name} 的 customInstructions 为空`)
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
  assert.deepEqual(resolvePersona(names[0], {}), BUILTIN_PERSONAS[names[0]])
  // 内置名即使磁盘上有同名条目也应解析到内置内容
  assert.deepEqual(resolvePersona(names[0], { [names[0]]: { style: 'roast' } }), BUILTIN_PERSONAS[names[0]])
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

check('客户端内置预设行不渲染删除按钮，改为「内置」标记', () => {
  // 徽标渲染在名称列（紧跟名称），不是操作区 —— 放操作区会把「使用」挤出竖列。
  // 定界必须用括号配平（extractCall），不能用缩进/固定窗口：曾用 `\s{22}` 猜终点，
  // 而真实闭合是 24 空格 ⇒ 捕获一路吞掉摘要列与操作区，「徽标在名称列」退化成
  // 「徽标在这一行里」，把徽标挪到摘要列也能通过（变异实验实测，H4）。
  const nameCell = extractCall(clientSource, "e('span', { className: 'soul-persona-name' }")
  assert.ok(nameCell !== '', '找不到名称列渲染块')
  assert.ok(
    /soul-persona-badge/.test(nameCell),
    '内置标记未渲染在名称列（放操作区会让两类行的「使用」不同列）'
  )
  // 名称列不得包含摘要/操作区内容 —— 防止定界再次失效而不自知
  assert.ok(
    !nameCell.includes('soul-persona-meta') && !nameCell.includes('soul-persona-actions'),
    '名称列的捕获范围越界（定界用括号配平，不得吞入 meta/actions）'
  )
  // 徽标不得出现在操作区块里
  const actionsCell = extractCall(clientSource, "e('span', { className: 'soul-persona-actions' }")
  assert.ok(actionsCell !== '', '找不到操作区渲染块')
  assert.equal(
    /soul-persona-badge/.test(actionsCell),
    false,
    '徽标不应出现在操作区（会占掉「使用」的列位）'
  )
  // 徽标也不得出现在摘要列（把徽标挪进 meta 同样破坏对齐前提）
  const metaCell = extractCall(clientSource, "e('span', { className: 'soul-persona-meta' }")
  assert.ok(metaCell !== '', '找不到摘要列渲染块')
  assert.equal(
    /soul-persona-badge/.test(metaCell),
    false,
    '徽标不应出现在摘要列（对齐断言的前提是徽标独占名称列）'
  )
  // 内置行在操作区第 2 轨放空占位（span，非按钮），自建行才是删除按钮：
  // 这正是两类行「使用」按钮能严格同列的原因。
  assert.ok(
    /builtin\s*\?\s*e\('span', \{ className: 'soul-persona-slot'/.test(clientCode),
    '内置行缺少操作区空占位（会导致「使用」与自建行不同列）'
  )
  assert.ok(
    /e\('button', \{ type: 'button', className: 'soul-prompt-link soul-persona-danger'/.test(stripComments(clientSource)),
    '删除按钮未渲染'
  )
  // 空占位必须是 span 而不是 button —— 否则会造出一个点了没反应的控件
  assert.equal(
    /soul-persona-slot'[^)]*\}\s*,\s*\{[^}]*onClick/.test(clientCode),
    false,
    '空占位不应是可点控件'
  )
})

check('客户端人设行用网格布局保证「使用」按钮跨行同列', () => {
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const row = cssBlock.match(/\.soul-persona-row\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/display:grid/.test(row), '人设行应使用网格布局（flex 下按钮列会随内容错位）')
  const actions = cssBlock.match(/\.soul-persona-actions\{([^}]*)\}/)?.[1] ?? ''
  assert.ok(/display:grid/.test(actions), '操作区应是网格（两条固定轨道）')
  // 轨道必须两端等宽：`auto`/`minmax()` 会按各自内容算宽，内置行第 2 轨为空 ⇒ 两行不同列
  assert.ok(
    /grid-template-columns:1fr 1fr/.test(actions),
    '操作区两条轨道必须等宽固定，否则内置行（第 2 轨为空）与自建行的「使用」不同列'
  )
  assert.ok(/width:\s*\d/.test(actions), '操作区需要固定宽度，跨行几何才会一致')
})

check('客户端的动效尊重 prefers-reduced-motion（含提示条）', () => {
  const cssBlock = clientCode.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
  const reduced = cssBlock.match(/@media \(prefers-reduced-motion:reduce\)\{([\s\S]*?)\}\}/g) ?? []
  assert.ok(reduced.length > 0, '客户端没有任何 prefers-reduced-motion 规则')
  const all = reduced.join('')
  // 三处会动的元素都必须在 reduced-motion 下停：光轨层、快捷开关圆点、提示条。
  // 提示条此前被漏掉 —— 它用的是**内联** animation，只查样式表容易漏看。
  for (const [needle, why] of [
    ['.soul-trail-layer', '光轨流动'],
    ['.soul-quick-toggle', '快捷开关圆点的脉冲'],
    ['.soul-toast', '保存/失败提示条的淡出']
  ]) {
    assert.ok(all.includes(needle), `prefers-reduced-motion 未覆盖 ${needle}（${why}）`)
  }
  // 提示条那条要能压过内联声明（实测：普通声明也有效，但 !important 更稳）
  const toastRule = (all.match(/\.soul-toast\{[^}]*\}/) ?? [''])[0]
  assert.ok(/animation:none/.test(toastRule), '提示条在 reduced-motion 下必须 animation:none')
})

check('客户端预设行摘要不读「关于你」', () => {
  // 行摘要显示「这个预设会改变什么」。身份字段已不属于预设，摘要再显示昵称就会
  // 与「应用它不会动昵称」自相矛盾。
  const block = clientCode.match(/const personaRowMeta = \(entry\) => \{([\s\S]*?)return parts\.join/)
  assert.ok(block, '缺少 personaRowMeta')
  for (const key of PROFILE_FIELDS) {
    assert.equal(block[1].includes(`row.${key}`), false, `预设行摘要不应读取 ${key}`)
  }
  // 反向防空过：摘要仍要读人设维度，否则「不读身份字段」会因为整个函数被掏空而假通过
  assert.ok(/row\.style/.test(block[1]), '预设行摘要仍应读 style')
})

check('服务端四条写路径都拒绝内置名，读取路径都走合并库', () => {
  // HTTP 保存 / 删除各一处，/soul 命令的 save / del 各一处
  const rejections = indexCode.split('isBuiltinPersona(personaName)').length - 1
  assert.equal(rejections, 4, `内置名拒绝点应为 4 处（HTTP 与命令层各 2），实际 ${rejections} 处`)
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
  const m = clientCode.match(/const FIELD_KEYS = \[([^\]]*)\]/)
  assert.ok(m, '客户端缺少 FIELD_KEYS')
  const clientKeys = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1])
  const hostFields = Object.keys(DEFAULT_CONFIG).sort()
  assert.deepEqual(
    [...clientKeys].sort(),
    hostFields,
    'FIELD_KEYS 必须与宿主 DEFAULT_CONFIG 的字段集合完全相同（漏字段会让 dirty 检测失效）'
  )
  // 顺序无关紧要但重复有害：同一字段出现两次会让 dirty 判定重复计算。
  assert.equal(new Set(clientKeys).size, clientKeys.length, 'FIELD_KEYS 含重复字段')
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
    // 从真实源码抽出 output.schema 的字面量并求值，保证测的就是插件里那份
    const literal = outputSchema.slice(outputSchema.indexOf('schema: {'))
    const open = literal.indexOf('{')
    let depth = 0
    let quote = null
    let end = -1
    for (let i = open; i < literal.length; i++) {
      const c = literal[i]
      if (quote) {
        if (c === '\\') { i++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    assert.ok(end > 0, '无法从 index.mjs 抽出 output.schema 字面量')
    let schema
    try {
      schema = new Function(`return (${literal.slice(open, end)})`)()
    } catch (err) {
      assert.fail(`output.schema 字面量求值失败：${err.message}`)
    }
    assert.doesNotThrow(
      () => defineTool({
        name: 'set_persona',
        description: 'verify-config schema 契约探针',
        parameters: { nickname: { type: 'string', description: 'probe' } },
        output: { schema },
        async execute() { return { ok: true } }
      }),
      '真实 dsh-tools 的 defineTool 拒绝了 set_persona 的输出 schema（工具将静默注册失败）'
    )
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
  const matched = indexCode.match(/async function resetConfigWithEscape\(\)[\s\S]*?\n\}/)
  assert.ok(matched, 'index.mjs 中找不到 resetConfigWithEscape')
  const body = matched[0]
  assert.ok(/moveAsideConfigFile\(configPath\(\)\)/.test(body), '重置应先移开损坏文件（＝备份到 .corrupt）')
  assert.ok(/configLoadFailure = null/.test(body), '移开之后必须清掉失败标记，否则 saveConfig 仍会拒绝')
  assert.ok(/commitConfig\(/.test(body), '重置应复用 commitConfig，而不是另写一份「读—改—写」')
  assert.ok(
    /catch[\s\S]*?configLoadFailure = failure[\s\S]*?throw/.test(body),
    '写入失败必须恢复失败标记，否则会把「文件仍然不可用」误报成正常'
  )
})

check('两个重置入口都走逃生口（HTTP 与斜杠命令）', () => {
  const route = indexCode.match(/path: '\/api\/soul\/config\/reset'[\s\S]*?\n    \}\)/)
  assert.ok(route, '找不到 /api/soul/config/reset 端点')
  assert.ok(/resetConfigWithEscape\(\)/.test(route[0]), 'HTTP 重置必须走逃生口')
  assert.ok(/backupPath/.test(route[0]), 'HTTP 重置应回传备份路径，供界面如实说明数据去哪了')

  const resetBranch = indexCode.match(/if \(first === 'reset'\)[\s\S]*?\n          \}/)
  assert.ok(resetBranch, "找不到 /soul reset 分支")
  assert.ok(/resetConfigWithEscape\(\)/.test(resetBranch[0]), '/soul reset 必须走逃生口')
  assert.ok(/backupPath/.test(resetBranch[0]), '/soul reset 应告知备份位置')

  assert.equal(
    /commitConfig\(current => defaultConfigPreservingPersonas\(current\)\)/.test(indexCode),
    false,
    '不得再有绕过逃生口的重置路径——否则损坏状态下会走到一条必然失败的写'
  )
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

// 「断言数一致」与「每一项真的通过」是两回事：前者只防脚本与声明漂移，
// 后者才是校验本身。check() 里捕获的任何异常都必须让整体失败 —— 否则失败的
// check 只打印一行 ✗ 却仍退出 0，这正是「看起来绿、实际没守住」的形态。
if (failures.length > 0) {
  console.log(`\n结果：失败（${failures.length} 项未通过）。`)
  process.exit(1)
}
if (!assertCount('verify-config', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
