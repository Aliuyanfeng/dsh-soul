// scripts/verify-subagent-scope.mjs — 子代理的人设继承开关（0.13.0）
//
// 为什么需要它：这一层的失效是**静默的** —— 子代理悄悄继承了主代理的人设，
// 用户只会觉得「它说话怪怪的」，不会报错。反过来，开关写错方向会让「明明开了继承，
// 子代理却没有性格」，同样不报错。所以这里把四条硬约束逐条钉死：
//   1. 默认继承（= 与旧行为一致，升级不静默改变）；
//   2. 关闭继承时基线全空：全局人设、工作区绑定、关于你都不许漏进子代理；
//   3. 关闭继承后只有两处显式来源：全局「子代理默认人设」+ 该会话自己的覆盖；
//   4. 预设被删不回退到全局（回退等于让子代理突然继承）。
//
// 零依赖，直接 node scripts/verify-subagent-scope.mjs 运行。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'
import { DEFAULT_CONFIG, PERSONA_FIELDS, PROFILE_FIELDS, PROMPT_INPUT_FIELDS, sanitizeConfig } from '../lib/config.mjs'
import {
  SUBAGENT_NEUTRAL_CONFIG,
  declaredPersonaFields,
  hasSubagentPersona,
  isSubagentAgent,
  isSubagentHeader,
  resolveSubagentConfig,
  subagentInheritsPersona,
  subagentPersonaNameOf
} from '../lib/subagent-scope.mjs'

const EXPECTED_ASSERTIONS = 33
const HERE = dirname(fileURLToPath(import.meta.url))
const INDEX_PATH = join(HERE, '..', 'index.mjs')

let passed = 0
async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    error.message = '【' + name + '】' + error.message
    error.stack = '【' + name + '】' + error.stack
    throw error
  }
  passed += 1
  console.log('  ✓ ' + name)
}

const PERSONA_KEYS = [...PROFILE_FIELDS, ...PERSONA_FIELDS]
const indexSource = await readFile(INDEX_PATH, 'utf8')
const scopeSource = await readFile(join(HERE, '..', 'lib', 'subagent-scope.mjs'), 'utf8')

// ══════════════════ 判定口径 ══════════════════

await check('子代理判定：origin=subagent', () => {
  assert.equal(isSubagentHeader({ origin: 'subagent' }), true)
})

await check('子代理判定：delegationDepth > 0（嵌套子代理）', () => {
  assert.equal(isSubagentHeader({ delegationDepth: 1 }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 3, origin: undefined }), true)
})

await check('子代理判定：delegationDepth = 0 不算（那是主代理）', () => {
  assert.equal(isSubagentHeader({ delegationDepth: 0 }), false)
})

await check('子代理判定：fork 出来的会话不算子代理（仍继承）', () => {
  // fork 的 header 有 parentSession 但没有 origin/delegationDepth 标记 ——
  // 它是主代理的延续，应该继续用主代理的人设。
  assert.equal(isSubagentHeader({ id: 'x', cwd: '/w', parentSession: 'p', isSeeded: true }), false)
})

await check('子代理判定：脏输入一律 false，不抛错', () => {
  assert.equal(isSubagentHeader(null), false)
  assert.equal(isSubagentHeader(undefined), false)
  assert.equal(isSubagentHeader('subagent'), false)
})

await check('isSubagentAgent 从 agent.session.header 取判据', () => {
  assert.equal(isSubagentAgent({ session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagentAgent({ session: { header: { id: 'main' } } }), false)
  assert.equal(isSubagentAgent(undefined), false)
  assert.equal(isSubagentAgent({ session: null }), false)
})

// ══════════════════ 继承开关 ══════════════════

await check('默认继承：字段缺席时为 true（老配置升级不静默改变行为）', () => {
  assert.equal(DEFAULT_CONFIG.subagentInheritPersona, true)
  assert.equal(subagentInheritsPersona({}), true)
  assert.equal(subagentInheritsPersona(null), true)
})

await check('显式关闭继承才生效（!== false，不是 === true）', () => {
  assert.equal(subagentInheritsPersona({ subagentInheritPersona: false }), false)
  assert.equal(subagentInheritsPersona({ subagentInheritPersona: true }), true)
  // 这两个是旧配置 / 脏数据能造出的形态，都必须落到「继承」一侧
  assert.equal(subagentInheritsPersona({ subagentInheritPersona: undefined }), true)
  assert.equal(subagentInheritsPersona({ subagentInheritPersona: 0 }), true)
})

// ══════════════════ 中性基线 ══════════════════

await check('中性基线：每个参与编译的字段都为空（不只是关于你）', () => {
  for (const key of PERSONA_KEYS) {
    assert.equal(SUBAGENT_NEUTRAL_CONFIG[key], '', key + ' 必须为空，否则 DEFAULT_CONFIG 的 professional/zh 会自己长出人设')
  }
})

await check('中性基线：enabled 仍为 true（无人设 ≠ 关掉插件）', () => {
  assert.equal(SUBAGENT_NEUTRAL_CONFIG.enabled, true)
})

await check('中性基线：默认子代理人设为 null', () => {
  assert.equal(SUBAGENT_NEUTRAL_CONFIG.subagentPersona, null)
})

// ══════════════════ 关闭继承时的解析链 ══════════════════

const globalPersona = {
  ...DEFAULT_CONFIG,
  enabled: true,
  nickname: '小明',
  occupation: '工程师',
  bio: '写后端的',
  style: 'humorous',
  language: 'en',
  customInstructions: '你是一个搞笑的人',
  personas: {}
}

await check('关闭继承 + 无预设：source=subagent-default，配置全空', () => {
  const r = resolveSubagentConfig(globalPersona, null)
  assert.equal(r.source, 'subagent-default')
  assert.equal(r.personaName, null)
  assert.equal(r.personaMissing, false)
  for (const key of PERSONA_KEYS) assert.equal(r.config[key], '', key + ' 不许从全局漏进来')
})

await check('关闭继承：全局人设与「关于你」都不许继承', () => {
  const r = resolveSubagentConfig(globalPersona, null)
  assert.equal(r.config.nickname, '')
  assert.equal(r.config.style, '')
  assert.equal(r.config.customInstructions, '')
  // language 是**例外且必须继承** —— 见下一条
  assert.equal(r.config.language, 'en', 'language 必须继承全局，否则英文用户会收到中文提示词')
})

await check('language 继承全局（全局开关，不是角色特征）', () => {
  // 它是「用哪套提示词文案 + 要求模型说哪种语言」的全局开关：子代理不继承它，
  // 英文用户会拿到一整份中文提示词（实测过，不是假设）。它不是角色特征，所以
  // 也不在 PERSONA_FIELDS 里 —— 预设声明了 language 也不该覆盖它。
  assert.equal(resolveSubagentConfig({ ...globalPersona, language: 'zh' }, null).config.language, 'zh')
  assert.equal(resolveSubagentConfig({ ...globalPersona, language: 'en' }, null).config.language, 'en')
  const withPreset = resolveSubagentConfig({
    ...globalPersona,
    language: 'en',
    subagentPersona: '带语言的老预设',
    personas: { 带语言的老预设: { style: 'casual', language: 'zh' } }
  }, null)
  assert.equal(withPreset.config.language, 'en', '预设里的 language 必须被忽略（它已不在 PERSONA_FIELDS）')
  assert.equal(withPreset.config.style, 'casual', '样式仍应生效')
})

await check('关闭继承：enabled 仍跟随全局（关掉插件时子代理也无人设）', () => {
  const r = resolveSubagentConfig({ ...globalPersona, enabled: false }, null)
  assert.equal(r.config.enabled, false)
})

await check('无人设时身份层为空（语言那不算人设）', () => {
  // 这一条守的是「中性基线是否真的中性」—— 若哪天 buildBehavior 改成对空串兜底
  // 默认值，配置对象看起来还是空的，但编译出来的提示词会重新长出人设。
  const r = resolveSubagentConfig(globalPersona, null)
  assert.equal((r.config.customInstructions || '').trim(), '')
  // 「有没有人设」必须靠人设字段判断，不能看提示词是否为空 ——
  // language 会编出「用xx回答」一句，文本非空但人设确实为空。
  assert.equal(hasSubagentPersona(r.config), false)
  // 反向防空过：给一个风格就该算有人设
  assert.equal(hasSubagentPersona({ ...r.config, style: 'casual' }), true)
  assert.equal(hasSubagentPersona({ ...r.config, customInstructions: '只挑错' }), true)
  assert.equal(hasSubagentPersona({ ...r.config, language: 'en' }), false, 'language 不算人设')
})

await check('关闭继承：预设整卡生效（只取人设字段）', () => {
  const base = {
    ...globalPersona,
    subagentPersona: '严谨工程',
    personas: { 严谨工程: { style: 'efficient', replyLength: 'concise', builtin: false, updatedAt: 'x' } }
  }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.source, 'subagent-persona')
  assert.equal(r.personaName, '严谨工程')
  assert.equal(r.config.style, 'efficient')
  assert.equal(r.config.replyLength, 'concise')
})

await check('关闭继承：预设里的「关于你」被丢弃（子代理不继承用户画像）', () => {
  const base = {
    ...globalPersona,
    subagentPersona: '带资料的预设',
    personas: { 带资料的预设: { style: 'casual', nickname: '不该出现', occupation: '不该出现', bio: '不该出现' } }
  }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.config.nickname, '')
  assert.equal(r.config.occupation, '')
  assert.equal(r.config.bio, '')
  assert.equal(r.config.style, 'casual')
})

await check('关闭继承：预设被删不回退全局，只标记 personaMissing', () => {
  const base = { ...globalPersona, subagentPersona: '已删除的预设', personas: {} }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.personaMissing, true)
  assert.equal(r.personaName, null)
  assert.equal(r.source, 'subagent-default')
  // 关键：不回退 —— 否则「删预设」会让子代理突然变成全局性格
  assert.equal(r.config.style, '')
  assert.equal(r.config.customInstructions, '')
})

await check('关闭继承：会话覆盖压过预设（且只合并实际存在的键）', () => {
  const base = {
    ...globalPersona,
    subagentPersona: '严谨工程',
    personas: { 严谨工程: { style: 'efficient', replyLength: 'concise' } }
  }
  const r = resolveSubagentConfig(base, { customInstructions: '只挑错，不改写' })
  assert.equal(r.source, 'subagent-session')
  assert.equal(r.config.customInstructions, '只挑错，不改写')
  // 没被覆盖的字段仍来自预设，不被「缺失」抹成空
  assert.equal(r.config.style, 'efficient')
  assert.equal(r.config.replyLength, 'concise')
})

await check('subagentPersonaNameOf：非法值一律 null', () => {
  assert.equal(subagentPersonaNameOf({}), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: null }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '' }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '   ' }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: 123 }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: 'x'.repeat(80) }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '__proto__' }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '严谨工程' }), '严谨工程')
})

await check('declaredPersonaFields：丢弃元键与「关于你」', () => {
  const patch = declaredPersonaFields({
    style: 'casual',
    builtin: true,
    updatedAt: 'x',
    nickname: '不该出现',
    occupation: '不该出现',
    bio: '不该出现'
  })
  assert.equal(patch.style, 'casual')
  assert.equal(patch.builtin, undefined)
  assert.equal(patch.updatedAt, undefined)
  assert.equal(patch.nickname, undefined)
  assert.equal(patch.occupation, undefined)
  assert.equal(patch.bio, undefined)
})

// ══════════════════ 配置层 ══════════════════

await check('sanitizeConfig：继承开关只接受布尔', () => {
  assert.deepEqual(sanitizeConfig({ subagentInheritPersona: false }), { patch: { subagentInheritPersona: false }, errors: {} })
  const bad = sanitizeConfig({ subagentInheritPersona: 'yes' })
  assert.deepEqual(bad.patch, {})
  assert.ok(bad.errors.subagentInheritPersona)
})

await check('sanitizeConfig：默认人设名非法时报错，空串视为清除', () => {
  assert.deepEqual(sanitizeConfig({ subagentPersona: '' }), { patch: { subagentPersona: null }, errors: {} })
  assert.deepEqual(sanitizeConfig({ subagentPersona: null }), { patch: { subagentPersona: null }, errors: {} })
  const tooLong = sanitizeConfig({ subagentPersona: 'x'.repeat(80) })
  assert.deepEqual(tooLong.patch, {})
  assert.ok(tooLong.errors.subagentPersona)
  const wrongType = sanitizeConfig({ subagentPersona: 42 })
  assert.deepEqual(wrongType.patch, {})
  assert.ok(wrongType.errors.subagentPersona)
})

await check('PROMPT_INPUT_FIELDS：两个新字段都参与编译（改它们要重新注册 section）', () => {
  assert.ok(PROMPT_INPUT_FIELDS.includes('subagentInheritPersona'), '继承开关必须进 PROMPT_INPUT_FIELDS')
  assert.ok(PROMPT_INPUT_FIELDS.includes('subagentPersona'), '子代理默认人设必须进 PROMPT_INPUT_FIELDS')
})

// ══════════════════ 接线（源码形态）══════════════════

await check('预设只声明风格时，用预设名兜底身份层', () => {
  // 实测发现：预设若只声明 style/emoji（自建预设常见），模型只看到「务实高效」，
  // 不知道自己在扮演谁 —— 名字是唯一携带角色意图的东西，此前只用于查表与 ★ 标注。
  const m = indexSource.match(/function compileSubagentPrompt\(config(?:, personaName)?\) \{[\s\S]*?\n\}/)
  assert.ok(m, '缺少 compileSubagentPrompt')
  // 0.13.0：预设名进提示词前先过防伪处理（它会被原样嵌进「你正在扮演「${name}」」），
  // 所以兜底分支的变量名从 personaName 换成了 safePersonaName。
  assert.match(m[0], /authored \|\| \(safePersonaName \? T\.subagentIdentityHint\(safePersonaName\) : ''\)/, '必须有「预设名兜底」')
  assert.match(m[0], /sanitizePromptText\(personaName\)/, '预设名必须过防伪处理（否则可伪造段头）')
  // 反向：调用点必须把 personaName 传进去（否则兜底形同虚设）
  assert.match(indexSource, /compileSubagentPrompt\(resolved\.config, resolved\.personaName\)/, '调用点必须传 personaName')
})

await check('装配与注入共用同一个 resolvePromptForAgent（不许各写一份）', () => {
  const calls = indexSource.match(/resolvePromptForAgent\(/g) || []
  // 1 处定义 + 2 处调用（装配 section / 注入循环）
  assert.ok(calls.length >= 3, 'resolvePromptForAgent 应有定义 + 装配 + 注入三处引用，实际 ' + calls.length)
  assert.match(indexSource, /const resolved = resolvePromptForAgent\(\s*snap\.value/, '装配侧必须走统一入口')
  assert.match(indexSource, /const resolved = resolvePromptForAgent\(\s*config,/, '注入侧必须走统一入口')
})

await check('子代理提示词不含「执行规则」块（compilePrompt 才有）', () => {
  const m = indexSource.match(/function compileSubagentPrompt\(config(?:, personaName)?\) \{[\s\S]*?\n\}/)
  assert.ok(m, '缺少 compileSubagentPrompt')
  assert.equal(/rulesHeader|T\.rules\b/.test(m[0]), false, '子代理提示词不得包含执行规则块')
  // 反向：主代理那份必须有（证明上一条不是因为两处都删了）
  const main = indexSource.match(/function compilePrompt\(config\) \{[\s\S]*?\n\}/)
  assert.ok(main && /rulesHeader/.test(main[0]), '主代理 compilePrompt 应保留执行规则块')
})

await check('继承默认 true 的归一化必须是 !== false', () => {
  // 行为断言（上面「显式关闭继承才生效」）已经覆盖；这里再从源码形态上钉一次，
  // 防止有人把函数改写成 === true 却恰好被别的默认值掩盖。
  assert.match(scopeSource, /subagentInheritPersona === false/, '归一化应判 === false（等价于 !== false）')
  assert.equal(/subagentInheritPersona === true/.test(scopeSource), false, '写成 === true 会让缺失字段被判成关闭')
})

await check('子代理分岔条件本身必须存在（否则子代理会静默继承）', () => {
  // resolvePromptForAgent 内部未导出，行为层测不到它的分支条件 —— 这条守的是源码形态：
  // 必须是「是子代理 **且** 关闭了继承」才走中性基线；少任何一个条件，子代理就会
  // 落到底部的 configForScope（= 完整继承），而且不会有任何报错。
  assert.match(
    indexSource,
    /isSubagentAgent\(agent\)\s*&&\s*!subagentInheritsPersona\(base\)/,
    '子代理分岔必须是「是子代理 且 未开继承」'
  )
  // 反向：底部（继承开启 / 主代理）必须仍走 configForScope —— 证明上一条不是因为两边都删了
  assert.match(indexSource, /const resolved = configForScope\(base, cwdOfAgent\(agent\)/, '继承开启时必须走原三层解析')
})

await check('子代理调用 set_persona 只写自己的会话覆盖', () => {
  // ⚠️ 钉**完整条件**而不是变量名：初版只钉 /callerIsSubagent...writeSessionPersonaPatch/，
  // 变异实测（把条件换成 `false && ...`）**没被拦住** —— 变量定义还在，正则照样匹配。
  assert.match(
    indexSource,
    /if \(callerIsSubagent && callerSessionId !== null\) \{[\s\S]{0,300}?writeSessionPersonaPatch/,
    '子代理分支必须是「是子代理 且 拿到 sessionId」才落会话覆盖'
  )
  // 反向：那条分支必须在「写全局配置」之前 return，不许走到下面的保存逻辑
  const seg = indexSource.match(/const callerIsSubagent[\s\S]{0,900}?\n            \}\n/)
  assert.ok(seg, '找不到子代理分支')
  assert.match(seg[0], /return \{ ok: true/, '子代理分支必须直接 return，不能落到全局保存')
})

await check('注入侧对「没变」的提示词跳过（避免刷屏子代理上下文）', () => {
  // 同上一组的教训：只钉 /lastInjectedPrompt\.get\(sessionId\) === prompt/ 时，
  // 把条件换成 `false && ...` 依然匹配（变异实测未拦）。必须钉「比较 + skipped++」的整段。
  assert.match(
    indexSource,
    /if \(sessionId !== null && lastInjectedPrompt\.get\(sessionId\) === prompt\) \{\s*\n\s*skipped\+\+/,
    '缺少注入去重（条件必须完整，且命中要 skipped++）'
  )
  assert.match(indexSource, /deliveryState\.skipped = skipped/, '跳过数应如实上报')
})

await check('「曾经有人设」必须看上次装配，不能看注入历史', () => {
  // 反例（本版修掉的真实盲区）：原先用 `!lastInjectedPrompt.has(sessionId)` 当作
  // 「一开始就没人设」的判据。但注入只在配置变更时发生 —— 一个继承着人设、此后
  // 配置没变过的子代理在注入表里是缺席的，于是「继承开着时启动 → 用户关掉继承」
  // 这条路径会漏发「人设已清除」，子代理继续拿旧人设跑完任务。
  assert.match(indexSource, /const lastAssembledPersona = new Map\(\)/, '必须记录上次装配时有没有人设')
  assert.match(
    indexSource,
    /if \(sessionId !== null\) lastAssembledPersona\.set\(sessionId, hasSubagentPersona\(resolved\.config\)\)/,
    '装配侧必须把本轮的人设有无记下来'
  )
  assert.match(
    indexSource,
    /const hadPersonaBefore[\s\S]{0,200}?lastAssembledPersona\.get\(sessionId\) === true/,
    '「曾经有人设」必须由上次装配的人设有无判断'
  )
  assert.match(
    indexSource,
    /if \(resolved\.subagent && !hasPersonaNow && !hadPersonaBefore\) \{/,
    '跳过条件必须用 hasPersonaNow + hadPersonaBefore（只钉变量名的话，条件改坏仍会匹配）'
  )
})

if (!assertCount('verify-subagent-scope', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
