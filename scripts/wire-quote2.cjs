const fs = require('fs')
const P = 'D:/AliuProject/dsh-plugin/dsh-soul/client/index.mjs'
let t = fs.readFileSync(P, 'utf8')
let n = 0
const sub = (from, to, tag) => {
  if (!t.includes(from)) { console.log('MISSING: ' + tag); process.exit(1) }
  t = t.replace(from, to); n++
}

// ① 设置页开关（插在「人设变更需确认」之后、光轨分组之前）
sub(
  [
    "              e('label', { htmlFor: 'soul-toolConfirm' }, t('field.toolConfirm')),",
    "              e(SoulHint, { text: t('hint.toolConfirm') })",
    '            ),'
  ].join('\n'),
  [
    "              e('label', { htmlFor: 'soul-toolConfirm' }, t('field.toolConfirm')),",
    "              e(SoulHint, { text: t('hint.toolConfirm') })",
    '            ),',
    '',
    '            // 引用作为上下文：单独的开关，关掉只影响引用，人设照常工作。',
    "            e('div', { className: 'soul-toggle' },",
    "              e('input', {",
    "                type: 'checkbox',",
    "                id: 'soul-quoteAsContext',",
    '                checked: localQuote,',
    '                onChange: (ev) => setLocalQuote(ev.target.checked)',
    '              }),',
    "              e('label', { htmlFor: 'soul-quoteAsContext' }, t('field.quoteAsContext')),",
    "              e(SoulHint, { text: t('hint.quoteAsContext') })",
    '            ),'
  ].join('\n'),
  'UI 开关'
)

// ② 历史字段标签
sub(
  "      requireToolConfirmation: 'field.toolConfirm',",
  [
    "      requireToolConfirmation: 'field.toolConfirm',",
    "      quoteAsContext: 'field.quoteAsContext',"
  ].join('\n'),
  'history label'
)

// ③ 中文文案
sub(
  "      'hint.toolConfirm': ",
  "      'field.quoteAsContext': '引用作为上下文',\n      'hint.quoteAsContext': '开启后，可在回答里选中一段文字并点「引用」，它作为上下文随下一轮请求送达模型 —— 不进你的消息正文，也不写进对话历史。',\n      'hint.toolConfirm': ",
  'zh'
)

// ④ 英文文案
sub(
  "      'hint.toolConfirm': ",
  "      'field.quoteAsContext': 'Quote as context',\n      'hint.quoteAsContext': 'When on, select a passage in a reply and click \"Quote\" — it is sent to the model as context with the next request, without entering your message or the chat history.',\n      'hint.toolConfirm': ",
  'en'
)

fs.writeFileSync(P, t, 'utf8')
console.log('applied ' + n + ' edits')
