const fs = require('fs')
const P = 'D:/AliuProject/dsh-plugin/dsh-soul/client/index.mjs'
let t = fs.readFileSync(P, 'utf8')
let n = 0
const sub = (from, to, tag) => {
  if (!t.includes(from)) { console.log('MISSING: ' + tag); process.exit(1) }
  t = t.replace(from, to); n++
}

// ① 删 CSS（4 条）
sub(
  [
    '      // ── 引用作为上下文 ──',
    '      // 动作行按钮：走宿主 sm 档（28 / 12 / 18 / radius-sm / border-l3），',
    '      // 与插件里其它按钮同规格 —— C86 的档位审计会自动检查它。',
    "      '.soul-quote-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',",
    "      '.soul-quote-action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',",
    "      '.soul-quote-action:active:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',",
    "      '.soul-quote-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',"
  ].join('\n'),
  '      // ── 引用作为上下文 ──',
  'css'
)

// ② 删文案（zh）
sub(
  [
    "      'quote.action': '引用',",
    "      'quote.actionFloat': '引用这段',"
  ].join('\n'),
  "      'quote.actionFloat': '引用这段',",
  'zh action'
)
sub(
  [
    "      'quote.selectFirst': '先选中一段文字',",
    "      'quote.tooMany': '引用已达上限',"
  ].join('\n'),
  '',
  'zh notices'
)

// ③ 删文案（en）
sub(
  [
    "      'quote.action': 'Quote',",
    "      'quote.actionFloat': 'Quote this',"
  ].join('\n'),
  "      'quote.actionFloat': 'Quote this',",
  'en action'
)
sub(
  [
    "      'quote.selectFirst': 'Select some text first',",
    "      'quote.tooMany': 'Quote limit reached',"
  ].join('\n'),
  '',
  'en notices'
)

// ④ 删组件（含其上方注释）
sub(
  `    // ── 按钮：挂在每条助手消息的动作行 ──
    function SoulQuoteAction(props) {`,
  '    // ── 占位（原行内「引用」按钮已移除，见下方说明）──\n    function SoulQuoteActionRemoved(props) {',
  'component head'
)

fs.writeFileSync(P, t, 'utf8')
console.log('applied ' + n + ' edits（组件本体下一步按行删除）')
