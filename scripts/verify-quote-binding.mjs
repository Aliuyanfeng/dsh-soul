// scripts/verify-quote-binding.mjs — 引用真绑定纯函数层的行为回归
//
// 为什么单独一个脚本：lib/quote-binding.mjs 是「消息 id ↔ 引用」真绑定的核心，
// 只靠源文本契约（verify-client 的 C104）证明不了运行时的 key 提取、清洗、
// 跨会话隔离、版本忽略是对的。这里真 import 真调用。
import assert from 'node:assert/strict'
import { assertCount } from './lib/skip-report.mjs'
import {
  messageIdOfNodeKey,
  normalizeBindingDoc,
  bindQuotesToMessage,
  quoteBindingPathFor,
  QUOTE_BINDING_VERSION
} from '../lib/quote-binding.mjs'

// 基线断言数。新增用例必须同步这里。
const EXPECTED_ASSERTIONS = 11

let passed = 0
const check = (name, fn) => {
  passed++
  try { fn(); console.log('  ✓ ' + name) }
  catch (err) {
    err.message = `【${name}】${err.message}`
    throw err
  }
}

check('node-key → 消息裸 id（实测格式）', () => {
  const k = '13:input-messagebd9049f2-298f-46d6-88a7-b679c4b98db0'
  assert.equal(messageIdOfNodeKey(k), 'bd9049f2-298f-46d6-88a7-b679c4b98db0')
})
check('node-key 无 input-message → null', () => {
  assert.equal(messageIdOfNodeKey('13:some-other-node'), null)
  assert.equal(messageIdOfNodeKey(''), null)
  assert.equal(messageIdOfNodeKey(null), null)
})
check('取最后一个 input-message 之后的全部内容', () => {
  assert.equal(messageIdOfNodeKey('x:input-messagey:input-messageZ'), 'Z')
})
check('绑定：清洗空白 + 保留原文', () => {
  const b = bindQuotesToMessage({}, 'id-1', [{ text: '  引用A  ' }], 100)
  assert.equal(b['id-1'].quotes[0].text, '引用A')
  assert.equal(b['id-1'].at, 100)
})
check('绑定：空消息 id / 空引用不写入', () => {
  assert.deepEqual(bindQuotesToMessage({}, '', [{ text: 'a' }], 1), {})
  assert.deepEqual(bindQuotesToMessage({}, 'id-1', [], 1), {})
})
check('绑定：覆盖同一消息 id', () => {
  let b = bindQuotesToMessage({}, 'id-1', [{ text: '旧' }], 1)
  b = bindQuotesToMessage(b, 'id-1', [{ text: '新' }], 2)
  assert.equal(b['id-1'].quotes[0].text, '新')
  assert.equal(b['id-1'].at, 2)
})
check('读侧：跨会话文档整条忽略（防串会话）', () => {
  const b = bindQuotesToMessage({}, 'id-1', [{ text: 'A' }], 1)
  const doc = normalizeBindingDoc({ version: QUOTE_BINDING_VERSION, sessionId: 'other', bindings: b }, 's1')
  assert.equal(Object.keys(doc.bindings).length, 0)
})
check('读侧：未知版本整条忽略', () => {
  const b = bindQuotesToMessage({}, 'id-1', [{ text: 'A' }], 1)
  const doc = normalizeBindingDoc({ version: 999, sessionId: 's1', bindings: b }, 's1')
  assert.equal(Object.keys(doc.bindings).length, 0)
})
check('读侧：损坏形状返回空表而非抛错', () => {
  for (const raw of [null, 42, [], 'x', { version: 1 }]) {
    const doc = normalizeBindingDoc(raw, 's1')
    assert.equal(Object.keys(doc.bindings).length, 0)
  }
})
check('读侧：过滤空引用条目', () => {
  const doc = normalizeBindingDoc({
    version: QUOTE_BINDING_VERSION,
    sessionId: 's1',
    bindings: { a: { quotes: [{ text: 'A' }], at: 1 }, b: { quotes: [], at: 2 }, c: null }
  }, 's1')
  assert.deepEqual(Object.keys(doc.bindings), ['a'])
})
check('sidecar 路径：哈希定长、不含原始 sessionId', () => {
  const p = quoteBindingPathFor('C:/home/.dsh/soul-config.json', 'session-abc/../evil')
  assert.ok(p.includes('soul-quote-bindings'))
  assert.equal(p.includes('evil'), false)
  assert.match(p, /[a-f0-9]{32}\.json$/)
})

console.log('\n全部通过：' + passed + ' 项检查')
if (!assertCount('verify-quote-binding', passed, EXPECTED_ASSERTIONS)) process.exit(1)
