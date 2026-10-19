// lib/bindings.mjs — dsh-soul 人设工作区绑定（路径规范化 + 前缀匹配 + 绑定表校验）
//
// 职责：
//   - 目录路径的规范化（统一分隔符、去尾分隔符、解析符号链接 / Junction）
//   - 目录与绑定项的前缀匹配（**必须落在路径边界上**，见 pathMatches）
//   - 绑定表的校验与序列化（读侧一律当不可信输入）
//
// 五条设计前提，改本模块前请先读：
//
//   1. **目录是主键，不是会话。** 宿主 `dsh-subagent` 让子代理原样继承父会话的
//      `session.header.cwd`，却给它一个全新的 sessionId。纯会话键的方案下，主会话里
//      生效的人设到了子代理会**静默回落**到全局配置，且没有任何地方能提示用户。
//      参见 docs/DESIGN-persona-scope.md §2。
//   2. **前缀匹配必须落在路径边界上。** 裸 startsWith 会让 `D:\项目A` 命中
//      `D:\项目AB`。这条规则只有 pathMatches 一处实现，并有独立断言守着 —— 它是
//      整个功能里最容易写错、错了以后表现得「像随机」的一行。
//   3. **路径规范化只用于比较，展示用原样。** 绑定表里存的键是规范化后的**展示形态**
//      （分隔符统一、无尾分隔符、**不折大小写**）；大小写折算只发生在 compareKey 里。
//      否则用户在设置页看到的目录名会与他磁盘上的不一致。
//   4. **符号链接与 Junction 必须解析。** 这不是理论问题：本机
//      `profiles\desktop\node_modules\dsh-soul` 就是 Junction。解析失败（目录已删、
//      网络盘离线）时**保留原样**，绝不报错 —— 一块离线盘不该让整个设置页崩掉。
//   5. **本模块只负责如实报告，不替调用方决定要不要回退** —— 与 lib/store.mjs、
//      lib/history.mjs 同一条约定，可被 scripts/verify-config.mjs 独立加载测试。
//
// 为什么绑定表是独立文件（`$DSH_HOME/soul-bindings.json`）而不是人设条目的一个字段：
// 绑定是**本机环境事实**，不是人设的属性。同一份「资深架构师」在台式机与笔记本上绑的
// 目录必然不同。放进人设条目会立刻带来三个问题：导出人设会带出本机绝对路径、内置人设
// 不能带路径（它随插件分发）、删人设时绑定该不该一起消失无从定义。
// 独立表里「绑定指向不存在的人设名 ⇒ 该条失效但保留」是个干净的答案。

import { realpath } from 'node:fs/promises'
import { PERSONA_NAME_MAX, sanitizePersonaName } from './config.mjs'
import { resolvePersona } from './personas.mjs'
import { moveAsideConfigFile, readConfigFile, writeConfigFile } from './store.mjs'

// ==================== 契约常量 ====================

// 绑定表格式版本。读到不认识的版本时**整表忽略**（而不是猜测字段语义）：
// 升级后的键含义无法保证，宁可暂时不生效，也不能按错的方式解析出一堆假绑定。
export const BINDINGS_VERSION = 1

// 绑定目录的路径长度上限。超限**拒绝写入**而不是截断 —— 截断出来的路径仍然
// 「看起来像个路径」，但它再也不会命中任何会话，用户只会觉得绑定莫名其妙不生效。
export const MAX_PATH_LENGTH = 512

// 绑定条数上限。每轮装配都要扫一遍绑定表，条数必须有界；200 与变更记录的
// MAX_ENTRIES 同值，是「远超任何真实用法、又小到能一眼看完」的量级。
export const MAX_BINDINGS = 200

// 平台默认值：分隔符与「大小写是否不敏感」。
//
// 两者都做成可传入的选项（而不是直接读 process.platform），是为了让断言能在同一台
// 机器上同时验证两套语义 —— 否则 CI（ubuntu）与开发机（Windows）跑出的结论不同，
// 「绿」的含义就跟着变了。
const PLATFORM_SEP = process.platform === 'win32' ? '\\' : '/'
const PLATFORM_CASE_INSENSITIVE = process.platform === 'win32'

// 禁用作绑定目录键的保留字（防原型污染）。JSON.parse 对 `"__proto__"` 会生成
// **自有属性**，随后 `out[key] = value` 就会改写原型而不是加一条绑定。
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function resolveOptions(options) {
  const sep = options && typeof options.sep === 'string' && options.sep.length === 1
    ? options.sep
    : PLATFORM_SEP
  const caseInsensitive = options && options.caseInsensitive !== undefined
    ? Boolean(options.caseInsensitive)
    : PLATFORM_CASE_INSENSITIVE
  return { sep, caseInsensitive }
}

// ==================== 路径规范化 ====================

// 判断一个（已规范的）路径是不是绝对路径。
//
// 刻意同时接受三种形态，而不按平台分叉：POSIX 根（`/…`）、Windows 盘符（`D:\…` / `D:/…`）、
// UNC（`\\server\share`）。在 POSIX 上多认一个 `D:\…` 是无害的（它永远不可能等于真实的
// 会话 cwd），而在 Windows 上漏认一种却是实打实的功能缺失。
//
// `D:项目A`（盘符相对路径）**不算**绝对路径 —— 它的含义取决于该盘当时的当前目录。
export function isAbsoluteDirPath(raw) {
  if (typeof raw !== 'string') return false
  const text = raw.trim()
  if (text === '') return false
  if (/^[\\/]/.test(text)) return true
  return /^[A-Za-z]:[\\/]/.test(text)
}

// 把任意用户输入（手输、粘贴、系统选择器返回）规范成统一的展示形态：
//   - 分隔符统一成 sep（Windows 下 `\`，POSIX 下 `/`）
//   - 折叠连续分隔符
//   - 去掉尾部分隔符（盘根 `D:\` 与 POSIX 根 `/` 除外）
//   - 保留 UNC 前缀 `\\`
//
// **不折大小写**：这是展示形态，用户看到的名字必须和他磁盘上的一致。
// 非法输入（非字符串 / 空串 / 含 NUL）返回 null，由调用方决定怎么回话。
//
// **不解析 `.` / `..`**：那需要文件系统（或至少一套纯文本折叠规则），归 resolveDirIdentity
// 的 realpath 管。这里不做的后果是**失败方向安全**的 —— `D:\项目A\sub\..` 会原样留下来
// 成为一条永远命中不了的绑定（会话 cwd 由宿主给出，永远是干净形态），而不是错命中
// 别的目录。反过来若在这里用文本规则折叠 `..`，`D:\项目A\sub\..` 会被折成 `D:\项目A`，
// 而 `sub` 是符号链接时这个折叠结果是**错的**。
export function normalizeDirPath(raw, options) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (text === '' || text.includes('\0')) return null

  const { sep } = resolveOptions(options)

  let prefix = ''
  let body = text
  // UNC 前缀先摘出来，否则下面「折叠连续分隔符」会把 `\\server` 折成 `\server`。
  //
  // 只在 Windows 分隔符下识别：POSIX 的 `//` 按规矩等同于 `/`（路径里的双斜杠是
  // 实现定义行为，没有 UNC 语义），若在这里也当成 UNC，`//` 会被原样保留下来，
  // 于是它与 `/` 成了两条不同的绑定。
  if (sep === '\\') {
    const uncMatch = /^[\\/]{2,}/.exec(body)
    if (uncMatch) {
      prefix = sep + sep
      body = body.slice(uncMatch[0].length)
    }
  }

  body = body.replace(/[\\/]+/g, sep)

  // 去尾分隔符。循环而不是一次正则：`D:\项目A\\` 折叠后仍可能留下一个尾分隔符。
  while (body.length > 1 && body.endsWith(sep)) {
    body = body.slice(0, -1)
  }
  // 盘根去掉尾分隔符后会变成 `D:`，那不是合法路径形态，补回来
  if (/^[A-Za-z]:$/.test(body)) body += sep

  const out = prefix + body
  return out === '' ? null : out
}

// 比较键：在展示形态之上再折一次大小写（仅 Windows 语义下）。
// 单独一个函数是为了让「存原样、比折叠」这条规则只有一处实现 —— 任何直接拿
// 展示形态去比的地方都会在 `D:\项目A` 与 `d:\项目a` 上得出错误结论。
export function compareKey(path, options) {
  if (typeof path !== 'string') return ''
  const { caseInsensitive } = resolveOptions(options)
  return caseInsensitive ? path.toLowerCase() : path
}

// 解析目录的真实身份（解析符号链接 / Junction）。
//
// 目标不存在（目录被删、网络盘离线、权限不足）时**回落到规范化形态**，绝不抛错：
// 绑定表里存着一条指向已拔掉的移动硬盘的规则，不该让整个设置页或装配流程崩掉。
//
// realpathFn 可注入（默认 node:fs 的 realpath），使本函数能在离线断言里被确定性地测试。
export async function resolveDirIdentity(raw, options, realpathFn) {
  const normalized = normalizeDirPath(raw, options)
  if (!normalized) return null

  const run = realpathFn || realpath
  try {
    const real = await run(normalized)
    return normalizeDirPath(real, options) || normalized
  } catch {
    return normalized
  }
}

// ==================== 前缀匹配 ====================

// 目录 candidate 是否落在绑定项 bound 的子树内。
//
// 这是整个功能的核心判据，写成 `candidate === bound || candidate.startsWith(bound + sep)`：
//   · 前半段处理「恰好就是这个目录」；
//   · 后半段的 `+ sep` 是**必须**的 —— 少了它，`D:\项目A` 会命中 `D:\项目AB`，
//     而这两个目录在磁盘上毫无关系。
//
// bound 以 sep 结尾时（盘根 `D:\`、POSIX 根 `/`）不再重复追加，否则会拼出 `D:\\`。
export function pathMatches(candidate, bound, options) {
  const candidateKey = compareKey(candidate, options)
  const boundKey = compareKey(bound, options)
  if (candidateKey === '' || boundKey === '') return false
  if (candidateKey === boundKey) return true

  const { sep } = resolveOptions(options)
  const prefix = boundKey.endsWith(sep) ? boundKey : boundKey + sep
  return candidateKey.startsWith(prefix)
}

// 列出命中 candidate 的全部绑定，**按具体程度从高到低**（最长前缀优先）。
//
// 返回数组而不是单个结果，是因为上层还需要「最近的一条绑了个已不存在的人设」这种
// 中间信息：它必须回落到父级绑定而不是直接掉到全局，而 UI 又要能把这层说明白。
export function matchBindings(cwd, bindings, options) {
  const candidate = normalizeDirPath(cwd, options)
  if (!candidate) return []

  const table = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
  const hits = []
  for (const dir of Object.keys(table)) {
    const bound = normalizeDirPath(dir, options)
    if (!bound) continue
    if (!pathMatches(candidate, bound, options)) continue
    hits.push({ dir, persona: table[dir], depth: compareKey(bound, options).length })
  }

  // 同样长时用目录名兜底排序，保证结果稳定（同一份绑定表任何时候都给出同一顺序）
  hits.sort((a, b) => (b.depth - a.depth) || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0))
  return hits
}

// 三层解析里「目录绑定」这一层的结论。
//
// 返回 null 表示没有任何可用绑定（回落全局）；返回对象时：
//   · dir / persona 是真正生效的那条；
//   · shadowed 是命中了、但因为人设已不存在而被跳过的更具体绑定 ——
//     它们不生效（见 §4.2），但 UI 必须把它们说出来，否则用户在子目录里
//     看到父级的人设，只会以为是 bug。
//
// 失效引用**不自动删除**：用户可能只是临时删了那个预设、打算重命名回来。
export function resolvePersonaForCwd(cwd, bindings, userPersonas, options) {
  const hits = matchBindings(cwd, bindings, options)
  const shadowed = []

  for (const hit of hits) {
    if (resolvePersona(hit.persona, userPersonas)) {
      return { dir: hit.dir, persona: hit.persona, shadowed }
    }
    shadowed.push({ dir: hit.dir, persona: hit.persona, reason: 'missing-persona' })
  }

  return null
}

// ==================== 绑定表校验 ====================

// 校验并归一化一张绑定表（读侧一律当不可信输入）。
//
// 逐条校验，**坏条目丢弃并计数**而不是整表拒绝：一张表里混进一行手改坏的记录，
// 不该让其余 20 条绑定一起失效。丢弃的原因一并返回，供 UI 显式标注。
//
// 返回 { bindings, dropped }，bindings 的键已是规范化后的展示形态。
export function sanitizeBindings(raw, options) {
  const dropped = []
  const bindings = {}

  if (raw === undefined || raw === null) return { bindings, dropped }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    dropped.push({ dir: null, reason: 'not-object' })
    return { bindings, dropped }
  }

  let count = 0
  for (const key of Object.keys(raw)) {
    if (FORBIDDEN_KEYS.has(key)) {
      dropped.push({ dir: key, reason: 'reserved-key' })
      continue
    }

    const rawDir = key
    if (rawDir.length > MAX_PATH_LENGTH) {
      dropped.push({ dir: rawDir, reason: 'path-too-long' })
      continue
    }
    const dir = normalizeDirPath(rawDir, options)
    if (!dir) {
      dropped.push({ dir: rawDir, reason: 'invalid-path' })
      continue
    }
    if (!isAbsoluteDirPath(dir)) {
      dropped.push({ dir: rawDir, reason: 'not-absolute' })
      continue
    }

    const persona = sanitizePersonaName(raw[key])
    if (!persona) {
      dropped.push({ dir, reason: 'invalid-persona' })
      continue
    }

    // 同一个目录在规范化之后可能撞车（`D:\项目A\` 与 `D:/项目A`）。后出现的覆盖先出现的，
    // 但两条都算「读到了」——这不是损坏，只是同一条绑定的两种写法。
    if (!Object.prototype.hasOwnProperty.call(bindings, dir)) {
      if (count >= MAX_BINDINGS) {
        dropped.push({ dir, reason: 'too-many' })
        continue
      }
      count++
    }
    bindings[dir] = persona
  }

  return { bindings, dropped }
}

// 解析整个绑定文件的内容（含版本检查）。
//
// 返回 { bindings, dropped, failure }：failure 是「文件整体不可用」的一句话说明，
// 与「个别条目被丢弃」（dropped）是两件事 —— 前者应当以空表继续并在 UI 上报出来，
// 后者只是标注，功能照常。
export function parseBindingsDocument(raw, options) {
  if (raw === undefined || raw === null) {
    return { bindings: {}, dropped: [], failure: null }
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { bindings: {}, dropped: [], failure: '绑定文件的内容不是一个对象，已按空表处理。' }
  }

  const version = raw.version
  if (version !== undefined && version !== BINDINGS_VERSION) {
    return {
      bindings: {},
      dropped: [],
      failure: `绑定文件的格式版本是 ${JSON.stringify(version)}，本版本只认识 ${BINDINGS_VERSION}，已按空表处理。`
    }
  }

  const { bindings, dropped } = sanitizeBindings(raw.bindings, options)
  return { bindings, dropped, failure: null }
}

// 写出用的文档形态。键**已在 sanitizeBindings 里规范化**，这里不再动它们，
// 因此「读进来 → 写回去」是幂等的。
export function serializeBindings(bindings) {
  const table = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
  const out = {}
  for (const key of Object.keys(table)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    out[key] = table[key]
  }
  return { version: BINDINGS_VERSION, bindings: out }
}

// ==================== 写入前的准入检查 ====================

// 检查一次「新增 / 改绑」请求是否可以写入，返回 null 表示可以，
// 否则返回一句可直接展示给用户的原因。
//
// 三类拒绝，每一类都对应一个真实会被问出来的问题：
//   · 路径非法 / 非绝对 —— 相对路径的绑定永远命中不了任何会话；
//   · 路径过长 —— 见 MAX_PATH_LENGTH 的注释；
//   · 人设不存在 —— 允许写入的话，用户会把一个 typo 当成「绑定生效了」，
//     然后在目录里等一个永远不会来的人设。**内置人设是合法目标**（不可删但可绑）。
export function bindingRefusal(dir, persona, userPersonas) {
  if (typeof dir !== 'string' || dir.length > MAX_PATH_LENGTH) {
    return `目录路径过长（上限 ${MAX_PATH_LENGTH} 字符），未写入。`
  }
  if (!isAbsoluteDirPath(dir)) {
    return '需要一个绝对路径，相对路径的绑定不会命中任何会话。'
  }
  // ★ 先归一化再查库：sanitizePersonaName 会把两侧空白 trim 掉，而查库要拿
  // trim 之后的名字。直接拿原串去查的话，`我的自定义人设 `（末尾一个空格）
  // 会在第一关通过、在第三关被判「不存在」—— 拒绝理由与真实原因不符，
  // 用户看到的是一句自相矛盾的话（名字合法，却说这个名字不存在）。
  const name = sanitizePersonaName(persona)
  if (name === null) {
    return `人设名不合法（1-${PERSONA_NAME_MAX} 个字符，且不能是保留字）。`
  }
  if (!resolvePersona(name, userPersonas)) {
    return `人设「${name}」不存在，未写入绑定。`
  }
  return null
}

// 把一次写入请求归一成可直接进表的形态（键与值都规范化），返回 null 表示不可写入。
//
// 与 bindingRefusal 分开是因为**两者的消费者不同**：refusal 只回答「能不能写」，
// 本函数回答「写什么」。合并成一个函数的后果是调用方必然自己再 trim 一遍值 ——
// 而那正是「拒绝时用的是 trim 后的名字、写进表里的是原串」这类不一致的来源。
export function normalizeBindingEntry(dir, persona, userPersonas, options) {
  const normalizedDir = normalizeDirPath(dir, options)
  const name = sanitizePersonaName(persona)
  if (!normalizedDir || name === null) return null
  if (bindingRefusal(normalizedDir, name, userPersonas)) return null
  return { dir: normalizedDir, persona: name }
}

// ==================== 文件路径与读写 ====================

// 绑定文件的位置：与配置文件**同目录**，但不从 `$DSH_HOME` 直接拼。
//
// 由 configPath() 推导而不是各自读一遍环境变量，是为了让「配置在哪、绑定就在哪」
// 成为结构事实 —— 测试里把配置指到临时目录时，绑定文件会自动跟着走，
// 不会出现「断言改了一份配置、实际写了另一份绑定」这种静默跑偏。
//
// 用字符串切分而不是 node:path 的 dirname/join：那两个函数**按运行平台**解析，
// 于是在 Windows 上处理 `/home/u/.dsh/soul-config.json` 会得到 `\home\u\...`，
// 断言随即无法在同一台机器上验证两套路径语义（verify-bindings 就是这么红的）。
// 与 lib/history.mjs 的 historyPathFor 同款写法：只做一次「最后一个分隔符」切分。
export function bindingsPathFor(configFilePath) {
  if (typeof configFilePath !== 'string' || configFilePath.trim() === '') return null
  const cut = Math.max(configFilePath.lastIndexOf('/'), configFilePath.lastIndexOf('\\'))
  if (cut < 0) return 'soul-bindings.json'
  return `${configFilePath.slice(0, cut + 1)}soul-bindings.json`
}

// 读取绑定文件。
//
// 与配置读取（lib/store.mjs 的 readConfigFile）复用同一套原语，因此「不存在」
// 「读不出来」「不是合法 JSON」三种情况的区分方式完全一致。
//
// 关键差别在**回退策略**：配置损坏时写入路径会拒绝保存（避免覆盖用户数据），
// 但绑定损坏时这里直接以空表继续 —— 绑定是环境事实，不是用户唯一的数据副本，
// 而且损坏时 moveAside 已经把原文件挪到 `.corrupt` 留给用户了。
//
// 返回 { bindings, dropped, failure, exists, movedAside }。
export async function readBindingsFile(filePath, options) {
  const { value, exists, failure } = await readConfigFile(filePath)

  if (failure) {
    // 损坏的文件移开（而非仅复制）：不动它的话，下一次读取仍判定为损坏，
    // 用户除手删文件外没有任何出路 —— 这正是 moveAsideConfigFile 存在的理由。
    const movedAside = await moveAsideConfigFile(filePath)
    const backup = movedAside ? `（原文件已备份到 ${movedAside}）` : ''
    return {
      bindings: {},
      dropped: [],
      failure: `${failure.message}${backup}`,
      exists,
      movedAside: movedAside || null
    }
  }

  const parsed = parseBindingsDocument(value, options)
  return { ...parsed, exists, movedAside: null }
}

// 原子写出绑定文件（复用 writeConfigFile 的临时文件 + rename 语义）。
export async function writeBindingsFile(filePath, bindings) {
  await writeConfigFile(filePath, serializeBindings(bindings))
  return serializeBindings(bindings)
}
