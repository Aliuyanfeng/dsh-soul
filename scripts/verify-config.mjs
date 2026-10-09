// scripts/verify-config.mjs — 配置层纯函数自检（npm run verify）
//
// 覆盖 lib/config.mjs 的 migrateConfig / sanitizeConfig：
//   - 旧版本 style+tone 迁移、废弃字段清理、特质脏数据回退
//   - 白名单 / 类型 / 长度 / 枚举校验的接受与拒绝路径
// 覆盖 lib/personas.mjs 的内置人设与合并 / 匹配语义（含「应用后必须命中自己」闭环）。
// 另含清单契约自检：插件图标（DSH 在 app-boot 的 iconOf 中判定）、前后端契约一致性。
// 零依赖，直接 `node scripts/verify-config.mjs` 运行。

import assert from 'node:assert/strict'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_CONFIG,
  FIELD_LIMITS,
  PERSONA_FIELDS,
  PERSONA_NAME_MAX,
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

let passed = 0
function check(name, fn) {
  fn()
  passed++
  console.log(`  ✓ ${name}`)
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

check('内置人设不声明用户自有信息、输出语言与总开关', () => {
  // nickname / occupation / bio 是「关于你」的用户资料，预设去写它们等于把用户
  // 的昵称职业清空；language 属于用户偏好，写死会让另一种语言的用户被强行切回；
  // enabled 是总开关，预设不该能替你关掉个性化。
  for (const name of builtinPersonaNames()) {
    for (const key of ['nickname', 'occupation', 'bio', 'language', 'enabled']) {
      assert.equal(key in BUILTIN_PERSONAS[name], false, `${name} 不应声明 ${key}`)
    }
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

  const driven = new Set(['enabled', ...PERSONA_FIELDS])
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

console.log(`\n全部通过：${passed} 项检查`)
