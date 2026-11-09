// lib/subagent-scope.mjs — 子代理的人设解析（0.13.0）
//
// 需求：子代理（spawn 出来的「干活的手」）默认沿用主代理的人设（与旧行为一致），
// 但允许用户关掉继承 —— 关掉之后子代理**不继承**任何东西，只从中性基线起算。
//
// 为什么做成开关而不是像上游那样直接改成默认无人设：那是一次破坏性变更
//（升级后所有子代理立刻变成无人设）。开关让想这么做的人自己打开，其余人零感知。
//
// 四条决定，每条都有代价。写在这里是为了以后不被「顺手优化」掉：
//
// 1. 关闭继承时，基线是**全空的中性配置**，不是「全局配置减几层」。
//    用减法的话，全局新加的任何字段都会自动漏进子代理；哪天有人加了新的默认文案，
//    子代理就在没人察觉的情况下重新长出人设。加法（只有显式来源才生效）错了也只会
//    「子代理少拿到一点」，不会「子代理偷偷继承」。
// 2. 关闭继承时，子代理**不走工作区绑定，也不走 cwd 目录绑定**。
//    两者都是「这块地方该用谁」的自动规则，属于主代理的会话环境；子代理是被派出去
//    干一件事的，拿父会话的地理位置去决定它的性格，等于让它继承。
// 3. 默认人设是一个**预设名**（config.subagentPersona），不是字段快照 ——
//    记名字，用户改预设时子代理跟着变；记快照会在配置里复制一份人设内容。
// 4. 预设被删掉时**不回退到全局**，保持无人设并标记 personaMissing。
//    回退会让「删掉预设」变成「子代理突然变成主代理的性格」——静默，且与用户预期相反。
//
// 关闭继承后唯一能进到子代理里的东西，只有两处显式来源：
//   ① 全局「子代理默认人设」（预设名）
//   ② 该子代理会话自己的会话覆盖（子代理用 set_persona 写给自己，或主代理临时写）
import { DEFAULT_CONFIG, PERSONA_FIELDS, sanitizeConfig, sanitizePersonaName } from './config.mjs'
import { SESSION_ENVELOPE_ONLY_FIELDS, SESSION_OVERRIDE_FIELDS } from './session-scope.mjs'
import { resolvePersona } from './personas.mjs'

// 「没有附加人设」的精确含义。
//
// 不能只把 nickname/occupation/bio 清空：compilePrompt 对 style='professional'、
// headingLists='default'、replyLength='normal'、language='zh' 都会生成对应的行为文案
// ——即使用户从没填过任何东西，DEFAULT_CONFIG 本身就会让模型「专业严谨、按中文回答」。
// 对主代理这是合理的默认值；对子代理它就是「继承了一份没人要的人设」。
//
// 所以这里把**每一个参与编译的字段**都置空，只保留 enabled 与结构字段。
// compileSubagentPrompt 对全空配置返回空字符串 —— 空提示词就是子代理该有的状态。
export const SUBAGENT_NEUTRAL_CONFIG = Object.freeze({
  ...DEFAULT_CONFIG,
  nickname: '',
  occupation: '',
  bio: '',
  style: '',
  headingLists: '',
  emoji: '',
  tables: '',
  replyLength: '',
  // language **刻意不清空**：它是全局开关（用哪套文案 + 要求模型说哪种语言），不是角色
  // 特征 —— 见 lib/config.mjs 的 PERSONA_FIELDS 注释。子代理同样遵守用户的语言选择，
  // 否则英文用户的子代理会收到一整份中文提示词（实测过，不是假设）。
  customInstructions: '',
  subagentPersona: null
})

// 这个会话是不是子代理会话。
//
// 判据来自 dsh-subagent 写进 session header 的元数据（childSessionMeta）：
//   origin: 'subagent'                —— 全树只有子代理创建处写这个值
//   delegationDepth: number > 0       —— 同上，嵌套子代理继续 +1
// 两个都认：origin 是明示字段，delegationDepth 是防御（旧会话或第三方 provider
// 可能只写后者）。父会话 fork 出来的会话没有这两个标记 —— 它是主代理的延续，
// 应该继续用主代理的人设。
export function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  if (header.origin === 'subagent') return true
  return typeof header.delegationDepth === 'number' && header.delegationDepth > 0
}

export function isSubagentAgent(agent) {
  return isSubagentHeader(agent && agent.session && agent.session.header)
}

// 子代理是否继承主代理的人设（默认 true）。
//
// 默认 true 的字段必须用 `!== false`：写成 `=== true` 会让「字段缺席」被当成
// 「用户关闭了继承」，老配置升级后子代理会静默变成无人设。
export function subagentInheritsPersona(config) {
  return !(config && config.subagentInheritPersona === false)
}

// config.subagentPersona 的合法值：null（无人设）或 1..64 字符的预设名。
// 复用 sanitizePersonaName，避免与预设名的校验规则各自漂移。
export function subagentPersonaNameOf(config) {
  if (!config || typeof config !== 'object') return null
  return sanitizePersonaName(config.subagentPersona)
}

// 预设条目里**实际声明**的人设字段。
//
// 只取 PERSONA_FIELDS：预设卡里可能带 nickname/occupation/bio（那是「关于你」的用户
// 背景），而子代理不该继承用户画像。再走一遍 sanitizeConfig，是为了丢掉 builtin /
// updatedAt 这类元键，并让枚举与长度限制与设置页完全一致（手改过的预设文件也可能不合法）。
export function declaredPersonaFields(entry) {
  const patch = {}
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return patch
  for (const key of PERSONA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue
    patch[key] = entry[key]
  }
  const { patch: clean } = sanitizeConfig(patch)
  return clean
}

/**
 * 这个子代理**有没有附加人设**。
 *
 * 为什么不看「提示词是否为空」：language 是全局开关，无人设时仍会编出「用简体中文回答」
 * 一句，提示词因此非空。要靠文本判断，就得反过来猜「这一句算不算人设」—— 那是脆弱的。
 * 这里直接问人设字段：自定义指令与五个特质维度都空 ⇒ 没人设。
 *
 * 注意**刻意不含** language：它是全局开关，清空它等于让英文用户的子代理改说中文。
 */
export function hasSubagentPersona(config) {
  if (!config || typeof config !== 'object') return false
  if (String(config.customInstructions || '').trim() !== '') return true
  for (const key of ['style', 'headingLists', 'emoji', 'tables', 'replyLength']) {
    if (config[key]) return true
  }
  return false
}

// 会话覆盖合并。只认白名单字段，且**只合并实际存在的键** ——
// 没写的字段必须保持中性基线，不能被「缺失」覆盖成空（那会把预设里的值抹掉）。
function mergeOverride(base, override) {
  if (!override || typeof override !== 'object' || Array.isArray(override)) {
    return { config: base, changed: false }
  }
  const next = { ...base }
  let changed = false
  for (const key of SESSION_OVERRIDE_FIELDS) {
    if (SESSION_ENVELOPE_ONLY_FIELDS.includes(key)) continue
    if (!Object.prototype.hasOwnProperty.call(override, key)) continue
    next[key] = override[key]
    changed = true
  }
  return { config: next, changed }
}

/**
 * 关闭继承时，子代理该拿到的配置。
 *
 * 解析链（顺序即优先级，后者覆盖前者）：
 *   中性基线 → 全局「子代理默认人设」预设 → 该会话的会话覆盖
 *
 * @param {object|null} base  全局配置（只读，用来取 enabled / subagentPersona / personas）
 * @param {object|null} sessionOverride  该子代理会话的覆盖（来自 sidecar，可为 null）
 * @returns {{config: object, source: string, personaName: string|null, personaMissing: boolean}}
 *   source: 'subagent-default'（无人设） | 'subagent-persona'（预设） | 'subagent-session'（会话覆盖生效）
 */
export function resolveSubagentConfig(base, sessionOverride) {
  // 全局开关仍然全局：关掉个性化时，子代理也不该凭空有人设。
  // （单独判 false 而不是直接透传，是为了避免 undefined 把 enabled 变成假值。）
  const enabled = !(base && base.enabled === false)

  // language 从全局继承：中性基线里保留的是 DEFAULT_CONFIG 的值，这里显式覆盖成调用方
  // 那一份（装配/注入传进来的都是当前全局配置）。
  const out = {
    ...SUBAGENT_NEUTRAL_CONFIG,
    enabled,
    language: (base && base.language) || DEFAULT_CONFIG.language
  }
  let source = 'subagent-default'
  let personaName = null
  let personaMissing = false

  const wanted = subagentPersonaNameOf(base)
  if (wanted) {
    const entry = resolvePersona(wanted, base && base.personas)
    if (entry) {
      Object.assign(out, declaredPersonaFields(entry))
      source = 'subagent-persona'
      personaName = wanted
    } else {
      // 预设被删/改名：不回退到全局（见文件头第 4 条），只如实标记。
      personaMissing = true
    }
  }

  const merged = mergeOverride(out, sessionOverride)
  if (merged.changed) source = 'subagent-session'

  return { config: merged.config, source, personaName, personaMissing }
}
