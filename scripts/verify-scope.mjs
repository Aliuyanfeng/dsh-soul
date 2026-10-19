// scripts/verify-scope.mjs — 工作区级人设覆盖的纯函数回归（离线，无宿主）
//
// 为什么需要它：`lib/workspace-scope.mjs` 决定「这个工作区用什么人设」，
// 而它的失效形态几乎都是**静默**的：
//   · `enabled` 被覆盖 ⇒ 用户关掉插件却没关干净（最严重）；
//   · 白名单漏一个字段 ⇒ 该字段的覆盖被丢，但界面显示"已绑定"；
//   · 版本不认识却硬解析 ⇒ 按错的语义读出一堆假覆盖；
//   · 空覆盖被当成"有覆盖" ⇒ 工作区明明没设，却挡住了目录回退。
// 这些都不会抛错，只会给出一个**看起来正常的错误人设**。
//
// 零依赖，直接 `node scripts/verify-scope.mjs` 运行。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertCount } from './lib/skip-report.mjs'
import {
  ENVELOPE_ONLY_FIELDS,
  MAX_WORKSPACE_ID_LENGTH,
  MAX_WORKSPACE_SCOPES,
  WORKSPACE_OVERRIDE_FIELDS,
  WORKSPACE_PERSONA_REF,
  WORKSPACE_SCOPE_VERSION,
  isEmptyOverride,
  isWorkspaceKey,
  mergeWorkspaceOverride,
  overrideFromPersona,
  resolveWorkspaceOverride,
  sanitizeWorkspaceOverride,
  sanitizeWorkspaceScopes,
  serializeWorkspaceScopes,
  validateWorkspaceBinding
} from '../lib/workspace-scope.mjs'

const EXPECTED_ASSERTIONS = 22

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

// ==================== workspaceId 的键形态 ====================

check('workspaceId 必须是短字符串，且不能是路径', () => {
  assert.equal(isWorkspaceKey('ws_a1'), true)
  assert.equal(isWorkspaceKey('a'), true)
  assert.equal(isWorkspaceKey(''), false, '空串不是合法键')
  assert.equal(isWorkspaceKey('   '), false, '纯空白不是合法键')
  assert.equal(isWorkspaceKey(null), false)
  assert.equal(isWorkspaceKey(undefined), false)
  assert.equal(isWorkspaceKey(42), false, '数字不是合法键')
  assert.equal(isWorkspaceKey({}), false)
  assert.equal(isWorkspaceKey([]), false)
  // 路径形态必须在入口拒绝：否则同一目录换个写法就成了另一条覆盖，
  // 而用户以为是同一个工作区。
  assert.equal(isWorkspaceKey('D:\\项目A'), false, '含反斜杠的路径不得当键')
  assert.equal(isWorkspaceKey('/home/u/proj'), false, '含斜杠的路径不得当键')
  assert.equal(isWorkspaceKey('x'.repeat(MAX_WORKSPACE_ID_LENGTH + 1)), false, '超长键被拒绝')
  assert.equal(isWorkspaceKey('x'.repeat(MAX_WORKSPACE_ID_LENGTH)), true, '恰好到上限应被接受')
})

check('空覆盖被归一成"没有覆盖"', () => {
  assert.equal(isEmptyOverride(null), true)
  assert.equal(isEmptyOverride(undefined), true)
  assert.equal(isEmptyOverride({}), true)
  assert.equal(isEmptyOverride([]), true, '数组不是覆盖项')
  assert.equal(isEmptyOverride({ style: 'casual' }), false)
})

// ==================== 单条覆盖：白名单与丢弃报告 ====================

check('覆盖项只保留白名单字段，其余全部进 dropped', () => {
  const { override, dropped } = sanitizeWorkspaceOverride({
    style: 'casual',
    customInstructions: '严格审查',
    // 以下都应被丢弃，且必须出现在 dropped 里 —— 否则「我明明写了却没生效」无从解释
    enabled: false,        // 包封字段：越界
    nickname: '小明',       // 「关于你」不在人设范围内
    occupation: '工程师',
    trailColor: '#FFFFFF', // 全局设施，不是项目偏好
    historyMaxEntries: 50
  })
  assert.deepEqual(override, { style: 'casual', customInstructions: '严格审查' })
  assert.deepEqual(
    dropped.slice().sort(),
    ['enabled', 'historyMaxEntries', 'nickname', 'occupation', 'trailColor']
  )
})

check('非对象 / 全非法字段的覆盖项归一成 null', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    assert.equal(sanitizeWorkspaceOverride(bad).override, null, `${JSON.stringify(bad)} 应归一成 null`)
  }
  const onlyIllegal = sanitizeWorkspaceOverride({ enabled: true, nickname: 'x' })
  assert.equal(onlyIllegal.override, null, '全部字段被丢弃时整条归一成 null')
  assert.equal(onlyIllegal.dropped.length, 2, '被丢弃的字段都要如实报出来')
})

check('白名单与包封字段的关系：不重叠，且 enabled 不在白名单里', () => {
  for (const field of ENVELOPE_ONLY_FIELDS) {
    assert.equal(
      WORKSPACE_OVERRIDE_FIELDS.includes(field),
      false,
      `${field} 是包封字段，绝不能出现在工作区可覆盖白名单里`
    )
  }
  // 白名单本身必须非空且都是配置里的字段名形态
  assert.ok(WORKSPACE_OVERRIDE_FIELDS.length >= 5, '可覆盖字段太少，可能存在漏登记')
  for (const field of WORKSPACE_OVERRIDE_FIELDS) {
    assert.match(field, /^[a-z][A-Za-z]*$/, `白名单字段名形态异常：${field}`)
  }
})

// ==================== 整表：版本、上限、损坏 ====================

check('整表：版本不认识时整表忽略并给出原因', () => {
  const result = sanitizeWorkspaceScopes({
    version: 999,
    scopes: { ws_a1: { style: 'casual' } }
  })
  assert.deepEqual(result.scopes, {}, '不认识的版本不得"尽力解析"出假覆盖')
  assert.ok(result.warning !== null, '整表被忽略时必须给出可展示的原因')
  assert.match(result.warning, /999/, '原因里要写明读到的是哪个版本')
})

check('整表：缺 version 时按当前版本解析（向前兼容手写文件）', () => {
  const result = sanitizeWorkspaceScopes({ scopes: { ws_a1: { style: 'casual' } } })
  assert.deepEqual(result.scopes, { ws_a1: { style: 'casual' } })
  assert.equal(result.warning, null)
})

check('整表：非法键与空覆盖被计数丢弃，不影响其它条目', () => {
  const result = sanitizeWorkspaceScopes({
    version: WORKSPACE_SCOPE_VERSION,
    scopes: {
      ws_good: { style: 'casual' },
      'D:\\path': { style: 'humorous' },   // 路径当键 → 丢弃
      ws_empty: {},                         // 空覆盖 → 丢弃
      ws_bad: 'not-an-object'               // 形状不对 → 丢弃
    }
  })
  assert.deepEqual(Object.keys(result.scopes), ['ws_good'], '一条坏数据不该让好数据陪葬')
  assert.equal(result.dropped, 3, '丢弃条数要如实报出')
})

check('整表：超上限时整表忽略而不是静默截断', () => {
  const scopes = {}
  for (let i = 0; i < MAX_WORKSPACE_SCOPES + 1; i++) scopes[`ws_${i}`] = { style: 'casual' }
  const result = sanitizeWorkspaceScopes({ version: WORKSPACE_SCOPE_VERSION, scopes })
  assert.deepEqual(result.scopes, {}, '超上限时不得截断 —— 截断会让"部分工作区设置莫名不生效"')
  assert.ok(result.warning !== null)
})

check('整表：非对象输入一律安全归零', () => {
  for (const bad of [null, undefined, 'x', 42, [], true]) {
    const result = sanitizeWorkspaceScopes(bad)
    assert.deepEqual(result.scopes, {}, `${JSON.stringify(bad)} 应得到空表`)
  }
})

check('序列化往返：serialize → sanitize 得到同一张表', () => {
  const original = { ws_a1: { style: 'casual' }, ws_b2: { customInstructions: 'x' } }
  const round = sanitizeWorkspaceScopes(serializeWorkspaceScopes(original))
  assert.deepEqual(round.scopes, original)
  assert.equal(round.dropped, 0)
  assert.equal(serializeWorkspaceScopes(original).version, WORKSPACE_SCOPE_VERSION)
})

// ==================== 解析与合并 ====================

check('按 workspaceId 解析覆盖，未命中返回 null', () => {
  const scopes = { ws_a1: { style: 'casual' } }
  assert.deepEqual(resolveWorkspaceOverride('ws_a1', scopes), { style: 'casual' })
  assert.equal(resolveWorkspaceOverride('ws_missing', scopes), null)
  assert.equal(resolveWorkspaceOverride(null, scopes), null)
  assert.equal(resolveWorkspaceOverride('D:\\path', scopes), null, '路径不是键')
  // 空覆盖等同于没有覆盖 —— 否则它会挡住目录回退
  assert.equal(resolveWorkspaceOverride('ws_empty', { ws_empty: {} }), null)
})

check('合并是字段级部分覆盖：未声明字段保持原值', () => {
  const base = { enabled: true, style: 'professional', language: 'zh', nickname: '小明' }
  const merged = mergeWorkspaceOverride(base, { style: 'humorous' })
  assert.equal(merged.style, 'humorous', '声明过的字段被覆盖')
  assert.equal(merged.language, 'zh', '未声明的字段保持原值')
  assert.equal(merged.nickname, '小明', '「关于你」不受工作区影响')
  // 绝不就地修改 base
  assert.equal(base.style, 'professional', 'mergeWorkspaceOverride 不得修改入参')
  assert.notEqual(merged, base, '应返回新对象')
})

check('★ enabled 绝不能被覆盖（全局总开关始终说话）', () => {
  const base = { enabled: false, style: 'professional' }
  // 即便有人绕过 sanitize 直接塞进 merge，第二道防线也必须挡住
  const merged = mergeWorkspaceOverride(base, { enabled: true, style: 'casual' })
  assert.equal(merged.enabled, false, '工作区不得把已关闭的插件重新打开')
  assert.equal(merged.style, 'casual', '同一次合并里的合法字段仍应生效')

  const base2 = { enabled: true }
  const merged2 = mergeWorkspaceOverride(base2, { enabled: false })
  assert.equal(merged2.enabled, true, '工作区也不得替用户关闭全局开关')
})

check('合并丢弃白名单外的字段（不把脏数据带进编译）', () => {
  const base = { enabled: true, style: 'professional', nickname: '小明' }
  const merged = mergeWorkspaceOverride(base, {
    style: 'casual',
    nickname: '被改掉的名字',   // 白名单外
    trailColor: '#000000',     // 白名单外
    __proto__: { polluted: 1 } // 原型污染尝试
  })
  assert.equal(merged.nickname, '小明', '「关于你」不得被工作区覆盖')
  assert.equal(merged.trailColor, undefined, '全局设施不得被工作区覆盖')
  assert.equal({}.polluted, undefined, '不得污染 Object.prototype')
})

check('空覆盖 / null 覆盖时原样返回 base（不改身份）', () => {
  const base = { enabled: true, style: 'professional' }
  assert.equal(mergeWorkspaceOverride(base, null), base)
  assert.equal(mergeWorkspaceOverride(base, {}), base)
  assert.equal(mergeWorkspaceOverride(base, undefined), base)
})

// ==================== 预设 → 覆盖 ====================

check('overrideFromPersona 只取白名单内字段', () => {
  const personas = {
    严格审查: {
      style: 'professional',
      replyLength: 'detailed',
      customInstructions: '先看安全',
      // 以下都不该进覆盖
      nickname: '预设里的昵称',
      enabled: false,
      updatedAt: '2026-01-01T00:00:00Z',
      builtin: true
    }
  }
  const override = overrideFromPersona('严格审查', personas)
  assert.deepEqual(override, {
    style: 'professional',
    replyLength: 'detailed',
    customInstructions: '先看安全'
  })
})

check('overrideFromPersona 对不存在 / 空的预设返回 null', () => {
  assert.equal(overrideFromPersona('不存在', {}), null)
  assert.equal(overrideFromPersona('空预设', { 空预设: { updatedAt: 'x' } }), null)
  assert.equal(overrideFromPersona('不含人设字段', { 不含人设字段: { nickname: 'x' } }), null)
})

// ==================== 绑定请求校验 ====================

check('validateWorkspaceBinding：正常请求给出可用覆盖，并记下绑定的是谁', () => {
  const personas = { 极简: { style: 'efficient' } }
  const verdict = validateWorkspaceBinding({ workspaceId: 'ws_a1', persona: '极简' }, personas)
  assert.equal(verdict.ok, true)
  assert.equal(verdict.workspaceId, 'ws_a1')
  assert.equal(verdict.persona, '极简')
  // 覆盖里必须带引用字段：预设日后被改名/删除时，界面才能说出「它原本指向谁」，
  // 而不是只剩一堆说不出出处的字段值。
  assert.deepEqual(verdict.override, { style: 'efficient', [WORKSPACE_PERSONA_REF]: '极简' })
  // 引用字段不参与合并（它不是可覆盖字段）
  const merged = mergeWorkspaceOverride({ enabled: true, style: 'professional' }, verdict.override)
  assert.equal(merged.style, 'efficient')
  assert.equal(
    Object.prototype.hasOwnProperty.call(merged, WORKSPACE_PERSONA_REF),
    false,
    '引用字段绝不能进配置 —— 它是元数据，不是人设字段'
  )
})

check('引用字段：只有它时算空覆盖，且 sanitize 保留它但不算 dropped', () => {
  // 预设被删、字段全失效后可能只剩引用字段。它不该挡住目录回退层。
  assert.equal(isEmptyOverride({ [WORKSPACE_PERSONA_REF]: '已删除的预设' }), true)
  assert.equal(isEmptyOverride({ [WORKSPACE_PERSONA_REF]: 'x', style: 'casual' }), false)
  const { override, dropped } = sanitizeWorkspaceOverride({
    style: 'casual',
    [WORKSPACE_PERSONA_REF]: '极简'
  })
  assert.equal(override[WORKSPACE_PERSONA_REF], '极简')
  assert.deepEqual(dropped, [], '引用字段不是「被丢弃的字段」')
  // 脏的引用字段被忽略（不留半条）
  assert.equal(sanitizeWorkspaceOverride({ style: 'casual', [WORKSPACE_PERSONA_REF]: 42 }).override[WORKSPACE_PERSONA_REF], undefined)
  assert.equal(sanitizeWorkspaceOverride({ style: 'casual', [WORKSPACE_PERSONA_REF]: '  ' }).override[WORKSPACE_PERSONA_REF], undefined)
})

check('validateWorkspaceBinding：拒绝路径当键、空人设、不存在的人设', () => {
  const personas = { 极简: { style: 'efficient' } }
  const cases = [
    [{ workspaceId: 'D:\\proj', persona: '极简' }, /工作区标识无效/],
    [{ workspaceId: '', persona: '极简' }, /工作区标识无效/],
    [{ workspaceId: 'ws_a1', persona: '' }, /不能为空/],
    [{ workspaceId: 'ws_a1', persona: '   ' }, /不能为空/],
    [{ workspaceId: 'ws_a1', persona: 42 }, /必须是字符串/],
    [{ workspaceId: 'ws_a1', persona: '不存在的人设' }, /不存在/]
  ]
  for (const [input, pattern] of cases) {
    const verdict = validateWorkspaceBinding(input, personas)
    assert.equal(verdict.ok, false, `应拒绝：${JSON.stringify(input)}`)
    assert.match(verdict.error, pattern, `错误文案应说明原因：${verdict.error}`)
  }
})

// ==================== 模块边界 ====================

// ⚠️ 这个 check 是**同步**的（本文件的 check() 不 await）。之前这里写成 async：
// check() 拿到一个 Promise 就当场判成功，断言体一个都没跑 ——「看起来绿、实际没验证」。

check('纯函数层不依赖宿主，也不触碰提示词装配', () => {
  const source = readFileSync(new URL('../lib/workspace-scope.mjs', import.meta.url), 'utf8')
  // 去掉注释再判断：注释里出现 cordis 不算依赖
  const code = source.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(/from 'cordis'|require\('cordis'\)/.test(code), false, '不得依赖 cordis —— 它要能被脚本独立加载')
  assert.equal(/compilePrompt|systemPrompt/.test(code), false, '不得触碰提示词装配')
  assert.equal(/console\./.test(code), false, '纯函数层不得打印')
})

if (!assertCount('verify-scope', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
