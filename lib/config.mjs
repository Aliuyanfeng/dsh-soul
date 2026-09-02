// lib/config.mjs — dsh-soul 配置层（纯函数模块，无任何依赖）
//
// 职责：
//   - 默认配置与合法取值常量（DEFAULT_CONFIG / STYLE_VALUES / TRAIT_VALUES / LANGUAGE_VALUES）
//   - 旧版本配置迁移（migrateConfig）
//   - 外部输入校验（sanitizeConfig）：字段白名单 + 类型断言 + 长度上限 + 枚举校验
//
// index.mjs 的所有配置写路径（HTTP 保存 / /soul 命令 / set_persona 工具 / soulConfig 服务）
// 共用同一套校验；本模块可被 scripts/verify-config.mjs 独立加载测试。

export const DEFAULT_CONFIG = {
  enabled: true,
  nickname: '',
  // 关于你：用户职业 / 用户介绍
  occupation: '',
  bio: '',
  // 回复风格和语调（v0.2.0 起合并为单一选项）
  style: 'professional',
  // 特质：标题和列表 / 表情符号（default=默认，more=增强，less=减弱）
  headingLists: 'default',
  emoji: 'default',
  language: 'zh',
  customInstructions: ''
}

// 合法的回复风格和语调取值（供工具参数校验）
export const STYLE_VALUES = ['professional', 'casual', 'humorous', 'roast', 'efficient']

// 特质合法取值
export const TRAIT_VALUES = ['default', 'more', 'less']

// 输出语言合法取值
export const LANGUAGE_VALUES = ['zh', 'en']

// 文本字段长度上限：防止超长文本撑爆 system prompt（同时缩小提示词注入面）。
// 超限一律拒绝、不做静默截断，避免改写用户输入。
export const FIELD_LIMITS = {
  nickname: 50,
  occupation: 50,
  bio: 500,
  customInstructions: 2000
}

// 需做长度校验的自由文本字段
const TEXT_FIELDS = ['nickname', 'occupation', 'bio', 'customInstructions']

// v0.1.x 配置使用 style + tone 两个字段；v0.2.0 起合并为单一 style（回复风格和语调）。
// 迁移映射：组合命中用组合表，否则退回旧 style 表，再否则用默认值。
const LEGACY_STYLE_TONE_MAP = {
  'professional+formal': 'professional',
  'casual+neutral': 'casual',
  'humorous+informal': 'humorous'
}
const LEGACY_STYLE_MAP = {
  professional: 'professional',
  casual: 'casual',
  friendly: 'casual',
  humorous: 'humorous',
  academic: 'professional'
}

// 迁移并清洗磁盘上的历史配置：补齐默认值、合并旧 style+tone、丢弃废弃字段、
// 特质脏数据回退为默认值。
export function migrateConfig(raw) {
  const config = { ...DEFAULT_CONFIG, ...raw }
  if (raw && typeof raw.style === 'string' && typeof raw.tone === 'string') {
    const combo = `${raw.style}+${raw.tone}`
    config.style = LEGACY_STYLE_TONE_MAP[combo] || LEGACY_STYLE_MAP[raw.style] || DEFAULT_CONFIG.style
    delete config.tone
  }
  // 人设预设 / 示例指令功能已在 v0.2.0 移除，丢弃历史残留字段
  delete config.presets
  delete config.tone
  delete config.examples
  // 特质字段校验：脏数据回退为默认值
  if (!TRAIT_VALUES.includes(config.headingLists)) config.headingLists = 'default'
  if (!TRAIT_VALUES.includes(config.emoji)) config.emoji = 'default'
  return config
}

// 校验外部传入的配置补丁，返回 { patch, errors }：
//   - patch：通过校验的字段补丁（仅含白名单字段），调用方将其合并到当前配置
//   - errors：被拒绝字段的原因表（字段名 -> 说明）；非空时调用方应整单拒绝本次写入
//
// 规则：
//   - 白名单：未知字段静默丢弃，不再落盘
//   - 类型：enabled 必须为布尔；文本字段必须为字符串；枚举字段必须命中合法取值
//   - 长度：文本字段超过 FIELD_LIMITS 即拒绝（不截断）
//   - 文本字段保存前 trim 首尾空白，空串视为清除该字段
export function sanitizeConfig(raw) {
  const patch = {}
  const errors = {}

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { patch, errors: { _: '配置必须是一个 JSON 对象' } }
  }

  if ('enabled' in raw) {
    if (typeof raw.enabled === 'boolean') {
      patch.enabled = raw.enabled
    } else {
      errors.enabled = '必须为布尔值（true / false）'
    }
  }

  for (const key of TEXT_FIELDS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value !== 'string') {
      errors[key] = '必须为字符串'
      continue
    }
    const text = value.trim()
    if (text.length > FIELD_LIMITS[key]) {
      errors[key] = `长度超过上限 ${FIELD_LIMITS[key]} 字符（当前 ${text.length}）`
      continue
    }
    patch[key] = text
  }

  const ENUM_CHECKS = [
    ['style', STYLE_VALUES, '回复风格和语调'],
    ['headingLists', TRAIT_VALUES, '特质·标题和列表'],
    ['emoji', TRAIT_VALUES, '特质·表情符号'],
    ['language', LANGUAGE_VALUES, '输出语言']
  ]
  for (const [key, values, label] of ENUM_CHECKS) {
    if (!(key in raw)) continue
    const value = raw[key]
    if (typeof value === 'string' && values.includes(value)) {
      patch[key] = value
    } else {
      errors[key] = `${label}必须是 ${values.join(' / ')} 之一`
    }
  }

  return { patch, errors }
}
