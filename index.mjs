// index.mjs — dsh-soul host 入口
//
// 三层架构：
//   - Identity（身份）：角色定义、人格特征
//   - Behavior（行为）：决策逻辑、行为约束
//   - Style（风格）：语气、表达方式、格式
//
// 功能：
//   - 支持自定义 Agent 回复风格和语调
//   - 支持用户昵称，回复时使用昵称称呼
//   - 保存用户配置到文件系统
//   - 提供 HTTP API 供客户端调用
//   - 注册斜杠命令 /soul 查看当前配置
//   - 注入系统提示词到 Agent

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const name = 'soul'

// 配置文件路径：$DSH_HOME/soul-config.json
function configPath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'soul-config.json')
}

// ==================== 三层架构 ====================

// Identity 层：身份定义
const IdentityLayer = {
  // 角色定义
  roles: {
    'default': '助手',
    'mentor': '导师',
    'friend': '朋友',
    'expert': '专家',
    'critic': '批评家'
  },
  
  // 构建身份描述
  build(config) {
    const parts = []
    
    // 用户自定义角色
    if (config.customInstructions) {
      parts.push(config.customInstructions)
    }
    
    // 用户昵称
    if (config.nickname) {
      parts.push(`你的用户叫"${config.nickname}"，在回复中使用这个称呼`)
    }
    
    return parts.join('\n')
  }
}

// Behavior 层：行为规则
const BehaviorLayer = {
  // 风格映射
  styles: {
    professional: '专业严谨、注重逻辑和准确性',
    casual: '轻松自然、像朋友一样交流',
    friendly: '友好亲切、温暖体贴',
    humorous: '幽默风趣、适当使用比喻和玩笑',
    academic: '学术性、引用权威来源、注重术语准确性'
  },
  
  // 语调映射
  tones: {
    neutral: '中性客观',
    formal: '正式礼貌',
    informal: '非正式、口语化',
    enthusiastic: '热情积极',
    calm: '平静沉稳'
  },
  
  // 行为规则
  rules: [
    '在回答任何问题时，都必须体现上述身份特征',
    '禁止使用标准AI助手的中性语气',
    '保持角色一致性，不要跳出设定'
  ],
  
  // 构建行为描述
  build(config) {
    const parts = []
    
    // 风格
    if (config.style && this.styles[config.style]) {
      parts.push(`回复风格：${this.styles[config.style]}`)
    }
    
    // 语调
    if (config.tone && this.tones[config.tone]) {
      parts.push(`语调：${this.tones[config.tone]}`)
    }
    
    return parts.join('，')
  }
}

// Style 层：输出格式
const StyleLayer = {
  // 格式模板
  templates: {
    default: '{content}',
    structured: '## {title}\n\n{content}',
    casual: '{content}~',
    formal: '尊敬的{nickname}，{content}'
  },
  
  // 构建风格描述
  build(config) {
    const parts = []
    
    // 根据风格选择格式
    if (config.style === 'casual') {
      parts.push('使用轻松的语气')
    } else if (config.style === 'formal') {
      parts.push('使用正式的语气')
    }
    
    return parts.join('，')
  }
}

// ==================== 配置管理 ====================

// 默认配置
const DEFAULT_CONFIG = {
  enabled: true,
  nickname: '',
  style: 'professional',
  tone: 'neutral',
  language: 'zh',
  customInstructions: '',
  // 人设预设：保存/切换完整人格三件套（昵称+风格+语调+自定义指令），
  // 不含 enabled / language / presets 自身——预设是「内容」，开关与语言是「环境」。
  presets: [],
  examples: [
    { label: '专业严谨', value: '你是一个专业严谨的助手，采用学术性的语气，注重逻辑和准确性。' },
    { label: '友好亲切', value: '你是一个友好亲切的助手，采用轻松自然的语气，像朋友一样交流。' },
    { label: '幽默风趣', value: '你是一个幽默风趣的助手，适当使用比喻和玩笑，让对话更有趣。' },
    { label: '简洁直接', value: '你是一个简洁直接的助手，回答问题直击要点，避免冗余。' }
  ]
}

// 内存中的配置缓存
let configCache = null

// 读取配置
async function loadConfig() {
  if (configCache) return configCache
  
  try {
    const data = await readFile(configPath(), 'utf8')
    configCache = { ...DEFAULT_CONFIG, ...JSON.parse(data) }
  } catch {
    configCache = { ...DEFAULT_CONFIG }
  }
  return configCache
}

// 保存配置
async function saveConfig(config) {
  const dir = join(configPath(), '..')
  await mkdir(dir, { recursive: true })
  await writeFile(configPath(), JSON.stringify(config, null, 2), 'utf8')
  configCache = config
  return config
}

// ==================== 提示词编译器 ====================

// Prompt Compiler：编译三层架构为系统提示词
function compilePrompt(config) {
  if (!config.enabled) {
    return ''
  }
  
  const identity = IdentityLayer.build(config)
  const behavior = BehaviorLayer.build(config)
  const style = StyleLayer.build(config)
  
  // 如果没有任何配置，返回空
  if (!identity && !behavior) {
    return ''
  }
  
  // 编译提示词
  const parts = []
  
  // 身份层
  if (identity) {
    parts.push(`[角色设定] ${identity}`)
  }
  
  // 行为层
  if (behavior) {
    parts.push(`[回复风格] ${behavior}`)
  }
  
  // 执行规则
  parts.push(`[执行规则] 你必须在每一条回复中严格遵守以上设定，包括但不限于：代码解释、技术问答、日常闲聊、知识科普等所有场景。违反此规则视为失败。`)
  
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

  const prompt = compilePrompt(config)
  const disabledText = [
    '[dsh-soul 个性化配置已关闭]',
    '从现在开始不要使用 dsh-soul 之前注入的昵称、角色、回复风格或语调配置。',
    '请恢复使用 Agent 的默认行为。'
  ].join('\n')
  const snapshotText = prompt || disabledText

  for (const agent of agents.list()) {
    try {
      agent.inject(createUserMessage({
        content: [{
          type: 'text',
          text: prompt ? [
            '[dsh-soul 个性化配置已更新]',
            '以下是当前最新的个性化配置快照。',
            '从现在开始必须按照此配置回复，不要继续使用旧的昵称、旧的角色或旧的风格。',
            '',
            prompt
          ].join('\n') : snapshotText
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

// 预设承载的人格字段（宿主端路由与斜杠命令共用）
const PRESET_FIELDS = ['nickname', 'style', 'tone', 'customInstructions']

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
            let raw = ''
            for await (const chunk of req) raw += chunk
            const newConfig = JSON.parse(raw)
            const current = await loadConfig()
            const updated = await saveConfig({ ...current, ...newConfig })
            
            // 配置变化后更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            
            send(200, { ok: true, config: updated })
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
    
    // 预览系统提示词（不落盘、不注入——用于设置页实时预览未保存的编辑）
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
            return send(405, { ok: false, error: 'Method not allowed' })
          }
          let raw = ''
          for await (const chunk of req) raw += chunk
          const draft = JSON.parse(raw || '{}')
          // 以已保存配置为底，仅用请求体中的字段覆盖，避免预览请求篡改完整配置
          const current = await loadConfig()
          const prompt = compilePrompt({ ...current, ...draft })
          send(200, { ok: true, prompt, enabled: draft.enabled !== undefined ? draft.enabled : current.enabled })
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

        try {
          const config = await saveConfig({ ...DEFAULT_CONFIG })

          // 配置变化后更新系统提示词，并注入所有活动会话
          refreshPromptAndInject(ctx, config)

          send(200, { ok: true, config })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
        }
      }
    })

    // 预设管理：POST /api/soul/presets/save   { name } 以当前配置为人设存为预设（同名覆盖）
    //           POST /api/soul/presets/apply  { name } 应用预设到当前配置
    //           POST /api/soul/presets/delete { name } 删除预设
    wsCtx.webServer.register({
      kind: 'exact',
      path: '/api/soul/presets',
      handler: async (req, res) => {
        const send = (status, body) => {
          res.writeHead(status, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }

        try {
          if (req.method !== 'POST') {
            return send(405, { ok: false, error: 'Method not allowed' })
          }
          const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
          const action = url.searchParams.get('action') || ''
          const op = url.pathname.split('/').pop() // save | apply | delete（兼容 action 查询参数）
          const kind = action || op
          let raw = ''
          for await (const chunk of req) raw += chunk
          const body = JSON.parse(raw || '{}')
          const name = typeof body.name === 'string' ? body.name.trim() : ''
          if (!name) return send(400, { ok: false, error: 'name is required' })
          if (name.length > 40) return send(400, { ok: false, error: 'name too long (max 40)' })

          const config = await loadConfig()
          const presets = Array.isArray(config.presets) ? config.presets : []

          if (kind === 'save') {
            // 请求体可携带 draft（设置页未保存的编辑）作为预设内容；
            // 未携带时以当前已保存配置为预设内容（斜杠命令路径）。
            const preset = { name }
            for (const f of PRESET_FIELDS) {
              const v = body[f] !== undefined ? body[f] : config[f]
              preset[f] = typeof v === 'string' ? v : ''
            }
            const idx = presets.findIndex(p => p.name === name)
            const next = [...presets]
            if (idx >= 0) next[idx] = preset
            else next.push(preset)
            const updated = await saveConfig({ ...config, presets: next })
            return send(200, { ok: true, config: updated, saved: name })
          }

          if (kind === 'apply') {
            const preset = presets.find(p => p.name === name)
            if (!preset) return send(404, { ok: false, error: `preset not found: ${name}` })
            const updated = { ...config }
            for (const f of PRESET_FIELDS) {
              if (typeof preset[f] === 'string') updated[f] = preset[f]
            }
            await saveConfig(updated)
            // 人设内容变化 → 刷新提示词并注入活动会话
            refreshPromptAndInject(ctx, updated)
            return send(200, { ok: true, config: updated, applied: name })
          }

          if (kind === 'delete') {
            const next = presets.filter(p => p.name !== name)
            if (next.length === presets.length) return send(404, { ok: false, error: `preset not found: ${name}` })
            const updated = await saveConfig({ ...config, presets: next })
            return send(200, { ok: true, config: updated, deleted: name })
          }

          return send(400, { ok: false, error: `unknown action: ${kind}` })
        } catch (err) {
          send(500, { ok: false, error: String(err.message || err) })
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
    styleLabel: '风格',
    toneLabel: '语调',
    instructionsLabel: '自定义指令',
    enabled: '已启用',
    disabled: '已禁用',
    notSet: '未设置',
    presetsLabel: '预设',
    noPresets: '（暂无预设。使用 /soul save <名称> 保存当前人设）',
    help: '使用 /soul show 查看详情\n使用 /soul reset 重置配置\n使用 /soul enable 启用\n使用 /soul disable 禁用\n使用 /soul 昵称xxx 设置昵称\n使用 /soul save <名称> 保存当前人设为预设\n使用 /soul use <名称> 应用预设\n使用 /soul list 列出预设\n使用 /soul delete <名称> 删除预设',
    resetDone: '✅ 配置已重置为默认值',
    presetSaved: (n, overwrote) => `✅ 预设「${n}」已保存${overwrote ? '（覆盖同名预设）' : ''}`,
    presetApplied: (n) => `✅ 预设「${n}」已应用，昵称/风格/语调/自定义指令已更新`,
    presetDeleted: (n) => `✅ 预设「${n}」已删除`,
    presetNotFound: (n) => `❌ 未找到预设：${n}`,
    presetNameRequired: '用法：/soul save|use|delete <名称>',
    presetListTitle: (count) => `📋 已保存 ${count} 个预设：`,
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
    styleLabel: 'Style',
    toneLabel: 'Tone',
    instructionsLabel: 'Custom instructions',
    enabled: 'enabled',
    disabled: 'disabled',
    notSet: 'not set',
    presetsLabel: 'Presets',
    noPresets: '(no presets yet. Use /soul save <name> to save the current persona)',
    help: 'Use /soul show to view details\nUse /soul reset to reset\nUse /soul enable to enable\nUse /soul disable to disable\nUse /soul <nickname> to set your nickname\nUse /soul save <name> to save the current persona as a preset\nUse /soul use <name> to apply a preset\nUse /soul list to list presets\nUse /soul delete <name> to delete a preset',
    resetDone: '✅ Configuration reset to defaults',
    presetSaved: (n, overwrote) => `✅ Preset "${n}" saved${overwrote ? ' (overwrote existing)' : ''}`,
    presetApplied: (n) => `✅ Preset "${n}" applied — nickname/style/tone/custom instructions updated`,
    presetDeleted: (n) => `✅ Preset "${n}" deleted`,
    presetNotFound: (n) => `❌ Preset not found: ${n}`,
    presetNameRequired: 'Usage: /soul save|use|delete <name>',
    presetListTitle: (count) => `📋 ${count} preset(s) saved:`,
    enableDone: '✅ Personalization enabled',
    disableDone: '✅ Personalization disabled',
    nicknameDone: (n) => `✅ Nickname set to: ${n}`,
    failed: (e) => `Operation failed: ${e}`
  }
}

function commandMessages(config) {
  return COMMAND_MESSAGES[config.language === 'en' ? 'en' : 'zh']
}

function registerCommands(ctx) {
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'soul',
      description: '查看或管理个性化设置。用法：/soul [show|reset|enable|disable|save|use|list|delete|昵称]',
      input: { hint: '[show|reset|enable|disable|save|use|list|delete|昵称]' },
      async handler(invocation) {
        // 保留原始大小写用于昵称与预设名，仅关键字匹配时忽略大小写
        const raw = String(invocation.rawInput || '').trim()
        const args = raw.toLowerCase()

        // 预设子命令形如 "save 名字"：切出关键字与名称参数（名称保留大小写）
        const spaceIdx = raw.indexOf(' ')
        const keyword = spaceIdx === -1 ? args : args.slice(0, spaceIdx)
        const nameArg = spaceIdx === -1 ? '' : raw.slice(spaceIdx + 1).trim()

        try {
          const config = await loadConfig()
          const t = commandMessages(config)

          if (keyword === 'save' || keyword === 'use' || keyword === 'delete') {
            if (!nameArg) return { kind: 'error', text: t.presetNameRequired }
            const presets = Array.isArray(config.presets) ? config.presets : []
            if (keyword === 'save') {
              const preset = { name: nameArg }
              for (const f of PRESET_FIELDS) preset[f] = typeof config[f] === 'string' ? config[f] : ''
              const idx = presets.findIndex(p => p.name === nameArg)
              const next = [...presets]
              if (idx >= 0) next[idx] = preset
              else next.push(preset)
              await saveConfig({ ...config, presets: next })
              return { kind: 'success', text: t.presetSaved(nameArg, idx >= 0) }
            }
            if (keyword === 'use') {
              const preset = presets.find(p => p.name === nameArg)
              if (!preset) return { kind: 'error', text: t.presetNotFound(nameArg) }
              const updated = { ...config }
              for (const f of PRESET_FIELDS) {
                if (typeof preset[f] === 'string') updated[f] = preset[f]
              }
              await saveConfig(updated)
              // 人设内容变化 → 刷新提示词并注入活动会话
              refreshPromptAndInject(ctx, updated)
              return { kind: 'success', text: t.presetApplied(nameArg) }
            }
            // delete
            const next = presets.filter(p => p.name !== nameArg)
            if (next.length === presets.length) return { kind: 'error', text: t.presetNotFound(nameArg) }
            await saveConfig({ ...config, presets: next })
            return { kind: 'success', text: t.presetDeleted(nameArg) }
          } else if (keyword === 'list') {
            const presets = Array.isArray(config.presets) ? config.presets : []
            if (presets.length === 0) {
              return { kind: 'success', text: `${t.presetsLabel}${t.colon}${t.noPresets}` }
            }
            const lines = presets.map((p, i) => `${i + 1}. ${p.name}${p.nickname ? `（${p.nickname}）` : ''}`)
            return { kind: 'success', text: `${t.presetListTitle(presets.length)}\n${lines.join('\n')}` }
          } else           if (args === 'show' || args === '') {
            const status = config.enabled ? t.enabled : t.disabled
            const nickname = config.nickname || t.notSet
            const style = config.style || t.notSet
            const tone = config.tone || t.notSet
            const instructions = config.customInstructions || t.notSet
            const presets = Array.isArray(config.presets) ? config.presets : []
            const presetInfo = presets.length > 0 ? `（${presets.length} 个预设）` : ''

            return {
              kind: 'success',
              text: `${t.showTitle}\n\n${t.statusLabel}${t.colon}${status}\n${t.nicknameLabel}${t.colon}${nickname}\n${t.styleLabel}${t.colon}${style}\n${t.toneLabel}${t.colon}${tone}\n${t.instructionsLabel}${t.colon}${instructions}\n${t.presetsLabel}${t.colon}${presets.length}${presetInfo}\n\n${t.help}`
            }
          } else if (args === 'reset') {
            const updated = await saveConfig({ ...DEFAULT_CONFIG })
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.resetDone }
          } else if (args === 'enable') {
            config.enabled = true
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.enableDone }
          } else if (args === 'disable') {
            config.enabled = false
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.disableDone }
          } else {
            // 设置昵称（保留原始大小写，不做 toLowerCase）
            config.nickname = raw
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: t.nicknameDone(raw) }
          }
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
          '调整当前个性化人设（昵称、回复风格、语调、自定义指令）。' +
          '当用户明确要求改变称呼、语气、风格或角色时使用。' +
          '只需要传入要修改的字段，未提供的字段保持不变。',
        parameters: {
          nickname: { type: 'string', description: '用户昵称，回复时会使用这个称呼。' },
          style: {
            type: 'string',
            enum: ['professional', 'casual', 'friendly', 'humorous', 'academic'],
            description: '回复风格。'
          },
          tone: {
            type: 'string',
            enum: ['neutral', 'formal', 'informal', 'enthusiastic', 'calm'],
            description: '语调。'
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
              changes: {
                type: 'object',
                description: '实际发生变化的字段',
                properties: {
                  nickname: { type: 'string' },
                  style: { type: 'string' },
                  tone: { type: 'string' },
                  customInstructions: { type: 'string' },
                },
              },
            },
          },
        },
        async execute(args) {
          try {
            const current = await loadConfig()
            const patch = {}
            if (typeof args.nickname === 'string' && args.nickname !== current.nickname) {
              patch.nickname = args.nickname
            }
            if (typeof args.style === 'string' && args.style !== current.style) {
              patch.style = args.style
            }
            if (typeof args.tone === 'string' && args.tone !== current.tone) {
              patch.tone = args.tone
            }
            if (typeof args.customInstructions === 'string' && args.customInstructions !== current.customInstructions) {
              patch.customInstructions = args.customInstructions
            }
            if (Object.keys(patch).length === 0) {
              return { ok: true, message: '没有要更改的设置' }
            }
            const updated = { ...current, ...patch }
            await saveConfig(updated)
            refreshPromptAndInject(ctx, updated)
            return { ok: true, message: '已更新个性化设置', changes: patch }
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
      const current = await loadConfig()
      const updated = { ...current, ...newConfig }
      return await saveConfig(updated)
    },
    async getSystemPrompt() {
      const config = await loadConfig()
      return compilePrompt(config)
    },
    async resetConfig() {
      return await saveConfig({ ...DEFAULT_CONFIG })
    }
  })
  
  // 注册各模块
  registerRoutes(ctx)
  registerCommands(ctx)
  registerSystemPrompt(ctx)
  registerTools(ctx)
}

export { name }
