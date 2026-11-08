// scripts/verify-subagent-scope.mjs — 子代理人设隔离（0.12.0）
//
// 为什么需要它：这一层的失效是**静默的** —— 子代理悄悄继承了主代理的人设，
// 用户只会觉得「它说话怪怪的」，不会报错。所以这里把三条硬约束逐条钉死：
//   1. 默认不继承：全局人设、工作区绑定都不许漏进子代理；
//   2. 只有两处显式来源：全局「子代理默认人设」预设名 + 该会话自己的覆盖；
//   3. 预设被删不回退到全局（回退等于让子代理突然继承）。
//
// 零依赖，直接 node scripts/verify-subagent-scope.mjs 运行。

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'
import { DEFAULT_CONFIG, PERSONA_FIELDS, PROFILE_FIELDS } from '../lib/config.mjs'
import {
  SUBAGENT_NEUTRAL_CONFIG,
  declaredPersonaFields,
  isSubagentAgent,
  isSubagentHeader,
  resolveSubagentConfig,
  subagentPersonaNameOf
} from '../lib/subagent-scope.mjs'

const EXPECTED_ASSERTIONS = 27
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
  passed++
  console.log('  ✓ ' + name)
}

// 一份「主代理正在用」的全局配置：人设、用户背景、工作区覆盖全都有。
// 子代理的解析结果里，对应字段必须一个都不出现 —— 这就是「默认不继承」的全部含义。
const GLOBAL_BASE = {
  ...DEFAULT_CONFIG,
  nickname: '主人',
  occupation: '大学生',
  bio: '不该漏进子代理的用户背景',
  style: 'humorous',
  customInstructions: '主代理的临场指令',
  workspaces: { 'D:/proj': { style: 'cheerful', language: 'en' } }
}

const PERSONA_KEYS = [...PROFILE_FIELDS, ...PERSONA_FIELDS]

// ==================== 判据：谁是子代理 ====================

await check('判据：origin=subagent', () => {
  assert.equal(isSubagentHeader({ origin: 'subagent' }), true)
})

await check('判据：delegationDepth > 0', () => {
  assert.equal(isSubagentHeader({ delegationDepth: 1 }), true)
  assert.equal(isSubagentHeader({ delegationDepth: 3, origin: undefined }), true)
})

await check('判据：delegationDepth = 0 的普通会话不算', () => {
  assert.equal(isSubagentHeader({ delegationDepth: 0 }), false)
})

await check('判据：header 缺失或不是对象，一律不算子代理', () => {
  assert.equal(isSubagentHeader(null), false)
  assert.equal(isSubagentHeader(undefined), false)
  assert.equal(isSubagentHeader('subagent'), false)
})

await check('判据：fork 会话（无 origin、无 delegationDepth）按主代理处理', () => {
  assert.equal(isSubagentHeader({ id: 'x', cwd: '/w', parentSession: 'p', isSeeded: true }), false)
})

await check('isSubagentAgent 从 agent.session.header 取标记', () => {
  assert.equal(isSubagentAgent({ session: { header: { origin: 'subagent' } } }), true)
  assert.equal(isSubagentAgent({ session: { header: { id: 'main' } } }), false)
  assert.equal(isSubagentAgent(undefined), false)
  assert.equal(isSubagentAgent({ session: null }), false)
})

// ==================== 中性基线 ====================

await check('中性基线：参与编译的人设字段全部为空', () => {
  for (const key of PERSONA_KEYS) {
    assert.equal(SUBAGENT_NEUTRAL_CONFIG[key], '', key + ' 必须为空（否则 DEFAULT_CONFIG 的 professional/zh 会自己长出人设）')
  }
})

await check('中性基线：enabled 保持开启', () => {
  assert.equal(SUBAGENT_NEUTRAL_CONFIG.enabled, true, '「无人设」不等于「关掉插件」')
})

// ==================== 解析链 ====================

await check('默认：无预设无覆盖 = 完全无人设', () => {
  const r = resolveSubagentConfig(GLOBAL_BASE, null)
  assert.equal(r.source, 'subagent-default')
  assert.equal(r.personaName, null)
  assert.equal(r.personaMissing, false)
  for (const key of PERSONA_KEYS) assert.equal(r.config[key], '', key + ' 必须保持空')
})

await check('默认：全局人设与用户背景都不许漏进来', () => {
  const r = resolveSubagentConfig(GLOBAL_BASE, null)
  assert.notEqual(r.config.nickname, GLOBAL_BASE.nickname)
  assert.notEqual(r.config.occupation, GLOBAL_BASE.occupation)
  assert.notEqual(r.config.bio, GLOBAL_BASE.bio)
  assert.notEqual(r.config.style, GLOBAL_BASE.style)
  assert.notEqual(r.config.customInstructions, GLOBAL_BASE.customInstructions)
})

await check('默认：工作区/目录绑定也不进子代理', () => {
  // GLOBAL_BASE.workspaces 里给 D:/proj 配了 cheerful + en；子代理拿到的必须还是空
  const r = resolveSubagentConfig({ ...GLOBAL_BASE }, {})
  assert.notEqual(r.config.style, 'cheerful')
  assert.notEqual(r.config.language, 'en')
  assert.equal(r.config.style, '')
})

const CARD = {
  style: 'humorous',
  replyLength: 'concise',
  customInstructions: '只做一件事：跑测试',
  // 刻意混入不该被带走的两种键：用户背景 + 元数据
  nickname: '卡里的昵称',
  builtin: true
}

await check('预设：subagentPersona 指向的预设整卡生效', () => {
  const base = { ...GLOBAL_BASE, subagentPersona: '子代理卡', personas: { '子代理卡': CARD } }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.source, 'subagent-persona')
  assert.equal(r.personaName, '子代理卡')
  assert.equal(r.personaMissing, false)
  assert.equal(r.config.style, 'humorous')
  assert.equal(r.config.replyLength, 'concise')
  assert.equal(r.config.customInstructions, CARD.customInstructions)
})

await check('预设：卡里的「关于你」与元数据不随卡进入子代理', () => {
  const base = { ...GLOBAL_BASE, subagentPersona: '子代理卡', personas: { '子代理卡': CARD } }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.config.nickname, '', '预设里的昵称属于用户背景，不该进子代理')
  assert.equal(r.config.builtin, undefined, '元数据键不该进配置')
})

await check('预设被删：不回退全局，只标记 personaMissing', () => {
  const base = { ...GLOBAL_BASE, subagentPersona: '已删除的卡', personas: {} }
  const r = resolveSubagentConfig(base, null)
  assert.equal(r.personaMissing, true)
  assert.equal(r.personaName, null)
  assert.equal(r.source, 'subagent-default')
  for (const key of PERSONA_KEYS) assert.equal(r.config[key], '', key + ' 不许回退成全局值')
})

await check('会话覆盖：压过预设', () => {
  const base = { ...GLOBAL_BASE, subagentPersona: '子代理卡', personas: { '子代理卡': CARD } }
  const r = resolveSubagentConfig(base, { style: 'professional' })
  assert.equal(r.source, 'subagent-session')
  assert.equal(r.config.style, 'professional')
})

await check('会话覆盖：能给子代理临时写「关于你」三字段', () => {
  const r = resolveSubagentConfig(GLOBAL_BASE, { nickname: '小助手', occupation: '验证子代理', bio: '临时身份' })
  assert.equal(r.source, 'subagent-session')
  assert.equal(r.config.nickname, '小助手')
  assert.equal(r.config.occupation, '验证子代理')
  assert.equal(r.config.bio, '临时身份')
})

await check('会话覆盖：只覆盖写到的键，预设其余字段保留', () => {
  const base = { ...GLOBAL_BASE, subagentPersona: '子代理卡', personas: { '子代理卡': CARD } }
  const r = resolveSubagentConfig(base, { style: 'professional' })
  assert.equal(r.config.replyLength, 'concise', '没写的字段不能被抹成空')
  assert.equal(r.config.customInstructions, CARD.customInstructions)
})

await check('会话覆盖：包封字段（enabled）被忽略', () => {
  const r = resolveSubagentConfig(GLOBAL_BASE, { enabled: false, style: 'humorous' })
  assert.equal(r.config.enabled, true, '会话覆盖不能关掉插件')
  assert.equal(r.config.style, 'humorous')
})

await check('全局 enabled=false 时子代理也不开人设', () => {
  const r = resolveSubagentConfig({ ...GLOBAL_BASE, enabled: false, subagentPersona: '子代理卡', personas: { '子代理卡': CARD } }, null)
  assert.equal(r.config.enabled, false)
})

await check('subagentPersona 非法值一律视为 null', () => {
  assert.equal(subagentPersonaNameOf({ subagentPersona: undefined }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '' }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: 42 }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: 'x'.repeat(31) }), null)
  assert.equal(subagentPersonaNameOf({ subagentPersona: '__proto__' }), null)
  assert.equal(subagentPersonaNameOf(null), null)
  const r = resolveSubagentConfig({ ...GLOBAL_BASE, subagentPersona: '__proto__' }, null)
  assert.equal(r.source, 'subagent-default', '非法预设名不能被当成预设')
})

await check('declaredPersonaFields：只留 PERSONA_FIELDS', () => {
  const out = declaredPersonaFields(CARD)
  assert.deepEqual(Object.keys(out).sort(), ['customInstructions', 'replyLength', 'style'])
})

await check('declaredPersonaFields：非法枚举被 sanitize 丢掉', () => {
  const out = declaredPersonaFields({ style: '莫名其妙的风格', emoji: 'more', nickname: 'x' })
  assert.equal(out.style, undefined)
  assert.equal(out.emoji, 'more')
  assert.equal(out.nickname, undefined)
})

// ==================== 接线：别被改回去 ====================

const SRC = await readFile(INDEX_PATH, 'utf8')

await check('接线：装配侧 section text 走 resolvePromptForAgent', () => {
  assert.match(SRC, /resolvePromptForAgent\(snap\.value, agent, workspaceId, sessionOverride\)/)
})

await check('接线：注入侧按 agent 解析，提示词没变就跳过', () => {
  assert.match(SRC, /resolvePromptForAgent\(\s*config,\s*agent,\s*workspaceId,/) // 参数跨行，只锚到第三个参数
  assert.match(SRC, /lastInjectedPrompt\.get\(sessionId\) === prompt/)
  assert.match(SRC, /lastInjectedPrompt\.set\(sessionId, prompt\)/)
})

await check('接线：子代理调用 set_persona 只改自己的会话覆盖', () => {
  assert.match(SRC, /const callerIsSubagent = isSubagentAgent\(exec && exec\.agent\)/)
})

await check('接线：set_subagent_persona 已注册', () => {
  assert.match(SRC, /name: 'set_subagent_persona'/)
})

await check('子代理提示词不含「执行规则」块', () => {
  const start = SRC.indexOf('function compileSubagentPrompt(config)')
  assert.ok(start >= 0, 'compileSubagentPrompt 应存在')
  const end = SRC.indexOf('\n}', start)
  const body = SRC.slice(start, end)
  assert.equal(body.includes('rulesHeader'), false, '执行规则是给主代理的行为约束，不该进子代理')
})

if (!assertCount('verify-subagent-scope', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log('\n全部通过：' + passed + ' 项检查')
