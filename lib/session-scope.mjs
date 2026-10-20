// lib/session-scope.mjs — 会话级人设覆盖（纯函数层 + sidecar 读写）
//
// 职责：
//   - 单个会话覆盖项的形状校验（读侧一律当不可信输入）
//   - sidecar 路径推导（`sha256(sessionId)` 作文件名）
//   - 三阶段回收的状态机（发现候选 → 宽限期 → 可回收）
//
// 五条设计前提，改本模块前请先读：
//
//   1. **会话覆盖是「状态」，不是「配置」。** 它随会话生灭、数量无上界、用户不在意它的
//      变更历史。所以放独立 sidecar（`$DSH_HOME/soul-sessions/`），不进 soul-config.json ——
//      塞进配置会让文件被短命的会话 id 无限撑大（0.8.0 刚为历史文件做过压实）。
//   2. **文件名必须哈希，不能直接拼接 sessionId。** 会话 id 的字符集由宿主决定，
//      没有证据表明它一定对文件系统安全。哈希定长、无歧义，且天然规避 `..` 之类的路径穿越。
//      文件**内容**里另存原始 sessionId，两者必须互相校验 —— 否则改个文件名就能让
//      某个会话读到另一个会话的覆盖。
//   3. **绝不用「agents.list() 里没有」判定会话已删除。** 那是 live registry，
//      会话切走、进程重启都会让它消失，但会话文件仍在磁盘上。用它判定会误删正在使用的
//      覆盖。唯一可信证据是 `sessionPersistence.list()`（扫磁盘）。
//   4. **缺证据时保留，不删除。** 清理是**单向下行**的操作：删错了用户永久丢失设置；
//      留着只是多几个小文件。所以凡是不确定的情况（服务不可用、扫描不完整、宽限期资料
//      缺失）一律不删。
//   5. **本模块不碰宿主 ctx。** 纯函数 + 文件读写，可被脚本独立加载测试（与
//      lib/store.mjs、lib/history.mjs、lib/bindings.mjs 同一条约定）。

import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { moveAsideConfigFile, readConfigFile, writeConfigFile } from './store.mjs'

// ==================== 契约常量 ====================

// sidecar 格式版本。读到不认识的版本时**整条忽略**（并保留文件，见前提 4）：
// 升级后的字段语义无法保证，按错的方式解析会给出一个看似正常、实则错误的人设。
export const SESSION_SCOPE_VERSION = 1

// 一个会话能覆盖的字段白名单。
//
// 与会话级覆盖的目的完全一致：**只改这一次对话的表现**。所以它与人设字段同集合，
// 但**刻意不含** `enabled`（全局总开关，见下）与 `historyMaxEntries`（全局设施）。
export const SESSION_OVERRIDE_FIELDS = Object.freeze([
  'style',
  'headingLists',
  'emoji',
  'tables',
  'replyLength',
  'language',
  'customInstructions'
])

// 任何作用域都不能覆盖的字段。与 lib/workspace-scope.mjs 的 ENVELOPE_ONLY_FIELDS 同义
// （两处独立列举：它们服务不同的数据形状，共享常量会让一处改动悄悄影响另一处）。
export const SESSION_ENVELOPE_ONLY_FIELDS = Object.freeze(['enabled'])

// 会话覆盖的宽限期（毫秒）。30 天。
//
// 这个数字**不是**普适标准，而是一个保守默认：宿主是否支持归档、离线会话、历史恢复
// 都还没有定论（会话文件可能长期存在但不活跃）。宁可留着。
export const ORPHAN_GRACE_MS = 30 * 24 * 60 * 60 * 1000

// 文件名哈希取前多少位。32 个 hex 字符 = 128 bit，碰撞概率可忽略；
// 文件名长度也远在常见文件系统上限之内。
export const FILE_HASH_LENGTH = 32

// sidecar 顶层目录名（相对 `$DSH_HOME`）。
export const SESSION_DIR_NAME = 'soul-sessions'

// sessionId 的长度上限。宿主用 SessionId 品牌类型，实测形如 `session-<uuid>`；
// 给一个宽松上限只为拦住把整段路径塞进 id 这类错误用法。
export const MAX_SESSION_ID_LENGTH = 256

// 单条覆盖的字段数上限（白名单本身只有 7 个，这里防的是异常数据）。
export const MAX_SESSION_OVERRIDE_KEYS = 16

// ==================== 路径与键 ====================

/**
 * 判断一个值能否当作 sessionId。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isSessionId(raw) {
  if (typeof raw !== 'string') return false
  const id = raw.trim()
  if (id === '') return false
  if (id.length > MAX_SESSION_ID_LENGTH) return false
  // 路径分隔符在入口就拒绝：sessionId 不该长成路径，而放行它等于把路径穿越的口子
  // 留给下游（虽然文件名是哈希，但内容里的 sessionId 会被展示与比较）。
  if (id.includes('\\') || id.includes('/')) return false
  if (id === '.' || id === '..') return false
  return true
}

/**
 * 由 sessionId 算出 sidecar 文件名（不含目录）。
 *
 * 用 sha256 而不是转义：转义规则要跟随不同文件系统，哈希定长且无歧义。
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionFileName(sessionId) {
  const digest = createHash('sha256').update(String(sessionId), 'utf8').digest('hex')
  return `${digest.slice(0, FILE_HASH_LENGTH)}.json`
}

/**
 * sidecar 目录路径：与 `soul-config.json` **同级**。
 *
 * 由配置文件路径推导而不是自己拼 `$DSH_HOME`：这样测试把配置指到临时目录时，
 * sidecar 自动跟着走（与 `bindingsPathFor` 同一条约定）。
 *
 * @param {string} configFilePath
 * @returns {string}
 */
export function sessionScopeDirFor(configFilePath) {
  return join(dirname(configFilePath), SESSION_DIR_NAME)
}

/**
 * 单个会话的 sidecar 完整路径。
 * @param {string} configFilePath
 * @param {string} sessionId
 * @returns {string}
 */
export function sessionScopePathFor(configFilePath, sessionId) {
  return join(sessionScopeDirFor(configFilePath), sessionFileName(sessionId))
}

// ==================== 校验 ====================

function isEmptyObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0
}

/**
 * 校验一份覆盖项。
 *
 * @param {unknown} raw
 * @returns {{ override: Record<string, unknown> | null, dropped: string[] }}
 */
export function sanitizeSessionOverride(raw) {
  const dropped = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { override: null, dropped }
  }

  const override = {}
  for (const [key, value] of Object.entries(raw)) {
    if (SESSION_ENVELOPE_ONLY_FIELDS.includes(key)) { dropped.push(key); continue }
    if (!SESSION_OVERRIDE_FIELDS.includes(key)) { dropped.push(key); continue }
    override[key] = value
  }

  if (Object.keys(override).length > MAX_SESSION_OVERRIDE_KEYS) {
    // 超限说明数据被污染了（白名单只有 7 个键），整条丢弃比挑着留更安全。
    return { override: null, dropped: dropped.concat(Object.keys(override)) }
  }

  return { override: isEmptyObject(override) ? null : override, dropped }
}

/**
 * 构造一份新的 sidecar 文档。
 *
 * @param {string} sessionId
 * @param {object} override 已校验的覆盖项
 * @param {number} [now] 可注入的时钟（测试用）
 * @param {string} [personaName] 用户实际选中的预设名（见下方说明）
 * @returns {object}
 */
export function createSessionScopeDoc(sessionId, override, now = Date.now(), personaName = null) {
  const iso = new Date(now).toISOString()
  const doc = {
    schemaVersion: SESSION_SCOPE_VERSION,
    sessionId,
    overrides: { ...override },
    createdAt: iso,
    updatedAt: iso
  }
  // personaName：**用户实际选了哪个预设**。
  //
  // 为什么必须单独记：覆盖项本身只存字段（style/headingLists/…），不记预设名。
  // 而「当前生效的是哪个预设」原先是**靠字段反查**出来的（findActivePersonaName：
  // 拿当前配置去比每个预设，谁匹配上就是它，多个匹配时按名称排序取首个）。
  // 这个反查在「两个预设声明了相同字段」时不确定：实测用户自建「游戏策划与开发专家」
  // 与内置「自驱型协作者」字段一致时，名称排序让自建的那个抢先命中 ——
  // 用户明明点了「自驱型协作者」，界面却显示「游戏策划与开发专家」。
  //
  // 记下名字就把「猜」变成了「知道」。字段仍照旧存（模型只认字段，
  // 名字只是给人看的注解），两者并存不冲突。
  if (typeof personaName === 'string' && personaName !== '') {
    doc.personaName = personaName
  }
  return doc
}

/**
 * 解析 sidecar 文档（读侧一律当不可信输入）。
 *
 * 三种失败都必须**区分开**，因为调用方的处理不同：
 *   - 形状/版本不对 → 忽略内容，但**保留文件**（可能是更新的版本写的）
 *   - sessionId 与文件名不符 → 忽略内容，保留文件（防错配）
 *   - 覆盖项为空 → 视为"没有覆盖"，可安全删除
 *
 * @param {unknown} raw
 * @param {string} expectedSessionId 文件名推导出的期望 id
 * @returns {{ override: object | null, failure: string | null, orphan: object | null, doc: object | null }}
 */
export function parseSessionScopeDoc(raw, expectedSessionId) {
  const empty = { override: null, failure: null, orphan: null, doc: null }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...empty, failure: 'sidecar 不是 JSON 对象' }
  }

  const version = raw.schemaVersion
  if (version !== SESSION_SCOPE_VERSION) {
    return { ...empty, failure: `sidecar 版本 ${String(version)} 不认识（当前支持 ${SESSION_SCOPE_VERSION}）` }
  }

  // sessionId 必须与文件内容一致：改个文件名就能让某个会话读到另一个会话的覆盖。
  if (typeof raw.sessionId !== 'string' || raw.sessionId !== expectedSessionId) {
    return { ...empty, failure: `sidecar 内的 sessionId 与文件名不符（文件里是 ${String(raw.sessionId)}）` }
  }

  const { override } = sanitizeSessionOverride(raw.overrides)
  const orphan = parseOrphanState(raw.orphan)

  // personaName：用户实际选的预设名。缺失（老版本 sidecar）或不是字符串都当作没有 ——
  // 调用方会退回「按字段反查」，那是不确定但可用的旧路径。
  const personaName = typeof raw.personaName === 'string' && raw.personaName !== ''
    ? raw.personaName
    : null

  return {
    override,
    failure: null,
    orphan,
    personaName,
    doc: {
      schemaVersion: SESSION_SCOPE_VERSION,
      sessionId: expectedSessionId,
      overrides: override,
      personaName,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null
    }
  }
}

/**
 * 解析孤儿标记。缺失即「从未被标记」。
 * @param {unknown} raw
 * @returns {{ firstSeenAt: string, lastScannedAt: string } | null}
 */
function parseOrphanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const firstSeenAt = typeof raw.firstSeenAt === 'string' ? raw.firstSeenAt : null
  if (firstSeenAt === null) return null
  // firstSeenAt 必须是可解析的时间：解析不了等于没有资料，按「未标记」处理更安全
  if (!Number.isFinite(Date.parse(firstSeenAt))) return null
  return {
    firstSeenAt,
    lastScannedAt: typeof raw.lastScannedAt === 'string' ? raw.lastScannedAt : firstSeenAt
  }
}

// ==================== 回收状态机 ====================

/**
 * 判定一个 sidecar 在**本轮扫描**下的状态。
 *
 * 这是整个回收逻辑的核心，纯函数、可穷举测试。三阶段对应设计 §5.2：
 *
 *   阶段 1「发现候选」：本轮扫描成功且该 id 不在磁盘会话清单里 → 写入 orphan.firstSeenAt
 *   阶段 2「宽限期」  ：已有 orphan 但未满 30 天 → 不删；若该 id 重新出现 → 撤销标记
 *   阶段 3「可回收」  ：已有 orphan、满 30 天、且本轮扫描**完整成功** → 才允许删
 *
 * 「本轮扫描成功」是**独立的一票否决**：如果持久化层不可用，30 天只度量了
 * 「我们多久没检查」，不能拿来当删除依据。
 *
 * @param {object} input
 * @param {{ firstSeenAt: string } | null} input.orphan 现有标记
 * @param {boolean} input.presentOnDisk 该会话是否在本轮磁盘清单里
 * @param {boolean} input.scanComplete 本轮扫描是否完整成功
 * @param {number} [input.now]
 * @param {number} [input.graceMs]
 * @returns {{ action: 'keep' | 'mark' | 'clear-mark' | 'collect', orphan: object | null, reason: string }}
 */
export function decideSessionScopeFate(input) {
  const now = Number.isFinite(input.now) ? input.now : Date.now()
  const graceMs = Number.isFinite(input.graceMs) ? input.graceMs : ORPHAN_GRACE_MS
  const current = input.orphan || null

  // 会话还在磁盘上 —— 无论之前有没有标记，都要撤销候选状态。
  if (input.presentOnDisk) {
    if (current !== null) {
      return { action: 'clear-mark', orphan: null, reason: '会话重新出现，撤销孤儿标记' }
    }
    return { action: 'keep', orphan: null, reason: '会话存在' }
  }

  // 会话不在清单里，但本轮扫描不完整 —— **不标记、不删除**。
  // 这一步是「缺证据时保留」的直接落地：扫描不完整意味着"没看到"不等于"不存在"。
  if (!input.scanComplete) {
    return { action: 'keep', orphan: current, reason: '本轮扫描不完整，不做任何判定' }
  }

  // 第一次发现缺席：标记候选，不删除。
  if (current === null) {
    return {
      action: 'mark',
      orphan: { firstSeenAt: new Date(now).toISOString(), lastScannedAt: new Date(now).toISOString() },
      reason: '首次发现会话缺席，标记为候选'
    }
  }

  const firstSeen = Date.parse(current.firstSeenAt)
  if (!Number.isFinite(firstSeen)) {
    // 标记里的时间坏了：当作"刚发现"，重新计时（宁可多留 30 天）
    return {
      action: 'mark',
      orphan: { firstSeenAt: new Date(now).toISOString(), lastScannedAt: new Date(now).toISOString() },
      reason: '孤儿标记的时间不可解析，重新计时'
    }
  }

  const age = now - firstSeen
  if (age < graceMs) {
    return {
      action: 'keep',
      orphan: { firstSeenAt: current.firstSeenAt, lastScannedAt: new Date(now).toISOString() },
      reason: `宽限期内（剩余 ${Math.ceil((graceMs - age) / (24 * 3600 * 1000))} 天）`
    }
  }

  return {
    action: 'collect',
    orphan: current,
    reason: `缺席已超过 ${Math.round(graceMs / (24 * 3600 * 1000))} 天，且本轮扫描完整`
  }
}

// ==================== 文件读写 ====================

/**
 * 读一个会话的 sidecar。
 *
 * 与 lib/store.mjs 的 `readConfigFile` 同一套语义（不存在 / 可读 / 损坏三分），
 * 但**不做自动备份**：sidecar 是"状态"，损坏时忽略即可，不需要惊动用户。
 * 真正的隔离（改名 `.bad`）由 GC 命令显式执行 —— 那是一个可审计的动作。
 *
 * @param {string} filePath
 * @param {string} expectedSessionId
 * @returns {Promise<{ override: object | null, failure: string | null, orphan: object | null, doc: object | null, exists: boolean }>}
 */
export async function readSessionScope(filePath, expectedSessionId) {
  const { value, exists, failure } = await readConfigFile(filePath)
  if (!exists) return { override: null, failure: null, orphan: null, doc: null, exists: false }
  if (failure) {
    return { override: null, failure: `读取失败：${failure.message}`, orphan: null, doc: null, exists: true }
  }
  const parsed = parseSessionScopeDoc(value, expectedSessionId)
  return { ...parsed, exists: true }
}

/**
 * 写一个会话的 sidecar（原子替换）。
 * @param {string} filePath
 * @param {object} doc
 * @returns {Promise<void>}
 */
export async function writeSessionScope(filePath, doc) {
  await writeConfigFile(filePath, doc)
}

/**
 * 把损坏 / 不可用的 sidecar 移开（`.bad` 后缀）。
 *
 * 只在**显式清理**时调用，绝不在读取路径上自动执行：读取是每轮都可能发生的，
 * 让它产生副作用会让"看一眼会话"变成"改了磁盘"。
 *
 * @param {string} filePath
 * @returns {Promise<string | null>} 移开后的路径；移不动返回 null
 */
export async function quarantineSessionScope(filePath) {
  return await moveAsideConfigFile(filePath)
}

/**
 * 列出 sidecar 目录里的全部候选文件（不读内容）。
 *
 * 目录不存在时返回空数组而不抛错：首次使用就是"没有覆盖"。
 * @param {string} dir
 * @returns {Promise<Array<{ name: string, path: string, size: number, mtimeMs: number }>>}
 */
export async function listSessionScopes(dir) {
  let names
  try {
    names = await readdir(dir)
  } catch (err) {
    if (err && err.code === 'ENOENT') return []
    throw err
  }

  const out = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(dir, name)
    try {
      const info = await stat(path)
      if (!info.isFile()) continue
      out.push({ name, path, size: info.size, mtimeMs: info.mtimeMs })
    } catch {
      // 单个文件 stat 失败（被并发删除 / 权限）：跳过，不让整次扫描失败
      continue
    }
  }
  return out
}

/**
 * 由文件名反查 sessionId。
 *
 * 哈希是**单向**的，所以无法从文件名还原 id。调用方必须读文件内容拿 id，
 * 并校验内容与文件名是否互相对应（见 parseSessionScopeDoc）。
 *
 * 这个函数存在只是为了把"为什么不能反查"写进代码（避免将来有人试图用文件名当键）。
 * @returns {null}
 */
export function sessionIdFromFileName() {
  return null
}
