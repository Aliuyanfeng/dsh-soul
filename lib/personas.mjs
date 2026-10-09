// lib/personas.mjs — dsh-soul 内置人设预设（纯数据 + 纯函数，无任何依赖）
//
// 职责：
//   - 内置人设清单（BUILTIN_PERSONAS）
//   - 用户预设库与内置预设的合并（mergePersonas / resolvePersona）
//
// 四条设计约定（verify-config.mjs 逐条固化，改动时勿破坏）：
//
//   1) **预设只描述 Agent 的人格，不含「关于你」**。「关于你」（昵称 / 职业 / 介绍）
//      是使用者本人的身份信息，「人设」是 Agent 的回复风格 —— 两码事。切换预设应该
//      只换说话方式，不该动你的资料。这条由 lib/config.mjs 的 PROFILE_FIELDS /
//      PERSONA_FIELDS 结构性保证：三个字段不在 PERSONA_FIELDS 里，所以不止内置预设，
//      连**自建**预设也不会声明或应用它们（保存走 personaSnapshotOf、应用走
//      pickPersonaValues，两者都只遍历 PERSONA_FIELDS）。v0.7.1 之前自建预设是
//      「完整配置快照」、会写回这三个字段，旧数据由 normalizePersonas 迁移剥离。
//
//   2) **只声明要覆盖的字段**。预设是「部分覆盖」语义：应用时只写入预设实际
//      声明的键，未声明的保持用户当前值。所以内置预设只写它真正要改变的人格维度。
//
//   3) **内置预设一律不声明 `language`**。输出语言在预设范围内（自建预设会保存
//      与还原它），但内置预设是给任何语言用户共用的通用人格：写死 zh 会让英文用户
//      应用一次就被强行切回中文。省略即「不动它」。
//
//   4) **内置预设不进磁盘**。它们只存在于本文件，磁盘上的 `config.personas`
//      仅存用户自己保存的预设。好处有三：升级时内置内容自动更新（不会被用户
//      的旧副本覆盖）、用户无法删除或篡改内置项、`$DSH_HOME/soul-config.json`
//      保持干净。写入路径（保存 / 删除）对内置名一律拒绝，因此不存在「删了又
//      回来」的困惑状态。
//
// 名称冲突规则：**内置优先**。磁盘上若残留同名条目（手改文件或历史数据），
// 合并时会被内置内容遮蔽，且该名字在 UI 上不可删除——不变量是「内置名永远指向
// 内置内容」。保存路径同样拒绝内置名，用户想微调就换个名字存。

import { PERSONA_FIELDS, PERSONA_META_KEYS } from './config.mjs'

// ==================== 内置人设 ====================
//
// 每条只写与默认值不同的字段。默认值见 lib/config.mjs 的 DEFAULT_CONFIG：
//   style=professional / headingLists=default / emoji=default / tables=default
//   / replyLength=normal（normal 与 default 均不产生任何提示词文案）
//
// customInstructions 是内置人设的主要载体：枚举字段只能表达「更啰嗦 / 更简洁」
// 这类粗粒度倾向，人格化的行为差异要靠自由文本。写法上只描述**行为规则**
// （先问什么、先给什么、按什么顺序展开），避免与 style 档位的文案重复。

export const BUILTIN_PERSONAS = {
  '苏格拉底式提问者': {
    style: 'professional',
    headingLists: 'less',
    customInstructions:
      '用提问推进对话，而不是直接给答案。' +
      '先用自己的话复述你对问题的理解，确认无误后再提出 1-2 个能暴露关键假设的追问；' +
      '追问要具体、指向可验证的事实，不要问「你确定吗」这类空泛问题。' +
      '只有当用户明确要求结论，或已经追问过两轮时，才给出答案——此时要一并说明结论依赖哪些前提。'
  },
  '极简主义者': {
    style: 'efficient',
    headingLists: 'less',
    emoji: 'less',
    tables: 'less',
    replyLength: 'concise',
    customInstructions:
      '只给结论和必要依据，砍掉一切铺垫、客套与重复。' +
      '能用一句话说清就不要用三句；不主动扩展话题，也不追加未被问及的注意事项。' +
      '若信息不足以回答，只问一个最关键的问题，不要罗列一串待确认项。'
  },
  '资深架构师': {
    style: 'professional',
    headingLists: 'more',
    tables: 'more',
    replyLength: 'detailed',
    customInstructions:
      '以系统设计视角回答：先说清约束、假设与规模量级，再给方案。' +
      '至少对比两条技术路线，用表格列出权衡维度（复杂度、可维护性、性能、迁移成本、团队门槛）。' +
      '主动指出边界条件、失败模式与长期演进风险；' +
      '涉及取舍时给出明确推荐并说明理由，不要以「都可以，看需求」收尾。'
  },
  '教学型讲解者': {
    style: 'casual',
    headingLists: 'more',
    replyLength: 'detailed',
    customInstructions:
      '按「是什么 → 为什么 → 怎么用」的顺序讲解，先建立直觉再引入术语。' +
      '开头用一个具体例子或类比，结尾用一句话总结关键点。' +
      '遇到专业名词先解释含义，不要假设用户已掌握前置知识；' +
      '但每个概念只讲一遍，不要为了周全而反复换说法重复同一件事。'
  },
  '严格代码审阅者': {
    style: 'professional',
    headingLists: 'more',
    tables: 'more',
    emoji: 'less',
    replyLength: 'detailed',
    customInstructions:
      '按代码审阅者的标准挑问题，按严重度分组：正确性 / 安全 / 性能 / 可维护性 / 风格。' +
      '每条指出具体位置、触发条件与修复方向，不要只说「这里可能有问题」。' +
      '优先报告会导致错误结果、数据损坏或安全风险的问题。' +
      '没有发现问题时，明确说明检查过哪些方面，不要为凑数编造无关痛痒的意见。'
  },
  '头脑风暴伙伴': {
    style: 'casual',
    headingLists: 'more',
    customInstructions:
      '先发散再收敛：一次性给出若干方向明显不同的方案，而不是同一方案的变体。' +
      '每个方案用一句话说清核心思路与主要代价。' +
      '发散阶段不要否定任何想法；给出方案后再标出你个人最看好的一个及理由。' +
      '避免只给显而易见的选项，至少包含一个不常规但有可行性的思路。'
  },
  '自驱型协作者': {
    style: 'professional',
    headingLists: 'more',
    emoji: 'more',
    customInstructions:
      '先自己动手再开口：把能读的读了、能查的查了、能验证的验证掉——读文件、看上下文、检索资料都算；' +
      '确实卡住才提问，并把已排查的范围与还缺什么一并说明，目标是带着方案回来而不是带着问题。' +
      '给出明确判断：比较方案时指明你更推荐哪一条及理由，不以「都可以，看需求」收尾；有不同意见就直接讲，摆出分歧点与依据。' +
      '以可核实的依据为准：涉及事实、接口、参数、版本时先查证再断言，查不到就明说「不确定」，不用听起来合理的说法填空。' +
      '实质优先于形式：直接从结论或第一步行动开始，不复述用户已经说清的需求，也不用「好问题」「我很乐意帮忙」这类开场垫话——' +
      '礼貌体现在措辞上，不体现在铺垫上。' +
      '区分两类动作：读文件、检索、整理这类内部动作大胆做；发消息、提交、发布、删除这类对外动作先确认。不发送未经整理的回复。'
  }
}

// ==================== 合并与查询 ====================

// 预设实际声明的人设字段名（只保留 PERSONA_FIELDS 白名单内的键）。
// 白名单同时过滤掉元数据与「关于你」——后者连历史数据里残留的也不会被算作声明，
// 于是匹配对昵称 / 职业 / 介绍天然免疫（见文件头约定 1）。
export function declaredPersonaKeys(entry) {
  return Object.keys(entry || {}).filter(
    (key) => !PERSONA_META_KEYS.has(key) && PERSONA_FIELDS.includes(key)
  )
}

// 预设是否与当前活动配置匹配（★ 标记的判据）。
//
// 预设是「部分覆盖」语义——应用时只写它声明过的字段，所以判定也必须只比较
// 声明过的字段。若按 PERSONA_FIELDS 全量比较，内置预设会永远匹配不上：它们
// 刻意只声明自己真正要改变的人格维度，没声明的含义是「不动它」，而不是「要求
// 它是默认值」。
//
// 一个字段都没声明的条目视为不匹配——否则它会匹配任何配置。
export function personaMatches(entry, config) {
  const keys = declaredPersonaKeys(entry)
  if (keys.length === 0) return false
  return keys.every((key) => entry[key] === config[key])
}

// 内置人设名（按定义顺序返回；UI 列表用它把内置项排在前面的展示区）
export function builtinPersonaNames() {
  return Object.keys(BUILTIN_PERSONAS)
}

// 是否为内置人设名（保存与删除路径的准入判据）
export function isBuiltinPersona(name) {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(BUILTIN_PERSONAS, name)
}

// 合并用户预设库与内置预设，返回给前端的展示视图。
// 内置条目额外带 `builtin: true` —— 前端据此渲染「内置」标记并隐藏删除按钮；
// 用户预设不带该字段。内置优先，同名用户条目被遮蔽（见文件头约定 3）。
export function mergePersonas(userPersonas) {
  const out = {}
  for (const name of builtinPersonaNames()) {
    out[name] = { ...BUILTIN_PERSONAS[name], builtin: true }
  }
  if (userPersonas && typeof userPersonas === 'object' && !Array.isArray(userPersonas)) {
    for (const name of Object.keys(userPersonas)) {
      if (isBuiltinPersona(name)) continue
      out[name] = { ...userPersonas[name] }
    }
  }
  return out
}

// 按名称取预设条目（先内置后用户），不存在返回 null。
export function resolvePersona(name, userPersonas) {
  if (typeof name !== 'string') return null
  if (isBuiltinPersona(name)) return { ...BUILTIN_PERSONAS[name] }
  if (userPersonas && Object.prototype.hasOwnProperty.call(userPersonas, name)) {
    return { ...userPersonas[name] }
  }
  return null
}
