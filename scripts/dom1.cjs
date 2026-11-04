const fs = require('fs')
const P = 'D:/AliuProject/dsh-plugin/dsh-soul/client/index.mjs'
let t = fs.readFileSync(P, 'utf8')
let n = 0
const sub = (from, to, tag) => {
  if (!t.includes(from)) { console.log('MISSING: ' + tag); process.exit(1) }
  t = t.replace(from, to); n++
}

// ① 模块级：最近一次「已发送」的引用快照（供历史注入）
sub(
  "    const quoteBuckets = new Map()",
  `    const quoteBuckets = new Map()

    // 最近一次「已发送」的引用快照（按会话）。
    //
    // 为什么要快照：引用送达后当前引用会被清空，而历史里那条消息还要能显示
    // 「它带了什么引用」。清空之前必须先留一份。
    //
    // 只保留**最近一次**：历史注入只挂到最新那条回合上，更早的不追溯 ——
    // 追溯需要把引用与消息 id 持久化绑定，那是另一套成本。
    const sentQuoteBuckets = new Map()`,
  'sent store'
)

// ② Dock：移除发送检测 effect（改由常驻组件统一处理）
sub(
  `      // 发送完成后自动清空引用。
      //
      // ⚠️ 曾用「输入框内容从有变空」当信号 —— **那是错的**：
      //   · 用户输入一段话再手动删光，草稿同样变空 ⇒ 刚加的引用被误清；
      //   · 且「只引用不输入就发送」那种情况永远检测不到。
      //   一句话：草稿状态反映的是"输入区有没有字"，不是"消息有没有发出去"。
      //
      // 现在的信号：**消息列表里多了一个回合**（[\`data-chat-turn\`]）。
      //   它和「发送成功」语义完全等价 —— 手动删字不会新增回合。
      //
      // 拿不到回合容器时**不清空**（失败方向安全：宁可多留一次引用，
      // 也不要误清；用户随时可以点浮层上的「清空」）。
      const turnCountRef = React.useRef(-1)
      React.useEffect(() => {
        if (sessionId === '') return undefined
        if (quotes.length === 0) return undefined
        if (typeof MutationObserver !== 'function') return undefined
        if (typeof document === 'undefined') return undefined

        // 回合容器的父节点即消息列表。取第一个回合向上找一层。
        const firstTurn = document.querySelector('[data-chat-turn]')
        const list = firstTurn === null ? null : firstTurn.parentElement
        if (list === null) return undefined

        const countTurns = () => list.querySelectorAll('[data-chat-turn]').length
        turnCountRef.current = countTurns()

        const check = () => {
          const next = countTurns()
          // 只有**增加**才算「新消息发出去了」；删除/清空会话不触发
          if (next <= turnCountRef.current) {
            turnCountRef.current = next
            return
          }
          turnCountRef.current = next
          quoteClear(sessionId)
        }

        const observer = new MutationObserver(check)
        observer.observe(list, { childList: true, subtree: true })
        return () => observer.disconnect()
      }, [sessionId, quotes.length])

`,
  'drop dock effect'
)

fs.writeFileSync(P, t, 'utf8')
console.log('applied ' + n + ' edits')
