// scripts/verify-client.mjs — 设置页客户端行为回归（离线，无浏览器）
//
// 为什么需要它：`verify-trail` / `verify-nav-icon` 覆盖的是**渲染层**（DOM 里的 SVG），
// 而设置页的**交互行为**一直只有「源文本契约」——即断言客户端源码里出现了某段写法。
// 那种断言证明不了「运行时真的走了那条分支」：把 `if (!payload)` 改成常量、或让
// `resetConfig` 永不返回 undefined，源码看起来依然正确。
//
// 这里把**真实的 `client/index.mjs`** 原样载入（不复制、不裁剪），在纯 Node 里：
//   1. 用一小撮 React 垫片实现 hooks（useState / useEffect / useRef）与 jsx-runtime；
//   2. 用假 window / document / fetch / 定时器接管外部世界；
//   3. 跑真实的 `apply(ctx)`，拿到真实的 `soulController` 与设置页组件；
//   4. 像用户一样**点按钮**，断言**用户实际会看到的提示文案**。
//
// 覆盖的行为全部是 0.7.1 修过、而此前没有任何行为回归守着的那几处：
//   - 两类问题分开上报：`configError`（配置读不出来）/ `deliveryWarning`（送不到会话）
//   - 重置失败**不得**被报成成功（配置损坏时那唯一一条自救路径）
//   - 重置成功且丢弃过损坏文件时要告知「已备份」
//   - 保存失败**不得**误报成「配置无变化」
//
// 零依赖，直接 `node scripts/verify-client.mjs` 运行。

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { setImmediate as drainTick } from 'node:timers'
import { assertCount } from './lib/skip-report.mjs'

// 基线运行应跑出的断言数。本脚本没有环境相关跳过（客户端源码与 Node 都在），
// 所以链里的 `--strict` 对它无额外语义；数字由下面的 assertCount 守住。
const EXPECTED_ASSERTIONS = 34

const source = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')

// ==================== 一、React 垫片 ====================
//
// 只实现客户端真正用到的那几个 hook（`React.useState` × 25 / `useEffect` × 9 /
// `useRef` × 6，无 useCallback / useMemo / useSyncExternalStore）。hook 按「组件在
// 渲染树里的路径」分帧、按调用顺序取槽 —— 与 React 的规则一致。渲染是同步的：状态
// 变化只置脏标记，由 settle() 收敛。

const Fragment = Symbol('Fragment')

function createRuntime() {
  const frames = new Map() // 路径 -> { key, values: [], deps: [], cursor }
  const cleanups = new Map() // `${frame.key}#${slot}` -> 清理函数
  let frameStack = []
  let queue = []
  let dirty = false

  const frameOf = () => {
    const frame = frameStack[frameStack.length - 1]
    if (!frame) throw new Error('hook 在组件外被调用')
    return frame
  }

  const React = {
    Fragment,
    useState(initial) {
      const frame = frameOf()
      const slot = frame.cursor++
      if (!(slot in frame.values)) {
        frame.values[slot] = typeof initial === 'function' ? initial() : initial
      }
      const set = (next) => {
        const current = frame.values[slot]
        const value = typeof next === 'function' ? next(current) : next
        if (Object.is(value, current)) return
        frame.values[slot] = value
        dirty = true
      }
      return [frame.values[slot], set]
    },
    useEffect(fn, deps) {
      const frame = frameOf()
      const slot = frame.cursor++
      const prev = frame.deps[slot]
      const same = prev !== undefined && deps !== undefined &&
        prev.length === deps.length && deps.every((d, i) => Object.is(d, prev[i]))
      if (same) return
      frame.deps[slot] = deps
      queue.push({ frame, slot, fn })
    },
    useRef(initial) {
      const frame = frameOf()
      const slot = frame.cursor++
      if (!(slot in frame.values)) frame.values[slot] = { current: initial }
      return frame.values[slot]
    }
  }

  const jsx = (type, props, key) => ({ type, props: props || {}, key })

  function renderChildren(children, path) {
    if (children === undefined || children === null || typeof children === 'boolean') return []
    if (Array.isArray(children)) return children.flatMap((c, i) => renderChildren(c, `${path},${i}`))
    if (typeof children === 'string' || typeof children === 'number') {
      return [{ type: '#text', text: String(children) }]
    }
    const node = render(children, path)
    return node ? [node] : []
  }

  function render(node, path) {
    if (typeof node === 'string' || typeof node === 'number') return { type: '#text', text: String(node) }
    if (!node || typeof node !== 'object') return null
    const { type, props } = node
    if (type === Fragment) return { type: '#fragment', children: renderChildren(props.children, `${path}#`) }
    if (typeof type === 'function') {
      const frame = frames.get(path) || { key: path, values: [], deps: [], cursor: 0 }
      frames.set(path, frame)
      frame.cursor = 0
      frameStack.push(frame)
      let out
      try {
        out = type(props)
      } finally {
        frameStack.pop()
      }
      return render(out, `${path}/`)
    }
    // 宿主元素（原生标签，或 ui 垫片里的标记类型）：props 原样保留 —— 断言要读它们
    return { type, props, children: renderChildren(props.children, `${path}>`) }
  }

  const drain = async () => {
    for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  }

  return {
    React,
    jsx,
    Fragment,
    /**
     * 卸载：执行所有已注册 effect 的清理函数。
     *
     * 为什么需要：垫片原先只在**依赖变化**时跑清理（见 settle 里的 previous()），
     * 组件卸载时从不执行 —— 于是「卸载时必须复位某状态」这类契约在测试台里根本
     * 无法触发（判断力验证实测：变异「卸载不复位 paused」漏网，底栏会永久停摆）。
     * 这不是产品缺陷而是测试台能力缺口，故补在这里。
     */
    unmount() {
      for (const fn of cleanups.values()) if (typeof fn === 'function') fn()
      cleanups.clear()
      // ⚠️ 必须**同时清掉 frames**：它是按渲染路径缓存的 hook 状态（useState 的当前值、
      // 已跑过的 deps）。只跑 cleanup 而不清 frames，下一次 render 会复用旧的
      // values/deps —— 于是「重新挂载」实际是「接着上次的状态继续」，effect 因为
      // deps 未变而不再执行。判断力对照实测：不清 frames 时，换掉路由后重进页面
      // 仍然显示上一次成功的数据，看起来像"组件没重新加载"。
      frames.clear()
      frameStack = []
      dirty = false
      queue = []
    },
    /**
     * 渲染 + 跑 effect，直到**状态与异步副作用都稳定**，并返回稳定后的那棵树。
     *
     * 踩过的坑：上一版在 `if (!dirty) return tree` 时返回的是**倒数第二轮**渲染的树 ——
     * 而「最后一轮」什么都没做（dirty 仍为 false，是上一轮的 false 摆在那）。于是
     * 由 `await` 触发的 setState（例如点「绑定」后 handleBind 里 resolve 的那次）
     * 虽然被记进了 frame，却**永远没有出现在返回的树里**：断言看到的是旧画面。
     */
    async settle(root) {
      let tree = null
      for (let pass = 0; pass < 40; pass++) {
        dirty = false
        queue = []
        tree = render(root, 'root')
        const effects = queue
        for (const { frame, slot, fn } of effects) {
          const key = `${frame.key}#${slot}`
          const previous = cleanups.get(key)
          if (typeof previous === 'function') previous()
          const returned = fn()
          cleanups.set(key, typeof returned === 'function' ? returned : null)
        }
        await drain()
        if (!dirty) {
          // 本帧的 effect 都已执行完。若这一帧**一个 effect 都没跑**，它就是最终画面
          // （上一轮的 tree 与它等价）；否则这一帧仍是「状态刚被 effect 改写、尚未重画」
          // 的中间态，必须再渲一轮才把新状态画出来。
          return effects.length === 0 ? tree : render(root, 'root')
        }
      }
      throw new Error('渲染未收敛（40 轮仍在变化）—— hook 依赖或 effect 里可能有自激循环')
    }
  }
}

// ==================== 二、遍历渲染树 ====================

function walk(node, visit) {
  if (!node) return
  visit(node)
  for (const child of node.children || []) walk(child, visit)
}

function textOf(node) {
  if (!node) return ''
  if (node.type === '#text') return node.text
  return (node.children || []).map(textOf).join('')
}

function findAll(tree, predicate) {
  const hits = []
  walk(tree, (node) => {
    if (predicate(node)) hits.push(node)
  })
  return hits
}

/**
 * 按**类名 token 精确匹配**取元素。
 *
 * 不要用 `className.includes('soul-persona-card')` 这种子串匹配：它同时命中
 * `soul-persona-card-head`、`soul-persona-card-pos` —— 实测导致「2 张卡片」被数成
 * 6 个节点（每个卡片还带着两个同前缀的子元素），断言报出误导性的「渲染了 6 张」。
 */
function findAllByClass(tree, cls) {
  return findAll(tree, (n) => {
    const c = n.props?.className
    return typeof c === 'string' && c.split(/\s+/).includes(cls)
  })
}

// ==================== 三、沙箱：假 window / document / 定时器 / fetch ====================

const realTimers = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval
}
let timerQueue = []
let fetchCalls = []

const installFakeTimers = () => {
  // 客户端有三处定时器，全部与断言直接相关，必须接管：
  //   - toast 的 2s 自动消失（绝不能在断言之前触发）；
  //   - 「关于你」分组的 2s 轮询刷新（真实 setInterval 会让事件循环永不空 —— 脚本
  //     跑完最后一行却不退出，看起来像挂住）；
  //   - 提示词预览的 400ms 防抖。
  // 接管后由用例决定何时推进，测试才是确定性的、也才跑得完。
  globalThis.setTimeout = (fn, delay) => {
    const handle = { fn, delay: delay || 0, repeat: false }
    timerQueue.push(handle)
    return handle
  }
  globalThis.setInterval = (fn, delay) => {
    const handle = { fn, delay: delay || 0, repeat: true }
    timerQueue.push(handle)
    return handle
  }
  const drop = (handle) => {
    if (handle) timerQueue = timerQueue.filter((t) => t !== handle)
  }
  globalThis.clearTimeout = drop
  globalThis.clearInterval = drop
}
const restoreTimers = () => {
  globalThis.setTimeout = realTimers.setTimeout
  globalThis.clearTimeout = realTimers.clearTimeout
  globalThis.setInterval = realTimers.setInterval
  globalThis.clearInterval = realTimers.clearInterval
}

const interpolate = (text, params) =>
  String(text).replace(/\{(\w+)\}/g, (all, key) => (params && key in params ? String(params[key]) : all))

/** 载入真实客户端 bundle 并装配插件（返回真实 controller 与设置页组件）。 */
function loadClient(routes, options = {}) {
  let factory = null
  const domNode = () => ({
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {} },
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
    appendChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    children: []
  })
  const windowStub = {
    __ModuleLoader__: { load: (m) => { factory = m.factory } },
    addEventListener: (type) => { captured.events.window.push(type) },
    removeEventListener() {},
    location: { origin: 'http://dsh.test' }
  }
  const documentStub = {
    visibilityState: 'visible',
    body: domNode(),
    head: domNode(),
    addEventListener: (type) => { captured.events.document.push(type) },
    removeEventListener() {},
    // 插件在装配时会把样式表插到 head（用 querySelector 判重），导航图标那一层还会
    // 挂 MutationObserver —— 这里只需让这些调用成立；本脚本断言的是行为，不是 DOM。
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => domNode(),
    createElementNS: () => domNode()
  }

  globalThis.window = windowStub
  globalThis.document = documentStub
  globalThis.MutationObserver = class { observe() {} disconnect() {} takeRecords() { return [] } }
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
  globalThis.requestAnimationFrame = (fn) => drainTick(() => fn(0))
  globalThis.cancelAnimationFrame = () => {}
  globalThis.getComputedStyle = () => ({ position: 'absolute', getPropertyValue: () => '' })
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const method = (init.method || 'GET').toUpperCase()
    const call = { path: url.pathname, method, body: init.body ? JSON.parse(init.body) : null }
    fetchCalls.push(call)
    const handler = routes[url.pathname]
    const body = handler ? handler(call) : { ok: false, error: `no route: ${url.pathname}` }
    if (body === false) return { ok: false, status: 500, json: async () => ({ ok: false, error: 'boom' }) }
    return { ok: true, status: 200, json: async () => body }
  }

  installFakeTimers()

  const runtime = createRuntime()
  const requireStub = (spec) => {
    if (spec === 'react') return runtime.React
    if (spec === 'react/jsx-runtime') return { jsx: runtime.jsx, jsxs: runtime.jsx, Fragment }
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') {
      // ui.Button / ui.Toast 单独换成宿主元素标记：这样它们连同 onClick / text /
      // tone / holdMs / onDone 原样留在渲染树里，断言就能像用户一样
      // 「找到那个按钮并点它」、「读出提示条的文案与色调」，而不是去猜某个闭包。
      return { Button: 'ui-button', Toast: 'ui-toast' }
    }
    throw new Error(`未预料的 require：${spec}`)
  }
  // eslint-disable-next-line no-new-func -- 客户端是宿主加载的 bundle（无 ESM 导入），只能在受控作用域里求值
  new Function('window', source)(windowStub)
  const module = factory(requireStub)

  // events：window/document 上注册过的事件名。用于断言「轮询与页面级监听挂在
  // **装配层**」—— 此前它们全在 SoulSettings 组件内，设置页没挂载时全部失效
  // （底栏人设名因此不刷新）。stub 原本是空实现，这里让它可观测。
  const captured = { provide: {}, sections: [], dicts: null, runtime, events: { window: [], document: [] } }
  // 目录点选服务桩：默认可用，用例可换成 `{ throw: '...' }` 走降级路径。
  // 宿主 UiWorkspaceService.pickDirectory() 返回 string | null，失败时抛普通 Error
  // （capability 被包在 cause 里、客户端读不到）—— 桩必须同形，见 DESIGN §7.5。
  captured.uiWorkspace = {
    pickDirectory: async () => null
  }
  // inject 的语义要跟宿主一致：**同步回调**、回调里的 ctx 就是新 scope。
  // 返回的是一个可 unload 的 fiber；这里只记录已触发次数与卸载函数。
  captured.injected = []
  captured.uiWorkspaceAbsent = options.uiWorkspace === null
  const ctx = {
    provide: (name, value) => { captured.provide[name] = value },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') captured.sections.push({ dispose }) },
    // 动态 inject：只有 uiWorkspace 一个依赖。**不调用**回调 = 服务缺席，
    // 正好用来断言「缺席时插件照常装配、只是点选按钮降级」。
    inject: (deps, cb) => {
      captured.injected.push({ deps, cb })
      const requested = Array.isArray(deps) ? deps : Object.keys(deps || {})
      if (!requested.includes('uiWorkspace')) return
      if (captured.uiWorkspaceAbsent) return
      cb({
        uiWorkspace: captured.uiWorkspace,
        effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') captured.sections.push({ dispose }) }
      })
    },
    locale: {
      register: (_ns, dicts) => { captured.dicts = dicts },
      bind: () => (key, params) => interpolate((captured.dicts?.zh || {})[key] ?? key, params)
    },
    slots: {
      inject: (_name, cb) => cb(),
      register: (options, component) => { captured.sections.push({ options, component }) }
    }
  }
  module.apply(ctx)

  const section = captured.sections.find((s) => s.options && s.options.name === 'settings.section')
  const controller = captured.provide.soulController
  const world = {
    runtime,
    captured,
    section,
    controller,
    routes,
    dicts: captured.dicts,
    apply: module.apply,
    module
  }
  return world
}

// ==================== 四、驱动器 ====================

/**
 * 装配一个干净的客户端实例（含真实的初始 loadConfig）。
 *
 * **桩必须与宿主真实协议同形**：`GET /api/soul/personas` 返回的是
 * `{ personas: <对象 map>, activeName: <名字|null> }`（见 index.mjs:835 personaLibrary），
 * 其中 personas 由 mergePersonas 生成、**恒含 7 个内置人设**（已实测：mergePersonas(null)
 * 也有 7 个键），所以真实环境里「空列表」分支不可达。
 * 此前这个桩写的是 `{ personas: [], activePersona: null }` —— 字段名错（activePersona
 * 而非 activeName）、类型也错（数组而非对象 map），于是人设行与 ★ 标记的渲染在行为层
 * **从未被执行过**：把它改成真实形状，整套 C 系列依然全绿（实测）。这正是「测试替身
 * 与真实协议漂移」的典型：桩喂了一个真实环境不可达的输入，测试永远看不到真问题。
 */
async function boot(configPayload = {}, personaPayload = null, options = {}) {
  fetchCalls = []
  timerQueue = []
  const routes = {
    '/api/soul/config': (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG }, ...configPayload }
      : { ok: true, config: { ...CONFIG }, changed: [] }),
    '/api/soul/config/reset': () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null }),
    // 默认形状贴近宿主：对象 map + activeName（不是数组、不是 activePersona）
    '/api/soul/personas': () => (personaPayload || {
      ok: true,
      personas: { 苏格拉底式提问者: { style: 'professional', builtin: true }, 极简主义者: { style: 'efficient' } },
      activeName: null
    }),
    '/api/soul/prompt': () => ({ ok: true, prompt: 'P', enabled: true })
  }
  const world = loadClient(routes, options)
  for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  return world
}

/**
 * 渲染设置页。`useSoulController` 由宿主把槽位声明的 `hooks.soulController`
 * （一个 subscribe / getSnapshot store）包成 hook 注入 —— 这里用垫片复刻同一语义。
 */
function rootElement(world) {
  const props = world.section.options.inject()
  const store = props.hooks.soulController
  const useSoulController = (selector) => {
    const [, force] = world.runtime.React.useState(0)
    world.runtime.React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
    return selector(store.getSnapshot())
  }
  return { type: world.section.component, props: { ...props, useSoulController } }
}

const renderSettings = (world) => world.runtime.settle(rootElement(world))

/**
 * 渲染设置页并**等异步副作用落地**（点击后的请求、effect 里的 setState）。
 *
 * `settle` 只保证「状态收敛」，而一个 handler 里的 `await fetch` 要等下一轮
 * microtask 才把结果写回 store。断言「点完之后界面上有什么」时必须用它，
 * 否则读到的是点击前那一帧（本文件踩过：绿字已进 store 却读不出来）。
 */
async function renderSettingsSettled(world) {
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  return world.runtime.settle(rootElement(world))
}

/** 输入框左侧的快捷开关（conversation.input.left 槽位），渲染方式与设置页同源。 */
function quickToggleElement(world) {
  const slot = world.captured.sections.find((s) => s.options && s.options.name === 'conversation.input.left')
  assert.ok(slot, '未注册 conversation.input.left 槽位')
  const props = slot.options.inject()
  const store = props.hooks.soulController
  const useSoulController = (selector) => {
    const [, force] = world.runtime.React.useState(0)
    world.runtime.React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
    return selector(store.getSnapshot())
  }
  return { type: slot.component, props: { ...props, useSoulController } }
}

/** 像用户一样点快捷开关，返回之后的按钮节点（可读 props 上的反馈）。 */
async function clickQuickToggle(world) {
  const before = await world.runtime.settle(quickToggleElement(world))
  const buttons = findAll(before, (n) => n.type === 'button' && typeof n.props?.onClick === 'function')
  assert.equal(buttons.length, 1, `快捷开关应恰好一个可点按钮，实际 ${buttons.length}`)
  await buttons[0].props.onClick()
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  const after = await world.runtime.settle(quickToggleElement(world))
  return findAll(after, (n) => n.type === 'button')[0]
}

/** 像用户一样点下指定文案的按钮，返回之后的 toast（{ text, kind }）。 */
async function clickButton(world, labelKey) {
  const tree = await renderSettings(world)
  const label = world.dicts.zh[labelKey]
  const buttons = findAll(tree, (n) => n.type === 'ui-button' && textOf(n) === label)
  assert.equal(buttons.length, 1, `期望恰好一个「${label}」按钮，实际 ${buttons.length} 个`)
  await buttons[0].props.onClick()
  const after = await renderSettings(world)
  // 提示形态对齐宿主模型设置页：成功走内联绿字（.soul-saved-notice，role=status）、
  // 失败走内联红字（.soul-error-notice，role=alert）—— 宿主设置页从不使用 toast。
  const notices = findAll(after, (n) => typeof n.props?.className === 'string' && n.props.className.includes('soul-saved-notice'))
  if (notices.length > 0) {
    assert.equal(notices.length, 1, `期望恰好一条成功绿字，实际 ${notices.length} 条`)
    return { text: textOf(notices[0]), kind: 'success' }
  }
  const errs = findAll(after, (n) => typeof n.props?.className === 'string' && n.props.className.includes('soul-error-notice'))
  assert.equal(errs.length, 1, `期望恰好一条失败红字，实际 ${errs.length} 条`)
  return { text: textOf(errs[0]), kind: 'error' }
}

// ==================== 五、用例 ====================

const CONFIG = {
  enabled: true,
  nickname: '',
  occupation: '',
  bio: '',
  style: 'professional',
  headingLists: 'default',
  emoji: 'default',
  tables: 'default',
  replyLength: 'normal',
  language: 'zh',
  customInstructions: '',
  requireToolConfirmation: false,
  trailEnabled: true,
  trailColor: '#679EFE',
  trailSpeed: 'slow',
  trailWidth: 'thin'
}

let passed = 0
async function check(name, fn) {
  try {
    await fn()
  } catch (error) {
    // 失败时把用例名带进消息：否则只有一行 AssertionError，无法一眼看出是哪个用例塌了。
    // 注意 `stack` 也要改 —— 未捕获错误打印的是 stack，它的首行在 AssertionError 构造时
    // 就已经写死，只改 `message` 在终端上根本看不见（判断力对照实测过）。
    error.message = `【${name}】${error.message}`
    error.stack = `【${name}】${error.stack}`
    throw error
  }
  passed++
  console.log(`  ✓ ${name}`)
}

try {
  await check('C1 真实 client/index.mjs 可在纯 Node 里装配，并通过 settings.section 注册设置栏目', async () => {
    const world = await boot()
    assert.ok(world.section, '未注册 settings.section')
    assert.equal(world.section.options.id, 'soul-settings')
    assert.equal(typeof world.section.options.label, 'function', 'label 必须是函数（语言切换时实时解析）')
    assert.ok(world.controller, '未 provide soulController')
    assert.ok(world.dicts?.zh && world.dicts?.en, '双语文案表未注册')
  })

  await check('C2 装配后立即以 GET 拉取配置（而不是等用户打开设置页）', async () => {
    await boot()
    const got = fetchCalls.filter((c) => c.path === '/api/soul/config' && c.method === 'GET')
    assert.equal(got.length, 1, `期望恰好一次 GET /api/soul/config，实际 ${got.length}`)
  })

  await check('C3 磁盘配置损坏时，configError 要显示在设置页上', async () => {
    const world = await boot({ configError: 'soul-config.json 解析失败' })
    const tree = await renderSettings(world)
    assert.match(textOf(tree), /soul-config\.json 解析失败/, '设置页未显示 configError')
  })

  await check('C4 只有送达警告时，deliveryWarning 同样要显示出来', async () => {
    const world = await boot({ deliveryWarning: '未送达任何活动会话' })
    const tree = await renderSettings(world)
    assert.match(textOf(tree), /未送达任何活动会话/, '设置页未显示 deliveryWarning')
  })

  await check('C5 两者同时存在时以 configError 为准（读不出来的问题更靠前）', async () => {
    const world = await boot({ configError: '读不出来', deliveryWarning: '送不到' })
    assert.equal(world.controller.store.getSnapshot().error, '读不出来')
  })

  await check('C6 保存成功但配置送不到会话时，回传的 deliveryWarning 要落到提示条上', async () => {
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG } }
      : { ok: true, config: { ...CONFIG }, changed: ['style'], deliveryWarning: '注入失败' })
    const payload = await world.controller.saveConfig({ style: 'casual' })
    assert.ok(payload, '保存成功应返回 payload')
    assert.equal(world.controller.store.getSnapshot().error, '注入失败')
  })

  await check('C7 保存失败时 saveConfig 返回 falsy（调用方据此给失败提示，而不是误报「无变化」）', async () => {
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG } }
      : { ok: false, error: '写入被拒绝' })
    const payload = await world.controller.saveConfig({ style: 'casual' })
    assert.equal(payload, undefined, '保存失败不得返回 payload')
    assert.match(String(world.controller.store.getSnapshot().error), /写入被拒绝/)
  })

  await check('C8 重置失败时弹「重置失败」，不得报成成功（0.7.1 修的就是这里）', async () => {
    const world = await boot()
    world.routes['/api/soul/config/reset'] = () => false // 失败响应
    const toast = await clickButton(world, 'button.reset')
    assert.equal(toast.kind, 'error', `重置失败的提示应为错误样式，实际 ${toast.kind}`)
    assert.equal(toast.text, world.dicts.zh['toast.resetFailed'])
    assert.notEqual(toast.text, world.dicts.zh['notice.reset'])
  })

  await check('C9 重置成功且丢弃过损坏文件时，提示「已备份」（而不是普通的「已重置」）', async () => {
    const world = await boot()
    world.routes['/api/soul/config/reset'] = () => ({
      ok: true, config: { ...CONFIG }, changed: [], backupPath: '/x/soul-config.json.corrupt'
    })
    const toast = await clickButton(world, 'button.reset')
    assert.equal(toast.kind, 'success')
    assert.equal(toast.text, world.dicts.zh['notice.resetRecovered'])
  })

  await check('C10 普通重置只提示「已重置」，且不留残余的送达警告', async () => {
    const world = await boot({ deliveryWarning: '旧的送达警告' })
    world.routes['/api/soul/config/reset'] = () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null })
    const toast = await clickButton(world, 'button.reset')
    assert.equal(toast.text, world.dicts.zh['notice.reset'])
    assert.equal(world.controller.store.getSnapshot().error, null, '重置后不应残留上一轮的送达警告')
  })

  await check('C11 保存失败弹「保存失败」，不得误报「配置无变化」', async () => {
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG } }
      : { ok: false, error: '非法颜色' })
    const toast = await clickButton(world, 'button.save')
    assert.equal(toast.kind, 'error')
    assert.equal(toast.text, world.dicts.zh['toast.saveFailed'])
    assert.notEqual(toast.text, world.dicts.zh['notice.noChanges'])
  })

  await check('C12 设置页真的渲染出可点的保存 / 重置按钮（断言不是对着空树跑）', async () => {
    const world = await boot()
    const tree = await renderSettings(world)
    const buttons = findAll(tree, (n) => n.type === 'ui-button')
    assert.ok(buttons.length >= 2, `应至少有保存与重置两个按钮，实际 ${buttons.length}`)
    const labels = buttons.map(textOf)
    assert.ok(labels.includes(world.dicts.zh['button.save']), `未找到保存按钮：${labels.join(' / ')}`)
    assert.ok(labels.includes(world.dicts.zh['button.reset']), `未找到重置按钮：${labels.join(' / ')}`)
    assert.ok(buttons.every((b) => typeof b.props.onClick === 'function'), '按钮缺少 onClick')
    // 反「空树也通过」：不仅要有按钮，还要真的渲染出了栏目与字段
    const text = textOf(tree)
    for (const key of ['settings.title', 'field.nickname', 'button.save', 'button.reset']) {
      assert.ok(
        text.includes(world.dicts.zh[key]),
        `设置页缺少「${key}」对应的文案（${world.dicts.zh[key]}）：${text}`
      )
    }
  })

  await check('C13 快捷开关保存失败时必须给出反馈（此前静默：按钮外观与文案都不变）', async () => {
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG } }
      : false)
    const button = await clickQuickToggle(world)
    assert.equal(button.props['data-failed'], 'true', '失败后 data-failed 必须为 true')
    assert.ok(
      String(button.props.title || '').includes('boom'),
      `失败原因要出现在 title 上，实际：${button.props.title}`
    )
    assert.equal(
      button.props['aria-label'],
      button.props.title,
      'aria-label 需与 title 一致（读屏用户同样要拿到失败原因）'
    )
    // 防空过：成功时该标记必须是 false，否则上面的断言等于写死
    const ok = await boot()
    const good = await clickQuickToggle(ok)
    assert.equal(good.props['data-failed'], 'false', '成功时不应残留失败标记')
  })

  await check('C14 预设列表拉取失败时显示失败原因，不得永远停在「加载中...」', async () => {
    const world = await boot()
    world.routes['/api/soul/personas'] = () => false
    // 人设分组默认折叠（Accordion 折叠时不渲染子节点），先像用户一样展开它
    const closed = await renderSettings(world)
    const triggers = findAll(closed, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))
    assert.equal(triggers.length, 1, `应恰好一个「人设预设」折叠标题，实际 ${triggers.length}`)
    await triggers[0].props.onClick()
    const text = textOf(await renderSettings(world))
    const failedLabel = world.dicts.zh['personas.loadFailed'].split('{')[0]
    assert.ok(text.includes(failedLabel), `应显示加载失败提示，实际渲染：${text.slice(0, 240)}`)
    assert.ok(text.includes('boom'), '失败原因要一并显示')
    assert.ok(
      !text.includes(world.dicts.zh['status.loading']),
      '失败后不得继续显示「加载中...」（此前是空 catch，personas 永为 null）'
    )
    // 防空过：正常加载时不应误报失败
    const ok = await boot()
    const okClosed = await renderSettings(ok)
    const okTrigger = findAll(okClosed, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))[0]
    await okTrigger.props.onClick()
    const okText = textOf(await renderSettings(ok))
    assert.ok(!okText.includes(failedLabel), '正常加载不应误报失败')
  })

  await check('C15 只改首尾空格不算「未保存的更改」（与服务端 trim 判据一致）', async () => {
    // 服务端对字符串字段一律 trim 后再落盘，客户端若按原始串比较 dirty，就会出现
    // 「敲了个空格 → 保存按钮亮起 → 保存成功却提示『配置无变化』」这种自相矛盾的状态。
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG, nickname: 'NickLi6' } }
      : { ok: true, config: { ...CONFIG, nickname: 'NickLi6' }, changed: [] })
    await world.controller.loadConfig()
    for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))

    const find = async () => findAll(await renderSettings(world), (n) => n.type === 'input' && n.props?.id === 'soul-nickname')
    const inputs = await find()
    assert.equal(inputs.length, 1, `应有一个昵称输入框，实际 ${inputs.length}`)
    inputs[0].props.onChange({ target: { value: '  NickLi6  ' } })
    for (let i = 0; i < 4; i++) await new Promise((r) => drainTick(r))
    assert.ok(
      !textOf(await renderSettings(world)).includes(world.dicts.zh['status.unsaved']),
      '只加首尾空格不应被判成「未保存的更改」'
    )
    // 防空过：真有改动时必须提示，否则上面那条等于恒真
    const inputs2 = await find()
    inputs2[0].props.onChange({ target: { value: 'NickLi6-改过' } })
    for (let i = 0; i < 4; i++) await new Promise((r) => drainTick(r))
    assert.ok(
      textOf(await renderSettings(world)).includes(world.dicts.zh['status.unsaved']),
      '真有改动时必须提示「有未保存的更改」'
    )
  })

  await check('C16 人设卡片按宿主协议渲染：★ 生效标记、内置徽标、卡片堆叠与翻页', async () => {
    // 这条补的是一个**覆盖空洞**：此前桩返回 `{ personas: [], activePersona: null }`
    // （字段名与类型都与宿主不符），于是人设行渲染与 ★ 标记从未被执行过 —— 把桩改成
    // 真实形状后，整套 C 系列仍全绿（实测），说明没有任何断言吃过这份数据。
    // 宿主真实协议：personas 是由 mergePersonas 生成的**对象 map**（恒含 7 个内置），
    // activeName 是「与当前配置匹配」的预设名（client:1235 读的就是它）。
    const world = await boot({}, {
      ok: true,
      personas: {
        苏格拉底式提问者: { style: 'professional', builtin: true },
        我的自建: { style: 'roast', emoji: 'more' }
      },
      activeName: '我的自建'
    })
    const closed = await renderSettings(world)
    const triggers = findAll(closed, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))
    assert.equal(triggers.length, 1, '应有一个「人设预设」分组标题')
    await triggers[0].props.onClick()
    const tree = await renderSettings(world)

    // ① activeName → store.activePersona 这条链路必须真的通（字段名写错就全灭）
    assert.equal(
      world.controller.store.getSnapshot().activePersona,
      '我的自建',
      'activeName 未被写进 store.activePersona —— 字段名与宿主协议不符'
    )

    // ② 卡片堆叠一次只渲染限定张数（当前 + 左右各一），当前张带 data-current="true"
    const cards = findAllByClass(tree, 'soul-persona-card')
    assert.equal(cards.length, 2, `两个预设应渲染 2 张卡片（左右无更多），实际 ${cards.length}`)
    const current = cards.filter((c) => c.props['data-current'] === 'true')
    assert.equal(current.length, 1, `应恰好一张当前卡片，实际 ${current.length}`)

    const cardText = cards.map(textOf)
    const activeCard = cardText.find((t2) => t2.includes('我的自建'))
    const idleCard = cardText.find((t2) => t2.includes('苏格拉底式提问者'))
    assert.ok(activeCard, `未渲染「我的自建」卡片：${cardText.join(' | ')}`)
    assert.ok(idleCard, `未渲染「苏格拉底式提问者」卡片：${cardText.join(' | ')}`)

    // ③ 生效预设带 ★，非生效的不带（防空过：两个方向都要断言，否则「恒加★」也会过）
    assert.ok(activeCard.includes('★'), `生效预设应带 ★：${activeCard}`)
    assert.ok(!idleCard.includes('★'), `非生效预设不应带 ★：${idleCard}`)

    // ④ 内置卡片带「内置」标记、且不渲染删除按钮；自建卡片相反
    assert.ok(idleCard.includes(world.dicts.zh['personas.builtin']), `内置卡片应带「内置」标记：${idleCard}`)
    assert.ok(!activeCard.includes(world.dicts.zh['personas.builtin']), `自建卡片不应带「内置」标记：${activeCard}`)
    const deleteButtons = findAll(tree, (n) => n.type === 'button' && textOf(n) === world.dicts.zh['personas.delete'])
    assert.equal(deleteButtons.length, 1, `只应有一个删除按钮（内置卡片不得有），实际 ${deleteButtons.length}`)

    // ⑤ 轮播交互：位置指示、圆点、翻页按钮与边界禁用（一次只见一张，这些是必需的补偿）
    //
    // 注意：**展开分组时轮播会自动定位到当前生效的那张**（新功能），因此这里一进来
    // 就已经停在「我的自建」（数组第 2 项 ⇒ 索引 1），而不是首张。位置指示应为 2 / 2。
    const nav = findAllByClass(tree, 'soul-persona-navbtn')
    assert.equal(nav.length, 2, `应有前后两个翻页按钮，实际 ${nav.length}`)
    const pos0 = findAllByClass(tree, 'soul-persona-card-pos')
    assert.equal(pos0.length, 1, `当前卡片应显示位置指示（i / n），实际 ${pos0.length}`)
    const [prev, next] = nav
    assert.equal(textOf(pos0[0]), '2 / 2', `展开后应定位到生效项（末张），位置指示应为「2 / 2」，实际「${textOf(pos0[0])}」`)
    assert.equal(prev.props.disabled, false, '已定位到末张时「上一张」应可用')
    assert.equal(next.props.disabled, true, '已定位到末张时「下一张」应禁用')
    const dots = findAllByClass(tree, 'soul-persona-dot')
    assert.equal(dots.length, 2, `圆点数量应等于预设数，实际 ${dots.length}`)
    assert.equal(dots.filter((d) => d.props['data-active'] === 'true').length, 1, '应恰好一个圆点为激活态')
    // 激活的圆点必须是生效项那个索引（1），而不是恒为第 0 个
    assert.equal(dots[1].props['data-active'], 'true', '激活圆点应落在生效项（索引 1）上')
    assert.equal(dots[0].props['data-active'], 'false', '非生效项的圆点不应是激活态')

    // ⑥ 点「上一张」→ 索引前移，位置指示与当前卡片内容同步变化
    const posBefore = textOf(findAllByClass(tree, 'soul-persona-card-pos')[0])
    const textBefore = textOf(current[0])
    await prev.props.onClick()
    const tree2 = await renderSettings(world)
    const cur2 = findAllByClass(tree2, 'soul-persona-card').filter((c) => c.props['data-current'] === 'true')
    assert.equal(cur2.length, 1, '翻页后仍应恰好一张当前卡片')
    const posAfter = textOf(findAllByClass(tree2, 'soul-persona-card-pos')[0])
    assert.notEqual(posAfter, posBefore, `位置指示应随翻页变化（翻页前后都是「${posAfter}」）`)
    assert.notEqual(textOf(cur2[0]), textBefore, '当前卡片内容应随翻页变化')
    // 位置指示与当前卡片必须是同一个预设（防止「指示变了但卡片没换」）。
    // 不硬编码名字与序号的对应关系 —— 顺序由 store 决定，从「翻页前那张」推导即可：
    // 翻页后指示从 i/2 变成 j/2，卡片内容必须是**另一张**，且两张合起来正好是两个预设。
    const allNames = ['我的自建', '苏格拉底式提问者']
    const shown = [textBefore, textOf(cur2[0])]
    for (const n of allNames) {
      assert.equal(
        shown.filter((t2) => t2.includes(n)).length,
        1,
        `「${n}」应在翻页前后各出现恰好一次，实际出现在：${shown.map((s) => s.slice(0, 26)).join(' | ')}`
      )
    }
    // 翻到首张后「上一张」应禁用（边界）
    const nav2 = findAllByClass(tree2, 'soul-persona-navbtn')
    assert.equal(nav2[0].props.disabled, true, '翻到首张后「上一张」应禁用')
  })

  await check('C19 应用预设后表单必须跟随 store，保存按钮不得误亮', async () => {
    // 用户实测：点「使用」显示正常，但「保存设置」亮起；一点保存，刚应用的预设
    // 被本地旧表单整体覆盖回旧配置（activeName 变回默认）。
    //
    // 根因：回填 effect 原是「dirty || saving 就整体不回填」。应用预设后 store 先变、
    // 本地表单还是旧值 ⇒ 那一次渲染 dirty 恒为 true ⇒ 回填被挡 ⇒ 表单停在旧值 ⇒
    // 「保存」把旧值整体 POST 上去覆盖预设。
    //
    // 修法：按字段判断（本地值 == 上次同步快照 ⇒ 用户没动过 ⇒ 回填）。
    // 本断言验证行为：应用预设后（未手改任何字段）dirty 必须为 false。
    const world = await boot({}, {
      ok: true,
      personas: {
        苏格拉底式提问者: { style: 'professional', builtin: true },
        资深架构师: { style: 'professional', headingLists: 'more', tables: 'more', replyLength: 'detailed', builtin: true }
      },
      activeName: '苏格拉底式提问者'
    })
    // 找到「使用」按钮所在卡（资深架构师）并应用它 —— 用卡片按钮而不是直接调 controller，
    // 这样测的是用户真实路径（handleUsePersona → store → 回填 effect）。
    // 注意：「人设预设」分组默认折叠，必须先展开（与 C16 同样的前置）。
    //
    // boot 默认桩没有 /personas/use 路由（点了会 404、被 catch 吞掉、store 不变），
    // 那样本断言会得到「保存按钮不亮」的**假阳性** —— 所以这里覆盖该路由，
    // 让它返回真实的「应用预设后的完整配置」（宿主行为：usePersona 会改活动配置）。
    // 同时 GET /config 也必须跟随 —— 否则 2s 轮询会把 store 打回旧值；
    // 真实宿主的 GET /config 本来就返回当前配置，测试桩此前没有模拟这一点。
    let appliedPersona = false
    const appliedConfig = () => ({ ...CONFIG, headingLists: 'more', tables: 'more', replyLength: 'detailed' })
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: appliedPersona ? appliedConfig() : { ...CONFIG }, configError: null, deliveryWarning: null }
      : { ok: true, config: { ...CONFIG }, changed: [] })
    world.routes['/api/soul/personas/use'] = () => {
      appliedPersona = true
      return { ok: true, config: appliedConfig(), changed: ['headingLists', 'tables', 'replyLength'], invalid: [] }
    }
    const tree0 = await renderSettings(world)
    const trigger0 = findAll(tree0, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))
    await trigger0[0].props.onClick()
    const treeOpen = await renderSettings(world)
    const useBtns = findAll(treeOpen, (n) => n.type === 'button' && textOf(n) === world.dicts.zh['personas.use'])
    assert.ok(useBtns.length >= 1, '应存在「使用」按钮（前置条件）')
    // 资深架构师与苏格拉底式提问者的 style 相同但 headingLists/tables/replyLength 不同，
    // 应用后 store 的这些字段必然变化 —— 足以检验回填。
    // 点按钮是 fire-and-forget（handleUsePersona 内部 await），必须排空微任务，
    // store 才会被 usePersona 的响应写入（排空后还要再排空一次：写入触发的渲染链）。
    await useBtns[useBtns.length - 1].props.onClick()
    for (let i = 0; i < 10; i++) await new Promise((r) => drainTick(r))
    const tree1 = await renderSettings(world)
    // ① 保存按钮必须**不亮**（disabled）—— 用户什么都没改
    const saveBtn = findAll(tree1, (n) => n.type === 'ui-button' && textOf(n) === world.dicts.zh['button.save'])
    assert.equal(saveBtn.length, 1, `应恰好一个「保存设置」按钮，实际 ${saveBtn.length}`)
    assert.equal(
      saveBtn[0].props.disabled,
      true,
      '应用预设后（未手改字段）「保存设置」应禁用 —— 亮起说明表单没跟上 store（本 bug 的第一症状）'
    )
    // ② store 与「已保存配置」一致（usePersona 已写回）
    const snap = world.controller.store.getSnapshot()
    assert.equal(snap.headingLists, 'more', '应用后 store.headingLists 应为预设值 more')
    assert.equal(snap.replyLength, 'detailed', '应用后 store.replyLength 应为预设值 detailed')
    // ③ 关键回归点：本地表单必须与 store 一致（dirty 的两侧相等）
    //    通过「不再有未保存提示」与保存按钮禁用间接验证（树里没有 dirty 标记）
    const dirtyHint = findAll(tree1, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-dirty'))
    assert.equal(dirtyHint.length, 0, '不应出现「未保存的更改」提示')
    // ④ 编辑某字段后 dirty 仍应正常亮起（确认按字段判断没有把保护一并去掉）。
    //    折叠分组是**互斥**的（toggleSection 会关掉人设分组），先切回「特质」分组。
    const triggerTraits = findAll(tree1, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.traits']))
    assert.ok(triggerTraits.length > 0, '应存在「特质」分组标题（前置条件）')
    await triggerTraits[0].props.onClick()
    const treeTraits = await renderSettings(world)
    const styleSelects = findAll(treeTraits, (n) => n.type === 'select')
    assert.ok(styleSelects.length > 0, '应存在风格下拉框（前置条件）')
    await styleSelects[0].props.onChange({ target: { value: 'roast' } })
    const tree2 = await renderSettings(world)
    const saveBtn2 = findAll(tree2, (n) => n.type === 'ui-button' && textOf(n) === world.dicts.zh['button.save'])
    assert.equal(
      saveBtn2[0].props.disabled,
      false,
      '手动改动字段后「保存设置」应恢复可用（按字段保护不能连编辑检测一起丢掉）'
    )
    // ⑤ 按字段保护的**另一半**：用户正在编辑的字段，不能被外部写入（loadConfig 的
    //    applyConfig，等价于 2s 轮询干的事）覆盖。若去掉按字段判断（无条件跟随
    //    store），这里会失败 —— C19 前半段只测「跟随」，测不出这个方向的回归
    //    （判断力验证实测 ②③ 漏网）。
    //    注意：不要指望 fake timer 的轮询自己跑 —— settle 不推进 timerQueue，
    //    直接调 loadConfig 才是确定性的等价写入。
    await styleSelects[0].props.onChange({ target: { value: 'casual' } })   // 用户正在编辑 style
    // 外部写入（轮询的等价物）必须真的改变 store —— effect 的依赖是 store 值，
    // 若 loadConfig 返回与 store 相同的值，effect 根本不跑，变异（无条件跟随）
    // 就探测不到差异（判断力验证实测 ②③ 漏网的原因）。这里模拟「别处把风格
    // 改成了 humorous」：store 即将变为 humorous，而用户手里还捏着 casual。
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG, style: 'humorous' }, configError: null, deliveryWarning: null }
      : { ok: true, config: { ...CONFIG }, changed: [] })
    await world.controller.loadConfig()
    // 渲染两轮：effect 按字段判断后的 setState 要到下一轮渲染才反映到树里
    // （测试台的 set 只标记 dirty，下一帧 render() 才提交；单帧树读到的是旧值）
    await renderSettings(world)
    const treePolled = await renderSettings(world)
    const polledSelects = findAll(treePolled, (n) => n.type === 'select')
    assert.ok(polledSelects.length > 0, '轮询后仍应有风格下拉框（前置条件）')
    assert.equal(
      polledSelects[0].props.value,
      'casual',
      '用户正在编辑的字段不得被外部写入覆盖（无条件跟随 store 会把它改回 store 值）'
    )
  })

  await check('C22 翻页会复位翻面态：切走再切回不得自动是背面', async () => {
  // 用户实测：翻开 A 卡背面 → 切到 B → 再切回 A，A 仍以背面出现。
  //
  // 根因：flippedName 记住了「哪张卡被翻开过」，而 go() 只改索引、不清它 ⇒
  // 切回来时 current && flippedName === name 又成立，于是「记得」上次的面。
  //
  // 语义：翻面是「看这张卡背面」的**临时阅读动作**，翻页是「换一张看」——
  // 注意力已重置。记住它会让用户以为这张卡「默认就是背面」。
  // 故三处换卡入口都要清：go() / 展开自动定位 / 折叠分组。
  const lib = {
    ok: true,
    personas: {
      苏格拉底式提问者: { style: 'professional', builtin: true, headingLists: 'default', emoji: 'default', tables: 'default', replyLength: 'normal', customInstructions: '' },
      极简主义者: { style: 'efficient', builtin: true, headingLists: 'default', emoji: 'default', tables: 'default', replyLength: 'normal', customInstructions: '' },
      资深架构师: { style: 'professional', builtin: true, headingLists: 'more', emoji: 'default', tables: 'more', replyLength: 'detailed', customInstructions: 'x' }
    },
    activeName: '苏格拉底式提问者'
  }
  const world = await boot({}, lib)
  const closed = await renderSettings(world)
  await findAll(closed, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))[0].props.onClick()
  const tree0 = await renderSettings(world)

  const flippedCount = (tree) => findAllByClass(tree, 'soul-persona-card').filter((c) => c.props['data-flipped'] === 'true').length
  const currentCard = (tree) => findAllByClass(tree, 'soul-persona-card').find((c) => c.props['data-current'] === 'true')

  // ① 翻开当前卡背面
  const front = findAll(currentCard(tree0), (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-front'))
  assert.ok(front[0] && typeof front[0].props.onClick === 'function', '前置条件：当前卡正面应可点翻面')
  await front[0].props.onClick()
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  const tree1 = await renderSettings(world)
  assert.equal(flippedCount(tree1), 1, '前置条件：点整面后应有 1 张处于背面')

  // ② 点侧边卡切到下一张 ⇒ 无卡处于背面
  const side = findAllByClass(tree1, 'soul-persona-card').find((c) => c.props['data-current'] === 'false' && typeof c.props.onClick === 'function')
  assert.ok(side, '前置条件：应存在可点的叠层侧边卡')
  await side.props.onClick()
  for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  const tree2 = await renderSettings(world)
  assert.equal(flippedCount(tree2), 0, '翻页后不应有卡处于背面')

  // ③ 切回原来那张 ⇒ 必须是正面（bug 时这里会是背面）
  const side2 = findAllByClass(tree2, 'soul-persona-card').find((c) => c.props['data-current'] === 'false' && typeof c.props.onClick === 'function')
  await side2.props.onClick()
  for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  const tree3 = await renderSettings(world)
  assert.equal(
    flippedCount(tree3),
    0,
    '切回原来那张时不得记住翻面态（应显示正面；bug 症状：仍以背面出现）'
  )

  // ④ 圆点导航同样要复位（不能只修侧边卡这一条路径）
  await front[0].props.onClick()
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  const dots = findAll(await renderSettings(world), (n) => n.props?.role === 'tab')
  assert.ok(dots.length > 1, '前置条件：应有多个位置圆点')
  await dots[1].props.onClick()
  for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  assert.equal(flippedCount(await renderSettings(world)), 0, '圆点导航换卡也应复位翻面态')

  // ⑤ 折叠 → 重新展开：也不得带出上次的背面
  //
  // ⚠️ 这一场景必须让「自动定位」落回**同一张卡**才有判别力：
  //    自动定位会把 index 设为 activePersona 的位置。若翻的是另一张卡，
  //    重新展开后当前卡已换人 ⇒ flippedName 天然不匹配 ⇒ 即使不清理也显示正面，
  //    测试就成了「永远通过」（初版正因如此漏掉了这个分支 —— 判断力验证发现）。
  //    故用独立 world，让 activeName 就是被翻的那张。
  const w5 = await boot({}, {
    ok: true,
    personas: {
      苏格拉底式提问者: { style: 'professional', builtin: true },
      极简主义者: { style: 'efficient', builtin: true }
    },
    // activeName 取列表第 0 项 ⇒ 展开时自动定位回第 0 张
    activeName: '苏格拉底式提问者'
  })
  const closed5 = await renderSettings(w5)
  await findAll(closed5, (n) => n.type === 'button' && textOf(n).includes(w5.dicts.zh['group.personas']))[0].props.onClick()
  let t5 = await renderSettings(w5)

  // 翻开**第 0 张**（= activeName 指向的那张，自动定位会回到它）
  const card0 = currentCard(t5)
  assert.ok(card0, '前置条件：应有当前卡')
  const front5 = findAll(card0, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-front'))
  await front5[0].props.onClick()
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  t5 = await renderSettings(w5)
  assert.equal(flippedCount(t5), 1, '前置条件：应已翻到背面')

  // 折叠
  await findAll(t5, (n) => n.type === 'button' && textOf(n).includes(w5.dicts.zh['group.personas']))[0].props.onClick()
  for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
  // 重新展开（自动定位会回到第 0 张 = 刚被翻的那张）
  t5 = await renderSettings(w5)
  await findAll(t5, (n) => n.type === 'button' && textOf(n).includes(w5.dicts.zh['group.personas']))[0].props.onClick()
  for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
  assert.equal(
    flippedCount(await renderSettings(w5)),
    0,
    '折叠后重新展开不得记得上次的翻面态（自动定位落回同一张卡时）'
  )
})

await check('C23 全局轮询注册在装配层（底栏不依赖设置页是否挂载）', async () => {
  // 用户实测：用 /soul confirm 确认人设变更后（宿主已写盘，配置文件正确），
  // 底栏「个性化已启用 · 人设名」仍显示旧值。
  //
  // 根因：三条刷新路径（setInterval / focus / visibilitychange）**全部注册在
  // SoulSettings 组件内** —— 设置页没挂载时它们都不存在，底栏读的 store 无人刷新。
  // 底栏是常驻组件，其数据链路不该依赖另一个组件的生命周期。
  //
  // 这里断言三件事：
  //   ① 定时器只在装配层注册（全客户端仅一处 setInterval）
  //   ② 装配层注册了页面级事件监听（focus / visibilitychange）
  //   ③ 设置页不再自己起定时器，只同步「暂停标记」
  const world = await boot()
  // ① 装配期即已注册（boot 会执行 ctx.effect）
  const intervals = timerQueue.filter((t) => t.repeat === true)
  assert.ok(intervals.length >= 1, '装配层应注册轮询定时器（interval）')

  // ② 事件监听挂在 window/document 上（而非仅在设置页组件内）
  //    测试台的 window/document stub 记录了 addEventListener 调用
  assert.ok(
    world.captured.events.window.includes('focus'),
    '装配层应监听 window focus（切回窗口立即刷新，不必等下一个轮询周期）'
  )
  assert.ok(
    world.captured.events.document.includes('visibilitychange'),
    '装配层应监听 document visibilitychange'
  )

  // ③ 设置页只同步暂停标记：不打开它时轮询照常，打开且编辑时暂停
  const before = world.controller.paused
  assert.equal(before, false, '初始不应处于暂停态')
  const tree = await renderSettings(world)
  // 渲染设置页后（无改动）仍不应暂停
  assert.equal(world.controller.paused, false, '无未保存编辑时不应暂停轮询')

  // ④ 暂停语义：置位后 canRefresh 应为 false（编辑中不被远端覆盖）
  world.controller.paused = true
  assert.equal(world.controller.canRefresh(), false, 'paused 时不应允许刷新')
  world.controller.paused = false
  assert.equal(world.controller.canRefresh(), true, '复位后应恢复刷新')

  // ⑤ 卸载复位：设置页卸载时必须把 paused 复原，否则**底栏永久停摆** ——
  //    这正是本次 bug 的镜像形态（一个组件的生命周期管住了常驻组件的刷新）。
  //    这条是判断力验证补出来的：变异「卸载时不复位 paused」首轮漏网，
  //    同时暴露了测试台缺口（垫片原先只在依赖变化时跑清理，卸载时从不执行）。
  const w2 = await boot()
  await renderSettings(w2)
  w2.controller.paused = true      // 模拟「编辑中被卸载」这一最坏情形
  w2.runtime.unmount()
  assert.equal(
    w2.controller.paused,
    false,
    '设置页卸载后必须复位 paused（否则外部轮询永久停摆，底栏不再刷新）'
  )
})

await check('C21 底栏展示当前人设，未匹配时显示「自定义」', async () => {
  // 需求：底栏「个性化已启用」后必须回答「现在用的是哪套人设」。
  // 此前只有匹配到预设才缀名字，手改过特质后留空 —— 等于没回答。
  // 现在：匹配到预设显示预设名，否则显示「自定义」。
  const personaLib = (activeName) => ({
    ok: true,
    personas: {
      苏格拉底式提问者: {
        style: 'professional', builtin: true, headingLists: 'default', emoji: 'default',
        tables: 'default', replyLength: 'normal', customInstructions: ''
      },
      极简主义者: { style: 'efficient', builtin: true }
    },
    activeName
  })

  // ① 匹配到预设 ⇒ 缀预设名
  const w1 = await boot({}, personaLib('苏格拉底式提问者'))
  // 人设列表由**设置页组件挂载后的 refresh** 拉取（apply 阶段只拉 config）。
  // 快捷开关单独渲染不会触发它 —— 先渲染一次设置页把人设灌进 store，
  // 否则下面读到的 activePersona 恒为 null（此前踩过：断言读到「自定义」）。
  await renderSettings(w1)
  const btn1 = await w1.runtime.settle(quickToggleElement(w1))
  const name1 = findAll(btn1, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-quick-toggle-name'))
  assert.equal(name1.length, 1, `启用时应有一个人设名节点，实际 ${name1.length}`)
  assert.ok(
    textOf(name1[0]).includes('苏格拉底式提问者'),
    `匹配到预设时应显示预设名，实际：「${textOf(name1[0])}」`
  )

  // ② 未匹配（手改过特质）⇒ 显示「自定义」，不能留空
  const w2 = await boot({}, personaLib(null))
  await renderSettings(w2)
  const btn2 = await w2.runtime.settle(quickToggleElement(w2))
  const name2 = findAll(btn2, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-quick-toggle-name'))
  assert.equal(name2.length, 1, '未匹配时也应有人设名节点（回退为「自定义」）')
  assert.ok(
    textOf(name2[0]).includes(w2.dicts.zh['quick.custom']),
    `未匹配时应显示「${w2.dicts.zh['quick.custom']}」，实际：「${textOf(name2[0])}」`
  )

  // ③ 关闭个性化 ⇒ 整块人设名不显示（此刻人设不生效，挂名字会误导）
  const w3 = await boot({}, personaLib('苏格拉底式提问者'))
  // 关闭个性化：必须让 GET 与 POST 都返回 enabled:false —— boot 的 configPayload
  // 只展开进 GET 的响应，POST 分支仍是 {...CONFIG}（enabled:true），
  // 直接 boot({enabled:false}) 会被后续 refresh 覆盖回 true（此前踩过）。
  const disabledConfig = { ...CONFIG, enabled: false }
  w3.routes['/api/soul/config'] = (call) => (call.method === 'GET'
    ? { ok: true, config: { ...disabledConfig }, configError: null, deliveryWarning: null }
    : { ok: true, config: { ...disabledConfig }, changed: [] })
  await renderSettings(w3)
  w3.controller.store.update((s) => { s.enabled = false })
  const btn3 = await w3.runtime.settle(quickToggleElement(w3))
  const name3 = findAll(btn3, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-quick-toggle-name'))
  assert.equal(name3.length, 0, '关闭个性化时不应显示人设名')
})

await check('C20 点叠层侧边卡只翻页、不翻面（整面点击必须限定当前卡）', async () => {
    // 用户实测 bug：点侧边卡切换下一个人设后，新当前卡直接以【背面】出现。
    // 根因：整面翻面的 onClick 挂在了【所有卡】的正面 face 上 —— 点侧边卡时，
    // 事件先冒泡到它的 face onClick（setFlippedName(侧边卡名)），再冒泡到卡片的
    // go() 翻页 ⇒ 翻页后它成了当前卡 ⇒ flippedName === 它 ⇒ 一上来就是背面。
    // 修法：face 的 onClick 限定 current；cursor:pointer 同理只给当前卡。
    const world = await boot({}, {
      ok: true,
      personas: {
        苏格拉底式提问者: { style: 'professional', builtin: true },
        极简主义者: { style: 'efficient', builtin: true },
        资深架构师: { style: 'professional', headingLists: 'more', builtin: true }
      },
      activeName: null
    })
    const closed = await renderSettings(world)
    const trigger = findAll(closed, (n) => n.type === 'button' && textOf(n).includes(world.dicts.zh['group.personas']))
    await trigger[0].props.onClick()
    const tree = await renderSettings(world)

    // ① 叠层侧边卡的正面 face 不得挂 onClick（否则点击会先翻面再翻页）
    const side = findAllByClass(tree, 'soul-persona-card')
      .find((c) => c.props['data-current'] === 'false' && typeof c.props.onClick === 'function')
    assert.ok(side, '前置条件：应存在可点的叠层侧边卡')
    const sideFront = findAll(side, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-front'))
    assert.equal(
      Boolean(sideFront[0] && sideFront[0].props.onClick),
      false,
      '叠层侧边卡的正面不得挂翻面 onClick（会与翻页冲突，导致新当前卡以背面出现）'
    )
    // ② 点它 ⇒ 只翻页
    await side.props.onClick()
    for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
    const after = await renderSettings(world)
    const cur = findAllByClass(after, 'soul-persona-card').filter((c) => c.props['data-current'] === 'true')
    assert.equal(cur.length, 1, '翻页后应恰好一张当前卡')
    assert.equal(cur[0].props['data-flipped'], 'false', '翻页后新当前卡必须是正面（bug 症状：直接背面）')
    // ③ 当前卡的正面仍必须可点翻面（修复不能把功能一并去掉）
    const curFront = findAll(cur[0], (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-front'))
    assert.ok(curFront[0] && typeof curFront[0].props.onClick === 'function', '当前卡正面应保留整面点击翻面')
    // ④ 翻到背面后，正面的整面点击必须撤掉（否则背面点击会再次触发翻面回调）
    await curFront[0].props.onClick()   // 翻到背面
    for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
    const flippedTree = await renderSettings(world)
    const flippedCard = findAllByClass(flippedTree, 'soul-persona-card').find((c) => c.props['data-flipped'] === 'true')
    assert.ok(flippedCard, '前置条件：应有一张卡处于背面')
    const flippedFront = findAll(flippedCard, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-front'))
    assert.equal(
      Boolean(flippedFront[0] && flippedFront[0].props.onClick),
      false,
      '背面状态下正面不得再挂整面点击（否则会重复触发翻面）'
    )
    // ⑤ 卡背整面点击=返回正面（与正面「整面点击翻到背面」对称）
    const backFace = findAll(flippedCard, (n) => typeof n.props?.className === 'string' && String(n.props.className).includes('soul-persona-face-back'))
    assert.ok(backFace[0] && typeof backFace[0].props.onClick === 'function', '卡背应整面可点返回')
    // ⑥ 但拖选文字时不得返回：模拟一个非折叠选区
    const realGetSelection = globalThis.getSelection
    try {
      globalThis.getSelection = () => ({ isCollapsed: false, toString: () => '选中的指令文本' })
      backFace[0].props.onClick()
      for (let i = 0; i < 4; i++) await new Promise((r) => drainTick(r))
      const stillFlipped = findAllByClass(await renderSettings(world), 'soul-persona-card').filter((c) => c.props['data-flipped'] === 'true')
      assert.equal(stillFlipped.length, 1, '拖选文字时不得翻回正面（否则一选就跳走）')
      // ⑦ 无选区时点击 ⇒ 正常返回
      globalThis.getSelection = () => ({ isCollapsed: true, toString: () => '' })
      backFace[0].props.onClick()
      for (let i = 0; i < 4; i++) await new Promise((r) => drainTick(r))
      const afterBack = findAllByClass(await renderSettings(world), 'soul-persona-card').filter((c) => c.props['data-flipped'] === 'true')
      assert.equal(afterBack.length, 0, '无选区时点卡背应返回正面')
    } finally {
      if (realGetSelection === undefined) delete globalThis.getSelection
      else globalThis.getSelection = realGetSelection
    }
  })

  await check('C18 展开「人设预设」时自动定位到当前生效的那张（而不是永远第 1 张）', async () => {
    // 需求背景：卡片一次只展示一张，内置项排在前面，生效项（尤其是自建）往往在后面。
    // 若固定从第 1 张开始，用户点开分组后要翻好几下才能看到自己在用哪个。
    //
    // 这里用**行为**验证（不看源码）：生效项排在第 2 位 ⇒ 展开后应直接停在 2 / 2。
    const personaLib = {
      ok: true,
      personas: {
        苏格拉底式提问者: { style: 'professional', builtin: true },
        我的自建: { style: 'roast', emoji: 'more' }
      },
      activeName: '我的自建'   // ← 生效项是第 2 个（内置排前面）
    }
    const open = async (w) => {
      const closed = await renderSettings(w)
      const trigger = findAll(closed, (n) => n.type === 'button' && textOf(n).includes(w.dicts.zh['group.personas']))
      await trigger[0].props.onClick()
      return renderSettings(w)
    }
    // ① 展开即定位到生效项
    const w1 = await boot({}, personaLib)
    const t1 = await open(w1)
    assert.equal(
      textOf(findAllByClass(t1, 'soul-persona-card-pos')[0]),
      '2 / 2',
      '展开后应定位到生效项（第 2 张），而不是停在首张'
    )
    // ② 定位的是**生效项本身**，不是碰巧的末张 —— 换个生效项再验一次
    const w2 = await boot({}, {
      ok: true,
      personas: personaLib.personas,
      activeName: '苏格拉底式提问者'   // ← 生效项改成第 1 个
    })
    const t2 = await open(w2)
    assert.equal(
      textOf(findAllByClass(t2, 'soul-persona-card-pos')[0]),
      '1 / 2',
      '生效项换到第 1 个时应定位到 1 / 2（证明是按生效项定位，而不是恒取末张）'
    )
    // ③ 无生效项（都不匹配）时退回首张 —— 总要给个确定落点
    const w3 = await boot({}, { ok: true, personas: personaLib.personas, activeName: null })
    const t3 = await open(w3)
    assert.equal(
      textOf(findAllByClass(t3, 'soul-persona-card-pos')[0]),
      '1 / 2',
      '没有生效项时应退回第 1 张'
    )
    // ④ 手动翻页后**不能被轮询拽回** —— 展开期间刷新 personas 不应重置位置
    //    （实现上用 autoPositionedRef 记住「本次展开已定位过」）
    const moved = await (async () => {
      const nav = findAllByClass(t1, 'soul-persona-navbtn')
      await nav[0].props.onClick()   // 生效项在末张 ⇒ 点「上一张」翻到首张
      return renderSettings(w1)
    })()
    assert.equal(
      textOf(findAllByClass(moved, 'soul-persona-card-pos')[0]),
      '1 / 2',
      '手动翻页后应停在 1 / 2'
    )
    // 触发一次「轮询刷新 personas」（内容不变）后位置必须还在 1 / 2
    await w1.controller.fetchPersonas?.()
    for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
    const afterRefresh = await renderSettings(w1)
    assert.equal(
      textOf(findAllByClass(afterRefresh, 'soul-persona-card-pos')[0]),
      '1 / 2',
      '展开期间轮询刷新不应把手动翻到的位置拽回生效项'
    )
    // ⑤ 折叠再展开 ⇒ 重新定位回生效项（需求原文：「每次点击开」都要展示当前使用的）
    const collapsed = await renderSettings(w1)
    const trigger2 = findAll(collapsed, (n) => n.type === 'button' && textOf(n).includes(w1.dicts.zh['group.personas']))
    await trigger2[0].props.onClick()   // 折叠
    await renderSettings(w1)
    const reopened = await open(w1)
    assert.equal(
      textOf(findAllByClass(reopened, 'soul-persona-card-pos')[0]),
      '2 / 2',
      '折叠后再次展开应重新定位到生效项'
    )
    // ⑥ **展开时数据尚未就绪**（personas 仍是 null）不得抛错 —— 等数据到了再定位。
    //    这条专防「去掉空值守卫」：无守卫时 personaNames 为 null，
    //    `null.indexOf(...)` 会抛 TypeError，直接把设置页渲染打断。
    //    桩用一个**永不 resolve** 的 promise 把 personas 钉在「加载中」。
    const w4 = loadClient({
      '/api/soul/config': (call) => (call.method === 'GET' ? { ok: true, config: { ...CONFIG } } : { ok: true, config: { ...CONFIG }, changed: [] }),
      '/api/soul/config/reset': () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null }),
      '/api/soul/personas': () => new Promise(() => {}),
      '/api/soul/prompt': () => ({ ok: true, prompt: 'P', enabled: true })
    })
    for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
    assert.equal(
      w4.controller.store.getSnapshot().personas,
      null,
      '前置条件：personas 应停在加载中（null）'
    )
    const closed4 = await renderSettings(w4)
    const trigger4 = findAll(closed4, (n) => n.type === 'button' && textOf(n).includes(w4.dicts.zh['group.personas']))
    await trigger4[0].props.onClick()
    const loadingTree = await renderSettings(w4)   // 不应抛错
    assert.ok(loadingTree, '展开时数据未就绪不应导致渲染失败')
    assert.equal(
      findAllByClass(loadingTree, 'soul-persona-card-pos').length,
      0,
      '数据未就绪时不应出现位置指示（此时还没有任何卡片）'
    )
    // ⑦ 更刁的组合：**personas 加载中（null）但 activePersona 已有值**。
    //    真实场景：先应用过某个预设（配置与它匹配），随后刷新页面 —— 配置先到、
    //    预设列表还在路上。此时若去掉 `!personaNames` 守卫，
    //    `personaNames.indexOf(...)` 会对 null 调用而抛 TypeError，直接打断设置页渲染。
    //    （上面 ⑥ 的桩里 activePersona 为 null，走的是 `: -1` 分支，覆盖不到这一条。）
    const w5 = loadClient({
      // 配置与桩里那个预签名一致 ⇒ 宿主会回报 activeName
      '/api/soul/config': (call) => (call.method === 'GET' ? { ok: true, config: { ...CONFIG } } : { ok: true, config: { ...CONFIG }, changed: [] }),
      '/api/soul/config/reset': () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null }),
      '/api/soul/personas': () => new Promise(() => {}),
      '/api/soul/prompt': () => ({ ok: true, prompt: 'P', enabled: true })
    })
    for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
    // 直接往 store 里塞一个非空 activePersona，复刻「配置先到、预设列表未到」
    w5.controller.store.update((s) => { s.activePersona = '苏格拉底式提问者' })
    for (let i = 0; i < 4; i++) await new Promise((r) => drainTick(r))
    const closed5 = await renderSettings(w5)
    const trigger5 = findAll(closed5, (n) => n.type === 'button' && textOf(n).includes(w5.dicts.zh['group.personas']))
    await trigger5[0].props.onClick()
    const tree5 = await renderSettings(w5)   // ← 去掉守卫时这里会抛 TypeError
    assert.ok(tree5, '预设列表加载中但已有生效人设时，展开分组不应抛错')
    assert.equal(
      findAllByClass(tree5, 'soul-persona-card-pos').length,
      0,
      '预设列表未就绪时不应出现位置指示'
    )
  })

  await check('C17 应用预设成功后清掉上一轮的失败提示', async () => {
    // 该端点不返回 deliveryWarning；此前不清 error ⇒ 上一轮保存失败过的红色提示
    // 会一直挂在设置页上，即使随后切预设成功。
    const world = await boot()
    world.routes['/api/soul/config'] = (call) => (call.method === 'GET' ? { ok: true, config: { ...CONFIG } } : false)
    const failed = await world.controller.saveConfig({ style: 'casual' })
    assert.equal(failed, undefined, '前置条件：保存失败应返回 undefined')
    assert.equal(world.controller.store.getSnapshot().error, 'boom', '前置条件：失败原因应写进 store')
    world.routes['/api/soul/personas/use'] = () => ({ ok: true, config: { ...CONFIG }, changed: ['style'], invalid: [] })
    await world.controller.usePersona('任意')
    assert.equal(world.controller.store.getSnapshot().error, null, '应用预设成功后不得残留上一轮的失败提示')
  })

  // ==================== 插件详情页「变更记录」区块（0.8.1 双入口）====================
  //
  // 0.8.1 起变更记录的主入口是宿主插件详情页（plugins.detail.section 槽位），
  // 设置页只留一行指引。渲染组件是 SoulHistorySection，判据是
  // subject.kind === 'bundle' && subject.pkg.name === 'dsh-soul'——
  // 所以这里的渲染语境是「详情页」：挂载即拉取（不再有「展开才拉」），
  // subject 不是 dsh-soul 时必须渲染 null（槽位契约原话）。

  /** 详情页槽位（plugins.detail.section）与它的渲染辅助。 */
  function detailSectionOf(world) {
    const slot = world.captured.sections.find((s) => s.options && s.options.name === 'plugins.detail.section')
    assert.ok(slot, '未注册 plugins.detail.section 槽位')
    assert.equal(slot.options.id, 'soul-detail-history', '详情页区块的 id 必须是 soul-detail-history')
    return slot
  }
  /** 渲染详情页区块。subject 模拟宿主 PackageDetail 的 bundle 形态（packageRef）；
   *  subject 缺省才补默认值 —— 显式传 null 必须原样传入（判据要吃得到）。 */
  async function renderDetail(world, subject) {
    const slot = detailSectionOf(world)
    const props = slot.options.inject()
    const store = props.hooks.soulController
    const useSoulController = (selector) => {
      const [, force] = world.runtime.React.useState(0)
      world.runtime.React.useEffect(() => store.subscribe(() => force((n) => n + 1)), [])
      return selector(store.getSnapshot())
    }
    const pkg = subject === undefined
      ? { kind: 'bundle', pkg: { name: 'dsh-soul', installed: true, enabled: true, rows: [] } }
      : subject
    return world.runtime.settle({
      type: slot.component,
      props: { ...props, useSoulController, t: (key, params) => interpolate((world.dicts?.zh || {})[key] ?? key, params), subject: pkg }
    })
  }
  /** 渲染 + 排空异步（挂载拉取与随后的 setState 都要跑完）。 */
  async function renderDetailSettled(world, subject) {
    await renderDetail(world, subject)
    for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
    return await renderDetail(world, subject)
  }

  /** 造一条服务端形状的变更记录（before/after 只装变化字段，personas 恒三段）。 */
  function historyEntry(over) {
    return {
      v: 1,
      id: 'e-0',
      at: new Date().toISOString(),
      source: 'web',
      action: 'save',
      configHash: 'h',
      before: {},
      after: {},
      personas: { added: [], updated: [], removed: [] },
      ...over
    }
  }
  /** 唯一的成功绿字（`.soul-saved-notice`）的文案。 */
  function savedNoticeOf(tree) {
    const hits = findAllByClass(tree, 'soul-saved-notice')
    assert.equal(hits.length, 1, `期望恰好一条成功提示，实际 ${hits.length} 条`)
    return textOf(hits[0])
  }

  await check('C24 变更记录详情页：subject 判据、挂载即拉取、按记录渲染时间/来源/字段', async () => {
    const entries = [
      historyEntry({
        id: 'aaa-1',
        at: new Date(Date.now() - 90 * 1000).toISOString(),
        before: { bio: '旧介绍', style: 'professional' },
        after: { bio: '', style: 'humorous' }
      }),
      historyEntry({
        id: 'bbb-2',
        at: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        source: 'command',
        action: 'set',
        personas: { added: ['头脑风暴伙伴'], updated: [], removed: [{ name: '极简主义者', entry: { style: 'efficient' } }] }
      }),
      // 刻意给一条「未来」的记录：服务端时钟略快或本机时钟回拨时真的会出现。
      // 时间差算出来是负数，显示「-1 分钟前」会让人以为记录坏了。
      historyEntry({
        id: 'ccc-3',
        at: new Date(Date.now() + 30 * 1000).toISOString(),
        source: 'persona',
        action: 'use',
        label: '苏格拉底式提问者',
        before: { style: 'professional' },
        after: { style: 'casual' }
      })
    ]
    const world = await boot()
    const calls = []
    world.routes['/api/soul/history'] = (call) => {
      calls.push(call)
      // 上限刻意不取 200：写死数字的实现在这条断言下会立刻露馅。
      // （「最多保留 200 条」是一句会被人当真的承诺，客户端只能转述服务端说的话。）
      return { ok: true, entries, max: 50, warning: null }
    }
    const zh = world.dicts.zh

    // ① subject 判据：别的插件详情页 / 非 bundle 形态必须渲染 null（槽位契约）
    for (const bad of [
      null,
      { kind: 'item', pkg: { name: 'dsh-soul' } },
      { kind: 'row', pkg: { name: 'dsh-soul' } },
      { kind: 'bundle', pkg: { name: 'dsh-other-plugin' } }
    ]) {
      const tree = await renderDetail(world, bad)
      assert.equal(findAllByClass(tree, 'soul-detail-history').length, 0,
        `subject=${JSON.stringify(bad)} 不得渲染变更记录区块`)
    }
    assert.equal(calls.length, 0, '未渲染自己详情页时不得请求 /api/soul/history')

    // ② 挂载 ⇒ 立即以 GET 拉取（详情页本来就是「专门来看记录」才打开的页面）
    const tree = await renderDetailSettled(world)
    assert.equal(calls.length, 1, '挂载详情页区块应恰好拉取一次')
    assert.equal(calls[0].method, 'GET', '拉取变更记录必须用 GET')
    assert.equal(calls[0].path, '/api/soul/history', '拉取路径必须是 /api/soul/history')

    // ③ 顶部计数：上限由服务端带回，客户端不写死
    assert.equal(textOf(findAllByClass(tree, 'soul-detail-history-count')[0]),
      zh['history.summary'].replace('{count}', '3').replace('{max}', '50'),
      '计数行必须用服务端带回的条数与条数上限')

    // ④ 每条行摘要：相对时间 · 来源 · 涉及字段（字段名复用设置页既有文案）
    const items = findAllByClass(tree, 'soul-history-item')
    assert.equal(items.length, 3, `应渲染 3 条记录，实际 ${items.length}`)
    assert.equal(textOf(findAllByClass(items[0], 'soul-history-time')[0]), '1 分钟前')
    assert.equal(textOf(findAllByClass(items[0], 'soul-history-source')[0]), zh['history.source.web'])
    assert.equal(textOf(findAllByClass(items[0], 'soul-history-fields')[0]),
      zh['history.fields'].replace('{fields}', `${zh['field.bio']}、${zh['field.style']}`))
    assert.equal(items[0].props['data-source'], 'web', '行上带来源标识，供按来源取样式')
    assert.equal(textOf(findAllByClass(items[1], 'soul-history-time')[0]), '3 小时前')
    assert.equal(textOf(findAllByClass(items[1], 'soul-history-fields')[0]),
      zh['history.fields'].replace('{fields}',
        `${zh['history.personasAdded'].replace('{names}', '头脑风暴伙伴')}、${zh['history.personasRemoved'].replace('{names}', '极简主义者')}`),
      '只有预设事件的记录也得有一句「涉及 …」，否则末尾悬着一个空壳')
    assert.equal(textOf(findAllByClass(items[2], 'soul-history-time')[0]), zh['history.timeJustNow'],
      '时间差为负（时钟回拨/服务端稍快）必须归入「刚刚」，不能显示「-1 分钟前」')
    // ④b label（预设名）必须出现在折叠摘要里 —— 不然「应用预设 · 风格」答不了「应用的是什么」；
    // 且拼在字段列表**之前**（先说什么预设，再说动了哪些字段，阅读顺序和提问顺序一致）。
    assert.equal(textOf(findAllByClass(items[2], 'soul-history-fields')[0]),
      zh['history.fields'].replace('{fields}',
        `${zh['history.labelSuffix'].replace('{label}', '苏格拉底式提问者')}、${zh['field.style']}`),
      '应用预设的记录必须在摘要里带预设名')

    // ⑤ 拉取失败必须留下痕迹：否则永远停在「加载中」，与「真的没有记录」无从区分
    const bad = await boot()
    bad.routes['/api/soul/history'] = () => false
    const badTree = await renderDetailSettled(bad)
    const badErrors = findAllByClass(badTree, 'soul-error').map(textOf)
    assert.equal(badErrors.length, 1, `拉取失败应在这个区块里显示一条错误，实际 ${badErrors.length} 条`)
    assert.equal(badErrors[0], bad.dicts.zh['history.loadFailed'].replace('{reason}', 'boom'))
    // 计数行也得交代状态：失败时不能还挂着「最近 N 条」装作一切正常
    assert.equal(textOf(findAllByClass(badTree, 'soul-detail-history-count')[0]),
      bad.dicts.zh['accordion.loadFailed'], '失败时计数行必须显示「加载失败」')
  })

  await check('C25 变更记录展开：原值→新值、空值占位、预设事件与恢复入口', async () => {
    const entries = [
      historyEntry({
        id: 'ct-1',
        at: new Date(Date.now() - 30 * 1000).toISOString(),
        // 刻意凑齐五种取值形态：枚举（要查词典）、被清空的文本（要显示「（空）」）、
        // 布尔（要显示「已开启/未开启」而不是 true/false）、**只出现在 before 里的键**
        //（「字段被删掉」的唯一表达方式，只遍历 after 的实现会把它整行漏掉 ——
        // 而漏掉的那一行恰是「谁把我的职业删了」），以及**枚举外的取值**。
        // 最后这种：配置文件被手工改坏时真的会出现（`trailSpeed: 'turbo'`），
        // 必须原样显示 —— 若不加 HISTORY_ENUM_VALUES 白名单就直接查词典，
        // `t('trail.speed.turbo')` 会渲染成裸键名，比显示原始值更难懂。
        before: { bio: '旧介绍', style: 'professional', requireToolConfirmation: false, occupation: '工程师', trailSpeed: 'slow' },
        after: { bio: '', style: 'humorous', requireToolConfirmation: true, trailSpeed: 'turbo' }
      }),
      historyEntry({
        id: 'ct-2',
        at: new Date(Date.now() - 30 * 1000).toISOString(),
        source: 'command',
        action: 'deletePreset',
        personas: { added: [], updated: [], removed: [{ name: '极简主义者', entry: { style: 'efficient' } }] }
      })
    ]
    const world = await boot()
    world.routes['/api/soul/history'] = () => ({ ok: true, entries, max: 200, warning: null })
    const zh = world.dicts.zh
    let tree = await renderDetailSettled(world)

    // ① 默认不收开任何一行：20 条全铺开会比详情页还长
    assert.equal(findAllByClass(tree, 'soul-history-detail').length, 0, '默认不得展开任何一条记录')
    // ② 「恢复此预设」只给删过预设的那条 —— 别的记录点它无事可做
    const restoreButtons = findAllByClass(tree, 'soul-history-action')
      .filter((n) => textOf(n) === zh['history.restorePreset'])
    assert.equal(restoreButtons.length, 1, `「恢复此预设」应只出现在删过预设的记录上，实际 ${restoreButtons.length} 个`)

    // ③ 展开第一条 ⇒ 逐字段「原值 → 新值」
    const mainOf = (index) => {
      const items = findAllByClass(tree, 'soul-history-item')
      const hit = findAllByClass(items[index], 'soul-history-item-main')
      assert.equal(hit.length, 1, '每条记录应恰好一个可展开主体')
      return hit[0]
    }
    await mainOf(0).props.onClick()
    tree = await renderDetail(world)
    const rows = findAllByClass(tree, 'soul-history-diff-row')
    assert.equal(rows.length, 5, `第一条应展开出 5 个字段，实际 ${rows.length}`)
    const rowOf = (label) => {
      const hit = rows.filter((r) => textOf(findAllByClass(r, 'soul-history-diff-field')[0]) === label)
      assert.equal(hit.length, 1, `应恰好一行「${label}」`)
      return hit[0]
    }
    const styleRow = rowOf(zh['field.style'])
    // 「展开即全文」：值放在 .soul-history-diff-value 里，块前有 .soul-history-diff-tag 标「原值/新值」
    const cellOf = (row, side) => {
      const cells = findAllByClass(row, 'soul-history-diff-cell')
      assert.equal(cells.length, side === 'from' ? 2 : 2, `展开行应有两块（原值/新值），实际 ${cells.length}`)
      const index = side === 'from' ? 0 : 1
      assert.equal(textOf(findAllByClass(cells[index], 'soul-history-diff-tag')[0]),
        zh[side === 'from' ? 'history.field.from' : 'history.field.to'],
        `值块前必须有「${side === 'from' ? '原值' : '新值'}」标签 —— 光靠位置分不清哪边是原值`)
      return findAllByClass(cells[index], 'soul-history-diff-value')[0]
    }
    assert.equal(textOf(cellOf(styleRow, 'from')), zh['style.professional'])
    assert.equal(textOf(cellOf(styleRow, 'to')), zh['style.humorous'])
    const bioRow = rowOf(zh['field.bio'])
    assert.equal(textOf(cellOf(bioRow, 'from')), '旧介绍')
    assert.equal(textOf(cellOf(bioRow, 'to')), zh['history.valueEmpty'],
      '被清空的字段必须显示「（空）」而不是留白 —— 留白会被读成渲染坏了')
    // ④ 布尔字段画的是「已开启/未开启」，不是 true/false
    const toolRow = rowOf(zh['field.toolConfirm'])
    assert.equal(textOf(cellOf(toolRow, 'from')), zh['accordion.off'])
    assert.equal(textOf(cellOf(toolRow, 'to')), zh['accordion.on'])
    // ⑤ 只出现在 before 里的键（字段被删掉）也必须占一行，新值那侧显示「（空）」
    const occRow = rowOf(zh['field.occupation'])
    assert.equal(textOf(cellOf(occRow, 'from')), '工程师')
    assert.equal(textOf(cellOf(occRow, 'to')), zh['history.valueEmpty'],
      '只在 before 里出现的字段必须照常占一行 —— 否则「谁把我这一项删了」就永远查不到')
    // ⑦ 枚举外的取值原样显示（查词典前必须先过取值白名单）
    const speedRow = rowOf(zh['trail.speed'])
    assert.equal(textOf(cellOf(speedRow, 'from')), zh['trail.speed.slow'])
    assert.equal(textOf(cellOf(speedRow, 'to')), 'turbo',
      '枚举外的取值必须原样显示 —— 直接查词典会渲染成裸键名 `trail.speed.turbo`')

    // ⑧ 展开第二条：预设事件单独成行，并**取代**第一条的展开（同时只展开一行）
    await mainOf(1).props.onClick()
    tree = await renderDetail(world)
    const personaLines = findAllByClass(tree, 'soul-history-diff-persona').map(textOf)
    assert.ok(personaLines.includes(zh['history.personasRemoved'].replace('{names}', '极简主义者')),
      `应有一行「删除预设 极简主义者」，实际 ${JSON.stringify(personaLines)}`)
    assert.equal(findAllByClass(tree, 'soul-history-diff-row').length, 0,
      '展开第二条时第一条必须收起 —— 同时摊开多行会让区块长度不可控')
    // ⑨ 再点一次收起
    await mainOf(1).props.onClick()
    tree = await renderDetail(world)
    assert.equal(findAllByClass(tree, 'soul-history-detail').length, 0, '点第二次应收起')
  })

  await check('C26 变更记录：撤销与清空都要过内联二次确认（不用原生 confirm）', async () => {
    const entries = [historyEntry({
      id: 'u-1',
      at: new Date().toISOString(),
      before: { style: 'professional' },
      after: { style: 'casual' }
    })]
    const world = await boot()
    const rollbacks = []
    const clears = []
    world.routes['/api/soul/history'] = () => ({ ok: true, entries, max: 200, warning: null })
    world.routes['/api/soul/history/rollback'] = (call) => {
      rollbacks.push(call.body)
      return {
        ok: true,
        config: { ...CONFIG },
        changed: ['style'],
        skipped: [],
        reversed: ['u-1'],
        unchanged: false,
        entry: null,
        deliveryWarning: null
      }
    }
    world.routes['/api/soul/history/clear'] = () => { clears.push(true); return { ok: true, removed: 1 } }
    const zh = world.dicts.zh
    let tree = await renderDetailSettled(world)

    // ① 撤销：第一次点只进入待确认，一个请求都不发
    const undoBtn = () => findAllByClass(tree, 'soul-history-action')[0]
    assert.equal(textOf(undoBtn()), zh['history.restore'])
    await undoBtn().props.onClick()
    tree = await renderDetail(world)
    assert.equal(textOf(undoBtn()), zh['history.restoreArmed'], '第一次点后按钮应变成「撤销？」')
    assert.equal(rollbacks.length, 0, '第一次点「撤销这一次」不得直接发请求')
    // ② 第二次点才真的撤销
    await undoBtn().props.onClick()
    tree = await renderDetailSettled(world)
    assert.equal(rollbacks.length, 1, '第二次点「撤销？」才发请求')
    assert.equal(rollbacks[0].id, 'u-1', '撤销必须带上这一条的 id')
    assert.equal(savedNoticeOf(tree), zh['history.restoreDone'].replace('{count}', '1'))

    // ③ 清空：同样的两步。它是这个区块唯一的危险色按钮（不可逆）
    const clearBtn = () => findAllByClass(tree, 'soul-history-clear')[0]
    assert.equal(textOf(clearBtn()), zh['history.clear'])
    await clearBtn().props.onClick()
    tree = await renderDetail(world)
    assert.equal(textOf(clearBtn()), zh['history.clearArmed'], '第一次点后按钮应变成「确认清空？」')
    assert.equal(clears.length, 0, '第一次点「清空记录」不得直接发请求')
    await clearBtn().props.onClick()
    tree = await renderDetailSettled(world)
    assert.equal(clears.length, 1, '第二次点「确认清空？」才发请求')
    assert.equal(savedNoticeOf(tree), zh['history.clearDone'].replace('{count}', '1'))
  })

  await check('C27 变更记录：超过 20 条折叠可展开，warning 不得被当成失败', async () => {
    const many = Array.from({ length: 22 }, (_, i) => historyEntry({
      id: `m-${String(i).padStart(2, '0')}`,
      at: new Date(Date.now() - (i + 1) * 60 * 1000).toISOString(),
      before: { style: 'professional' },
      after: { style: 'humorous' }
    }))
    const world = await boot()
    world.routes['/api/soul/history'] = () => ({
      ok: true,
      entries: many,
      max: 200,
      warning: '记录文件较大，只读取了最近的部分。'
    })
    const zh = world.dicts.zh
    let tree = await renderDetailSettled(world)

    // ① 一条一条铺开会让这个区块比详情页还长 ⇒ 只渲染 20 条
    assert.equal(findAllByClass(tree, 'soul-history-item').length, 20, '最多只渲染 20 条')
    // ② 剩下的必须有出口：「最多保留 200 条」这句承诺得配一个能看到更多的按钮
    const more = findAllByClass(tree, 'soul-history-more')
    assert.equal(more.length, 1, '超出 20 条时应给出「还有 N 条」')
    assert.equal(textOf(more[0]), zh['history.more'].replace('{count}', '2'))
    await more[0].props.onClick()
    tree = await renderDetail(world)
    assert.equal(findAllByClass(tree, 'soul-history-item').length, 22, '点开「还有 2 条」后应全部摊开')
    assert.equal(findAllByClass(tree, 'soul-history-more').length, 0, '全部摊开后不该再留「还有 N 条」')

    // ③ warning 是「看到的不是全部」，不是失败：留在区块内、且不能染红
    const warn = findAllByClass(tree, 'soul-history-warning')
    assert.equal(warn.length, 1, 'warning 应留在这个区块内提示')
    assert.equal(textOf(warn[0]), zh['history.warning'].replace('{reason}', '记录文件较大，只读取了最近的部分。'))
    assert.ok(String(warn[0].props.className).includes('soul-status'), 'warning 用普通提示样式，不是 .soul-error')
    assert.equal(findAllByClass(tree, 'soul-error').length, 0, 'warning 不得被当成错误')
  })

  await check('C28 设置页指引：一条轻提示 + 问号里的全文，不再铺两行正文', async () => {    const world = await boot()
    world.routes['/api/soul/history'] = () => ({ ok: true, entries: [historyEntry({ id: 'a' })], max: 200, warning: null })
    const zh = world.dicts.zh

    // ① 折叠态：变更记录不该在设置页有独立分组，也不该出现在折叠标题旁。
    const closed = await renderSettings(world)
    // 判据用 accordion **标题 span** 而不是整个 accordion 文本：指引文案里就有
    //「变更记录」四个字，整树文本匹配会被自己误伤（首轮假红就是这么来的）。
    const closedTitles = findAllByClass(closed, 'soul-accordion-title')
    assert.equal(closedTitles.some((n) => textOf(n) === zh['group.history']), false,
      '设置页不得再保留「变更记录」手风琴分组')
    assert.equal(findAllByClass(closed, 'soul-history-entry').length, 0, '设置页不得再保留独立指引行（.soul-history-entry）')
    assert.equal(findAllByClass(closed, 'soul-accordion-head').length, 0,
      '折叠标题旁的 head 层应已删除（说明改放展开区内）')
    assert.equal(textOf(closed).includes(zh['history.entryHint']), false,
      '折叠态不该出现变更记录指引 —— 它解释的是展开后的东西')

    // ② 展开「人设预设」：两条说明各自一行，正文只有一句话，细节在问号里。
    const triggers = findAll(closed, (n) => n.type === 'button' && textOf(n).includes(zh['group.personas']))
    assert.ok(triggers.length > 0, '应存在「人设预设」分组标题（前置条件）')
    await triggers[0].props.onClick()
    const tree = await renderSettings(world)

    const notes = findAllByClass(tree, 'soul-note-inline')
    assert.equal(notes.length, 2, `应有两行轻提示（预设范围 + 变更记录去向），实际 ${notes.length}`)
    // 每行都是「一句话 + 一个问号」，正文走 .soul-note-text
    const texts = notes.map((n) => textOf(findAllByClass(n, 'soul-note-text')[0]))
    assert.deepEqual(texts, [zh['personas.hint'], zh['history.entryHint']],
      `两行正文应分别是两条短文案，实际 ${JSON.stringify(texts)}`)

    // ③ 关键：正文**不得**再穷举清单 —— 那些名词在卡片和按钮上本来就看得到。
    //    细节只能出现在问号的 tooltip 里（.soul-hint-tip），不能混进正文。
    for (const key of ['personas.hint', 'history.entryHint']) {
      assert.ok(zh[key].length <= 40, `${key} 应是短句（≤40 字），实际 ${zh[key].length} 字：${zh[key]}`)
    }
    const tips = findAllByClass(tree, 'soul-hint-tip').map((n) => textOf(n))
    assert.ok(tips.includes(zh['personas.hintDetail']), '预设的完整说明应在问号 tooltip 里')
    assert.ok(tips.includes(zh['history.entryHintMore']), '变更记录的去向全文应在问号 tooltip 里')
    // 反向：tooltip 的细节文字绝不能漏进正文（那等于没瘦身）
    const bodyText = texts.join('')
    for (const detailKey of ['personas.hintDetail', 'history.entryHintMore']) {
      assert.equal(bodyText.includes(zh[detailKey]), false, `正文不得混入 ${detailKey} 的全文`)
    }
    // ④ 说明是正文，不是按钮内容：绝不能嵌进 trigger（button 内不允许嵌可聚焦元素）
    const openTriggers = findAllByClass(tree, 'soul-accordion-trigger')
    assert.equal(openTriggers.some((n) => textOf(n).includes(zh['history.entryHint'])), false,
      '指引不得嵌进 trigger 按钮')
    // ⑤ 其余分组的展开区不得误挂说明（说明块是 personas 专属）
    const bodies = findAllByClass(tree, 'soul-accordion-body')
    const others = bodies.filter((n) => textOf(n) !== textOf(notes[0].parent) && !(n.children || []).includes(notes[0]))
    assert.equal(others.some((n) => findAllByClass(n, 'soul-note').length > 0), false,
      '只有人设预设分组挂说明块，其他分组不得误挂')
  })

  await check('C35 0.8.0 起设置页不得再出现「工作区绑定」分组（逻辑层保留，UI 撤下）', async () => {
    const world = await boot()
    // 绑定接口给它一条数据：如果分组被误加回来，展开后一定能看到这条 ——
    // 用空数据测不出问题（空态与「分组不存在」在文本上都可能什么都不显示）。
    world.routes['/api/soul/bindings'] = () => ({
      ok: true,
      bindings: { 'D:\\项目A': '苏格拉底式提问者' },
      invalid: [], dropped: 0, warning: null, max: 50, maxPathLength: 260, sessions: []
    })
    const zh = world.dicts.zh

    // ① 逐个分组展开，任何一组里都不得出现这个手风琴（连同它的标题与主体）
    let tree = await renderSettings(world)
    for (const groupKey of ['about', 'traits', 'personas', 'tool']) {
      const titleKey = { about: 'group.aboutYou', traits: 'group.traits', personas: 'group.personas', tool: 'group.tool' }[groupKey]
      const btn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes(zh[titleKey]))[0]
      assert.ok(btn, `前置条件：应存在「${zh[titleKey]}」分组`)
      await btn.props.onClick()
      tree = await renderSettingsSettled(world)
      // 判据一：折叠标题里不得有这一项
      assert.equal(
        findAllByClass(tree, 'soul-accordion-title').some((n) => textOf(n) === zh['group.bindings']),
        false,
        `展开「${zh[titleKey]}」后不得出现「工作区绑定」分组标题`
      )
      // 判据二：主体（那个会渲染绑定表的组件）不得被挂载
      assert.equal(findAllByClass(tree, 'soul-bindings').length, 0,
        `展开「${zh[titleKey]}」后不得渲染绑定主体（.soul-bindings）`)
    }
    // ② 折叠态整树文本里也不该出现它的说明文案
    assert.equal(textOf(tree).includes(zh['bindings.hint']), false,
      '设置页不得出现工作区绑定的说明文案')
  })

  await check('C36 会话「人设」tab：常驻注册、拿到 sessionId、按来源显示生效人设', async () => {
    const world = await boot()
    const zh = world.dicts.zh

    // ① 槽位：注册到 conversation.view（列表槽位），且 inject 必须把 sessionId 传下去。
    //    这是插件拿到「当前会话 id」的唯一正规入口 —— 设置页的 slotInject 是空串。
    const slot = world.captured.sections.find((s) => s.options && s.options.name === 'conversation.view')
    assert.ok(slot, '必须注册到 conversation.view 槽位（否则会话里没有「人设」tab）')
    assert.equal(slot.options.id, 'soul-persona')
    assert.equal(typeof slot.options.label, 'function', 'label 必须是函数（语言切换时需重新解析）')
    const injected = slot.options.inject('session-abc')
    assert.equal(injected.sessionId, 'session-abc', 'inject 必须把 sessionId 原样传给组件')
    assert.ok(injected.controller, 'inject 必须传 controller')
    // 宿主不传 sessionId 时（空白会话）必须是 null，而不是 undefined —— 组件靠它判"能不能改"
    assert.equal(slot.options.inject(undefined).sessionId, null)

    // ② 渲染：有覆盖时显示「有覆盖」标记、当前人设与来源
    world.routes['/api/soul/session-scope'] = (call) => {
      if (call.method === 'GET') {
        return {
          ok: true,
          sessionId: 'session-abc',
          workspaceId: 'ws_1',
          override: { style: 'humorous' },
          source: 'session',
          activePersona: '幽默风趣',
          workspaceTitle: 'dsh-plugin'
        }
      }
      return { ok: true, sessionId: 'session-abc', override: null, source: 'workspace', activePersona: '极简主义者', workspaceTitle: 'dsh-plugin' }
    }

    const renderTab = async () => {
      const props = slot.options.inject('session-abc')
      const useSoulController = (selector) => selector(world.controller.store.getSnapshot())
      const tree = await world.runtime.settle({
        type: slot.component,
        props: { ...props, useSoulController, t: (k, p) => {
          const raw = zh[k] ?? k
          return p ? raw.replace(/\{(\w+)\}/g, (m, name) => (p[name] === undefined ? m : String(p[name]))) : raw
        } }
      })
      for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
      return world.runtime.settle({
        type: slot.component,
        props: { ...props, useSoulController, t: (k, p) => {
          const raw = zh[k] ?? k
          return p ? raw.replace(/\{(\w+)\}/g, (m, name) => (p[name] === undefined ? m : String(p[name]))) : raw
        } }
      })
    }

    // 先让预设加载完（组件靠 state.personas 生成胶囊）
    world.routes['/api/soul/personas'] = () => ({
      ok: true,
      personas: { 苏格拉底式提问者: { style: 'professional', builtin: true }, 幽默风趣: { style: 'humorous' } },
      activeName: null
    })
    await world.controller.loadPersonas()

    const tree = await renderTab()
    const text = textOf(tree)
    assert.ok(text.includes(zh['session.title']), '应显示标题')
    assert.ok(text.includes('幽默风趣'), `应显示当前生效人设，实际「${text}」`)
    assert.ok(text.includes(zh['session.source.session']), '来源应标明是「本会话临时覆盖」')
    // 「有覆盖」标记会出现**两处**：顶部状态行 + 右栏详情头。
    // 改成左右分栏后两处都要显示 —— 用户点开别的卡时，详情头显示"使用中"而顶部
    // 仍是"有覆盖"，读起来才是同一套状态。
    assert.ok(
      findAllByClass(tree, 'soul-session-badge').length >= 1,
      '有覆盖时应显示「有覆盖」标记'
    )
    // 卡牌：每个预设一张（与设置页同一套卡牌语言）。
    // 0.9.0-d 改版前这里是胶囊（.soul-session-chip）；改成卡牌后断言对象随之更换。
    const cards = findAllByClass(tree, 'soul-session-card')
    assert.equal(cards.length, 2, `应为每个预设渲染一张卡，实际 ${cards.length}`)
    // 卡面必须复用设置页那套元素：插画 + 压图标题 + 效果栏
    assert.equal(findAllByClass(cards[0], 'soul-persona-art').length, 1, '卡面应有插画区（与设置页同款）')
    assert.equal(findAllByClass(cards[0], 'soul-persona-art-title').length, 1, '卡面应有压图标题')
    assert.equal(findAllByClass(cards[0], 'soul-persona-eff').length, 1, '卡面应有「这个预设会怎么回答」的效果栏')
    // 左卡牌 + 右详情：两块都必须存在
    assert.equal(findAllByClass(tree, 'soul-session-split').length, 1, '应是左右分栏布局')
    assert.equal(findAllByClass(tree, 'soul-session-detail').length, 1, '应有右栏详情面板')
    // 右栏要显示与设置页卡背**同款**的六个维度 + 自定义指令全文块
    // ⚠️ 不能只断言容器存在：容器在但里面一个维度都没有时，界面看起来"有一块空白"，
    //    而容器断言仍然通过（判断力对照实测：把维度列表换成空数组时漏网）。
    assert.equal(
      findAllByClass(tree, 'soul-persona-dim').length,
      6,
      `详情栏应列出六个维度（与设置页卡背同款），实际 ${findAllByClass(tree, 'soul-persona-dim').length}`
    )
    assert.ok(findAllByClass(tree, 'soul-persona-fulltext').length >= 1, '详情栏应有自定义指令全文块')
    // ⚠️ 叠层映射：选中卡必须落在**中心**（data-current）而非左侧。
    // 初版错写成 `stackOrder[offset + 1]`，把选中卡渲染到左侧、中心显示下一个 ——
    // 表现是「无论点哪个都显示同一张」。这里用中心卡 vs 详情栏名称交叉验证。
    {
      const centers = cards.filter((c) => c.props['data-current'] === 'true')
      assert.equal(centers.length, 1, `应恰好一张中心卡（data-current），实际 ${centers.length}`)
      const detail = findAllByClass(tree, 'soul-session-detail')[0]
      assert.ok(detail, '应有右栏详情面板')
      const detailName = findAllByClass(detail, 'soul-session-detail-name')[0]
      assert.ok(detailName, '详情栏应有名称')
      assert.ok(
        textOf(centers[0]).includes(textOf(detailName)),
        `中心卡应是详情栏展示的那张（中心=「${textOf(centers[0]).slice(0, 40)}」，详情=「${textOf(detailName)}」）`
      )
    }
    // 自定义字段必须用中英文标签，不是裸键名
    {
      const fieldEls = findAllByClass(tree, 'soul-session-field')
      if (fieldEls.length > 0) {
        const bare = fieldEls.filter((f) => /^[a-z][A-Za-z]*$/.test(textOf(f)))
        assert.equal(
          bare.length, 0,
          `自定义字段应显示中英文标签，不应露出裸键名：${bare.map(textOf).join(', ')}`
        )
      }
    }
    // 宽度必须与宿主输入框同宽（读 --dsh-chat-content-width），不是硬编码
    {
      const source = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')
      const cssBlock = source.match(/const css = \[([\s\S]*?)\]\.join/)?.[1] ?? ''
      assert.match(
        cssBlock,
        /max-width:var\(--dsh-chat-content-width/,
        '会话 tab 宽度应读 --dsh-chat-content-width（与宿主输入框同宽）而非硬编码'
      )
    }
    // 左侧是**叠层轮转**而非平铺：卡片带 style.transform（translateX/scale）与 data-current
    {
      const styled = cards.filter((c) => c.props.style && typeof c.props.style.transform === 'string')
      assert.equal(styled.length, cards.length, '每张卡都应有叠层 transform（不是平铺）')
      // 判据不能只是「是字符串」：transform: '' 也是字符串。
      // 必须真的含 translateX，否则把叠层写成平铺、再留个空 transform 也能过。
      for (const c of styled) {
        assert.ok(
          c.props.style.transform.includes('translateX'),
          `叠层 transform 必须含 translateX，实际「${c.props.style.transform}」`
        )
      }
      const centers = cards.filter((c) => c.props['data-current'] === 'true')
      assert.equal(centers.length, 1, `应恰好一张中心卡（data-current），实际 ${centers.length}`)
    }
    // 生效中的那张卡要标出来，否则用户看不出哪个在用
    const effectiveCards = cards.filter((c) => c.props['data-effective'] === 'true')
    assert.equal(effectiveCards.length, 1, `应恰好一张卡标为生效中，实际 ${effectiveCards.length}`)
    assert.ok(textOf(effectiveCards[0]).includes('幽默风趣'), '生效中的应是当前覆盖的那个预设')
    assert.equal(
      findAllByClass(tree, 'soul-session-chip').filter((c) => textOf(c) === zh['session.clear']).length,
      1,
      '有覆盖时必须给出「恢复上层设置」'
    )
  })

  await check('C37 会话「人设」tab：点卡看详情（不改配置）、右栏「用这个」才改、清除即恢复', async () => {
    const world = await boot()
    const zh = world.dicts.zh
    const posts = []
    const slot = world.captured.sections.find((s) => s.options && s.options.name === 'conversation.view')
    assert.ok(slot, '前置条件：conversation.view 已注册')

    let current = {
      ok: true,
      sessionId: 'session-abc',
      workspaceId: 'ws_1',
      override: null,
      source: 'workspace',
      activePersona: '苏格拉底式提问者',
      workspaceTitle: 'dsh-plugin'
    }
    world.routes['/api/soul/personas'] = () => ({
      ok: true,
      // 桩必须带上**真实预设会有的元数据**（updatedAt / builtin）与「关于你」字段：
      // 否则「客户端是否筛掉非覆盖字段」这件事根本测不出来 —— 判断力对照实测：
      // 把筛选循环换成 Object.assign 时，不带元数据的桩让断言全部放行。
      personas: {
        苏格拉底式提问者: { style: 'professional', builtin: true, updatedAt: '2026-01-01T00:00:00Z' },
        幽默风趣: {
          style: 'humorous',
          replyLength: 'concise',
          nickname: '不该被提交的昵称',
          occupation: '不该被提交的职业',
          updatedAt: '2026-01-01T00:00:00Z'
        }
      },
      activeName: null
    })
    world.routes['/api/soul/session-scope'] = (call) => {
      if (call.method === 'GET') return current
      posts.push(call.body)
      if (call.body && call.body.clear === true) {
        current = { ...current, override: null, source: 'workspace', activePersona: '苏格拉底式提问者' }
      } else {
        current = { ...current, override: call.body.overrides, source: 'session', activePersona: '幽默风趣' }
      }
      return current
    }
    await world.controller.loadPersonas()

    const renderTab = async () => {
      const props = slot.options.inject('session-abc')
      const useSoulController = (selector) => selector(world.controller.store.getSnapshot())
      const t = (k, p) => {
        const raw = zh[k] ?? k
        return p ? raw.replace(/\{(\w+)\}/g, (m, name) => (p[name] === undefined ? m : String(p[name]))) : raw
      }
      for (let i = 0; i < 6; i++) await new Promise((r) => drainTick(r))
      return world.runtime.settle({ type: slot.component, props: { ...props, useSoulController, t } })
    }

    let tree = await renderTab()
    // ① 点卡片选中 → 右栏详情出现「用这个」→ 点它才改配置
    //
    //    0.9.0-d 改成左右分栏后，卡面**不再**放操作按钮：点卡 = 换右栏详情（纯浏览），
    //    改配置的动作收敛到右栏。这两步必须分开验证 —— 否则「点卡直接改配置」这种
    //    退化（浏览即生效）测不出来。
    const cardFor = (n) => findAllByClass(tree, 'soul-session-card').find((c) => textOf(c).includes(n))
    const humorousCard = cardFor('幽默风趣')
    assert.ok(humorousCard, '应有「幽默风趣」的卡牌')
    // 卡面上不应有操作按钮（改配置只在右栏）
    assert.equal(
      findAllByClass(humorousCard, 'soul-persona-action').length,
      0,
      '卡面上不应有操作按钮 —— 点卡只换详情，不该顺带改配置'
    )
    await humorousCard.props.onClick()
    tree = await renderTab()
    // 选中后右栏显示这张卡的详情，且「用这个」在右栏
    const detail = findAllByClass(tree, 'soul-session-detail')[0]
    assert.ok(detail, '应有右栏详情面板')
    assert.ok(textOf(detail).includes('幽默风趣'), `右栏应显示被选中的那张卡，实际「${textOf(detail).slice(0, 80)}」`)
    const useBtn = findAllByClass(detail, 'soul-persona-action')[0]
    assert.ok(useBtn, '右栏应有「用这个」按钮')
    assert.equal(textOf(useBtn), zh['session.useCard'], '未生效的人设应显示「用这个」')
    assert.equal(posts.length, 0, '仅仅选中一张卡**不得**改配置（浏览与生效是两件事）')
    await useBtn.props.onClick()
    tree = await renderTab()
    assert.equal(posts.length, 1, `点一次应只发一次请求，实际 ${posts.length}`)
    assert.deepEqual(posts[0], {
      sessionId: 'session-abc',
      overrides: { style: 'humorous', replyLength: 'concise' }
    }, `应只带预设声明过的字段，实际 ${JSON.stringify(posts[0])}`)
    // ⚠️ 反向断言：预设条目的元数据与非人设字段**绝不能**被提交。
    // 只断言"带了正确的两个字段"会漏掉「整份预设照发」的形态 —— 判断力对照实测：
    // 把筛选循环换成 `Object.assign(overrides, entry)` 时，原版本全部放行。
    const submitted = posts[0].overrides || {}
    for (const forbidden of ['updatedAt', 'builtin', 'name', 'nickname', 'enabled']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(submitted, forbidden),
        false,
        `提交的覆盖里不得含 ${forbidden} —— 服务端会丢弃它，客户端本来就不该发`
      )
    }
    assert.ok(findAllByClass(tree, 'soul-session-badge').length >= 1, '改完应出现「有覆盖」标记')
    // 生效中的卡：卡片带 data-effective（配置事实），而**按钮在右栏**且变「使用中」
    {
      const effective = findAllByClass(tree, 'soul-session-card').filter((c) => c.props['data-effective'] === 'true')
      assert.equal(effective.length, 1, `应恰好一张卡标为生效中，实际 ${effective.length}`)
      // 卡面上没有按钮（浏览与生效分离），所以 active 样式落在右栏那个按钮上
      const detail = findAllByClass(tree, 'soul-session-detail')[0]
      const activeBtn = findAllByClass(detail, 'soul-persona-action')[0]
      assert.ok(activeBtn, '右栏应有操作按钮')
      assert.equal(textOf(activeBtn), zh['session.chipInUse'], '生效中的人设，右栏按钮应显示「使用中」')
      assert.ok(String(activeBtn.props.className).includes('soul-persona-active'), '生效中时按钮应带 active 样式')
    }

    // ② 点「恢复上层设置」→ clear:true，且覆盖消失
    const clearChip = findAllByClass(tree, 'soul-session-chip').find((c) => textOf(c) === zh['session.clear'])
    assert.ok(clearChip, '应有「恢复上层设置」')
    await clearChip.props.onClick()
    tree = await renderTab()
    assert.equal(posts.length, 2, '清除应再发一次请求')
    assert.deepEqual(posts[1], { sessionId: 'session-abc', clear: true })
    assert.equal(findAllByClass(tree, 'soul-session-badge').length, 0, '清除后不该再有「有覆盖」标记')
  })


  await check('C38 工作区人设：平铺卡片（未绑定排前）、内联选人设、解绑过二次确认', async () => {
    const world = await boot()
    const zh = world.dicts.zh
    const posts = []
    let view = {
      ok: true,
      indexProblem: null,
      max: 200,
      boundCount: 1,
      workspaces: [
        { workspaceId: 'ws_a', title: 'dsh-plugin', path: 'D:\\p\\dsh-plugin', sessionCount: 2, bound: true, invalidPersona: false },
        { workspaceId: 'ws_b', title: 'dsh-soul', path: 'D:\\p\\dsh-soul', sessionCount: 1, bound: false, invalidPersona: false },
        { workspaceId: 'ws_c', title: 'aaa-newest', path: 'D:\\p\\aaa', sessionCount: 0, bound: false, invalidPersona: false }
      ]
    }
    world.routes['/api/soul/personas'] = () => ({
      ok: true,
      personas: { 苏格拉底式提问者: { style: 'professional', builtin: true }, 极简主义者: { style: 'efficient' } },
      activeName: null
    })
    world.routes['/api/soul/workspaces'] = (call) => {
      if (call.method === 'GET') return view
      posts.push({ path: '/api/soul/workspaces', body: call.body })
      view = {
        ...view,
        workspaces: view.workspaces.map((w) => (w.workspaceId === call.body.workspaceId ? { ...w, bound: true } : w))
      }
      return view
    }
    world.routes['/api/soul/workspaces/delete'] = (call) => {
      posts.push({ path: '/api/soul/workspaces/delete', body: call.body })
      view = {
        ...view,
        workspaces: view.workspaces.map((w) => (w.workspaceId === call.body.workspaceId ? { ...w, bound: false } : w))
      }
      return view
    }
    await world.controller.loadPersonas()

    const slot = world.captured.sections.find((s) => s.options && s.options.name === 'plugins.detail.section' && s.options.id === 'soul-detail-workspaces')
    assert.ok(slot, '必须注册到 plugins.detail.section 槽位')

    // ⚠️ `subject` 由**宿主**在渲染详情页时注入，不在注册时的 inject 里。
    // 组件靠它判断"这个详情页是不是自己的"，所以测试必须自己补上 ——
    // 漏补的话组件一律 return null，看起来像"组件坏了"（本用例初版就读到 0 张卡片）。
    const OWN_SUBJECT = { kind: 'bundle', pkg: { name: 'dsh-soul' } }

    const render = async () => {
      const props = { ...slot.options.inject(), subject: OWN_SUBJECT }
      const useSoulController = (selector) => selector(world.controller.store.getSnapshot())
      const t = (k, p) => {
        const raw = zh[k] ?? k
        return p ? raw.replace(/\{(\w+)\}/g, (m, name) => (p[name] === undefined ? m : String(p[name]))) : raw
      }
      // ⚠️ 顺序必须是「先渲染 → 再等 → 再渲染」：组件在**首次渲染**时才挂载、
      // effect 才排上异步加载。先等再渲染的话，等的是"还没发出去的请求"，
      // 于是永远停在加载态（本用例初版就是这么读到 0 张卡片的）。
      await world.runtime.settle({ type: slot.component, props: { ...props, useSoulController, t } })
      for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
      return world.runtime.settle({ type: slot.component, props: { ...props, useSoulController, t } })
    }

    // `reload` 的 effect 依赖是 `[]` —— 组件只在**挂载那一次**拉数据。
    // 测试里换掉路由后再调 render() 并不会重跑 effect（依赖没变），
    // 所以「换路由 → 重进页面」必须显式重建：先 unmount 再 render。
    const remount = async () => {
      world.runtime.unmount()
      return await render()
    }

    // ① 只服务自己的详情页
    let tree = await render()
    const props0 = { ...slot.options.inject(), subject: OWN_SUBJECT }
    // settle 返回的是渲染树节点（组件返回 null 时外层仍有一层），所以判据是**没有内容**，
    // 而不是 strictEqual(null)。
    const otherTree = await world.runtime.settle({
      type: slot.component,
      props: { ...props0, subject: { kind: 'bundle', pkg: { name: 'other-plugin' } }, useSoulController: (s) => s(world.controller.store.getSnapshot()), t: (k) => zh[k] ?? k }
    })
    assert.equal(textOf(otherTree || {}).trim(), '', '其他插件的详情页必须不渲染任何内容')
    assert.equal(findAllByClass(otherTree || {}, 'soul-ws-card').length, 0, '其他插件的详情页不得出现工作区卡片')

    // ② 平铺卡片，且**未绑定的排在前面**（那正是用户来这一页要处理的）
    const cards = findAllByClass(tree, 'soul-ws-card')
    assert.equal(cards.length, 3, `应渲染三张工作区卡片，实际 ${cards.length}`)
    const titles = cards.map((c) => textOf(findAllByClass(c, 'soul-ws-title')[0]))
    assert.deepEqual(titles, ['aaa-newest', 'dsh-soul', 'dsh-plugin'],
      `未绑定的应排前面并按标题排序，实际 ${JSON.stringify(titles)}`)
    assert.equal(cards[0].props['data-bound'], 'false')
    assert.equal(cards[2].props['data-bound'], 'true')

    // ②b 「加载中」「加载失败」「确实没有工作区」是三件不同的事。
    //     这一组曾经在 0.8.0 的 C14 上被真实抓到过（懒加载分组把失败显示成"加载中"），
    //     所以这里逐个验证三态各自的文案，而不是只测成功路径。
    {
      const saved = world.routes['/api/soul/workspaces']
      // 失败：必须显示原因，不能停在「加载中」。
      // 桩用 `ok:false` 而不是抛错 —— postJSON 只把 `payload.error` 翻进异常消息，
      // 抛错会变成 "HTTP 500"，测不到"原因被展示"这件事。
      world.routes['/api/soul/workspaces'] = () => ({ ok: false, error: 'boom' })
      const failTree = await remount()
      assert.equal(
        textOf(failTree).includes(zh['workspaces.loading']),
        false,
        '读取失败时不得停在「加载中」—— 那与"确实没有工作区"长得一样'
      )
      assert.ok(textOf(failTree).includes('boom'), `失败时应把原因显示出来，实际「${textOf(failTree)}」`)

      // 空列表：显示空态文案，而不是加载中
      world.routes['/api/soul/workspaces'] = () => ({ ok: true, indexProblem: null, max: 200, boundCount: 0, workspaces: [] })
      const emptyTree = await remount()
      assert.ok(textOf(emptyTree).includes(zh['workspaces.empty']), '没有工作区时应显示空态文案')
      assert.equal(textOf(emptyTree).includes(zh['workspaces.loading']), false, '空态不得显示成加载中')

      // 服务不可用（indexProblem）：如实说明，且**不**显示空态
      world.routes['/api/soul/workspaces'] = () => ({ ok: true, indexProblem: 'registry 不可用', max: 200, boundCount: 0, workspaces: [] })
      const problemTree = await remount()
      assert.ok(textOf(problemTree).includes('registry 不可用'), '服务不可用时应如实说明原因')
      assert.equal(
        textOf(problemTree).includes(zh['workspaces.empty']),
        false,
        '服务不可用时不得显示成"还没有工作区"—— 那会让用户以为自己的数据没了'
      )
      world.routes['/api/soul/workspaces'] = saved
    }

    // ③ 点「绑定人设」→ 内联展开人设胶囊（不弹层）
    tree = await remount()
    const freshCards = findAllByClass(tree, 'soul-ws-card')
    const bindBtn = findAllByClass(freshCards[0], 'soul-ws-action').find((b) => textOf(b) === zh['workspaces.bind'])
    assert.ok(bindBtn, '未绑定的卡片应有「绑定人设」')
    await bindBtn.props.onClick()
    tree = await render()
    const chips = findAllByClass(tree, 'soul-session-chip')
    assert.ok(chips.length >= 2, `应展开人设胶囊，实际 ${chips.length}`)
    assert.equal(findAllByClass(tree, 'soul-ws-picker').length, 1, '只展开一个选择器')

    // ④ 点一个人设 → 发一次绑定请求
    const pick = chips.find((c) => textOf(c) === '极简主义者')
    assert.ok(pick, '应有「极简主义者」胶囊')
    await pick.props.onClick()
    tree = await render()
    assert.equal(posts.length, 1, `应发一次绑定请求，实际 ${posts.length}`)
    assert.deepEqual(posts[0], { path: '/api/soul/workspaces', body: { workspaceId: 'ws_c', persona: '极简主义者' } })
    assert.equal(findAllByClass(tree, 'soul-ws-picker').length, 0, '绑定后应收起选择器')

    // ⑤ 解绑：第一次点只 arm，第二次才发请求
    tree = await render()
    const boundCard = findAllByClass(tree, 'soul-ws-card')[2]
    const unbindBtn = () => findAllByClass(tree, 'soul-ws-action').find((b) => textOf(b) === zh['workspaces.unbind'])
    assert.ok(unbindBtn(), '已绑定的卡片应有「解除绑定」')
    await unbindBtn().props.onClick()
    tree = await render()
    assert.equal(posts.length, 1, '第一次点解绑不得发请求')
    const armed = findAllByClass(tree, 'soul-ws-action-armed')
    assert.equal(armed.length, 1, '第一次点后应进入 armed 态')
    assert.equal(textOf(armed[0]), zh['workspaces.unbindArmed'])
    await armed[0].props.onClick()
    tree = await render()
    assert.equal(posts.length, 2, '第二次点才发解绑请求')
    assert.equal(posts[1].path, '/api/soul/workspaces/delete')
  })

  // verify-e2e-prompt 的 W1–W15 与 R1–R13 守着。0.9.0 用工作区平铺卡片重写 UI 时，
  // 会在这里补新的行为用例。

  await check('C34 保留条数在变更记录区块里就地改并即时落盘，设置页不得再有它', async () => {
    const entries = [historyEntry({ id: 'r-1', at: new Date().toISOString(), before: { style: 'professional' }, after: { style: 'casual' } })]
    const world = await boot()
    const posts = []
    world.routes['/api/soul/history'] = () => ({ ok: true, entries, max: 200, warning: null })
    world.routes['/api/soul/config'] = (call) => {
      if (call.method === 'GET') return { ok: true, config: { ...CONFIG }, configError: null, deliveryWarning: null }
      posts.push(call.body)
      // 服务端把 POST 体当 patch 合并，并把（夹取后的）值回传
      return { ok: true, config: { ...CONFIG, ...call.body }, changed: ['historyMaxEntries'], deliveryWarning: null }
    }
    const zh = world.dicts.zh

    // ① 设置页的每个分组里都不得再有这个控件（逐个展开查，避免只看了默认展开的那组）
    let tree = await renderSettings(world)
    for (const groupKey of ['group.traits', 'group.personas', 'group.bindings', 'group.tool']) {
      const btn = findAll(tree, (n) => n.type === 'button' && textOf(n).includes(zh[groupKey]))[0]
      if (!btn) continue
      await btn.props.onClick()
      tree = await renderSettingsSettled(world)
      assert.equal(findAll(tree, (n) => n.props && n.props.id === 'soul-historyMaxEntries').length, 0,
        `设置页「${zh[groupKey]}」分组里不得再出现保留条数下拉（0.8.1 已迁到详情页）`)
    }

    // ② 详情页的变更记录区块里必须有它
    let detail = await renderDetailSettled(world)
    const selects = findAll(detail, (n) => n.type === 'select' && n.props.id === 'soul-historyMaxEntries')
    assert.equal(selects.length, 1, `详情页应恰好一个保留条数下拉，实际 ${selects.length}`)
    assert.equal(selects[0].props.value, '200', '初始值应来自配置（默认 200）')
    // 档位完整（50 / 100 / 200 / 500），否则用户没法把窗口调大
    const options = findAll(selects[0], (n) => n.type === 'option').map((n) => n.props.value)
    assert.deepEqual(options, ['50', '100', '200', '500'], `档位应为四档，实际 ${JSON.stringify(options)}`)

    // ③ 改一次就落盘，不用等设置页那个保存按钮
    await selects[0].props.onChange({ target: { value: '500' } })
    detail = await renderDetailSettled(world)
    assert.equal(posts.length, 1, `改一次应恰好发一次保存请求，实际 ${posts.length}`)
    // 只发这一个字段：整份配置回传会覆盖掉别的标签页刚改的东西
    assert.deepEqual(posts[0], { historyMaxEntries: 500 }, `请求体只该带这一个字段，实际 ${JSON.stringify(posts[0])}`)
    const after = findAll(detail, (n) => n.type === 'select' && n.props.id === 'soul-historyMaxEntries')[0]
    assert.equal(after.props.value, '500', '成功后下拉应停在新值上')
    const okText = findAllByClass(detail, 'soul-saved-notice')
    assert.equal(okText.length, 1, '成功后应有一行绿字')
    assert.equal(textOf(okText[0]), zh['history.maxEntriesSaved'].replace('{count}', '500'))
  })

  await check('C39 会话覆盖清理：默认只预览、确认才删、扫描不完整时不给清理按钮', async () => {
    const world = await boot()
    const zh = world.dicts.zh
    const posts = []
    let plan = {
      ok: true,
      dryRun: true,
      scanComplete: true,
      persistenceProblem: null,
      total: 3,
      markable: [{ sessionId: 's-watching' }],
      collectable: [{ sessionId: 's-old', file: 'a.json', reason: '缺席超过 30 天' }],
      quarantine: [{ sessionId: 's-bad', file: 'b.json', reason: '内容损坏' }],
      entries: []
    }
    world.routes['/api/soul/session-scope/gc'] = (call) => {
      posts.push(call.body || {})
      if (call.body && call.body.apply === true) {
        plan = { ...plan, dryRun: false, collectable: [], removed: ['s-old'] }
      }
      return plan
    }

    const slot = world.captured.sections.find((s) => s.options && s.options.name === 'plugins.detail.section' && s.options.id === 'soul-detail-sessions')
    assert.ok(slot, '必须注册到 plugins.detail.section 槽位（id=soul-detail-sessions）')
    const OWN = { kind: 'bundle', pkg: { name: 'dsh-soul' } }

    const render = async () => {
      const props = { ...slot.options.inject(), subject: OWN }
      const useSoulController = (selector) => selector(world.controller.store.getSnapshot())
      const t = (k, p) => {
        const raw = zh[k] ?? k
        return p ? raw.replace(/\{(\w+)\}/g, (m, name) => (p[name] === undefined ? m : String(p[name]))) : raw
      }
      await world.runtime.settle({ type: slot.component, props: { ...props, useSoulController, t } })
      for (let i = 0; i < 8; i++) await new Promise((r) => drainTick(r))
      return world.runtime.settle({ type: slot.component, props: { ...props, useSoulController, t } })
    }

    // ① 打开页面**不自动扫描**：清理是运维动作，不该在打开详情页时悄悄跑一遍
    let tree = await render()
    assert.equal(posts.length, 0, '打开详情页不得自动发起清理扫描')
    assert.ok(textOf(tree).includes(zh['sessions.previewHint']), '未预览时应给出「预览不会删」的说明')
    assert.equal(findAllByClass(tree, 'soul-ws-action-armed').length, 0, '未预览时不得出现确认按钮')

    // ② 点「清理可回收项」→ 只发一次 dry-run（body 里**没有** apply:true）
    const firstBtn = () => findAll(findAllByClass(tree, 'soul-sessions-actions')[0], (n) => n.type === 'button')[0]
    await firstBtn().props.onClick()
    tree = await render()
    assert.equal(posts.length, 1, '点一次应只发一次扫描请求')
    assert.equal(posts[0].apply, undefined, '第一次点击**不得**带 apply:true —— 默认必须站在「不删」一侧')
    const armed = findAllByClass(tree, 'soul-ws-action-armed')
    assert.equal(armed.length, 1, '预览出可回收项后应出现确认按钮')
    assert.equal(textOf(armed[0]), zh['sessions.collectArmed'].replace('{count}', '1'))

    // ③ 点确认 → 才发 apply:true
    await armed[0].props.onClick()
    tree = await render()
    assert.equal(posts.length, 2, '确认应再发一次请求')
    assert.equal(posts[1].apply, true, '确认时**必须**带 apply:true')
    assert.ok(textOf(tree).includes(zh['sessions.collected'].replace('{count}', '1')), '应报告清理结果')

    // ④ 扫描不完整 → 明确说明「没做判定」，且**不给清理按钮**
    world.runtime.unmount()
    posts.length = 0
    // ⚠️ 桩必须让 collectable **非空**：扫描不完整时状态机对所有条目返回 keep，
    // 所以真实数据下 collectable 必然是空的 —— 但如果桩也给它空，
    // 「界面上是否显示清理按钮只取决于 collectable」这个缺陷就永远测不出来。
    // 这里刻意构造"不完整 + 有可回收项"这个真实世界不该出现、但代码可能误判的形态。
    plan = {
      ok: true,
      dryRun: true,
      scanComplete: false,
      persistenceProblem: 'sessionPersistence 不可用',
      total: 3,
      markable: [],
      collectable: [{ sessionId: 's-should-not-show', file: 'c.json', reason: '不应出现' }],
      quarantine: [],
      entries: []
    }
    tree = await render()
    await firstBtn().props.onClick()
    tree = await render()
    assert.ok(textOf(tree).includes(zh['sessions.scanIncomplete']), '扫描不完整时必须说清没做判定')
    assert.equal(findAllByClass(tree, 'soul-ws-action-armed').length, 0, '扫描不完整时不得给出确认删除的入口')
  })
} finally {
  restoreTimers()
}

if (!assertCount('verify-client', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
