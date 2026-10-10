// scripts/verify-config.mjs — 配置层纯函数自检（npm run verify）
//
// 覆盖 lib/config.mjs 的 migrateConfig / sanitizeConfig：
//   - 旧版本 style+tone 迁移、废弃字段清理、特质脏数据回退
//   - 白名单 / 类型 / 长度 / 枚举校验的接受与拒绝路径
// 覆盖 lib/personas.mjs 的内置人设与合并 / 匹配语义（含「应用后必须命中自己」闭环）。
// 另含清单契约自检：插件图标（DSH 在 app-boot 的 iconOf 中判定）、前后端契约一致性。
// 零依赖，直接 `node scripts/verify-config.mjs` 运行。

import assert from 'node:assert/strict'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  FIELD_LIMITS,
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
import { assertCount } from './lib/skip-report.mjs'

// 基线运行应跑出的断言数。跑完时校验，防止「脚本加/删用例」与文档口径悄悄脱节。
//
// 注意：本脚本没有环境相关的跳过分支（只读仓库内的文件与纯函数，不依赖浏览器 / DSH /
// 平台能力），所以链里的 `--strict` 对它是空操作 —— 这是**事实描述**，不是缺陷。
// 它的数字由这里的 assertCount 守住；需要 --strict 的是那些有跳过能力的脚本。
const EXPECTED_ASSERTIONS = 80

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
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

// 从 index.mjs 的 PROMPT_TEXT 中按缩进切片取出某个文案子表（zh / en 各一处）。
// 用「块数量必须为 2」做结构断言：文案表若被重构或改名，这里会直接失败而不是静默放过。
function promptTextBlocks(key) {
  const re = new RegExp(`\\n    ${key}: \\{\\n([\\s\\S]*?)\\n    \\\},`, 'g')
  return [...indexSource.matchAll(re)].map((m) => m[1])
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
  const snapshot = indexSource.match(/function personaSnapshotOf\(config\) \{([\s\S]*?)\n\}/)
  assert.ok(snapshot, '缺少 personaSnapshotOf')
  assert.ok(/for \(const key of PERSONA_FIELDS\)/.test(snapshot[1]), '快照必须按 PERSONA_FIELDS 取键')
  const pick = indexSource.match(/function pickPersonaValues\(persona\) \{([\s\S]*?)\n\}/)
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

check('客户端摘要的默认值表与宿主 DEFAULT_CONFIG 逐项一致', () => {
  const block = clientSource.match(/const META_FIELD_DEFAULTS = \{([\s\S]*?)\}/)
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
  const block = clientSource.match(/const META_FIELD_VALUES = \{([\s\S]*?)\}/)
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
  assert.ok(
    /builtin && e\('span', \{ className: 'soul-persona-badge' \}/.test(clientSource),
    '内置标记未渲染'
  )
  assert.ok(/!builtin && e\('button'/.test(clientSource), '删除按钮未被 builtin 条件包裹')
})

check('客户端预设行摘要不读「关于你」', () => {
  // 行摘要显示「这个预设会改变什么」。身份字段已不属于预设，摘要再显示昵称就会
  // 与「应用它不会动昵称」自相矛盾。
  const block = clientSource.match(/const personaRowMeta = \(entry\) => \{([\s\S]*?)return parts\.join/)
  assert.ok(block, '缺少 personaRowMeta')
  for (const key of PROFILE_FIELDS) {
    assert.equal(block[1].includes(`row.${key}`), false, `预设行摘要不应读取 ${key}`)
  }
  // 反向防空过：摘要仍要读人设维度，否则「不读身份字段」会因为整个函数被掏空而假通过
  assert.ok(/row\.style/.test(block[1]), '预设行摘要仍应读 style')
})

check('服务端四条写路径都拒绝内置名，读取路径都走合并库', () => {
  // HTTP 保存 / 删除各一处，/soul 命令的 save / del 各一处
  const rejections = indexSource.split('isBuiltinPersona(personaName)').length - 1
  assert.equal(rejections, 4, `内置名拒绝点应为 4 处（HTTP 与命令层各 2），实际 ${rejections} 处`)
  assert.ok(indexSource.split('mergePersonas(').length - 1 >= 3, '预设库读取应统一走 mergePersonas')
  assert.ok(/resolvePersona\(personaName, config\.personas\)/.test(indexSource), '命令层 use 未走 resolvePersona')
  assert.ok(/resolvePersona\(personaName, current\.personas\)/.test(indexSource), 'HTTP use 未走 resolvePersona')
})

check('匹配逻辑只在纯模块实现一份（不留本地重复实现）', () => {
  assert.equal(
    indexSource.includes('function declaredPersonaKeys'),
    false,
    'index.mjs 不应自带 declaredPersonaKeys——已下沉到 lib/personas.mjs，两份实现会漂移'
  )
  assert.ok(/personaMatches\(/.test(indexSource), 'index.mjs 应调用 personaMatches 做 ★ 判定')
})

// ---------- 提示词预览（草稿编译）----------

// 抽出参与提示词编译的全部函数源码：compilePrompt 及其两个子构建器。
// 只扫部分函数会漏掉字段，故三者一起扫。
function promptCompilerSource() {
  const chunks = []
  for (const name of ['buildUserProfile', 'buildBehavior', 'compilePrompt']) {
    const matched = indexSource.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`))
    assert.ok(matched, `index.mjs 中找不到函数 ${name}`)
    chunks.push(matched[0])
  }
  return chunks.join('\n')
}

check('草稿预览端点复用保存路径的校验与编译，且不落盘、不注入', () => {
  const matched = indexSource.match(/path: '\/api\/soul\/prompt\/preview'[\s\S]*?\n    \}\)/)
  assert.ok(matched, '缺少 /api/soul/prompt/preview 端点')
  const body = matched[0]
  assert.ok(/sanitizeConfig\(parsed\.body\)/.test(body), '草稿预览未复用 sanitizeConfig（未校验的草稿会编出误导性提示词）')
  assert.ok(/compilePrompt\(draft\)/.test(body), '草稿预览未调用 compilePrompt')
  assert.ok(/req\.method !== 'POST'/.test(body), '草稿预览应限制为 POST')
  assert.equal(/saveConfig\(/.test(body), false, '草稿预览不得落盘（不应调用 saveConfig）')
  assert.equal(/refreshPromptAndInject\(/.test(body), false, '草稿预览不得注入会话（不应调用 refreshPromptAndInject）')
})

check('客户端「参与编译的字段」与宿主 compilePrompt 实际读取的字段一致', () => {
  const block = clientSource.match(/const PROMPT_FIELD_KEYS = \[([\s\S]*?)\]/)
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

check('客户端在有未保存编辑时预览草稿，否则预览已生效提示词', () => {
  assert.ok(/async previewPrompt\(draft\)/.test(clientSource), '控制器缺少 previewPrompt')
  assert.ok(/await controller\.previewPrompt\(promptDraft\(\)\)/.test(clientSource), '未调用草稿预览端点')
  assert.ok(/const promptDirty = PROMPT_FIELD_KEYS\.some\(/.test(clientSource), 'promptDirty 应由 PROMPT_FIELD_KEYS 判定（改光轨不该让预览变成草稿）')
  // 只断言下面的三元语法不够：把 asDraft 写死成 false 也能让三元看起来「正确」，
  // 但预览就永远只看已生效内容了。必须把「草稿判定来源于 promptDirty」这一环钉住。
  assert.ok(/const asDraft = promptDirty\b/.test(clientSource), 'asDraft 必须取自 promptDirty，否则预览会永远停留在已生效内容')
  assert.ok(/asDraft\s*\?\s*await controller\.previewPrompt/.test(clientSource), '草稿分支未按 asDraft 选择端点')
})

check('提示词预览的编译入口唯一（避免重复请求与过期闭包）', () => {
  assert.equal(
    clientSource.includes('if (showPrompt) await loadPrompt()'),
    false,
    '保存/重置/应用预设处理器内不应再直接编译预览——刷新统一由 effect 驱动，两处调用会重复请求并可能用到过期闭包'
  )
  const effect = clientSource.match(
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
  const anchor = indexSource.indexOf("name: 'soul:persona'")
  assert.ok(anchor >= 0, '找不到 soul:persona 的 section 注册')
  const region = indexSource.slice(anchor, anchor + 1500)
  assert.ok(
    /interpolate:\s*false/.test(region),
    'section 必须显式写 interpolate: false —— 宿主默认开启且是严格模式，' +
      '用户只要在「自定义指令」里写出一对完整的 {{...}} 就会让 renderPrompt 抛错；' +
      '该错位于 agent.step() 开头且无 try/catch ⇒ 该会话每一轮都失败'
  )
  assert.equal(/interpolate:\s*true/.test(region), false, 'interpolate 不得为 true')
})

// ---------- 配置持久化（原子写 / 损坏不覆盖）----------

const storeSource = readFileSync(new URL('../lib/store.mjs', import.meta.url), 'utf8')

check('配置读取区分「文件不存在」与「文件损坏」，失败时不缓存', () => {
  const matched = indexSource.match(/async function loadConfig\(\)[\s\S]*?\n\}/)
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
    /function configWriteRefusal|function describeConfigFailure/.test(indexSource),
    false,
    'index.mjs 不应自带失败说明 / 拒绝判定的实现——写入路径有四条，本地再写一份必然漂移'
  )
  assert.ok(
    /configWriteRefusal\(configLoadFailure, configPath\(\)\)/.test(indexSource),
    'saveConfig 应调用 configWriteRefusal 决定是否拒绝写入'
  )
})

check('配置写入只有一条路径：lib/store.mjs 的「临时文件 + rename」', () => {
  assert.equal(
    /from 'node:fs\/promises'/.test(indexSource),
    false,
    'index.mjs 不应直接操作文件系统——原子写必须收口在 lib/store.mjs，否则会被绕过'
  )
  assert.ok(/await writeConfigFile\(configPath\(\), clean\)/.test(indexSource), 'saveConfig 应经由 writeConfigFile 写入')
  assert.ok(
    /writeFile\(tmpPath[\s\S]*?rename\(tmpPath, filePath\)/.test(storeSource),
    'lib/store.mjs 的写入必须是「先写 .tmp、再 rename 覆盖」；直接 writeFile 会在中断时留下截断的 JSON'
  )
})

check('配置损坏时上报原因（设置页不必等一次失败的保存才知道）', () => {
  assert.ok(
    /configError: configLoadFailure \? describeConfigFailure\(configLoadFailure\) : null/.test(indexSource),
    'GET /api/soul/config 应带回 configError，否则用户只会看到「人设无故被重置」'
  )
  assert.ok(
    /s\.error = typeof payload\.configError === 'string'[\s\S]{0,120}?typeof payload\.deliveryWarning === 'string'/.test(clientSource),
    '客户端应同时展示 configError（读不出来）与 deliveryWarning（送不到会话）——两者症状相同、处理方式不同'
  )
})

// ---------- 损坏配置的逃生口（重置）----------

check('移除损坏配置只有一条实现：lib/store.mjs 的 moveAsideConfigFile', () => {
  assert.ok(
    /export async function moveAsideConfigFile\(filePath\)[\s\S]*?await rename\(filePath, target\)/.test(storeSource),
    '必须用 rename 把损坏文件移开——只 copyFile 保留原文件的话，读取仍判定为损坏，重置依然被拒'
  )
  assert.equal(
    /rename\(configPath\(\)|unlink\(configPath\(\)/.test(indexSource),
    false,
    'index.mjs 不应自己搬移/删除配置文件，收口在 lib/store.mjs'
  )
})

check('重置是配置损坏时的逃生口：先移开损坏文件，再复用同一条写入路径', () => {
  const matched = indexSource.match(/async function resetConfigWithEscape\(\)[\s\S]*?\n\}/)
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
  const route = indexSource.match(/path: '\/api\/soul\/config\/reset'[\s\S]*?\n    \}\)/)
  assert.ok(route, '找不到 /api/soul/config/reset 端点')
  assert.ok(/resetConfigWithEscape\(\)/.test(route[0]), 'HTTP 重置必须走逃生口')
  assert.ok(/backupPath/.test(route[0]), 'HTTP 重置应回传备份路径，供界面如实说明数据去哪了')

  const resetBranch = indexSource.match(/if \(first === 'reset'\)[\s\S]*?\n          \}/)
  assert.ok(resetBranch, "找不到 /soul reset 分支")
  assert.ok(/resetConfigWithEscape\(\)/.test(resetBranch[0]), '/soul reset 必须走逃生口')
  assert.ok(/backupPath/.test(resetBranch[0]), '/soul reset 应告知备份位置')

  assert.equal(
    /commitConfig\(current => defaultConfigPreservingPersonas\(current\)\)/.test(indexSource),
    false,
    '不得再有绕过逃生口的重置路径——否则损坏状态下会走到一条必然失败的写'
  )
})

check('重置失败不得被报成成功', () => {
  const handler = clientSource.match(/const handleReset = async \(\) => \{[\s\S]*?\n      \}/)
  assert.ok(handler, '找不到客户端的 handleReset')
  assert.ok(/if \(!payload\)/.test(handler[0]), 'handleReset 必须区分失败（resetConfig 失败时返回 undefined）')
  assert.ok(/toast\.resetFailed/.test(handler[0]), '失败时应用失败提示，而不是无条件报「已重置」')
  assert.ok(/payload\.backupPath/.test(handler[0]), '有备份时应提示「已备份」，避免用户以为数据凭空消失')
})

// ---------- 配置生效链路的可观测性 ----------

check('注入失败必须留下可观测记录，不得静默返回', () => {
  const matched = indexSource.match(/function injectPromptToAllAgents\(ctx, config\)[\s\S]*?\n\}/)
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
  const matched = indexSource.match(/path: '\/api\/soul\/status'[\s\S]*?\n    \}\)/)
  assert.ok(matched, '应注册 GET /api/soul/status')
  const body = matched[0]
  assert.ok(/channels:/.test(body), '应分别报告两条通道')
  assert.ok(/section:/.test(body) && /injection/.test(body), 'section 与 injection 都要有')
  assert.ok(/sectionRegisteredAt/.test(indexSource), 'section 的注册状态必须被记录')
})

check('「送不到会话」与「读不出来」是两种问题，分开上报', () => {
  assert.ok(
    /deliveryWarning: deliveryProblemText\(config\)/.test(indexSource),
    'GET /api/soul/config 应带回 deliveryWarning'
  )
  assert.ok(
    /deliveryWarning: deliveryProblemText\(updated\)/.test(indexSource),
    'POST /api/soul/config 也应带回——保存成功但送不到会话时要让用户看见'
  )
  assert.ok(/deliveryProblemText\(config\)/.test(indexSource), '/soul show 应展示送达状态')
  assert.ok(/t\.deliveryLabel/.test(indexSource), '/soul show 应带「送达」标签行')
})

check('版本号不新增需手工同步的常量（唯一来源 package.json）', () => {
  assert.ok(
    /createRequire\(import\.meta\.url\)\('\.\/package\.json'\)\.version/.test(indexSource),
    'host 端版本应直接取自 package.json'
  )
  assert.equal(
    /const\s+(PLUGIN_)?VERSION\s*=\s*'0\./.test(indexSource),
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
  for (const { file } of [...chain, ...strict]) {
    const url = new URL(`../scripts/${file}`, import.meta.url)
    assert.ok(existsSync(url), `package.json 引用了不存在的脚本：${file}`)
    const src = readFileSync(url, 'utf8')
    // 光在 package.json 里写上 `--strict` 是不够的 —— 脚本必须真的实现那套语义：
    //   ① 引入 skip-report（跳过与断言数的唯一实现）；
    //   ② 把「本脚本有多少断言」交给它：跑完时 `assertCount` 精确校验，或像
    //      verify-compat 那样把 **nominal**（随环境浮动的检查数）交给 `skipExit`。
    //      两者取其一 —— compat 的检查数本身取决于本机装了什么，精确相等不适用。
    // 本版之前 verify-config / verify-store 两条都不满足，于是链里的 `--strict`
    // 对它们纯属装饰、数字也没人守 —— 这条断言就是为了让那种状态跑不起来。
    assert.ok(
      // 必须是一条**真正的 import 语句**，不能只在注释里出现这段路径 —— 否则把 import
      // 注掉、留下一行注释，这条断言照样通过（判断力对照实测过这个漏法）。
      /^\s*import\b[^\n]*from '\.\/lib\/skip-report\.mjs'/m.test(src),
      `${file} 必须真正 import ./lib/skip-report.mjs，否则跳过语义与断言数都无人守`
    )
    assert.ok(
      /\bassertCount\(/.test(src) || /NOMINAL_ASSERTIONS/.test(src),
      `${file} 必须把断言数交给 skip-report（assertCount 精确校验，或 NOMINAL_ASSERTIONS 供 skipExit 报告）`
    )
    assert.equal(
      /process\.argv\.includes\('--strict'\)/.test(src),
      false,
      `${file} 不得自己解析 --strict（必须走 skip-report 的 strictMode()，否则两处判定会漂移）`
    )
  }
})

if (!assertCount('verify-config', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
