// scripts/verify-quote-delivery.mjs — 引用真的拼进 systemPrompt.context 了吗？
//
// 为什么单独一个脚本：用户实测反馈「模型在思考里猜我的意思，根本没看到引用」。
// 根因是按 Enter 清空 quotePending 发生在 text() 求值之前，而此前所有 e2e
// 都只验证 context 被**注册**了，从没断言过 text() 返回的内容。
//
// 这里真挂载 index.mjs，按宿主的真实顺序模拟：
//   setQuotes → quoteClear(空) → refreshContext.text() → 重试 → session/event → 下一轮
// 断言每一步 text() 的**实际返回值**。
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'

const EXPECTED_ASSERTIONS = 8
const HERE = dirname(fileURLToPath(import.meta.url))
const PKG = resolve(HERE, '..')

let passed = 0
const check = (name, fn) => {
  passed++
  try { fn(); console.log('  ✓ ' + name) }
  catch (err) { err.message = `【${name}】${err.message}`; throw err }
}

const tmp = mkdtempSync(join(tmpdir(), 'soul-delivery-'))
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

const contexts = []
const routes = new Map()
const eventHandlers = []
const ctx = {
  systemPrompt: {
    section() { return () => {} },
    context(options) { contexts.push(options); return () => {} }
  },
  webServer: { register(route) { routes.set(route.path, route.handler) } },
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

const call = async (path, body, method = 'POST') => {
  const handler = routes.get(path)
  if (!handler) throw new Error('no route ' + path)
  let out
  const res = { writeHead() {}, end(text) { out = text } }
  const req = {
    method,
    url: path,
    // 真实 JSON fetch 会带 Content-Type；csrfGuard（0.13.0）要求写请求是 JSON
    headers: method === 'POST' ? { 'content-type': 'application/json' } : {}
  }
  if (method === 'POST') {
    req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
  }
  await handler(req, res)
  return JSON.parse(out)
}

const SID = 'session-abc123'
const Q1 = '用户引用了这段原文，希望你就此回应'
const Q2 = '第二轮的新引用'
const quoteCtx = contexts.find((c) => c.name === 'soul:quotes')
const fake = { agent: { session: { id: SID } } }
const text = () => quoteCtx.text(fake)
const emitMessage = (id, sourceKind = 'user') => {
  for (const fn of eventHandlers) {
    fn(
      { id: SID, header: { id: SID } },
      { type: 'user/message', surfaceOp: 'append', data: { id, source: { kind: sourceKind } } }
    )
  }
}

check('soul:quotes context 已注册', () => assert.ok(quoteCtx))
check('session/event 已订阅消息提交', () => assert.equal(eventHandlers.length, 1))

await call('/api/soul/quotes', { sessionId: SID, quotes: [{ text: Q1 }] }, 'POST')
check('引用刚设置时 text() 含引用原文', () => {
  assert.match(text(), /用户当前引用的原文/)
  assert.match(text(), new RegExp(Q1))
})

// ★ 核心时序：按 Enter 清空 quotePending（送达层历史值），必须**不影响**送达。
await call('/api/soul/quotes', { sessionId: SID, quotes: [] }, 'POST')
check('★ 按 Enter 清空后，模型请求装配仍能读到引用（此前的 bug）', () => {
  assert.match(text(), new RegExp(Q1), '模型看不到引用就只能靠推理猜 —— 这正是用户报的现象')
})
check('模型请求重试时引用仍在', () => {
  assert.match(text(), new RegExp(Q1))
})

// ★ 宿主每轮会先 append 一条 runtime-context 消息（我们的引用上下文本体），
// 它也是 user/message + append + 带 id，但 source.kind = "runtime-context"。
// 它**绝不能**消费 quoteSnapshot —— 否则快照被绑到不渲染成 input-message 节点的
// id 上，客户端找不到目标，胶囊就消失（用户实测反馈）。
emitMessage('ctx-uuid-0', 'runtime-context')
check('★ runtime-context 消息不得消费引用快照', () => {
  assert.match(text(), new RegExp(Q1), '上下文消息后引用仍应在，供真正的用户消息绑定')
})

emitMessage('msg-uuid-1', 'user')
check('★ 真正的用户消息提交后，下一轮 text() 为空，不重复送达', () => {
  assert.equal(text(), '')
})

await call('/api/soul/quotes', { sessionId: SID, quotes: [{ text: Q2 }] }, 'POST')
await call('/api/soul/quotes', { sessionId: SID, quotes: [] }, 'POST')
check('下一轮新引用可再次送达', () => {
  const s = text()
  assert.match(s, new RegExp(Q2))
  assert.equal(s.includes(Q1), false, '旧引用不该混进新一轮')
})

rmSync(tmp, { recursive: true, force: true })
console.log('\n全部通过：' + passed + ' 项检查')
if (!assertCount('verify-quote-delivery', passed, EXPECTED_ASSERTIONS)) process.exit(1)
