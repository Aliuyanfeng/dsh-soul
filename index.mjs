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
//   - 配置写入统一走写队列，返回 changed 供调用方跳过无变化刷新

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONFIG,
  STYLE_VALUES,
  TRAIT_VALUES,
  LANGUAGE_VALUES,
  PERSONA_FIELDS,
  PERSONA_NAME_MAX,
  migrateConfig,
  sanitizeConfig,
  sanitizePersonaName
} from './lib/config.mjs'

const name = 'soul'

// 配置文件路径：$DSH_HOME/soul-config.json
function configPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'soul-config.json')
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

// 行为块：回复风格和语调 + 特质 + 输出语言
function buildBehavior(config, T) {
  const parts = []
  if (config.style && T.styles[config.style]) parts.push(`${T.styleLabel}${T.styles[config.style]}`)
  if (config.headingLists && T.headingLists[config.headingLists]) parts.push(T.headingLists[config.headingLists])
  if (config.emoji && T.emoji[config.emoji]) parts.push(T.emoji[config.emoji])
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

// 读取配置
async function loadConfig() {
  if (configCache) return configCache
  
  try {
    const data = await readFile(configPath(), 'utf8')
    configCache = migrateConfig(JSON.parse(data))
  } catch {
    configCache = { ...DEFAULT_CONFIG }
  }
  return configCache
}

// 保存配置
async function saveConfig(config) {
  const dir = join(configPath(), '..')
  await mkdir(dir, { recursive: true })
  // 过滤已废弃字段（旧客户端可能仍携带 tone / presets / examples）
  const clean = { ...config }
  delete clean.tone
  delete clean.presets
  delete clean.examples
  await writeFile(configPath(), JSON.stringify(clean, null, 2), 'utf8')
  configCache = clean
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

// 在写队列中执行一次配置更新：mutate 收到当前配置的浅拷贝，返回新配置对象。
// 注意 mutate 必须在队列任务内完成全部读取与合并，不要在队列外提前读取配置。
// 返回 { config, changed }：changed 为实际发生变化的字段名数组，
// 调用方在其为空时应跳过提示词刷新与会话注入（配置没有变化）。
async function commitConfig(mutate) {
  return enqueueConfigWrite(async () => {
    const current = await loadConfig()
    const next = mutate({ ...current })
    const changed = diffKeys(current, next)
    const config = await saveConfig(next)
    return { config, changed }
  })
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

// ==================== Agent 上下文注入 ====================

// 将最新配置作为 model-facing context 注入所有活动会话。
// inject() 不会唤醒 Agent，也不改写普通用户消息；会在下一次 step 被模型读取。
function injectPromptToAllAgents(ctx, config) {
  const agents = ctx.get('agents')
  if (!agents || typeof agents.list !== 'function') {
    // console.warn('[dsh-soul] agents 服务不可用，跳过最新配置注入')
    return
  }

  const T = promptTextOf(config)
  const prompt = compilePrompt(config)
  const snapshotText = prompt || T.injectDisabled

  for (const agent of agents.list()) {
    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: prompt ? `${T.injectUpdatedHeader}\n${T.injectUpdatedBody}\n\n${prompt}` : snapshotText
        }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-soul',
          form: 'snapshot',
          sections: [{
            name: 'soul:persona',
            text: snapshotText
          }]
        }
      }))
      // console.log(`[dsh-soul] 已向 Agent ${agent.id} 注入最新配置`)
    } catch (err) {
      // console.error(`[dsh-soul] 向 Agent ${agent.id} 注入配置失败:`, err)
    }
  }
}

function refreshPromptAndInject(ctx, config) {
  if (globalUpdatePrompt) {
    globalUpdatePrompt().catch(err => {
      // console.error('[dsh-soul] 更新系统提示词失败:', err)
    })
  }
  injectPromptToAllAgents(ctx, config)
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
            send(200, { ok: true, config })
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
            const { config: updated, changed } = await commitConfig(current => ({ ...current, ...patch }))

            // 配置有实际变化才更新系统提示词并注入会话，避免无变化保存堆积注入消息
            if (changed.length > 0) {
              refreshPromptAndInject(ctx, updated)
            }

            send(200, { ok: true, config: updated, changed })
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
          const config = await loadConfig()
          const prompt = compilePrompt(config)
          send(200, { ok: true, prompt, enabled: config.enabled })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })
    
    // 预览系统提示词端点已在 v0.2.0 移除（提示词预览功能下线）

    // 重置配置
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/config/reset',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        try {
          const { config, changed } = await commitConfig(current => defaultConfigPreservingPersonas(current))

          // 配置有实际变化才更新系统提示词并注入会话
          if (changed.length > 0) {
            refreshPromptAndInject(ctx, config)
          }

          send(200, { ok: true, config, changed })
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

// 从配置中提取人设字段快照（作为预设保存的内容）
function personaSnapshotOf(config) {
  const values = {}
  for (const key of PERSONA_FIELDS) values[key] = config[key]
  return values
}

// 从预设条目中挑出人设字段（忽略 updatedAt 等元数据）
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

// 计算与当前活动配置完全一致的预设名（多个命中时取名称排序最前）
function findActivePersonaName(config) {
  const personas = config.personas || {}
  for (const personaName of Object.keys(personas).sort()) {
    const entry = personas[personaName]
    if (PERSONA_FIELDS.every((key) => entry[key] === config[key])) return personaName
  }
  return null
}

// 人设预设 HTTP 路由：列表 / 保存 / 使用 / 删除。
// 保存与删除仅变更 personas 库（diffKeys 跳过该字段），不会触发会话注入；
// 使用会变更活动配置字段，走常规 changed 门控注入。
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
          send(res, 200, { ok: true, personas: config.personas || {}, activeName: findActivePersonaName(config) })
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
          const { config: updated } = await commitConfig((current) => {
            const personas = clonePersonas(current.personas)
            personas[personaName] = { ...personaSnapshotOf(current), updatedAt: new Date().toISOString() }
            return { ...current, personas }
          })
          send(res, 200, { ok: true, personas: updated.personas || {}, activeName: findActivePersonaName(updated) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 使用预设：将预设字段应用到活动配置（走 changed 门控注入）
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
          if (!personaName || !hasOwn(current.personas || {}, personaName)) {
            send(res, 400, { ok: false, error: `预设不存在：${personaName || '(空)'}` })
            return
          }
          // 预设值保存时已校验；此处再过一遍白名单，防御手改文件等异常数据
          const { patch } = sanitizeConfig(pickPersonaValues(current.personas[personaName]))
          const { config: updated, changed } = await commitConfig(c => ({ ...c, ...patch }))
          if (changed.length > 0) {
            refreshPromptAndInject(ctx, updated)
          }
          send(res, 200, { ok: true, config: updated, changed, unchanged: changed.length === 0 })
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
          const current = await loadConfig()
          if (!personaName || !hasOwn(current.personas || {}, personaName)) {
            send(res, 400, { ok: false, error: `预设不存在：${personaName || '(空)'}` })
            return
          }
          const { config: updated } = await commitConfig((c) => {
            const personas = clonePersonas(c.personas)
            delete personas[personaName]
            return { ...c, personas }
          })
          send(res, 200, { ok: true, personas: updated.personas || {}, activeName: findActivePersonaName(updated) })
        } catch (err) {
          send(res, 500, { ok: false, error: String(err.message || err) })
        }
      }
    })
  })
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
    traitNames: {
      default: '默认',
      more: '增强',
      less: '减弱'
    },
    instructionsLabel: '自定义指令',
    enabled: '已启用',
    disabled: '已禁用',
    notSet: '未设置',
    toolConfirmLabel: '确认模式',
    onLabel: '开启',
    offLabel: '关闭',
    personasLabel: '人设预设',
    pendingHint: '⚠ 有待确认的人设变更：/soul confirm 确认，/soul reject 拒绝',
    noPending: '没有待确认的人设变更',
    confirmDone: (detail) => `✅ 已应用人设变更：${detail}`,
    rejectDone: '✅ 已拒绝待确认的人设变更',
    saveDone: (name) => `✅ 已保存预设「${name}」`,
    useDone: (name) => `✅ 已应用预设「${name}」`,
    useUnchanged: (name) => `ℹ 预设「${name}」与当前配置一致，无需变更`,
    personaMissing: (name) => `预设「${name}」不存在`,
    delDone: (name) => `✅ 已删除预设「${name}」`,
    listTitle: '📋 人设预设',
    listEmpty: '暂无人设预设，使用 /soul save <名称> 保存当前配置',
    saveUsage: '用法：/soul save <名称>（1-30 个字符）',
    useUsage: '用法：/soul use <名称>',
    delUsage: '用法：/soul del <名称>',
    setUsage: '用法：/soul set key=value ...（可用字段：enabled / style / headingLists / emoji / language / nickname / occupation / bio / customInstructions）',
    unknownField: '未知配置项',
    invalidEnabled: 'enabled 取值必须为 true / false',
    setNoChanges: '配置无变化，未做修改',
    setDone: (keys) => `✅ 已更新：${keys.join('、')}`,
    help: '使用 /soul show 查看详情\n使用 /soul set style=humorous 修改配置项\n使用 /soul save <名称> 保存预设；/soul use <名称> 应用；/soul list 查看；/soul del <名称> 删除\n使用 /soul confirm 或 /soul reject 处理待确认的人设变更\n使用 /soul reset 重置配置\n使用 /soul enable 启用；/soul disable 禁用\n使用 /soul 昵称xxx 设置昵称',
    resetDone: '✅ 配置已重置为默认值',
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
    traitNames: {
      default: 'Default',
      more: 'More',
      less: 'Less'
    },
    instructionsLabel: 'Custom instructions',
    enabled: 'enabled',
    disabled: 'disabled',
    notSet: 'not set',
    toolConfirmLabel: 'Tool confirmation',
    onLabel: 'on',
    offLabel: 'off',
    personasLabel: 'Personas',
    pendingHint: '⚠ Pending persona proposal: /soul confirm to apply, /soul reject to discard',
    noPending: 'No pending persona proposal',
    confirmDone: (detail) => `✅ Persona changes applied: ${detail}`,
    rejectDone: '✅ Pending persona proposal discarded',
    saveDone: (name) => `✅ Persona "${name}" saved`,
    useDone: (name) => `✅ Persona "${name}" applied`,
    useUnchanged: (name) => `ℹ Persona "${name}" matches the current config`,
    personaMissing: (name) => `Persona "${name}" does not exist`,
    delDone: (name) => `✅ Persona "${name}" deleted`,
    listTitle: '📋 Personas',
    listEmpty: 'No personas yet — save the current config with /soul save <name>',
    saveUsage: 'Usage: /soul save <name> (1-30 chars)',
    useUsage: 'Usage: /soul use <name>',
    delUsage: 'Usage: /soul del <name>',
    setUsage: 'Usage: /soul set key=value ... (fields: enabled / style / headingLists / emoji / language / nickname / occupation / bio / customInstructions)',
    unknownField: 'Unknown field',
    invalidEnabled: 'enabled must be true or false',
    setNoChanges: 'No config changes to apply',
    setDone: (keys) => `✅ Updated: ${keys.join(', ')}`,
    help: 'Use /soul show for details\nUse /soul set style=humorous to change fields\nUse /soul save <name> / use <name> / list / del <name> for personas\nUse /soul confirm or /soul reject for pending persona proposals\nUse /soul reset to reset\nUse /soul enable / disable to toggle\nUse /soul <nickname> to set your nickname',
    resetDone: '✅ Configuration reset to defaults',
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
            const { config: updated, changed } = await commitConfig(c => ({ ...c, nickname: patch.nickname }))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.nicknameDone(patch.nickname) }
          }

          if (first === '' || first === 'show') {
            const status = config.enabled ? t.enabled : t.disabled
            const nickname = config.nickname || t.notSet
            const occupation = config.occupation || t.notSet
            const bio = config.bio || t.notSet
            const styleName = t.styleNames[config.style] || config.style || t.notSet
            const hlName = t.traitNames[config.headingLists] || config.headingLists
            const emojiName = t.traitNames[config.emoji] || config.emoji
            const instructions = config.customInstructions || t.notSet
            const personaCount = Object.keys(config.personas || {}).length
            const pendingLine = pendingPersonaProposal ? `\n${t.pendingHint}` : ''

            return {
              kind: 'success',
              text: `${t.showTitle}\n\n${t.statusLabel}${t.colon}${status}\n${t.nicknameLabel}${t.colon}${nickname}\n${t.occupationLabel}${t.colon}${occupation}\n${t.bioLabel}${t.colon}${bio}\n${t.styleLabel}${t.colon}${styleName}\n${t.traitsLabel}${t.colon}${t.headingListsLabel}=${hlName}，${t.emojiLabel}=${emojiName}\n${t.instructionsLabel}${t.colon}${instructions}\n${t.toolConfirmLabel}${t.colon}${config.requireToolConfirmation ? t.onLabel : t.offLabel}\n${t.personasLabel}${t.colon}${personaCount}${pendingLine}\n\n${t.help}`
            }
          }

          if (first === 'reset') {
            // 重置活动配置，但保留人设预设库
            const { config: updated, changed } = await commitConfig(current => defaultConfigPreservingPersonas(current))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.resetDone }
          }

          if (first === 'enable') {
            // 写队列内「读—改—写」，不在队列外改写内存缓存对象；无变化时跳过注入
            const { config: updated, changed } = await commitConfig(c => ({ ...c, enabled: true }))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.enableDone }
          }

          if (first === 'disable') {
            const { config: updated, changed } = await commitConfig(c => ({ ...c, enabled: false }))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.disableDone }
          }

          if (first === 'save') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.saveUsage }
            await commitConfig((current) => {
              const personas = clonePersonas(current.personas)
              personas[personaName] = { ...personaSnapshotOf(current), updatedAt: new Date().toISOString() }
              return { ...current, personas }
            })
            return { kind: 'success', text: t.saveDone(personaName) }
          }

          if (first === 'use') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.useUsage }
            if (!hasOwn(config.personas || {}, personaName)) {
              return { kind: 'error', text: t.personaMissing(personaName) }
            }
            // 预设值保存时已校验；此处再过一遍白名单，防御手改文件等异常数据
            const { patch } = sanitizeConfig(pickPersonaValues(config.personas[personaName]))
            const { config: updated, changed } = await commitConfig(c => ({ ...c, ...patch }))
            if (changed.length === 0) {
              return { kind: 'success', text: t.useUnchanged(personaName) }
            }
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.useDone(personaName) }
          }

          if (first === 'list') {
            const personas = config.personas || {}
            const names = Object.keys(personas).sort()
            if (names.length === 0) {
              return { kind: 'success', text: `${t.listTitle}\n${t.listEmpty}` }
            }
            const activeName = findActivePersonaName(config)
            const lines = names.map((personaName) => {
              const entry = personas[personaName]
              const styleText = STYLE_VALUES.includes(entry.style) ? (t.styleNames[entry.style] || entry.style) : (entry.style || '-')
              const nickText = entry.nickname || '-'
              return `${personaName === activeName ? '✔ ' : '• '}${personaName} ｜ ${t.styleLabel}=${styleText} ｜ ${t.nicknameLabel}=${nickText}`
            })
            return { kind: 'success', text: `${t.listTitle} [${names.length}]\n${lines.join('\n')}` }
          }

          if (first === 'del' || first === 'delete' || first === 'rm') {
            const personaName = sanitizePersonaName(rest)
            if (!personaName) return { kind: 'error', text: t.delUsage }
            if (!hasOwn(config.personas || {}, personaName)) {
              return { kind: 'error', text: t.personaMissing(personaName) }
            }
            await commitConfig((current) => {
              const personas = clonePersonas(current.personas)
              delete personas[personaName]
              return { ...current, personas }
            })
            return { kind: 'success', text: t.delDone(personaName) }
          }

          if (first === 'set') {
            const pairs = parseSetArgs(rest)
            if (!pairs || pairs.length === 0) return { kind: 'error', text: t.setUsage }
            const rawPatch = {}
            for (const [key, value] of pairs) {
              if (key === 'enabled') {
                const flag = value.toLowerCase()
                if (['true', '1', 'on', 'yes'].includes(flag)) rawPatch.enabled = true
                else if (['false', '0', 'off', 'no'].includes(flag)) rawPatch.enabled = false
                else return { kind: 'error', text: t.failed(t.invalidEnabled) }
              } else {
                rawPatch[key] = value
              }
            }
            const { patch, errors } = sanitizeConfig(rawPatch)
            const errorKeys = Object.keys(errors)
            if (errorKeys.length > 0) {
              return { kind: 'error', text: t.failed(`${errorKeys[0]}: ${errors[errorKeys[0]]}`) }
            }
            const droppedKeys = Object.keys(rawPatch).filter((key) => !(key in patch))
            if (Object.keys(patch).length === 0) {
              return { kind: 'error', text: t.failed(droppedKeys.length > 0 ? `${t.unknownField}: ${droppedKeys.join(', ')}` : t.setUsage) }
            }
            const { config: updated, changed } = await commitConfig(c => ({ ...c, ...patch }))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: changed.length > 0 ? t.setDone(changed) : t.setNoChanges }
          }

          if (first === 'confirm') {
            if (!pendingPersonaProposal) return { kind: 'error', text: t.noPending }
            const proposal = pendingPersonaProposal
            pendingPersonaProposal = null
            const { config: updated, changed } = await commitConfig(c => ({ ...c, ...proposal.patch }))
            if (changed.length > 0) refreshPromptAndInject(ctx, updated)
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
      // 重新注册前先移除旧 section，触发 system-prompt/change，
      // 让 DSH 丢弃当前会话已经缓存的 system prompt 快照。
      disposeSection?.()

      disposeSection = spCtx.systemPrompt.section({
        name: 'soul:persona',
        order: 0,
        text: () => {
          const prompt = compilePrompt(configCache || DEFAULT_CONFIG)
          if (prompt) {
            // console.log(`[dsh-soul] 系统提示词已组装：${prompt.substring(0, 100)}...`)
          }
          return prompt
        }
      })
    }

    registerSection()

    globalUpdatePrompt = async () => {
      await loadConfig()
      registerSection()
      // console.log('[dsh-soul] 系统提示词已更新，当前会话下一次请求将使用最新配置')
    }

    ctx.effect(() => () => {
      disposeSection?.()
      disposeSection = null
      if (globalUpdatePrompt) {
        globalUpdatePrompt = null
      }
    }, 'dsh-soul: system prompt section')
  })
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
        description:
          '调整当前个性化人设（昵称、回复风格和语调、自定义指令）。' +
          '当用户明确要求改变称呼、语气、风格或角色时使用。' +
          '只需要传入要修改的字段，未提供的字段保持不变。',
        parameters: {
          nickname: { type: 'string', description: '用户昵称，回复时会使用这个称呼。' },
          occupation: { type: 'string', description: '用户的职业。' },
          bio: { type: 'string', description: '关于用户的介绍。' },
          style: {
            type: 'string',
            enum: STYLE_VALUES,
            description: '回复风格和语调：professional=专业严谨，casual=轻松自然，humorous=幽默风趣，roast=吐槽达人，efficient=高效干练。'
          },
          language: {
            type: 'string',
            enum: LANGUAGE_VALUES,
            description: '回复语言：zh=简体中文，en=English。'
          },
          headingLists: {
            type: 'string',
            enum: TRAIT_VALUES,
            description: '特质·标题和列表：default=默认，more=增强（采用清晰格式和列表结构），less=减弱（使用更多段落文本）。'
          },
          emoji: {
            type: 'string',
            enum: TRAIT_VALUES,
            description: '特质·表情符号：default=默认，more=增强（使用较多表情符号），less=减弱（尽量减少使用表情符号）。'
          },
          customInstructions: { type: 'string', description: '额外的自定义指令，用于覆盖或补充当前人设。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            required: ['ok'],
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              pending: {
                type: 'boolean',
                description: '提议待确认（requireToolConfirmation 开启时返回，变更尚未生效）'
              },
              changes: {
                type: 'object',
                description: '实际发生变化的字段',
                properties: {
                  nickname: { type: 'string' },
                  occupation: { type: 'string' },
                  bio: { type: 'string' },
                  style: { type: 'string' },
                  language: { type: 'string' },
                  headingLists: { type: 'string' },
                  emoji: { type: 'string' },
                  customInstructions: { type: 'string' },
                },
              },
            },
          },
        },
        async execute(args) {
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

            // 确认模式：不落盘，返回待确认提议（/soul confirm 应用、/soul reject 拒绝）
            const snapshot = await loadConfig()
            if (snapshot.requireToolConfirmation) {
              const T0 = promptTextOf(snapshot)
              const pendingKeys = Object.keys(patch).filter((key) => snapshot[key] !== patch[key])
              if (pendingKeys.length === 0) {
                return { ok: true, message: T0.toolNoChanges }
              }
              const proposalChanges = Object.fromEntries(pendingKeys.map((key) => [key, patch[key]]))
              pendingPersonaProposal = { patch: proposalChanges, proposedAt: new Date().toISOString() }
              const detail = pendingKeys.map((key) => `${key}=${JSON.stringify(patch[key])}`).join(', ')
              return {
                ok: true,
                pending: true,
                changes: proposalChanges,
                message: `${T0.toolProposal}\n${detail}\n${T0.toolProposalHint}`
              }
            }

            // 写队列内合并，避免与其他写入方（Web UI、/soul 命令）竞态；
            // changed 由队列任务统一 diff 得出
            const { config: updated, changed } = await commitConfig((current) => {
              const next = { ...current }
              for (const key of Object.keys(patch)) {
                next[key] = patch[key]
              }
              return next
            })

            if (changed.length === 0) {
              return { ok: true, message: promptTextOf(updated).toolNoChanges }
            }

            refreshPromptAndInject(ctx, updated)
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
      const { config } = await commitConfig(current => ({ ...current, ...patch }))
      return config
    },
    async getSystemPrompt() {
      const config = await loadConfig()
      return compilePrompt(config)
    },
    async resetConfig() {
      const { config } = await commitConfig(current => defaultConfigPreservingPersonas(current))
      return config
    }
  })
  
  // 注册各模块
  registerRoutes(ctx)
  registerPersonaRoutes(ctx)
  registerCommands(ctx)
  registerSystemPrompt(ctx)
  registerTools(ctx)
}

export { name }
