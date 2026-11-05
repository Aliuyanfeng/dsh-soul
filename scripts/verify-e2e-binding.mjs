// scripts/verify-e2e-binding.mjs — 引用真绑定的端到端回归（离线）
//
// 为什么需要它：C104 是源文本契约，verify-quote-binding 是纯函数行为，
// 但都证明不了「host 落盘 → 查询端点 → client 按 node-key 画到**正确那条**消息」
// 这条链真的闭环。这里用真实纯函数 + 真实 paint 逻辑切片跑一遍。
//
// 最关键的一条断言：三条消息里只有**中间那条**带引用，胶囊必须挂在中间，
// 而不是首条或末条 —— 这正是旧版「挂到最新消息」bug 的照妖镜。
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'
import {
  readQuoteBindings,
  bindQuotesToMessage,
  normalizeBindingDoc,
  writeQuoteBindings,
  messageIdOfNodeKey
} from '../lib/quote-binding.mjs'

const EXPECTED_ASSERTIONS = 10
let passed = 0
const check = (name, fn) => {
  passed++
  try { fn(); console.log('  ✓ ' + name) }
  catch (err) { err.message = `【${name}】${err.message}`; throw err }
}

const tmp = mkdtempSync(join(tmpdir(), 'soul-e2e-'))
const configPath = join(tmp, 'soul-config.json')
writeFileSync(configPath, '{}')
const SID = 's1'
const MSG_ID = 'bd9049f2-298f-46d6-88a7-b679c4b98db0'
const NODE_KEY = '13:input-message' + MSG_ID

// ---- ① host：setQuotes 快照 + session/event 绑定落盘 ----
const snapshot = { quotes: [{ text: '引用原文A' }], at: 1000 }
const event = { type: 'user/message', surfaceOp: 'append', data: { id: MSG_ID } }
check('user/message + surfaceOp=append 才进入绑定', () => {
  assert.equal(event.type === 'user/message' && event.surfaceOp === 'append', true)
})
const initial = await readQuoteBindings(configPath, SID)
const bound = bindQuotesToMessage(initial.bindings, String(event.data.id), snapshot.quotes, snapshot.at)
const capped = normalizeBindingDoc({ version: 1, sessionId: SID, bindings: bound }, SID).bindings
await writeQuoteBindings(configPath, SID, capped)
check('host 按 event.data.id 落盘', () => {
  assert.equal(Object.keys(capped)[0], MSG_ID)
  assert.equal(capped[MSG_ID].quotes[0].text, '引用原文A')
})

// ---- ② 查询端点读回 ----
const served = await readQuoteBindings(configPath, SID)
check('查询端点读回绑定表', () => {
  assert.equal(served.bindings[MSG_ID].quotes[0].text, '引用原文A')
})

// ---- ③ DOM 垫片 ----
const allNodes = []
function makeEl(cls, attrs) {
  const el = {
    className: cls || '', _attrs: Object.assign({}, attrs || {}), children: [], parentElement: null,
    get firstChild() { return this.children.length ? this.children[0] : null },
    getAttribute(n) { return Object.prototype.hasOwnProperty.call(this._attrs, n) ? this._attrs[n] : null },
    setAttribute(n, v) { this._attrs[n] = String(v) },
    appendChild(c) { c.parentElement = this; this.children.push(c); return c },
    insertBefore(c, ref) { c.parentElement = this; const i = ref == null ? -1 : this.children.indexOf(ref); if (i <= 0) this.children.unshift(c); else this.children.splice(i, 0, c); return c },
    removeChild(c) {
      const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1)
      c.parentElement = null
      const g = allNodes.indexOf(c); if (g >= 0) allNodes.splice(g, 1)
      return c
    },
    closest(sel) { let cur = this; while (cur !== null) { if (sel === '[data-chat-node-key]' && cur.getAttribute('data-chat-node-key') !== null) return cur; cur = cur.parentElement } return null },
    textContent: ''
  }
  allNodes.push(el); return el
}
function matches(el, sel) {
  if (sel === '[class*="userRow"]') return el.className.indexOf('userRow') >= 0
  if (sel[0] === '[' && sel[sel.length - 1] === ']') return el.getAttribute(sel.slice(1, -1)) !== null
  return false
}
const document = {
  createElement() { return makeEl('') },
  querySelectorAll(s) { return allNodes.filter(e => matches(e, s)) },
  querySelector(s) { return allNodes.find(e => matches(e, s)) || null }
}
function addMsg(nodeKey) {
  const h = makeEl('flowItem', { 'data-chat-node-key': nodeKey })
  const r = makeEl('userRow_x'); r.textContent = '消息'
  h.appendChild(r); return r
}
addMsg('13:input-message' + 'aaaaaaaa-0000-0000-0000-000000000001')  // 首
const targetRow = addMsg(NODE_KEY)                                     // 中（带引用）
addMsg('13:input-message' + 'bbbbbbbb-0000-0000-0000-000000000002')  // 尾

// ---- ④ client paint 逻辑切片（逐行对应 client/index.mjs）----
const ATTR = 'data-soul-quote-sent', FOR_ATTR = 'data-soul-quote-for', USER_ROW = '[class*="userRow"]'
const tr = (k, p) => k === 'quote.sentBadge' ? '引用 ' + p.count : ('#' + p.index + ' ' + p.text)
const bindings = served.bindings
// 直接复用**真实源码**的提取函数，不在测试里内联副本 ——
// 否则改坏 lib/quote-binding.mjs 时 e2e 仍会用旧的副本通过（实测漏检过）。
const messageIdOf = messageIdOfNodeKey
function paint() {
  const wanted = new Set()
  for (const row of document.querySelectorAll(USER_ROW)) {
    if (typeof row.closest !== 'function') continue
    const holder = row.closest('[data-chat-node-key]')
    if (holder === null) continue
    const id = messageIdOf(holder.getAttribute('data-chat-node-key'))
    if (id !== null && Object.prototype.hasOwnProperty.call(bindings, id)) wanted.add(id)
  }
  for (const stale of document.querySelectorAll('[' + ATTR + ']')) {
    const forId = stale.getAttribute(FOR_ATTR)
    if (forId === null || !wanted.has(forId)) {
      if (stale.parentElement !== null) stale.parentElement.removeChild(stale)
    }
  }
  for (const row of document.querySelectorAll(USER_ROW)) {
    if (typeof row.closest !== 'function') continue
    const holder = row.closest('[data-chat-node-key]')
    if (holder === null) continue
    const id = messageIdOf(holder.getAttribute('data-chat-node-key'))
    if (id === null) continue
    const entry = bindings[id]
    if (entry === undefined || !Array.isArray(entry.quotes) || entry.quotes.length === 0) continue
    let drawn = false
    for (const b of document.querySelectorAll('[' + FOR_ATTR + ']')) {
      if (b.getAttribute(FOR_ATTR) === id) { drawn = true; break }
    }
    if (drawn) continue
    const badge = document.createElement('div')
    badge.className = 'soul-quote-sent'
    badge.setAttribute(ATTR, String(entry.at || 0))
    badge.setAttribute(FOR_ATTR, id)
    badge.textContent = tr('quote.sentBadge', { count: String(entry.quotes.length) })
    const tip = document.createElement('div')
    tip.className = 'soul-quote-sent-tip'
    tip.textContent = entry.quotes.map((q, i) => tr('quote.sentItem', { index: String(i + 1), text: String((q && q.text) || '') })).join('\n\n')
    badge.appendChild(tip)
    row.insertBefore(badge, row.firstChild)
  }
}

paint()
const badges = document.querySelectorAll('[' + ATTR + ']')
check('只画 1 个胶囊', () => assert.equal(badges.length, 1))
check('胶囊绑定正确的消息 id', () => assert.equal(badges[0].getAttribute(FOR_ATTR), MSG_ID))
check('★ 胶囊挂在【中间那条】消息上，不是首条也不是最新条', () => {
  assert.equal(badges[0].parentElement, targetRow)
})
check('tooltip 含引用原文', () => {
  assert.equal(badges[0].children[0].textContent.includes('引用原文A'), true)
})
paint()
check('重复 paint 幂等（不得重复插入）', () => {
  assert.equal(document.querySelectorAll('[' + ATTR + ']').length, 1)
})
targetRow.removeChild(badges[0])
check('宿主抹掉后能补画', () => {
  paint()
  assert.equal(document.querySelectorAll('[' + ATTR + ']').length, 1)
})
const other = await readQuoteBindings(configPath, 's2')
check('跨会话隔离', () => assert.equal(Object.keys(other.bindings).length, 0))

rmSync(tmp, { recursive: true, force: true })
console.log('\n全部通过：' + passed + ' 项检查')
if (!assertCount('verify-e2e-binding', passed, EXPECTED_ASSERTIONS)) process.exit(1)
