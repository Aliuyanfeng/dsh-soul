// lib/quote-binding.mjs — 引用与「消息唯一 id」的绑定（纯函数层 + sidecar 读写）
//
// 为什么存在这个模块
// ------------------
// 历史胶囊（消息上方那个「1 个已选文本片段」小标签）早期靠 **DOM 观察 + 推断**
// 把引用挂到消息上：pending / 数量变化 / 文本变化 / 快照前最后一条……
// 结果在桌面端反复出现「不出现、迁移到最新消息、过几秒消失」。
//
// 根因：引用与消息之间**没有真正的关联**，全靠在渲染时机里猜。
//
// 现在的机制（真绑定）
// --------------------
//   1. host 侧订阅 `session/event`，当 `user/message` 提交时，
//      把它当时挂着的引用，用**该消息的 id** 存进绑定表（落盘）。
//   2. 客户端遍历 DOM 的 `data-chat-node-key`（形如 `13:input-message<uuid>`），
//      提取出 `<uuid>` 去查绑定表，命中就画胶囊。
//
// 两端能对上的依据（已查宿主源码，勿凭印象改）
// -------------------------------------------
//   · dsh-client-ui-conversation: messageDefinition.kind = "input-message"，
//     match 返回 `{ id: String(event.data.id) }` —— 节点 id 就是 user/message 的 data.id。
//   · dsh-client-ui-chat: `"data-chat-node-key": routedNode.key`，
//     而 flowKey 源自 routedNode.key。用户实测值 `13:input-message<uuid>`。
//   ⇒ `<uuid>` === `event.data.id`。
//
// 为什么用「裸 uuid」而不是完整 node-key 作表键
// -------------------------------------------
//   完整 key 带 `13:` 前缀（会话/流编号），前缀语义不公开、可能随会话变化。
//   裸 uuid 是消息自身的 id，稳定且两端一致。DOM 侧提取尾段即可。
//
// 本模块不碰宿主 ctx、不碰 DOM —— 纯函数 + 文件读写，可被离线脚本直接测。

import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { readConfigFile, writeConfigFile } from './store.mjs'

export const QUOTE_BINDING_VERSION = 1

// sidecar 目录名（与 soul-config.json 同级）
const BINDING_DIR = 'soul-quote-bindings'

// 单条引用的上限（与 index.mjs 的 QUOTE_MAX_ITEMS / QUOTE_MAX_CHARS 对齐）
export const BINDING_MAX_ITEMS = 20
export const BINDING_MAX_CHARS = 4000

// 单个会话最多保留多少条绑定。超出丢最早，避免 sidecar 无限增长。
export const BINDING_MAX_PER_SESSION = 200

/** sidecar 路径：sha256(sessionId) 定长、规避路径穿越。 */
export function quoteBindingPathFor(configPath, sessionId) {
  const hash = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return join(dirname(configPath), BINDING_DIR, hash + '.json')
}

/**
 * 从 DOM 的 data-chat-node-key 提取消息裸 id。
 *
 * `13:input-messagebd9049f2-298f-...` → `bd9049f2-298f-...`
 *
 * 不做严格 uuid 校验：宿主只保证它是 String(event.data.id)，字符集不公开。
 * 取最后一个 `input-message` 之后的全部内容即可；取不到返回 null（调用方跳过）。
 */
export function messageIdOfNodeKey(nodeKey) {
  const raw = String(nodeKey === null || nodeKey === undefined ? '' : nodeKey)
  const at = raw.lastIndexOf('input-message')
  if (at < 0) return null
  const id = raw.slice(at + 'input-message'.length)
  return id === '' ? null : id
}

/**
 * 校验并清洗一条绑定的引用数组。读侧一律当不可信输入。
 */
function cleanQuotes(rawQuotes) {
  const list = Array.isArray(rawQuotes) ? rawQuotes : []
  const out = []
  for (const item of list) {
    if (out.length >= BINDING_MAX_ITEMS) break
    const text = typeof item === 'string'
      ? item
      : String(item && item.text !== undefined ? item.text : '')
    const trimmed = text.trim()
    if (trimmed === '') continue
    out.push({ text: trimmed.slice(0, BINDING_MAX_CHARS) })
  }
  return out
}

/**
 * 把磁盘读来的一份文档规整成 `{ sessionId, bindings }`。
 * 任何不确定都返回空表（宁可少画，不要画错位置），且**不删除文件**。
 */
export function normalizeBindingDoc(raw, expectedSessionId) {
  const empty = { sessionId: String(expectedSessionId), bindings: {} }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  if (raw.version !== QUOTE_BINDING_VERSION) return empty
  // 文件名是哈希，内容里的 sessionId 必须与预期互相校验（防串会话）
  if (String(raw.sessionId) !== String(expectedSessionId)) return empty
  const src = raw.bindings
  if (src === null || typeof src !== 'object' || Array.isArray(src)) return empty

  const bindings = {}
  // 只收合法条目；按 at 排序后截断到上限，丢最早的
  const entries = []
  for (const [id, entry] of Object.entries(src)) {
    if (typeof id !== 'string' || id === '') continue
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const quotes = cleanQuotes(entry.quotes)
    if (quotes.length === 0) continue
    entries.push([id, { quotes, at: Number(entry.at) || 0 }])
  }
  entries.sort((a, b) => b[1].at - a[1].at)
  for (const [id, entry] of entries.slice(0, BINDING_MAX_PER_SESSION)) {
    bindings[id] = entry
  }
  return { sessionId: String(expectedSessionId), bindings }
}

/** 读一个会话的绑定表。文件不存在 / 损坏 / 版本不认识 → 空表。 */
export async function readQuoteBindings(configPath, sessionId) {
  const filePath = quoteBindingPathFor(configPath, sessionId)
  const { value } = await readConfigFile(filePath)
  return normalizeBindingDoc(value, sessionId)
}

/**
 * 把「某条消息」的引用写进绑定表。
 *
 * @returns 新的 bindings（对象），调用方负责落盘前再做一次 normalize 截断。
 */
export function bindQuotesToMessage(bindings, messageId, quotes, at) {
  const next = Object.assign({}, bindings)
  const id = String(messageId === null || messageId === undefined ? '' : messageId)
  if (id === '') return next
  const cleaned = cleanQuotes(quotes)
  if (cleaned.length === 0) {
    delete next[id]
    return next
  }
  next[id] = { quotes: cleaned, at: Number(at) || Date.now() }
  return next
}

/** 写回一个会话的完整绑定表。 */
export async function writeQuoteBindings(configPath, sessionId, bindings) {
  const filePath = quoteBindingPathFor(configPath, sessionId)
  const doc = {
    version: QUOTE_BINDING_VERSION,
    sessionId: String(sessionId),
    bindings: Object.assign({}, bindings)
  }
  await writeConfigFile(filePath, doc)
  return doc
}
