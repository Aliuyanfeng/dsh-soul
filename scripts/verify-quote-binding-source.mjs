// scripts/verify-quote-binding-source.mjs — 胶囊绑定必须落在「用户真消息」的 id 上
//
// 用户实测：修好引用送达后，胶囊反而消失了。根因是宿主每轮会先 append 一条
// runtime-context 消息（引用上下文本体），它也是 user/message + append + 带 id；
// 若 session/event 不过滤它，quoteSnapshot 会被绑到这条不渲染成 input-message
// 节点的消息 id 上，客户端按 `input-message<uuid>` 找不到目标 ⇒ 胶囊不画。
//
// 这里真挂载 index.mjs，模拟宿主一整轮的事件序列，查 /api/soul/quotes/bound
// 断言绑定**只**落在用户真消息的 id 上。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'
import { messageIdOfNodeKey } from '../lib/quote-binding.mjs'

const EXPECTED_ASSERTIONS = 5
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')
let passed = 0
const check = (name, fn) => {
  passed++
  try { fn(); console.log('  ✓ ' + name) }
  catch (err) { err.message = `【${name}】${err.message}`; throw err }
}

const tmp = mkdtempSync(join(tmpdir(), 'soul-bindsrc-'))
const copy = join(tmp, 'pkg')
mkdirSync(copy, { recursive: true })
for (const f of ['index.mjs', 'package.json']) cpSync(join(PKG, f), join(copy, f))
for (const d of ['lib', 'locale']) cpSync(join(PKG, d), join(copy, d), { recursive: true })
const nm = join(copy, 'node_modules', '@deepseek-ai', 'dsh-llm')
mkdirSync(nm, { recursive: true })
writeFileSync(join(nm, 'package.json'), '{"name":"@deepseek-ai/dsh-llm","version":"0.0.0","type":"module","main":"index.mjs"}')
writeFileSync(join(nm, 'index.mjs'), 'export function createUserMessage(){return {}}')
process.env.DSH_HOME = join(tmp, 'home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

const mod = await import(pathToFileURL(join(copy, 'index.mjs')).href)
const contexts = [], routes = new Map(), eventHandlers = []
const ctx = {
  systemPrompt: {
    section() { return () => {} },
    context(o) { contexts.push(o); return () => {} }
  },
  webServer: { register(r) { routes.set(r.path, r.handler) } },
  logger: { warn() {}, error() {}, info() {} },
  get() { return undefined },
  inject(names, cb) {
    const list = Array.isArray(names) ? names : [names]
    if (list.length && list.every((n) => n === 'systemPrompt' || n === 'webServer')) cb(ctx)
  },
  provide() {}, effect(fn) { return fn() },
  on(name, fn) { if (name === 'session/event') eventHandlers.push(fn) },
  emit() {}
}
await mod.apply(ctx)

const call = async (path, body, method = 'POST', url = path) => {
  const handler = routes.get(path)
  if (!handler) throw new Error('no route ' + path)
  let out
  const res = { writeHead() {}, end(text) { out = text } }
  const req = {
    method,
    url,
    // 真实浏览器的 JSON fetch 会带 Content-Type；csrfGuard（0.13.0）要求写请求是 JSON。
    // Sec-Fetch-Site 缺省即放行（同源 / 本地调用不一定带）。
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {}
  }
  if (method === 'POST') req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
  await handler(req, res)
  return JSON.parse(out)
}
const SID = 'session-abc123'
const USER_MSG_ID = 'user-uuid-1234'
const CTX_MSG_ID = 'context-uuid-9999'
const Q = '引用原文XYZ'

// 用户选中引用
await call('/api/soul/quotes', { sessionId: SID, quotes: [{ text: Q }] }, 'POST')
// 让 text() 求值（送达），再按 Enter 清空
const qctx = contexts.find((c) => c.name === 'soul:quotes')
qctx.text({ agent: { session: { id: SID } } })
await call('/api/soul/quotes', { sessionId: SID, quotes: [] }, 'POST')

const emit = (id, sourceKind) => {
  for (const fn of eventHandlers) {
    fn({ id: SID, header: { id: SID } },
      { type: 'user/message', surfaceOp: 'append', data: { id, source: { kind: sourceKind } } })
  }
}
// 宿主真实顺序：先 runtime-context，再用户真消息
emit(CTX_MSG_ID, 'runtime-context')
emit(USER_MSG_ID, 'user')

// 落盘是异步的，等一小会儿
await new Promise((r) => setTimeout(r, 120))

const bound = await call('/api/soul/quotes/bound', null, 'GET', '/api/soul/quotes/bound?sessionId=' + SID)
check('绑定表非空', () => assert.equal(Object.keys(bound.bindings).length, 1))
check('★ 绑定落在【用户真消息】的 id 上', () => {
  assert.ok(bound.bindings[USER_MSG_ID], '应绑定到 ' + USER_MSG_ID)
  assert.equal(bound.bindings[USER_MSG_ID].quotes[0].text, Q)
})
check('★ 不得绑定到 runtime-context 消息的 id', () => {
  assert.equal(bound.bindings[CTX_MSG_ID], undefined)
})
check('★ 该 id 能被 DOM 的 node-key 提取规则识别', () => {
  const nodeKey = '13:input-message' + USER_MSG_ID
  assert.equal(messageIdOfNodeKey(nodeKey), USER_MSG_ID)
})
check('客户端查询端点只返回本会话绑定', () => {
  // 换一个 sessionId 查，应为空
  return call('/api/soul/quotes/bound', null, 'GET', '/api/soul/quotes/bound?sessionId=other')
    .then((r) => assert.equal(Object.keys(r.bindings).length, 0))
})

rmSync(tmp, { recursive: true, force: true })
console.log('\n全部通过：' + passed + ' 项检查')
if (!assertCount('verify-quote-binding-source', passed, EXPECTED_ASSERTIONS)) process.exit(1)
