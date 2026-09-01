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
  customInstructions: '',
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
    
    // 获取系统提示词
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
  })
}

// ==================== 斜杠命令 ====================

function registerCommands(ctx) {
  ctx.inject(['commands'], (cmdCtx) => {
    cmdCtx.commands.register({
      name: 'soul',
      description: '查看或管理个性化设置。用法：/soul [show|reset|enable|disable|昵称]',
      input: { hint: '[show|reset|enable|disable|昵称]' },
      async handler(invocation) {
        const args = String(invocation.rawInput || '').trim().toLowerCase()
        
        try {
          const config = await loadConfig()
          
          if (args === 'show' || args === '') {
            const status = config.enabled ? '已启用' : '已禁用'
            const nickname = config.nickname || '未设置'
            const style = config.style || '未设置'
            const tone = config.tone || '未设置'
            const instructions = config.customInstructions || '未设置'
            
            return {
              kind: 'success',
              text: `🧠 个性化设置\n\n状态：${status}\n昵称：${nickname}\n风格：${style}\n语调：${tone}\n自定义指令：${instructions}\n\n使用 /soul show 查看详情\n使用 /soul reset 重置配置\n使用 /soul enable 启用\n使用 /soul disable 禁用\n使用 /soul 昵称xxx 设置昵称`
            }
          } else if (args === 'reset') {
            const updated = await saveConfig({ ...DEFAULT_CONFIG })
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: '✅ 配置已重置为默认值' }
          } else if (args === 'enable') {
            config.enabled = true
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: '✅ 个性化设置已启用' }
          } else if (args === 'disable') {
            config.enabled = false
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: '✅ 个性化设置已禁用' }
          } else {
            // 设置昵称
            config.nickname = args
            const updated = await saveConfig(config)
            // 更新系统提示词，并注入所有活动会话
            refreshPromptAndInject(ctx, updated)
            return { kind: 'success', text: `✅ 昵称已设置为：${args}` }
          }
        } catch (err) {
          return { kind: 'error', text: `操作失败：${err.message}` }
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
}

export { name }
