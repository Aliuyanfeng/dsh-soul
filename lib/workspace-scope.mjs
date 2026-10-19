// lib/workspace-scope.mjs — 工作区级人设覆盖（纯函数层）
//
// 职责：
//   - 工作区覆盖表的校验与序列化（读侧一律当不可信输入）
//   - `workspaceId → 人设名` 的解析
//   - 与全局配置的**字段级部分覆盖**合并
//
// 四条设计前提，改本模块前请先读：
//
//   1. **工作区身份是 `workspaceId`，不是目录。** 宿主 `workspaceRegistry` 维护权威的
//      `sessionId → workspaceId` 索引；目录只是**回退**依据（见 §2.2 的解析链）。
//      用目录当主键会在「工作区改名 / 目录移动」时丢掉覆盖，而用户完全无法察觉。
//   2. **`enabled` 绝不能被下层覆盖。** 它是全局总开关：`compilePrompt()` 首行就是
//      `if (!config.enabled) return ''`。若某个工作区能把 enabled 改成 true，
//      「关掉插件」就不再是关掉 —— 用户会以为没关干净。这条由 ENVELOPE_ONLY
//      与断言共同钉住。
//   3. **部分覆盖，不是整份替换。** 与 `/api/soul/personas/use` 同一条规则：
//      只覆盖条目**显式声明过**的字段。同一个概念在两处有不同语义，用户就无法
//      用「点一下使用预设」来验证「这个工作区绑定生效了吗」。
//   4. **本模块只负责如实报告，不替调用方决定要不要回退** —— 与 lib/store.mjs、
//      lib/history.mjs、lib/bindings.mjs 同一条约定，可被脚本独立加载测试。
//
// 为什么工作区覆盖放在 `soul-config.json` 而不是独立文件：
// 它是**配置**（低频、天然有上限、用户在意它的变更历史），与 Session 覆盖的
// **状态**性质不同（高频、无上限、会随会话消失）。状态才需要 sidecar。

import { PERSONA_FIELDS, PERSONA_NAME_MAX, sanitizePersonaName } from './config.mjs'
import { resolvePersona } from './personas.mjs'

// ==================== 契约常量 ====================

// 覆盖表格式版本。读到不认识的版本时**整表忽略**（而不是猜测字段语义）：
// 升级后的键含义无法保证，宁可暂时不生效，也不能按错的方式解析出一堆假覆盖。
export const WORKSPACE_SCOPE_VERSION = 1

// 一个工作区能覆盖的字段白名单。
//
// 这就是 `PERSONA_FIELDS`：工作区覆盖表达的是「这个项目要什么样的人设」，
// 与人设预设能表达的完全一致。刻意**不含** `enabled`（见前提 2）、
// 也不含 `historyMaxEntries` / `trail*`（那些是全局设施，不是项目偏好）。
//
// 不导出 `PERSONA_FIELDS` 的引用而是当场列出，是为了让白名单在文件里**可读**：
// 一个 `[...PERSONA_FIELDS]` 会让「工作区到底能改什么」只能靠跳转才能回答。
export const WORKSPACE_OVERRIDE_FIELDS = Object.freeze([
  'style',
  'headingLists',
  'emoji',
  'tables',
  'replyLength',
  'language',
  'customInstructions'
])

// 永远由全局决定、任何作用域都不能覆盖的字段。
export const ENVELOPE_ONLY_FIELDS = Object.freeze(['enabled'])

// 一个工作区一条覆盖。上限按「用户实际会建多少个工作区」定：
// 宿主的工作区是用户手动添加的，几十个已属异常；超出时如实报告而不是静默截断。
export const MAX_WORKSPACE_SCOPES = 200

// workspaceId 的长度上限。宿主用 `WorkspaceId` 品牌类型，实测形如短字符串；
// 给一个宽松上限只为拦住把整个路径塞进 key 这类错误用法。
export const MAX_WORKSPACE_ID_LENGTH = 128

// ==================== 校验 ====================

/**
 * 判断一个值能否当作 workspaceId 的键。
 *
 * 不接受：
 *   - 非字符串 / 空串
 *   - 含路径分隔符（`\` 或 `/`）—— 那是「把目录当身份」的典型错误，必须在入口拒绝，
 *     否则同一目录会因为写法不同而出现两条互不相干的覆盖
 *   - 超长
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isWorkspaceKey(raw) {
  if (typeof raw !== 'string') return false
  const key = raw.trim()
  if (key === '') return false
  if (key.length > MAX_WORKSPACE_ID_LENGTH) return false
  if (key.includes('\\') || key.includes('/')) return false
  return true
}

/**
 * 覆盖项是否为空（空对象表示「这个工作区不覆盖任何字段」，等同于没有条目）。
 * @param {unknown} entry
 * @returns {boolean}
 */
export function isEmptyOverride(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
  return Object.keys(entry).length === 0
}

/**
 * 校验单个工作区覆盖项。读侧一律当不可信输入。
 *
 * 返回值**不抛错**：与 lib/bindings.mjs 的 `sanitizeBindings` 同一约定 ——
 * 一条坏数据不该让整张表失效，调用方需要知道「哪几条被丢掉了」才能如实提示。
 *
 * @param {unknown} raw
 * @returns {{ override: Record<string, unknown> | null, dropped: string[] }}
 *   override 为 null 表示整条不可用；dropped 列出被忽略的字段名（便于诊断）
 */
export function sanitizeWorkspaceOverride(raw) {
  const dropped = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { override: null, dropped }
  }

  const override = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!WORKSPACE_OVERRIDE_FIELDS.includes(key)) {
      // 包封字段（enabled）与未知字段一律丢弃：前者是越界，后者是无法理解的语义。
      // 两者都必须**出现在 dropped 里**，否则「我明明写了却没生效」无从解释。
      dropped.push(key)
      continue
    }
    // 类型与取值交给 sanitizeConfig 统一校验（下面 pickPersonaValues + sanitizeConfig
    // 走的是同一条路径），这里只做字段白名单筛选。
    override[key] = value
  }

  return { override: isEmptyOverride(override) ? null : override, dropped }
}

/**
 * 校验整张工作区覆盖表。
 *
 * @param {unknown} raw 读盘得到的原始值
 * @returns {{ scopes: Record<string, object>, dropped: number, warning: string | null }}
 *   - scopes：可用的 `workspaceId → override`
 *   - dropped：被丢弃的条目数（形状不对 / 键非法 / 覆盖为空）
 *   - warning：整表不可用的原因（版本不认识等），此时 scopes 为空对象
 */
export function sanitizeWorkspaceScopes(raw) {
  const empty = { scopes: {}, dropped: 0, warning: null }
  if (raw === undefined || raw === null) return empty
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { scopes: {}, dropped: 0, warning: '工作区覆盖表必须是一个对象' }
  }

  // 版本：不认识就整表忽略。这里刻意不「尽力解析」—— 升级后的字段语义无法保证，
  // 按错的语义解析出一堆假覆盖，比暂时失效更难排查。
  const version = raw.version
  if (version !== undefined && version !== WORKSPACE_SCOPE_VERSION) {
    return {
      scopes: {},
      dropped: 0,
      warning: `工作区覆盖表版本 ${String(version)} 不认识（当前支持 ${WORKSPACE_SCOPE_VERSION}），已整表忽略`
    }
  }

  const table = raw.scopes
  if (table === undefined || table === null) return empty
  if (typeof table !== 'object' || Array.isArray(table)) {
    return { scopes: {}, dropped: 0, warning: '工作区覆盖表的 scopes 必须是一个对象' }
  }

  const scopes = {}
  let dropped = 0
  for (const [id, entry] of Object.entries(table)) {
    if (!isWorkspaceKey(id)) { dropped++; continue }
    const { override } = sanitizeWorkspaceOverride(entry)
    if (override === null) { dropped++; continue }
    scopes[id] = override
  }

  // 超上限时**如实报告**而不是静默截断：截断意味着「有些工作区的设置莫名不生效」，
  // 那正是最不该静默的一类失败。
  const keys = Object.keys(scopes)
  if (keys.length > MAX_WORKSPACE_SCOPES) {
    return {
      scopes: {},
      dropped: keys.length,
      warning: `工作区覆盖表含 ${keys.length} 条，超过上限 ${MAX_WORKSPACE_SCOPES}，已整表忽略`
    }
  }

  return { scopes, dropped, warning: null }
}

/**
 * 序列化工作区覆盖表（写盘用）。
 * @param {Record<string, object>} scopes
 * @returns {{ version: number, scopes: Record<string, object> }}
 */
export function serializeWorkspaceScopes(scopes) {
  return { version: WORKSPACE_SCOPE_VERSION, scopes: { ...scopes } }
}

// ==================== 解析与合并 ====================

/**
 * 从覆盖表里取出某个工作区的覆盖项。
 *
 * 返回 null 表示「这个工作区没有自定义人设」—— 与「有覆盖但字段全空」是同一件事，
 * 因为空覆盖在 sanitize 阶段就被归一成 null 了。
 *
 * @param {string | null | undefined} workspaceId
 * @param {Record<string, object>} scopes
 * @returns {object | null}
 */
export function resolveWorkspaceOverride(workspaceId, scopes) {
  if (!isWorkspaceKey(workspaceId)) return null
  const entry = scopes && scopes[workspaceId]
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  return isEmptyOverride(entry) ? null : entry
}

/**
 * 把工作区覆盖合并进当前配置（**部分覆盖**语义）。
 *
 * 合并顺序无关（只有一层），但必须保证：
 *   - 未声明的字段保持原值；
 *   - `enabled` 等包封字段**绝不**被覆盖（即便它在 override 里，也在这里再挡一次 ——
 *     sanitize 已经挡过，但这是最后一道，成本为零）；
 *   - 未知字段不落进结果（防止把脏数据带进编译）。
 *
 * @param {object} base 当前生效的配置（全局，或已合并过更高优先级的层）
 * @param {object | null} override 工作区覆盖
 * @returns {object} 合并后的配置（新对象，绝不就地修改 base）
 */
export function mergeWorkspaceOverride(base, override) {
  if (!override || typeof override !== 'object') return base

  const patch = {}
  for (const [key, value] of Object.entries(override)) {
    if (ENVELOPE_ONLY_FIELDS.includes(key)) continue
    if (!WORKSPACE_OVERRIDE_FIELDS.includes(key)) continue
    patch[key] = value
  }
  if (Object.keys(patch).length === 0) return base
  return { ...base, ...patch }
}

/**
 * 从预设条目里挑出「工作区可覆盖」的字段。
 *
 * 与 `index.mjs` 的 `pickPersonaValues` **同一条语义**（`if (key in persona)` 即
 * 「只应用条目实际声明过的键」），但只取 `WORKSPACE_OVERRIDE_FIELDS` 这一子集：
 * 那个函数还包含 `enabled` 之外的人设字段，而工作区覆盖的白名单更窄。
 *
 * 刻意不直接复用同名函数：它定义在 `index.mjs`（依赖宿主 ctx，不可独立加载），
 * 而本模块必须能被 `scripts/verify-*.mjs` 单独 import 测试。语义一致性由断言守住，
 * 而不是靠共享代码 —— 两者的白名单本来就不同，共享反而会诱使它们漂移到一起。
 *
 * @param {object} persona
 * @returns {Record<string, unknown>}
 */
function pickOverridableValues(persona) {
  const values = {}
  for (const key of PERSONA_FIELDS) {
    if (!WORKSPACE_OVERRIDE_FIELDS.includes(key)) continue
    if (key in persona) values[key] = persona[key]
  }
  return values
}

/**
 * 把「人设预设」换算成一份覆盖项。
 *
 * 与 `/api/soul/personas/use`、`configForCwd` 走**同一条**折算语义（部分覆盖 +
 * 白名单过滤）。三处若各自实现一遍，就会出现「点使用得到的效果」与「绑定得到的效果」
 * 对不上 —— 而那正是用户用来验证绑定是否生效的唯一手段。
 *
 * @param {string} personaName
 * @param {Record<string, object>} personas 预设库
 * @returns {object | null} 预设不存在时返回 null
 */
export function overrideFromPersona(personaName, personas) {
  const entry = resolvePersona(personaName, personas)
  if (!entry) return null
  const values = pickOverridableValues(entry)
  const override = {}
  for (const [key, value] of Object.entries(values)) {
    if (ENVELOPE_ONLY_FIELDS.includes(key)) continue
    if (!WORKSPACE_OVERRIDE_FIELDS.includes(key)) continue
    override[key] = value
  }
  return isEmptyOverride(override) ? null : override
}

/**
 * 校验一次「给工作区绑定人设」的请求。
 *
 * @param {{ workspaceId: unknown, persona: unknown }} input
 * @param {Record<string, object>} personas 预设库
 * @returns {{ ok: true, workspaceId: string, persona: string, override: object }
 *          | { ok: false, error: string }}
 */
export function validateWorkspaceBinding(input, personas) {
  const workspaceId = input && input.workspaceId
  if (!isWorkspaceKey(workspaceId)) {
    return { ok: false, error: '工作区标识无效：必须是非空字符串，且不能是路径' }
  }

  const persona = input && input.persona
  if (typeof persona !== 'string') {
    return { ok: false, error: '人设名必须是字符串' }
  }
  const trimmed = persona.trim()
  if (trimmed === '') {
    return { ok: false, error: '人设名不能为空' }
  }
  // 长度与字符集复用命名校验：允许写入一个「命名不合法」的人设名，等于制造一条
  // 永远无法通过任何界面删除的僵尸覆盖。
  if (trimmed.length > PERSONA_NAME_MAX || sanitizePersonaName(trimmed) === null) {
    return { ok: false, error: `人设名不合法：${trimmed}` }
  }

  const override = overrideFromPersona(trimmed, personas)
  if (override === null) {
    return { ok: false, error: `人设「${trimmed}」不存在（或该人设未声明任何可覆盖字段）` }
  }

  return { ok: true, workspaceId, persona: trimmed, override }
}
