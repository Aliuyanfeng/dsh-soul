// lib/history.mjs — dsh-soul 变更审计（append-only JSONL + 回滚规划，无 cordis 依赖）
//
// 职责：
//   - 把一次配置变更写成一个条目（时间戳 / 来源 / 动作 / 字段级 before→after / 预设库事件）
//   - 读取记录文件，并把「不可解析的行」「超长行」「过大的文件」「截断的尾行」如实报告出来
//   - 规划回滚：从当前配置逐条反向还原到目标条目**之后**的状态
//
// 四条设计前提，改本模块前请先读：
//
//   1. 记录文件是**不可信输入**。用户可以手改、别的工具可以写坏、进程可以在写入中途被杀。
//      所以读侧的每一行都要重新校验，非法行丢弃并计数 —— 绝不让一条坏行把整个列表打不开。
//   2. 条目只存**发生变化的字段**，不是完整快照。一次 style 改动不该在磁盘上留下 4.8 KB，
//      而且 `professional → humorous` 比两份快照更适合人读。代价是回滚必须**逐条反向还原**
//      （见 planRollback），因此每条都带一份 configHash 作为链式指纹。
//   3. 指纹只覆盖 AUDIT_FIELDS 这一冻结投影。配了很多字段却不算变更（见 AUDIT_FIELDS 注释）
//      的原因必须记在这里：哈希一旦把「无关字段」算进去，回滚会因为一次外观调整而拒绝工作。
//   4. 本模块只负责如实报告，不替调用方决定要不要回退 —— 与 lib/store.mjs 同一条约定，
//      可被 scripts/verify-history.mjs 独立加载并针对真实文件系统测试。

import { appendFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { DEFAULT_CONFIG, PERSONA_FIELDS, PERSONA_META_KEYS, PERSONA_NAME_MAX, sanitizeConfig } from './config.mjs'

// ==================== 契约常量 ====================

// 条目格式版本。读到 `v !== HISTORY_VERSION` 的条目一律丢弃（而不是猜测字段语义）：
// 升级后旧条目的含义无法保证，宁可少一条记录，也不能按错的方式还原配置。
export const HISTORY_VERSION = 1

// 来源（UI 上的「谁」徽标）与动作（UI 上的「做了什么」）。两者都是**枚举白名单**而不是
// 正则：写错一个来源标签应当在断言里当场变红，而不是安静地存进文件、等 UI 显示空白。
export const HISTORY_SOURCES = ['web', 'command', 'tool', 'service', 'persona', 'rollback', 'restorePersona']
export const HISTORY_ACTIONS = [
  'save',
  'reset',
  'use',
  'savePreset',
  'deletePreset',
  'restorePreset',
  'rollback',
  'nickname',
  'enable',
  'disable',
  'set',
  'confirm',
  'setPersona',
  'update'
]

// 保留条目数上限（默认值）。压实只丢**最老的**，于是保留下来的永远是完整日志的
// 一个后缀 —— 这是 planRollback 能安全工作的前提（见那里的注释）。
// 实际上限由配置字段 historyMaxEntries 决定（clampHistoryMaxEntries 夹在 50–500），
// 这里只作调用方未传时的兜底；数值必须与 lib/config.mjs 的
// HISTORY_MAX_ENTRIES_DEFAULT 一致，由 verify-config 钉住。
export const MAX_ENTRIES = 200

// 触发压缩的字节阈值。幸福路径只有一次 stat，压缩是低频动作。
export const MAX_BYTES = 512 * 1024

// 单行上限。超长行直接丢弃（否则一份手写的畸形文件可以把内存吃满）。
export const MAX_LINE_BYTES = 64 * 1024

// 单次读取上限：文件大于它时只读**尾部**这么多字节，再丢掉被截断的首行。
// 不能直接 readFile —— 用户手改出一个 200 MB 的文件就能把宿主进程拖死。
export const MAX_READ_BYTES = 4 * 1024 * 1024

// 单次解析行数上限（兜底，防「很多条短行」这种绕过字节上限的形状）。
// 注意是保留**尾部**行：日志的价值集中在最近，从头截断会把最该看到的几条丢掉。
export const MAX_READ_LINES = 1000

// ★ AUDIT_FIELDS：参与指纹与差分的字段全集，从 DEFAULT_CONFIG 推导且**只算一次**。
//
// 为什么必须是一个冻结的投影而不是「配置对象里除 personas 外的所有键」：
// commitConfig 的 mutate 收到的 `current` 是 loadConfig 的产物，可能夹带内存态字段
// （缓存、派生值……）。若把这些也算进 configHash，一次「不影响任何持久字段」的内部
// 改动就会改动哈希 —— 表现为回滚突然报 diverged，而用户什么都没做。
// 反过来，从 DEFAULT_CONFIG 推导而不是另抄一份，是为了让将来加字段时两边不会漂移
// （漂移的表现是「新字段的变更静默丢失」，极难发现）。
//
// personas **刻意不在其中**：预设库的变化单独记为事件（见 diffPersonas），
// 且不参与指纹。否则「先在预设库里存一个，再撤销一次 style 改动」会因哈希不匹配
// 而拒绝回滚 —— 两件毫不相干的事互相干扰。
const AUDIT_FIELDS = Object.freeze(Object.keys(DEFAULT_CONFIG).sort())

// 原型污染键：出现在 before/after/personas 里一律丢弃。
// 注意与 lib/config.mjs 的 FORBIDDEN_PERSONA_NAMES 是**两处**独立防线 ——
// 那边管预设名，这边管配置字段与预设事件名，谁也不该依赖对方。
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

const AUDIT_FIELD_SET = new Set(AUDIT_FIELDS)
const ID_PATTERN = /^[0-9a-z]{1,12}-[0-9a-f]{6}$/
const HASH_PATTERN = /^[0-9a-f]{64}$/

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function auditFields() {
  return AUDIT_FIELDS.slice()
}

// ==================== 路径与 id ====================

// 记录文件是配置文件的**兄弟文件**：$DSH_HOME/soul-config.json → $DSH_HOME/soul-config.history.jsonl
export function historyPathFor(configPath) {
  const path = String(configPath || '')
  if (path.endsWith('.json')) return `${path.slice(0, -'.json'.length)}.history.jsonl`
  return `${path}.history.jsonl`
}

// 6 位随机十六进制。毫秒时间戳不足以保证唯一（写队列虽然串行，但同一毫秒内完成两次
// 写入完全正常），所以随机段是必需的，不是装饰。
export function randomSuffix() {
  return randomBytes(3).toString('hex')
}

export function createEntryId(nowMs, suffix) {
  return `${Number(nowMs).toString(36)}-${suffix}`
}

// ==================== 指纹 ====================

// 深度按键名排序，供哈希前做规范序列化。
//
// 为什么必须排序：JSON.stringify 的键序取决于对象属性的插入顺序，而配置对象在
// 「写入时构造」与「从磁盘读回后重建」两条路径上的键序不保证一致。不排序的话，
// 同一份配置会算出两个指纹，链式校验就会把完全正常的状态判成「不一致」。
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isPlainObject(value)) {
    const out = {}
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key])
    return out
  }
  return value
}

// 配置指纹：链式校验的判据（见 planRollback）。只覆盖 AUDIT_FIELDS 这一投影，
// 因此「与审计无关的键」无论怎么变都不会动摇链条。
export function hashConfig(config) {
  const source = isPlainObject(config) ? config : {}
  const projection = {}
  for (const key of AUDIT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(source, key)) projection[key] = source[key]
  }
  return createHash('sha256').update(JSON.stringify(canonicalize(projection))).digest('hex')
}

// ==================== 差分 ====================

// 活动配置的字段级差分（跳过 personas —— 它由 diffPersonas 单独处理）。
// 与 index.mjs 的 diffKeys 分工不同：那个只回答「有没有变、要不要刷新提示词」，
// 这个要留下「从什么变成什么」。
export function diffFields(previous, next) {
  const before = {}
  const after = {}
  const from = isPlainObject(previous) ? previous : {}
  const to = isPlainObject(next) ? next : {}
  for (const key of AUDIT_FIELDS) {
    if (from[key] === to[key]) continue
    // 「切到 undefined」无法表达（JSON 里会凭空消失），记下来只会在回滚时误导，
    // 所以两边都缺席时直接不记。
    if (from[key] === undefined && to[key] === undefined) continue
    if (from[key] !== undefined) before[key] = from[key]
    if (to[key] !== undefined) after[key] = to[key]
  }
  return { before, after }
}

// 预设库白名单过滤：只留 PERSONA_FIELDS 内的人设字段与 PERSONA_META_KEYS 里的元数据。
// 复用 lib/config.mjs 的白名单 —— 记录里的预设内容最终会被写回磁盘，
// 过滤规则必须与磁盘归一化完全一致，否则「恢复此预设」会恢复出一个
// normalizePersonas 下次读盘时会悄悄削掉的东西。
function pickPersonaFields(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (PERSONA_FIELDS.includes(key) || PERSONA_META_KEYS.has(key)) out[key] = raw[key]
  }
  return out
}

// 预设「内容」的指纹：只比 PERSONA_FIELDS，**刻意不比 updatedAt**。
//
// updatedAt 每次保存都会变。把它算进来，用户「原样再存一遍」就会留下一条
// 「覆盖了预设 X」的记录 —— 而覆盖之所以要留底，是因为它会丢掉原内容；
// 内容没丢就不该报。假记录比漏记更糟：它会让时间线失去可信度。
function personaSignature(raw) {
  const content = {}
  if (isPlainObject(raw)) {
    for (const key of PERSONA_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(raw, key)) content[key] = raw[key]
    }
  }
  return JSON.stringify(canonicalize(content))
}

// 预设库事件：新增 / 覆盖 / 删除。
//
// 为什么不能省：index.mjs 的 diffKeys 里有 `if (key === 'personas') continue`（那是刻意的
// —— 预设库不是活动配置、不该触发提示词刷新）。于是预设的增删改**不会**出现在 changed 里，
// 审计必须显式记录，否则「新增了一个预设」会静默漏记。
//
// 为什么覆盖（updated）也要带原内容：删除是明显的不可逆操作，覆盖则容易被人忽略 ——
// 「存为预设」用一个已存在的名字，原条目就没了。二者都只有这里留底。
export function diffPersonas(previous, next) {
  const prev = isPlainObject(previous) ? previous : {}
  const nxt = isPlainObject(next) ? next : {}
  const added = []
  const updated = []
  const removed = []
  for (const name of Object.keys(nxt)) {
    if (FORBIDDEN_KEYS.has(name)) continue
    if (!Object.prototype.hasOwnProperty.call(prev, name)) added.push(name)
    else if (personaSignature(prev[name]) !== personaSignature(nxt[name])) {
      updated.push({ name, entry: pickPersonaFields(prev[name]) })
    }
  }
  for (const name of Object.keys(prev)) {
    if (FORBIDDEN_KEYS.has(name)) continue
    if (!Object.prototype.hasOwnProperty.call(nxt, name)) {
      removed.push({ name, entry: pickPersonaFields(prev[name]) })
    }
  }
  return { added, updated, removed }
}

export function hasPersonaEvents(events) {
  return !!events && (events.added.length > 0 || events.updated.length > 0 || events.removed.length > 0)
}

// ==================== 条目构造与校验 ====================

// 组装一条记录。任一必填项不合法时返回 null（调用方据此跳过审计，而不是写半条进去）。
//
// label 是可选的人类可读上下文（如「应用了哪个预设」「哪个斜杠命令」）：
// 它不参与指纹、不参与回滚，只是给时间线看的 —— 所以归一化时超长就丢弃而不是整条拒收。
export function buildHistoryEntry({ id, at, source, action, configHash, before, after, personas, label }) {
  return normalizeHistoryEntry({
    v: HISTORY_VERSION,
    id,
    at,
    source,
    action,
    configHash,
    before: pickConfigFields(before),
    after: pickConfigFields(after),
    personas: hasPersonaEvents(personas) ? personas : { added: [], updated: [], removed: [] },
    label
  })
}

// 校验并归一化一条记录（也用于读侧）。任何一处不对就整条丢弃。
//
// 严格是刻意的：回滚会把条目里的值写回配置，一条形状可疑的记录宁可丢掉。
// 丢掉的代价是「少一条历史」，接受的代价是「写出一个谁都没见过的配置」。
export function normalizeHistoryEntry(raw) {
  if (!isPlainObject(raw)) return null
  if (raw.v !== HISTORY_VERSION) return null
  if (typeof raw.id !== 'string' || raw.id.length > 64 || !ID_PATTERN.test(raw.id)) return null
  if (typeof raw.at !== 'string' || raw.at.length > 40 || !Number.isFinite(Date.parse(raw.at))) return null
  if (!HISTORY_SOURCES.includes(raw.source)) return null
  if (!HISTORY_ACTIONS.includes(raw.action)) return null
  if (typeof raw.configHash !== 'string' || !HASH_PATTERN.test(raw.configHash)) return null

  const before = pickConfigFields(raw.before)
  const after = pickConfigFields(raw.after)
  const personas = normalizePersonaEvents(raw.personas)
  // 空条目（什么都没变）不入账：每次点「保存」都刷一条噪声，列表很快就没法用了。
  if (Object.keys(before).length === 0 && Object.keys(after).length === 0 && !hasPersonaEvents(personas)) return null

  // label 是展示用的可选字段：旧记录没有它照常解析（向后兼容），超长或非字符串就丢弃 ——
  // 它不影响指纹与回滚，犯不着为一句文案拒绝整条记录。
  const label = typeof raw.label === 'string' && raw.label.trim() !== '' && raw.label.length <= LABEL_MAX
    ? raw.label
    : undefined
  const entry = { v: HISTORY_VERSION, id: raw.id, at: raw.at, source: raw.source, action: raw.action, configHash: raw.configHash, before, after, personas }
  if (label !== undefined) entry.label = label
  return entry
}

// label 上限：预设名上限（PERSONA_NAME_MAX）之外再留些余量给组合文案；JSONL 单行上限
// （MAX_LINE_BYTES = 64 KiB）远远够不到，这个值是「显示层不跑马」的约束，不是安全边界。
const LABEL_MAX = 120

function pickConfigFields(raw) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (AUDIT_FIELD_SET.has(key)) out[key] = raw[key]
  }
  return out
}

function normalizePersonaEvents(raw) {
  const added = []
  const updated = []
  const removed = []
  if (isPlainObject(raw)) {
    if (Array.isArray(raw.added)) {
      for (const name of raw.added) {
        if (typeof name !== 'string' || !name || name.length > PERSONA_NAME_MAX) continue
        if (FORBIDDEN_KEYS.has(name)) continue
        added.push(name)
      }
    }
    for (const [field, target] of [
      ['updated', updated],
      ['removed', removed]
    ]) {
      if (!Array.isArray(raw[field])) continue
      for (const item of raw[field]) {
        if (!isPlainObject(item)) continue
        const name = item.name
        if (typeof name !== 'string' || !name || name.length > PERSONA_NAME_MAX) continue
        if (FORBIDDEN_KEYS.has(name)) continue
        target.push({ name, entry: pickPersonaFields(item.entry) })
      }
    }
  }
  return { added, updated, removed }
}

export function serializeEntry(entry) {
  return `${JSON.stringify(entry)}\n`
}

// ==================== JSONL 解析 ====================

// 解析记录文件全文。返回 { entries, dropped, trimmed, truncated }：
//   - entries  ：按文件物理顺序（最老在前）的合法条目
//   - dropped  ：被丢弃的行数（坏 JSON / 形状不对 / 超长 / 末尾半行）
//   - trimmed  ：因为超出条数上限而没被读到的**合法**行数（与 dropped 分开，见下）
//   - truncated：文件末尾没有换行 ⇒ 上一次追加被打断，最后一条记录不完整
//
// truncated 不只是显示用的：它意味着「有一条变更没被记下来」，
// planRollback 的指纹校验会因此失败并拒绝回滚（这正是期望的行为）。
export function parseHistoryText(text) {
  const source = typeof text === 'string' ? text : ''
  const truncated = source.length > 0 && !source.endsWith('\n')
  const lines = source.split('\n')
  // 末尾的换行会在 split 结果里多出一个空元素 —— 它不是一行。
  // 不剥掉的话它会占掉条数上限里的一个名额，让「最近 1000 条」实际只拿到 999 条。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  // 末尾不完整的半行不参与解析（但仍计入 dropped，如实报告）
  if (truncated) lines.pop()

  let dropped = truncated ? 1 : 0
  // 超出条数上限时丢**最老的**（见 MAX_READ_LINES 注释）。
  // 与 dropped 分开计数：这些行完全合法，只是没被读到 —— 混进 dropped 会让 UI 显示
  // 「有 2512 行无法解析」，而文件里其实一个坏行都没有。
  let trimmed = 0
  let window = lines
  if (lines.length > MAX_READ_LINES) {
    trimmed = lines.length - MAX_READ_LINES
    window = lines.slice(lines.length - MAX_READ_LINES)
  }

  const entries = []
  for (const line of window) {
    const row = line.trim()
    if (!row) continue
    if (Buffer.byteLength(row, 'utf8') > MAX_LINE_BYTES) {
      dropped += 1
      continue
    }
    let raw
    try {
      raw = JSON.parse(row)
    } catch {
      dropped += 1
      continue
    }
    const entry = normalizeHistoryEntry(raw)
    if (entry) entries.push(entry)
    else dropped += 1
  }
  return { entries, dropped, trimmed, truncated }
}

// 只保留最新的 max 条（缺省 MAX_ENTRIES）。
//
// 「丢最老的」不是随手定的：保留了后缀，就意味着任何仍然存在的条目，
// 它之后的每一条也都还在 —— planRollback 从最新往回走时不会踩空。反过来若从中间挖洞，
// 回滚会安静地算出错误结果。
export function pruneEntries(entries, max = MAX_ENTRIES) {
  const list = Array.isArray(entries) ? entries : []
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MAX_ENTRIES
  if (list.length <= limit) return list
  // 取**尾部** limit 条。注意这里不能顺手 sort：条目顺序由文件物理顺序决定，
  // 而时间戳只用于显示（§8「时间戳不参与任何逻辑判定」）—— 按时间排会在同毫秒
  // 或时钟回拨时把顺序搅乱，而顺序正是 planRollback 的判据。
  return list.slice(list.length - limit)
}

export function findEntryIndex(entries, id) {
  const list = Array.isArray(entries) ? entries : []
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return i
  }
  return -1
}

// ==================== 文件 IO ====================

async function readRange(handle, start, length) {
  const buffer = Buffer.alloc(length)
  let filled = 0
  // read() 允许短读（返回的字节数可以小于请求量）。本地文件上通常一次就读满，
  // 但把「短读」当成读完会让解析器看到一段凭空截断的文本 —— 那是难查的偶发 bug。
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
    if (bytesRead <= 0) break
    filled += bytesRead
  }
  return filled === length ? buffer : buffer.subarray(0, filled)
}

export async function readHistoryFile(filePath) {
  let text
  let trimmedHead = false
  try {
    const handle = await open(filePath, 'r')
    try {
      const info = await handle.stat()
      // 目录能被打开发，且 size 为 0 —— 不显式判断的话，一个叫 soul-config.history.jsonl
      // 的目录会安静地读成「还没有任何变更记录」，而文件其实根本读不了。
      // 这正是本模块要避免的那类安静失败：UI 上永远显示空列表，用户无从知道哪里不对。
      if (info.isDirectory()) {
        return { entries: [], dropped: 0, trimmed: 0, truncated: false, trimmedHead: false, error: `变更记录路径是一个目录，无法读取：${filePath}` }
      }
      const start = Math.max(0, info.size - MAX_READ_BYTES)
      if (start > 0) {
        // 只读了尾部 ⇒ 无论首行保不保留，都要如实上报「没有读全」
        // （否则用户看到的是一个静默缩水的列表）。
        trimmedHead = true
        // 再决定首行能不能用：看被切掉的那一个字节是不是换行符。
        //   - 是  → 读取起点正好落在行首，首行是完整的，必须保留；
        //   - 不是 → 起点切在某一行中间，首行是半行，丢掉它。
        // 不判断就一律丢首行，会在「文件大小正好是 MAX_READ_BYTES 的整数倍」这类
        // 巧合下静默少一条记录 —— 而少的那条会影响 planRollback 的指纹校验。
        const probe = await readRange(handle, start - 1, 1)
        const atLineStart = probe.length === 1 && probe[0] === 0x0a
        const tail = await readRange(handle, start, info.size - start)
        text = tail.toString('utf8')
        if (!atLineStart) {
          const cut = text.indexOf('\n')
          text = cut >= 0 ? text.slice(cut + 1) : ''
        }
      } else {
        text = (await readRange(handle, 0, info.size)).toString('utf8')
      }
    } finally {
      await handle.close()
    }
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { entries: [], dropped: 0, trimmed: 0, truncated: false, trimmedHead: false, error: null }
    }
    return { entries: [], dropped: 0, trimmed: 0, truncated: false, trimmedHead: false, error: `变更记录读取失败（${(err && err.code) || 'unknown'}）：${(err && err.message) || err}` }
  }

  return { ...parseHistoryText(text), trimmedHead, error: null }
}

// 追加一条记录。调用方负责把 entry 构造好（buildHistoryEntry 返回非 null）。
export async function appendHistoryEntry(filePath, entry) {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, serializeEntry(entry), 'utf8')
}

// 原子重写整份记录（临时文件 + rename，与 lib/store.mjs 的 writeConfigFile 同一手法）。
export async function rewriteHistoryFile(filePath, entries) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, entries.map(serializeEntry).join(''), 'utf8')
  await rename(tmpPath, filePath)
}

async function historySize(filePath) {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

// 记录一条变更：正常情况追加一行；文件超过 MAX_BYTES 时读回全文、压实、原子重写。
//
// 注意压实会**重新序列化合法条目**：那些被丢弃的坏行随之消失。这是有意为之（自愈），
// 代价是坏行不再出现 —— 所以 dropped 计数必须在读取时就被报告出去，
// 不能等到压缩时才发现「有几行不见了」。
export async function recordHistoryEntry(filePath, entry, maxEntries) {
  const size = await historySize(filePath)
  if (size > MAX_BYTES) {
    const { entries, dropped, error } = await readHistoryFile(filePath)
    if (error) throw new Error(error)
    const kept = pruneEntries(entries.concat(entry), maxEntries)
    await rewriteHistoryFile(filePath, kept)
    return { compacted: true, kept: kept.length, dropped }
  }
  await appendHistoryEntry(filePath, entry)
  return { compacted: false, kept: 0, dropped: 0 }
}

// 清空记录：先读一遍拿到条数（供 UI 报「已清空 N 条」），再删文件。
// 留着空文件只会让「有没有记录」多出第三种状态。
export async function clearHistoryFile(filePath) {
  const { entries } = await readHistoryFile(filePath)
  await rm(filePath, { force: true })
  return entries.length
}

// ==================== 回滚规划 ====================

// 规划一次回滚：**撤销**目标条目以及它之后的所有改动。
//
// 语义是「撤销这一条」，不是「恢复到这一条刚做完的样子」。区别很重要：
// 按后者，点最新那条永远是空操作（你已经在那个状态），而最新那条恰恰是用户最想撤的。
// 更糟的是它的结果与行内容相反 —— 行上写着「style 变成 humorous」，撤销却把
// 「之后那次 emoji 改动」退回去了，style 反而留着。撤销必须把点的那条真正撤掉。
//
// 为什么必须连带撤销它之后的：条目只记变化字段，后一条的 before 是它自己那次改动的
// 前提。跳过中间某条去单独还原更早的字段，会算出一份从未存在过的混合状态。
// 所以结果状态 = 「目标条目发生**之前**」的状态，被撤销的条目 id 一并回报（供 UI 预览）。
//
// 为什么不无脑撤销就好：撤销链假设「记录与配置同步」。一旦不同步（用户手改了
// soul-config.json、或上次进程死在「配置已写、审计未写」之间），撤销出来的就是那份
// 混合状态 —— 比拒绝更糟。所以每一步都先验指纹：当前状态的哈希必须等于该条目的
// configHash，对不上就返回 reason='diverged'，由调用方明确报错。
//
// 返回 { ok, patch, skipped, reversed, reason }：
//   - patch    ：相对当前配置的字段级补丁（已过 sanitizeConfig 白名单）
//   - skipped  ：记录里有、但当前 schema 校验不通过的字段名（如实回报，不静默丢弃）
//   - reversed ：被撤销的条目 id（从新到旧，含目标条目）
export function planRollback(entries, current, targetId) {
  const list = Array.isArray(entries) ? entries : []
  const index = findEntryIndex(list, targetId)
  if (index < 0) return { ok: false, reason: 'missing', patch: {}, skipped: [], reversed: [] }

  let state = isPlainObject(current) ? current : {}
  const newest = list[list.length - 1]
  if (!newest || hashConfig(state) !== newest.configHash) {
    return { ok: false, reason: 'diverged', patch: {}, skipped: [], reversed: [] }
  }

  const reversed = []
  for (let i = list.length - 1; i >= index; i--) {
    const entry = list[i]
    if (hashConfig(state) !== entry.configHash) {
      return { ok: false, reason: 'diverged', patch: {}, skipped: [], reversed: [] }
    }
    state = { ...state, ...entry.before }
    reversed.push(entry.id)
  }

  const rawPatch = {}
  for (const key of AUDIT_FIELDS) {
    if (state[key] === current[key]) continue
    // 缺席与「值为 undefined」在 JSON 里无法区分，喂给 sanitizeConfig 只会换来一条
    // 「必须为字符串」的误报（并被算进 skipped）—— 直接跳过，让它如实缺席。
    if (state[key] === undefined) continue
    rawPatch[key] = state[key]
  }
  const { patch, errors } = sanitizeConfig(rawPatch)
  return { ok: true, reason: null, patch, skipped: Object.keys(errors), reversed }
}

// ==================== 读取结果的对外形状 ====================

// 把读结果整理成 HTTP 响应要用的形状：条目**最新在前**，并附上可展示的警告。
//
// 倒序在服务端做一次：客户端再排一次的话，两边规则迟早漂移，
// 而「列表顺序和实际写入顺序不一致」这种 bug 很难被当成 bug 报出来。
export function toHistoryResponse(read, writeFailure, maxEntries) {
  const warnings = []
  if (read.error) warnings.push(read.error)
  if (typeof writeFailure === 'string' && writeFailure) warnings.push(`变更记录写入失败：${writeFailure}`)
  if (read.truncated) warnings.push('记录文件末尾不完整，最后一次变更可能没有留下记录。')
  if (read.trimmedHead) warnings.push('记录文件较大，只读取了最近的部分。')
  if (read.trimmed > 0) warnings.push(`记录条目较多，只显示了最近的 ${MAX_READ_LINES} 条。`)
  if (read.dropped > 0) warnings.push(`有 ${read.dropped} 行无法解析，已忽略。`)
  return {
    entries: read.entries.slice().reverse(),
    // 上限是**配置里的承诺**，不是模块常量：客户端把「最多保留 N 条」这句话当真，
    // 服务端就必须说自己配置里真正承诺的那个数。
    max: Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : MAX_ENTRIES,
    warning: warnings.length > 0 ? warnings.join(' ') : null
  }
}
