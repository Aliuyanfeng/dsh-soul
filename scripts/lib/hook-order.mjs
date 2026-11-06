// scripts/lib/hook-order.mjs — React Rules of Hooks 静态检查
//
// 为什么需要静态检查而不是行为测试：
// 「守卫 return 夹在 hook 之间」这类违例，只有**真实 React** 会抛
// （Rendered more/fewer hooks than ...）。本套件的 React 垫片按路径分帧、
// 按调用顺序取槽，槽位不够时就地新建（见 verify-client.mjs 文件头），
// 对 hook 数量变化完全无感 —— 实测把 SoulQuickToggle 的守卫挪回 useState 之前，
// 「off→on 同一棵树」的行为断言照样通过。所以这条必须由源码结构钉住。
//
// 判定规则（组件 = 4 空格缩进的 `function Name(props)`，与 componentBody 同一约定）：
//   在函数体**顶层**（花括号深度 1）出现的 `return null` 守卫之后，
//   不得再出现任何 hook 调用语句。
// 深度用花括号计数求得，刻意**不**按缩进判断 —— 本文件里就有一处组件体内
// 少缩进两格的语句，靠缩进会漏。

// 组件体顶层的 hook 调用语句（`React.useState(...)` / `useSoulController(...)` /
// `const [a, setA] = React.useState(...)`）。已经限定「深度 1 且非注释行」，
// 所以只需判断这一行里有没有 hook 调用。
const HOOK_STATEMENT = /\b(?:React\.use[A-Z]\w*|use[A-Z]\w*)\s*\(/

// 组件体顶层的守卫式提前返回（`return null` / `if (...) return null`）
const GUARD_CLAUSE = /^(?:if \(.*\) )?return (?:null|undefined);?$/

/**
 * 逐行求出「该行起始时处于函数体第几层花括号」。
 * @returns {number[]} 与 lines 同长；下标即行号
 */
function depthProfile(lines, start, end) {
  const depths = new Array(lines.length).fill(0)
  let depth = 0
  let started = false
  for (let i = start; i <= end; i++) {
    depths[i] = started ? depth : 0
    const line = lines[i]
    let quote = null
    for (let j = 0; j < line.length; j++) {
      const c = line[j]
      if (quote) {
        if (c === '\\') { j++; continue }
        if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; continue }
      if (c === '/' && line[j + 1] === '/') break
      if (c === '{') { depth++; started = true } else if (c === '}') {
        depth--
        if (depth === 0 && started) break
      }
    }
  }
  return depths
}

/**
 * @param {string} text client/index.mjs 全文
 * @returns {{fn: string, guardLine: number, hookLine: number, hook: string}[]}
 */
export function findHookOrderViolations(text) {
  const lines = text.split('\n')
  const heads = []
  for (let i = 0; i < lines.length; i++) {
    const m = /^    function ([A-Za-z_$][\w$]*)\(/.exec(lines[i])
    if (m) heads.push({ name: m[1], start: i })
  }
  const found = []
  for (let k = 0; k < heads.length; k++) {
    const start = heads[k].start
    const end = k + 1 < heads.length ? heads[k + 1].start - 1 : lines.length - 1
    const depths = depthProfile(lines, start, end)
    let guard = -1
    for (let i = start + 1; i <= end; i++) {
      if (depths[i] !== 1) continue
      const t = lines[i].trim()
      if (t.startsWith('//') || t.startsWith('*')) continue
      if (GUARD_CLAUSE.test(t)) { guard = i; break }
    }
    if (guard < 0) continue
    for (let i = guard + 1; i <= end; i++) {
      if (depths[i] !== 1) continue
      const t = lines[i].trim()
      if (t.startsWith('//') || t.startsWith('*')) continue
      if (HOOK_STATEMENT.test(t)) {
        found.push({ fn: heads[k].name, guardLine: guard + 1, hookLine: i + 1, hook: t.slice(0, 72) })
        break
      }
    }
  }
  return found
}
