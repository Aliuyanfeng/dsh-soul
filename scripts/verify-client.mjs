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
const EXPECTED_ASSERTIONS = 12

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
    /** 渲染 + 跑本轮 effect，直到状态不再变化（含 effect / handler 里已 resolve 的 promise）。 */
    async settle(root) {
      for (let pass = 0; pass < 40; pass++) {
        dirty = false
        queue = []
        const tree = render(root, 'root')
        for (const { frame, slot, fn } of queue) {
          const key = `${frame.key}#${slot}`
          const previous = cleanups.get(key)
          if (typeof previous === 'function') previous()
          const returned = fn()
          cleanups.set(key, typeof returned === 'function' ? returned : null)
        }
        await drain()
        if (!dirty) return tree
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
function loadClient(routes) {
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
    addEventListener() {},
    removeEventListener() {},
    location: { origin: 'http://dsh.test' }
  }
  const documentStub = {
    visibilityState: 'visible',
    body: domNode(),
    head: domNode(),
    addEventListener() {},
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
      // ui.Button 单独换成宿主元素标记：这样它连同 onClick / children 原样留在渲染树里，
      // 断言就能像用户一样「找到那个按钮并点它」，而不是去猜某个闭包。
      return { Button: 'ui-button' }
    }
    throw new Error(`未预料的 require：${spec}`)
  }
  // eslint-disable-next-line no-new-func -- 客户端是宿主加载的 bundle（无 ESM 导入），只能在受控作用域里求值
  new Function('window', source)(windowStub)
  const module = factory(requireStub)

  const captured = { provide: {}, sections: [], dicts: null, runtime }
  const ctx = {
    provide: (name, value) => { captured.provide[name] = value },
    effect: (fn) => { const dispose = fn(); if (typeof dispose === 'function') captured.sections.push({ dispose }) },
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

/** 装配一个干净的客户端实例（含真实的初始 loadConfig）。 */
async function boot(configPayload = {}) {
  fetchCalls = []
  timerQueue = []
  const routes = {
    '/api/soul/config': (call) => (call.method === 'GET'
      ? { ok: true, config: { ...CONFIG }, ...configPayload }
      : { ok: true, config: { ...CONFIG }, changed: [] }),
    '/api/soul/config/reset': () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null }),
    '/api/soul/personas': () => ({ ok: true, personas: [], activePersona: null }),
    '/api/soul/prompt': () => ({ ok: true, prompt: 'P', enabled: true })
  }
  const world = loadClient(routes)
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

/** 像用户一样点下指定文案的按钮，返回之后的 toast（{ text, kind }）。 */
async function clickButton(world, labelKey) {
  const tree = await renderSettings(world)
  const label = world.dicts.zh[labelKey]
  const buttons = findAll(tree, (n) => n.type === 'ui-button' && textOf(n) === label)
  assert.equal(buttons.length, 1, `期望恰好一个「${label}」按钮，实际 ${buttons.length} 个`)
  await buttons[0].props.onClick()
  const after = await renderSettings(world)
  const toasts = findAll(after, (n) => typeof n.props?.className === 'string' && n.props.className.includes('soul-toast'))
  assert.equal(toasts.length, 1, `期望恰好一个 toast，实际 ${toasts.length} 个`)
  return {
    text: textOf(toasts[0]),
    kind: toasts[0].props.className.includes('soul-toast-error') ? 'error' : 'success'
  }
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
    assert.notEqual(toast.text, world.dicts.zh['toast.reset'])
  })

  await check('C9 重置成功且丢弃过损坏文件时，提示「已备份」（而不是普通的「已重置」）', async () => {
    const world = await boot()
    world.routes['/api/soul/config/reset'] = () => ({
      ok: true, config: { ...CONFIG }, changed: [], backupPath: '/x/soul-config.json.corrupt'
    })
    const toast = await clickButton(world, 'button.reset')
    assert.equal(toast.kind, 'success')
    assert.equal(toast.text, world.dicts.zh['toast.resetRecovered'])
  })

  await check('C10 普通重置只提示「已重置」，且不留残余的送达警告', async () => {
    const world = await boot({ deliveryWarning: '旧的送达警告' })
    world.routes['/api/soul/config/reset'] = () => ({ ok: true, config: { ...CONFIG }, changed: [], backupPath: null })
    const toast = await clickButton(world, 'button.reset')
    assert.equal(toast.text, world.dicts.zh['toast.reset'])
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
    assert.notEqual(toast.text, world.dicts.zh['toast.noChanges'])
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
} finally {
  restoreTimers()
}

if (!assertCount('verify-client', passed, EXPECTED_ASSERTIONS)) process.exit(1)

console.log(`\n全部通过：${passed} 项检查`)
