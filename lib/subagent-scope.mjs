// lib/subagent-scope.mjs — 子代理的人设解析（0.12.0）
//
// 需求：主智能体与子智能体**不共用**同一个人设；子代理默认不继承主代理的人设，
// 由主代理在 spawn 时（或之后）为它选一张预设，或者临时写一段。
//
// 四条决定，每条都有代价。写在这里是为了以后不被「顺手优化」掉：
//
// 1. 基线是**全空的中性配置**，不是「全局配置减几层」。
//    用减法的话，全局新加的任何字段都会自动漏进子代理；哪天有人加了新的默认文案，
//    子代理就在没人察觉的情况下重新长出人设。加法（只有显式来源才生效）错了也只会
//    「子代理少拿到一点」，不会「子代理偷偷继承」。
// 2. 子代理**不走工作区绑定，也不走 cwd 目录绑定**。
//    两者都是「这块地方该用谁」的自动规则，属于主代理的会话环境；子代理是被派出去
//    干一件事的，拿父会话的地理位置去决定它的性格，等于让它继承。
// 3. 默认人设是一个**预设名**（config.subagentPersona），不是字段快照 ——
//    记名字，用户改预设时子代理跟着变；记快照会在配置里复制一份人设内容。
// 4. 预设被删掉时**不回退到全局**，保持无人设并标记 personaMissing。
//    回退会让「删掉预设」变成「子代理突然变成主代理的性格」——静默，且与用户预期相反。
//
// 唯一能进到子代理里的东西，只有两处显式来源：
//   ① 全局「子代理默认人设」（预设名）
//   ② 该子代理会话自己的会话覆盖（主代理临时写给它的）
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
  language: '',
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

// config.subagentPersona 的合法值：null（无人设）或 1..30 字符的预设名。
// 复用 sanitizePersonaName，避免与预设名的校验规则各自漂移。
export function subagentPersonaNameOf(config) {
  if (!config || typeof config !== 'object') return null
  return sanitizePersonaName(config.subagentPersona)
}

// 预设条目里**实际声明**的人设字段。
// （导出给 set_subagent_persona 工具复用：主代理选了一张卡，写进会话覆盖的必须是
//  同一套字段，否则「工具看到的卡」和「子代理拿到的人设」会不一样。）
//
// 只取 PERSONA_FIELDS：预设卡里可能带 nickname/occupation/bio（那是「关于你」的用户
// 背景），而子代理不该继承用户画像 —— 它需要的话由主代理显式写进会话覆盖。
// 再走一遍 sanitizeConfig，是为了丢掉 builtin / updatedAt 这类元键，并让枚举与
// 长度限制与设置页完全一致（手改过的预设文件也可能不合法）。
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
 * 子代理该拿到的配置。
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

  const out = { ...SUBAGENT_NEUTRAL_CONFIG, enabled }
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
