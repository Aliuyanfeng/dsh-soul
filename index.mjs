// index.mjs — dsh-soul host 入口
//
// 提示词结构：
//   - 身份（自定义指令 → [角色设定]）
//   - 用户背景（「关于你」→ [用户背景]）
//   - 行为（风格/特质/输出语言 → [回复风格]）
//   - 执行规则（[执行规则]）
// 全部固定文案按 config.language 提供中英两套（PROMPT_TEXT 文案表）。
//
// 功能：
//   - 支持自定义 Agent 回复风格和语调
//   - 支持用户昵称，回复时使用昵称称呼
//   - 保存用户配置到文件系统
//   - 提供 HTTP API 供客户端调用
//   - 注册斜杠命令 /soul 查看当前配置
//   - 注入系统提示词到 Agent
//   - 配置写入统一走写队列，返回 changed（有无实际变更）与 promptChanged（是否需要刷新提示词并注入会话）

import { join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONFIG,
  STYLE_VALUES,
  TRAIT_VALUES,
  REPLY_LENGTH_VALUES,
  LANGUAGE_VALUES,
  PERSONA_FIELDS,
  PERSONA_NAME_MAX,
  PROMPT_INPUT_FIELDS,
  migrateConfig,
  sanitizeConfig,
  sanitizePersonaName
} from './lib/config.mjs'
import {
  bindingsPathFor,
  bindingRefusal,
  compareKey,
  MAX_BINDINGS,
  MAX_PATH_LENGTH,
  normalizeBindingEntry,
  normalizeDirPath,
  readBindingsFile,
  resolveDirIdentity,
  resolvePersonaForCwd,
  writeBindingsFile
} from './lib/bindings.mjs'
import {
  MAX_SESSION_ID_LENGTH,
  ORPHAN_GRACE_MS,
  SESSION_DIR_NAME,
  SESSION_ENVELOPE_ONLY_FIELDS,
  SESSION_OVERRIDE_FIELDS,
  SESSION_SCOPE_VERSION,
  createSessionScopeDoc,
  decideSessionScopeFate,
  isSessionId,
  listSessionScopes,
  quarantineSessionScope,
  readSessionScope,
  sanitizeSessionOverride,
  sessionScopeDirFor,
  sessionScopePathFor,
  writeSessionScope
} from './lib/session-scope.mjs'
import {
  MAX_WORKSPACE_SCOPES,
  WORKSPACE_PERSONA_REF,
  WORKSPACE_SCOPE_VERSION,
  mergeWorkspaceOverride,
  resolveWorkspaceOverride,
  sanitizeWorkspaceScopes,
  validateWorkspaceBinding
} from './lib/workspace-scope.mjs'
import { createInjectionSource } from './lib/injection.mjs'
import { isBuiltinPersona, builtinPersonaNames, mergePersonas, personaMatches, resolvePersona, declaredPersonaKeys } from './lib/personas.mjs'
import { configWriteRefusal, describeConfigFailure, moveAsideConfigFile, readConfigFile, writeConfigFile } from './lib/store.mjs'
import {
  buildHistoryEntry,
  clearHistoryFile,
  createEntryId,
  diffFields,
  diffPersonas,
  findEntryIndex,
  hashConfig,
  historyPathFor,
  MAX_READ_LINES,
  planRollback,
  randomSuffix,
  readHistoryFile,
  recordHistoryEntry,
  toHistoryResponse
} from './lib/history.mjs'

const name = 'soul'

// 配置文件路径：$DSH_HOME/soul-config.json
function configPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'soul-config.json')
}

// 变更记录的落盘路径：配置文件的**兄弟文件**（soul-config.json → soul-config.history.jsonl）。
// 与配置同目录而不塞进配置里，理由见 DESIGN-audit-rollback.md §4.1。
function historyPath() {
  return historyPathFor(configPath())
}

// 最近一次「变更记录没能记下来」的原因（记成功则清空）。
//
// 审计失败绝不能连带配置写失败 —— 那会把「记不下来」升级成「改不了」，
// 而配置写入是这个插件的核心功能。但也不能装作没发生：原因经
// GET /api/soul/history 的 warning 字段回传，设置页会原样显示。
let lastHistoryFailure = null

// 版本号：唯一来源是 package.json。
//
// 刻意**不**在这里再写一个常量 —— 需要手工同步的版本号已经有三处
// （package.json / client 的 VERSION / RELEASE_NOTES.md），再加一处只会多一个漂移点。
// 读不到就返回 null：诊断端点不应该因为版本读不出来而失败。
function pluginVersion() {
  try {
    return createRequire(import.meta.url)('./package.json').version || null
  } catch {
    return null
  }
}

// ==================== 人设插画（方案 C：卡片左侧方图） ====================
//
// 图放 assets/personas/<内置人设名>.webp，随包发布；客户端按人设名请求
// `/api/soul/persona-art/<name>`，宿主读文件返回。三条设计取舍：
//
//   ① **不进客户端包**：客户端模块由宿主注入，把 7 张图内联成 data URL 会让
//      客户端包从 114KB 涨到 1MB+；走路由则按需加载、可缓存。
//   ② **缺图回退占位而不是报错**：只有部分人设配了图时，其余显示官方鲸鱼轮廓的
//      占位图。用户看到的是「一只鲸鱼」而不是破图，且新增人设不必同时补图。
//   ③ **只服务内置人设名**：文件名由人设名构成，必须经白名单校验 —— 否则
//      `/api/soul/persona-art/../../package.json` 这类路径穿越能读到包内任意文件。

const PERSONA_ART_DIR = 'assets/personas'
// 允许的图片扩展名（宿主对插件资源的白名单：SVG / PNG / JPEG / WebP）
const ART_EXTENSIONS = ['.webp', '.png', '.jpg', '.jpeg', '.svg']
// MIME 表：必须显式给出，否则浏览器可能按 octet-stream 下载而不是渲染
const ART_MIME = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml'
}
const PLACEHOLDER_FILE = 'placeholder.svg'
// 自定义（自建）预设的默认贴图：鲸鱼剪影 + 装饰元素，用户提供的品牌插画。
// 与内置插画同为 512×512 WebP、视觉重量一致，但形态是无五官的剪影 ——
// 内置是有具体人格的具象插画，自建是「还没定制」的中性底图，一眼可区分。
const CUSTOM_ART_FILE = 'custom-placeholder.webp'

// 包根目录下的 assets/personas 绝对路径
function personaArtDir() {
  try {
    const pkgDir = createRequire(import.meta.url).resolve('./package.json').replace(/[\\/]package\.json$/, '')
    return join(pkgDir, PERSONA_ART_DIR)
  } catch {
    return null
  }
}

// 解析某个内置人设的插画（返回文件名，或回退到占位图；都不可用返回 null）
//
// 白名单校验用 isBuiltinPersona：人设名因此只能是既定 7 个之一，不含 / 与 ..，
// 路径穿越从结构上不可能发生（而不是靠字符串替换去猜）。
function resolvePersonaArt(name) {
  const dir = personaArtDir()
  if (!dir || typeof name !== 'string') return null
  // 自建预设没有配套插画 ⇒ 用专用默认贴图（本版只做样式调整；
  // 允许用户上传本地图片作为插画是后续版本的功能）。
  //
  // 这里**仍不接受任意名字拼路径**：只有内置名会走下面的按名查找，
  // 非内置名一律返回固定文件，路径穿越依然不可能发生。
  if (!isBuiltinPersona(name)) {
    const custom = join(dir, CUSTOM_ART_FILE)
    // MIME 按扩展名取，不写死 —— 贴图格式变过一次（svg → webp），
    // 写死会让浏览器把它当 octet-stream 下载而不是渲染。
    const ext = CUSTOM_ART_FILE.slice(CUSTOM_ART_FILE.lastIndexOf('.'))
    return existsSync(custom) ? { file: custom, mime: ART_MIME[ext] } : null
  }
  for (const ext of ART_EXTENSIONS) {
    const file = join(dir, `${name}${ext}`)
    if (existsSync(file)) return { file, mime: ART_MIME[ext] }
  }
  const fallback = join(dir, PLACEHOLDER_FILE)
  if (existsSync(fallback)) return { file: fallback, mime: ART_MIME['.svg'] }
  return null
}

// 已配图的人设名列表（诊断端点用：一眼看出哪几个还缺图）
function personasWithArt() {
  const dir = personaArtDir()
  if (!dir || !existsSync(dir)) return []
  let files = []
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  const out = []
  for (const name of builtinPersonaNamesSafe()) {
    if (ART_EXTENSIONS.some((ext) => files.includes(`${name}${ext}`))) out.push(name)
  }
  return out
}

// builtinPersonaNames 的容错包装：诊断路径不应因为导入异常而失败
function builtinPersonaNamesSafe() {
  try {
    return builtinPersonaNames()
  } catch {
    return []
  }
}


// ==================== 提示词文案与构建器 ====================

// 提示词固定文案表：所有进入 system prompt / 会话注入 / 工具返回的文本，
// 按输出语言（config.language）提供中英两套，键集完全对齐。
const PROMPT_TEXT = {
  zh: {
    roleHeader: '[角色设定]',
    profileHeader: '[用户背景]',
    profileDisclaimer: '以下信息描述的是与你对话的用户本人，不是你的身份；不要把用户的职业、技术背景或自述当成你自己的设定。',
    profileNickname: (n) => `- 昵称：${n}（回复时使用这个称呼）`,
    profileOccupation: (o) => `- 职业：${o}`,
    profileBio: (b) => `- 用户自述：${b}`,
    styleHeader: '[回复风格]',
    styleLabel: '回复风格和语调：',
    styles: {
      professional: '专业严谨、注重逻辑和准确性、正式礼貌',
      casual: '轻松自然、像朋友一样交流、中性客观',
      humorous: '幽默风趣、适当使用比喻和玩笑、口语化',
      roast: '吐槽达人、犀利幽默、爱调侃但无恶意、口语化',
      efficient: '高效干练、直击要点、简洁明了、不绕弯子'
    },
    headingLists: {
      more: '采用清晰的格式和列表结构组织回答，善用标题和列表',
      less: '使用更多段落文本，减少标题和列表的使用'
    },
    emoji: {
      more: '在回复中使用较多表情符号',
      less: '尽量减少使用表情符号'
    },
    tables: {
      more: '在呈现对比、多字段信息或结构化内容时优先使用表格',
      less: '避免使用表格，改用列表或段落文本呈现'
    },
    replyLength: {
      concise: '回答尽量简洁，直击要点，不展开无关内容',
      detailed: '回答尽量详尽，充分展开背景、步骤与推理过程'
    },
    replyLanguage: {
      zh: '必须使用简体中文回复',
      en: '必须使用英语（English）回复'
    },
    joiner: '，',
    rulesHeader: '[执行规则]',
    rules: '你必须在每一条回复中严格遵守以上角色设定和回复风格；涉及用户背景时，用它来理解用户、贴合用户的需求和水平作答，而不是把它当作你自己的身份。包括但不限于：代码解释、技术问答、日常闲聊、知识科普等所有场景。违反此规则视为失败。',
    injectUpdatedHeader: '[dsh-soul 个性化配置已更新]',
    injectUpdatedBody: [
      '以下是当前最新的个性化配置快照（含昵称、回复风格和语调、特质、输出语言等）。',
      '从现在开始必须按照此配置回复，不要继续使用旧的昵称、角色、风格、语调、特质或输出语言。'
    ].join('\n'),
    injectDisabled: [
      '[dsh-soul 个性化配置已关闭]',
      '从现在开始不要使用 dsh-soul 之前注入的昵称、角色、回复风格、语调、特质或输出语言配置。',
      '请恢复使用 Agent 的默认行为。'
    ].join('\n'),
    toolUpdated: '已更新个性化设置',
    toolNoChanges: '没有要更改的设置',
    toolValidationFailed: '配置校验失败：',
    toolProposal: '已收到人设变更请求（确认模式已开启，尚未生效）：',
    toolRejected: '你在审批面板中拒绝了这次人设变更，未做任何修改。',
    toolApprovalDisabled: '说明：本次会话的审批通道已被禁用（approval policy = never），因此没有弹出确认面板；这不代表你做了拒绝操作。',
    toolProposalHint: '在用户确认前不会生效；用户可用 /soul confirm 确认，或 /soul reject 拒绝。'
  },
  en: {
    roleHeader: '[Role]',
    profileHeader: '[User profile]',
    profileDisclaimer: 'The information below describes the user you are talking to — it is NOT your own identity; do not treat the user\'s occupation, background or self-description as your persona.',
    profileNickname: (n) => `- Nickname: ${n} (address the user by this name in replies)`,
    profileOccupation: (o) => `- Occupation: ${o}`,
    profileBio: (b) => `- Self-description: ${b}`,
    styleHeader: '[Reply style]',
    styleLabel: 'Reply style & tone: ',
    styles: {
      professional: 'Rigorous and professional, focused on logic and accuracy, formal and courteous',
      casual: 'Relaxed and natural, chatting like a friend, neutral and objective',
      humorous: 'Humorous, apt with analogies and jokes, colloquial',
      roast: 'Playful roaster, sharp and witty but never mean, colloquial',
      efficient: 'Efficient and straight to the point, concise, no beating around the bush'
    },
    headingLists: {
      more: 'Organize answers with clear formatting, headings and lists',
      less: 'Use more paragraph text; minimize headings and lists'
    },
    emoji: {
      more: 'Use emojis fairly often in replies',
      less: 'Keep emoji usage to a minimum'
    },
    tables: {
      more: 'Prefer tables when presenting comparisons, multi-field or structured information',
      less: 'Avoid tables; use lists or paragraph text instead'
    },
    replyLength: {
      concise: 'Keep answers concise: hit the key points and skip unrelated elaboration',
      detailed: 'Give detailed answers: fully expand on background, steps and reasoning'
    },
    replyLanguage: {
      zh: '必须使用简体中文回复',
      en: 'You must reply in English.'
    },
    joiner: '; ',
    rulesHeader: '[Execution rules]',
    rules: 'You must strictly follow the role setup and reply style above in EVERY reply; when user background is involved, use it to understand the user and tailor your answers to their needs and level — never treat it as your own identity. This covers all scenarios including code explanation, technical Q&A, casual chat and knowledge sharing. Violating this rule counts as failure.',
    injectUpdatedHeader: '[dsh-soul] Personalization config updated',
    injectUpdatedBody: [
      'Below is the latest personalization snapshot (nickname, reply style & tone, traits, output language, etc.).',
      'From now on you must reply according to this config; do not keep using the previous nickname, role, style, tone, traits or output language.'
    ].join('\n'),
    injectDisabled: [
      '[dsh-soul] Personalization config disabled',
      'Stop using any nickname, role, reply style, tone, traits or output language previously injected by dsh-soul.',
      'Return to your default behavior.'
    ].join('\n'),
    toolUpdated: 'Personalization settings updated',
    toolNoChanges: 'No settings to change',
    toolValidationFailed: 'Config validation failed: ',
    toolProposal: 'Persona change requested (confirmation mode is on — not applied yet):',
    toolRejected: 'You rejected this persona change in the approval panel — nothing was modified.',
    toolApprovalDisabled: 'Note: the approval channel is disabled in this session (approval policy = never), so no confirmation panel appeared; this does not mean you rejected anything.',
    toolProposalHint: 'It stays pending until the user confirms with /soul confirm or rejects with /soul reject.'
  }
}

// 按配置选择文案表（未知语言回退中文）
function promptTextOf(config) {
  return PROMPT_TEXT[config && config.language === 'en' ? 'en' : 'zh']
}

// 用户背景块（「关于你」）：描述对话用户本人，不属于 Agent 的角色设定
function buildUserProfile(config, T) {
  const lines = []
  if (config.nickname) lines.push(T.profileNickname(config.nickname))
  if (config.occupation) lines.push(T.profileOccupation(config.occupation))
  if (config.bio) lines.push(T.profileBio(config.bio))
  return lines.join('\n')
}

// 行为块：回复风格和语调 + 特质（标题和列表 / 表情符号 / 表格）+ 回复长度 + 输出语言。
// 缺项（如 tables=default、replyLength=normal）在文案表中没有对应键，直接跳过、不产生文本，
// 因此默认配置编译出的提示词与新增这两个维度之前完全一致。
function buildBehavior(config, T) {
  const parts = []
  if (config.style && T.styles[config.style]) parts.push(`${T.styleLabel}${T.styles[config.style]}`)
  if (config.headingLists && T.headingLists[config.headingLists]) parts.push(T.headingLists[config.headingLists])
  if (config.emoji && T.emoji[config.emoji]) parts.push(T.emoji[config.emoji])
  if (config.tables && T.tables[config.tables]) parts.push(T.tables[config.tables])
  if (config.replyLength && T.replyLength[config.replyLength]) parts.push(T.replyLength[config.replyLength])
  if (config.language && T.replyLanguage[config.language]) parts.push(T.replyLanguage[config.language])
  return parts.join(T.joiner)
}

// ==================== 配置管理 ====================

// 默认配置、合法取值（STYLE_VALUES / TRAIT_VALUES / LANGUAGE_VALUES）、
// 旧版本迁移（migrateConfig）与输入校验（sanitizeConfig）见 lib/config.mjs。

// POST /api/soul/config 请求体大小上限：合法配置远小于该值，仅用于拦截异常请求
const MAX_BODY_BYTES = 64 * 1024

// 内存中的配置缓存
let configCache = null

// 配置的**单调修订号**：每次配置真的被替换（读盘成功、写入成功、重置）+1。
//
// 为什么需要它：system prompt 的 section.text 是宿主**同步**调用的，每次装配都读
// `configCache` —— 而 configCache 由写队列整体替换。若一次装配过程中间发生了写入，
// 同一轮里 section 多次求值时可能拿到**两个不同版本**的配置，症状正是「System Prompt
// Updated 已出现、模型却仍用旧昵称」这一类难以复现的问题。
//
// 有了修订号，装配侧可以：
//   ① 先取一次快照再求值（见 snapshotConfig），保证一轮只用一份配置；
//   ② 把「这一轮实际用了哪一版」记进诊断状态，事后能回答「进模型的是哪一版」。
//
// 刻意**不**做「装配期间禁止写入」：装配是纯读，写入走队列，加锁只会让保存变慢。
// 单调号足以定位，不需要互斥。
let configRevision = 0

function bumpConfigRevision() {
  configRevision += 1
}

// 取当前配置的不可变快照。装配路径上**只调用一次**，后续全部基于它。
//
// 返回的 revision 与 value 是同一时刻的配对：先读 revision 再读 value（或反过来）
// 在单线程里等价，因为两者之间没有 await —— 一旦有 await，就又会读到两个版本。
function snapshotConfig() {
  return {
    revision: configRevision,
    value: configCache || DEFAULT_CONFIG
  }
}

// 磁盘上的配置存在但不可用（读不出来 / 不是合法 JSON）时的记录。
// 置位后 saveConfig 会拒绝写入，避免把损坏的配置静默清空成默认值。
let configLoadFailure = null

// 读取配置。
//
// 文件不存在（首次运行）与文件损坏是两件不同的事，必须分开处理：
//   - 不存在  → 回退默认值，正常路径，可以照常保存；
//   - 损坏    → 也回退默认值（保证插件与设置页仍可用），但记录失败原因，
//               并让写入路径拒绝保存。否则「回退默认」会在下一次保存时变成
//               「以默认值为底写回磁盘」，用户的自定义指令与预设库就永久丢了。
//
// 失败时刻意**不写 configCache**：这样用户修好文件后，下一次读取会自动恢复正常，
// 不必重启 DSH。
async function loadConfig() {
  if (configCache) return configCache
  configLoadFailure = null

  const { value, exists, failure } = await readConfigFile(configPath())
  if (failure) {
    configLoadFailure = failure
    return { ...DEFAULT_CONFIG }
  }

  configCache = exists ? migrateConfig(value) : { ...DEFAULT_CONFIG }
  bumpConfigRevision()
  return configCache
}

// 保存配置（原子写，见 lib/store.mjs 的 writeConfigFile）。
// 磁盘配置损坏时拒绝写入：拒绝的原因与恢复方式由 lib/store.mjs 统一生成。
async function saveConfig(config) {
  const refusal = configWriteRefusal(configLoadFailure, configPath())
  if (refusal) {
    throw new Error(refusal)
  }

  // 过滤已废弃字段（旧客户端可能仍携带 tone / presets / examples）
  const clean = { ...config }
  delete clean.tone
  delete clean.presets
  delete clean.examples
  await writeConfigFile(configPath(), clean)
  configCache = clean
  bumpConfigRevision()
  return clean
}

// ==================== 配置写入队列 ====================

// 所有配置写路径（HTTP 保存 / /soul 命令 / set_persona 工具 / soulConfig 服务）
// 统一经由该队列串行执行「读—改—写」，避免并发写入时各方都基于同一份旧配置合并、
// 后写覆盖前写（丢更新）。队列按提交顺序执行任务。
let configWriteQueue = Promise.resolve()

function enqueueConfigWrite(task) {
  const run = configWriteQueue.then(task)
  // 队列吞掉单次任务的失败，保证后续写入不会被一次磁盘错误卡死
  configWriteQueue = run.then(() => {}, () => {})
  return run
}

// 不影响提示词的字段：变更它们不需要刷新系统提示词，也不需要向活动会话注入快照；
// 但它们仍是实际配置变更，必须计入 changed（供调用方判断「已保存 / 无变化」并驱动前端 dirty）。
//
// 由 DEFAULT_CONFIG 减去 PROMPT_INPUT_FIELDS **推导**，而不是手写清单。
// 手写清单的代价已经发生过两次：trail* 四项之外，requireToolConfirmation 与
// historyMaxEntries 都曾被漏在外面 —— 后果是改一次「保留条数」会重新注册 section
// 并向所有活动会话注入一条配置更新消息，用户看到的是「我只调了个容量，Agent 却被
// 通知了一遍配置变了」。这类「漏登记」不会报错，只会安静地多注入。
//
// 推导的安全前提是 compilePrompt 只读 PROMPT_INPUT_FIELDS 里的字段，该前提由
// scripts/verify-config.mjs 的「编译源码读取的每个 config.X 都必须已登记」钉住。
//
// 未知键（不在 DEFAULT_CONFIG 里）会落在「影响提示词」一侧 —— 方向是安全的：
// 最坏是多重启一次提示词，而不是改了不生效。
const NON_PROMPT_FIELDS = new Set(
  Object.keys(DEFAULT_CONFIG).filter((key) => !PROMPT_INPUT_FIELDS.includes(key))
)

// 在写队列中执行一次配置更新：mutate 收到当前配置的浅拷贝，返回新配置对象。
// 注意 mutate 必须在队列任务内完成全部读取与合并，不要在队列外提前读取配置。
// 返回 { config, changed, promptChanged }：
//   - changed：实际发生变化的字段名数组（不含 personas 预设库），供调用方判断有无变更
//   - promptChanged：changed 中会影响 Agent 行为的子集；为空时应跳过提示词刷新与会话注入
//
// 第二参数 source 是**变更记录的归属**，形如 { source, action }：source 是渠道
// （web / command / tool / service / persona / rollback / restorePersona），
// action 是动作（save / set / use / …）。两个都是白名单枚举，写进条目与读回条目时各校验一次。
//
// 为什么必须由调用方显式给出：同一次「改了 style」可能是网页保存、斜杠命令、Agent 工具
// 或其它插件调用，事后从配置差异里是**推不出来**的。审计的价值有一半在于回答
// 「是谁改的」—— 默认值会让这半个价值静默消失，所以这里刻意不给默认值。
async function commitConfig(mutate, source) {
  return enqueueConfigWrite(async () => {
    const current = await loadConfig()
    // mutate 允许返回 Promise：撤销要在「读记录 → 规划 → 写配置」之间保持原子，
    // 而记录必须在**队列内**读。放在队列外读会有一个窗口——两次撤销并发时，
    // 后者的规划建立在已被前者改过的配置上，指纹校验会给出看起来像「数据损坏」的
    // diverged，排查方向完全跑偏。
    const next = await mutate({ ...current })
    const changed = diffKeys(current, next)
    const promptChanged = changed.filter((key) => !NON_PROMPT_FIELDS.has(key))
    const config = await saveConfig(next)

    // 差分必须在 saveConfig **之后**、且以它返回的配置为基准：saveConfig 会剔除
    // tone / presets / examples 三个废弃字段，拿 mutate 的产物去比会把它们误报成变更。
    const entry = await auditCommit(current, config, source, config.historyMaxEntries)

    return { config, changed, promptChanged, entry }
  })
}

// 路由内主动拒绝：从队列任务里抛出即可中止本次提交（不写盘），由 handler 按状态码回话。
// 不用返回一个「什么都没改」的配置来收场 —— 那会照样重写一次配置文件，
// 让一次失败的操作在磁盘上留下痕迹。
function httpError(status, message) {
  const err = new Error(message)
  err.httpStatus = status
  return err
}

// 把一次成功的提交记进变更记录。
//
// 时机与失败处理（DESIGN-audit-rollback.md §5）：调用点已在 saveConfig 之后，
// 所以「配置写失败却留下记录」在结构上不可能。反过来「配置已写、记录没写成」是可能的
// （磁盘只读、记录文件被占用）—— 此时把原因记进 lastHistoryFailure 并**继续返回成功**，
// 因为配置确实已经改了。
async function auditCommit(current, config, source, maxEntries) {
  try {
    const fields = diffFields(current, config)
    const personas = diffPersonas(current.personas, config.personas)

    // 「什么都没变」必须在构造条目**之前**判掉，不能靠 buildHistoryEntry 返回 null 来表达。
    // 后者把两种情况混成了同一个返回值：真的没变，和条目因为 shape 不对被拒
    // （例如某个调用点漏标 source）—— 后者是代码缺陷，混进来就会变成
    // 「配置改了、记录里没有、也没有任何告警」。这条判据把缺陷从静默变响亮。
    const changedAny =
      Object.keys(fields.after).length > 0 ||
      personas.added.length > 0 || personas.updated.length > 0 || personas.removed.length > 0
    if (!changedAny) {
      lastHistoryFailure = null
      return null
    }

    const entry = buildHistoryEntry({
      id: createEntryId(Date.now(), randomSuffix()),
      at: new Date().toISOString(),
      source: source && source.source,
      action: source && source.action,
      label: source && source.label,
      configHash: hashConfig(config),
      before: fields.before,
      after: fields.after,
      personas
    })
    if (!entry) {
      // 有变化却构造不出条目 ⇒ 一定是调用点的 source/action 没标或标错。
      // 报出来而不是当作「无变化」跳过：审计缺一条而没人知道，比留一条错的更糟。
      lastHistoryFailure = `变更记录条目构造失败（source=${JSON.stringify(source)}），本次改动未被记录`
      return null
    }
    await recordHistoryEntry(historyPath(), entry, maxEntries)
    lastHistoryFailure = null
    return entry
  } catch (err) {
    lastHistoryFailure = String((err && err.message) || err)
    return null
  }
}

// 比较两份配置的差异字段名（浅比较；soul 配置为扁平对象）。
// personas（人设预设库）不属于活动配置：库的增删改不应触发提示词刷新与会话注入。
function diffKeys(a, b) {
  const changed = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (key === 'personas') continue
    if (a[key] !== b[key]) changed.push(key)
  }
  return changed
}

// 重置为默认配置，但保留人设预设库（预设属于用户资产，重置不应清空）
function defaultConfigPreservingPersonas(current) {
  const next = { ...DEFAULT_CONFIG }
  if (current && current.personas) next.personas = current.personas
  return next
}

// 重置：配置损坏时的**逃生口**。
//
// 损坏状态下所有写入都被 saveConfig 拒绝 —— 包括重置。但「一个出口都没有」意味着
// 用户只能自己去删文件，所以「重置」被定义为**刻意丢弃**：先把损坏的文件移开
// （＝备份到 <config>.corrupt），路径随即回到「首次运行」分支，这次写入才能真正落盘。
//
// 这与 R3 的「损坏配置绝不**静默**被覆盖」不冲突：静默覆盖被禁止，而重置是用户显式
// 发起的动作、且覆盖前先留下备份。
//
// 复用 commitConfig 的「读—改—写」，不另写一份；写入失败时恢复失败标记，
// 避免把「文件仍然不可用」误报成正常状态。
//
// source 由调用方给（web 重置 / 斜杠命令重置 / 其它插件调用），穿透给 commitConfig
// 用于变更记录 —— 三个入口都是「重置」，但来源不同，记录里要分得开。
async function resetConfigWithEscape(source) {
  const failure = configLoadFailure
  const backupPath = failure ? await moveAsideConfigFile(configPath()) : null
  if (failure) configLoadFailure = null

  try {
    const result = await commitConfig((current) => defaultConfigPreservingPersonas(current), source)
    return { ...result, backupPath }
  } catch (err) {
    if (failure) configLoadFailure = failure
    throw err
  }
}

// 将字段级校验错误汇总为一行文本（HTTP 错误信息 / 工具返回消息共用）
function formatFieldErrors(errors) {
  return Object.entries(errors)
    .map(([field, reason]) => `${field}: ${reason}`)
    .join('；')
}

// 读取 JSON 请求体：限制大小（超限读完丢弃并返回 413），解析失败返回 400。
// 超限时继续读完剩余数据，避免连接中残留未读字节污染 keep-alive。
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  let oversized = false
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) {
      oversized = true
      chunks.length = 0
      continue
    }
    chunks.push(chunk)
  }
  if (oversized) {
    return { ok: false, status: 413, error: `请求体超过大小上限 ${MAX_BODY_BYTES} 字节` }
  }
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  } catch (err) {
    return { ok: false, status: 400, error: '请求体不是合法的 JSON：' + String(err.message || err) }
  }
}

// ==================== 提示词编译器 ====================

// Prompt Compiler：将身份（自定义指令）、用户背景与行为（风格/特质/语言）
// 按 config.language 对应的文案表编译为 system prompt。
function compilePrompt(config) {
  if (!config.enabled) {
    return ''
  }

  const T = promptTextOf(config)
  const identity = (config.customInstructions || '').trim()
  const profile = buildUserProfile(config, T)
  const behavior = buildBehavior(config, T)

  // 如果没有任何配置，返回空
  if (!identity && !behavior && !profile) {
    return ''
  }

  const parts = []

  // 身份层
  if (identity) {
    parts.push(`${T.roleHeader} ${identity}`)
  }

  // 用户背景块：明确声明描述的是用户本人，防止模型把用户信息当成自己的身份
  if (profile) {
    parts.push(`${T.profileHeader} ${T.profileDisclaimer}\n${profile}`)
  }

  // 行为层
  if (behavior) {
    parts.push(`${T.styleHeader} ${behavior}`)
  }

  // 执行规则
  parts.push(`${T.rulesHeader} ${T.rules}`)

  return parts.join('\n')
}

// ==================== 配置生效链路的送达诊断 ====================

// 「改配置 → 下一轮生效」由两条通道共同承载：system prompt section（底座）与
// 活动会话注入（立即见效）。任一条静默失效，表面症状都是「改了人设不生效」而没有
// 任何报错 —— 正是本插件历史上最难排查的一类问题（见 DEBUGGING.md 3.5）。
//
// 因此这里如实记录事实，并让三处可读到：日志（同因只告一次）、GET /api/soul/status、
// /soul show。诊断本身不改变行为，只在真的出问题时才说话（正常状态不打扰）。
const deliveryState = {
  injectedAt: null,        // 最近一次注入尝试的时间（ISO）
  agents: 0,               // 最近一次看到的活动会话数
  delivered: 0,            // 最近一次成功注入的会话数
  failed: 0,               // 最近一次注入抛错的会话数
  injectionProblem: null,  // 未能如实送达的原因；正常为 null
  sectionRegisteredAt: null, // section 最近一次注册成功的时间（ISO）
  lastAssembledRevision: null, // 最近一次装配实际使用的配置修订号（排查「改了没生效」用）
  lastAssembledScope: null // 最近一次装配用的是哪一层：'workspace' | 'cwd'
}

// 同一原因只告一次警，避免每次保存都刷屏；一旦恢复正常则清掉记录，
// 这样「好了又坏」会再次告警。
const warnedReasons = new Set()

function warnOnce(ctx, reason, message) {
  if (warnedReasons.has(reason)) return
  warnedReasons.add(reason)
  try {
    ctx.logger?.warn?.(`[dsh-soul] ${message}`)
  } catch {
    // 日志不可用不应影响功能
  }
}

// 把内部原因码翻译成一句能直接看懂的话（/soul show、设置页、状态端点共用）。
//
// 文案取自 **COMMAND_MESSAGES**（不是 PROMPT_TEXT）：delivery* 系列键只定义在命令文案表里，
// 两者都按 config.language 提供中英两套。这里此前误用 promptTextOf ⇒ 该函数在
// 'agents-service-unavailable' 分支返回 undefined（JSON 序列化时字段整个消失，故障对
// 用户不可见），在 'inject-failed' 分支直接抛 TypeError（保存已落盘却报 HTTP 500）。
function deliveryProblemText(config) {
  const problem = deliveryState.injectionProblem
  if (!problem) return null
  const T = commandMessages(config)
  if (problem === 'agents-service-unavailable') return T.deliveryNoAgentsService
  return T.deliveryInjectFailed(problem.replace(/^inject-failed:\s*/, ''))
}

// 把最新配置作为 model-facing context 注入所有活动会话。
// inject() 不会唤醒 Agent，也不改写普通用户消息；会在下一次 step 被模型读取。
function injectPromptToAllAgents(ctx, config) {
  const stamp = new Date().toISOString()
  const unavailable = (reason, message) => {
    deliveryState.injectedAt = stamp
    deliveryState.agents = 0
    deliveryState.delivered = 0
    deliveryState.failed = 0
    deliveryState.injectionProblem = reason
    warnOnce(ctx, reason, message)
  }

  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') {
    unavailable(
      'agents-service-unavailable',
      'agents 服务不可用：新配置只能经 system prompt section 送达，保存后可能要到新会话才生效'
    )
    return
  }

  let listed
  try {
    listed = agents.list()
  } catch (err) {
    unavailable(
      'agents-service-unavailable',
      `列出活动会话失败（${String((err && err.message) || err)}）：新配置只能经 system prompt section 送达`
    )
    return
  }

  const T = promptTextOf(config)

  let delivered = 0
  let failed = 0
  let lastError = null

  for (const agent of listed) {
    // **每个会话各自编译**，不能共用一份文本。
    //
    // 工作区绑定让「配置」不再是全局唯一的：A 项目会话该拿到「资深架构师」，B 项目会话
    // 该拿到「极简主义者」。若在这里算一份全局文本发给所有人，B 项目会收到 A 的人设 ——
    // 这比不注入更糟（不注入时它至少还是全局配置，与用户以为的一致）。
    //
    // 拿不到 cwd（会话头无该字段）时 configForCwd 返回原配置，行为与绑定功能上线前一致。
    const perAgent = configForCwd(config, cwdOfAgent(agent)).config
    const prompt = compilePrompt(perAgent)
    const snapshotText = prompt || T.injectDisabled

    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: prompt ? `${T.injectUpdatedHeader}\n${T.injectUpdatedBody}\n\n${prompt}` : snapshotText
        }],
        // 会话格式 v4 要求生产者自持 kind；旧的 `kind: 'plugin'` + `plugin` 组合
        // 会让每一轮在 step 开始前失败（issue #1，构造与校验见 lib/injection.mjs）
        source: createInjectionSource(snapshotText)
      }))
      delivered++
    } catch (err) {
      failed++
      lastError = err
      try {
        ctx.logger?.warn?.(`[dsh-soul] 向会话 ${agent?.id} 注入配置失败：${String((err && err.message) || err)}`)
      } catch {
        // 同上：日志失败不影响功能
      }
    }
  }

  deliveryState.injectedAt = stamp
  deliveryState.agents = listed.length
  deliveryState.delivered = delivered
  deliveryState.failed = failed
  deliveryState.injectionProblem = failed > 0
    ? `inject-failed: ${String((lastError && lastError.message) || lastError)}`
    : null

  // 恢复正常后允许再次告警（「好了又坏」不该被静默）
  if (failed === 0) warnedReasons.delete('agents-service-unavailable')
  else warnedReasons.add('agents-service-unavailable')
}

function refreshPromptAndInject(ctx, config) {
  if (globalUpdatePrompt) {
    globalUpdatePrompt().catch(err => {
      try {
        ctx.logger?.warn?.(`[dsh-soul] 重新注册 system prompt section 失败：${String((err && err.message) || err)}`)
      } catch {
        // 同上
      }
    })
  }
  injectPromptToAllAgents(ctx, config)
}

// ==================== 工作区绑定：按目录解析人设 ====================
//
// 三层解析（DESIGN-persona-scope.md §5）：会话显式覆盖 → 目录绑定（最长前缀）→ 全局配置。
// 0.8.1-b 落地的是中间那层；会话覆盖（0.8.1-c/d）尚未接入，接入点见 resolveForCwd 的注释。
//
// 为什么绑定表要单独缓存而不是每次读盘：本节的两个消费者都在**每一轮装配**上 ——
// system prompt section 的 text provider 每轮都被调用一次，活动会话注入每次保存各一次。
// 读盘 + 200 次 realpath 放进这条路径是不可接受的，所以绑定表在加载时规范化一次。

// 绑定文件路径（configPath() 的兄弟文件）。
function bindingsPath() {
  return bindingsPathFor(configPath())
}

// 绑定表读数。null = 还没读过（与「读过了、确实是空表」必须分得开，
// 后者意味着「用户一条都没绑」，前者意味着「还没问过磁盘」）。
let bindingsCache = null

// 最近一次绑定加载失败 / 有坏条目的说明（无问题为 null）。
let bindingsLoadFailure = null

// 命中判定的比较表。
//
// 这里有两个键集合，都指向同一条绑定：
//   · **展示键**：绑定表里原样存着的形式，UI 与用户看到的就是它；
//   · **身份键**：`realpath` 解析后的形式（解掉符号链接 / Junction；Windows 上还会
//     规范化盘符大小写）。
//
// 为什么要两个都进比较表 —— 两边各自可能缺席一次解析：
//   · 会话 cwd 由 Node 的 `process.cwd()` 提供（`GetCurrentDirectory` 返回的是**规范**
//     路径），而绑定目录是用户在选择器里点出来的，很可能是 Junction 路径。
//     典型失配：cwd = `D:\真实目录`、绑定键 = `D:\junction入口`。
//   · 反过来，用户手工粘贴的路径可能本就是规范路径，而会话 cwd 落在 Junction 里。
// 两个键都留着，任一侧成立即命中；`bindingsDisplayOf` 负责把命中结果翻译回展示键，
// 因为用户不认得 realpath 吐出来的那个名字。
//
// **不对 cwd 做 realpath**：text provider 必须是**同步**的（见 registerSystemPrompt），
// 而 realpath 是异步 I/O。把身份解析全部放在**键**侧，这个约束就消失了 ——
// 键在加载时算一次，之后每轮装配都只是字符串比较。
let bindingsCompareTable = null

// 身份键 → 展示键（仅当两者不同时才有一条）。
let bindingsDisplayOf = null

// 解析绑定表：读盘 + 为每条键算出身份形态。
//
// 失败时**以空表继续**并把原因记在 bindingsLoadFailure 上，绝不抛错：
// 绑定是可选增强，读不出来不该让整个插件的装配流程崩掉（与 loadConfig 的策略不同，
// 因为配置是用户唯一的数据副本，而绑定不是）。
//
// 失败时**不写 bindingsCache**，与 loadConfig 同款：用户把文件改对之后，下一次
// 加载（绑定路由写完表之后总会重新加载）就能自动恢复，不必重启 DSH。
// 此时比较表被清成空表 —— 宁可暂时不生效，也不能拿上一次的旧表继续命中。
async function loadBindings() {
  const filePath = bindingsPath()
  const { bindings, dropped, failure } = await readBindingsFile(filePath)
  bindingsLoadFailure = failure || (dropped.length > 0 ? `${dropped.length} 条绑定因格式问题被忽略。` : null)

  if (failure) {
    bindingsCompareTable = {}
    bindingsDisplayOf = new Map()
    return { bindings: {}, dropped, failure, filePath }
  }

  // 计算身份键。并发发起（最多 MAX_BINDINGS=200 条，realpath 很轻），
  // 但 resolveDirIdentity 自身绝不抛错，所以这里不需要 per-item 的 try/catch。
  const compareTable = { ...bindings }
  const displayOf = new Map()
  const keys = Object.keys(bindings)
  const identities = await Promise.all(keys.map(dir => resolveDirIdentity(dir)))

  for (let i = 0; i < keys.length; i++) {
    const dir = keys[i]
    const identity = identities[i]
    // 只有真的不同才加别键：同一条绑定占两个键位会让 shadowed 出现重复项。
    if (!identity || compareKey(identity) === compareKey(dir)) continue
    // 身份键撞上另一条展示键时**不覆盖** —— 展示键是用户亲手写的那个，
    // 优先级更高；被挡住的身份键只是少一条别名，判定方向安全。
    if (hasOwn(compareTable, identity)) continue
    compareTable[identity] = bindings[dir]
    displayOf.set(identity, dir)
  }

  bindingsCompareTable = compareTable
  bindingsDisplayOf = displayOf
  bindingsCache = { bindings, dropped, failure: null, filePath }
  return bindingsCache
}

// 按目录解析该用什么人设（三层解析的「目录层」）。
//
// 返回 null 表示没有可用绑定 ⇒ 调用方回落全局配置（这是绝大多数用户的常态）。
// 返回对象时：
//   · dir / persona —— 真正生效的那条绑定；
//   · shadowed —— 命中了、但人设已不存在的更具体绑定（不生效，但必须能说出来）。
//
// 本函数是**同步**的：它每轮装配都被调用，且 text provider 不允许是异步的。
// 因此读盘只能发生在装配之外（apply() 启动时、绑定路由写完之后），见 ensureBindings。
async function ensureBindings() {
  if (!bindingsCache) await loadBindings()
  return bindingsCache
}

function resolveBindingForCwd(cwd, userPersonas) {
  if (!bindingsCompareTable || !bindingsDisplayOf) return null
  const normalized = normalizeDirPath(cwd)
  if (!normalized) return null

  const resolved = resolvePersonaForCwd(normalized, bindingsCompareTable, userPersonas)
  if (!resolved) return null

  // 命中身份键时回报展示键（用户认得的是他自己写的那个名字）。
  const display = dir => (bindingsDisplayOf.get(dir) || dir)
  const seen = new Set()
  const shadowed = []
  for (const item of resolved.shadowed) {
    const dir = display(item.dir)
    // 同一条绑定的展示键与身份键可能都命中，去重后 UI 才不会把一条失效绑定画两遍。
    if (seen.has(dir)) continue
    seen.add(dir)
    shadowed.push({ ...item, dir })
  }

  return { dir: display(resolved.dir), persona: resolved.persona, shadowed }
}

// ==================== 三级作用域：Global → Workspace → Session ====================
//
// 解析链（DESIGN-config-scope.md §2.2）：
//
//   workspaceId（索引命中） → 工作区覆盖 → 部分覆盖全局
//        ↓ 索引未命中（服务重启 / 新会话 / 索引空）
//   cwd 前缀匹配（lib/bindings.mjs 既有能力） → 目录绑定 → 部分覆盖全局
//        ↓ 都没有
//   Global
//
// **失败方向必须安全**：任何一环不可用，只能在「更精确」与「更宽松」之间移动，
// 不能变成「错误的人设」。

// sessionId → workspaceId 的**只读快照**。
//
// 为什么是快照而不是"每次问宿主"：`systemPrompt.section.text` 是宿主**同步**调用的，
// 里面不能有 await、也不能做线性扫描（每次装配 × 每个工作区 × 每个 sessionIds getter）。
// 所以索引在装配路径**之外**维护，装配时只查表。
//
// 键与值都用 String：宿主用品牌类型（WorkspaceId / SessionId），把它们当字符串比较
// 是唯一稳定做法（品牌类型在运行时就是字符串，但对象比较会因代理包装而失配）。
let sessionWorkspaceIndex = new Map()

// 索引最后一次成功重建的时间（ISO）。诊断用：排查「工作区绑定为什么没生效」时，
// 第一个要看的就是索引有没有建起来。
let workspaceIndexBuiltAt = null

// 重建索引。**同步且不做 I/O** —— workspaceRegistry.list() 是内存投影。
//
// `sessionIds` 是 getter，每次访问都会过滤一遍（宿主内部按 candidateMatches 校验），
// 因此这里只遍历一次并把结果拍平成 Map，绝不把这个 getter 存下来反复问。
function rebuildWorkspaceIndex(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (!registry || typeof registry.list !== 'function') {
    // 服务缺席不是错误：没有它就只能走 cwd 回退，而那正是 0.8.1 的语义。
    return false
  }

  let listed
  try {
    listed = registry.list()
  } catch {
    return false
  }

  const next = new Map()
  for (const workspace of Array.isArray(listed) ? listed : []) {
    const id = workspace && workspace.id !== undefined ? String(workspace.id) : ''
    if (id === '') continue
    let sessionIds
    try {
      sessionIds = workspace.sessionIds
    } catch {
      // 单个工作区的 getter 抛错不该让整张索引失败（宿主注释：候选会话可能已被移出）
      continue
    }
    for (const sessionId of Array.isArray(sessionIds) ? sessionIds : []) {
      next.set(String(sessionId), id)
    }
  }

  sessionWorkspaceIndex = next
  workspaceIndexBuiltAt = new Date().toISOString()
  return true
}

// 从装配上下文里取 sessionId。
//
// `agent.id` **就是** sessionId —— 宿主注册 typert lookup 时用的正是
// `wireTypeSymbol: "@deepseek-ai/dsh-session/types#SessionId"`，
// `resolve: (sessionId) => this.get(sessionId)`。
//
// 诊断装配时 agent 缺席，返回 null。
function sessionIdOfAgent(agent) {
  const id = agent?.id
  if (typeof id === 'string' && id.trim() !== '') return id
  if (typeof id === 'number') return String(id)
  return null
}

// 把「全局配置 + 一次作用域解析结果」合成为该会话实际生效的配置。
//
// 三层顺序固定：先工作区（或目录），再会话覆盖。后者能盖前者 —— 这正是
// 「本次会话临时改用教学模式」的语义。
//
// 用预设的**部分覆盖**语义（与 /api/soul/personas/use 同一条规则）：只覆盖条目实际
// 声明过的字段，未声明的保持上层值。这条复用不是巧合 —— 用户在设置页点「使用」
// 一个预设时看到的效果，必须与他在该目录里自动拿到的效果**逐字段一致**，
// 否则「绑定生效了吗」将无法用任何已有操作来验证。
//
// `enabled` 刻意**不在**任何覆盖范围内：全局总开关始终说话。
//
// `sessionOverride` 由调用方从**内存缓存**取（见 sessionOverrides）。这里不读盘：
// 装配是同步的，读盘会把 Promise 塞进提示词。
function configForScope(base, cwd, workspaceId, sessionOverride) {
  // ① 工作区层：workspaceId 优先，cwd 回退。
  const scopes = workspaceScopesOf(base)
  const workspaceOverride = workspaceId ? resolveWorkspaceOverride(workspaceId, scopes) : null
  let merged = base
  let source = 'global'
  let binding = null

  if (workspaceOverride) {
    merged = mergeWorkspaceOverride(base, workspaceOverride)
    source = 'workspace'
  } else {
    // ② 目录回退（0.8.1 语义）：索引没命中时，目录仍是可信信息。
    const resolved = resolveBindingForCwd(cwd, base.personas)
    if (resolved) {
      const persona = resolvePersona(resolved.persona, base.personas)
      if (persona) {
        const { patch } = sanitizeConfig(pickPersonaValues(persona))
        merged = { ...base, ...patch }
        source = 'directory'
        binding = resolved
      }
    }
  }

  // ③ 会话层：最贴近用户当下意图，优先级最高。
  //    它盖的是**字段**，不是整份配置 —— 只改 style 的会话覆盖，其余字段仍来自上层。
  if (sessionOverride) {
    merged = mergeSessionOverride(merged, sessionOverride)
    source = 'session'
  }

  return { config: merged, source, workspaceId: workspaceId || null, binding }
}

// 兼容既有调用点：只按 cwd 解析（不含工作区层）。
// 保留这个名字是因为 verify-*.mjs 与若干注释按它描述契约；新代码应直接用 configForScope。
function configForCwd(base, cwd) {
  const { config, binding } = configForScope(base, cwd, null, null)
  return { config, binding }
}

// 读出配置里的工作区覆盖表（已校验过的形态）。
function workspaceScopesOf(config) {
  const raw = config && config.workspaces
  if (!raw || typeof raw !== 'object') return {}
  const { scopes } = sanitizeWorkspaceScopes(raw)
  return scopes
}

// ==================== 会话级覆盖（0.9.0-c）====================
//
// 存储：`$DSH_HOME/soul-sessions/{sha256(sessionId)[:32]}.json`（与 soul-config.json 同级）。
// 校验与回收状态机在 lib/session-scope.mjs；这里只负责**内存缓存**与合并。
//
// 为什么必须有缓存：装配路径是同步的（宿主 `section.text(context)` 同步调用），
// 不能在里面 await 一次读盘。所以：
//   · 缓存按需加载（首次遇到某个 sessionId 时排一个异步读盘）；
//   · 读盘完成后写回缓存，下一轮装配即可命中；
//   · 写入（用户改覆盖）时同步更新缓存，**不等**磁盘 —— 让「改完立刻生效」成立。
//
// 失效方向是安全的：缓存未命中 ⇒ 这一轮按上层配置（工作区/全局）走，
// 最坏是"第一次生效慢一拍"，不会给出错误的人设。
const sessionOverrides = new Map()   // sessionId → override（已校验）
const sessionOverridesInFlight = new Set()
// 读过的 sessionId（含"读过但确实没有覆盖"）：避免每轮都重新排一次读盘
const sessionOverridesKnown = new Set()

// 读出某个会话的覆盖（同步，只查缓存）。
//
// 未命中时排一次异步加载并返回 null —— 本轮按上层走，下一轮生效。
function sessionOverridesOrNull(sessionId) {
  if (sessionId === null) return null
  if (sessionOverridesKnown.has(sessionId)) return sessionOverrides.get(sessionId) || null
  // 首次遇到：排一次读盘。in-flight 集合防止同一会话在一轮里被排多次。
  if (!sessionOverridesInFlight.has(sessionId)) {
    sessionOverridesInFlight.add(sessionId)
    void loadSessionOverride(sessionId).finally(() => {
      sessionOverridesInFlight.delete(sessionId)
    })
  }
  return null
}

// 读一个会话的 sidecar 进缓存。
async function loadSessionOverride(sessionId) {
  try {
    const filePath = sessionScopePathFor(configPath(), sessionId)
    const result = await readSessionScope(filePath, sessionId)
    sessionOverridesKnown.add(sessionId)
    if (result.override) sessionOverrides.set(sessionId, result.override)
    else sessionOverrides.delete(sessionId)
    return result.override
  } catch {
    // 读失败不记为"已知"：下次装配会重试（可能是临时权限问题）
    return null
  }
}

// 清掉某个会话的缓存（写入后调用，或 GC 删文件后调用）。
function forgetSessionOverride(sessionId) {
  sessionOverrides.delete(sessionId)
  sessionOverridesKnown.delete(sessionId)
}

// 会话覆盖的合并：部分覆盖 + 白名单 + 包封字段保护。
//
// 与 mergeWorkspaceOverride 同一条语义（字段级、不整份替换），但两处独立实现 ——
// 它们服务不同的数据来源，共享会让一处改动悄悄影响另一处。语义一致性由断言守住。
function mergeSessionOverride(base, override) {
  if (!override || typeof override !== 'object') return base
  const patch = {}
  for (const [key, value] of Object.entries(override)) {
    if (SESSION_ENVELOPE_ONLY_FIELDS.includes(key)) continue
    if (!SESSION_OVERRIDE_FIELDS.includes(key)) continue
    patch[key] = value
  }
  if (Object.keys(patch).length === 0) return base
  return { ...base, ...patch }
}

// 从装配上下文里取该会话的工作目录。
//
// 两个都必须容忍 undefined：
//   · `ctx` —— 宿主在 diagnostics 装配时**不传 agent**（runtime-types.d.ts:14-19 的注释
//     写明 `absent on diagnostics`）。此时回落全局配置，绝不抛错。
//   · `cwd` —— 会话头里可能没有这个字段。取不到时任何绑定都不会命中，
//     于是行为与「没有绑定功能」完全一致（失败方向安全）。
function cwdOfAgent(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : null
}

// ==================== HTTP 路由 ====================

function registerRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    // 获取配置
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/config',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        
        try {
          if (req.method === 'GET') {
            const config = await loadConfig()
            // configError：磁盘配置存在但不可用时上报（此时 config 是回退的默认值）。
            // 让设置页能直接说明「人设为什么像是被重置了」，而不是让用户自己发现；
            // 正常情况下该字段为 null，不影响既有客户端。
            send(200, {
              ok: true,
              config,
              configError: configLoadFailure ? describeConfigFailure(configLoadFailure) : null,
              // deliveryWarning：配置送达异常时上报（例如 agents 服务不可用）。
              // 与 configError 分开：configError 是「配置读不出来」，这里是「配置送不到会话」，
              // 两者症状都表现为「改了人设不生效」，但处理方式完全不同。
              deliveryWarning: deliveryProblemText(config)
            })
          } else if (req.method === 'POST') {
            const parsed = await readJsonBody(req)
            if (!parsed.ok) {
              send(parsed.status, { ok: false, error: parsed.error })
              return
            }

            // 输入校验：字段白名单 + 类型 + 长度上限 + 枚举；存在错误时整单拒绝
            const { patch, errors } = sanitizeConfig(parsed.body)
            if (Object.keys(errors).length > 0) {
              send(400, { ok: false, error: '配置校验失败：' + formatFieldErrors(errors), errors })
              return
            }

            // 写队列内「读—改—写」，只合并通过校验的字段（未知字段不落盘）
            const { config: updated, changed, promptChanged } = await commitConfig(current => ({ ...current, ...patch }), { source: 'web', action: 'save' })

            // 仅影响 Agent 行为的字段变化才刷新提示词并注入会话；
            // 光轨等纯外观字段只更新配置，不向会话堆积注入快照
            if (promptChanged.length > 0) {
              refreshPromptAndInject(ctx, updated)
            }

            send(200, { ok: true, config: updated, changed, deliveryWarning: deliveryProblemText(updated) })
          } else {
            send(405, { ok: false, error: 'Method not allowed' })
          }
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })
    
    // 获取系统提示词（当前已保存配置）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/prompt',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }
        
        try {
          // 方法校验：本端点只读。此前是唯一不判 method 的端点（同文件其余 7 处都有
          // 405 分支），实测 POST /api/soul/prompt 会拿到 200 —— 宿主只做路径匹配，
          // method 判定确实是 handler 的责任。
          if (req.method !== 'GET') {
            send(405, { ok: false, error: 'Method not allowed' })
            return
          }
          const config = await loadConfig()
          const prompt = compilePrompt(config)
          send(200, { ok: true, prompt, enabled: config.enabled })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })
    
    // 预览「未保存的编辑」编译出的 system prompt：以已保存配置为底，用请求体中
    // 通过校验的字段覆盖后编译。
    //
    // **不落盘、不注入会话** —— 纯只读旁路，供设置在保存前确认真正会被注入的内容。
    // v0.1.x 曾有同类端点，随 v0.2.0 精简重构下线；此处恢复并修掉旧实现的一个疏漏：
    // 旧版直接展开请求体（{ ...current, ...draft }）未经校验，而这里与保存路径共用
    // 同一套 sanitizeConfig —— 非法字段既不参与预览、也不会落盘，并通过 invalid
    // 回报给客户端，避免出现「预览悄悄沿用了旧值」这种看不出原因的偏差。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/prompt/preview',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        try {
          if (req.method !== 'POST') {
            send(405, { ok: false, error: 'Method not allowed' })
            return
          }

          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(parsed.status, { ok: false, error: parsed.error })
            return
          }

          const { patch, errors } = sanitizeConfig(parsed.body)
          const current = await loadConfig()
          const draft = { ...current, ...patch }

          send(200, {
            ok: true,
            prompt: compilePrompt(draft),
            enabled: draft.enabled,
            invalid: Object.keys(errors)
          })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 重置配置
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/config/reset',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        // 方法校验：这是**破坏性写**入口（重置配置、必要时丢弃并备份损坏文件），
        // 缺了它任何 HTTP 方法都能触发 —— 而 GET 是浏览器预取、爬虫、<img src>、
        // 链接预览都会发出的方法，一个 GET 就能重置用户配置。
        // 同期的 personas/save、personas/delete 都有此校验，此处属遗漏。
        if (req.method !== 'POST') {
          send(405, { ok: false, error: 'Method not allowed' })
          return
        }

        try {
          // 经由逃生口：配置损坏时这是设置页唯一还能成功的写操作。
          // backupPath 非 null 说明刚才确实丢弃了一份损坏的配置（已备份），
          // 客户端据此给出「备份在哪」的提示，而不是让用户以为数据凭空消失。
          const { config, changed, promptChanged, backupPath } = await resetConfigWithEscape({ source: 'web', action: 'reset' })

          // 仅影响 Agent 行为的字段变化才刷新提示词并注入会话
          if (promptChanged.length > 0) {
            refreshPromptAndInject(ctx, config)
          }

          send(200, { ok: true, config, changed, backupPath, deliveryWarning: deliveryProblemText(config) })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 生效链路诊断：两条通道（system prompt section / 活动会话注入）的当前状态。
    // 设置页与 /soul show 之外，这是给「改了配置不生效」提供的第三个、也是脚本化的观察点。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/status',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        try {
          if (req.method !== 'GET') {
            send(405, { ok: false, error: 'Method not allowed' })
            return
          }

          const config = await loadConfig()
          const injection = {
            lastAt: deliveryState.injectedAt,
            agents: deliveryState.agents,
            delivered: deliveryState.delivered,
            failed: deliveryState.failed,
            problem: deliveryState.injectionProblem
          }

          send(200, {
            ok: true,
            version: pluginVersion(),
            enabled: config.enabled,
            configPath: configPath(),
            configError: configLoadFailure ? describeConfigFailure(configLoadFailure) : null,
            promptChars: compilePrompt(config).length,
            channels: {
              // section 是底座：它一旦注册成功，宿主每一步装配都会重新求值
              // （不依赖任何缓存，见 scripts/verify-live-prompt.mjs）
              section: {
                registered: deliveryState.sectionRegisteredAt !== null,
                registeredAt: deliveryState.sectionRegisteredAt,
                // 当前内存里的配置修订号，以及最近一次装配实际用到的那个。
                // 两者不相等是**正常**的（装配发生在写入之前）；但用户报告「改了没生效」
                // 时，若 lastAssembledRevision 长期不前进，问题就锁定在装配没被触发，
                // 而不是配置没写进去 —— 这正是过去只能靠猜的那一步。
                configRevision,
                lastAssembledRevision: deliveryState.lastAssembledRevision,
                lastAssembledScope: deliveryState.lastAssembledScope,
                // 工作区索引：有了它才能把 sessionId 换成 workspaceId。
                // 为 null 表示从未重建成功 —— 此时一切解析都退化为 cwd 前缀匹配。
                workspaceIndexBuiltAt,
                workspaceIndexSize: sessionWorkspaceIndex.size
              },
              injection
            },
            deliveryWarning: deliveryProblemText(config)
          })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 人设预设管理端点见 registerPersonaRoutes（v0.5.0 重新提供该能力）
  })
}

// ==================== 人设预设 ====================

// 待确认的人设变更提议（set_persona 确认模式；进程内短生命周期，不做持久化）
let pendingPersonaProposal = null

// 从配置中提取人设快照（作为预设保存的内容）。
//
// 只遍历 PERSONA_FIELDS ⇒ **不含「关于你」（昵称 / 职业 / 介绍）**：预设是 Agent 的
// 人格存档，不是使用者身份存档。切换预设不该把你的昵称职业一起换掉。
// 输出语言在范围内（它决定 Agent 用什么语言作答）。
function personaSnapshotOf(config) {
  const values = {}
  for (const key of PERSONA_FIELDS) values[key] = config[key]
  return values
}

// 从预设条目中挑出人设字段（忽略 updatedAt 等元数据与「关于你」）。
// `if (key in persona)` 即「部分覆盖」语义：只应用条目**实际声明**的键，
// 未声明的保持用户当前值；而遍历白名单本身则是第二道防线——即便磁盘上残留了
// nickname / occupation / bio（历史数据），也不会被写回活动配置。
function pickPersonaValues(persona) {
  const values = {}
  for (const key of PERSONA_FIELDS) {
    if (key in persona) values[key] = persona[key]
  }
  return values
}

// 浅拷贝人设库（仅自有可枚举键，规避原型污染键）
function clonePersonas(personas) {
  const out = {}
  for (const key of Object.keys(personas || {})) out[key] = { ...personas[key] }
  return out
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key)
}

// 计算与当前活动配置匹配的预设名（多个命中时取名称排序最前）。
// 匹配语义是「部分覆盖」而非全字段相等，理由见 lib/personas.mjs 的 personaMatches。
function findActivePersonaName(config) {
  const view = mergePersonas(config.personas)
  for (const personaName of Object.keys(view).sort()) {
    if (personaMatches(view[personaName], config)) return personaName
  }
  return null
}

// 应用一个预设条目：过白名单 → 写队列合并。
//
// **必须回报被丢弃的字段**：normalizePersonas 只按字段名过滤、不校验取值，所以磁盘上
// 残留的历史值（例如 v0.1.x 的合法 style 'friendly'）或手改的异常值会走到这里被
// sanitizeConfig 拒绝。此前两条应用路径都只取 patch、把 errors 丢掉 ⇒ 预设被「部分
// 应用」却返回 ok:true / 「已应用」，用户以为整套生效了（实测：style 与 emoji 被静默
// 丢弃，只有 customInstructions 写回）。
//
// 语义选择：应用**合法部分**并如实回报被丢弃的字段，而不是整单拒绝 —— 后者会让一个
// 只差一个字段的旧预设彻底不可用，代价更高；而「部分应用 + 明示」与 /api/soul/prompt/
// preview 的 invalid 约定一致。
//
// 来源固定为 persona/use：两个调用入口（网页「使用」与 /soul use）是同一个动作，
// 用户视角下「用了个预设」这件事本身比「从哪个入口点的」更重要，故不细分。
async function applyPersonaEntry(ctx, entry) {
  const { patch, errors } = sanitizeConfig(pickPersonaValues(entry))
  const invalid = Object.keys(errors)
  // label 带上预设名：审计里「应用预设」这条记录光有字段差，缺「应用的是什么」——
  // 用户问「昨晚我切到了哪个人设」时，字段差答不上来。
  const { config: updated, changed, promptChanged } = await commitConfig(
    c => ({ ...c, ...patch }),
    { source: 'persona', action: 'use', label: entry && typeof entry.name === 'string' ? entry.name : undefined }
  )
  if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
  // applied 是「通过校验的字段数」——与 changed（实际产生差异的字段）不同：
  // 全部非法时 applied 为 0，此时不能报「已应用」，也不能报「与当前配置一致」。
  return { updated, changed, promptChanged, invalid, applied: Object.keys(patch).length }
}

// 预设库的对外视图（内置 + 用户）与当前命中项，供三个路由的响应复用。
function personaLibrary(config) {
  return { personas: mergePersonas(config.personas), activeName: findActivePersonaName(config) }
}

// 人设预设 HTTP 路由：列表 / 保存 / 使用 / 删除。
// 保存与删除仅变更 personas 库（diffKeys 跳过该字段），不会触发会话注入；
// 使用会变更活动配置字段，走常规 promptChanged 门控注入。
function registerPersonaRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // 列表
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/personas',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const config = await loadConfig()
          send(res, 200, { ok: true, ...personaLibrary(config) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 保存当前配置为预设（upsert）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/personas/save',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const personaName = sanitizePersonaName(parsed.body && parsed.body.name)
          if (!personaName) {
            send(res, 400, { ok: false, error: `预设名称无效（1-${PERSONA_NAME_MAX} 个字符）` })
            return
          }
          // 内置名一律不可写入：内置预设只存在于代码里，若允许同名落盘，合并视图会
          // 遮蔽它，用户就会得到一个「保存了却看不见、也删不掉」的幽灵条目。
          if (isBuiltinPersona(personaName)) {
            send(res, 400, { ok: false, error: `「${personaName}」是内置预设，请换一个名称` })
            return
          }
          const { config: updated } = await commitConfig((current) => {
            const personas = clonePersonas(current.personas)
            personas[personaName] = { ...personaSnapshotOf(current), updatedAt: new Date().toISOString() }
            return { ...current, personas }
          }, { source: 'web', action: 'savePreset' })
          send(res, 200, { ok: true, ...personaLibrary(updated) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 使用预设：将预设字段应用到活动配置（走 promptChanged 门控注入）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/personas/use',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const personaName = sanitizePersonaName(parsed.body && parsed.body.name)
          const current = await loadConfig()
          // 内置与用户预设共用同一条应用路径（resolvePersona 先内置后用户）
          const entry = personaName ? resolvePersona(personaName, current.personas) : null
          if (!entry) {
            send(res, 400, { ok: false, error: `预设不存在：${personaName || '(空)'}` })
            return
          }
          // 内置预设已在代码里写过一遍；用户预设保存时也校验过。此处统一再过一遍
          // 白名单，防御手改 config.json 注入的异常数据。
          // invalid = 因取值非法而被丢弃的字段名：必须回报，不能静默部分应用。
          const { updated, changed, invalid, applied } = await applyPersonaEntry(ctx, entry)
          // 一个合法字段都没有 ⇒ 什么都没应用，按失败处理（与 /soul use 同语义）
          if (applied === 0) {
            send(res, 400, { ok: false, error: `预设「${personaName}」没有可应用的合法字段`, invalid })
            return
          }
          send(res, 200, { ok: true, config: updated, changed, unchanged: changed.length === 0, invalid })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 删除预设
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/personas/delete',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const personaName = sanitizePersonaName(parsed.body && parsed.body.name)
          // 内置预设不可删除。这一层必须挡在「磁盘库是否存在」之前：内置项本来就不在
          // 磁盘库里，但手改文件可能留下同名残留，那种条目已被合并视图遮蔽、删它没有
          // 意义，而调用方真正想删的是内置项——直接拒绝，语义才唯一。
          if (personaName && isBuiltinPersona(personaName)) {
            send(res, 400, { ok: false, error: `「${personaName}」是内置预设，无法删除` })
            return
          }
          const current = await loadConfig()
          if (!personaName || !hasOwn(current.personas || {}, personaName)) {
            send(res, 400, { ok: false, error: `预设不存在：${personaName || '(空)'}` })
            return
          }
          const { config: updated } = await commitConfig((c) => {
            const personas = clonePersonas(c.personas)
            delete personas[personaName]
            return { ...c, personas }
          }, { source: 'web', action: 'deletePreset' })
          send(res, 200, { ok: true, ...personaLibrary(updated) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 人设插画：/api/soul/persona-art/<内置人设名>
    //
    // 用 prefix 路由（WebRouteKind 支持 'exact' | 'prefix'）而不是 query 参数：
    // 路径里直接带人设名，浏览器可对每个 URL 独立缓存与复用连接。
    // 名字必须命中内置人设白名单（isBuiltinPersona），路径穿越因此不可能发生。
    wsCtx.webServer.register({
      kind: 'prefix',
      path: '/api/soul/persona-art',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
            return
          }
          const raw = String(req.url || '').split('?')[0]
          const name = decodeURIComponent(raw.slice('/api/soul/persona-art'.length).replace(/^\/+/, ''))
          const art = resolvePersonaArt(name)
          if (!art) {
            // 图与占位图都没有（理论上只会在 assets 被外部删空时出现）
            res.writeHead(404, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ ok: false, error: `没有可用的插画：${name || '(空)'}` }))
            return
          }
          const body = readFileSync(art.file)
          res.writeHead(200, {
            'content-type': art.mime,
            'content-length': String(body.length),
            // 图随包发布、路径即内容标识 ⇒ 可长期缓存；换图必然伴随版本号变化
            'cache-control': 'public, max-age=86400'
          })
          res.end(body)
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: false, error: String(err.message || err) }))
        }
      }
    })
  })
}

// ==================== 变更记录 ====================

// 解析 ?limit=。非法值一律当作「没给」而不是报错：这是一个纯展示参数，
// 为一个拼错的查询串返回 400 只会让客户端多写一段没必要的错误处理。
function parseLimit(rawUrl) {
  try {
    const raw = new URL(String(rawUrl || ''), 'http://localhost').searchParams.get('limit')
    if (raw === null) return null
    const value = Number.parseInt(raw, 10)
    if (!Number.isFinite(value) || value <= 0) return null
    return Math.min(value, MAX_READ_LINES)
  } catch {
    return null
  }
}

// 变更记录的四条路由：列表 / 撤销 / 恢复预设 / 清空。
//
// 一律先校验 req.method（同文件其余写路由的规矩，来自 /api/soul/config/reset
// 曾经任何方法——包括 GET——都能触发破坏性写入的教训）。
//
// 撤销与恢复预设都走唯一漏斗 commitConfig，于是「我撤销过一次」本身也留下一条记录：
// 审计因此是链条而不是快照，能看出「改了、撤了、又改回去」。
function registerHistoryRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // 列表（最新在前）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/history',
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const read = await readHistoryFile(historyPath())
          // max 必须来自**当前配置**（用户改了保留条数，UI 的「最多保留 N 条」就得跟着变）；
          // 读配置失败时回退默认值 —— 列表读取不该因为配置层的抖动而 500。
          let maxEntries
          try {
            maxEntries = (await loadConfig()).historyMaxEntries
          } catch {
            maxEntries = undefined
          }
          const payload = toHistoryResponse(read, lastHistoryFailure, maxEntries)
          // ?limit= 只影响本次返回的条数，**不动 max** —— max 是容量上限（压实后保多少条），
          // 拿它当「本次有多少条」用，客户端会在两种含义之间猜。
          const limit = parseLimit(req.url)
          if (limit !== null && payload.entries.length > limit) {
            payload.entries = payload.entries.slice(0, limit)
          }
          send(res, 200, { ok: true, ...payload })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 撤销：把配置退回到目标条目**发生之前**的状态（连带撤销它之后的所有改动）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/history/rollback',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const id = typeof (parsed.body && parsed.body.id) === 'string' ? parsed.body.id : ''
          if (!id) {
            send(res, 400, { ok: false, error: '缺少要撤销的记录 id' })
            return
          }

          let plan = null
          const { config: updated, changed, promptChanged, entry } = await commitConfig(async (current) => {
            // 记录必须在**队列内**读：放到队列外读会与并发写入形成窗口，规划建立在
            // 已被别人改过的配置上，指纹校验随后报出一个看起来像「数据损坏」的
            // diverged，把排查方向带偏。
            const read = await readHistoryFile(historyPath())
            if (read.error) throw httpError(500, read.error)
            plan = planRollback(read.entries, current, id)
            if (!plan.ok) {
              if (plan.reason === 'missing') {
                throw httpError(400, `找不到这条变更记录：${id}。它可能已被清空或压实淘汰。`)
              }
              // diverged：配置与记录不同步（有人手改过配置文件）。不给一个猜出来的结果。
              throw httpError(409, '记录与当前配置对不上，无法撤销。可能有人手工改过配置文件。')
            }
            // 补丁为空是**合法**结果（目标那次改动已被后续改动改回来了），
            // 此时不改任何字段、也不会留下记录，由 unchanged 告诉客户端「已经是最新」。
            if (Object.keys(plan.patch).length === 0) return { ...current }
            return { ...current, ...plan.patch }
          }, { source: 'rollback', action: 'rollback' })

          // 仅影响 Agent 行为的字段变化才刷新提示词注入（与其余写路径同一门控）
          if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)

          send(res, 200, {
            ok: true,
            config: updated,
            changed,
            skipped: plan ? plan.skipped : [],
            reversed: plan ? plan.reversed : [],
            unchanged: changed.length === 0,
            entry,
            deliveryWarning: deliveryProblemText(updated)
          })
        } catch (err) {
          const status = err && err.httpStatus ? err.httpStatus : 500
          send(res, status, { ok: false, error: String((err && err.message) || err) })
        }
      }
    })

    // 恢复预设：只对「删除预设」这类条目有意义（条目里带着被删条目的内容）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/history/restore-persona',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const id = typeof (parsed.body && parsed.body.id) === 'string' ? parsed.body.id : ''
          if (!id) {
            send(res, 400, { ok: false, error: '缺少记录 id' })
            return
          }

          const restored = []
          const skipped = []
          const { config: updated, changed, entry } = await commitConfig(async (current) => {
            const read = await readHistoryFile(historyPath())
            if (read.error) throw httpError(500, read.error)
            const index = findEntryIndex(read.entries, id)
            if (index < 0) {
              throw httpError(400, `找不到这条变更记录：${id}。它可能已被清空或压实淘汰。`)
            }
            const removed = read.entries[index].personas.removed
            if (removed.length === 0) {
              throw httpError(400, '这条记录里没有被删除的预设，无法恢复。')
            }
            const personas = clonePersonas(current.personas)
            for (const item of removed) {
              // 逐个校验、逐个说明为什么没恢复。**绝不静默覆盖同名条目**：
              // 删掉「架构师」之后完全可能又新建了一个同名但内容不同的预设，
              // 此时「恢复」若是直接写回，等于把用户后来的编辑悄悄扔掉。
              const personaName = sanitizePersonaName(item.name)
              if (!personaName) {
                skipped.push({ name: item.name, reason: 'invalid-name' })
                continue
              }
              if (isBuiltinPersona(personaName)) {
                skipped.push({ name: personaName, reason: 'builtin' })
                continue
              }
              if (hasOwn(personas, personaName)) {
                skipped.push({ name: personaName, reason: 'exists' })
                continue
              }
              personas[personaName] = { ...item.entry }
              restored.push(personaName)
            }
            if (restored.length === 0) {
              throw httpError(400, `没有可恢复的预设：${skipped.map((item) => item.name).join('、')}`)
            }
            return { ...current, personas }
          }, { source: 'restorePersona', action: 'restorePreset' })

          // 预设库变化不触发会话注入（diffKeys 本就跳过 personas），故此处不刷新提示词
          send(res, 200, { ok: true, restored, skipped, changed, entry, ...personaLibrary(updated) })
        } catch (err) {
          const status = err && err.httpStatus ? err.httpStatus : 500
          send(res, status, { ok: false, error: String((err && err.message) || err) })
        }
      }
    })

    // 清空：隐私出口（记录里有昵称 / 职业 / 介绍 / 自定义指令的原文）
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/history/clear',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          // 借配置写队列串行：记录是在提交路径里写的，清空若不入队就会与并发的追加
          // 撞在一起 —— 最坏的结果是「刚清完又冒出一条」，用户会以为清空没生效。
          const removed = await enqueueConfigWrite(async () => {
            const count = await clearHistoryFile(historyPath())
            lastHistoryFailure = null
            return count
          })
          send(res, 200, { ok: true, removed })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })
  })
}

// ==================== 工作区绑定路由 ====================

// 绑定表的写队列。与配置队列（enqueueConfigWrite）**刻意是两个实例**（设计 §4.3）：
// 两套数据在因果上无关 —— 绑定的写入不依赖配置的当前值，反之亦然 —— 共用一个队列
// 只会把两者的延迟叠在一起，一次慢写的绑定请求会挡住配置保存。
let bindingsWriteQueue = Promise.resolve()

function enqueueBindingsWrite(task) {
  const run = bindingsWriteQueue.then(task)
  bindingsWriteQueue = run.then(() => {}, () => {})
  return run
}

// 活动会话的目录与解析结果，供设置页回答「我这个项目现在是谁」。
//
// 为什么必须由宿主算：设置页的槽位 scope 是 `root`（设计 §7.7），它**拿不到
// sessionId**，也就拿不到会话 cwd。宿主遍历 agents.list() 是唯一权威的来源。
//
// 取 `session.header.cwd` 而不是工作区根：两者可能不同（工作区 D:\AliuProject、
// 会话 cwd D:\AliuProject\dsh-plugin），显示错粒度会让用户绑错层级。
function describeActiveSessions(ctx, config) {
  const out = []
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') return out

  let listed
  try {
    listed = agents.list()
  } catch {
    // 列不出活动会话不是错误：设置页只是少一段「当前用的谁」，仍能管理绑定表。
    return out
  }

  for (const agent of listed) {
    const cwd = cwdOfAgent(agent)
    const id = agent && typeof agent.id === 'string' ? agent.id : null

    if (!cwd) {
      // cwd 缺席是宿主允许的情况（会话没有工作目录）。必须如实说出来 ——
      // 让用户对着空白猜「为什么绑了没生效」，不如直接告诉他这个会话没有目录。
      out.push({ id, cwd: null, persona: findActivePersonaName(config), binding: null, shadowed: [] })
      continue
    }

    const resolved = resolveBindingForCwd(cwd, config.personas)
    // 生效人设走与真实装配**同一条路径**（configForCwd → 部分覆盖 → findActivePersonaName），
    // 否则设置页显示的「生效人设」与实际注入的可能不一致 —— 那正是最难查的一类 bug。
    const effective = configForCwd(config, cwd).config

    let binding = null
    if (resolved) {
      // 「直接绑定」与「继承自上级」的判别**必须在宿主做**：客户端拿原始串比较时，
      // Windows 上 `D:\项目A` 与 `d:\项目a` 会被判成不同目录，于是「就是本目录」
      // 被显示成「继承自上级」，用户会去找一条并不存在的父级绑定。
      const sameDir = compareKey(normalizeDirPath(resolved.dir)) === compareKey(normalizeDirPath(cwd))
      binding = { dir: resolved.dir, persona: resolved.persona, inherited: !sameDir }
    }

    out.push({
      id,
      cwd,
      persona: findActivePersonaName(effective),
      binding,
      shadowed: resolved ? resolved.shadowed : []
    })
  }

  return out
}

// 绑定表的可读形态（列表 + 失效标注 + 解析结果）。
async function bindingsView(ctx) {
  const cache = await ensureBindings()
  const config = await loadConfig()

  // 失效引用：指向的人设已不存在。**不自动删除**（设计 §4.2）——用户可能只是临时
  // 删了那个预设、打算重命名回来。但必须显式标注，否则用户在目录里等一个永远
  // 不会来的人设。
  const invalid = []
  for (const dir of Object.keys(cache.bindings)) {
    const name = cache.bindings[dir]
    if (!resolvePersona(name, config.personas)) invalid.push({ dir, persona: name })
  }

  return {
    bindings: cache.bindings,
    invalid,
    dropped: cache.dropped,
    // warning 是「整表没读进来」或「有条目被丢弃」，与「一条都没绑」是两件事。
    warning: bindingsLoadFailure,
    max: MAX_BINDINGS,
    maxPathLength: MAX_PATH_LENGTH,
    sessions: describeActiveSessions(ctx, config)
  }
}

function registerBindingRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // 写完之后统一收尾：重载绑定表 → 刷新提示词并注入。
    //
    // 这是**第三类**会改变提示词的事实（设计 §6.4）：它不改 soul-config.json，
    // 所以 commitConfig 的 promptChanged 门控看不见它。绑定路由必须自己触发，
    // 否则「刚绑好，会话里却不生效，要新开会话才行」。
    const afterBindingsWrite = async (config) => {
      await loadBindings()
      const fresh = config || (await loadConfig())
      refreshPromptAndInject(ctx, fresh)
    }

    // GET = 读取（绑定表 + 当前活动会话的解析结果）；POST = 新增 / 改绑。
    //
    // 同一 (kind, path) 只能 register **一次**：宿主 dsh-host-webserver 的
    // `register()` 对重复路径直接 `throw new Error('webserver: duplicate exact
    // route "' + path + '"')`，而这里是 ctx.inject 回调 —— 一次重复注册会让
    // 整个插件装配失败。故方法分派必须写在 handler 内，这也正是本文件其余
    // 14 条路由的范式。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/bindings',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            send(res, 200, { ok: true, ...(await bindingsView(ctx)) })
          } catch (err) {
            send(res, 500, { ok: false, error: String(err.message || err) })
          }
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'Method not allowed' })
          return
        }
        try {
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }

          const config = await loadConfig()
          // 准入检查挑出三类拒绝（路径非法 / 过长 / 人设不存在），
          // 原因文案可直接展示 —— 客户端不得再包一层前缀。
          const refusal = bindingRefusal(parsed.body && parsed.body.dir, parsed.body && parsed.body.persona, config.personas)
          if (refusal) {
            send(res, 400, { ok: false, error: refusal })
            return
          }
          const entry = normalizeBindingEntry(parsed.body && parsed.body.dir, parsed.body && parsed.body.persona, config.personas)
          if (!entry) {
            send(res, 400, { ok: false, error: '绑定内容不合法，未写入。' })
            return
          }

          await enqueueBindingsWrite(async () => {
            // 队列内读盘再合并：队列外读会与并发写入形成窗口，后写覆盖前写。
            const read = await readBindingsFile(bindingsPath())
            if (read.failure) throw httpError(500, read.failure)
            const table = { ...read.bindings }
            // 已存在的目录改绑不算新增，只有真新增才受条数上限约束 ——
            // 否则满表之后连改绑都做不了，用户只能先删再绑。
            const isNew = !hasOwn(table, entry.dir)
            if (isNew && Object.keys(table).length >= MAX_BINDINGS) {
              throw httpError(400, `绑定数量已达上限（${MAX_BINDINGS} 条），请先删除不再需要的绑定。`)
            }
            table[entry.dir] = entry.persona
            await writeBindingsFile(bindingsPath(), table)
          })

          await afterBindingsWrite(config)
          send(res, 200, { ok: true, ...(await bindingsView(ctx)) })
        } catch (err) {
          // 队列内抛出的 httpError 带状态码；其余按 500 处理。
          send(res, err.httpStatus || 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 解绑
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/bindings/delete',
      handler: async (req, res) => {
        try {
          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const target = normalizeDirPath(parsed.body && parsed.body.dir)
          if (!target) {
            send(res, 400, { ok: false, error: '需要一个绝对路径才能解绑。' })
            return
          }

          const config = await loadConfig()
          let removed = false
          await enqueueBindingsWrite(async () => {
            const read = await readBindingsFile(bindingsPath())
            if (read.failure) throw httpError(500, read.failure)
            const table = { ...read.bindings }
            // 按**比较键**找：用户点了列表里那一行，但配置里存的可能是另一种写法
            // （分隔符、尾分隔符、盘符大小写）。拿原串直接 delete 会「点了没反应」。
            const key = Object.keys(table).find(dir => compareKey(dir) === compareKey(target))
            if (key === undefined) return
            delete table[key]
            removed = true
            await writeBindingsFile(bindingsPath(), table)
          })

          // 没删掉任何东西时**不刷新**：一次空解绑不该向所有活动会话注入快照。
          if (removed) await afterBindingsWrite(config)
          send(res, 200, { ok: true, removed, ...(await bindingsView(ctx)) })
        } catch (err) {
          send(res, err.httpStatus || 500, { ok: false, error: String(err.message || err) })
        }
      }
    })
  })
}

// ==================== 工作区索引（sessionId → workspaceId）====================

// 维护 sessionWorkspaceIndex 的三条时机（DESIGN-config-scope.md §2.2）：
//
//   ① 首轮重建 —— 服务刚就绪时索引必然是空的；
//   ② 宿主工作区变更 —— 加/删工作区、会话移入移出，都会改变映射；
//   ③ 兜底重扫 —— 装配时发现「有 sessionId 但索引里没有」就标记，下一拍重建。
//
// ③ 是必需的：②依赖宿主的事件名（内部约定，可能改名）。没有兜底的话，
// 事件一旦改名，索引会**静默停止更新** —— 表现为「工作区绑定时灵时不灵」，
// 而 ③ 让它的失败形态退化成「多扫一次内存投影」，代价可以忽略。
function registerWorkspaceIndex(ctx) {
  const rebuild = () => rebuildWorkspaceIndex(ctx)

  // ① 首轮：延后一拍，给宿主服务一个物化窗口。
  const firstTimer = setTimeout(rebuild, 0)
  if (typeof firstTimer.unref === 'function') firstTimer.unref()

  // ② 事件：宿主工作区域变更。事件名取自 dsh-workspace 的 domain 事件。
  //    订阅失败（宿主无该事件）不是错误 —— 还有 ③ 兜底。
  try {
    ctx.on('domain/changed', () => { rebuild() })
  } catch {
    // 事件名不存在时 ctx.on 可能直接抛错；吞掉，靠 ③。
  }

  // ③ 兜底：装配时未命中的 sessionId 会被记下来，这里周期性重扫。
  //    用 5s 而不是每轮：索引是内存投影，重建本身很轻，但没必要每个 step 都做。
  const sweepTimer = setInterval(() => {
    if (pendingWorkspaceRescan === 0) return
    pendingWorkspaceRescan = 0
    rebuild()
  }, 5000)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()

  ctx.effect(() => () => {
    clearTimeout(firstTimer)
    clearInterval(sweepTimer)
  }, 'dsh-soul: workspace index')
}

// 装配时发现「有 sessionId 但索引查不到」的次数。由 section.text 递增（同步、无副作用），
// 由上面的定时器消费。刻意用计数器而不是 Set：装配是每轮都跑的，Set 会无限增长。
let pendingWorkspaceRescan = 0

// ==================== 工作区路由 ====================

// 工作区覆盖的读写。与绑定路由**刻意分开**：绑定是独立的 soul-bindings.json，
// 工作区覆盖是 soul-config.json 的一个字段 —— 后者必须走配置写队列与审计。
function registerWorkspaceRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // 一次性读全：宿主的工作区列表 + 当前配置里的覆盖表 + 每个工作区的解析结果。
    //
    // 全部由**宿主**算，设置页/详情页只负责画 —— 它们拿不到 workspaceRegistry
    // （客户端侧是 `workspaces` 服务，是另一份投影）。
    const workspaceView = async () => {
      const config = await loadConfig()
      const registry = ctx.get('workspaceRegistry')
      const scopes = workspaceScopesOf(config)

      const workspaces = []
      let indexProblem = null
      if (!registry || typeof registry.list !== 'function') {
        indexProblem = 'workspaceRegistry 服务不可用：无法列出宿主的工作区。'
      } else {
        let listed = []
        try {
          listed = registry.list()
        } catch (err) {
          indexProblem = `列出工作区失败：${String((err && err.message) || err)}`
        }
        const personaNames = { ...(config.personas || {}) }
        for (const workspace of Array.isArray(listed) ? listed : []) {
          const id = workspace && workspace.id !== undefined ? String(workspace.id) : null
          if (id === null) continue
          const override = resolveWorkspaceOverride(id, scopes)
          // 失效引用：覆盖指向的人设已不存在。**如实标出但不自动删除** ——
          // 用户可能只是临时改名，删掉就再也找不回来了（与绑定表同一条约定）。
          // 引用字段说明「当初绑的是谁」：预设被改名/删除后，覆盖的字段值仍在生效，
          // 但界面必须能说出这条覆盖已经指向空气 —— 否则用户看到一堆陌生字段无从判断。
          const refName = override && typeof override[WORKSPACE_PERSONA_REF] === 'string'
            ? override[WORKSPACE_PERSONA_REF]
            : null
          const invalidPersona = refName !== null && !(refName in personaNames)
          workspaces.push({
            workspaceId: id,
            title: typeof workspace.title === 'string' ? workspace.title : '',
            path: typeof workspace.path === 'string' ? workspace.path : '',
            sessionCount: Array.isArray(workspace.sessionIds) ? workspace.sessionIds.length : 0,
            bound: override !== null,
            // 绑的是哪个预设：界面要显示它，而不是只说"已绑定"。
            // 失效时仍原样返回 —— 用户需要看到"它原本指向谁"才能判断怎么处理。
            persona: refName,
            invalidPersona
          })
        }
      }

      return {
        workspaces,
        indexProblem,
        max: MAX_WORKSPACE_SCOPES,
        // 供 UI 展示「当前有几条覆盖」。数字取自配置而非上面的列表：
        // 覆盖可以指向一个已被删除的工作区，那种条目仍占着表。
        boundCount: Object.keys(scopes).length
      }
    }

    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/workspaces',
      handler: async (req, res) => {
        if (req.method === 'GET') {
          try {
            send(res, 200, { ok: true, ...(await workspaceView()) })
          } catch (err) {
            send(res, 500, { ok: false, error: String(err.message || err) })
          }
          return
        }
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'Method not allowed' })
          return
        }

        try {
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }

          const config = await loadConfig()
          const verdict = validateWorkspaceBinding(parsed.body, config.personas)
          if (!verdict.ok) {
            send(res, 400, { ok: false, error: verdict.error })
            return
          }

          // 走配置写队列：与 HTTP 保存 / 命令 / 工具共用同一条串行路径，
          // 并自动获得变更审计（source = web, action = save）。
          await commitConfig((current) => {
            const scopes = workspaceScopesOf(current)
            scopes[verdict.workspaceId] = verdict.override
            const next = { ...current, workspaces: { version: WORKSPACE_SCOPE_VERSION, scopes } }
            return next
          }, { source: 'web', action: 'save' })

          // 工作区改的是**人设**，必须重算提示词并注入 —— commitConfig 的
          // promptChanged 看不见 workspaces（它不在 AUDIT_FIELDS / PROMPT_INPUT_FIELDS 里）。
          const fresh = await loadConfig()
          refreshPromptAndInject(ctx, fresh)

          send(res, 200, { ok: true, ...(await workspaceView()) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 解绑：把某个工作区从覆盖表里删掉。与绑定路由的 /delete 同一形态。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/workspaces/delete',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'Method not allowed' })
          return
        }
        try {
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          const workspaceId = parsed.body && parsed.body.workspaceId
          if (typeof workspaceId !== 'string' || workspaceId.trim() === '') {
            send(res, 400, { ok: false, error: '缺少 workspaceId' })
            return
          }

          let removed = false
          await commitConfig((current) => {
            const scopes = workspaceScopesOf(current)
            if (!(workspaceId in scopes)) return current
            removed = true
            const next = { ...scopes }
            delete next[workspaceId]
            // 删空后把字段整个去掉：留一个 `{ version, scopes: {} }` 会让「从未设过」
            // 与「设过又全删了」在磁盘上不可区分，排查时看不出真相。
            const empty = Object.keys(next).length === 0
            return { ...current, workspaces: empty ? undefined : { version: WORKSPACE_SCOPE_VERSION, scopes: next } }
          }, { source: 'web', action: 'save' })

          if (removed) {
            const fresh = await loadConfig()
            refreshPromptAndInject(ctx, fresh)
          }
          send(res, 200, { ok: true, removed, ...(await workspaceView()) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })
  })
}

// ==================== 会话级覆盖路由（0.9.0-c）====================

// 会话覆盖的读写 + 回收。三条路由：
//   GET  /api/soul/session-scope?sessionId=...   读该会话的覆盖与解析结果
//   POST /api/soul/session-scope                 设置 / 清除该会话的覆盖
//   POST /api/soul/session-scope/gc              回收（默认 dry-run）
//
// 与工作区覆盖的区别：工作区写**配置**（走 commitConfig、进审计、有变更历史）；
// 会话写**状态**（sidecar、不进审计）。这不是疏漏：「改了这次会话用什么人设」是
// 一次性的临时动作，记进变更历史只会把时间线淹没。
function registerSessionScopeRoutes(ctx) {
  ctx.inject(['webServer'], (wsCtx) => {
    const send = (res, status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    // 会话覆盖的「当前值 + 解析结果」，供会话内 tab 显示。
    //
    // 全部在宿主算：客户端拿不到 sessionId → workspaceId 的权威映射（那是宿主侧索引）。
    const sessionScopeView = async (sessionId) => {
      const config = await loadConfig()
      const override = await loadSessionOverride(sessionId)
      const workspaceId = sessionWorkspaceIndex.get(String(sessionId)) || null
      const resolved = configForScope(config, null, workspaceId, override)

      // 生效人设名：走与真实装配**同一条路径**，否则 tab 上显示的与模型拿到的不一致。
      return {
        sessionId,
        workspaceId,
        override: override || null,
        source: resolved.source,
        activePersona: findActivePersonaName(resolved.config),
        workspaceTitle: (() => {
          if (workspaceId === null) return null
          const registry = ctx.get('workspaceRegistry')
          if (!registry || typeof registry.list !== 'function') return null
          try {
            const hit = registry.list().find((w) => String(w.id) === workspaceId)
            return hit && typeof hit.title === 'string' ? hit.title : null
          } catch {
            return null
          }
        })()
      }
    }

    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/session-scope',
      handler: async (req, res) => {
        try {
          if (req.method === 'GET') {
            const url = new URL(req.url, 'http://localhost')
            const sessionId = url.searchParams.get('sessionId') || ''
            if (!isSessionId(sessionId)) {
              send(res, 400, { ok: false, error: '缺少或非法的 sessionId' })
              return
            }
            send(res, 200, { ok: true, ...(await sessionScopeView(sessionId)) })
            return
          }

          if (req.method !== 'POST') {
            send(res, 405, { ok: false, error: 'Method not allowed' })
            return
          }

          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }

          const sessionId = parsed.body && parsed.body.sessionId
          if (!isSessionId(sessionId)) {
            send(res, 400, { ok: false, error: '缺少或非法的 sessionId' })
            return
          }

          const filePath = sessionScopePathFor(configPath(), sessionId)

          // `clear: true` = 清除覆盖。显式动作而非"传空对象"，因为空对象与
          // "只想改一个字段、其余保留"在语义上无法区分。
          if (parsed.body && parsed.body.clear === true) {
            // 删文件：用 quarantine 而不是 rm？—— 这里**必须是真删**：
            // 用户主动清除覆盖，把一个 .bad 文件留在磁盘上只会污染 GC 的清单。
            // 但删除失败要如实报告，不能假装成功。
            let removed = false
            try {
              const { rm } = await import('node:fs/promises')
              await rm(filePath, { force: true })
              removed = true
            } catch (err) {
              send(res, 500, { ok: false, error: `清除失败：${String((err && err.message) || err)}` })
              return
            }
            forgetSessionOverride(sessionId)
            if (removed) refreshPromptAndInject(ctx, await loadConfig())
            send(res, 200, { ok: true, ...(await sessionScopeView(sessionId)) })
            return
          }

          // 设置覆盖：白名单过滤，enabled 等包封字段一律丢弃。
          const { override, dropped } = sanitizeSessionOverride(parsed.body && parsed.body.overrides)
          if (override === null) {
            send(res, 400, {
              ok: false,
              error: dropped.length > 0
                ? `没有可用的覆盖字段（被忽略：${dropped.join(', ')}）`
                : '缺少 overrides'
            })
            return
          }

          // 保留原有的 createdAt 与孤儿标记：重写覆盖不等于"这个会话是新出现的"。
          const previous = await readSessionScope(filePath, sessionId)
          const now = Date.now()
          const doc = {
            ...createSessionScopeDoc(sessionId, override, now),
            createdAt: (previous.doc && previous.doc.createdAt) || new Date(now).toISOString(),
            ...(previous.orphan ? { orphan: previous.orphan } : {})
          }
          await writeSessionScope(filePath, doc)

          // **先写缓存再刷新提示词**：缓存更新是同步的，保证紧接着的那一轮装配
          // 一定能看到新值。若等磁盘异步完成再刷，装配可能先跑、读到旧缓存。
          sessionOverrides.set(sessionId, override)
          sessionOverridesKnown.add(sessionId)
          refreshPromptAndInject(ctx, await loadConfig())

          send(res, 200, { ok: true, dropped, ...(await sessionScopeView(sessionId)) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // —— 回收：默认 dry-run ——
    //
    // 判定依据是 `sessionPersistence.list()`（扫磁盘会话文件），**绝不是** `agents.list()`
    // （那是 live registry，会话切走就消失，用它判定会误删正在使用的覆盖）。
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/session-scope/gc',
      handler: async (req, res) => {
        if (req.method !== 'POST') {
          send(res, 405, { ok: false, error: 'Method not allowed' })
          return
        }
        try {
          const parsed = await readJsonBody(req)
          if (!parsed.ok) {
            send(res, parsed.status, { ok: false, error: parsed.error })
            return
          }
          // 只有显式 apply:true 才会真的删。默认 dry-run。
          const apply = parsed.body && parsed.body.apply === true

          const plan = await planSessionGc(ctx)
          const result = { ok: true, dryRun: !apply, ...plan }

          if (apply && plan.collectable.length > 0) {
            const removed = []
            for (const item of plan.collectable) {
              try {
                const { rm } = await import('node:fs/promises')
                await rm(item.path, { force: true })
                forgetSessionOverride(item.sessionId)
                removed.push(item.sessionId)
              } catch (err) {
                result.errors = result.errors || []
                result.errors.push({ sessionId: item.sessionId, error: String((err && err.message) || err) })
              }
            }
            result.removed = removed
            if (removed.length > 0) refreshPromptAndInject(ctx, await loadConfig())
          }

          send(res, 200, result)
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })
  })
}

// 规划一次回收：读全部 sidecar、比对磁盘会话清单、跑状态机。
//
// 关键：`scanComplete` 反映的是「本轮会话清单是否可信」。拿不到
// `sessionPersistence` 时它必须是 false —— 那会让状态机对**所有**条目返回 keep，
// 于是「服务不可用」不会演变成「把所有覆盖当孤儿删掉」。
async function planSessionGc(ctx) {
  const dir = sessionScopeDirFor(configPath())
  const files = await listSessionScopes(dir)

  // 磁盘上的会话清单。
  let stored = null
  let persistenceProblem = null
  const persistence = ctx.get('sessionPersistence')
  if (!persistence || typeof persistence.list !== 'function') {
    persistenceProblem = 'sessionPersistence 服务不可用：无法确认哪些会话仍然存在，本轮不做任何判定'
  } else {
    try {
      const listed = await persistence.list()
      stored = new Set(
        (Array.isArray(listed) ? listed : [])
          .map((item) => (item && item.id !== undefined ? String(item.id) : ''))
          .filter((id) => id !== '')
      )
    } catch (err) {
      persistenceProblem = `列出会话失败：${String((err && err.message) || err)}；本轮不做任何判定`
    }
  }

  const scanComplete = stored !== null && persistenceProblem === null
  const now = Date.now()

  const entries = []
  for (const file of files) {
    const item = {
      file: file.name,
      path: file.path,
      sessionId: null,
      action: 'keep',
      reason: '',
      graceDaysLeft: null,
      failure: null
    }

    // 从内容里读 sessionId（文件名是哈希，无法反查）。读不出就只报告，不动它。
    let doc
    try {
      doc = JSON.parse(await (await import('node:fs/promises')).readFile(file.path, 'utf8'))
    } catch (err) {
      item.action = 'quarantine'
      item.reason = `sidecar 读不出来或不是合法 JSON：${String((err && err.message) || err)}`
      entries.push(item)
      continue
    }

    const sessionId = doc && typeof doc.sessionId === 'string' ? doc.sessionId : null
    if (!isSessionId(sessionId)) {
      item.action = 'quarantine'
      item.reason = 'sidecar 内缺少合法的 sessionId（无法与文件名互相校验）'
      entries.push(item)
      continue
    }
    item.sessionId = sessionId

    // 内容与文件名必须互相对应：改个文件名就能让某个会话读到另一个会话的覆盖。
    const expectedName = sessionScopePathFor(configPath(), sessionId)
    if (expectedName !== file.path) {
      item.action = 'quarantine'
      item.reason = `文件名与内容里的 sessionId 不符（期望 ${expectedName.split(/[\\/]/).pop()}）`
      entries.push(item)
      continue
    }

    const parsedDoc = (await readSessionScope(file.path, sessionId))
    if (parsedDoc.failure) {
      item.action = 'quarantine'
      item.reason = parsedDoc.failure
      entries.push(item)
      continue
    }

    const decision = decideSessionScopeFate({
      orphan: parsedDoc.orphan,
      presentOnDisk: scanComplete ? stored.has(sessionId) : false,
      scanComplete,
      now
    })
    item.action = decision.action
    item.reason = decision.reason
    if (decision.orphan && decision.action === 'keep') {
      const age = now - Date.parse(decision.orphan.firstSeenAt)
      item.graceDaysLeft = Math.max(0, Math.ceil((ORPHAN_GRACE_MS - age) / (24 * 3600 * 1000)))
    }

    // 标记 / 撤销标记都要落盘 —— 但**只在扫描完整时**。扫描不完整时状态机返回 keep，
    // 那时不该写任何东西（否则一次临时的服务故障会把所有条目刷上已扫描时间）。
    if (decision.action === 'mark' || decision.action === 'clear-mark') {
      try {
        const nextDoc = decision.action === 'clear-mark'
          ? { ...doc, orphan: undefined }
          : { ...doc, orphan: decision.orphan }
        if (decision.action === 'clear-mark') delete nextDoc.orphan
        await writeSessionScope(file.path, nextDoc)
      } catch (err) {
        item.markError = String((err && err.message) || err)
      }
    }

    entries.push(item)
  }

  return {
    scanComplete,
    persistenceProblem,
    total: entries.length,
    markable: entries.filter((e) => e.action === 'mark'),
    collectable: entries.filter((e) => e.action === 'collect'),
    quarantine: entries.filter((e) => e.action === 'quarantine'),
    entries
  }
}

// ==================== 斜杠命令 ====================

// 宿主端无 locale 服务（CommandInvocation 不携带 UI 语言，settings 中亦无语言字段），
// 命令输出语言跟随 soul 配置的 language 字段，可在设置页切换。
const COMMAND_MESSAGES = {
  zh: {
    showTitle: '🧠 个性化设置',
    colon: '：',
    statusLabel: '状态',
    nicknameLabel: '昵称',
    occupationLabel: '职业',
    bioLabel: '介绍',
    styleLabel: '风格语调',
    styleNames: {
      professional: '专业严谨',
      casual: '轻松自然',
      humorous: '幽默风趣',
      roast: '吐槽达人',
      efficient: '高效干练'
    },
    traitsLabel: '特质',
    headingListsLabel: '标题和列表',
    emojiLabel: '表情符号',
    tablesLabel: '表格',
    replyLengthLabel: '回复长度',
    traitNames: {
      default: '默认',
      more: '增强',
      less: '减弱'
    },
    replyLengthNames: {
      concise: '简洁',
      normal: '适中',
      detailed: '详尽'
    },
    listSep: '，',
    trailLabel: '输入框光轨',
    trailLine: (status, color, speedName, widthName) => `${status}（${color} / ${speedName} / ${widthName}）`,
    trailSpeedNames: {
      slow: '慢',
      normal: '中',
      fast: '快'
    },
    trailWidthNames: {
      thin: '细',
      normal: '中',
      thick: '粗'
    },
    instructionsLabel: '自定义指令',
    enabled: '已启用',
    disabled: '已禁用',
    notSet: '未设置',
    toolConfirmLabel: '确认模式',
    onLabel: '开启',
    offLabel: '关闭',
    personasLabel: '人设预设',
    // 提议是**内存态**（重启即失效）、也没有 TTL，所以必须让用户看到它是什么时候提出的，
    // 否则一条陈旧提议会一直挂着而无法判断新鲜度（proposedAt 此前只写不读）。
    pendingHint: (at) => `⚠ 有待确认的人设变更（提出于 ${at}）：/soul confirm 确认，/soul reject 拒绝`,
    noPending: '没有待确认的人设变更',
    confirmDone: (detail) => `✅ 已应用人设变更：${detail}`,
    rejectDone: '✅ 已拒绝待确认的人设变更',
    saveDone: (name) => `✅ 已保存预设「${name}」`,
    // 内置预设（随插件发布、不落盘）：不可用同名保存，也不可删除
    builtinName: '内置',
    builtinSaveBlocked: (name) => `「${name}」是内置预设，请换一个名称`,
    builtinDeleteBlocked: (name) => `「${name}」是内置预设，无法删除`,
    useDone: (name) => `✅ 已应用预设「${name}」`,
    useUnchanged: (name) => `ℹ 预设「${name}」与当前配置一致，无需变更`,
    // 预设里部分字段的取值非法（历史值或手改）：合法字段照常应用，被跳过的必须说出来
    usePartial: (name, fields) => `⚠ 预设「${name}」已部分应用，以下字段取值非法、已跳过：${fields}`,
    useAllInvalid: (name, fields) => `✗ 预设「${name}」没有可应用的合法字段：${fields}`,
    personaMissing: (name) => `预设「${name}」不存在`,
    delDone: (name) => `✅ 已删除预设「${name}」`,
    listTitle: '📋 人设预设',
    listEmpty: '暂无人设预设，使用 /soul save <名称> 保存当前配置',
    // 列表行报告预设实际覆盖的人格维度数量（取代 v0.7.1 起恒为空的「昵称」列）
    listCovers: (n) => `覆盖 ${n} 项`,
    saveUsage: '用法：/soul save <名称>（1-30 个字符）',
    useUsage: '用法：/soul use <名称>',
    delUsage: '用法：/soul del <名称>',
    setUsage: '用法：/soul set key=value ...（可用字段：enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth）',
    unknownField: '未知配置项',
    invalidBoolean: (key, value) => `${key} 取值必须为 true / false（收到：${JSON.stringify(value)}）`,
    setNoChanges: '配置无变化，未做修改',
    setDone: (keys) => `✅ 已更新：${keys.join('、')}`,
    help: '使用 /soul show 查看详情\n使用 /soul set style=humorous 修改配置项\n使用 /soul save <名称> 保存预设；/soul use <名称> 应用；/soul list 查看；/soul del <名称> 删除\n使用 /soul confirm 或 /soul reject 处理待确认的人设变更\n使用 /soul reset 重置配置\n使用 /soul enable 启用；/soul disable 禁用\n使用 /soul 昵称xxx 设置昵称',
    resetDone: '✅ 配置已重置为默认值',
    resetRecovered: (file) => `✅ 配置已重置为默认值（损坏的文件已备份为 ${file}）`,
    deliveryLabel: '送达：',
    deliveryOk: (delivered, total) => total === 0
      ? '暂无活动会话（配置将在新会话生效）'
      : `已注入 ${delivered}/${total} 个活动会话`,
    deliveryNoAgentsService: 'agents 服务不可用 —— 新配置只能经 system prompt section 送达，保存后可能要到新会话才生效',
    deliveryInjectFailed: (detail) => `向活动会话注入失败：${detail}`,
    enableDone: '✅ 个性化设置已启用',
    disableDone: '✅ 个性化设置已禁用',
    nicknameDone: (n) => `✅ 昵称已设置为：${n}`,
    failed: (e) => `操作失败：${e}`
  },
  en: {
    showTitle: '🧠 Personalization Settings',
    colon: ': ',
    statusLabel: 'Status',
    nicknameLabel: 'Nickname',
    occupationLabel: 'Occupation',
    bioLabel: 'Bio',
    styleLabel: 'Style & Tone',
    styleNames: {
      professional: 'Professional',
      casual: 'Casual',
      humorous: 'Humorous',
      roast: 'Roast Master',
      efficient: 'Efficient'
    },
    traitsLabel: 'Traits',
    headingListsLabel: 'Headings & lists',
    emojiLabel: 'Emoji',
    tablesLabel: 'Tables',
    replyLengthLabel: 'Reply length',
    traitNames: {
      default: 'Default',
      more: 'More',
      less: 'Less'
    },
    replyLengthNames: {
      concise: 'Concise',
      normal: 'Balanced',
      detailed: 'Detailed'
    },
    listSep: ', ',
    trailLabel: 'Composer light trail',
    trailLine: (status, color, speedName, widthName) => `${status} (${color} / ${speedName} / ${widthName})`,
    trailSpeedNames: {
      slow: 'Slow',
      normal: 'Normal',
      fast: 'Fast'
    },
    trailWidthNames: {
      thin: 'Thin',
      normal: 'Normal',
      thick: 'Thick'
    },
    instructionsLabel: 'Custom instructions',
    enabled: 'enabled',
    disabled: 'disabled',
    notSet: 'not set',
    toolConfirmLabel: 'Tool confirmation',
    onLabel: 'on',
    offLabel: 'off',
    personasLabel: 'Personas',
    // 提议是**内存态**（重启即失效）、也没有 TTL，所以必须让用户看到它是什么时候提出的，
    // 否则一条陈旧提议会一直挂着而无法判断新鲜度（proposedAt 此前只写不读）。
    pendingHint: (at) => `⚠ Pending persona proposal (raised at ${at}): /soul confirm to apply, /soul reject to discard`,
    noPending: 'No pending persona proposal',
    confirmDone: (detail) => `✅ Persona changes applied: ${detail}`,
    rejectDone: '✅ Pending persona proposal discarded',
    saveDone: (name) => `✅ Persona "${name}" saved`,
    builtinName: 'built-in',
    builtinSaveBlocked: (name) => `"${name}" is a built-in persona — pick another name`,
    builtinDeleteBlocked: (name) => `"${name}" is a built-in persona and cannot be deleted`,
    useDone: (name) => `✅ Persona "${name}" applied`,
    useUnchanged: (name) => `ℹ Persona "${name}" matches the current config`,
    // 预设里部分字段的取值非法（历史值或手改）：合法字段照常应用，被跳过的必须说出来
    usePartial: (name, fields) => `⚠ Persona "${name}" applied partially; skipped as invalid: ${fields}`,
    useAllInvalid: (name, fields) => `✗ Persona "${name}" has no applicable field: ${fields}`,
    personaMissing: (name) => `Persona "${name}" does not exist`,
    delDone: (name) => `✅ Persona "${name}" deleted`,
    listTitle: '📋 Personas',
    listEmpty: 'No personas yet — save the current config with /soul save <name>',
    // 列表行报告预设实际覆盖的人格维度数量（取代 v0.7.1 起恒为空的「昵称」列）
    listCovers: (n) => `covers ${n} field${n === 1 ? '' : 's'}`,
    saveUsage: 'Usage: /soul save <name> (1-30 chars)',
    useUsage: 'Usage: /soul use <name>',
    delUsage: 'Usage: /soul del <name>',
    setUsage: 'Usage: /soul set key=value ... (fields: enabled / style / headingLists / emoji / tables / replyLength / language / nickname / occupation / bio / customInstructions / trailEnabled / trailColor / trailSpeed / trailWidth)',
    unknownField: 'Unknown field',
    invalidBoolean: (key, value) => `${key} must be true or false (got: ${JSON.stringify(value)})`,
    setNoChanges: 'No config changes to apply',
    setDone: (keys) => `✅ Updated: ${keys.join(', ')}`,
    help: 'Use /soul show for details\nUse /soul set style=humorous to change fields\nUse /soul save <name> / use <name> / list / del <name> for personas\nUse /soul confirm or /soul reject for pending persona proposals\nUse /soul reset to reset\nUse /soul enable / disable to toggle\nUse /soul <nickname> to set your nickname',
    resetDone: '✅ Configuration reset to defaults',
    resetRecovered: (file) => `✅ Configuration reset to defaults (the damaged file was backed up as ${file})`,
    deliveryLabel: 'Delivery: ',
    deliveryOk: (delivered, total) => total === 0
      ? 'no active sessions (the config will apply in a new session)'
      : `injected into ${delivered}/${total} active sessions`,
    deliveryNoAgentsService: 'the `agents` service is unavailable — the new config can only travel via the system prompt section, so it may take a new session to apply',
    deliveryInjectFailed: (detail) => `injection into active sessions failed: ${detail}`,
    enableDone: '✅ Personalization enabled',
    disableDone: '✅ Personalization disabled',
    nicknameDone: (n) => `✅ Nickname set to: ${n}`,
    failed: (e) => `Operation failed: ${e}`
  }
}

function commandMessages(config) {
  return COMMAND_MESSAGES[config.language === 'en' ? 'en' : 'zh']
}

// /soul 子命令关键字（命中走子命令；否则整体视为昵称）
const COMMAND_KEYWORDS = new Set(['show', 'reset', 'enable', 'disable', 'save', 'use', 'list', 'del', 'delete', 'rm', 'set', 'confirm', 'reject'])

// /soul set 中按布尔解析的键；其余键以原始字符串交给 sanitizeConfig 校验
const COMMAND_BOOLEAN_KEYS = new Set(['enabled', 'trailEnabled'])

// 配置字段名 → 小写形式。子命令关键字本就忽略大小写（见 handler 里的 toLowerCase），
// 键名此前却严格区分：`/soul set STYLE=humorous` 会报「未知配置项」，与用户预期不一致。
// 这里按小写**映射回真实字段名**（不是把键 toLowerCase —— 那会把 headingLists 压成
// headinglists，反而匹配不上白名单）。非配置字段仍按未知处理。
const COMMAND_FIELD_BY_LOWER = new Map(Object.keys(DEFAULT_CONFIG).map((key) => [key.toLowerCase(), key]))

// 归一化 /soul set 的键名：命中真实字段则用其准确写法，否则原样交给白名单判未知
function normalizeSetKey(key) {
  return COMMAND_FIELD_BY_LOWER.get(key.toLowerCase()) || key
}

// 解析 /soul set 的键值参数：key=value 对；不含 = 的 token 追加到上一个值
// （支持含空格的文本值，如：/soul set bio=写代码 多年 经验）
function parseSetArgs(rest) {
  if (!rest) return []
  const pairs = []
  for (const token of rest.split(/\s+/)) {
    const eq = token.indexOf('=')
    if (eq > 0) pairs.push([token.slice(0, eq), token.slice(eq + 1)])
    else if (pairs.length > 0 && token) pairs[pairs.length - 1][1] += ` ${token}`
    else return null
  }
  return pairs
}

function registerCommands(ctx) {
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'soul',
      description: '查看或管理个性化设置。用法：/soul [show|set|save|use|list|del|confirm|reject|reset|enable|disable|昵称]',
      input: { hint: '[show|set k=v|save <名>|use <名>|list|del <名>|confirm|reject|reset|enable|disable|昵称]' },
      async handler(invocation) {
        // 保留原始大小写用于昵称/预设名，仅关键字匹配时忽略大小写
        const raw = String(invocation.rawInput || '').trim()
        const spaceAt = raw.search(/\s/)
        const first = (spaceAt === -1 ? raw : raw.slice(0, spaceAt)).toLowerCase()
        const rest = spaceAt === -1 ? '' : raw.slice(spaceAt + 1).trim()

        try {
          const config = await loadConfig()
          const t = commandMessages(config)

          // 非关键字输入：整体视为昵称（保留原始大小写）；空输入走 show
          if (first !== '' && !COMMAND_KEYWORDS.has(first)) {
            const { patch, errors } = sanitizeConfig({ nickname: raw })
            if (errors.nickname) {
              return { kind: 'error', text: t.failed(errors.nickname) }
            }
            const { config: updated, promptChanged } = await commitConfig(c => ({ ...c, nickname: patch.nickname }), { source: 'command', action: 'nickname' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.nicknameDone(patch.nickname) }
          }

          if (first === '' || first === 'show') {
            const status = config.enabled ? t.enabled : t.disabled
            const nickname = config.nickname || t.notSet
            const occupation = config.occupation || t.notSet
            const bio = config.bio || t.notSet
            const styleName = t.styleNames[config.style] || config.style || t.notSet
            const traitsLine = [
              `${t.headingListsLabel}=${t.traitNames[config.headingLists] || config.headingLists}`,
              `${t.emojiLabel}=${t.traitNames[config.emoji] || config.emoji}`,
              `${t.tablesLabel}=${t.traitNames[config.tables] || config.tables}`,
              `${t.replyLengthLabel}=${t.replyLengthNames[config.replyLength] || config.replyLength}`
            ].join(t.listSep)
            const instructions = config.customInstructions || t.notSet
            // 预设数量用**合并视图**（内置 + 用户），与 /soul list 和 Web UI 一致：
            // 此前只数 config.personas（磁盘上的用户预设），于是同一个「人设预设」
            // 在 show 里显示 2、在 list 里显示 9。
            const personaCount = Object.keys(mergePersonas(config.personas)).length
            const pendingLine = pendingPersonaProposal
              ? `\n${t.pendingHint(new Date(pendingPersonaProposal.proposedAt).toLocaleString())}`
              : ''
            const trailText = t.trailLine(
              config.trailEnabled ? t.enabled : t.disabled,
              config.trailColor,
              t.trailSpeedNames[config.trailSpeed] || config.trailSpeed,
              t.trailWidthNames[config.trailWidth] || config.trailWidth
            )
            // 送达状态：直接回答「我刚改了配置，为什么没生效」这个高频疑问 ——
            // 两条通道里注入是否真的送到了活动会话，此前完全没有可观测点。
            const delivery = deliveryProblemText(config) || t.deliveryOk(deliveryState.delivered, deliveryState.agents)

            return {
              kind: 'success',
              text: `${t.showTitle}\n\n${t.statusLabel}${t.colon}${status}\n${t.nicknameLabel}${t.colon}${nickname}\n${t.occupationLabel}${t.colon}${occupation}\n${t.bioLabel}${t.colon}${bio}\n${t.styleLabel}${t.colon}${styleName}\n${t.traitsLabel}${t.colon}${traitsLine}\n${t.trailLabel}${t.colon}${trailText}\n${t.instructionsLabel}${t.colon}${instructions}\n${t.toolConfirmLabel}${t.colon}${config.requireToolConfirmation ? t.onLabel : t.offLabel}\n${t.personasLabel}${t.colon}${personaCount}${pendingLine}\n${t.deliveryLabel}${t.colon}${delivery}\n\n${t.help}`
            }
          }

          if (first === 'reset') {
            // 重置活动配置，但保留人设预设库。
            // 经由逃生口：配置损坏时这是唯一还能落盘的操作（先备份损坏文件）。
            const { config: updated, promptChanged, backupPath } = await resetConfigWithEscape({ source: 'command', action: 'reset' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return backupPath
              ? { kind: 'success', text: t.resetRecovered(backupPath) }
              : { kind: 'success', text: t.resetDone }
          }

          if (first === 'enable') {
            // 写队列内「读—改—写」，不在队列外改写内存缓存对象；无变化时跳过注入
            const { config: updated, promptChanged } = await commitConfig(c => ({ ...c, enabled: true }), { source: 'command', action: 'enable' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.enableDone }
          }

          if (first === 'disable') {
            const { config: updated, promptChanged } = await commitConfig(c => ({ ...c, enabled: false }), { source: 'command', action: 'disable' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.disableDone }
          }

          if (first === 'save') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.saveUsage }
            if (isBuiltinPersona(personaName)) {
              return { kind: 'error', text: t.builtinSaveBlocked(personaName) }
            }
            await commitConfig((current) => {
              const personas = clonePersonas(current.personas)
              personas[personaName] = { ...personaSnapshotOf(current), updatedAt: new Date().toISOString() }
              return { ...current, personas }
            }, { source: 'command', action: 'savePreset' })
            return { kind: 'success', text: t.saveDone(personaName) }
          }

          if (first === 'use') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.useUsage }
            // 内置与用户预设共用同一条应用路径（resolvePersona 先内置后用户）
            const entry = resolvePersona(personaName, config.personas)
            if (!entry) {
              return { kind: 'error', text: t.personaMissing(personaName) }
            }
            // 预设值保存时已校验；此处再过一遍白名单，防御手改文件等异常数据。
            // 非法字段不再被静默丢弃：applied=0 ⇒ 报错；有部分非法 ⇒ 明示被跳过的字段。
            const { changed, invalid, applied } = await applyPersonaEntry(ctx, entry)
            const fieldsText = invalid.join(t.listSep)
            // 预设未声明任何字段（applied=0 且 invalid=0）不是错误，是「无可应用内容」
            if (invalid.length > 0 && applied === 0) {
              return { kind: 'error', text: t.useAllInvalid(personaName, fieldsText) }
            }
            if (invalid.length > 0) {
              return { kind: 'success', text: t.usePartial(personaName, fieldsText) }
            }
            if (changed.length === 0) {
              return { kind: 'success', text: t.useUnchanged(personaName) }
            }
            return { kind: 'success', text: t.useDone(personaName) }
          }

          if (first === 'list') {
            // 与 Web UI 一致：列出合并视图（内置 + 用户），并标出内置项
            const view = mergePersonas(config.personas)
            const names = Object.keys(view).sort()
            if (names.length === 0) {
              return { kind: 'success', text: `${t.listTitle}\n${t.listEmpty}` }
            }
            const activeName = findActivePersonaName(config)
            const lines = names.map((personaName) => {
              const entry = view[personaName]
              const styleText = STYLE_VALUES.includes(entry.style) ? (t.styleNames[entry.style] || entry.style) : (entry.style || '-')
              // 原先这里显示 `昵称=${entry.nickname || '-'}`，但 v0.7.1 起预设**不含**
              // 「关于你」（PERSONA_FIELDS 里没有 nickname，normalizePersonas 也会剥离）
              // ⇒ 该列恒为「昵称=-」，是一列永远没有信息的死数据。改为报告它实际
              // 覆盖了几个人格维度：这才是「应用这个预设会改变多少东西」的有效信息。
              const covers = declaredPersonaKeys(entry).length
              const mark = entry.builtin ? ` [${t.builtinName}]` : ''
              return `${personaName === activeName ? '✔ ' : '• '}${personaName}${mark} ｜ ${t.styleLabel}=${styleText} ｜ ${t.listCovers(covers)}`
            })
            return { kind: 'success', text: `${t.listTitle} [${names.length}]\n${lines.join('\n')}` }
          }

          if (first === 'del' || first === 'delete' || first === 'rm') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.delUsage }
            if (isBuiltinPersona(personaName)) {
              return { kind: 'error', text: t.builtinDeleteBlocked(personaName) }
            }
            if (!hasOwn(config.personas || {}, personaName)) {
              return { kind: 'error', text: t.personaMissing(personaName) }
            }
            await commitConfig((current) => {
              const personas = clonePersonas(current.personas)
              delete personas[personaName]
              return { ...current, personas }
            }, { source: 'command', action: 'deletePreset' })
            return { kind: 'success', text: t.delDone(personaName) }
          }

          if (first === 'set') {
            const pairs = parseSetArgs(rest)
            if (!pairs || pairs.length === 0) return { kind: 'error', text: t.setUsage }
            const rawPatch = {}
            for (const [rawKey, rawValue] of pairs) {
              // 键名忽略大小写（与子命令关键字一致）；值统一 trim（枚举此前不 trim）
              const key = normalizeSetKey(rawKey)
              const value = rawValue.trim()
              if (COMMAND_BOOLEAN_KEYS.has(key)) {
                const flag = value.toLowerCase()
                if (['true', '1', 'on', 'yes'].includes(flag)) rawPatch[key] = true
                else if (['false', '0', 'off', 'no'].includes(flag)) rawPatch[key] = false
                // 带上收到的实际值：`enabled=true extra` 会解析成值 "true extra"，
                // 只说「必须为 true / false」会让人以为是关键字写错了
                else return { kind: 'error', text: t.failed(t.invalidBoolean(key, value)) }
              } else {
                rawPatch[key] = value
              }
            }
            const { patch, errors } = sanitizeConfig(rawPatch)
            const errorKeys = Object.keys(errors)
            if (errorKeys.length > 0) {
              return { kind: 'error', text: t.failed(`${errorKeys[0]}: ${errors[errorKeys[0]]}`) }
            }
            // hasOwn 而非 `in`：后者会命中原型链（`constructor` 之类恒为 true），
            // 让真正未知的字段被误判成「已识别」而不进 droppedKeys。
            const droppedKeys = Object.keys(rawPatch).filter((key) => !hasOwn(patch, key))
            if (Object.keys(patch).length === 0) {
              return { kind: 'error', text: t.failed(droppedKeys.length > 0 ? `${t.unknownField}: ${droppedKeys.join(', ')}` : t.setUsage) }
            }
            const { config: updated, changed, promptChanged } = await commitConfig(c => ({ ...c, ...patch }), { source: 'command', action: 'set' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: changed.length > 0 ? t.setDone(changed) : t.setNoChanges }
          }

          if (first === 'confirm') {
            if (!pendingPersonaProposal) return { kind: 'error', text: t.noPending }
            const proposal = pendingPersonaProposal
            pendingPersonaProposal = null
            const { config: updated, changed, promptChanged } = await commitConfig(c => ({ ...c, ...proposal.patch }), { source: 'command', action: 'confirm' })
            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            const detail = Object.keys(proposal.patch).map((key) => `${key}=${JSON.stringify(proposal.patch[key])}`).join(', ')
            return { kind: 'success', text: t.confirmDone(detail) }
          }

          if (first === 'reject') {
            if (!pendingPersonaProposal) return { kind: 'error', text: t.noPending }
            pendingPersonaProposal = null
            return { kind: 'success', text: t.rejectDone }
          }

          // 理论不可达：关键字表与上方分支一一对应
          return { kind: 'error', text: t.help }
        } catch (err) {
          return { kind: 'error', text: commandMessages(await loadConfig()).failed(err.message) }
        }
      }
    })
  })
}

// ==================== 系统提示词注入 ====================

// 全局变量，用于在配置变化时更新提示词
let globalUpdatePrompt = null

function registerSystemPrompt(ctx) {
  ctx.inject(['systemPrompt'], (spCtx) => {
    let disposeSection = null

    const registerSection = () => {
      // 重新注册前先移除旧 section。
      //
      // 注意：这里**不是**靠 `system-prompt/change` 让宿主丢弃快照 —— 该事件当前全树
      // 没有任何消费者（只在 dsh-system-prompt 内部 emit）。真正让新配置生效的是
      // section 的 text provider 在每次装配时重新求值（宿主对函数式 text 不做缓存），
      // 以及活动会话注入这条第二条通道。两件事都有回归兜底：
      // scripts/verify-live-prompt.mjs / verify-e2e-prompt.mjs。
      //
      // 保留「先移除再注册」是因为宿主按名字插入、同名会抛重复错。
      disposeSection?.()

      disposeSection = spCtx.systemPrompt.section({
        name: 'soul:persona',
        order: 0,
        // 关闭宿主的提示词插值（默认开启）。插值是严格模式：文本里每一对完整的
        // {{...}} 都必须命中一个已注册变量，否则 renderPrompt 抛错；而本 section
        // 的装配里变量集为空 ⇒ 用户在「自定义指令」里写一句模板语法（例如 {{name}}）
        // 就会让整个 system prompt 装配失败。该抛错位于 agent.step() 开头且无
        // try/catch ⇒ 不是「忽略那段文字」，而是**该会话的每一轮都失败**。
        //
        // 代价为 0：我们不使用任何宿主提示词变量（需要上下文时，text 本身就是
        // provider）。关掉它同时让「预览所见」与「真实注入」逐字符一致。
        interpolate: false,
        text: (assembly) => {
          // ⚠️ 必须同步：宿主以 `section.text(context)` 的形式**同步**调用
          // （dsh-system-prompt 的装配：`typeof entry.text === 'function' ? entry.text(context) : entry.text`），
          // 返回 Promise 会被当成 section 文本对象塞进提示词。所以这里只做纯字符串
          // 比较——路径的身份解析（realpath）已在 loadBindings() 里对**键**做过一次。
          //
          // ⚠️ 也必须**只取一次快照**：configCache 由写队列整体替换。若这里分两次读
          // （例如先 configCache、再在 configForCwd 里又读一遍），装配期间发生写入就会
          // 让同一轮用上两个版本的配置。快照先取，之后全用它。
          //
          // `assembly.agent` 在诊断装配时缺席（宿主注释写明 `absent on diagnostics`），
          // cwdOfAgent 对 undefined 返回 null ⇒ configForCwd 原样返回全局配置。
          const snap = snapshotConfig()
          const agent = assembly && assembly.agent
          // 快照必须**整体**使用：连同索引一起，本轮只取一次。
          // sessionId 走索引拿 workspaceId；拿不到就让 configForScope 回退到 cwd。
          const sessionId = sessionIdOfAgent(agent)
          const workspaceId = sessionId === null ? null : (sessionWorkspaceIndex.get(sessionId) || null)
          // 会话层覆盖走**内存缓存**（同步），未命中时它会在后台排一次读盘，
          // 本轮按上层配置走 —— 下一轮生效。装配里绝不能 await。
          const sessionOverride = sessionOverridesOrNull(sessionId)
          const resolved = configForScope(snap.value, cwdOfAgent(agent), workspaceId, sessionOverride)
          const prompt = compilePrompt(resolved.config)
          // 记下「这一轮实际用的是哪一版」：排查「改了却没生效」时，第一个要回答的就是它。
          // 只写不读，不影响任何行为（deliveryState 由状态端点序列化给设置页）。
          deliveryState.lastAssembledRevision = snap.revision
          deliveryState.lastAssembledScope = resolved.source
          return prompt
        }
      })

      deliveryState.sectionRegisteredAt = new Date().toISOString()
    }

    registerSection()

    globalUpdatePrompt = async () => {
      await loadConfig()
      registerSection()
    }

    ctx.effect(() => () => {
      disposeSection?.()
      disposeSection = null
      deliveryState.sectionRegisteredAt = null
      if (globalUpdatePrompt) {
        globalUpdatePrompt = null
      }
    }, 'dsh-soul: system prompt section')
  })
}

// ==================== 人设变更的宿主审批 ====================
//
// 确认模式开启时，人设变更走**宿主的原生审批交互**（输入框处的
// 「允许一次 / 拒绝」面板），而不是让用户手敲 /soul confirm。
//
// 为什么复用宿主审批而不是自绘弹框：
//   · 面板、键盘（Enter 允许 / Esc 拒绝）、读屏、一次性授权语义都由宿主实现；
//   · ask / decided 会写入会话审计日志（谁在何时批准了什么人设变更）；
//   · 多个插件同时要审批时由 waterfall 自然排队，不会出现两个弹框抢焦点。
//
// 返回三态，调用方据此决定继续落盘 / 拒绝 / 退化：
//   'allowed'    —— 用户批准，调用方继续写盘
//   'rejected'   —— 用户拒绝，调用方返回失败
//   'unavailable'—— 拿不到审批能力（无 agent、宿主未装审批服务、无 Web UI 应答者），
//                    调用方退化到 /soul confirm 文本流程
//
// 刻意**不加超时**：用户不点就一直等，与宿主其它审批一致。
// 加超时会产生「只是没来得及点就被自动拒绝」这种难以解释的行为。
function approvalOutcomeOf(outcome) {
  if (outcome === 'allowed-once') return 'allowed'
  if (outcome === 'rejected') return 'rejected'
  // 'cancelled'（请求被撤回）与 'unavailable'（无应答者）都归为「审批不可用」，
  // 交由文本流程兜底 —— 用户仍有机会通过 /soul confirm 应用这次变更。
  return 'unavailable'
}

// 读取当前生效的审批策略。复刻宿主 ApprovalService.effectivePolicy 的算法
// （overrideOf(session) ?? config.policy ?? 'ask'）。
//
// 任一项不可读时保守回落到 'ask' —— 回落到 ask 意味着「仍去问用户」，
// 失败方向是「多问一次」而不是「静默改配置」。
function resolveApprovalPolicy(approval, agent) {
  try {
    const session = agent && agent.session
    if (typeof approval.overrideOf === 'function' && session) {
      const override = approval.overrideOf(session)
      if (override === 'never' || override === 'ask') return override
    }
    const configured = approval.config && approval.config.policy
    if (configured === 'never' || configured === 'ask') return configured
  } catch {
    // 读策略失败不应影响主流程 —— 继续按 ask 走（让宿主的真实判定说话）
  }
  return 'ask'
}

async function requestToolApproval(ctx, exec, changes) {
  try {
    // agent 是必须的：宿主客户端表单靠它解析会话归属，拿不到就会放弃应答
    //（dsh-client-ui-approval 里 scopeOf(owner) === undefined 时直接 next()）。
    const agent = exec && exec.agent
    if (!agent) return 'unavailable'
    // 服务解析：以**注册工具的 ctx**（toolsCtx）为主 —— 这与 dsh-tools 自己的
    // serviceAsk 写法一致（它在工具执行中用 this.ctx.get('approval')）。
    //
    // 实测教训：最初传的是 registerTools 的根 ctx，ctx.get('approval') 返回
    // undefined ⇒ 每次都退化成 /soul confirm 文本流程，看起来像「功能没生效」。
    // 另外 cordis 的 agent 作用域可能更精确（审批本就该路由到该 agent 的会话），
    // 故一并作为候选，任一命中即用。
    const candidates = []
    if (agent && typeof agent.ctx === 'object' && agent.ctx && typeof agent.ctx.get === 'function') candidates.push(agent.ctx)
    if (ctx && typeof ctx.get === 'function') candidates.push(ctx)
    let approval
    for (const c of candidates) {
      const found = c.get('approval')
      if (found && typeof found.request === 'function') { approval = found; break }
    }
    if (!approval || typeof approval.request !== 'function') return 'unavailable'

    // —— 策略预判：避免把「通道被禁用」误报成「用户拒绝」——
    //
    // 宿主在 effectivePolicy(session) === 'never' 时**不问任何人**，直接返回
    // 'rejected'（见 dsh-user-approval 的 decide()）。而 'rejected' 这个取值把
    // 两件完全不同的事混在一起：
    //   ① 用户真的点了「拒绝」
    //   ② 审批通道被策略禁用，无人被询问
    // 若不区分，就会向用户报告一件**从未发生的事**（实测踩过：策略为 never 时
    // 提示「你在审批面板中拒绝了」，而用户根本没看到面板）。
    //
    // 故在发起请求前复刻宿主的策略算法，判定为 'never' 时直接走文本确认
    // （与 'unavailable' 同一落点），并给出准确文案。
    //
    // 为什么不直接应用变更（把 never 当作「无需确认」）：requireToolConfirmation
    // 是用户为本功能单独设的偏好，而 never 是会话级的审批通道策略。用后者悄悄推翻
    // 前者，等于让一个通道开关替用户取消了他自己的功能选择。真要免确认，正确做法是
    // 关掉设置页里的「人设变更需确认」开关 —— 那才是为这件事准备的开关。
    if (resolveApprovalPolicy(approval, agent) === 'never') return 'policy-disabled'

    const detail = Object.entries(changes)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(', ')
    const outcome = await approval.request({
      agent,
      toolName: 'set_persona',
      ...(exec && exec.callId !== undefined ? { callId: exec.callId } : {}),
      ...(exec && exec.signal !== undefined ? { signal: exec.signal } : {}),
      reason: '人设变更需要你的确认',
      // 中英并列：宿主按当前 UI 语言选取，审计日志里仍保留 reason 原文
      displayReason: {
        en: 'Persona change requires your confirmation',
        zh: '人设变更需要你的确认',
        'zh-Hans': '人设变更需要你的确认'
      }
    })
    return approvalOutcomeOf(outcome)
  } catch {
    // 审批链路任何异常都不应让人设变更彻底失败 —— 退化为文本确认
    return 'unavailable'
  }
}

// ==================== Agent 可调用工具 ====================

// tools 是可选 host 服务且 ABI 版本敏感（同 dsh-share-page 的守卫）。
// 动态 import + 守卫：@deepseek-ai/dsh-tools 不可解析或旧 ABI（缺 TOOL_RUNTIME_SCHEDULER
// symbol）时跳过工具注册——插件照常激活，Web UI / 命令 / 路由不受影响。
function registerTools(ctx) {
  ctx.inject(['tools'], (toolsCtx) => {
    import('@deepseek-ai/dsh-tools').then(({ defineTool, TOOL_RUNTIME_SCHEDULER }) => {
      if (typeof TOOL_RUNTIME_SCHEDULER !== 'symbol') {
        throw new Error('dsh-soul: resolved @deepseek-ai/dsh-tools lacks TOOL_RUNTIME_SCHEDULER — requires ^0.1.0-rc.6')
      }
      toolsCtx.tools.register(defineTool({
        name: 'set_persona',
        // 描述是**模型侧**文本，中英并列：工具 schema 只在 apply 时注册一次，而
        // `tools.register` 对同名重注册会抛 "already registered"，语言切换时无法
        // 原地换描述（registry 只在注销旧句柄后才接受同名）。并列两种语言既覆盖
        // zh / en 两种界面，又不必引入重注册的时序风险。
        description:
          '调整当前个性化设置（昵称、回复风格和语调、自定义指令）。' +
          '当用户明确要求改变称呼、语气、风格或角色时使用。' +
          '只需要传入要修改的字段，未提供的字段保持不变。\n' +
          'Adjust the current personalization settings (nickname, reply style & tone, custom instructions). ' +
          'Use it when the user explicitly asks to change how they are addressed, the tone, the style, or the role. ' +
          'Pass only the fields to change; omitted fields keep their current values.',
        parameters: {
          nickname: { type: 'string', description: '用户昵称，回复时会使用这个称呼。/ The nickname to address the user by.' },
          occupation: { type: 'string', description: '用户的职业。/ The user’s occupation.' },
          bio: { type: 'string', description: '关于用户的介绍。/ Background about the user.' },
          style: {
            type: 'string',
            enum: STYLE_VALUES,
            description: '回复风格和语调：professional=专业严谨，casual=轻松自然，humorous=幽默风趣，roast=吐槽达人，efficient=高效干练。/ Reply style & tone.'
          },
          language: {
            type: 'string',
            enum: LANGUAGE_VALUES,
            description: '回复语言：zh=简体中文，en=English。/ Reply language.'
          },
          headingLists: {
            type: 'string',
            enum: TRAIT_VALUES,
            description: '特质·标题和列表：default=默认，more=增强（采用清晰格式和列表结构），less=减弱（使用更多段落文本）。/ Headings & lists.'
          },
          emoji: {
            type: 'string',
            enum: TRAIT_VALUES,
            description: '特质·表情符号：default=默认，more=增强（使用较多表情符号），less=减弱（尽量减少使用表情符号）。/ Emoji usage.'
          },
          tables: {
            type: 'string',
            enum: TRAIT_VALUES,
            description: '特质·表格：default=默认，more=增强（呈现对比、多字段或结构化信息时优先使用表格），less=减弱（避免表格，改用列表或段落文本）。/ Table usage.'
          },
          replyLength: {
            type: 'string',
            enum: REPLY_LENGTH_VALUES,
            description: '回复长度偏好：concise=简洁（直击要点、不展开），normal=适中（不额外约束），detailed=详尽（充分展开背景、步骤与推理）。/ Reply length preference.'
          },
          customInstructions: { type: 'string', description: '额外的自定义指令，用于覆盖或补充当前人设。/ Extra custom instructions that override or extend the current persona.' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            // 注意：DSH 的 schema DSL **不支持根级 required**（作者错误：
            // "schema.required is not supported by the value schema DSL"）。
            // 必填只能标在属性上（property.required must be true when present）。
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string' },
              pending: {
                type: 'boolean',
                description: '提议待确认（requireToolConfirmation 开启时返回，变更尚未生效）'
              },
              changes: {
                type: 'object',
                description: '实际发生变化的字段',
                // object 节点必须显式声明 additionalProperties
                // （作者错误："...additionalProperties must be explicitly true or false"）
                additionalProperties: false,
                properties: {
                  nickname: { type: 'string' },
                  occupation: { type: 'string' },
                  bio: { type: 'string' },
                  style: { type: 'string' },
                  language: { type: 'string' },
                  headingLists: { type: 'string' },
                  emoji: { type: 'string' },
                  tables: { type: 'string' },
                  replyLength: { type: 'string' },
                  customInstructions: { type: 'string' },
                },
              },
            },
          },
          // 结果渲染：宿主每次工具**成功执行**后都会无条件调用它
          // （dsh-tools 的 createSuccessResult → tool.output.render(...)）。
          // 不提供会怎样：defineTool 无条件下包一份 `render(args, value) { return userRender(...) }`，
          // 而 userRender 是 undefined ⇒ 注册能过（底层 register 校验的是包装后的函数），
          // 但**每次成功调用都在渲染阶段抛 TypeError: userRender is not a function**，
          // 宿主把它包成 projectionError("render")，用户视角是「Agent 说改了却报错」。
          // 自带插件 19 个都提供它。契约：返回 [{ type: 'text', text }]（无损 JSON）。
          render: (_args, value) => {
            // 直接把 message 作为给模型读的文本：它已经是完整的一句话（含 pending 提议与
            // 失败原因），再套一层 JSON.stringify 只会让模型多解析一层转义。
            const text = typeof value?.message === 'string' && value.message.length > 0
              ? value.message
              : (value?.ok === true ? 'ok' : 'failed')
            return [{ type: 'text', text }]
          },
        },
        async execute(args, exec) {
          try {
            // 与 HTTP 保存共用同一套校验（白名单 / 类型 / 长度 / 枚举）
            const { patch, errors } = sanitizeConfig(args)
            if (Object.keys(errors).length > 0) {
              const T0 = promptTextOf(await loadConfig())
              return { ok: false, message: T0.toolValidationFailed + formatFieldErrors(errors) }
            }
            if (Object.keys(patch).length === 0) {
              const T0 = promptTextOf(await loadConfig())
              return { ok: true, message: T0.toolNoChanges }
            }

            // 确认模式：先走**宿主的原生审批交互**（输入框处的「允许一次 / 拒绝」面板）。
            //
            // 三态处理：
            //   allowed     → 用户已批准，继续往下走写盘（故这里不 return）
            //   rejected    → 用户拒绝，返回失败且不落盘
            // 三态 + 一个策略态：
            //   allowed         → 用户已批准，继续往下走写盘（故这里不 return）
            //   rejected        → 用户明确拒绝，返回失败且不落盘
            //   unavailable     → 拿不到审批能力（无 agent / 宿主未装审批服务 /
            //                     客户端没有应答者），退化到 /soul confirm 文本流程
            //   policy-disabled → 审批通道被会话策略禁用（never）⇒ 同样走文本流程，
            //                     但文案必须说明「通道被禁用」，不能谎称用户拒绝
            //
            // 退化路径必须保留：纯 TUI 或无 Web UI 的场景没有应答者，审批会返回
            // 'unavailable'，此时文本流程是唯一可用的确认途径。删掉它会让这些场景
            // 彻底无法确认人设变更。
            const snapshot = await loadConfig()
            if (snapshot.requireToolConfirmation) {
              const T0 = promptTextOf(snapshot)
              const pendingKeys = Object.keys(patch).filter((key) => snapshot[key] !== patch[key])
              if (pendingKeys.length === 0) {
                return { ok: true, message: T0.toolNoChanges }
              }
              const proposalChanges = Object.fromEntries(pendingKeys.map((key) => [key, patch[key]]))
              const verdict = await requestToolApproval(toolsCtx, exec, proposalChanges)
              if (verdict === 'rejected') {
                return { ok: false, message: T0.toolRejected }
              }
              if (verdict === 'unavailable' || verdict === 'policy-disabled') {
                pendingPersonaProposal = { patch: proposalChanges, proposedAt: new Date().toISOString() }
                const detail = pendingKeys.map((key) => `${key}=${JSON.stringify(patch[key])}`).join(', ')
                // 通道被禁用时补一句准确说明：否则用户会以为是面板出了问题，
                // 或误以为是自己拒绝了（此前的错误措辞正是这么来的）。
                const why = verdict === 'policy-disabled' ? `${T0.toolApprovalDisabled}\n` : ''
                return {
                  ok: true,
                  pending: true,
                  changes: proposalChanges,
                  message: `${T0.toolProposal}\n${detail}\n${why}${T0.toolProposalHint}`
                }
              }
              // verdict === 'allowed' ⇒ 落到下面的写盘路径
            }

            // 写队列内合并，避免与其他写入方（Web UI、/soul 命令）竞态；
            // changed 由队列任务统一 diff 得出
            const { config: updated, changed, promptChanged } = await commitConfig((current) => {
              const next = { ...current }
              for (const key of Object.keys(patch)) {
                next[key] = patch[key]
              }
              return next
            }, { source: 'tool', action: 'setPersona' })

            if (changed.length === 0) {
              return { ok: true, message: promptTextOf(updated).toolNoChanges }
            }

            if (promptChanged.length > 0) refreshPromptAndInject(ctx, updated)
            return {
              ok: true,
              message: promptTextOf(updated).toolUpdated,
              changes: Object.fromEntries(changed.map(key => [key, updated[key]]))
            }
          } catch (err) {
            return { ok: false, message: String(err.message || err) }
          }
        },
      }))
    }).catch((err) => {
      toolsCtx.logger?.warn?.('[dsh-soul] set_persona tool not registered: ' + String((err && err.message) || err))
    })
  })
}

// ==================== 主入口 ====================

export async function apply(ctx) {
  // 加载配置
  await loadConfig()

  // 加载工作区绑定表。
  //
  // 必须在装配路径之外做完：system prompt section 的 text provider 是**同步**的
  // （见 registerSystemPrompt 里的说明），不能在里面 await 读盘。这里读一次，
  // 之后每轮装配只做纯字符串比较。失败不阻塞启动（绑定是可选增强）。
  await ensureBindings()
  
  // 提供 soulConfig 服务
  ctx.provide('soulConfig', {
    async getConfig() {
      return await loadConfig()
    },
    async updateConfig(newConfig) {
      // 与 HTTP 保存共用同一套校验；失败时抛错给服务调用方；返回更新后的配置
      const { patch, errors } = sanitizeConfig(newConfig)
      if (Object.keys(errors).length > 0) {
        throw new Error('配置校验失败：' + formatFieldErrors(errors))
      }
      const { config, promptChanged } = await commitConfig(current => ({ ...current, ...patch }), { source: 'service', action: 'update' })
      // 送达与另外三条写路径保持一致：服务调用方（其它插件）改配置后同样应当
      // 立即反映到活动会话，否则「改了配置不生效」会从服务这条路再次出现。
      if (promptChanged.length > 0) refreshPromptAndInject(ctx, config)
      return config
    },
    async getSystemPrompt() {
      const config = await loadConfig()
      return compilePrompt(config)
    },
    async resetConfig() {
      // 与 HTTP / 斜杠命令两条重置入口共用逃生口
      const { config, promptChanged } = await resetConfigWithEscape({ source: 'service', action: 'reset' })
      if (promptChanged.length > 0) refreshPromptAndInject(ctx, config)
      return config
    }
  })
  
  // 注册各模块
  registerRoutes(ctx)
  registerPersonaRoutes(ctx)
  registerHistoryRoutes(ctx)
  registerBindingRoutes(ctx)
  registerWorkspaceRoutes(ctx)
  registerSessionScopeRoutes(ctx)
  registerCommands(ctx)
  registerSystemPrompt(ctx)
  registerTools(ctx)
  registerWorkspaceIndex(ctx)
}

export { name }
