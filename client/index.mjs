// client/index.mjs — dsh-soul Web UI 插件
//
// 在设置页面添加「个性化」栏目：
//   - 启用/禁用个性化设置
//   - 「关于你」（昵称/职业/介绍）、回复风格和语调、特质、输出语言、自定义指令
//   - 人设预设：7 个内置人设（随插件提供、不可删除，行尾标「内置」）+ 保存当前为预设、一键使用（★ 标记当前匹配项）、删除
//   - Agent 工具：set_persona 确认模式开关
//   - 输入框光轨：Agent 回复中时输入框边框的流光动效（颜色 / 速度 / 粗细 + 实时示例）
//   - dirty 检测（无改动禁用保存）、统一 toast 提示
//   - 提示词预览（只读）：无未保存编辑时显示「当前生效提示词」，有编辑时改为编译草稿
//     —— 展示保存后真正会生效的内容，并在保存/重置/应用预设后自动刷新
//
// 光轨另注册到 conversation.input.overlay 槽位（输入框卡片内部），
// 运行时按会话 running 状态在卡片上挂载/隐藏 SVG 环，见 SoulTrail。
//
// 纯 JS + React jsx-runtime 手写（不依赖 JSX 构建），开箱即用。
// 注意：dsh web 使用 React 17+ 的 jsx-runtime，children 必须放在 props.children
// 里；不能把 children 当第三个参数传（第三个参数是 key）。
//
// 文案全部走宿主 locale 词典：槽位声明 locale: NS 后，渲染器会把绑定本命名
// 空间的 t 注入组件（props.t），并在语言切换时重渲染；导航 label 由 apply 内
// 绑定的 navT 实时解析，壳层在语言切换时会重新解析 label。

window.__ModuleLoader__.load({
  id: 'dsh-soul',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    // react/jsx-runtime：官方 client bundle 使用 jsx/jsxs/Fragment。
    // 我们用一个小包装 e() 让 children 写法保持直观，同时符合 jsx-runtime 约定。
    const { jsx: h, jsxs: hs, Fragment } = require('react/jsx-runtime')
    const React = require('react')
    const ui = require('@deepseek-ai/dsh-client-ui-primitives')

    // 包装：把多余的参数收集成 props.children，避免直接调用 h(type, props, child)
    // 时被当成 key 参数。
    const e = (type, props, ...children) => {
      const p = props || {}
      if (children.length === 0) return h(type, p)
      if (children.length === 1) return h(type, { ...p, children: children[0] })
      return hs(type, { ...p, children })
    }

    // -------------------------------------------------------------------------
    // 状态与控制器
    // -------------------------------------------------------------------------

    const NS = 'soul'
    const VERSION = '0.9.0'
    const INITIAL = {
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
      // set_persona 确认模式（v0.5.0）
      requireToolConfirmation: false,
      // 输入框光轨（v0.6.0）：Agent 回复中时输入框边框的流光动效
      trailEnabled: true,
      trailColor: '#679EFE',
      trailSpeed: 'slow',
      trailWidth: 'thin',
      // 人设预设库与当前匹配项（GET /api/soul/personas 带回）
      personas: null,
      activePersona: null,
      // 预设列表请求失败的原因（成功时清空）。用于把「加载中」与「加载失败」区分开
      personasError: null,
      // 会话作用域解析结果：sessionId → { activePersona, source, workspaceTitle, ... }。
      //
      // 为什么放进**全局 store**而不是组件自己的 useState：
      // · 会话「人设」tab 与 header 的人设标签是**两个组件**，都要看同一份数据；
      // · 之前 header 标签只在 sessionId 变化时取一次 ⇒ 会话里切换人设后，
      //   标签仍显示旧值（用户报的 bug）；
      // · 放 store 后，saveSessionScope 成功即写入，所有订阅者一起刷新 ——
      //   不必再各自去轮询或监听。
      //
      // 值是普通对象（不是 Map）：store 的更新走浅比较，Map 原地改不会触发。
      sessionScopes: {},
      // 变更记录（0.8.0）：null = 还没拉过，[] = 拉过且确实没有记录。
      // 两者必须分得开 —— 否则「没有记录」与「还没加载」在界面上是同一种空白。
      history: null,
      // 记录可能不完整的原因（读取窗口切掉、坏行、压实、写入失败），服务端给的原文
      historyWarning: null,
      historyError: null,
      // 容量上限（服务端 HISTORY_MAX_ENTRIES）。由响应带回而不是写死在客户端：
      // 两边各写一份迟早会不一致，而「最多保留 N 条」是一句会被人当真的承诺。
      historyMax: null,
      // 变更记录保留条数（配置字段，用户可改）。与 historyMax 不同：
      // historyMax 是「当前配置承诺的上限」（响应带回），historyMaxEntries 是
      // 设置表单里的那份值 —— 保存成功后两者应相等。
      historyMaxEntries: 200,
      // —— 工作区绑定（0.8.1）——
      // 与 history 同款：null = 还没拉过，[] = 拉过且确实没有绑定。
      // 「这个项目还没绑过」与「还没去看」是两件事，界面上不给它们同一种空白。
      bindings: null,
      // 失效引用（绑定的人设已不存在）与坏行丢弃数，都由服务端如实标注
      bindingsInvalid: [],
      bindingsDropped: null,
      // 「记录可能不完整」的原因，不是失败（同 historyWarning）
      bindingsWarning: null,
      bindingsError: null,
      // 服务端承诺的上限（MAX_BINDINGS / MAX_PATH_LENGTH），由响应带回，
      // 不在客户端写死 —— 两边各写一份迟早会不一致
      bindingsMax: null,
      bindingsMaxPath: null,
      // 活动会话的解析结果（只读状态：哪个目录现在用的是谁）
      bindingsSessions: [],
      saving: false,
      error: null
    }

    // 第三方插件不能 require('@deepseek-ai/dsh-client-runtime/client')——
    // dsh web 的 module table 只 seed 9 个 platform 模块，runtime/client 不在里面。
    // 第三方插件必须自实现 SnapshotStore。
    const createSnapshotStore = (init) => {
      let state = init
      const listeners = new Set()
      const notify = () => { for (const fn of [...listeners]) fn() }
      return {
        getSnapshot: () => state,
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
        update: (mutator) => {
          const next = { ...state }
          mutator(next)
          // 值全等时不换引用、也不通知：设置页每 2s 轮询一次宿主配置，绝大多数轮次
          // 什么都没变，此前却每次都让订阅方（设置页 / 快捷开关 / 光轨）白重渲染一次。
          // 取两侧键集的并集比较：只遍历 next 会漏掉「mutator 删了某个键」的情形，
          // 那会变成静默不更新 —— 比多通知一次严重得多。
          for (const key of new Set([...Object.keys(state), ...Object.keys(next)])) {
            if (!Object.is(next[key], state[key])) {
              state = next
              notify()
              return
            }
          }
        },
        set: (next) => { state = next; notify() },
      }
    }

    // 一层浅比较：用于判断服务端新解析出的对象是否与已存的等价。
    // 预设条目本身是扁平对象（人格字段 + updatedAt / builtin），所以一层足够。
    const shallowEqual = (a, b) => {
      if (a === b) return true
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
      const ka = Object.keys(a)
      const kb = Object.keys(b)
      if (ka.length !== kb.length) return false
      return ka.every((key) => Object.is(a[key], b[key]))
    }

    // 预设库是「库 → 条目」两层结构，需要逐条目比。
    const samePersonas = (a, b) => {
      if (a === b) return true
      if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false
      const ka = Object.keys(a)
      const kb = Object.keys(b)
      if (ka.length !== kb.length) return false
      return ka.every((key) => shallowEqual(a[key], b[key]))
    }

    // 变更记录只在「追加一条」或「被清空」时变化，两者的**id 序列**都不一样 ——
    // 所以逐条深比是白费力气（每条含 before/after/personas，深比一次的代价远超收益）。
    // 比 id 序列足够，且顺带覆盖了「压实后旧条目被淘汰」这种变化。
    const sameHistory = (a, b) => {
      if (a === b) return true
      if (!Array.isArray(a) || !Array.isArray(b)) return false
      if (a.length !== b.length) return false
      return a.every((item, index) => item && b[index] && item.id === b[index].id)
    }

    function hostBase() {
      const origin = globalThis.location?.origin
      return origin !== void 0 && origin !== 'null' ? origin : 'http://dsh.internal'
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // -------------------------------------------------------------------------
    // 输入框光轨：渲染层
    // -------------------------------------------------------------------------
    //
    // 匀速原理：沿「卡片边缘」画一个 SVG 圆角矩形，pathLength 归一化到 100，
    // 用 stroke-dashoffset 线性动画推进 —— 按弧长运动，圆角与直边线速度一致
    // （旋转 conic-gradient 的角速度恒定，但周长线速度会随位置变化，故不采用）。
    // 渐隐拖尾：8 层等长 dash 依次错位叠加、透明度递减 —— 头部各层重叠最亮，
    // 向后剩余层数递减形成拖尾；所有层共用同一时长，整体仍严格匀速。
    // 与边框重合：stroke 中心线落在宿主边框盒边缘；外半圈由「外扩盒」容纳
    // （见 TRAIL_PAD），不再依赖 overflow:visible；光轨开启时隐藏宿主自身细边框，
    // 保证边界上只有一条线。
    //
    // ⚠️ 隔离不变量（v0.6.2 修复 issue #2 的尺寸正反馈环）：
    // 环是「写在宿主内部、尺寸随宿主变化」的绝对定位元素。一旦它进入宿主布局流
    // （例如类规则里的 position:absolute 被第三方皮肤/主题的更具体选择器或
    // !important 覆盖），就会闭合成环：卡片变高 → ResizeObserver → 按新尺寸改写
    // SVG → 元素自身再变高 → 卡片再变高 → …（实测 60 次 sync 即可把 134px 撑到 9202px）。
    // 故本实现用三层独立手段保证它绝不参与宿主的任何尺寸测量：
    //   1) 挂载点优先选卡片内那个 `position:absolute;height:0` 的 overlay 锚点 ——
    //      锚点高度写死为 0，环即使退回常规流也撑不动卡片；
    //   2) 关键几何（position/left/top/width/height/contain）全部内联 ——
    //      内联样式只可能被 !important 击败，比单类选择器可靠得多；
    //   3) contain:strict（含 size/layout/paint）+ 墨迹全部收进自身盒内，
    //      尺寸、布局、绘制都与外部彻底隔离。

    const TRAIL_DASH = 12
    const TRAIL_LAYERS = 8
    const TRAIL_LAYER_STEP = 2.2
    const TRAIL_RADIUS = 22
    const TRAIL_COLOR_FALLBACK = '#679EFE'
    const TRAIL_PRESET_COLORS = ['#679EFE', '#22C55E', '#EF4444', '#A855F7', '#06B6D4', '#F59E0B']
    const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
    const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
    const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']
    // 最粗描边（4px）的一半：环的外盒比宿主边框盒每边外扩这么多，
    // 好让描边的外半圈也落在 SVG 自己的盒内（contain:paint 会按盒裁切）。
    // 这样就不需要 overflow:visible —— 墨迹不再外溢，不可能被祖先的 scrollHeight 计入。
    const TRAIL_PAD = 2
    // 失控熔断：输入框卡片不可能达到这个量级；命中即停止同步并隐藏，防止未知宿主
    // 测高逻辑把环拖进任何残余的正反馈（正常路径下永不触发）。
    const TRAIL_MAX_SIDE = 20000

    // 颜色容错：输入中途（如只打了 #6）回退到默认色，避免示例与提示丢失；
    // 统一大写，与宿主归一化结果及调色板取值一致
    function safeTrailColor(value) {
      if (typeof value !== 'string') return TRAIL_COLOR_FALLBACK
      const text = value.trim()
      return TRAIL_COLOR_PATTERN.test(text) ? text.toUpperCase() : TRAIL_COLOR_FALLBACK
    }

    function createSvgNode(tag, attrs) {
      const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
      for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value)
      return node
    }

    // 构建拖尾环；层数、dash 长度与错位步长与 CSS 中的 keyframes 一一对应
    function buildTrailSvg() {
      const svg = createSvgNode('svg', { class: 'soul-trail-svg', 'aria-hidden': 'true' })
      for (let layer = 0; layer < TRAIL_LAYERS; layer++) {
        svg.appendChild(createSvgNode('rect', {
          class: 'soul-trail-layer',
          'data-layer': String(layer),
          fill: 'none',
          pathLength: '100',
          'stroke-dasharray': `${TRAIL_DASH} ${100 - TRAIL_DASH}`,
          'stroke-dashoffset': String(layer * TRAIL_LAYER_STEP)
        }))
      }
      return svg
    }

    // 环外盒相对挂载锚点的偏移。锚点的 padding box 原点与宿主的 padding box 原点重合，
    // 因此左/上各再减「宿主边框宽度 + TRAIL_PAD」，才能把外盒对到宿主边框盒上。
    function trailBoxOffset(host) {
      let borderLeft = 0
      let borderTop = 0
      try {
        const style = typeof globalThis.getComputedStyle === 'function' ? globalThis.getComputedStyle(host) : null
        if (style) {
          borderLeft = parseFloat(style.borderLeftWidth) || 0
          borderTop = parseFloat(style.borderTopWidth) || 0
        }
      } catch {
        // 取不到计算样式就按无边框处理（DSH 输入框卡片 border:0）
      }
      return { left: -borderLeft - TRAIL_PAD, top: -borderTop - TRAIL_PAD }
    }

    // 让环与宿主「边框盒」逐像素对齐：外盒 = 宿主边框盒 + TRAIL_PAD×2，
    // viewBox 以像素为单位，描边中心线因此正好压在宿主边框盒边缘；
    // 圆角半径与宿主输入框卡片一致。尺寸未变时不重复写（避免多余样式写入）。
    function sizeTrailSvg(svg, host, width, height) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false
      const boxWidth = width + TRAIL_PAD * 2
      const boxHeight = height + TRAIL_PAD * 2
      const offset = trailBoxOffset(host)
      const key = `${width}x${height}@${offset.left},${offset.top}`
      if (svg.dataset.trailKey === key) return false
      svg.dataset.trailKey = key
      svg.style.left = `${offset.left}px`
      svg.style.top = `${offset.top}px`
      svg.style.width = `${boxWidth}px`
      svg.style.height = `${boxHeight}px`
      svg.setAttribute('viewBox', `0 0 ${boxWidth} ${boxHeight}`)
      for (const rect of svg.querySelectorAll('.soul-trail-layer')) {
        rect.setAttribute('x', String(TRAIL_PAD))
        rect.setAttribute('y', String(TRAIL_PAD))
        rect.setAttribute('width', String(width))
        rect.setAttribute('height', String(height))
        rect.setAttribute('rx', String(TRAIL_RADIUS))
      }
      return true
    }

    // 在卡片内解析环的挂载点：必须是卡片内一个「零高度容器」——DSH composer 的
    // .overlayAnchor 与设置页示例的 .soul-trail-anchor 都是这个形态。零高度容器
    // 即便环退回常规流也撑不动卡片（issue #2 的第一层隔离），且其 padding box 原点
    // 与卡片的 padding box 原点重合，环才能与卡片边框盒对齐。
    // 两种落点：
    //   1) anchor 本身就是卡片的直接子元素（设置页示例）→ 就是它；
    //   2) anchor 渲染在卡片内的某个容器里（线上：conversation.input.overlay 槽位
    //      把组件挂在 DSH 的 .overlayAnchor 内）→ 取「anchor 的、作为卡片直接子元素的祖先」。
    // 判据只看 DOM 结构、不看计算样式：样式表失效恰恰是最需要零高挂载点的时刻，
    // 那种场景下 anchor 的计算样式反而不可信。两者都不满足时退回卡片本身，
    // 由内联 position/contain 兜底。
    function resolveTrailMountPoint(card, anchor) {
      if (anchor && anchor.parentElement === card) return anchor
      const parent = anchor && anchor.parentElement
      if (!parent) return card
      let node = parent
      while (node !== card && node.parentElement && node.parentElement !== card) node = node.parentElement
      if (node !== card && node.parentElement === card) return node
      return card
    }

    // 把环挂到宿主卡片（内部锚点）上并跟随宿主尺寸变化；返回 { svg, setVisible, unmount }
    function mountTrailRing(host, anchor) {
      const svg = buildTrailSvg()
      // 关键几何内联：position 若被样式表覆盖，环会退回常规流并触发尺寸正反馈环，
      // 后果是整页布局被撑爆，因此不能只依赖类规则（见渲染层「隔离不变量」注释）
      svg.style.cssText = [
        'position:absolute',
        'display:none',
        'pointer-events:none',
        'contain:strict',
        'overflow:hidden',
        'margin:0',
        'padding:0',
        'border:0',
        'transform:none',
        'animation:none',
        'max-width:none',
        'max-height:none'
      ].join(';')
      ;(anchor || host).appendChild(svg)

      let stopped = false
      let observer = null
      let geometryChecked = false

      // 停用并留下线索：与其画出巨大错位的图形或拖垮布局，不如安静退出
      const disable = (reason) => {
        stopped = true
        svg.style.display = 'none'
        if (observer) observer.disconnect()
        if (typeof console !== 'undefined' && typeof console.warn === 'function') {
          console.warn(`[dsh-soul] 已停用输入框光轨：${reason}`)
        }
      }

      const sync = () => {
        if (stopped) return
        // 用 offsetWidth/Height（边框盒）而非 clientWidth/Height（内边距盒），
        // 环才能与宿主边框盒对齐
        const width = host.offsetWidth
        const height = host.offsetHeight
        if (width > TRAIL_MAX_SIDE || height > TRAIL_MAX_SIDE) {
          disable('输入框尺寸异常（疑似尺寸正反馈）')
          return
        }
        if (!sizeTrailSvg(svg, host, width, height)) return
        if (geometryChecked) return
        geometryChecked = true
        // 自检：样式表若用更具体的选择器或 !important 把 position 改回常规流，
        // 环就会重新参与宿主排版（这正是 issue #2 的成因），此时主动停用
        if (typeof globalThis.getComputedStyle !== 'function') return
        let position = 'absolute'
        try {
          position = globalThis.getComputedStyle(svg).position
        } catch {
          return
        }
        if (position !== 'absolute') disable(`光轨样式被第三方样式表覆盖（position: ${position}）`)
      }

      sync()
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(sync)
        observer.observe(host)
      } else if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('resize', sync)
      }
      // 首帧同步就可能已判定停用（尺寸异常 / 样式被覆盖），此时不必再观察
      if (stopped && observer) observer.disconnect()

      // 显隐也走内联：不只依赖 `[data-soul-trail="off"]` 类规则，
      // 样式表被覆盖时不至于把环留在页面上
      const setVisible = (visible) => {
        if (stopped) return
        svg.style.display = visible ? 'block' : 'none'
      }

      return {
        svg,
        setVisible,
        unmount: () => {
          stopped = true
          if (observer) observer.disconnect()
          else if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', sync)
          svg.remove()
        }
      }
    }

    var SoulController = class {
      constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher
        this.store = createSnapshotStore(INITIAL)
        this.disposed = false
        // 外部轮询的暂停标记（由设置页在「有未保存编辑」时置位）。
        //
        // 为什么放在 controller 上而不是组件 state：轮询已从设置页组件**上移到
        // apply()**（见那里的注释），装配层读不到组件的 dirty/saving。而「编辑中
        // 不覆盖用户输入」这条语义仍必须保留，所以在共享的 controller 上开一个口。
        this.paused = false
      }

      // 是否允许外部轮询写入 store
      canRefresh() {
        return !this.disposed && !this.paused
      }

      // 把服务端返回的完整配置映射进 store
      applyConfig(s, config) {
        s.enabled = config.enabled
        s.nickname = config.nickname || ''
        s.occupation = config.occupation || ''
        s.bio = config.bio || ''
        s.style = config.style
        s.headingLists = config.headingLists || 'default'
        s.emoji = config.emoji || 'default'
        s.tables = config.tables || 'default'
        s.replyLength = config.replyLength || 'normal'
        s.language = config.language || 'zh'
        s.customInstructions = config.customInstructions
        s.requireToolConfirmation = config.requireToolConfirmation === true
        s.trailEnabled = config.trailEnabled !== false
        s.trailColor = config.trailColor || TRAIL_COLOR_FALLBACK
        s.trailSpeed = config.trailSpeed || 'slow'
        s.trailWidth = config.trailWidth || 'thin'
        // 变更记录保留条数：服务端 migrate 已夹取到 50–500，这里只兜「缺席」
        s.historyMaxEntries = Number.isFinite(config.historyMaxEntries) ? config.historyMaxEntries : 200
      }

      async loadConfig() {
        if (this.disposed) return
        // 开始读取就清掉上一次的错误；此前还写了一个 s.loading，但全客户端零处读取
        // （设置页首帧直接显示 INITIAL 默认值），属于只写不读的死状态，已删。
        this.store.update(s => { s.error = null })

        try {
          const payload = await this.postJSON('/api/soul/config', null, { method: 'GET' })
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            // 两类问题分开上报、合到同一条提示里：
            //   configError     —— 磁盘配置读不出来（回退默认值，写入被拒）
            //   deliveryWarning —— 配置送不到活动会话（agents 服务不可用等）
            // 两者表面症状都是「改了人设不生效」，所以都要让用户看得见。
            s.error = typeof payload.configError === 'string'
              ? payload.configError
              : (typeof payload.deliveryWarning === 'string' ? payload.deliveryWarning : null)
          })
        } catch (error) {
          if (this.disposed) return
          this.store.update(s => {
            s.error = messageOf(error)
          })
        }
      }

      async saveConfig(config) {
        if (this.disposed) return
        this.store.update(s => { s.saving = true; s.error = null })

        try {
          const payload = await this.postJSON('/api/soul/config', config)
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            // 保存成功也可能带着送达警告（配置写下了但送不到会话）
            s.error = typeof payload.deliveryWarning === 'string' ? payload.deliveryWarning : null
            s.saving = false
          })
          return payload
        } catch (error) {
          if (this.disposed) return
          this.store.update(s => {
            s.saving = false
            s.error = messageOf(error)
          })
        }
      }

      async resetConfig() {
        if (this.disposed) return
        this.store.update(s => { s.saving = true; s.error = null })

        try {
          const payload = await this.postJSON('/api/soul/config/reset')
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            s.error = typeof payload.deliveryWarning === 'string' ? payload.deliveryWarning : null
            s.saving = false
          })
          return payload
        } catch (error) {
          if (this.disposed) return
          this.store.update(s => {
            s.saving = false
            s.error = messageOf(error)
          })
        }
      }

      // 人设预设：列表 / 保存 / 使用 / 删除
      async fetchPersonas() {
        return await this.postJSON('/api/soul/personas', null, { method: 'GET' })
      }

      // 拉取预设列表并写入 store。
      //
      // 从 SoulSettings 组件**下沉**到这里：全局轮询（apply 层）与设置页都要用它，
      // 逻辑留在组件里会导致装配层无法调用、只能重写一遍 ⇒ 两套写 store 的代码。
      async loadPersonas() {
        if (this.disposed) return
        try {
          const payload = await this.fetchPersonas()
          this.store.update((s) => {
            // 内容相同就保留旧引用：每 2s 轮询都会重新解析出**新对象**，若直接赋值，
            // store 的浅比较永远判为「变了」⇒ 去重失效，整页仍每 2s 白重渲染。
            s.personas = samePersonas(s.personas, payload.personas) ? s.personas : payload.personas
            s.activePersona = payload.activeName
            // 拉取成功：清掉上一次的失败痕迹（否则失败后即便恢复，提示会一直挂着）
            s.personasError = null
          })
        } catch (err) {
          // 预设列表加载失败不打断主配置界面 —— 但必须**留下痕迹**：
          // 否则 personas 永远是 null，摘要与面板一直显示「加载中...」，
          // 与「真的还没有预设」无从区分，也没有任何失败提示。
          this.store.update((s) => {
            s.personasError = messageOf(err)
          })
        }
      }

      // draft（可选）：设置页**还没保存**的草稿字段（0.9.0-r）。
      // 不带它的话，用户改完表单直接点「存为预设」会存下旧配置（实测过的 bug）。
      async savePersona(name, draft = null) {
        const body = { name }
        if (draft && typeof draft === 'object') body.draft = draft
        return await this.postJSON('/api/soul/personas/save', body)
      }

      async usePersona(name) {
        const payload = await this.postJSON('/api/soul/personas/use', { name })
        if (!this.disposed) {
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            // 清掉上一轮的失败提示：该端点不返回 deliveryWarning，此前一旦上一轮
            // 保存失败过，切预设成功后红色错误条会一直挂着。
            s.error = null
          })
        }
        return payload
      }

      async deletePersona(name) {
        return await this.postJSON('/api/soul/personas/delete', { name })
      }

      // —— 变更记录（0.8.0）——
      async fetchHistory() {
        return await this.postJSON('/api/soul/history', null, { method: 'GET' })
      }

      // 拉取记录并写入 store。
      //
      // 与 loadPersonas 同款：失败必须留下痕迹，否则界面永远停在「加载中」，
      // 与「真的还没有记录」无从区分 —— 而「到底有没有记录」正是这一组的全部意义。
      async loadHistory() {
        if (this.disposed) return
        try {
          const payload = await this.fetchHistory()
          this.store.update((s) => {
            // 内容相同就保留旧引用，理由同 loadPersonas：每 2s 轮询都会解析出**新数组**，
            // 直接赋值会让 store 的浅比较永远判「变了」，整页白重渲染。
            const next = Array.isArray(payload.entries) ? payload.entries : []
            s.history = sameHistory(s.history, next) ? s.history : next
            // warning 是「记录可能不完整」，不是失败：不写进 historyError，
            // 否则界面会把「只显示了最近 1000 条」报成红色错误。
            s.historyWarning = payload.warning ? String(payload.warning) : null
            s.historyMax = Number.isFinite(payload.max) ? payload.max : s.historyMax
            s.historyError = null
          })
        } catch (err) {
          this.store.update((s) => {
            s.historyError = messageOf(err)
          })
        }
      }

      // 撤销：把配置退回到目标记录**发生之前**。
      //
      // 409（diverged）与 400（找不到 / 记录被压实淘汰）都是**预期内的拒绝**，
      // 不是网络故障 —— 直接把服务端文案抛给调用方，由界面原样展示。
      // 服务端已经把原因写得能读懂（「记录与当前配置对不上，可能有人手工改过配置文件」），
      // 这里再包一层「撤销失败：...」只会把关键信息埋起来。
      async rollbackHistory(id) {
        const payload = await this.postJSON('/api/soul/history/rollback', { id })
        if (!this.disposed) {
          this.store.update((s) => {
            this.applyConfig(s, payload.config)
            s.error = null
          })
        }
        return payload
      }

      async restorePersona(id) {
        const payload = await this.postJSON('/api/soul/history/restore-persona', { id })
        if (!this.disposed) {
          this.store.update((s) => {
            this.applyConfig(s, payload.config)
            s.error = null
          })
        }
        return payload
      }

      async clearHistory() {
        return await this.postJSON('/api/soul/history/clear')
      }

      // —— 工作区绑定（0.8.1）——
      async fetchBindings() {
        return await this.postJSON('/api/soul/bindings', null, { method: 'GET' })
      }

      // 把服务端返回的绑定视图整块写进 store。
      //
      // 绑定的每个字段都是「服务端说了算」：失效引用由服务端按当前预设库算出，
      // sessions 的生效人设由服务端走与真实装配同一条解析路径得出。客户端只负责
      // 原样保留 —— 自己再算一遍只会有两种结果：算对了白算，算错了两个地方打架。
      applyBindings(s, payload) {
        // bindings 是**对象**（目录 → 人设名），不是数组 —— 服务端 bindingsView
        // 直接透传 soul-bindings.json 的映射。上一版这里写的是 Array.isArray 兜底，
        // 一旦为假就会把整张表静默吞成空：界面显示「还没有绑定任何目录」而文件里
        // 其实有。故按对象判，且**缺字段时保留旧值**而不是清空。
        const raw = payload.bindings
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) s.bindings = raw
        else if (raw === null || Array.isArray(raw)) s.bindings = {}
        s.bindingsInvalid = Array.isArray(payload.invalid) ? payload.invalid : []
        s.bindingsDropped = Number.isFinite(payload.dropped) ? payload.dropped : 0
        // warning 是「看到的不是全部」，不是失败，所以不写进 bindingsError
        s.bindingsWarning = payload.warning ? String(payload.warning) : null
        s.bindingsMax = Number.isFinite(payload.max) ? payload.max : s.bindingsMax
        s.bindingsMaxPath = Number.isFinite(payload.maxPathLength)
          ? payload.maxPathLength
          : s.bindingsMaxPath
        s.bindingsSessions = Array.isArray(payload.sessions) ? payload.sessions : []
      }

      // 拉取绑定视图并写 store。
      //
      // 失败必须留下痕迹（同 loadHistory）：界面停在「加载中」与「确实没有绑定」
      // 长得一样，而这一组的全部意义就是回答「我这个项目现在是谁」。
      async loadBindings() {
        if (this.disposed) return
        try {
          const payload = await this.fetchBindings()
          this.store.update((s) => {
            this.applyBindings(s, payload)
            s.bindingsError = null
          })
        } catch (err) {
          this.store.update((s) => {
            s.bindingsError = messageOf(err)
          })
        }
      }

      // 新增或改绑一个目录。写成功的结果里带回完整视图，直接铺进 store，
      // 省掉一次「写完立刻再拉一遍」的往返。
      async saveBinding(dir, persona) {
        const payload = await this.postJSON('/api/soul/bindings', { dir, persona })
        if (!this.disposed) {
          this.store.update((s) => {
            this.applyBindings(s, payload)
            s.bindingsError = null
          })
        }
        return payload
      }

      async removeBinding(dir) {
        const payload = await this.postJSON('/api/soul/bindings/delete', { dir })
        if (!this.disposed) {
          this.store.update((s) => {
            this.applyBindings(s, payload)
            s.bindingsError = null
          })
        }
        return payload
      }

      // —— 会话级覆盖（0.9.0-d）——
      //
      // 与绑定刻意分开：会话覆盖是**状态**（随会话生灭），绑定是**配置**。
      // 因此这里不写 store 的全局字段，由调用组件自己持有结果 —— 一份覆盖只对
      // 它所属的那个会话有意义，塞进全局 store 会让两个会话的 tab 互相串味。
      async fetchSessionScope(sessionId) {
        const query = `?sessionId=${encodeURIComponent(sessionId)}`
        return await this.postJSON(`/api/soul/session-scope${query}`, null, { method: 'GET' })
      }

      // 当前会话的作用域（生效人设 + 来源层级）。与 fetchSessionScope 同源，
      // 但走固定路径：这个端点给「输入框下方的标签」用 —— 它在会话外，
      // 拿不到 sessionId，只能由宿主通过 scope:'session' 槽位的标准 props 传进来。
      async fetchCurrentSessionScope(sessionId) {
        const query = `?sessionId=${encodeURIComponent(sessionId)}`
        return await this.postJSON(`/api/soul/session-scope/current${query}`, null, { method: 'GET' })
      }

      // personaName：用户实际点的预设名。一并提交，服务端把它记进 sidecar ——
      // 否则「当前生效的是哪个预设」只能靠字段反查，而反查在多个预设字段相同时不确定。
      // 写 store：会话作用域变了 → 所有看它的人（header 标签、会话 tab）一起刷新。
      //
      // 不可变更新（新建对象）—— store 是浅比较，原地改同一个对象不会触发订阅者。
      setSessionScope(sessionId, scope) {
        if (this.disposed) return
        this.store.update((s) => {
          s.sessionScopes = { ...s.sessionScopes, [String(sessionId)]: scope }
        })
      }

      async saveSessionScope(sessionId, overrides, personaName = null) {
        const body = { sessionId, overrides }
        if (typeof personaName === 'string' && personaName !== '') body.personaName = personaName
        const payload = await this.postJSON('/api/soul/session-scope', body)
        // 服务端已经回了解析结果（activePersona / source / workspaceTitle）——
        // 直接落进 store，header 标签立刻就是新值，不必再发一次请求。
        if (payload && typeof payload === 'object') {
          this.setSessionScope(sessionId, {
            activePersona: typeof payload.activePersona === 'string' ? payload.activePersona : null,
            recordedPersona: typeof payload.recordedPersona === 'string' ? payload.recordedPersona : null,
            globalPersona: typeof payload.globalPersona === 'string' ? payload.globalPersona : null,
            source: typeof payload.source === 'string' ? payload.source : null,
            workspaceId: payload.workspaceId || null,
            workspaceTitle: typeof payload.workspaceTitle === 'string' ? payload.workspaceTitle : null,
            override: payload.override || null
          })
        }
        return payload
      }

      async clearSessionScope(sessionId) {
        const payload = await this.postJSON('/api/soul/session-scope', { sessionId, clear: true })
        if (payload && typeof payload === 'object') {
          this.setSessionScope(sessionId, {
            activePersona: typeof payload.activePersona === 'string' ? payload.activePersona : null,
            recordedPersona: null,
            globalPersona: typeof payload.globalPersona === 'string' ? payload.globalPersona : null,
            source: typeof payload.source === 'string' ? payload.source : null,
            workspaceId: payload.workspaceId || null,
            workspaceTitle: typeof payload.workspaceTitle === 'string' ? payload.workspaceTitle : null,
            override: null
          })
        }
        return payload
      }

      // —— 工作区人设（0.9.0-e）——
      //
      // 与绑定、会话覆盖都不同：工作区列表是**宿主**的，插件只能列与改，
      // 不能增删（那是侧边栏的职责）。所以这里只有读 + 绑定/解绑。
      async fetchWorkspaces() {
        return await this.postJSON('/api/soul/workspaces', null, { method: 'GET' })
      }

      async saveWorkspacePersona(workspaceId, persona) {
        return await this.postJSON('/api/soul/workspaces', { workspaceId, persona })
      }

      async removeWorkspacePersona(workspaceId) {
        return await this.postJSON('/api/soul/workspaces/delete', { workspaceId })
      }

      // —— 会话覆盖清理（0.9.0-f）——
      //
      // 默认 dry-run：不传 apply 就**绝不会删**。真删必须显式 apply:true ——
      // 这个默认值站在"不删"那一侧，因为删除不可逆。
      async scanSessionScopeGc() {
        return await this.postJSON('/api/soul/session-scope/gc', {})
      }

      async applySessionScopeGc() {
        return await this.postJSON('/api/soul/session-scope/gc', { apply: true })
      }

      // 统一请求：body 为 null 时不携带请求体（GET 用）
      async postJSON(path, body, overrides = {}) {
        const url = new URL(path, hostBase())
        const init = { method: overrides.method || 'POST', ...overrides }
        if (body !== null && body !== undefined) {
          init.headers = { 'content-type': 'application/json' }
          init.body = JSON.stringify(body)
        }
        const response = await this.fetcher(url, init)
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.error || `HTTP ${response.status}`)
        }
        return payload
      }

      // 读取当前生效（已保存）的提示词：{ ok, prompt, enabled }
      async fetchPrompt() {
        const payload = await this.postJSON('/api/soul/prompt', null, { method: 'GET' })
        return payload
      }

      // 预览「未保存的编辑」编译出的提示词：POST 草稿字段，服务端以已保存配置为底
      // 覆盖后编译。不落盘、不影响生效提示词 —— 返回的 invalid 列出未通过校验、因而未计入
      // 预览的字段名，供界面如实提示，避免用户以为改动已生效。
      async previewPrompt(draft) {
        const payload = await this.postJSON('/api/soul/prompt/preview', draft)
        return payload
      }

      async dispose() {
        this.disposed = true
      }
    }

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      // —— 与宿主设置页对齐的栏目容器 ——
      // 宿主其余栏目（models / plugins / plugin-inventory）都不用外框：内容直接落在
      // 设置页 options 容器自带的 `padding:0 24px 24px` 里，靠 `max-width` 限制行长，
      // 分组则用「卡片」表达（.5px 边框 + settings-card-* + radius-xl）。
      // 我们此前是 `.soul-section{margin:24px 0;padding:20px;border:1px;radius:8px}`
      // —— 等于在宿主内边距里又套了一层盒子，是观感不统一最直接的原因，故整层去掉。
      '.soul-section{display:flex;flex-direction:column;gap:12px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}',
      // 标题：与宿主栏目标题同规格（16px / 500 / lh24，不是 600）
      '.soul-section h3{margin:0;font-size:16px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary)}',
      '.soul-title-row{display:flex;align-items:baseline;justify-content:space-between;gap:12px;min-width:0}',
      '.soul-version{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px;white-space:nowrap}',
      // 字段：宿主用 12px / 500 / lh18 的字段标签 + 8px 间距
      '.soul-field{margin-bottom:14px;width:100%}',
      '.soul-field label{display:block;margin-bottom:8px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // 与上面的 label 同形，但用于「没有对应控件」的分组标题（如光轨示例预览）：
      // 那种位置写 <label> 会是一个指向空的标签，语义错误
      '.soul-field-label{display:block;margin-bottom:8px;font-size:12px;font-weight:500;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // 控件：边框换宿主卡片描边色、圆角用 sm(8px)，与宿主输入控件一致
      '.soul-field select,.soul-field textarea,.soul-field input[type=text]{width:100%;padding:8px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;box-sizing:border-box}',
      '.soul-field select option{color:var(--dsw-alias-label-primary)}',
      '.soul-section{color-scheme:light}',
      'body[data-ds-dark-theme] .soul-section{color-scheme:dark}',
      '.soul-field select{color-scheme:light}',
      'body[data-ds-dark-theme] .soul-field select{color-scheme:dark}',
      '.soul-field textarea{min-height:120px;resize:vertical}',
      '.soul-field textarea.soul-textarea-sm{min-height:72px}',
      // 组标题：宿主用 15px/600 的小标题，这里对齐并去掉下边框（宿主分组靠卡片分隔，不靠横线）
      '.soul-group-title{margin:4px 0 0 0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}',
      // 折叠分组＝宿主卡片：.5px 描边 + card-fill + radius-xl + overflow hidden
      // 刻意不用 overflow:hidden 裁子元素圆角：那会把「向上弹出」的 .soul-hint-tip
      // 在跨出分组上边界时切掉顶部（实测复现：Agent 工具分组的提示是该分组第一个
      // 元素，上方只有 14px 内边距，而提示高约 60px，必然越界被裁）。
      // 改为给触发器补顶圆角，让 hover 背景自己贴合 —— 视觉等价且不裁剪。
      '.soul-accordion{margin:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.soul-accordion-open{position:relative;z-index:20}',
      // 顶圆角补偿：容器不再裁剪，触发器的 hover 背景需自己贴合外层圆角
      // （半径为外层圆角减去 0.5px 边框）。展开时底边保持直角，与 body 的分隔线相接。
      '.soul-accordion-trigger{display:flex;align-items:center;width:100%;min-height:44px;gap:10px;padding:10px 14px;border:0;border-radius:calc(var(--dsw-radius-xl) - .5px) calc(var(--dsw-radius-xl) - .5px) 0 0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background-color .15s ease}',
      '.soul-accordion-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-accordion-title{flex:0 0 auto;font-size:14px;font-weight:500;line-height:22px}',
      '.soul-accordion-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400;line-height:18px}',
      '.soul-accordion-icon{flex:0 0 18px;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;text-align:center}',
      // 收起态只有触发器一个子元素 ⇒ 四角都要圆（展开态由上面的顶圆角规则负责）
      '.soul-accordion:not(.soul-accordion-open) .soul-accordion-trigger{border-radius:calc(var(--dsw-radius-xl) - .5px)}',
      // 折叠标题旁的问号提示已取消（说明改放展开区内的 .soul-note）：
      // head 层随之删除 —— 触发器恢复成 section 的直接子元素，无需 flex 包裹。
      '.soul-accordion-body{padding:14px;border-top:.5px solid var(--dsw-alias-settings-card-stroke);background:transparent}',
      '.soul-field select:focus,.soul-field textarea:focus,.soul-field input[type=text]:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent)}',
      '.soul-toggle{display:flex;align-items:center;gap:8px;margin-bottom:14px}',
      '.soul-toggle label{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.soul-buttons{display:flex;gap:8px;margin-top:2px}',
      // 允许换行、不裁切。
      //
      // 为什么必须改容器（而不只是放宽 max-width）：
      // · white-space:nowrap 让整串强制一行 —— 输入框左侧空间有限，必然溢出；
      // · overflow:hidden 把溢出部分**直接裁掉** —— 这就是「展示不全」的直接原因；
      // · inline-flex + align-items:center 在多行时也对不齐。
      //
      // max-width:min(100%, 22em) 给个上限：太长的自定义预设名不至于把整条输入框撑开。
      // overflow:hidden 是**扫光特效的裁切边界**，不能去掉：
      // 扫光（::before）从 translateX(100%) 扫到 translateX(-100%)，两端都会超出按钮。
      //
      // ⚠️ 0.9.0-g 为了让文字完整显示曾把它去掉 —— 结果特效溢出到按钮外面。
      // 两者并不真正冲突：文字现在允许换行且有 max-width 上限，**不会溢出**内容盒；
      // 真正溢出的只有扫光伪元素。所以 overflow:hidden 裁的是扫光，不裁文字。
      '.soul-quick-toggle{position:relative;isolation:isolate;display:inline-flex;align-items:center;flex-wrap:wrap;gap:2px 6px;min-height:28px;max-width:min(100%,22em);overflow:hidden;padding:4px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:normal}',
      '.soul-quick-toggle:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-quick-toggle[data-enabled="true"]{color:var(--dsw-alias-brand-primary)}',
      '.soul-quick-toggle[data-enabled="true"]:hover{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-error-primary) 18%,transparent)}',
      '.soul-quick-toggle[data-enabled="false"]:hover{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent)}',
      '.soul-quick-toggle[data-enabled="true"]:hover::before{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 24%,transparent);animation:soul-toggle-red-sweep .55s ease-out both}',
      '.soul-quick-toggle[data-enabled="false"]:hover::before{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 24%,transparent);animation:soul-toggle-green-sweep .55s ease-out both}',
      '.soul-quick-toggle::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;transform:translateX(100%)}',
      '.soul-quick-toggle > *{position:relative;z-index:1}',
      '.soul-quick-toggle-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.soul-quick-toggle[data-enabled="true"] .soul-quick-toggle-dot{background:var(--dsw-alias-state-success-primary);animation:soul-status-pulse 1.8s ease-in-out infinite}',
      // 保存失败：小圆点转红并停止脉冲（按钮文案不变，故必须靠颜色 + title/aria-label 反馈）
      // 注意：--dsw-alias-label-error **在宿主主题里不存在**（实测 var() 回退成继承色＝黑），
      // 宿主表达错误色统一用 --dsw-alias-state-error-primary，这里一并纠正。
      '.soul-quick-toggle[data-failed="true"]{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.soul-quick-toggle[data-failed="true"] .soul-quick-toggle-dot{background:var(--dsw-alias-state-error-primary);animation:none}',
      '.soul-quick-toggle:disabled{cursor:wait;opacity:.6}',
      '@keyframes soul-toggle-red-sweep{from{transform:translateX(100%)}to{transform:translateX(-100%)}}',
      '@keyframes soul-toggle-green-sweep{from{transform:translateX(100%)}to{transform:translateX(-100%)}}',
      '@keyframes soul-status-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,transparent);opacity:.75}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-success-primary) 0%,transparent);opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.soul-quick-toggle[data-enabled="true"] .soul-quick-toggle-dot{animation:none}.soul-quick-toggle[data-enabled="true"]:hover::before,.soul-quick-toggle[data-enabled="false"]:hover::before{animation:none;transform:none}}',
      // 快捷开关里追加的人设名（B）：同样单行省略，避免把底栏撑宽
      '.soul-quick-toggle-name{min-width:0;opacity:.85;overflow-wrap:anywhere}',
      // 来源层级标签（全局 / 工作区 / 本会话覆盖）：次要色小字，与人设名分开 ——
      // 它是注解不是主信息。max-width 限制它别把人设名挤掉。
      '.soul-quick-toggle-scope{flex:none;color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:14px;overflow-wrap:anywhere}',
      // —— 会话 header 的人设标签（0.9.0-h）——
      //
      // 规格抄宿主的 AgentPresetLabel（同一位置的「创造模式」标签）——
      // 但**底色 token 换掉了**：它用的 --dsw-alias-fill-tsp-secondary 在宿主主题里
      // **没有定义**（只被那个包自己引用，var() 会静默回退），抄过来就是抄一个失效值。
      // 这里用真实存在的 --dsw-alias-bg-module-platform。
      // 22px 高、次要底色、圆角、小字、inline-flex。
      // 宿主在窄容器时会把 header 标签隐藏（@container (width<=540px)），
      // 我们跟着做 —— 空间不够时宁可不显示，也不要挤坏标题行。
      '.soul-session-persona-label{display:inline-flex;align-items:center;gap:6px;max-width:min(100%,320px);height:22px;padding:0 8px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:22px;white-space:nowrap;overflow:hidden}',
      // hero 区（新会话行）的落点：与邻居（工作区 chip / 创造模式）同一行右对齐。
      // flex:none 防止被 chip 的 flex 收缩挤扁。
      '.soul-session-persona-label[data-in-hero="true"]{flex:none}',
      '.soul-session-persona-label-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      // 图标：与文字同色但略淡（图标是标识，文字是主信息）
      '.soul-session-persona-label-icon{flex:none;opacity:.75}',
      // 侧栏会话行 hover 面具徽标（0.9.0-ab）：与行内其它 hover 按钮对齐
      '.soul-sidebar-persona-badge{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-tertiary)}',
      '.soul-sidebar-persona-badge-icon{display:block}',
      '.soul-session-persona-label-scope{flex:none;font-size:11px;opacity:.8}',
      '@container (width<=540px){.soul-session-persona-label{display:none}}',
      // 错误提示：颜色改用宿主真实存在的 state-error-primary（原先引用不存在的 token ⇒ 渲染成黑色）
      '.soul-error{margin-top:8px;padding:10px 12px;background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05));border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;width:100%;box-sizing:border-box}',
      '.soul-hint{position:relative;display:inline-flex;align-items:center;margin-left:6px;color:var(--dsw-alias-label-secondary);cursor:help;vertical-align:middle}',
      '.soul-hint:hover{color:var(--dsw-alias-label-primary)}',
      '.soul-hint-tip{position:absolute;bottom:calc(100% + 8px);left:0;padding:8px 10px;background:var(--dsw-alias-bg-module-platform);border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);font-size:12px;font-weight:400;line-height:1.5;color:var(--dsw-alias-label-primary);white-space:normal;width:max-content;max-width:260px;text-align:left;opacity:0;visibility:hidden;transition:opacity .15s ease;pointer-events:none;z-index:9999;box-shadow:var(--dsw-shadow-lv3,0 4px 12px rgba(0,0,0,0.15))}',
      '.soul-hint:hover .soul-hint-tip{opacity:1;visibility:visible}',
      // 键盘聚焦同样要能拿到说明：只有 :hover 的话，键盘 / 读屏用户永远看不到提示
      '.soul-hint:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;border-radius:3px}',
      '.soul-hint:focus-visible .soul-hint-tip{opacity:1;visibility:visible}',
      '.soul-status{margin-top:6px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      // 说明块：一组「读到就够、不需要操作」的文字（预设收录范围 + 变更记录去哪了）。
      // 与 .soul-status 同排印，但允许多行分行 —— 多条说明挤成一段会像一句话里
      // 混了两件事。行距靠 line-height 自然撑开，不上边框（不是引用也不是分隔）。
      '.soul-note{margin-top:10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.soul-note > div + div{margin-top:2px}',
      // 一句话 + 一个问号：正文不再换行成段，问号挂在句子末尾（0.8.1 文案瘦身）。
      // align-items:baseline 让问号与 12px 文字同基线 —— 用 center 会让它看起来浮起来。
      '.soul-note-inline{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}',
      '.soul-note-text{min-width:0}',
      '.soul-dirty{color:var(--dsw-alias-state-warn-primary)}',
      // —— 人设预设：竖版卡牌 + 堆叠轮播 ——
      // 方案 B：插画是卡面主视觉（方形满铺），名称与摘要压在图上由渐变承接，
      // 效果与按钮在下方的白色信息区。卡牌竖版后「一次只见一张」的代价更大，
      // 因此保留位置指示、圆点与左右翻页（见 .soul-persona-nav）。
      '.soul-persona-carousel{position:relative;display:flex;flex-direction:column;gap:12px}',
      // 堆叠容器：卡牌绝对定位其中，容器高度固定 ⇒ 切换时不跳动。
      // 竖版卡牌高度 = 插画 260（等于卡宽的正方形）+ 信息区约 92 + 边框 ⇒ 取 372。
      // 左右留白不需要 padding：卡片以 margin:auto 居中，±92px 的两张展开后总宽约 430px，
      // 远小于容器宽度（设置页 max-width 760px），不会溢出。
      '.soul-persona-stack{position:relative;min-height:372px}',
      // 卡牌：固定宽度居中（left/right:0 + margin auto），靠 transform 做叠层位移与缩放。
      // top/bottom:0 让三张卡等高 —— 内容长短不同的卡片高度一致，堆叠才整齐。
      //
      // ⚠️ 卡片**不能**有 overflow:hidden：CSS 规范规定 overflow != visible 会强制
      //    transform-style: flat，3D 翻转会被压平。裁切职责已下沉到 .soul-persona-face
      //    （它带 overflow:hidden + border-radius:inherit，效果等价）。
      '.soul-persona-card{position:absolute;top:0;bottom:0;left:0;right:0;width:260px;margin:0 auto;display:flex;flex-direction:column;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08));box-sizing:border-box;font-size:12px;line-height:18px;transition:transform .3s cubic-bezier(.22,.61,.36,1),opacity .3s ease;transform-origin:center top;will-change:transform;perspective:1000px}',
      // —— 卡牌的两面（正面 = 卡面，背面 = 详情）：真 3D 翻转 ——
      //
      // 三层职责分离（这是能做真 3D 而不伤叠层几何的关键）：
      //   .soul-persona-card      叠层位置（translateX/Y/scale，内联）
      //   .soul-persona-flipper   翻到哪一面（rotateY 0 ↔ 180）
      //   .soul-persona-face-*    两个面各自的内容
      // 若把 rotateY 写进卡片，就要和叠层偏移合成同一个 transform 字符串 ⇒
      // 偏移几何变脆。
      //
      // ⚠️ perspective 已并入上面的 .soul-persona-card 规则（单条规则，便于断言核对）：
      //    它必须挂在**翻转元素的父级**（卡片）上才生效。
      '.soul-persona-card{perspective:1000px}',
      '.soul-persona-flipper{position:absolute;inset:0;transform-style:preserve-3d;transition:transform .5s cubic-bezier(.2,.7,.3,1);border-radius:inherit}',
      '.soul-persona-card[data-flipped="true"] .soul-persona-flipper{transform:rotateY(180deg)}',
      // 两个面：各自裁圆角 + 隐藏背面，构成标准 3D 翻转
      '.soul-persona-face{position:absolute;inset:0;display:flex;flex-direction:column;overflow:hidden;border-radius:inherit;backface-visibility:hidden;-webkit-backface-visibility:hidden;transition:opacity .18s ease}',
      // 整面可点（任意处点击翻到卡背）：cursor 提示可点性
      '.soul-persona-face-front{opacity:1}',
      // 当前卡整面可点翻背（cursor 提示）；叠层侧边卡的点击是翻页，不提示翻面
      '.soul-persona-card[data-current="true"]:not([data-flipped="true"]) .soul-persona-face-front{cursor:pointer}',
      // 背面预先转到 180°，随 flipper 一起转回正面
      // 卡背整面可点返回（与正面「整面点击翻到背面」对称）：cursor 提示可点。
      // 全文块单独覆盖为 text —— 那里是可选中的文字，光标形态要与之相符。
      '.soul-persona-face-back{gap:6px;padding:10px;box-sizing:border-box;transform:rotateY(180deg);opacity:1;cursor:pointer}',
      // 未翻面时背面整层不可点、也不被读屏念到（它虽被 backface 隐藏，但仍在树里）
      '.soul-persona-card:not([data-flipped="true"]) .soul-persona-face-back{pointer-events:none}',
      // 尊重「减少动态效果」：不做 3D 位移，直接切换
      '@media (prefers-reduced-motion:reduce){.soul-persona-flipper{transition:none}}',
      // 背面头部：名称 + 内置徽标。
      // 名称用 flex:0 1 auto（**不是** flex:1 1 auto）：后者会把它撑满整行，
      // 于是徽标与名称**重叠在同一位置**（实测：名称 [44,272]、徽标 [44,77]，
      // 视觉上徽标盖住了名称开头，看起来像被截成了「协作者」）。
      // 现在名称按内容取宽、仅在过长时收缩（min-width:0 + ellipsis 兜底），
      // 徽标 flex:none 紧随其后。
      '.soul-persona-back-head{display:flex;align-items:center;gap:6px;flex:none}',
      '.soul-persona-back-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;line-height:18px}',
      // 卡背里的徽标必须**重置定位**：.soul-persona-badge 为压在插画上而设了
      // position:absolute（见该规则），在卡背的 flex 行里它脱离流 ⇒ 与名称重叠
      // （实测：名称 [44,75]、徽标 [44,77]，视觉上徽标盖住名称开头）。
      // 这里改回 static 让它正常参与 flex 布局。
      '.soul-persona-back-head .soul-persona-badge{position:static;flex:none}',
      // 维度列表：label 左、值右，两列对齐
      '.soul-persona-dims{display:flex;flex-direction:column;gap:2px;flex:none}',
      '.soul-persona-dim{display:flex;align-items:baseline;justify-content:space-between;gap:8px;font-size:11px;line-height:16px}',
      '.soul-persona-dim span{flex:none;color:var(--dsw-alias-label-tertiary)}',
      '.soul-persona-dim b{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.soul-persona-back-label{flex:none;margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      // 全文：**不截断**（正面效果栏才截断）。
      // 滚动放在**这一块自己**身上（不是 face），这样「返回」按钮始终贴在卡底可见 ——
      // 实测把 overflow-y 放 face 上时，长文本会把按钮一起推出视野并被文字压住。
      // 需要的背景：卡片高度固定 372px，而实测 339 字占 272px（17 行 × 16px），
      // 加头部/维度/按钮后已无余量，稍长就必然要滚。
      '.soul-persona-fulltext{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;cursor:text;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:pre-wrap;word-break:break-word}',
      // 背面的「返回」：贴底按钮，做成描边式（不抢视觉，但必须好点）。
      //
      // ⚠️ 选择器必须带 .soul-persona-face-back 前缀（提高权重），不能只写
      // `.soul-persona-back-btn`：基类 `.soul-persona-action` 有 `flex:1 1 auto`，
      // 而两者都是单类选择器（权重相同）⇒ **后声明者胜**。本规则在源码里排在
      // 基类之前，于是基类的 flex:1 覆盖了这里的 flex:none —— 后果是自定义预设
      // 指令较短时，剩余空间把「返回」按钮**拉伸到 98px 高**（实测：短文本 98px
      // vs 长文本 21px）。加前缀后权重更高，与声明顺序无关。
      // 卡背底部按钮行：返回（弹性占满）+ 删除（自建卡才有，定宽）。
      // .soul-persona-back-btn 的 margin-top:auto 移到本行容器上 —— 按钮行整体贴底。
      '.soul-persona-back-actions{display:flex;align-items:center;gap:8px;flex:none;margin-top:auto}',
      '.soul-persona-back-btn{flex:1 1 auto}',
      // 删除在卡背是「次要管理操作」：定宽描边（armed 态复用正面同款变实心样式）
      '.soul-persona-back-del{flex:0 0 64px}',
      '.soul-persona-details{flex:0 0 auto;padding:0 10px;background:transparent;color:var(--dsw-alias-label-secondary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-settings-card-stroke);font-size:12px;font-weight:500}',
      '.soul-persona-details:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);filter:none}',
      // 插画区：正方形主视觉。非内置预设没有配套插画，用主题色渐变兜底
      // 所有卡片都出图（自建预设由宿主返回专用默认贴图）；图未就绪时露出渐变底。
      '.soul-persona-art{position:relative;width:100%;aspect-ratio:1/1;flex:none;overflow:hidden;background:linear-gradient(150deg,color-mix(in srgb,var(--dsw-alias-brand-primary) 22%,var(--dsw-alias-bg-module-platform)),var(--dsw-alias-bg-module-platform))}',
      '.soul-persona-art-img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;user-select:none}',
      // 底部渐变：让压在图上的名称/摘要有足够对比度（浅色插画上白字会糊）
      '.soul-persona-art-veil{position:absolute;inset:auto 0 0 0;height:62%;background:linear-gradient(180deg,rgba(10,14,35,0),rgba(10,14,35,.62) 55%,rgba(10,14,35,.86));pointer-events:none}',
      // 名称 + 摘要压在图底部
      '.soul-persona-art-title{position:absolute;left:12px;right:12px;bottom:10px;display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.soul-persona-name{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-static-neutral-bluish-00,#fff);font-size:14px;font-weight:600;line-height:20px}',
      '.soul-persona-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:0 1px 6px rgba(0,0,0,.5)}',
      // 作用域标注（全局）：小一号、半透明，跟在预设名后面 —— 注解而非主信息。
      '.soul-persona-scope-tag{flex:none;padding:0 5px;border-radius:999px;background:rgba(255,255,255,.18);color:inherit;font-size:9px;font-weight:600;line-height:14px;letter-spacing:.2px;opacity:.75}',
      '.soul-persona-meta{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-static-neutral-bluish-100,#d3dbf5);font-size:11px;line-height:16px;text-shadow:0 1px 6px rgba(0,0,0,.5)}',
      // 内置徽标：图上用半透明玻璃底（白底徽标在深色图上会太跳）
      '.soul-persona-badge{position:absolute;top:10px;left:10px;flex:none;padding:2px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.34);background:rgba(255,255,255,.2);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:10px;font-weight:600;line-height:14px;letter-spacing:.3px;backdrop-filter:blur(8px)}',
      // 位置指示：图上右上角的胶囊
      '.soul-persona-card-pos{position:absolute;top:10px;right:10px;padding:2px 7px;border-radius:999px;background:rgba(10,14,35,.5);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:10px;line-height:14px;font-variant-numeric:tabular-nums;backdrop-filter:blur(8px)}',
      // 信息区：效果说明 + 操作按钮
      '.soul-persona-body{display:flex;flex-direction:column;gap:8px;flex:1;min-height:0;padding:10px 12px 12px}',
      '.soul-persona-eff{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}',
      // 非当前卡片是「背景层」：可点击切过去，但不可抢注意力
      '.soul-persona-card[data-current="false"]{cursor:pointer}',
      // 「翻开」动画：切张时当前卡片轻微放大，给出卡牌被拨动的实感
      '.soul-persona-card[data-current="true"]{animation:soul-card-in .3s cubic-bezier(.22,.61,.36,1) both}',
      '@keyframes soul-card-in{from{opacity:.72;transform:translateX(0) scale(.96)}to{opacity:1;transform:translateX(0) scale(1)}}',
      // 位置指示与翻页：竖版卡牌一次只见一张，这三处是对该损失的补偿
      '.soul-persona-nav{display:flex;align-items:center;justify-content:center;gap:12px}',
      '.soul-persona-navbtn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;padding:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-settings-card-fill);color:var(--dsw-alias-label-secondary);font:inherit;font-size:16px;line-height:1;cursor:pointer;transition:background-color .15s ease,color .15s ease}',
      '.soul-persona-navbtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.soul-persona-navbtn:disabled{cursor:default;opacity:.3}',
      '.soul-persona-navbtn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-persona-dots{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;justify-content:center}',
      '.soul-persona-dot{width:6px;height:6px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-label-tertiary);opacity:.35;cursor:pointer;transition:opacity .15s ease,transform .15s ease}',
      '.soul-persona-dot[data-active="true"]{opacity:1;transform:scale(1.3);background:var(--dsw-alias-brand-primary)}',
      '.soul-persona-dot:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      // 操作区：固定宽度 + 两个等宽轨道，「使用」永远在第 1 轨、删除位永远在第 2 轨。
      // 间距对齐宿主 .zGbnIq_rowActions 的 gap:4px；margin-top:auto 让它贴卡片底部，
      // 于是不同摘要长度的卡片按钮仍对齐（堆叠容器高度固定，不会被内容撑变）。
      // 操作区：「使用」是卡牌主操作（要突出），弹性占满可用宽度；
      // 「删除」是次要破坏性操作，定宽小按钮，不抢主次。
      // 内置预设无删除 ⇒ 不渲染删除按钮，「使用」自然占满整行。
      '.soul-persona-actions{display:flex;align-items:center;gap:8px;margin-top:auto;padding-top:2px}',
      // 主按钮：走主题的主按钮色族（brand 底 + 反色前景）。
      // 为什么不再沿用「对齐宿主 linkButton」的 28px 透明底：那是**列表行**里的
      // 文字按钮规格，而卡牌的主操作需要更强的视觉权重（样张里也是实心主色按钮）。
      '.soul-persona-action{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;height:36px;padding:0 14px;border:0;border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);font:inherit;font-size:13px;font-weight:600;line-height:20px;cursor:pointer;white-space:nowrap;flex:1 1 auto;min-width:0;transition:filter .15s ease}',
      '.soul-persona-action:hover:not(:disabled){filter:brightness(1.08)}',
      '.soul-persona-action:active:not(:disabled){filter:brightness(0.96)}',
      '.soul-persona-action:disabled{cursor:default;opacity:.5}',
      '.soul-persona-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      // 当前生效的预设：按钮文字为「使用中」，样式改为**描边式**（透明底 + 品牌色边框与文字），
      // 与其它卡片的实心主色按钮形成对比 —— 这样即使不看名称前的 ★，也能一眼认出当前配置。
      // 仍可点击（再点一次是无变化的幂等操作，宿主会回「配置无变化」），不刻意禁用：
      // 禁用会让用户以为卡住了，而这里并无副作用。
      '.soul-persona-active{background:transparent;color:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 .5px var(--dsw-alias-brand-primary)}',
      '.soul-persona-active:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);filter:none}',
      // 删除：定宽描边式危险按钮（43px），明显小于「使用」，形成主次对比
      '.soul-persona-danger{flex:0 0 43px;background:transparent;color:var(--dsw-alias-state-error-primary);border:.5px solid var(--dsw-alias-state-error-primary);font-size:12px;font-weight:500}',
      '.soul-persona-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger);filter:none}',
      // 内置预设：不渲染删除按钮（后端也拒绝删除），「使用」占满整行。
      // 类名保留是为了兼容既有断言与「空占位不能是可点控件」这条历史契约。
      '.soul-persona-slot{display:none}',
      // 徽标：对齐宿主的 rowTag 规格（.5px 描边、radius-xs、11px/16px）
      // ⚠️ 这条是**卡背头**的徽标样式（描边式、inline、灰字），必须限定在 .soul-persona-back-head 内。
      // 若不限定，它会覆盖卡面那条（absolute、玻璃底、白字）—— 而它自己又不写 position，
      // 于是卡面徽标变成「白字玻璃底 + absolute 定位 + 描边式字号」的混合体，在插画上漂。
      // 会话「人设」tab 的卡面徽标曾因此漂移：它没有 .soul-persona-back-head 包裹，
      // 上面那条 position:static 的重置不生效。
      '.soul-persona-back-head .soul-persona-badge{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:0 6px;font-size:11px;line-height:16px;white-space:nowrap}',
      // ——「存为新预设」命名弹层（方案 A）——
      // 遮罩用 fixed 全屏 + 半透明；层级要低于 toast（toast 是 10000），
      // 因为保存成功后 toast 要能盖在弹层之上被看到。
      '.soul-modal-mask{position:fixed;inset:0;z-index:9000;display:flex;align-items:center;justify-content:center;background:rgba(10,14,35,.42);padding:24px}',
      '.soul-modal{box-sizing:border-box;width:100%;max-width:380px;display:flex;flex-direction:column;gap:14px;padding:18px;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.18))}',
      '.soul-modal-title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:22px}',
      '.soul-modal .soul-field{margin-bottom:0}',
      // 「将保存 / 不含」两行说明：这是消除「不知道存了哪些值」的关键，用弱化样式但仍可读
      '.soul-modal-note{display:flex;flex-direction:column;gap:4px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.soul-modal-note-excl{color:var(--dsw-alias-label-tertiary)}',
      // 「保存后立即应用」复选框（0.9.0-t）
      '.soul-modal-check{display:flex;align-items:flex-start;gap:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.soul-modal-check input{flex:none;margin-top:3px;width:14px;height:14px;cursor:pointer}',
      '.soul-modal-check-hint{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      // 「更新到预设」列表（0.9.0-s）：每行一个可选预设名。
      '.soul-update-list{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto}',
      '.soul-update-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;padding:8px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer}',
      '.soul-update-item:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary)}',
      '.soul-update-item:disabled{cursor:wait;opacity:.6}',
      '.soul-update-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}',
      '.soul-update-badge{flex:none;color:var(--dsw-alias-brand-primary);font-size:11px;line-height:16px}',
      '.soul-modal-actions{display:flex;justify-content:flex-end;gap:8px}',
      // 二次确认态：描边 → 实心危险色，**并放宽按钮**。
      // 放宽是必须的：普通态按「删除」两字定宽 43px，而「确认删除？」是五个字，
      // 沿用 43px 会把文字挤到贴边/溢出（实测截图确认）。此时它是需要用户看清的
      // 关键动作，宽度优先于「不与主按钮抢视觉」这条次要原则。
      '.soul-persona-danger-armed{flex:0 0 auto;padding:0 10px;background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground);border-color:var(--dsw-alias-state-error-primary)}',
      '.soul-persona-danger-armed:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.08)}',
      // 提示词预览：宿主用 bg-module-platform 表达「内嵌代码/只读区」
      '.soul-prompt-pre{margin:8px 0 0 0;padding:12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-family:var(--ds-font-family-code,Consolas,Menlo,monospace);text-align:left;width:100%;box-sizing:border-box}',
      // —— 保存成功的内联绿字 ——
      // 规格照抄宿主模型设置页的 .savedNotice（zGbnIq_savedNotice）：
      // color:var(--dsw-alias-state-success-primary)、margin:0、12px/18px。
      // 位置也一致：标题区之后、分组列表之前。生命周期不自动消失，
      // 由下一次编辑（dirty）清除 —— 见组件里的 effect。
      // 「已偏离任何预设」的出口：一行提示 + 一个行动按钮。
      // 用与宿主一致的弱化文字色 + 品牌色可点文字（不是实心按钮 —— 它是提示性的
      // 建议动作，不该与「使用」抢视觉权重）。
      '.soul-drift{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:8px;padding:8px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform)}',
      '.soul-drift-text{min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.soul-drift-action{box-sizing:border-box;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.soul-drift-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-drift-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',      '.soul-saved-notice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px}',
      // 失败红字：规格照抄宿主 .zGbnIq_error（state-error-primary、margin:0、12px/18px），
      // role=alert。与绿字同位互斥（失败压过成功），都不自动消失。
      '.soul-error-notice{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      // —— 输入框光轨 ——
      // 几何规则（position/尺寸/contain）同时内联在元素上，见 mountTrailRing；
      // 这里保留一份等价声明作为兜底，并让样式可读、可被第三方主题安全覆盖（仅颜色/速度/粗细）
      '.soul-trail-svg{position:absolute;display:block;pointer-events:none;contain:strict;overflow:hidden;margin:0;padding:0;border:0}',
      // 设置页示例用的零高度挂载锚点：只定位占坑，不参与任何尺寸计算
      '.soul-trail-anchor{position:absolute;inset:0 0 auto;height:0;pointer-events:none}',
      // 速度档位（整体比首版慢一档）：normal 3.6s / slow 4.8s / fast 2.4s
      '.soul-trail-layer{fill:none;stroke:var(--soul-trail-color,#679EFE);stroke-width:2.5;stroke-linecap:butt;animation-name:soul-trail-run-0;animation-duration:3.6s;animation-timing-function:linear;animation-iteration-count:infinite}',
      '.soul-trail-layer[data-layer="0"]{opacity:1;stroke-linecap:round}',
      '.soul-trail-layer[data-layer="1"]{animation-name:soul-trail-run-1;opacity:.87}',
      '.soul-trail-layer[data-layer="2"]{animation-name:soul-trail-run-2;opacity:.74}',
      '.soul-trail-layer[data-layer="3"]{animation-name:soul-trail-run-3;opacity:.61}',
      '.soul-trail-layer[data-layer="4"]{animation-name:soul-trail-run-4;opacity:.47}',
      '.soul-trail-layer[data-layer="5"]{animation-name:soul-trail-run-5;opacity:.34}',
      '.soul-trail-layer[data-layer="6"]{animation-name:soul-trail-run-6;opacity:.21}',
      '.soul-trail-layer[data-layer="7"]{animation-name:soul-trail-run-7;opacity:.08}',
      '@keyframes soul-trail-run-0{from{stroke-dashoffset:0px}to{stroke-dashoffset:-100px}}',
      '@keyframes soul-trail-run-1{from{stroke-dashoffset:2.2px}to{stroke-dashoffset:-97.8px}}',
      '@keyframes soul-trail-run-2{from{stroke-dashoffset:4.4px}to{stroke-dashoffset:-95.6px}}',
      '@keyframes soul-trail-run-3{from{stroke-dashoffset:6.6px}to{stroke-dashoffset:-93.4px}}',
      '@keyframes soul-trail-run-4{from{stroke-dashoffset:8.8px}to{stroke-dashoffset:-91.2px}}',
      '@keyframes soul-trail-run-5{from{stroke-dashoffset:11px}to{stroke-dashoffset:-89px}}',
      '@keyframes soul-trail-run-6{from{stroke-dashoffset:13.2px}to{stroke-dashoffset:-86.8px}}',
      '@keyframes soul-trail-run-7{from{stroke-dashoffset:15.4px}to{stroke-dashoffset:-84.6px}}',
      '[data-soul-trail-speed="slow"] .soul-trail-layer{animation-duration:4.8s}',
      '[data-soul-trail-speed="fast"] .soul-trail-layer{animation-duration:2.4s}',
      '[data-soul-trail-width="thin"] .soul-trail-layer{stroke-width:1.5}',
      '[data-soul-trail-width="thick"] .soul-trail-layer{stroke-width:4}',
      // 显隐的兜底规则（主路径由 mountTrailRing 的 setVisible 写内联 display）
      '[data-soul-trail="off"] .soul-trail-svg{display:none}',
      // 光轨开启时隐藏宿主输入框自身的细边框（保留 1px 占位，避免布局跳动），
      // 使边界上只存在光轨一条线
      '[data-composer-card][data-soul-trail="on"]{--dsw-elevation-stroke-color:transparent}',
      // 设置页：颜色控件与实时示例
      '.soul-trail-colors{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.soul-trail-swatch{width:26px;height:26px;padding:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);cursor:pointer}',
      '.soul-trail-swatch[data-active="true"]{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-trail-picker{width:34px;height:26px;padding:0;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:none;cursor:pointer}',
      '.soul-field .soul-trail-colors input.soul-trail-hex{width:104px;padding:5px 8px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;font-family:Consolas,Menlo,monospace;box-sizing:border-box}',
      '.soul-trail-preview{position:relative;margin-top:6px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.soul-trail-preview[data-soul-trail="on"]{border-color:transparent}',
      '.soul-trail-preview-text{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      // —— 变更记录（0.8.0）——
      // 顶部状态行 + 右侧「清空记录」：与 .soul-drift 同款（space-between），
      // 因为它也是「一句话 + 一个行动」的形态。
      '.soul-history-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:6px}',
      '.soul-history-count{margin-top:0}',
      // —— 插件详情页外壳（0.8.1 双入口）：对齐宿主 detailSection 排版 ——
      // 宿主 .detailSection = flex column / gap 12px；.sectionHead = baseline 对齐；
      // .sectionTitle = 14px/500/20px；.sectionCount = 12px 次要色（fO69Vq_ 前缀）。
      '.soul-detail-history{display:flex;flex-direction:column;gap:12px}',
      '.soul-detail-history-head{display:flex;align-items:baseline;gap:10px}',
      '.soul-detail-history-title{margin:0;font-size:14px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.soul-detail-history-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // —— 会话「人设」tab（0.9.0-d）——
      // 它是 conversation.view 的一种，宿主把它画在对话区里，所以要自带内边距与
      // 最大宽度（不像设置页有外层容器）。参数抄宿主的 viewArea 排版：
      // 内容左对齐、与对话区同宽的上限，宽屏下不铺满整行。
      // 与宿主 conversation 输入框同宽：直接读 --dsh-chat-content-width
      // （宿主 body 规则里定义为 clamp(680px, 64%, 920px)）。宿主调宽窄、tab 跟着变，
      // 比硬编码 720px 更稳；变量缺失时回退 720px（与上一版一致）。
      '.soul-session-persona{display:flex;flex-direction:column;gap:16px;max-width:var(--dsh-chat-content-width,720px);width:100%;margin:0 auto;padding:20px 4px;box-sizing:border-box;color:var(--dsw-alias-label-primary)}',
      '.soul-session-head{display:flex;align-items:baseline;gap:8px}',
      '.soul-session-title{margin:0;font-size:14px;font-weight:500;line-height:20px}',
      // 容器内间距全部交给 gap:16px 统一 —— .soul-field 自带的 margin-bottom:14px
      // 会让「临时改用」与下方卡牌的间距比上方标题的 16px 小，视觉不齐（用户反馈）。
      // ⚠️ 0.9.0-af 补全：光清 .soul-field 不够 —— 前置排查发现容器内还有多处
      // 自带纵向 margin：.soul-field-label(8px bottom)、.soul-status(top)、
      // .soul-session-split(top:2px)、.soul-session-clear-row(top)、
      // .soul-session-detail-actions(top)、.soul-session-scope-hint(top)。
      // 每漏一处，三段间距就有一段不齐（用户连续报了两次）。
      // 通配清零容器内所有子元素的纵向 margin —— 间距语义只归 gap 一处管。
      // 面板内部的 margin（detail-actions/scope-hint 的 margin-top）不受影响：
      // 它们在 .soul-session-detail 里，不是本容器的直接子元素。
      '.soul-session-persona > *{margin-top:0;margin-bottom:0}',
      // 「有覆盖」标记：一眼看出这个会话与外面的设置不同，避免用户以为改的是全局
      '.soul-session-badge{padding:0 6px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:18px}',
      // 当前生效卡：与设置页 .soul-bindings-current 同款观感（描边 + 浅底）
      '.soul-session-current{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      // 名称加粗（0.9.0-aa）：这是 tab 里最重要的信息，500 不够突出
      '.soul-session-current-name{font-size:14px;line-height:22px;font-weight:700}',
      // 特质突出点（非默认维度）小字：与名称同行，弱于名称
      '.soul-session-current-traits{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:22px;font-weight:400}',
      '.soul-session-current-source{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 人设胶囊：可点即选，选中的用主色实心（与设置页的「使用中」同一套色彩语义）
      '.soul-session-chips{display:flex;flex-wrap:wrap;gap:8px}',
      // 与「使用中」按钮（.soul-persona-action，36px / radius-md）并排，
      // 高度与圆角必须一致 —— 否则同一行里一高一低。
      // .soul-session-chip 现在只剩「取消本会话的临时人设」这一个使用点
      // （0.9.0-d 移除了旧胶囊选择器），直接对齐规格；配色保持描边式（次要动作）。
      '.soul-session-chip{box-sizing:border-box;display:inline-flex;align-items:center;height:36px;padding:0 14px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-md,12px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.soul-session-chip:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.soul-session-chip:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-session-chip:disabled{opacity:.5;cursor:default}',
      '.soul-session-chip-active{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
      // 「取消本会话的临时人设」用次要色：它可逆，不是破坏性动作
      '.soul-session-chip-clear{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.soul-session-clear-row{display:flex;margin-top:10px}',
      // —— 会话「人设」：左卡牌网格 + 右详情（0.9.0-d 改版）——
      //
      // 与设置页的人设卡牌**共用同一套视觉语言**（圆角、描边、浅底、插画 + 压图标题），
      // 但布局从「叠层轮播 + 3D 翻面」改成「左侧网格选中 + 右侧详情面板」：
      // 会话面板横向空间窄，左侧是**叠层轮转**而非平铺：中心大卡 + 两侧各露边一张。
      // 比例：左栏 260px（正好容下 260px 的叠层）+ 右栏自适应；放不下时整体换行。
      '.soul-session-split{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}',
      // 叠层容器：卡片绝对定位到同一格，靠内联 transform 偏移（与设置页同构）。
      // overflow:hidden 让两侧露边卡在容器边缘被自然裁掉，观感与设置页一致。
      // 叠层容器：**1:1**（高度 = 卡宽 210px）。
      //
      // 为什么是 1:1：插画资源全是 512×512 正方形，而容器若是竖长的（比如 210×380），
      // 配合 object-fit:cover 就会**上下裁掉约 44%**，只剩中间一条 —— 看起来像「插画不够大」。
      // 1:1 容器让插画完整显示，且比原来看到的那条中间带大得多。
      // 轮播容器：叠层卡 + 下方导航（同一列，纵向）
      '.soul-session-carousel{flex:0 0 300px;min-width:300px;display:flex;flex-direction:column;align-items:center;gap:10px}',
      // 0.9.0-ag：soul-field 是普通块容器 —— split 与 detail 垂直堆叠（detail 被
      // 挤到卡牌下方），这才是「三段间距不一致」的真身。改 flex 行布局后
      // detail 回到卡牌右侧，split(338) 与 detail(338) 等高。
      '.soul-field.soul-persona-field{display:flex;gap:18px;align-items:flex-start;flex-wrap:wrap}',
      '.soul-session-grid{position:relative;width:100%;height:300px;overflow:hidden}',
      // 单张卡：结构抄 .soul-persona-card 的正面（去掉 3D 翻面 —— 翻面由右栏详情承担）。
      // ⚠️ 这里**不得**写任何 transform：叠层偏移由内联 style 持有（translateX/scale）；
      // 若 CSS 也给 transform，两者会互相覆盖。
      // 插画铺满整张卡：art 绝对定位 inset:0，卡本身只提供定位上下文与圆角裁切。
      '.soul-session-card{position:absolute;top:0;bottom:0;left:0;right:0;width:300px;margin:0 auto;display:block;overflow:hidden;border-radius:var(--dsw-radius-xl);border:.5px solid var(--dsw-alias-settings-card-stroke);background:var(--dsw-alias-settings-card-fill);box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08));box-sizing:border-box;font-size:12px;line-height:18px;transition:transform .3s cubic-bezier(.22,.61,.36,1),opacity .3s ease;cursor:pointer}',
      '.soul-session-card:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      // 生效中的那张：**不加描边**（0.9.0-u）。
      //
      // 历史：曾用主色描边 + 1px 光晕表达「生效」，但主色在浅色主题下解析为近黑
      // （#0f1115），压在插画上是一圈很重的黑框 —— 用户反馈太丑。
      // 生效标识已有**左下角的 ★ 角标**（半透明深底圆 + 白字，不依赖遮罩），
      // 描边是重复信号，去掉后 ★ 成为唯一依据，观感干净得多。
      // 若将来要恢复描边，注意别与 hover 的 translateY 合成同一个 transform。
      '.soul-session-card[data-effective="true"]{box-shadow:var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08))}',
      // 选中的那张：**只抬高一档 + 投影加深**，不再加描边。
      //
      // 为什么去掉那圈 1px 光晕：它与上面「生效」的描边是同一个主色，浅色主题下两者都是
      // 近黑 ⇒ 生效卡与选中卡叠在一起时是「双层黑框」，完全分不出哪个是「正在生效」、
      // 哪个是「正在浏览」。把描边独占给「生效」，选中只留位移与投影，两个状态就分开了。
      '.soul-session-card[data-selected="true"]{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.18),var(--dsw-shadow-lv2,0 2px 8px rgba(0,0,0,.08))}',
      // 生效 **且** 选中（最常见：中心卡正是生效的那张）⇒ 投影取两者中更重的一档。
      '.soul-session-card[data-selected="true"][data-effective="true"]{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.18)}',
      // 插画区：**绝对定位铺满整张卡**。
      // 原来它在文档流里（1:1 的画面 + 下方文字区），现在没有文字区了 ⇒ 直接铺满，
      // 画面大得多。aspect-ratio 不再需要（高度由容器决定）。
      '.soul-session-card .soul-persona-art{position:absolute;inset:0;width:100%;height:100%;aspect-ratio:auto}',
      // 生效标记 ★：放左下角（右上角被「i / n」占了，左上角被内置徽标占了）。
      // 半透明深底 + 白字 —— 不依赖遮罩，在任何底图上都读得清。
      '.soul-session-card-star{position:absolute;left:10px;bottom:10px;width:22px;height:22px;display:flex;align-items:center;justify-content:center;border-radius:50%;background:rgba(10,14,35,.55);color:var(--dsw-static-neutral-bluish-00,#fff);font-size:13px;line-height:1;backdrop-filter:blur(6px)}',
      // 右栏详情：复用设置页卡背的元素（.soul-persona-dims / .soul-persona-fulltext），
      // 这里只补容器与滚动。高度上限避免长文把整个面板撑得比卡牌栏高太多。
      // 详情面板：**固定高度**（0.9.0-z）。
      //
      // 为什么不用 max-height：那会让面板高度跟着内容走 —— 每个人设的
      // 自定义指令长度不同，切换时面板一高一低地跳，左侧轮播也跟着晃。
      // 固定 height 后切换任何预设面板都不变，只有内容区滚动。
      //
      // 340px = 原上限值，实测能容纳六维度 + 约 12 行指令；更长的指令在内部滚动。
      '.soul-session-detail{flex:1 1 220px;min-width:200px;display:flex;flex-direction:column;gap:8px;padding:12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill);height:338px;box-sizing:border-box;overflow:hidden}',
      '.soul-session-detail-empty{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.soul-session-detail-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
      '.soul-session-detail-name{font-size:14px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.soul-session-detail-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:2px}',
      '.soul-session-detail-actions .soul-persona-action{flex:1 1 auto}',
      // 作用范围说明（0.9.0-z）：小字次要色，一行即可
      '.soul-session-scope-hint{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      // 覆盖里的字段名：等宽，便于与配置键对上
      '.soul-session-fields{display:flex;flex-wrap:wrap;gap:6px}',
      '.soul-session-field{padding:1px 6px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px}',
      // —— 工作区人设平铺卡片（0.9.0-e）——
      // 竖排卡片而非下拉：工作区通常 3–10 个，每张要同时表达「名字 + 路径 + 绑定态」。
      '.soul-ws-list{display:flex;flex-direction:column;gap:8px}',
      '.soul-ws-card{display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:10px 12px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      // 已绑定：左侧一道主色竖条（与「命中当前目录」同一套视觉语义）
      '.soul-ws-card-bound{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.soul-ws-main{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}',
      '.soul-ws-title{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.soul-ws-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:18px}',
      '.soul-ws-invalid{display:flex;flex-wrap:wrap;gap:6px;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.soul-ws-actions{display:flex;align-items:center;gap:8px;flex:none}',
      '.soul-ws-persona{color:var(--dsw-alias-brand-primary);font-size:12px;line-height:18px}',
      '.soul-ws-unbound{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.soul-ws-action{box-sizing:border-box;display:inline-flex;align-items:center;height:26px;padding:0 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.soul-ws-action:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.soul-ws-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-ws-action:disabled{opacity:.5;cursor:default}',
      // 「绑定人设」是这一页的主操作：实心主色
      '.soul-ws-action-primary{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground)}',
      // 解绑 armed：危险色（与删除预设同一套）
      '.soul-ws-action-armed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      // 内联展开的人设胶囊：占满整行，与卡片内容左对齐
      '.soul-ws-picker{flex-basis:100%;display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px;border-top:.5px solid var(--dsw-alias-settings-card-stroke)}',
      '.soul-ws-picker-label{flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 会话清理的按钮行：与设置页的 .soul-buttons **分开命名**（那个 class 语义是
      // 「保存按钮区」，复用它会让"保存设置在哪里"这类断言抓到错误的块 —— 实测抓到过）。
      '.soul-sessions-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:4px}',
      // 保留条数（0.8.1 从设置页迁来）：一行「标签 + 下拉 + 提示」。
      // 下拉不撑满整行 —— 它是容量参数，不是表单主字段，铺满会显得比记录本身还重。
      '.soul-history-retention{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.soul-history-retention label{margin:0;flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.soul-history-retention select{flex:none;width:auto;min-width:112px;padding:4px 8px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px}',
      '.soul-history-retention select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-history-retention select:disabled{opacity:.6}',
      // 下拉右侧的问号提示沿用设置页的 SoulHint；这里只压掉它的上边距以对齐这一行
      '.soul-history-retention .soul-hint{margin-top:0}',
      // —— 设置页指引（0.8.1 双入口）——
      // 列表整体迁去插件详情页后，设置页不再有指引行；去向说明并入「人设预设」
      // 展开区的 .soul-note（见下方 .soul-note 注释），不再单独占一行。
      // 危险色描边文字钮（规格抄 .soul-persona-danger）：清空记录不可逆，
      // 是这一组唯一的破坏性动作。撤销按钮不用危险色 —— 它可以再撤销一次改回来。
      '.soul-history-clear{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;height:24px;padding:0 10px;border:.5px solid var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.soul-history-clear:hover{background:var(--dsw-alias-interactive-bg-hover-danger,rgba(236,19,19,.05))}',
      '.soul-history-clear:focus-visible{outline:2px solid var(--dsw-alias-state-error-primary);outline-offset:1px}',
      // armed：实心危险色 + 文案变成「确认清空？」（样式抄 .soul-persona-danger-armed）
      '.soul-history-clear-armed{background:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-label-primary-foreground)}',
      '.soul-history-warning{margin-top:6px}',
      '.soul-history-list{display:flex;flex-direction:column;gap:6px;margin:10px 0 0 0;padding:0;list-style:none}',
      '.soul-history-item{border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-module-platform);overflow:hidden}',
      // 头部是「主体按钮 + 操作按钮」两段：主体撑满左侧，操作固定在右，
      // 因此主体按钮必须 min-width:0 才能让里面的 ellipsis 生效。
      '.soul-history-item-head{display:flex;align-items:center;gap:8px;padding-right:8px}',
      '.soul-history-item-main{display:flex;align-items:center;gap:8px;flex:1;min-width:0;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;text-align:left;cursor:pointer}',
      '.soul-history-item-main:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-history-item-main:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      // 时间与来源不参与收缩（它们短且固定），字段名列表吃掉剩余宽度并省略。
      '.soul-history-time{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap}',
      '.soul-history-source{flex:none;padding:0 6px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;white-space:nowrap}',
      '.soul-history-fields{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.soul-history-item-actions{display:flex;align-items:center;gap:6px;flex:none}',
      '.soul-history-action{box-sizing:border-box;flex:none;display:inline-flex;align-items:center;height:24px;padding:0 8px;border:.5px solid var(--dsw-alias-brand-primary);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
      '.soul-history-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-history-action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-history-action-armed{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.soul-history-detail{padding:0 10px 10px 10px;border-top:.5px solid var(--dsw-alias-settings-card-stroke)}',
      '.soul-history-diff{display:flex;flex-direction:column;gap:10px;padding-top:8px}',
      // 「展开即全文」：每行竖排 —— 字段名、原值块、新值块依次铺开。
      // 曾经是 88px/1fr/14px/1fr 的四列网格 + 单行省略，但自定义指令几百字时
      // 一行省略号等于没给；竖排让长文本换行铺开，短字段也不吃亏。
      '.soul-history-diff-row{display:flex;flex-direction:column;gap:4px;font-size:12px;line-height:18px}',
      '.soul-history-diff-field{color:var(--dsw-alias-label-tertiary);word-break:break-word}',
      // pre-wrap：介绍 / 自定义指令里的换行是内容的一部分，压成一行会看不出改了什么。
      '.soul-history-diff-cell{display:flex;flex-direction:column;gap:2px}',
      '.soul-history-diff-tag{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.soul-history-diff-value{min-width:0;white-space:pre-wrap;word-break:break-word}',
      // 原值块垫底色区分「这是被替换掉的」，新值保持正文色；省略号阶段二值同权重，全文阶段必须能一眼分清。
      '.soul-history-diff-cell:first-of-type .soul-history-diff-value{color:var(--dsw-alias-label-tertiary)}',
      '.soul-history-diff-value{color:var(--dsw-alias-label-primary)}',
      '.soul-history-diff-persona{margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.soul-history-more{align-self:flex-start;margin-top:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-brand-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.soul-history-more:hover{text-decoration:underline}',
      '.soul-history-more:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      // —— 设置页「工作区绑定」分组（0.8.1-d）——
      // 外层容器只负责块间距：三段是 .soul-field，彼此之间要留出与其它分组一致的空。
      '.soul-bindings{display:flex;flex-direction:column;gap:14px}',
      // 尺寸全部抄本文件既有的宿主对齐规格：输入框复用 .soul-field 的控件规则，
      // 小按钮复用 .soul-history-action（24px 高 / 描边 / brand 文字），
      // 危险态复用 .soul-history-action-armed 的语义（实心危险色 + 换文案）。
      // 这里只补「绑定」独有的排版：路径与元信息的折叠、列表的树形前缀、当前目录的高亮。
      // 当前会话目录卡：一行等宽路径 + 两行元信息（生效人设 / 来源），
      // 路径靠 title 给全文、靠 shortenPath 截中段 —— 不换行，避免长路径把卡片撑高
      '.soul-bindings-current{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      // 路径用等宽字体：宿主主题**没有** --dsw-font-mono 这个 token（实测校对过），
      // 引一个不存在的 var() 只会静默回退，所以这里直接给系统等宽字体栈。
      '.soul-bindings-path{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.soul-bindings-meta{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 输入框 + 「选择目录…」同一行：按钮不缩放（flex:none），输入框吃满剩余宽度
      '.soul-bindings-new{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.soul-bindings-new:last-child{margin-bottom:0}',
      '.soul-bindings-new label{margin:0;flex:none}',
      // 0.9.0-ah：按钮改用宿主 ui.Button 后，这里**不能再覆盖 background / color**
      // —— 原先的 color:brand-primary 压住了宿主给的白字，hover 时深底深字变全黑。
      // 只保留布局：这一行的输入框吃掉剩余宽度，其余控件不缩放。
      '.soul-bindings-new > *{flex:none}',
      '.soul-bindings-new input{flex:1 1 auto;min-width:0}',
      // 人设下拉不许被压到看不见：flex:none + 固定最小宽度
      '.soul-bindings-new select{flex:none;width:auto;min-width:120px}',
      // 降级提示：与 .soul-status 同色同字号，贴在选择器原位（说明为什么按钮不见了）
      '.soul-bindings-hint{margin:-2px 0 8px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 列表：与 .soul-history-list 同规格（紧凑、无项目符号）
      '.soul-bindings-rows{display:flex;flex-direction:column;gap:6px;margin:10px 0 0 0;padding:0;list-style:none}',
      '.soul-bindings-row{display:flex;align-items:center;gap:6px;min-height:32px;padding:4px 8px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1)}',
      // 高亮命中当前会话的那一条：左侧一道 brand 竖条，比整块上色更安静
      '.soul-bindings-row[data-current="true"]{border-color:var(--dsw-alias-brand-primary);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.soul-bindings-tree{flex:none;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      // 目录名是这一行的主体：吃掉剩余宽度，过长则省略（全文在 title）
      '.soul-bindings-dir{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}',
      '.soul-bindings-here{flex:none;padding:0 6px;border-radius:var(--dsw-radius-sm);background:color-mix(in srgb,var(--dsw-alias-brand-primary) 12%,transparent);color:var(--dsw-alias-brand-primary);font-size:11px;line-height:18px}',
      '.soul-bindings-bad{flex:none;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
      '.soul-bindings-select{flex:none;width:auto;min-width:96px;max-width:160px}',
      // 解绑的「待确认」态：只染文字颜色（宿主按钮的底色/悬停不动，避免旧的全黑问题）
      '.soul-bindings-act-armed{color:var(--dsw-alias-state-error-primary)}',
      // 未绑定回落行：虚线框＝「这是规则、不是一条记录」
      '.soul-bindings-fallback{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border:.5px dashed var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm)}',
      '.soul-bindings-fallback-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      // 「看到的不是全部」不是失败：用次要色，与红字错误（.soul-error）区分。
      // 宿主主题**没有**黄色 warning token（实测：--dsw-alias-label-warning /
      // --dsw-alias-state-warning-primary 都不存在），自己硬编一个黄色又会跟主题脱节，
      // 所以按「不重要但要知道」处理，与同组其它提示同色。
      '.soul-bindings-warning{color:var(--dsw-alias-label-secondary)}',
      // 开了「减少动态效果」时：光轨层与卡片停动画。
      // 结果提示（绿字/红字）不需要在这里照顾 —— 它们是静态文字、没有动画。
      '@media (prefers-reduced-motion:reduce){.soul-trail-layer{animation:none}.soul-persona-card{animation:none!important;transition:none}}'
    ].join('')

    const tagId = 'dsh-soul/styles.css'
    let styleTagMissing = false
    if (typeof document !== 'undefined') {
      try {
        styleTagMissing = document.querySelector(`style[data-plugin-css="${tagId}"]`) === null
      } catch {
        styleTagMissing = true
      }
    }
    if (styleTagMissing) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-soul'
      tag.dataset.pluginCss = tagId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    // -------------------------------------------------------------------------
    // 文案词典（键集中英完全对齐；渲染器按槽位 locale 注入 t）
    // -------------------------------------------------------------------------

    const zh = {
      'nav.label': '个性化',
      'settings.title': '个性化设置',
      'accordion.filled': '项已填写',
      'accordion.empty': '未填写',
      // 分组摘要在「拉取失败」时的显示（折叠态下用户只看得到这一行）
      'accordion.loadFailed': '加载失败',
      'accordion.personas': '个预设',
      'accordion.on': '已开启',
      'accordion.off': '未开启',
      'toggle.enabled': '启用个性化设置',
      'quick.enable': '开启个性化',
      'quick.disable': '关闭个性化',
      'quick.statusEnabled': '个性化已启用',
      'quick.custom': '自定义',
      'quick.statusDisabled': '个性化已关闭',
      // 快捷开关保存失败时的兜底文案（有服务端 error 时优先显示它）
      'quick.toggleFailed': '保存失败，请重试',
      'group.aboutYou': '关于你',
      'field.nickname': '用户昵称',
      'field.nicknamePlaceholder': '输入你的昵称，回复时会称呼你',
      'field.occupation': '用户职业',
      'field.occupationPlaceholder': '例如：软件工程师、学生、产品经理',
      'field.bio': '用户介绍',
      'field.bioPlaceholder': '简单介绍自己，让回复更贴合你的背景',
      'group.traits': '特质',
      'field.style': '回复风格和语调',
      'hint.style': '设置 Agent 回复你的风格和语调。这不会影响 Agent 的功能。',
      'field.headingLists': '标题和列表',
      'hint.headingLists': '在回复风格和语调的基础上选择额外的自定义特质项。控制回答中标题和列表的使用程度。',
      'field.emoji': '表情符号',
      'hint.emoji': '在回复风格和语调的基础上选择额外的自定义特质项。控制表情符号的使用程度。',
      'field.tables': '表格',
      'hint.tables': '在回复风格和语调的基础上选择额外的自定义特质项。控制回答中表格的使用程度。',
      'field.replyLength': '回复长度',
      'field.activePersonaName': '最近使用的预设',
      'hint.replyLength': '控制回答的篇幅。选「适中」时不额外约束，由 Agent 自行判断。',
      'field.language': '输出语言',
      'hint.language': '设置 Agent 回复你使用的语言，同时影响 /soul 命令的输出语言。',
      'field.instructions': '自定义指令',
      'hint.instructions': '补充角色、习惯等个性化要求。建议不要重复设置回复风格和语调类似的话术，以免与上方选项冲突。',
      'field.instructionsPlaceholder': '输入自定义指令，可以是其他行为、回复风格和语调等偏好设置',
      'group.personas': '人设预设',
      'personas.save': '保存当前为预设',
      // 方案 A：入口移出预设列表，与「保存设置」并列（文案用「存为预设…」表示会再问一步）
      'personas.saveAs': '存为预设…',
      // 更新到预设（0.9.0-s）：与「存为预设」并列 —— 前者覆盖已有，后者新建。
      'personas.updateTo': '更新到预设',
      'personas.updateNone': '还没有可更新的自建预设。内置预设不可修改。',
      'personas.updateCovers': '会把「关于你」之外的人格字段（风格、特质、长度、指令）写入所选预设。',
      'personas.updateExcludes': '不会包含昵称、职业、介绍 —— 它们不属于预设。',
      'notice.personaUpdated': '已更新预设「{name}」。',
      'personas.saveNameLabel': '新预设名称',
      'personas.saveConfirm': '保存',
      'personas.saveCovers': '将保存：回复风格和语调、特质、回复长度、输出语言、自定义指令',
      'personas.saveExcludes': '不含：昵称、职业、介绍（这些属于「关于你」，预设不动它们）',
      'personas.confirmDeleteShort': '确认删除？',
      // —— 卡背（详情面）——
      'personas.details': '详情',
      'personas.flipBack': '返回',
      'personas.dims': '人设维度',
      'personas.customInstructions': '自定义指令',
      'personas.dimDefault': '默认',
      'personas.noCustomInstructions': '这个人设没有额外的自定义指令',
      'personas.savePlaceholder': '预设名称（1-30 字符）',
      'personas.use': '使用',
      'personas.active': '使用中',
      'personas.delete': '删除',
      'personas.prev': '上一个预设',
      'personas.next': '下一个预设',
      'personas.confirmDelete': '确定删除预设「{name}」？',
      'personas.empty': '暂无人设预设，保存当前配置后可一键切换',
      // 列表拉取失败（此前是空 catch ⇒ 界面会永远停在「加载中...」）
      'personas.loadFailed': '人设预设加载失败：{reason}',
      'personas.builtin': '内置',
      'personas.drift': '当前配置与任何预设都不一致。',
      'personas.driftAction': '存为新预设',
      // 一句话就够了：用户的真实疑问只有「存了这个会不会连我的昵称也一起换掉」。
      // 「不可删除」不再写进正文 —— 每张内置卡上都挂着「内置」徽标、且根本没有删除按钮，
      // 说第二遍只是噪音。
      'personas.hint': '预设只含 Agent 的人格；你的昵称与自我介绍不随预设切换。',
      // hover 里的全文：原来那段正文原样保留在这里，需要细节的人仍能读到，
      // 不需要的人不必被它占两行。
      'personas.hintDetail': '预设有风格、特质（标题和列表 / 表情符号 / 表格）、回复长度、输出语言、自定义指令；不含「关于你」里的昵称、职业与自我介绍。内置预设随插件提供，不可删除。',
      'style.professional': '专业严谨',
      'style.casual': '轻松自然',
      'style.humorous': '幽默风趣',
      'style.roast': '吐槽达人',
      'style.efficient': '高效干练',
      'trait.headingLists.default': '默认',
      'trait.headingLists.more': '增强（采用清晰格式和列表结构）',
      'trait.headingLists.less': '减弱（使用更多段落文本）',
      'trait.emoji.default': '默认',
      'trait.emoji.more': '增强（使用较多表情符号）',
      'trait.emoji.less': '减弱（尽量减少使用表情符号）',
      'trait.tables.default': '默认',
      'trait.tables.more': '增强（优先用表格呈现对比与多字段信息）',
      'trait.tables.less': '减弱（避免使用表格，改用列表或段落）',
      'trait.replyLength.concise': '简洁（只讲要点，不展开）',
      'trait.replyLength.normal': '适中（不额外约束）',
      'trait.replyLength.detailed': '详尽（充分展开背景与推理）',
      // 预设行摘要用的短标签（trait.* 的完整说明太长，一行放不下）
      'meta.replyLength.concise': '简洁',
      'meta.replyLength.detailed': '详尽',
      'meta.headingLists.more': '多列表',
      'meta.headingLists.less': '少列表',
      'meta.emoji.more': '多表情',
      'meta.emoji.less': '少表情',
      'meta.tables.more': '多用表格',
      'meta.tables.less': '少用表格',
      'meta.language.zh': '中文',
      'meta.language.en': '英文',
      // —— 工作区绑定（0.8.1）——
      'group.bindings': '工作区绑定',
      'bindings.hint': '绑定记住的是目录而不是会话：在绑定的目录（含子目录）里开的会话自动用这个人设。保存后立刻对活动会话生效，其他目录不受影响。',
      // 当前会话目录卡
      'bindings.currentTitle': '当前会话目录',
      'bindings.noSession': '当前没有活动会话，所以没有「现在用什么」可显示。',
      'bindings.noCwd': '这个会话没有工作目录，任何绑定都不会命中 —— 它会用全局配置。',
      'bindings.effective': '生效人设',
      'bindings.source': '来源',
      'bindings.sourceGlobal': '全局配置（没有绑定的目录都归它管）',
      'bindings.sourceInherited': '{dir}（上级目录继承）',
      'bindings.choose': '选择目录…',
      'bindings.manualLabel': '目录路径',
      'bindings.manualPlaceholder': '粘贴一个绝对路径，例如 D:\\项目A',
      'bindings.bindDir': '绑定',
      // 结果提示：就地在分组内显示绿字/红字（与变更记录同款，不用 toast）
      'bindings.needDir': '先填一个目录，或者点「选择目录…」。',
      'bindings.bound': '已绑定：{dir} → {name}',
      'bindings.unbound': '已解绑：{dir}',
      'bindings.unbindMissing': '这条绑定已经不在列表里了（可能是在别处删掉的），刷新一下即可。',
      'bindings.pickerUnavailable': '当前连接方式无法调起系统目录选择器，请手动粘贴路径。',
      'bindings.moreSessions': '另有 {count} 个活动会话',
      // 绑定列表
      'bindings.listTitle': '已绑定的目录',
      'bindings.loading': '加载中...',
      'bindings.loadFailed': '无法读取工作区绑定：{reason}',
      'bindings.empty': '还没有绑定任何目录。',
      'bindings.count': '共 {count} 条 · 最多 {max} 条',
      'bindings.here': '当前目录',
      'bindings.persona': '使用的人设',
      'bindings.unbind': '解绑',
      'bindings.unbindArmed': '确认解绑？',
      'bindings.invalid': '人设「{name}」已不存在',
      'bindings.invalidHint': '这条绑定不会生效，改绑或解绑它。',
      'bindings.dropped': '有 {count} 行无效记录已被忽略。',
      'bindings.warning': '绑定表可能不完整：{reason}',
      'bindings.maxPath': '路径上限 {max} 字符。',
      'bindings.fallback': '未绑定的目录使用全局配置',
      'bindings.change': '改',
      // —— 会话级人设（0.9.0-d）——
      // tab 标题：与设置页「个性化」、详情页「人设预设」同一套用词。
      'session.tabLabel': '人设',
      'session.title': '本会话的人设',
      'session.current': '当前生效',
      'session.workspace': '所属工作区',
      'session.workspaceUnknown': '未归入任何工作区',
      'session.source.global': '全局配置',
      'session.source.workspace': '工作区「{name}」',
      'session.source.directory': '目录绑定',
      'session.source.session': '本会话临时覆盖',
      'session.noPersona': '自定义（与任何预设都不匹配）',
      'session.overrideTitle': '临时改用',
      'session.overrideHint': '只影响这个会话；新会话仍按工作区或全局设置。',
      'session.pickPersona': '换成预设…',
      'session.customOverrides': '自定义字段',
      'session.clear': '取消本会话的临时人设',
      'session.cleared': '已取消本会话的临时人设，现在跟随上层配置。',
      'session.applied': '本会话已改用「{name}」。',
      'session.loading': '加载中...',
      'session.loadFailed': '无法读取本会话的人设：{reason}',
      'session.applyFailed': '设置失败：{reason}',
      'session.noOverrides': '没有临时覆盖。',
      'session.badge': '有覆盖',
      // 输入框标签的来源层级：告诉用户「现在这个人设是哪一层定的」
      'quick.scopeSession': '本会话覆盖',
      'quick.scopeWorkspace': '工作区「{name}」',
      'quick.scopeDirectory': '目录绑定',
      'quick.scopeGlobal': '全局配置',
      'quick.scopeUnknown': '会话状态未知',
      // 设置页预设行的作用域标注：设置页没有会话上下文，写的是**全局**
      'personas.scopeGlobal': '全局',
      // 卡面按钮：与设置页「使用 / 使用中」同一套语义，只是措辞更贴会话语境
      'session.useCard': '用这个',
      'session.pickHint': '点左侧任意一张卡，在这里查看它的完整人设。',
      'session.chipInUse': '使用中',
      // —— 工作区人设（详情页，0.9.0-e）——
      'workspaces.title': '工作区人设',
      'workspaces.count': '{bound} / {total} 已绑定',
      'workspaces.hint': '工作区里的人设只作用于该工作区下的会话；未绑定的回落全局配置。',
      'workspaces.unbound': '未绑定',
      'workspaces.bind': '绑定人设',
      'workspaces.rebind': '改绑',
      'workspaces.unbind': '解除绑定',
      'workspaces.unbindArmed': '确认解除？',
      'workspaces.empty': '还没有工作区。在侧边栏「添加工作区」后回来这里配置人设。',
      'workspaces.loading': '加载中...',
      'workspaces.loadFailed': '无法读取工作区：{reason}',
      'workspaces.serverProblem': '宿主服务不可用：{reason}',
      'workspaces.invalid': '人设「{name}」已不存在',
      'workspaces.invalidHint': '这条绑定不会生效；改绑或解除它。',
      'workspaces.applied': '「{name}」已绑定到「{title}」。',
      'workspaces.unbindDone': '已解除「{title}」的人设绑定。',
      'workspaces.applyFailed': '设置失败：{reason}',
      'workspaces.pickPersona': '选择人设',
      // —— 会话覆盖清理（0.9.0-f）——
      'sessions.title': '会话覆盖',
      'sessions.hint': '会话里临时改过的人设。会话不存在后会先观察 30 天，确认不回再清理。',
      'sessions.scanning': '正在检查…',
      'sessions.scanFailed': '无法完成检查：{reason}',
      'sessions.scanIncomplete': '宿主未提供会话清单，本次不做任何判定 —— 「没看到」不等于「已删除」。',
      'sessions.summary': '共 {total} 个 · 待观察 {markable} · 可回收 {collectable} · 损坏 {quarantine}',
      'sessions.collect': '清理可回收项',
      'sessions.collectArmed': '确认清理 {count} 项？',
      'sessions.collected': '已清理 {count} 项。',
      'sessions.nothing': '没有可回收的条目。',
      'sessions.previewHint': '预览不会删除任何文件；确认后才会真的清理。',
      'group.tool': 'Agent 工具',
      'field.toolConfirm': '人设变更需确认',
      'hint.toolConfirm': '开启后，Agent 改人设会先在输入框处弹出审批面板（Enter 允许 / Esc 拒绝）。若会话审批通道不可用（策略为 never），则退化为待确认提议，需用 /soul confirm 处理 —— 此时建议关闭本开关，否则每次改动都要手输命令。',
      // —— 变更记录（0.8.0）——
      'group.history': '变更记录',
      'history.empty': '还没有任何变更记录。',
      'history.loading': '加载中...',
      'history.loadFailed': '无法读取变更记录：{reason}',
      'history.summary': '最近 {count} 条 · 最多保留 {max} 条',
      'history.more': '还有 {count} 条',
      'history.clear': '清空记录',
      'history.clearArmed': '确认清空？',
      'history.clearDone': '已清空 {count} 条变更记录。',
      // 按钮用「撤销」而不是「恢复」：点一条记录的结果是**把这一次改动撤掉**
      // （连同它之后的），不是「切回那天的状态」。
      'history.restore': '撤销这一次',
      'history.restoreArmed': '撤销？',
      'history.restoreDone': '已撤销 {count} 次改动。',
      'history.restoreUnchanged': '在撤销之前，这些改动就已经被后续改动改回去了。',
      'history.restorePreset': '恢复此预设',
      'history.restorePresetDone': '已恢复预设「{name}」。',
      'history.restorePresetSkipped': '未恢复「{name}」：{reason}',
      'history.skip.exists': '当前已有同名的预设',
      'history.skip.builtin': '这是内置预设',
      'history.skip.invalid-name': '名字不合法',
      'history.restoreSkippedNote': '已恢复 {count} 个，另有 {skipped} 个未恢复。',
      'history.diverged': '记录与当前配置对不上，无法撤销。可能有人手工改过配置文件。',
      'history.warning': '记录可能不完整：{reason}',
      'history.footer': '撤销人设配置，不影响人设预设库。',
      'history.fields': '涉及 {fields}',
      'history.field.from': '原值',
      'history.field.to': '新值',
      'history.personasAdded': '新增预设 {names}',
      'history.personasRemoved': '删除预设 {names}',
      'history.personasUpdated': '覆盖预设 {names}',
      // —— label：条目的人类可读上下文（0.8.0 打磨）——
      // 折叠行里「应用预设 · 自定义指令」答不了「应用的是什么」；有 label 时拼在来源后面。
      'history.labelSuffix': '：{label}',
      'history.source.web': '网页保存',
      'history.source.command': '斜杠命令',
      'history.source.tool': 'Agent 工具',
      'history.source.service': '插件调用',
      'history.source.persona': '应用预设',
      'history.source.rollback': '撤销',
      'history.source.restorePersona': '恢复预设',
      // —— 变更记录：列表渲染补充（0.8.0-d）——
      // 服务端没带回容量上限时的退路：宁可不提「最多保留 N 条」，也不编一个数字出来。
      'history.summaryCount': '最近 {count} 条',
      // 双入口（0.8.1）：主入口在插件详情页，设置页不再留独立指引行（突兀且占地）；
      // 变更记录的主入口在插件详情页。这里不再罗列「撤销、恢复预设、清空都在那里」
      // —— 那是三个按钮的名字，点进去自然看得到；罗列只会把一行提示撑成一段话。
      'history.entryHint': '改动都能撤销',
      // hover 全文：具体的「在哪儿、能做什么」。正文只留一句判断，细节按需展开。
      'history.entryHintMore': '变更记录在插件详情页（插件管理 → 已安装插件 → dsh-soul）：撤销某次改动及其之后的全部改动、恢复被删的预设、清空记录，都在那里。',
      // —— 变更记录保留条数（0.8.0 打磨）——
      'history.maxEntries': '保留条数',
      'history.maxEntriesHint': '变更记录最多保留多少条。超出后自动丢弃最旧的记录；条数越多，可撤销的范围越大。',
      'history.maxEntriesDefault': '{count} 条（默认）',
      'history.maxEntriesOption': '{count} 条',
      'history.maxEntriesSaved': '保留条数已改为 {count} 条。',
      'history.timeJustNow': '刚刚',
      'history.timeMinutes': '{count} 分钟前',
      'history.timeHours': '{count} 小时前',
      'history.timeDays': '{count} 天前',
      // 空值必须显式画出来：留空会被读成「渲染坏了」，而「这次把它清空了」是一条事实
      'history.valueEmpty': '（空）',
      // 服务端不记空条目，所以这一句正常情况下到不了屏幕；但记录文件是可以被手工
      // 改坏的，真遇到时宁可写「无字段变化」，也不要显示成裸键名 history.emptyFields。
      'history.emptyFields': '无字段变化',
      'button.save': '保存设置',
      'button.saving': '保存中...',
      'button.cancel': '取消',
      'button.reset': '重置默认',
      'status.loading': '加载中...',
      'status.unsaved': '有未保存的更改',
      // —— 内联绿字（对齐宿主模型设置页的 savedNotice）——
      // 保存类成功提示不再走 toast（宿主那里根本不用 toast 报成功），
      // 文案对齐宿主语气：句末带句号、不带 emoji（宿主绿字没有装饰符号）
      'notice.saved': '设置已保存。',
      'notice.noChanges': '配置无变化。',
      'notice.reset': '已重置为默认值。',
      'notice.resetRecovered': '已重置为默认值（损坏的配置已备份）。',
      'notice.personaSaved': '已保存预设「{name}」。',
      'notice.personaSavedAndApplied': '已保存并应用预设「{name}」。',
      'personas.applyAfterSave': '保存后立即应用',
      'sidebar.personaTip': '人设：{name}',
      'personas.applyAfterSaveHint': '不勾选则保留当前配置不变（表单恢复到已保存的设置）',
      'notice.personaUsed': '已应用预设「{name}」。',
      'notice.personaUnchanged': '预设与当前配置一致。',
      'notice.personaDeleted': '已删除预设「{name}」。',
      // 以下错误类仍走 toast（打断性提示）
      'toast.saved': '✅ 设置已保存',
      'toast.noChanges': '✅ 配置无变化',
      'toast.reset': '✅ 已重置为默认值',
      'toast.resetRecovered': '✅ 已重置为默认值（损坏的配置已备份）',
      'toast.resetFailed': '❌ 重置失败',
      'toast.personaSaved': '✅ 预设已保存',
      'toast.personaUsed': '✅ 预设已应用',
      // 预设含非法取值时服务端只应用合法部分，被跳过的字段必须回报
      'toast.personaPartial': '⚠ 预设仅部分应用，以下字段取值非法已跳过：{fields}',
      'toast.personaUnchanged': 'ℹ 预设与当前配置一致',
      'toast.personaDeleted': '✅ 预设已删除',
      'prompt.title': '当前生效提示词',
      'prompt.summaryEnabled': '已启用',
      'prompt.summaryDisabled': '已禁用',
      'prompt.summaryChars': '{n} 字符',
      'prompt.loading': '提示词加载中...',
      'prompt.empty': '（个性化已禁用，提示词为空）',
      'prompt.chars': '当前字符数：{n}',
      'prompt.titleDraft': '保存后将生效的提示词',
      'prompt.summaryDraft': '{n} 字符 · 未保存',
      'prompt.invalid': '以下字段未通过校验，未计入本次预览：{fields}',
      // 列表分隔符：中文用顿号、英文用逗号 + 空格。此前英文界面里也硬编码「、」，
      // 会渲染成 `...excluded from this preview: style、tables`（中英混排）。
      'common.listSep': '、',
      'toast.saveFailed': '❌ 保存失败，请检查配置',
      'trail.title': '输入框光轨',
      'trail.enable': '启用输入框光轨',
      'trail.color': '光轨颜色',
      'trail.speed': '流动速度',
      'trail.speed.slow': '慢',
      'trail.speed.normal': '中',
      'trail.speed.fast': '快',
      'trail.width': '光轨粗细',
      'trail.width.thin': '细',
      'trail.width.normal': '中',
      'trail.width.thick': '粗',
      'trail.preview': '效果示例',
      'trail.previewText': 'Agent 回复时，输入框边框会出现流动的光轨',
      'hint.trail': 'Agent 回复期间，输入框边框显示沿边流动的光轨。点击色块、使用取色器，或直接填写十六进制色值（如 #679EFE）。'
    }

    const en = {
      'nav.label': 'Personalization',
      'settings.title': 'Personalization Settings',
      'accordion.filled': 'fields filled',
      'accordion.empty': 'No fields set',
      // 分组摘要在「拉取失败」时的显示（折叠态下用户只看得到这一行）
      'accordion.loadFailed': 'Failed to load',
      'accordion.personas': 'personas',
      'accordion.on': 'enabled',
      'accordion.off': 'disabled',
      'toggle.enabled': 'Enable personalization',
      'quick.enable': 'Enable personalization',
      'quick.disable': 'Disable personalization',
      'quick.statusEnabled': 'Personalization enabled',
      'quick.custom': 'Custom',
      'quick.statusDisabled': 'Personalization disabled',
      // 快捷开关保存失败时的兜底文案（有服务端 error 时优先显示它）
      'quick.toggleFailed': 'Save failed, please retry',
      'group.aboutYou': 'About you',
      'field.nickname': 'Nickname',
      'field.nicknamePlaceholder': 'Your nickname — the agent will address you by it',
      'field.occupation': 'Occupation',
      'field.occupationPlaceholder': 'e.g. software engineer, student, product manager',
      'field.bio': 'Bio',
      'field.bioPlaceholder': 'A short introduction so replies fit your background',
      'group.traits': 'Traits',
      'field.style': 'Reply style & tone',
      'hint.style': "Sets the style and tone the agent uses when replying to you. It does not affect the agent's capabilities.",
      'field.headingLists': 'Headings & lists',
      'hint.headingLists': 'An extra trait layered on top of style & tone. Controls how much answers rely on headings and lists.',
      'field.emoji': 'Emoji',
      'hint.emoji': 'An extra trait layered on top of style & tone. Controls how many emojis answers use.',
      'field.tables': 'Tables',
      'hint.tables': 'An extra trait layered on top of style & tone. Controls how much answers rely on tables.',
      'field.replyLength': 'Reply length',
      'field.activePersonaName': 'Last used persona',
      'hint.replyLength': 'Controls how long answers are. "Balanced" adds no constraint and lets the agent decide.',
      'field.language': 'Output language',
      'hint.language': 'Sets the language the agent replies in; also affects the /soul command output.',
      'field.instructions': 'Custom instructions',
      'hint.instructions': 'Extra persona or habit requirements. Avoid repeating wording similar to the style & tone option above to prevent conflicts.',
      'field.instructionsPlaceholder': 'Custom instructions — other behaviors, style or tone preferences',
      'group.personas': 'Personas',
      'personas.save': 'Save current as persona',
      'personas.saveAs': 'Save as persona…',
      'personas.updateTo': 'Update preset',
      'personas.updateNone': 'No editable custom presets yet. Built-in presets cannot be modified.',
      'personas.updateCovers': 'Writes the persona fields (style, traits, length, instructions) into the selected preset.',
      'personas.updateExcludes': 'Nickname, occupation and bio are not included — they are not part of a persona.',
      'notice.personaUpdated': 'Updated preset "{name}".',
      'personas.saveNameLabel': 'New persona name',
      'personas.saveConfirm': 'Save',
      'personas.saveCovers': 'Saves: reply style & tone, traits, reply length, reply language, custom instructions',
      'personas.saveExcludes': 'Excludes: nickname, occupation, bio (those are "About you" — personas never touch them)',
      'personas.confirmDeleteShort': 'Confirm delete?',
      'personas.details': 'Details',
      'personas.flipBack': 'Back',
      'personas.dims': 'Persona dimensions',
      'personas.customInstructions': 'Custom instructions',
      'personas.dimDefault': 'Default',
      'personas.noCustomInstructions': 'This persona adds no custom instructions',
      'personas.savePlaceholder': 'Persona name (1-30 chars)',
      'personas.use': 'Use',
      'personas.active': 'Active',
      'personas.delete': 'Delete',
      'personas.prev': 'Previous persona',
      'personas.next': 'Next persona',
      'personas.confirmDelete': 'Delete persona "{name}"?',
      'personas.empty': 'No personas yet — save the current config to switch with one click',
      // 列表拉取失败（此前是空 catch ⇒ 界面会永远停在「加载中...」）
      'personas.loadFailed': 'Failed to load personas: {reason}',
      'personas.builtin': 'Built-in',
      'personas.drift': 'The current config matches no preset.',
      'personas.driftAction': 'Save as new preset',
      'personas.hint': 'Personas hold only the agent personality; your nickname and bio never switch with a persona.',
      'personas.hintDetail': 'A persona covers style, traits (headings & lists / emoji / tables), reply length, reply language and custom instructions — never the nickname, occupation or bio under "About you". Built-in personas ship with the plugin and cannot be deleted.',
      'style.professional': 'Professional',
      'style.casual': 'Casual',
      'style.humorous': 'Humorous',
      'style.roast': 'Roast Master',
      'style.efficient': 'Efficient',
      'trait.headingLists.default': 'Default',
      'trait.headingLists.more': 'More (clear formatting with headings and lists)',
      'trait.headingLists.less': 'Less (more paragraph text)',
      'trait.emoji.default': 'Default',
      'trait.emoji.more': 'More (frequent emoji usage)',
      'trait.emoji.less': 'Less (minimal emoji usage)',
      'trait.tables.default': 'Default',
      'trait.tables.more': 'More (prefer tables for comparisons and multi-field data)',
      'trait.tables.less': 'Less (avoid tables; use lists or paragraphs)',
      'trait.replyLength.concise': 'Concise (key points only)',
      'trait.replyLength.normal': 'Balanced (no extra constraint)',
      'trait.replyLength.detailed': 'Detailed (expand background and reasoning)',
      // Short labels for the persona row summary (trait.* full text is too long)
      'meta.replyLength.concise': 'Concise',
      'meta.replyLength.detailed': 'Detailed',
      'meta.headingLists.more': 'More lists',
      'meta.headingLists.less': 'Fewer lists',
      'meta.emoji.more': 'More emoji',
      'meta.emoji.less': 'Less emoji',
      'meta.tables.more': 'More tables',
      'meta.tables.less': 'Fewer tables',
      'meta.language.zh': 'Chinese',
      'meta.language.en': 'English',
      // —— Workspace bindings (0.8.1) ——
      'group.bindings': 'Workspace bindings',
      'bindings.hint': 'A binding remembers a directory, not a session: sessions opened in that directory (or below it) use the bound persona. Saving takes effect for active sessions right away; other directories are untouched.',
      'bindings.currentTitle': 'Current session directory',
      'bindings.noSession': 'No active session, so there is no "in effect right now" to show.',
      'bindings.noCwd': 'This session has no working directory, so no binding can match it — it uses the global config.',
      'bindings.effective': 'Persona in effect',
      'bindings.source': 'Source',
      'bindings.sourceGlobal': 'Global config (everything unbound falls back to it)',
      'bindings.sourceInherited': '{dir} (inherited from a parent directory)',
      'bindings.choose': 'Choose directory…',
      'bindings.manualLabel': 'Directory path',
      'bindings.manualPlaceholder': 'Paste an absolute path, e.g. D:\\project-a',
      'bindings.bindDir': 'Bind',
      'bindings.needDir': 'Enter a directory first, or use "Choose directory…".',
      'bindings.bound': 'Bound: {dir} → {name}',
      'bindings.unbound': 'Unbound: {dir}',
      'bindings.unbindMissing': 'This binding is no longer in the list (it was probably removed elsewhere); reload to refresh.',
      'bindings.pickerUnavailable': 'This connection cannot open the system directory picker; paste the path instead.',
      'bindings.moreSessions': '{count} more active session(s)',
      'bindings.listTitle': 'Bound directories',
      'bindings.loading': 'Loading...',
      'bindings.loadFailed': 'Could not read the workspace bindings: {reason}',
      'bindings.empty': 'No directory is bound yet.',
      'bindings.count': '{count} total · up to {max}',
      'bindings.here': 'This directory',
      'bindings.persona': 'Persona',
      'bindings.unbind': 'Unbind',
      'bindings.unbindArmed': 'Unbind it?',
      'bindings.invalid': 'Persona "{name}" no longer exists',
      'bindings.invalidHint': 'This binding will not take effect; rebind or remove it.',
      'bindings.dropped': '{count} invalid line(s) were ignored.',
      'bindings.warning': 'The binding table may be incomplete: {reason}',
      'bindings.maxPath': 'Path limit {max} characters.',
      'bindings.fallback': 'Unbound directories use the global config',
      'bindings.change': 'Change',
      'session.tabLabel': 'Persona',
      'session.title': 'Persona for this session',
      'session.current': 'In effect',
      'session.workspace': 'Workspace',
      'session.workspaceUnknown': 'Not in any workspace',
      'session.source.global': 'Global config',
      'session.source.workspace': 'Workspace "{name}"',
      'session.source.directory': 'Directory binding',
      'session.source.session': 'Temporary override for this session',
      'session.noPersona': 'Custom (matches no preset)',
      'session.overrideTitle': 'Temporarily use',
      'session.overrideHint': 'Affects this session only; new sessions follow the workspace or global setting.',
      'session.pickPersona': 'Switch to a preset…',
      'session.customOverrides': 'Custom fields',
      'session.clear': 'Remove this session\'s temporary persona',
      'session.cleared': "Removed this session's temporary persona; it now follows the upper scopes.",
      'session.applied': 'This session now uses "{name}".',
      'session.loading': 'Loading...',
      'session.loadFailed': 'Could not read this session\'s persona: {reason}',
      'session.applyFailed': 'Could not apply: {reason}',
      'session.noOverrides': 'No temporary override.',
      'session.badge': 'overridden',
      'quick.scopeSession': 'this session',
      'quick.scopeWorkspace': 'workspace "{name}"',
      'quick.scopeDirectory': 'directory binding',
      'quick.scopeGlobal': 'global config',
      'quick.scopeUnknown': 'session state unknown',
      'personas.scopeGlobal': 'Global',
      'session.useCard': 'Use this',
      'session.pickHint': 'Pick a card on the left to see its full persona here.',
      'session.chipInUse': 'In use',
      'workspaces.title': 'Workspace personas',
      'workspaces.count': '{bound} / {total} bound',
      'workspaces.hint': 'A workspace persona applies only to sessions opened in that workspace; unbound workspaces fall back to the global config.',
      'workspaces.unbound': 'Not bound',
      'workspaces.bind': 'Bind persona',
      'workspaces.rebind': 'Change',
      'workspaces.unbind': 'Unbind',
      'workspaces.unbindArmed': 'Unbind?',
      'workspaces.empty': 'No workspaces yet. Add one from the sidebar, then come back here to set its persona.',
      'workspaces.loading': 'Loading...',
      'workspaces.loadFailed': 'Could not read workspaces: {reason}',
      'workspaces.serverProblem': 'Host service unavailable: {reason}',
      'workspaces.invalid': 'Persona "{name}" no longer exists',
      'workspaces.invalidHint': 'This binding will not take effect; rebind or remove it.',
      'workspaces.applied': '"{name}" is now bound to "{title}".',
      'workspaces.unbindDone': 'Unbound the persona from "{title}".',
      'workspaces.applyFailed': 'Could not apply: {reason}',
      'workspaces.pickPersona': 'Pick a persona',
      'sessions.title': 'Session overrides',
      'sessions.hint': 'Personas changed for a single session. After the session disappears they are watched for 30 days before cleanup.',
      'sessions.scanning': 'Checking…',
      'sessions.scanFailed': 'Could not finish the check: {reason}',
      'sessions.scanIncomplete': 'The host did not provide a session list, so nothing was decided — "not seen" is not "deleted".',
      'sessions.summary': '{total} total · {markable} watching · {collectable} collectable · {quarantine} corrupt',
      'sessions.collect': 'Clean up collectable',
      'sessions.collectArmed': 'Delete {count} item(s)?',
      'sessions.collected': 'Cleaned up {count} item(s).',
      'sessions.nothing': 'Nothing to collect.',
      'sessions.previewHint': 'Previewing deletes nothing; files are removed only after you confirm.',
      'group.tool': 'Agent tools',
      'field.toolConfirm': 'Require confirmation for persona changes',
      'hint.toolConfirm': 'When on, persona changes by the agent first raise an approval panel above the input box (Enter = allow, Esc = reject). If the session approval channel is unavailable (policy = never), it falls back to a pending proposal applied only via /soul confirm. Under full permissions the panel never appears, so turning this switch off is recommended.',
      // —— Change history (0.8.0) ——
      'group.history': 'Change history',
      'history.empty': 'No changes recorded yet.',
      'history.loading': 'Loading...',
      'history.loadFailed': 'Could not read the change history: {reason}',
      'history.summary': 'Last {count} · keeps up to {max}',
      'history.more': '{count} more',
      'history.clear': 'Clear history',
      'history.clearArmed': 'Clear it?',
      'history.clearDone': 'Cleared {count} change records.',
      // "Undo" rather than "restore": clicking a record reverts **that change**
      // (and everything after it), it does not jump back to that day's state.
      'history.restore': 'Undo this change',
      'history.restoreArmed': 'Undo?',
      'history.restoreDone': 'Undid {count} change(s).',
      'history.restoreUnchanged': 'Those changes had already been reverted by later edits.',
      'history.restorePreset': 'Restore this preset',
      'history.restorePresetDone': 'Restored preset "{name}".',
      'history.restorePresetSkipped': 'Did not restore "{name}": {reason}',
      'history.skip.exists': 'a preset with that name already exists',
      'history.skip.builtin': 'it is a built-in preset',
      'history.skip.invalid-name': 'the name is not valid',
      'history.restoreSkippedNote': 'Restored {count}; {skipped} were not restored.',
      'history.diverged': 'The history does not match the current config, so it cannot be undone. The config file may have been edited by hand.',
      'history.warning': 'The history may be incomplete: {reason}',
      'history.footer': 'Undoes persona settings only; your preset library is untouched.',
      'history.fields': 'Touches {fields}',
      'history.field.from': 'was',
      'history.field.to': 'now',
      'history.personasAdded': 'Added preset {names}',
      'history.personasRemoved': 'Deleted preset {names}',
      'history.personasUpdated': 'Overwrote preset {names}',
      'history.labelSuffix': ': {label}',
      'history.source.web': 'Web save',
      'history.source.command': 'Slash command',
      'history.source.tool': 'Agent tool',
      'history.source.service': 'Plugin call',
      'history.source.persona': 'Preset applied',
      'history.source.rollback': 'Undo',
      'history.source.restorePersona': 'Preset restored',
      // —— Change history: list rendering (0.8.0-d) ——
      // Fallback for when the server did not report a capacity: better to omit
      // "keeps up to N" than to invent a number that reads like a promise.
      'history.summaryCount': 'Last {count}',
      // Dual entry (0.8.1): the full view lives on the plugin detail page; the
      // settings group becomes a pointer line so a low-frequency feature stops
      // occupying the settings page permanently.
      'history.entryHint': 'Every change can be undone',
      'history.entryHintMore': 'Change history lives on the plugin details page (Plugin manager → Installed plugins → dsh-soul): undo a change together with everything after it, restore a deleted preset, and clear the log.',
      // —— Change history retention (0.8.0 polish) ——
      'history.maxEntries': 'Entries kept',
      'history.maxEntriesHint': 'How many change-history entries to keep. Older entries are dropped once the limit is reached; a larger number means a longer undo window.',
      'history.maxEntriesDefault': '{count} entries (default)',
      'history.maxEntriesOption': '{count} entries',
      'history.maxEntriesSaved': 'Entries kept is now {count}.',
      'history.timeJustNow': 'just now',
      'history.timeMinutes': '{count} min ago',
      'history.timeHours': '{count} h ago',
      'history.timeDays': '{count} d ago',
      // An empty value must be drawn explicitly: leaving it blank reads as "broken",
      // while "it was cleared" is itself a fact worth showing.
      'history.valueEmpty': '(empty)',
      'history.emptyFields': 'No field changes',
      'button.save': 'Save Settings',
      'button.saving': 'Saving...',
      'button.cancel': 'Cancel',
      'button.reset': 'Reset to Default',
      'status.loading': 'Loading...',
      'status.unsaved': 'You have unsaved changes',
      // Inline success notice (mirrors the host models page savedNotice)
      'notice.saved': 'Settings saved.',
      'notice.noChanges': 'No changes to save.',
      'notice.reset': 'Reset to defaults.',
      'notice.resetRecovered': 'Reset to defaults (the damaged config was backed up).',
      'notice.personaSaved': 'Saved persona "{name}".',
      'notice.personaSavedAndApplied': 'Saved and applied persona "{name}".',
      'personas.applyAfterSave': 'Apply immediately after saving',
      'sidebar.personaTip': 'Persona: {name}',
      'personas.applyAfterSaveHint': 'Leave unchecked to keep the current config unchanged (the form reverts to the saved settings)',
      'notice.personaUsed': 'Applied persona "{name}".',
      'notice.personaUnchanged': 'Persona matches current config.',
      'notice.personaDeleted': 'Deleted persona "{name}".',
      'toast.saved': '✅ Settings saved',
      'toast.noChanges': '✅ No changes to save',
      'toast.reset': '✅ Reset to defaults',
      'toast.resetRecovered': '✅ Reset to defaults (the damaged config was backed up)',
      'toast.resetFailed': '❌ Reset failed',
      'toast.personaSaved': '✅ Persona saved',
      'toast.personaUsed': '✅ Persona applied',
      // 预设含非法取值时服务端只应用合法部分，被跳过的字段必须回报
      'toast.personaPartial': '⚠ Persona applied partially; skipped as invalid: {fields}',
      'toast.personaUnchanged': 'ℹ Persona matches current config',
      'toast.personaDeleted': '✅ Persona deleted',
      'prompt.title': 'Active system prompt',
      'prompt.summaryEnabled': 'Enabled',
      'prompt.summaryDisabled': 'Disabled',
      'prompt.summaryChars': '{n} chars',
      'prompt.loading': 'Loading prompt...',
      'prompt.empty': '(personalization disabled — the prompt is empty)',
      'prompt.chars': 'Current character count: {n}',
      'prompt.titleDraft': 'Prompt after saving',
      'prompt.summaryDraft': '{n} chars · unsaved',
      'prompt.invalid': 'These fields failed validation and are excluded from this preview: {fields}',
      // 列表分隔符：中文用顿号、英文用逗号 + 空格。此前英文界面里也硬编码「、」，
      // 会渲染成 `...excluded from this preview: style、tables`（中英混排）。
      'common.listSep': ', ',
      'toast.saveFailed': '❌ Save failed — please check the config',
      'trail.title': 'Composer light trail',
      'trail.enable': 'Enable composer light trail',
      'trail.color': 'Trail color',
      'trail.speed': 'Flow speed',
      'trail.speed.slow': 'Slow',
      'trail.speed.normal': 'Normal',
      'trail.speed.fast': 'Fast',
      'trail.width': 'Trail thickness',
      'trail.width.thin': 'Thin',
      'trail.width.normal': 'Normal',
      'trail.width.thick': 'Thick',
      'trail.preview': 'Preview',
      'trail.previewText': 'While the agent is replying, a light trail runs along the composer border',
      'hint.trail': 'While the agent is replying, a light trail runs along the composer border. Pick a swatch, use the color picker, or type a hex value (e.g. #679EFE).'
    }

    // 图标替换匹配的导航文案（词典中 nav.label 的全部语言取值）
    const NAV_LABELS = new Set([zh['nav.label'], en['nav.label']])

    // 组件内翻译回退：渲染器未注入 t 时使用中文词典（保证组件可独立渲染/测试）
    function makeFallbackT(dict) {
      return (key, params) => {
        let text = dict[key] ?? key
        if (params) {
          for (const [name, value] of Object.entries(params)) {
            text = text.split(`{${name}}`).join(String(value))
          }
        }
        return text
      }
    }
    const FALLBACK_T = makeFallbackT(zh)

    // -------------------------------------------------------------------------
    // 组件
    // -------------------------------------------------------------------------

    // 选项取值（label 走词典；取值与 lib/config.mjs 的合法值保持一致）
    const STYLE_VALUES = ['professional', 'casual', 'humorous', 'roast', 'efficient']
    const TRAIT_VALUES = ['default', 'more', 'less']
    // 回复长度偏好（与宿主 lib/config.mjs 的 REPLY_LENGTH_VALUES 对齐）
    const REPLY_LENGTH_VALUES = ['concise', 'normal', 'detailed']
    // 输出语言（与宿主 lib/config.mjs 的 LANGUAGE_VALUES 对齐）
    const LANGUAGE_VALUES = ['zh', 'en']

    // 预设行摘要只显示「与默认值不同」的字段——若把 10 个字段全列出来，每行都是
    // 一长串「默认 / 适中」，反而看不出两个预设到底差在哪。默认值须与宿主
    // lib/config.mjs 的 DEFAULT_CONFIG 保持一致。
    const META_FIELD_VALUES = {
      replyLength: REPLY_LENGTH_VALUES,
      headingLists: TRAIT_VALUES,
      emoji: TRAIT_VALUES,
      tables: TRAIT_VALUES,
      language: LANGUAGE_VALUES
    }
    const META_FIELD_DEFAULTS = {
      replyLength: 'normal',
      headingLists: 'default',
      emoji: 'default',
      tables: 'default',
      language: 'zh'
    }
    // 输出语言选项（两种 UI 语言下均自解释，不进词典）
    const LANGUAGE_OPTIONS = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' }
    ]

    // 设置页表单驱动的字段（dirty 检测与保存载荷共用）。
    const FORM_FIELD_KEYS = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth']

    // 由**别的界面**就地管理、因而不在这张表单里的配置字段：
    //   · `historyMaxEntries` —— 插件详情页的变更记录区块（改完即时落盘，不经保存按钮）；
    //   · `workspaces` —— 插件详情页的「工作区人设」区块（同上，0.9.0）。
    // 两者都是复合/非表单语义：设置页的「保存设置」不该顺手提交它们，否则用户在详情页
    // 改完的值会被设置页那份**不知道它改过**的旧表单覆盖回去。
    // activePersonaName（0.9.0-p）同属外部管理：由「使用预设」动作写入，
    // 设置页表单不直接编辑它 —— 但 FIELD_KEYS 必须覆盖（dirty 对账不漏字段）。
    const EXTERNALLY_MANAGED_FIELDS = ['historyMaxEntries', 'workspaces', 'activePersonaName']

    // 配置字段全集（宿主 DEFAULT_CONFIG 的对账基准）。
    // 顺序与 DEFAULT_CONFIG 一致，便于人眼对账；重复字段会让 dirty 判定重复计算。
    // **表单只认 FORM_FIELD_KEYS** —— 拿全集去判 dirty 会让表单对着一个它并不持有的
    // 字段反复比较，语义混乱（当前恰好因为两边都是 undefined 而等价，但那是巧合）。
    const FIELD_KEYS = [...FORM_FIELD_KEYS, ...EXTERNALLY_MANAGED_FIELDS]

    // 变更记录保留条数的可选值。**只放整数档位，不做自由输入**：
    // 这是个一次设定、此后不再碰的容量参数，自由输入只会带来
    // 「输 30 被夹到 50」这种需要额外解释的状态。默认档（200）单独标注出来，
    // 用户想回到出厂设置时一眼能找到。
    // （0.8.1 起这个下拉在插件详情页的变更记录区块内，不在设置页 —— 见下方
    //  `HISTORY_MAX_ENTRIES_OPTIONS` 所在位置的说明。）

    // 其中真正参与 compilePrompt 的字段子集。
    // 提示词预览只依赖它们：改光轨颜色 / 粗细、切换 set_persona 确认模式都不会改变
    // 编译结果，不该因此重新请求，也不该让预览被标成「未保存」。
    const PROMPT_FIELD_KEYS = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions']

    // —— 变更记录（0.8.0）——
    //
    // 审计字段的文案键。**必须覆盖 lib/history.mjs 的 AUDIT_FIELDS**（= DEFAULT_CONFIG 全键）：
    // 漏掉一个，时间线里就会露出一串裸键名（`trailWidth`）。有断言盯着这张表。
    // 复用设置页既有文案而不是另写一份：同一样东西在两处叫不同名字，用户会以为不是一回事。
    const HISTORY_FIELD_LABELS = {
      enabled: 'toggle.enabled',
      nickname: 'field.nickname',
      occupation: 'field.occupation',
      bio: 'field.bio',
      style: 'field.style',
      headingLists: 'field.headingLists',
      emoji: 'field.emoji',
      tables: 'field.tables',
      replyLength: 'field.replyLength',
      language: 'field.language',
      customInstructions: 'field.instructions',
      requireToolConfirmation: 'field.toolConfirm',
      trailEnabled: 'trail.enable',
      trailColor: 'trail.color',
      trailSpeed: 'trail.speed',
      trailWidth: 'trail.width',
      // 保留条数本身也是被审计的字段：改它同样会留一条记录（否则用户改了容量，
      // 记录里查不到是谁改的），所以它必须有自己的标签。
      historyMaxEntries: 'history.maxEntries',
      // 最近一次「使用预设」实际点的名字（0.9.0-p）：切预设同样要留痕，
      // 否则变更记录里它显示成裸键名。
      activePersonaName: 'field.activePersonaName'
    }

    // 与 lib/history.mjs 的 HISTORY_SOURCES 对齐；认不出的来源原样显示。
    const HISTORY_SOURCES = ['web', 'command', 'tool', 'service', 'persona', 'rollback', 'restorePersona']

    // 一次最多铺开多少条。记录上限是 200 条，全渲染会让这一组比整个设置页还长；
    // 超出的折成一行「还有 N 条」，想看完的人再点一次。
    const HISTORY_RENDER_LIMIT = 20

    // —— 变更记录保留条数（0.8.1 从设置页迁到插件详情页）——
    //
    // 它描述的是「这个区块自己保留多少条」，放在它**自己旁边**才是对话该发生的位置：
    // 用户在详情页看到「最近 37 条 · 最多保留 200 条」，想改这个 200 时就地能改，
    // 而不必先去设置页的「人设预设」组里找 —— 那个位置解释不清（它既不是预设，
    // 也只是「变更记录」这个分组的容量，而设置页早已没有变更记录分组了）。
    //
    // 档位由服务端 HISTORY_MAX_ENTRIES 与 clampHistoryMaxEntries 兜底；客户端这组
    // 常量只负责「给哪些选项」。上限 500 因为条目只存变化字段、远在 512 KB 之内；
    // 下限 50 因为再小则「上一轮就没了」。
    const HISTORY_MAX_ENTRIES_OPTIONS = [50, 100, 200, 500]
    const HISTORY_MAX_ENTRIES_DEFAULT = 200

    // 枚举字段 → 既有文案键的映射表（模块级：SoulSettings 与 SoulHistorySection 共用）。
    // 枚举值复用设置页的既有文案键（`style.*` / `trait.*` / `trail.speed.*` …），
    // 布尔用「已开启 / 未开启」，其余原样显示。
    const HISTORY_ENUM_KEYS = {
      style: (value) => `style.${value}`,
      headingLists: (value) => `trait.headingLists.${value}`,
      emoji: (value) => `trait.emoji.${value}`,
      tables: (value) => `trait.tables.${value}`,
      replyLength: (value) => `trait.replyLength.${value}`,
      trailSpeed: (value) => `trail.speed.${value}`,
      trailWidth: (value) => `trail.width.${value}`
    }
    const HISTORY_ENUM_VALUES = {
      style: STYLE_VALUES,
      headingLists: TRAIT_VALUES,
      emoji: TRAIT_VALUES,
      tables: TRAIT_VALUES,
      replyLength: REPLY_LENGTH_VALUES,
      trailSpeed: TRAIL_SPEED_VALUES,
      trailWidth: TRAIL_WIDTH_VALUES
    }

    // 提示词小图标：hover / 键盘聚焦都展示说明文字。
    // 此前只有 :hover 可达，且提示节点用 visibility:hidden —— 那会把它移出无障碍树，
    // 键盘与读屏用户拿不到字段说明。这里补 tabIndex 让它可以聚焦，并在 :focus-visible
    // 下显示提示（同时保留 aria-label，聚焦时读屏会念出说明本身）。
    function SoulHint(props) {
      return e('span', { className: 'soul-hint', 'aria-label': props.text, tabIndex: 0 },
        e('svg', {
          viewBox: '0 0 24 24',
          width: 14,
          height: 14,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
          e('circle', { cx: 12, cy: 12, r: 10 }),
          e('line', { x1: 12, y1: 16, x2: 12, y2: 12 }),
          e('line', { x1: 12, y1: 8, x2: 12.01, y2: 8 })
        ),
        e('span', { className: 'soul-hint-tip', role: 'tooltip' }, props.text)
      )
    }

    // 可折叠设置面板：同一时间只展开一个区域，并持久化用户最后的选择。
    //
    // 曾经这里有个 `hint` prop，把问号提示渲染在折叠标题旁的 head 里。用户反馈：
    // 折叠态挂问号等于把说明放在「还没展开就能看到」的位置，而它解释的恰恰是展开后
    // 的东西。现在说明一律写进 body 里（能直接读的文字优先于 hover），
    // head 层随之取消 —— 触发器恢复成 section 的直接子元素。
    function SoulAccordion(props) {
      const { id, title, summary, open, onToggle, children } = props
      return e('section', { className: `soul-accordion${open ? ' soul-accordion-open' : ''}` },
        e('button', {
          type: 'button',
          className: 'soul-accordion-trigger',
          'aria-expanded': open,
          'aria-controls': `${id}-body`,
          onClick: onToggle
        },
          e('span', { className: 'soul-accordion-title' }, title),
          e('span', { className: 'soul-accordion-summary' }, summary),
          e('span', { className: 'soul-accordion-icon', 'aria-hidden': true }, open ? '−' : '+')
        ),
        open && e('div', { id: `${id}-body`, className: 'soul-accordion-body' }, children)
      )
    }

    // —— 变更记录（0.8.0 → 0.8.1 双入口改造）——
    //
    // 0.8.1 起主入口是**插件详情页**（plugins.detail.section 槽位）：
    // 变更记录是低频的回顾性信息，长期占着设置页主区不值得；详情页地方大，
    // 可以按宿主 detailSection 的排版充分展示。设置页只留一行指引（见 SoulSettings）。
    //
    // 组件收 { useSoulController, controller, t, subject }：subject 由宿主传入
    //（bundle / item / row 三种形态）—— 只有 dsh-soul 自己的详情页才渲染，
    // 其他插件的详情页必须渲染 null（槽位契约原话："renders null for a subject
    // it has nothing for"）。挂载时才拉取：比设置页的「展开才拉」更懒。
    function SoulHistorySection(props) {
      const { useSoulController, controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const subject = props.subject || null
      // 只服务自己的详情页。bundle 形态才有 pkg.name（item/row 形态没有，
      // 一律不渲染 —— 它们是另一个层级的页面）。
      if (!subject || subject.kind !== 'bundle' || !subject.pkg || subject.pkg.name !== 'dsh-soul') return null

      const state = useSoulController((state) => state)
      const { history, historyWarning, historyMax, historyError, historyMaxEntries } = state

      // 结果提示：与设置页同款双轨 —— 成功绿字（role=status）、失败红字（role=alert），
      // 失败压过成功。独立于 pendingUndo/pendingClear（那两个有 5s 超时）。
      const [notice, setNotice] = React.useState(null)
      const [errorNotice, setErrorNotice] = React.useState(null)

      // —— 保留条数（0.8.1 从设置页迁来）——
      //
      // 它是**配置字段**（落 soul-config.json、进审计），但在这里是「就地的容量参数」：
      // 改完立刻 POST，不等设置页那个保存按钮——用户在详情页改完就走人了，
      // 要求他再去设置页点一次保存，等于挖了个坑。
      //
      // 乐观更新 + 失败回滚：先把本地值改成新值（下拉立刻响应），服务端拒绝
      // （校验 / 磁盘损坏）时退回原值并报红字。不做「保存中禁用」——这是个
      // 一次性动作，且服务端有写队列，连点几次只会依次落盘。
      const [retentionPending, setRetentionPending] = React.useState(false)
      const savedRetention = Number.isFinite(historyMaxEntries) ? historyMaxEntries : HISTORY_MAX_ENTRIES_DEFAULT

      // —— 二次确认与浏览状态（从 SoulSettings 平移，语义不变）——
      const [pendingUndo, setPendingUndo] = React.useState(null)
      const [pendingClear, setPendingClear] = React.useState(false)
      // 展开的是哪一条（存 id 而不是下标：重拉后顺序可能变，存下标会展开错行）。
      const [expandedEntry, setExpandedEntry] = React.useState(null)
      // 「还有 N 条」被点开后就一直摊开：记录只在写配置时变。
      const [showAllHistory, setShowAllHistory] = React.useState(false)

      React.useEffect(() => {
        if (pendingUndo === null && !pendingClear) return
        const timer = setTimeout(() => {
          setPendingUndo(null)
          setPendingClear(false)
        }, 5000)
        return () => clearTimeout(timer)
      }, [pendingUndo, pendingClear])

      const showError = (text) => {
        setNotice(null)
        setErrorNotice(text)
      }
      const showNotice = (text) => {
        setErrorNotice(null)
        setNotice(text)
      }

      // 保留条数的就地保存（定义放在 showError / showNotice 之后：它们是被引用的
      // 绑定，写在前面会在首次渲染时落进 TDZ —— 本文件踩过同一个坑）。
      const changeRetention = async (next) => {
        if (retentionPending || next === savedRetention) return
        setRetentionPending(true)
        setErrorNotice(null)
        try {
          // 只发这一个字段：服务端把 POST 体当 patch 用（`{ ...current, ...patch }`），
          // 不必回传整份配置 —— 也就不会把别的标签页刚改的字段覆盖回旧值。
          const payload = await controller.saveConfig({ historyMaxEntries: next })
          if (!payload) {
            showError(t('toast.saveFailed'))
            return
          }
          // 服务端会夹取（clampHistoryMaxEntries）：回读它**实际接受**的值，
          // 而不是相信我们发出去的那个。
          const applied = Number.isFinite(payload.config && payload.config.historyMaxEntries)
            ? payload.config.historyMaxEntries
            : savedRetention
          showNotice(t('history.maxEntriesSaved', { count: String(applied) }))
          // 窗口可能变小（例如 200 → 50）：顺手把列表刷新回新窗口，免得界面上
          // 还挂着按旧上限读来的条目。
          await controller.loadHistory()
        } catch (err) {
          showError(messageOf(err))
        } finally {
          setRetentionPending(false)
        }
      }

      const handleUndo = async (id) => {
        if (pendingUndo !== id) {
          setPendingUndo(id)
          return
        }
        setPendingUndo(null)
        try {
          const payload = await controller.rollbackHistory(id)
          await controller.loadHistory()
          const count = Array.isArray(payload && payload.reversed) ? payload.reversed.length : 0
          if (count === 0) {
            showNotice(t('history.restoreUnchanged'))
          } else {
            showNotice(t('history.restoreDone', { count: String(count) }))
          }
        } catch (err) {
          showError(messageOf(err))
        }
      }

      const handleRestorePreset = async (id) => {
        try {
          const payload = await controller.restorePersona(id)
          await controller.loadHistory()
          const restored = Array.isArray(payload && payload.restored) ? payload.restored : []
          const skipped = Array.isArray(payload && payload.skipped) ? payload.skipped : []
          const names = restored.join(t('common.listSep'))
          showNotice(
            skipped.length > 0
              ? `${t('history.restorePresetDone', { name: names })} ${t('history.restoreSkippedNote', { count: String(restored.length), skipped: String(skipped.length) })}`
              : t('history.restorePresetDone', { name: names })
          )
        } catch (err) {
          showError(messageOf(err))
        }
      }

      const handleClearHistory = async () => {
        if (!pendingClear) {
          setPendingClear(true)
          return
        }
        setPendingClear(false)
        try {
          const payload = await controller.clearHistory()
          await controller.loadHistory()
          const removed = payload && typeof payload.removed === 'number' ? payload.removed : 0
          showNotice(t('history.clearDone', { count: String(removed) }))
        } catch (err) {
          showError(messageOf(err))
        }
      }

      // 挂载即拉取：详情页本来就是「专门来看记录」才打开的页面。
      React.useEffect(() => {
        if (!controller.canRefresh()) return
        void controller.loadHistory()
      }, [controller])

      // —— 渲染辅助（与 0.8.0-d 同源，搬成组件内局部函数）——
      const historySummary = historyError
        ? t('accordion.loadFailed')
        : (history === null
          ? t('status.loading')
          : (history.length === 0
            ? t('accordion.empty')
            : (Number.isFinite(historyMax)
              ? t('history.summary', { count: String(history.length), max: String(historyMax) })
              : t('history.summaryCount', { count: String(history.length) }))))

      const historyTimeText = (rawAt) => {
        const at = Date.parse(rawAt)
        if (!Number.isFinite(at)) return String(rawAt)
        const diff = Date.now() - at
        // 时钟回拨（或服务端时间略快）会让 diff 变成负数 —— 当成「刚刚」。
        if (diff < 60 * 1000) return t('history.timeJustNow')
        const minutes = Math.floor(diff / (60 * 1000))
        if (minutes < 60) return t('history.timeMinutes', { count: String(minutes) })
        const hours = Math.floor(minutes / 60)
        if (hours < 24) return t('history.timeHours', { count: String(hours) })
        return t('history.timeDays', { count: String(Math.floor(hours / 24)) })
      }

      const historySourceText = (source) => {
        const key = `history.source.${String(source)}`
        return HISTORY_SOURCES.includes(source) ? t(key) : String(source)
      }

      const historyValueText = (key, value) => {
        if (value === undefined || value === null || value === '') return t('history.valueEmpty')
        if (typeof value === 'boolean') return t(value ? 'accordion.on' : 'accordion.off')
        if (key === 'language') {
          const hit = LANGUAGE_OPTIONS.find((item) => item.value === value)
          return hit ? hit.label : String(value)
        }
        // 只有落在合法取值里才查词典：否则 `style: 'custom-whatever'` 会渲染成键名本身
        const toKey = HISTORY_ENUM_KEYS[key]
        if (toKey && HISTORY_ENUM_VALUES[key].includes(value)) return t(toKey(value))
        return String(value)
      }

      const historyFieldNames = (entry) => {
        const keys = new Set()
        for (const key of Object.keys(entry.before || {})) keys.add(key)
        for (const key of Object.keys(entry.after || {})) keys.add(key)
        return [...keys]
      }

      const historyPersonaEvents = (entry) => {
        const events = (entry && entry.personas) || {}
        const added = Array.isArray(events.added) ? events.added : []
        const removed = Array.isArray(events.removed) ? events.removed.map((item) => item && item.name).filter(Boolean) : []
        const updated = Array.isArray(events.updated) ? events.updated.map((item) => item && item.name).filter(Boolean) : []
        return { added, removed, updated }
      }

      const historyRowText = (entry) => {
        const parts = historyFieldNames(entry).map((key) => t(HISTORY_FIELD_LABELS[key] || key))
        const events = historyPersonaEvents(entry)
        const sep = t('common.listSep')
        if (events.added.length > 0) parts.push(t('history.personasAdded', { names: events.added.join(sep) }))
        if (events.removed.length > 0) parts.push(t('history.personasRemoved', { names: events.removed.join(sep) }))
        if (events.updated.length > 0) parts.push(t('history.personasUpdated', { names: events.updated.join(sep) }))
        // label（如预设名）紧跟在第一个字段前说出来：「应用预设：苏格拉底式提问者 · 自定义指令」
        // —— 没有它，这一行答不了「应用的是什么」。旧记录没有 label，原样省略。
        if (typeof entry.label === 'string' && entry.label !== '') parts.unshift(t('history.labelSuffix', { label: entry.label }))
        return parts.length > 0 ? t('history.fields', { fields: parts.join(sep) }) : t('history.emptyFields')
      }

      const historyFieldRows = (entry) => {
        const before = (entry && entry.before) || {}
        const after = (entry && entry.after) || {}
        const keys = [...new Set([...Object.keys(after), ...Object.keys(before)])]
        return keys.map((key) => ({
          key,
          label: t(HISTORY_FIELD_LABELS[key] || key),
          from: historyValueText(key, before[key]),
          to: historyValueText(key, after[key])
        }))
      }

      // —— 外壳对齐宿主插件详情页（fO69Vq_ 前缀的样式）——
      // .detailSection：flex column、gap:12px；.sectionHead：baseline 对齐的标题行；
      // .sectionTitle：14px/500/20px；.sectionCount：12px 次要色。
      return e('section', { className: 'soul-detail-history', 'data-soul-history': 'true' },
        e('div', { className: 'soul-detail-history-head' },
          e('h4', { className: 'soul-detail-history-title' }, t('group.history')),
          e('span', { className: 'soul-detail-history-count' }, historySummary)
        ),
        // —— 保留条数：与它约束的内容放在一起 ——
        //
        // 标题行说「最近 37 条 · 最多保留 200 条」，这个 200 就地可改，不必去设置页找。
        // 放在列表**之前**而不是之后：它是这个区块的容量设置，读了标题就会想知道它在哪；
        // 放到几十条记录下面，等于让用户先翻完才看见。
        // 记录为空 / 读取失败时也照常渲染 —— 容量参数与「当前有几条」无关。
        e('div', { className: 'soul-history-retention' },
          e('label', { htmlFor: 'soul-historyMaxEntries' }, t('history.maxEntries')),
          e('select', {
            id: 'soul-historyMaxEntries',
            value: String(savedRetention),
            disabled: retentionPending,
            onChange: (ev) => { void changeRetention(Number(ev.target.value)) }
          },
            ...HISTORY_MAX_ENTRIES_OPTIONS.map((count) => e('option', {
              key: count,
              value: String(count)
            }, count === HISTORY_MAX_ENTRIES_DEFAULT
              ? t('history.maxEntriesDefault', { count: String(count) })
              : t('history.maxEntriesOption', { count: String(count) })))
          ),
          e(SoulHint, { text: t('history.maxEntriesHint') })
        ),
        // 结果提示：成功绿字 / 失败红字，与设置页同一套形态（宿主 savedNotice 语义）
        (notice || errorNotice) && (errorNotice
          ? e('p', { className: 'soul-error-notice', role: 'alert' }, errorNotice)
          : e('p', { className: 'soul-saved-notice', role: 'status', 'aria-live': 'polite' }, notice)),
        historyError
          ? e('div', { className: 'soul-error' }, t('history.loadFailed', { reason: historyError }))
          : (history === null
            ? e('div', { className: 'soul-status' }, t('history.loading'))
            : (history.length === 0
              ? e('div', { className: 'soul-status' }, t('history.empty'))
              : e(Fragment, null,
                // 清空是**不可逆**的（记录里有昵称、职业、自述、自定义指令的原文），
                // 所以它是这一组唯一的危险色按钮，且同样要过二次确认。
                e('div', { className: 'soul-history-head' },
                  e('button', {
                    type: 'button',
                    className: `soul-history-clear${pendingClear ? ' soul-history-clear-armed' : ''}`,
                    onClick: handleClearHistory
                  }, t(pendingClear ? 'history.clearArmed' : 'history.clear'))
                ),

                // 记录可能不完整（末尾被截断 / 文件过大只读了一段 / 有坏行）——
                // 这是「看到的不是全部」，不是失败。
                historyWarning && e('div', { className: 'soul-status soul-history-warning' },
                  t('history.warning', { reason: historyWarning })),

                e('ul', { className: 'soul-history-list' },
                  ...(showAllHistory ? history : history.slice(0, HISTORY_RENDER_LIMIT)).map((entry) => {
                    const isOpen = expandedEntry === entry.id
                    const events = historyPersonaEvents(entry)
                    const rows = historyFieldRows(entry)
                    const arming = pendingUndo === entry.id
                    return e('li', {
                      key: entry.id,
                      className: 'soul-history-item',
                      'data-source': String(entry.source)
                    },
                      e('div', { className: 'soul-history-item-head' },
                        // 整行主体是一个按钮（展开/收起），操作按钮放在它**外面** ——
                        // 按钮里套按钮既非法又会让点「撤销」连带展开。
                        e('button', {
                          type: 'button',
                          className: 'soul-history-item-main',
                          'aria-expanded': isOpen,
                          onClick: () => setExpandedEntry(isOpen ? null : entry.id)
                        },
                          e('span', { className: 'soul-history-time' }, historyTimeText(entry.at)),
                          e('span', { className: 'soul-history-source' }, historySourceText(entry.source)),
                          e('span', { className: 'soul-history-fields' }, historyRowText(entry))
                        ),
                        e('div', { className: 'soul-history-item-actions' },
                          // 撤销用次要色：它可逆；真正不可逆的是清空，危险色留给它。
                          e('button', {
                            type: 'button',
                            className: `soul-history-action${arming ? ' soul-history-action-armed' : ''}`,
                            onClick: () => handleUndo(entry.id)
                          }, t(arming ? 'history.restoreArmed' : 'history.restore')),
                          // 只有「删过预设」的记录才给恢复入口 —— 其余记录点它无事可做。
                          events.removed.length > 0 && e('button', {
                            type: 'button',
                            className: 'soul-history-action',
                            onClick: () => handleRestorePreset(entry.id)
                          }, t('history.restorePreset'))
                        )
                      ),

                      isOpen && e('div', { className: 'soul-history-detail' },
                        rows.length > 0 && e('div', { className: 'soul-history-diff' },
                          // 「展开即全文」：原值/新值不再压成单行省略 —— 自定义指令几百字时，
                          // 一行省略号等于没给。每行竖排：字段名 + 原值块 + 新值块，长文本换行铺开。
                          ...rows.map((row) => e('div', { key: row.key, className: 'soul-history-diff-row' },
                            e('span', { className: 'soul-history-diff-field' }, row.label),
                            row.from !== '' && e('div', { className: 'soul-history-diff-cell' },
                              e('span', { className: 'soul-history-diff-tag' }, t('history.field.from')),
                              e('div', { className: 'soul-history-diff-value' }, row.from)
                            ),
                            e('div', { className: 'soul-history-diff-cell' },
                              e('span', { className: 'soul-history-diff-tag' }, t('history.field.to')),
                              e('div', { className: 'soul-history-diff-value' }, row.to)
                            )
                          ))
                        ),
                        events.added.length > 0 && e('div', { className: 'soul-history-diff-persona' },
                          t('history.personasAdded', { names: events.added.join(t('common.listSep')) })),
                        events.updated.length > 0 && e('div', { className: 'soul-history-diff-persona' },
                          t('history.personasUpdated', { names: events.updated.join(t('common.listSep')) })),
                        events.removed.length > 0 && e('div', { className: 'soul-history-diff-persona' },
                          t('history.personasRemoved', { names: events.removed.join(t('common.listSep')) }))
                      )
                    )
                  })
                ),

                // 「最近 200 条」这句承诺得配一个能看到更多的出口。
                !showAllHistory && history.length > HISTORY_RENDER_LIMIT && e('button', {
                  type: 'button',
                  className: 'soul-history-more',
                  onClick: () => setShowAllHistory(true)
                }, t('history.more', { count: String(history.length - HISTORY_RENDER_LIMIT) })),

                e('div', { className: 'soul-status' }, t('history.footer'))
              )))
      )
    }

    // -------------------------------------------------------------------------
    // 会话级人设（0.9.0-d）—— 注册到宿主的 `conversation.view` 列表槽位
    // -------------------------------------------------------------------------
    //
    // 为什么在这里而不在设置页：会话覆盖**只对这个会话**有意义，而设置页的槽位
    // scope 是 `root`，拿不到 sessionId（宿主契约：settings.section 不注入会话）。
    // `conversation.view` 的 inject 回调是 `(sessionId) => props`，这是插件能拿到
    // 当前会话 id 的唯一正规入口。
    //
    // 与设置页的第二个区别：这里的改动**即时生效**，没有"保存"按钮 ——
    // 用户在对话中途想换个风格，不该先跑去设置页。
    function SoulSessionPersona(props) {
      const { controller, useSoulController } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      // 宿主把当前会话 id 通过槽位 inject 传进来（conversation.view 的约定）。
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      // 全局 store：预设列表、配置都在这里（与设置页同一份）。
      const state = useSoulController((state) => state)

      // 本会话的解析结果**独立于全局 store**：一份覆盖只对它所属的会话有意义，
      // 塞进全局 store 会让两个会话的 tab 互相串味。
      const [localView, setView] = React.useState(null)
      // 会话作用域解析结果 —— **优先读全局 store**，回落本地 state。
      //
      // 为什么：header 的人设标签与这个 tab 是两个组件，都要显示「当前生效的人设 + 来源」。
      // 两边各存一份必然漂移（实测：tab 里切换了人设，header 标签仍显示旧的 ——
      // 因为标签只在 sessionId 变化时取数，而切换人设不改变 sessionId）。
      // store 是单一数据源：saveSessionScope 成功后写入，两边一起刷新。
      const storedScope = state.sessionScopes && state.sessionScopes[String(sessionId)]
      const view = storedScope || localView
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // 右栏详情正在展示哪一张卡（null = 还没选中）。
      //
      // 与「生效」是两件事：这个纯属浏览状态，点卡片只换详情、不改配置；
      // 真正写配置的是详情面板里的「用这个」。初值在下面的 effect 里跟随生效项。
      const [selectedPersona, setSelectedPersona] = React.useState(null)

      // 刻意**不用** React.useCallback：本项目的客户端垫片（scripts/verify-client.mjs）
      // 只实现了 useState / useEffect / useRef —— 用 useCallback 会让整条客户端回归
      // 在这个组件上一头撞死（历史上已经踩过一次）。这里的依赖只有 sessionId，
      // 用普通函数 + 显式依赖数组完全等价，而且垫片也能跑。
      const reload = async () => {
        if (sessionId === null) {
          setView(null)
          setError(null)
          return
        }
        try {
          const payload = await controller.fetchSessionScope(sessionId)
          setView(payload)
          setError(null)
        } catch (err) {
          setError(messageOf(err))
        }
      }

      // 切到别的会话时重新取：这个组件的 props.sessionId 会随宿主切换而变。
      React.useEffect(() => {
        setNotice(null)
        // 切会话时清掉选中态：上一屏看的那张卡与这个会话无关，留着会让人以为它在生效
        setSelectedPersona(null)
        void reload()
        // reload 的闭包只捕获 sessionId（其余是稳定的 setter / controller）
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [sessionId])

      // 预设名列表与设置页同一套排序（内置优先），避免两处顺序不一致。
      const personaNames = state.personas
        ? Object.keys(state.personas).sort((a, b) => {
          const aBuiltin = state.personas[a] && state.personas[a].builtin ? 0 : 1
          const bBuiltin = state.personas[b] && state.personas[b].builtin ? 0 : 1
          return aBuiltin - bBuiltin
        })
        : []

      const apply = async (personaName) => {
        if (sessionId === null || busy) return
        const entry = state.personas ? state.personas[personaName] : null
        if (!entry) return
        setBusy(true)
        setError(null)
        try {
          // 只提交该预设**声明过**的字段（部分覆盖），与「应用预设」「工作区绑定」
          // 走同一条语义 —— 否则三处效果不一致，用户没法用任一处验证另一处。
          const overrides = {}
          for (const key of SESSION_OVERRIDE_KEYS) {
            if (key in entry) overrides[key] = entry[key]
          }
          // 带上**用户实际点的预设名**：服务端要靠它显示"当前生效的是哪个预设"。
          //
          // 只传字段是不够的 —— 覆盖项里没有名字，服务端只能拿当前配置去反查哪个预设
          // 匹配得上。两个预设声明了相同字段时，反查结果取决于**名称排序**：
          // 实测用户自建「游戏策划与开发专家」与内置「自驱型协作者」字段一致时，
          // 点了后者却显示前者。把名字一起传过去，反查就退化成兜底而不是唯一依据。
          const payload = await controller.saveSessionScope(sessionId, overrides, personaName)
          setView(payload)
          setNotice(t('session.applied', { name: personaName }))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      const clear = async () => {
        if (sessionId === null || busy) return
        setBusy(true)
        setError(null)
        try {
          const payload = await controller.clearSessionScope(sessionId)
          setView(payload)
          setNotice(t('session.cleared'))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      // ⚠️ 所有 hook 必须声明在**任何提前 return 之前**。
      //
      // 这个 effect 原先写在 `if (view === null) return ...` 后面，于是：
      //   首屏 view === null  → 提前 return，effect 没执行（hook 数 = 5）
      //   view 到达后          → effect 执行（hook 数 = 6）
      // React 检测到「本次渲染的 hook 比上次多」⇒ error #310
      // （Rendered more hooks than during the previous render）整块 tab 崩溃。
      //
      // 测试台没抓到，是因为它每次 settle 都走完整的渲染循环、且组件从不经过
      // 「先 null 后有值」的两段式挂载。**这是垫片与真实 React 的差异，不是产品逻辑
      // 正确性的证据** —— 教训：hook 顺序在垫片里测不出来，只能靠代码纪律。
      React.useEffect(() => {
        if (selectedPersona !== null) return
        // 优先跟随「当前生效」的预设。
        if (view && typeof view.activePersona === 'string' && view.activePersona !== '') {
          setSelectedPersona(view.activePersona)
          return
        }
        // ⚠️ view 还没加载完时**必须等**：此刻 view 为 null、activePersona 也读不到，
        // 若在这里兜底就会抢先选中第一个预设；等 view 到达后，
        // 「selectedPersona !== null」的守卫又会把正确的选择挡回去 ——
        // 结果是「生效的那张被甩到侧边、中心卡是别的预设」。
        if (!view) return
        // 兜底：全局配置**不匹配任何预设**时（手改过特质、纯自定义配置），
        // 服务端回的 activePersona 是 null。此时若不兜底，选中态永远为 null ⇒
        // 右栏渲染成「点左侧任意一张卡」的空提示 ⇒ **一个按钮都没有**，
        // 用户看到的是「点了没反应」（其实连按钮都没画出来）。
        // 兜底到第一个可用预设，右栏立刻有内容与「用这个」按钮。
        if (personaNames.length > 0) setSelectedPersona(personaNames[0])
        // selectedPersona 是「要不要跟随」的判据，必须进依赖；view / personaNames
        // 变化时重新评估。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [view, selectedPersona, personaNames])

      // 会话 id 缺席（宿主在诊断 / 空白会话时可能不传）：如实说明，不假装能改。
      if (sessionId === null) {
        return e('div', { className: 'soul-session-persona' },
          e('div', { className: 'soul-status' }, t('session.workspaceUnknown'))
        )
      }

      if (view === null) {
        return e('div', { className: 'soul-session-persona' },
          error
            ? e('div', { className: 'soul-error' }, t('session.loadFailed', { reason: error }))
            : e('div', { className: 'soul-status' }, t('session.loading'))
        )
      }

      // 「来源」必须说清是**哪一层**决定的：否则用户看到一个人设名，却不知道该去哪儿改它。
      const sourceText = (() => {
        if (view.source === 'session') return t('session.source.session')
        if (view.source === 'workspace') {
          return t('session.source.workspace', { name: view.workspaceTitle || view.workspaceId || '' })
        }
        if (view.source === 'directory') return t('session.source.directory')
        return t('session.source.global')
      })()

      const hasOverride = view.override !== null && view.override !== undefined
      const activePersona = typeof view.activePersona === 'string' && view.activePersona !== ''
        ? view.activePersona
        : t('session.noPersona')

      // —— 卡牌网格 ——
      //
      // 与设置页的「人设预设」用**同一套卡牌语言**（同样的圆角/描边/插画/压图标题），
      // 理由不是"顺手复用"：用户在设置页学会「一张卡 = 一个人设，点卡面上的按钮就用它」，
      // 到了会话里面对同一个概念（人设），切换成本最低的方式就是长成一样。
      // —— 左：卡牌轮转（叠层）／右：选中卡的详情 ——
      //
      // 轮转而非平铺：会话面板横向空间本来就窄，平铺会把每张卡挤到「名字 + 一句效果」
      // 看不出差异；叠层轮转与设置页的人设卡牌**同构**，用户在设置页学会的
      // 「左右露边 = 可翻，中心大卡 = 正在看」在这里直接复用。
      //
      // 与设置页轮转的两点差异（会话面板高度有限，简化几何）：
      //   · 偏移步长收窄到 68px / 0.94 / 0.88（设置页 92px / 0.9 / 0.8）—— 三张同屏
      //     时总宽约 260px，正好卡进左栏；
      //   · 不做 3D 翻面（右栏详情已承担「看清」，翻面会与它重复）。
      //
      // 选中态与生效态是**两个不同的东西**，必须分开表达：
      //   · selectedPersona = 中心大卡（右栏详情跟着变，纯浏览，不影响配置）；
      //   · isEffective     = 这一张是否正在生效（配置事实，名字前加 ★）。
      const cardFor = (name, offset) => {
        const entry = state.personas ? state.personas[name] : null
        const builtin = !!(entry && entry.builtin)
        const isEffective = hasOverride && activePersona === name
        return e('div', {
          key: name,
          className: 'soul-session-card',
          'data-effective': isEffective ? 'true' : 'false',
          'data-current': offset === 0 ? 'true' : 'false',
          'aria-hidden': offset === 0 ? undefined : 'true',
          // 偏移归**叠层**所有（内联 transform）；与 CSS 里 hover/焦点态的
          // translateY 微抬无关 —— 两者若合成一个 transform 会互相打架。
          style: {
            transform: `translateX(${offset * 78}px) scale(${1 - Math.abs(offset) * 0.06})`,
            zIndex: String(10 - Math.abs(offset)),
            opacity: offset === 0 ? '1' : '0.55'
          },
          // 0.9.0-m：卡牌**不再可点** —— 切换改由下方轮播导航（左右按钮 + 圆点）负责，
          // 与设置页的「人设预设」轮播同一套交互。卡上只保留信息与状态角标。
          //
          // 无障碍名仍然要：卡面已无可见文字（0.9.0-l 移除了遮罩与压图标题），
          // 纯图形元素必须有可访问名，读屏用户才知道这是哪张卡。
          'aria-label': name,
          title: isEffective ? `${name}（${t('session.chipInUse')}）` : name
        },
          e('div', { className: 'soul-persona-art' },
            e('img', {
              className: 'soul-persona-art-img',
              src: new URL(`/api/soul/persona-art/${encodeURIComponent(name)}`, hostBase()).href,
              alt: '',
              loading: 'lazy',
              decoding: 'async',
              draggable: 'false',
              onError: (ev) => { ev.target.style.display = 'none' }
            }),
            // 遮罩与压图文字**已移除**（0.9.0-l）：右侧详情已完整展示人设名、
            // 六个维度与自定义指令全文，卡上再叠一层渐变遮罩 + 文字只是重复，
            // 而且遮罩会让插画本身失掉大半饱和度 —— 既然是「完全展示卡牌」，
            // 就让插画原样呈现。
            //
            // 保留的是**功能性角标**（不是文字信息，右栏没有的）：
            //   · 内置徽标 —— 这张卡是内置的还是自建的
            //   · 位置指示 i / n —— 排第几张（只标中心卡，否则三张都显示同一个数）
            //   · ★ —— 这张正在生效（原本在名字前，名字没了就挪到右上角）
            builtin && e('span', { className: 'soul-persona-badge' }, t('personas.builtin')),
            offset === 0 && e('span', { className: 'soul-persona-card-pos' }, `${personaIndexOf(name) + 1} / ${personaNames.length}`),
            isEffective && e('span', { className: 'soul-session-card-star' }, '★')
          )
          // 下方不再有文字区（0.9.0-j）：右栏详情已完整展示人设名、六个维度、
          // 自定义指令全文与效果说明，卡上重复一遍是冗余，还会把插画挤成半张。
          // 「完全展示卡牌」= 插画铺满整张卡。
          //
          // 压图标题（名字 + 摘要）**保留** —— 插画是抽象主题图，没有名字
          // 认不出是哪张卡。
        )
      }

      // ── 叠层顺序：完整循环 ──
      //
      // 中心永远是 selectedPersona；左露边 = 它的**前一个**（列表头则接尾），
      // 右露边 = 它的**后一个**（列表尾则接头）。首尾相接 ⇒ 点右侧卡它滑到中心、
      // 原中心滑到左侧；点左侧卡反之 —— 整个列表是一个环。
      //
      // ⚠️ 这里**不能**用「selectedPersona 排头 + 其余顺排」那种线性序：
      // 那样点侧边卡时，露出的仍是同一批邻居，视觉上像「只有两张在动」；
      // 而真正该变的是「谁在中心、谁在旁边」。
      // ── 叠层：中心 + 两侧露边，首尾相接 ──
      //
      // 结构直接用「槽位」表达，不再用「stackOrder 下标 + 偏移」两层映射 ——
      // 那两层映射正是本轮三个 bug 的来源：下标与偏移各错一次就渲染出别的卡。
      //
      // slots 的每一项是 { name, offset }：
      //   offset 0  = 中心（= selectedPersona）
      //   offset -1 = 左侧露边（= 它的前一个，列表头则接尾）
      //   offset +1 = 右侧露边（= 它的后一个，列表尾则接头）
      //
      // 预设数不足 3 时**不重复渲染同一张**：[A, B, A] 会产生重复 React key，
      // 且让"恰一张中心卡"的判据失真。
      const personaIndexOf = (name) => personaNames.indexOf(name)
      const stackSlots = (() => {
        const n = personaNames.length
        if (n === 0) return []
        const at = personaIndexOf(selectedPersona)
        if (at === -1) {
          // 选中项不在列表里（预设刚被删）：退回线性序，中心取第一个
          return personaNames.map((name, i) => ({ name, offset: i === 0 ? 0 : 1 }))
        }
        if (n === 1) return [{ name: personaNames[0], offset: 0 }]
        if (n === 2) {
          const other = personaNames[1 - at]
          return [
            { name: other, offset: -1 },
            { name: personaNames[at], offset: 0 }
          ]
        }
        return [
          { name: personaNames[(at - 1 + n) % n], offset: -1 },
          { name: personaNames[at], offset: 0 },
          { name: personaNames[(at + 1) % n], offset: 1 }
        ]
      })()

      // 右栏详情：与设置页卡背**逐字相同**的六个维度 + 自定义指令全文，
      // 外加这一栏独有的操作按钮（用这个 / 取消本会话的临时人设）。
      const detailOf = (name) => {
        if (name === null) {
          return e('div', { className: 'soul-session-detail-empty' }, t('session.pickHint'))
        }
        const entry = state.personas ? state.personas[name] : null
        const builtin = !!(entry && entry.builtin)
        const isEffective = hasOverride && activePersona === name
        return e(Fragment, null,
          e('div', { className: 'soul-session-detail-head' },
            e('span', { className: 'soul-session-detail-name' }, name),
            builtin && e('span', { className: 'soul-persona-badge' }, t('personas.builtin')),
            isEffective && e('span', { className: 'soul-session-badge' }, t('session.chipInUse'))
          ),
          e('div', { className: 'soul-persona-dims' },
            ...PERSONA_DIM_KEYS.map((dim) => e('div', { className: 'soul-persona-dim', key: dim },
              e('span', null, t(`field.${dim}`)),
              e('b', null, personaDimLabelOf(entry, dim, t))
            ))
          ),
          e('div', { className: 'soul-persona-back-label' }, t('personas.customInstructions')),
          e('div', { className: 'soul-persona-fulltext' }, personaFullTextOf(entry, t)),
          e('div', { className: 'soul-session-detail-actions' },
            e('button', {
              type: 'button',
              className: isEffective
                ? 'soul-persona-action soul-persona-active'
                : 'soul-persona-action',
              disabled: busy,
              onClick: () => { void apply(name) }
            }, isEffective ? t('session.chipInUse') : t('session.useCard')),
            hasOverride && isEffective && e('button', {
              type: 'button',
              className: 'soul-session-chip soul-session-chip-clear',
              disabled: busy,
              onClick: () => { void clear() }
            }, t('session.clear'))
          ),
          // 作用范围说明：紧跟操作按钮 —— 它解释的正是上面那个按钮改的东西
          // （「用这个」/「取消本会话的临时人设」都只作用于本会话）。
          // 放在分栏最底部离使用场景太远，用户看不到。
          hasOverride && e('div', { className: 'soul-session-scope-hint' },
            t('session.overrideHint'))
        )
      }

      return e('div', { className: 'soul-session-persona' },
        e('div', { className: 'soul-session-head' },
          e('h4', { className: 'soul-session-title' }, t('session.title')),
          hasOverride && e('span', { className: 'soul-session-badge' }, t('session.badge'))
        ),

        // 当前生效：先回答「现在是谁」，再给操作
        e('div', { className: 'soul-session-current' },
          e('div', { className: 'soul-session-current-name' },
            activePersona,
            // 特质突出点（0.9.0-ab）：非默认的维度摘要，跟在名称后的小字。
            // personaRowMetaOf 的输出正是"风格 + 偏离默认值的维度" —— 与卡面
            // 摘要同源。无匹配预设（自定义配置）时不显示。
            activePersona && state.personas && state.personas[activePersona] && e('span', { className: 'soul-session-current-traits' },
              ` · ${personaRowMetaOf(state.personas[activePersona], t)}`)
          ),
          e('div', { className: 'soul-session-current-source' }, sourceText)
        ),

        (notice || error) && (error
          ? e('p', { className: 'soul-error-notice', role: 'alert' }, t('session.applyFailed', { reason: error }))
          : e('p', { className: 'soul-saved-notice', role: 'status', 'aria-live': 'polite' }, notice)),

        // 临时覆盖：左侧叠层轮转（中心大卡 + 两侧露边）+ 右侧详情面板
        e('div', { className: 'soul-field soul-persona-field' },
          // 标题与上方 tab 标题（.soul-session-title，14px/500）统一 ——
          // 两者是同层级区块标题，原先用 .soul-field-label（12px）视觉不齐（用户反馈）。
          e('h4', { className: 'soul-session-title' }, t('session.overrideTitle')),
          personaNames.length === 0
            ? e('div', { className: 'soul-status' }, t('session.loading'))
            : e('div', { className: 'soul-session-split' },
              // 左侧：轮播区 = 叠层卡 + 下方导航
              e('div', { className: 'soul-session-carousel' },
                // 叠层：中心卡 = selectedPersona（offset 0），左/右各露出前一个/后一个。
                e('div', { className: 'soul-session-grid' },
                  ...stackSlots.map((slot) => cardFor(slot.name, slot.offset))
                ),
                // 轮播导航：左右按钮 + 圆点（与设置页「人设预设」同一套）
                //
                // 为什么**循环**而不是到边界就 disabled：设置页是线性浏览（到头就停），
                // 这里刻意做成环形 —— 预设只有几张，用户想看「下一张」时不该先翻回第一张。
                e('div', { className: 'soul-persona-nav' },
                  e('button', {
                    type: 'button',
                    className: 'soul-persona-navbtn',
                    'data-dir': 'prev',
                    'aria-label': t('personas.prev'),
                    onClick: () => setSelectedPersona(
                      personaNames[(personaIndexOf(selectedPersona) - 1 + personaNames.length) % personaNames.length]
                    )
                  }, '‹'),
                  e('div', { className: 'soul-persona-dots', role: 'tablist' },
                    ...personaNames.map((n, i) => e('button', {
                      key: n,
                      type: 'button',
                      role: 'tab',
                      className: 'soul-persona-dot',
                      'data-active': i === personaIndexOf(selectedPersona) ? 'true' : 'false',
                      'aria-selected': i === personaIndexOf(selectedPersona) ? 'true' : 'false',
                      'aria-label': `${n}（${i + 1}/${personaNames.length}）`,
                      onClick: () => setSelectedPersona(n)
                    }))
                  ),
                  e('button', {
                    type: 'button',
                    className: 'soul-persona-navbtn',
                    'data-dir': 'next',
                    'aria-label': t('personas.next'),
                    onClick: () => setSelectedPersona(
                      personaNames[(personaIndexOf(selectedPersona) + 1) % personaNames.length]
                    )
                  }, '›')
                )
              ),
              e('div', { className: 'soul-session-detail' }, detailOf(selectedPersona))
            ),
        ),

        // 覆盖里的自定义字段（不是预设带来的）：让用户知道"现在生效的不是某个预设"
        hasOverride && (() => {
          const keys = Object.keys(view.override || {})
          if (keys.length === 0) return null
          return e('div', { className: 'soul-field' },
            e('div', { className: 'soul-field-label' }, t('session.customOverrides')),
            // 用字段**标签**（中英双语）而不是裸键名：HISTORY_FIELD_LABELS 是变更记录
            // 同款表，保证「改字段叫什么」在 tab、变更记录、设置页三处一致。
            // 缺失的键回退到原样（万一有人改了字段名又漏了标签）。
            e('div', { className: 'soul-session-fields' }, ...keys.map((key) => e('code', {
              key,
              className: 'soul-session-field'
            }, t(HISTORY_FIELD_LABELS[key] || key))))
          )
        })()
      )
    }

    // 会话覆盖可提交的字段白名单（与服务端 lib/session-scope.mjs 的
    // SESSION_OVERRIDE_FIELDS 逐项一致）。客户端这份只用于「从预设里挑字段」，
    // 真正的校验在服务端 —— 客户端过滤只是少发几个必然被丢弃的键。
    const SESSION_OVERRIDE_KEYS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions']

    // -------------------------------------------------------------------------
    // 卡牌文案（模块级）—— 设置页、会话 tab、工作区卡片共用同一套措辞
    // -------------------------------------------------------------------------
    //
    // 为什么必须共用而不是各写一份：同一个预设在设置页显示「专业严谨 · 多列表」、
    // 在会话里显示「专业严谨」，用户会以为它们是两个东西。语义一致只能靠同一份实现，
    // 靠"记得同步"是不行的（这个项目已经因为手工同步的清单踩过两次）。
    //
    // 依赖注入的 `t`：渲染器按槽位 locale 注入翻译函数，模块级函数拿不到闭包里的 t。

    // 预设摘要：风格 + 所有「偏离默认值」的维度。
    const personaRowMetaOf = (entry, t) => {
      const row = entry || {}
      const parts = []
      if (STYLE_VALUES.includes(row.style)) parts.push(t(`style.${row.style}`))
      else if (row.style) parts.push(row.style)
      for (const [field, allowed] of Object.entries(META_FIELD_VALUES)) {
        const value = row[field]
        if (!value || value === META_FIELD_DEFAULTS[field]) continue
        if (!allowed.includes(value)) continue
        parts.push(t(`meta.${field}.${value}`))
      }
      return parts.join(' · ')
    }

    // 卡面效果栏：优先 customInstructions（人格差异的主要载体），没有则退回摘要。
    // 截断到第一句或 60 字：卡面空间有限，CSS 侧还有 3 行 line-clamp 兜底。
    const personaEffectTextOf = (entry, t) => {
      const raw = typeof (entry || {}).customInstructions === 'string' ? entry.customInstructions.trim() : ''
      if (raw === '') return personaRowMetaOf(entry, t)
      const firstSentence = raw.split(/[。；;\n]/)[0] || raw
      return firstSentence.length > 60 ? `${firstSentence.slice(0, 60)}…` : firstSentence
    }

    // —— 卡背（详情面）的三样辅助，模块级 ——
    //
    // 列出「一个人设完整的六个维度」。顺序与设置页表单一致（风格 → 标题列表 →
    // 表情 → 表格 → 回复长度 → 语言），这样卡背读起来与设置页对得上。
    const PERSONA_DIM_KEYS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language']

    // 单个维度的「值」文案。刻意**不把与默认相同的项留空**：设置页里 trait 的默认值
    // 就是 'default'，而卡背要回答的是「这个人设改了什么」—— 统一标成「默认」比留空
    // 更清楚（留空会让人以为渲染坏了）。
    // 语言维度复用 LANGUAGE_OPTIONS 的标签（'中文' / 'English' 两种语言下同名，
    // 本来就是语言自称，无需翻译）。
    const personaDimLabelOf = (entry, dim, t) => {
      const row = entry || {}
      const value = row[dim]
      if (dim === 'language') {
        const opt = LANGUAGE_OPTIONS.find((o) => o.value === value)
        return opt ? opt.label : t('personas.dimDefault')
      }
      if (dim === 'style') {
        return STYLE_VALUES.includes(value) ? t(`style.${value}`) : t('personas.dimDefault')
      }
      // ⚠️ 判据是 TRAIT_VALUES.includes(value)（合法**取值** 'default'|'more'|'less'），
      // 不是检查 dim —— 这里曾经被误改成检查维度名，结果所有 trait 维度都落到「默认」。
      return TRAIT_VALUES.includes(value) ? t(`trait.${dim}.${value}`) : t('personas.dimDefault')
    }

    // 卡背的全文：这一次**不截断**（正面效果栏才截断）。
    // 预设没写自定义指令时给一句说明，而不是留空 —— 留空会让人以为渲染坏了。
    const personaFullTextOf = (entry, t) => {
      const raw = typeof (entry || {}).customInstructions === 'string'
        ? entry.customInstructions.trim()
        : ''
      return raw === '' ? t('personas.noCustomInstructions') : raw
    }

    // -------------------------------------------------------------------------
    // 工作区人设（0.9.0-e）—— 注册到宿主的 `plugins.detail.section` 槽位
    // -------------------------------------------------------------------------
    //
    // 为什么在插件详情页而不是设置页：设置页是**快捷调整**（风格/语言/开关），
    // 而这里是「这个项目用什么人设」的结构性配置 —— 低频、需要空间（平铺卡片）、
    // 而且与变更记录放在同一页更符合"这是我的插件怎么配"的心智模型。
    //
    // 为什么平铺而不是下拉：工作区通常 3–10 个，每个有 title 与"是否已绑定"两个
    // 信息维度；下拉关闭时只能显示一项，用户必须展开才知道有哪些、哪些还没绑。
    // **未绑定的排前面** —— 那正是用户来这里要处理的事。
    function SoulWorkspaces(props) {
      const { controller, useSoulController } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const subject = props.subject || null
      // 只服务自己的详情页（与变更记录同一判据）。
      if (!subject || subject.kind !== 'bundle' || !subject.pkg || subject.pkg.name !== 'dsh-soul') return null

      const state = useSoulController((state) => state)
      const [view, setView] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // 正在展开人设选择的工作区（null = 没有）
      const [picking, setPicking] = React.useState(null)
      // 待确认解绑的工作区（内联二次确认，与删除预设同一套）
      const [pendingUnbind, setPendingUnbind] = React.useState(null)

      const reload = async () => {
        try {
          const payload = await controller.fetchWorkspaces()
          setView(payload)
          setError(null)
        } catch (err) {
          // ⚠️ 失败时必须清空 view：否则界面继续渲染**上一次成功**的列表，
          // 用户看到的是过期数据却以为是当前的（错误提示与旧卡片同屏，更混乱）。
          setView(null)
          setError(messageOf(err))
        }
      }

      React.useEffect(() => {
        void reload()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      // 解绑的二次确认 5 秒后复位（同设置页的 armed 态）
      React.useEffect(() => {
        if (pendingUnbind === null) return undefined
        const timer = setTimeout(() => setPendingUnbind(null), 5000)
        return () => clearTimeout(timer)
      }, [pendingUnbind])

      const personaNames = state.personas
        ? Object.keys(state.personas).sort((a, b) => {
          const aBuiltin = state.personas[a] && state.personas[a].builtin ? 0 : 1
          const bBuiltin = state.personas[b] && state.personas[b].builtin ? 0 : 1
          return aBuiltin - bBuiltin
        })
        : []

      const bind = async (workspace, persona) => {
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const payload = await controller.saveWorkspacePersona(workspace.workspaceId, persona)
          setView(payload)
          setPicking(null)
          setNotice(t('workspaces.applied', { name: persona, title: workspace.title || workspace.path }))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      const unbind = async (workspace) => {
        if (pendingUnbind !== workspace.workspaceId) {
          setPendingUnbind(workspace.workspaceId)
          return
        }
        setPendingUnbind(null)
        if (busy) return
        setBusy(true)
        setError(null)
        try {
          const payload = await controller.removeWorkspacePersona(workspace.workspaceId)
          setView(payload)
          setNotice(t('workspaces.unbindDone', { title: workspace.title || workspace.path }))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      // 加载中 / 失败 / 空 三态必须分开（0.8.0 的 C14 就是被"加载中显示成空"抓到的）
      const body = (() => {
        if (error !== null && view === null) {
          return e('div', { className: 'soul-error' }, t('workspaces.loadFailed', { reason: error }))
        }
        if (view === null) {
          return e('div', { className: 'soul-status' }, t('workspaces.loading'))
        }
        if (view.indexProblem) {
          // 宿主服务不可用：如实说明，不给一个"看起来是空的"列表
          return e('div', { className: 'soul-error' }, t('workspaces.serverProblem', { reason: view.indexProblem }))
        }
        const items = Array.isArray(view.workspaces) ? view.workspaces : []
        if (items.length === 0) {
          return e('div', { className: 'soul-status' }, t('workspaces.empty'))
        }

        // 未绑定的排前面：那正是用户来这一页要处理的事
        const sorted = items.slice().sort((a, b) => {
          if (a.bound !== b.bound) return a.bound ? 1 : -1
          return String(a.title || a.path).localeCompare(String(b.title || b.path))
        })

        return e('div', { className: 'soul-ws-list' }, ...sorted.map((ws) => {
          const title = ws.title || ws.path
          const armed = pendingUnbind === ws.workspaceId
          const isPicking = picking === ws.workspaceId
          return e('div', {
            key: ws.workspaceId,
            className: ws.bound ? 'soul-ws-card soul-ws-card-bound' : 'soul-ws-card',
            'data-bound': ws.bound ? 'true' : 'false'
          },
            e('div', { className: 'soul-ws-main' },
              e('div', { className: 'soul-ws-title' }, title),
              e('code', { className: 'soul-ws-path', title: ws.path }, ws.path),
              ws.invalidPersona && e('div', { className: 'soul-ws-invalid' },
                e('span', null, t('workspaces.invalid', { name: ws.persona || '' })),
                e('span', { className: 'soul-status' }, t('workspaces.invalidHint')))
            ),
            e('div', { className: 'soul-ws-actions' },
              // 已绑定：显示当前人设名 + 改绑 / 解绑
              ws.bound
                ? e(Fragment, null,
                  e('span', { className: 'soul-ws-persona' }, ws.persona || t('workspaces.bound')),
                  e('button', {
                    type: 'button',
                    className: 'soul-ws-action',
                    disabled: busy,
                    onClick: () => setPicking(isPicking ? null : ws.workspaceId)
                  }, t('workspaces.rebind')),
                  e('button', {
                    type: 'button',
                    className: armed ? 'soul-ws-action soul-ws-action-armed' : 'soul-ws-action',
                    disabled: busy,
                    onClick: () => { void unbind(ws) }
                  }, t(armed ? 'workspaces.unbindArmed' : 'workspaces.unbind'))
                )
                : e(Fragment, null,
                  e('span', { className: 'soul-ws-unbound' }, t('workspaces.unbound')),
                  e('button', {
                    type: 'button',
                    className: 'soul-ws-action soul-ws-action-primary',
                    disabled: busy || personaNames.length === 0,
                    onClick: () => setPicking(isPicking ? null : ws.workspaceId)
                  }, t('workspaces.bind'))
                )
            ),
            // 内联展开人设胶囊（不另开弹层）：一次点击完成绑定
            isPicking && e('div', { className: 'soul-ws-picker' },
              e('span', { className: 'soul-ws-picker-label' }, t('workspaces.pickPersona')),
              e('div', { className: 'soul-session-chips' },
                ...personaNames.map((name) => e('button', {
                  key: name,
                  type: 'button',
                  className: 'soul-session-chip',
                  disabled: busy,
                  onClick: () => { void bind(ws, name) }
                }, name))
              )
            )
          )
        }))
      })()

      const boundCount = Array.isArray(view && view.workspaces)
        ? view.workspaces.filter((w) => w.bound).length
        : 0
      const total = Array.isArray(view && view.workspaces) ? view.workspaces.length : 0

      return e('section', { className: 'soul-detail-history', 'data-soul-workspaces': 'true' },
        e('div', { className: 'soul-detail-history-head' },
          e('h4', { className: 'soul-detail-history-title' }, t('workspaces.title')),
          e('span', { className: 'soul-detail-history-count' },
            t('workspaces.count', { bound: String(boundCount), total: String(total) }))
        ),
        (notice || error) && (error
          ? e('p', { className: 'soul-error-notice', role: 'alert' }, t('workspaces.applyFailed', { reason: error }))
          : e('p', { className: 'soul-saved-notice', role: 'status', 'aria-live': 'polite' }, notice)),
        e('div', { className: 'soul-note' }, t('workspaces.hint')),
        body
      )
    }

    // -------------------------------------------------------------------------
    // 会话覆盖清理（0.9.0-f）—— 插件详情页的第三个区块
    // -------------------------------------------------------------------------
    //
    // 为什么也要一个按钮（而不是只留命令）：命令是给愿意敲的人的，而"我这儿攒了一堆
    // 不知道哪来的会话配置"是所有人都会遇到的事 —— 那时他们不会想到去查文档。
    //
    // 交互刻意做成两步：先**预览**（不删任何东西），确认后才清理。
    // 删除不可逆，且回收依据（会话清单）可能不可用，所以默认永远站在"不删"一侧。
    function SoulSessions(props) {
      const { controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const subject = props.subject || null
      if (!subject || subject.kind !== 'bundle' || !subject.pkg || subject.pkg.name !== 'dsh-soul') return null

      const [plan, setPlan] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // 已预览、待确认（null = 还没预览过）
      const [armedCount, setArmedCount] = React.useState(null)

      const scan = async () => {
        if (busy) return
        setBusy(true)
        setError(null)
        setNotice(null)
        try {
          const payload = await controller.scanSessionScopeGc()
          setPlan(payload)
          // 预览一次即 arm：按钮文案随之变成「确认清理 N 项？」
          setArmedCount(Array.isArray(payload.collectable) ? payload.collectable.length : 0)
        } catch (err) {
          setPlan(null)
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      const apply = async () => {
        if (busy || plan === null) return
        // 第二次点击才真删；第一次只 arm（按钮文案已经说明了后果）
        if (armedCount === null) { void scan(); return }
        if (armedCount === 0) { void scan(); return }
        setBusy(true)
        setError(null)
        try {
          const payload = await controller.applySessionScopeGc()
          setPlan(payload)
          setArmedCount(null)
          const removed = Array.isArray(payload.removed) ? payload.removed.length : 0
          setNotice(t('sessions.collected', { count: String(removed) }))
        } catch (err) {
          setError(messageOf(err))
        } finally {
          setBusy(false)
        }
      }

      const collectable = plan && Array.isArray(plan.collectable) ? plan.collectable.length : 0
      const body = (() => {
        if (error !== null && plan === null) {
          return e('div', { className: 'soul-error' }, t('sessions.scanFailed', { reason: error }))
        }
        if (plan === null) {
          // 还没点「预览」：不自动扫描。清理是运维动作，不该在打开详情页时悄悄跑一遍。
          return e('div', { className: 'soul-status' }, t('sessions.previewHint'))
        }
        return e(Fragment, null,
          // 扫描不完整 → 明确说"没做判定"，并**隐藏清理按钮**（没有判定就没有可清理项）
          plan.scanComplete === false
            ? e('div', { className: 'soul-status' }, t('sessions.scanIncomplete'))
            : e('div', { className: 'soul-status' },
              t('sessions.summary', {
                total: String(plan.total || 0),
                markable: String((plan.markable || []).length),
                collectable: String(collectable),
                quarantine: String((plan.quarantine || []).length)
              })),
          // 可回收清单：让用户在删之前看见具体是哪些
          collectable > 0 && e('div', { className: 'soul-field' },
            e('div', { className: 'soul-field-label' }, t('sessions.collect')),
            ...plan.collectable.slice(0, 20).map((item) => e('code', {
              key: item.sessionId || item.file,
              className: 'soul-session-field'
            }, String(item.sessionId || item.file)))
          ),
          plan.scanComplete !== false && collectable === 0 && e('div', { className: 'soul-status' }, t('sessions.nothing'))
        )
      })()

      return e('section', { className: 'soul-detail-history', 'data-soul-sessions': 'true' },
        e('div', { className: 'soul-detail-history-head' },
          e('h4', { className: 'soul-detail-history-title' }, t('sessions.title'))
        ),
        (notice || error) && (error
          ? e('p', { className: 'soul-error-notice', role: 'alert' }, t('sessions.scanFailed', { reason: error }))
          : e('p', { className: 'soul-saved-notice', role: 'status', 'aria-live': 'polite' }, notice)),
        e('div', { className: 'soul-note' }, t('sessions.hint')),
        body,
        // 用独立 class 而不是 .soul-buttons：那个 class 属于**设置页的保存按钮区**，
        // 复用会让「保存设置在哪里」这类断言抓到错误的块（verify-config 立刻抓到过）。
        e('div', { className: 'soul-sessions-actions' },
          e('button', {
            type: 'button',
            className: 'soul-ws-action',
            disabled: busy,
            onClick: () => { void scan() }
          }, busy ? t('sessions.scanning') : t('sessions.collect')),
          // 真删按钮的三个条件缺一不可：
          //   ① 预览过（armedCount !== null）；
          //   ② 有可回收项；
          //   ③ **本轮扫描完整** —— 扫描不完整时状态机对一切返回 keep，那时即便
          //      列表里出现 collectable（服务端逻辑变更 / 数据异常），也不该给删除入口。
          //      这是"缺证据时保留"在 UI 上的最后一道闸。
          armedCount !== null && collectable > 0 && plan !== null && plan.scanComplete !== false && e('button', {
            type: 'button',
            className: 'soul-ws-action soul-ws-action-armed',
            disabled: busy,
            onClick: () => { void apply() }
          }, t('sessions.collectArmed', { count: String(collectable) }))
        )
      )
    }

    // -------------------------------------------------------------------------
    // 会话人设标签（只读）—— 挂在会话 header
    // -------------------------------------------------------------------------
    //
    // 为什么从输入框左侧挪到 header：
    // · 输入框左侧横向空间极窄，「个性化已启用 · 人设名 · 层级」根本放不下
    //   （实测被 overflow:hidden 裁掉）；
    // · 会话 header 那一行（标题旁）本来就有横向空间，宿主的「创造模式」标签就挂在那；
    // · 宿主自己在窄容器时会把 header 标签**隐藏**（AgentPresetLabel 的
    //   @container (width<=540px){ display:none }）—— 说明这个位置的设计就是
    //   「有空间才显示」，与我们的诉求一致。
    //
    // 只读：会话的 composition 一旦开始就固定了，header 里放可切换控件会承诺
    //   宿主拒绝兑现的事（这是宿主 AgentPresetLabel 的原话，理由同样成立）。
    //   要改人设去「人设」tab 或设置页。
    function SoulSessionPersonaLabel(props) {
      const { useSoulController, controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const enabled = state.enabled === true
      // scope:'session' 槽位的 inject 收到的是**位置参数** [sessionId]（见宿主契约
      // FactoryInjectParams：scope 'session' → [sessionId: SessionId]）。
      const sessionId = typeof props.sessionId === 'string' && props.sessionId !== '' ? props.sessionId : null
      // 数据来自**全局 store**（sessionScopes[sessionId]），不是组件自己取。
      //
      // 为什么改：原实现自己在 useEffect 里 fetch，依赖只有 [sessionId] ——
      // 会话里切换人设时 sessionId 没变 ⇒ effect 不重跑 ⇒ header 标签仍显示旧人设
      // （用户报的 bug：人设 tab 里切换了，标题栏不变）。
      //
      // 现在 store 是单一数据源：saveSessionScope / clearSessionScope 成功后把服务端
      // 返回的解析结果写进 store ⇒ 所有看它的地方一起刷新，不必各自轮询。
      const scopeView = (state.sessionScopes && state.sessionScopes[String(sessionId)]) || null
      // 请求是否失败过：失败时不得静默退回全局值（那会重现"界面说 A、模型用 B"的割裂）
      const [scopeFailed, setScopeFailed] = React.useState(false)

      // 兜底：store 里还没有这个会话的记录时（首次打开、别的组件写入的），
      // 去取一次。取到后写回 store，后续都走 store。
      React.useEffect(() => {
        if (sessionId === null) return undefined
        if (scopeView !== null) return undefined
        let cancelled = false
        void controller.fetchCurrentSessionScope(sessionId).then((payload) => {
          if (cancelled) return
          controller.setSessionScope(sessionId, {
            activePersona: typeof payload.activePersona === 'string' ? payload.activePersona : null,
            recordedPersona: typeof payload.recordedPersona === 'string' ? payload.recordedPersona : null,
            globalPersona: typeof payload.globalPersona === 'string' ? payload.globalPersona : null,
            source: typeof payload.source === 'string' ? payload.source : null,
            workspaceId: payload.workspaceId || null,
            workspaceTitle: typeof payload.workspaceTitle === 'string' ? payload.workspaceTitle : null,
            override: payload.override || null
          })
          setScopeFailed(false)
        }).catch(() => {
          if (cancelled) return
          setScopeFailed(true)
        })
        return () => { cancelled = true }
      }, [sessionId, scopeView])

      // 关闭个性化时不显示（人设此刻不生效，挂名字会误导）
      if (!enabled) return null

      const activePersona = state.activePersona
      const scopeActive = scopeView && typeof scopeView.activePersona === 'string' && scopeView.activePersona !== ''
        ? scopeView.activePersona
        : null
      const displayPersona = scopeActive
        || (scopeFailed ? t('quick.scopeUnknown') : (activePersona || t('quick.custom')))
      const scopeTag = (() => {
        if (!scopeView) return null
        if (scopeView.source === 'session') return t('quick.scopeSession')
        if (scopeView.source === 'workspace') {
          return t('quick.scopeWorkspace', { name: scopeView.workspaceTitle || scopeView.workspaceId || '' })
        }
        if (scopeView.source === 'directory') return t('quick.scopeDirectory')
        if (scopeView.source === 'global') return t('quick.scopeGlobal')
        return t('quick.scopeUnknown')
      })()

      return e('span', { className: 'soul-session-persona-label' },
        // 图标：宿主的 IconAgentPresetOutlineRegular（智能体预设）。
        //
        // 为什么用宿主现成图标而不是自绘：
        // · 语义正好 —— 「Agent 预设」就是「人设」；
        // · 与**同一位置**的邻居（header 上的「创造模式」标签）用同一套图标语言，
        //   视觉统一，用户的识别成本最低；
        // · 随主题变色（currentColor），不用管深浅色；
        // · 免去自绘 SVG 的描边/尺寸对齐问题。
        //
        // 宿主客户端包（ui-agent-preset / ui-chat / ui-tool）都是
        // require('@deepseek-ai/dsh-client-ui-primitives') 拿它的，
        // 与本插件的 require 机制完全相同。
        //
        // 尺寸 14：与邻居 AgentPresetLabel 的图标一致（size: 14）。
        // 面具图标（0.9.0-w 自绘，0.9.0-x 定稿为「喜剧+悲剧」双面）：戏剧面具 =
        // 「戴上面具扮演另一个角色」+ 一张脸半笑半哭，比 agent-preset 图标更准确
        // 地表达「人设」，也避免与「创造模式」标签撞图标。stroke 用 currentColor。
        // 渲染验证：Chrome headless 截 96/28/14px 三档，14px 下三笔都清晰。
        e('svg', {
          className: 'soul-session-persona-label-icon',
          width: 14,
          height: 14,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
          // 主体：微倾斜的盾形（倾斜 = 戏剧感）。
          // 0.9.0-y：底部从尖角改圆 —— 原两条曲线汇聚到尖点 (8,13.8)，观感尖锐；
          // 改为两侧曲线止于 (11.4,12.4) / (4.6,12.4)，中间用一段平缓弧相连，
          // 下巴呈现圆弧而不是尖。
          e('path', { d: 'M2.2 3.0 C4.2 1.8 11.8 1.8 13.8 3.0 C14.4 6.4 13.0 11.4 11.4 12.4 C10.2 13.1 9.2 13.4 8.0 13.4 C6.8 13.4 5.8 13.1 4.6 12.4 C3.0 11.4 1.6 6.4 2.2 3.0 Z' }),
          // 左眼：笑（上弯弧）；右眼：哭（下弯弧）—— 一张脸两种情绪，
          // 即戏剧「喜剧 + 悲剧」双面。两弧相交于中间，14px 下仍清晰。
          e('path', { d: 'M4.0 6.0 C4.7 5.2 6.1 5.2 6.8 6.0' }),
          e('path', { d: 'M9.2 5.6 C9.9 6.4 11.3 6.4 12.0 5.6' }),
          // 嘴：左高右低的斜线（半笑半哭的暧昧感）
          e('path', { d: 'M4.6 9.6 C6.0 10.2 9.0 9.6 11.2 8.6' })
        ),
        e('span', { className: 'soul-session-persona-label-name' }, displayPersona),
        scopeTag && e('span', { className: 'soul-session-persona-label-scope' }, scopeTag)
      )
    }

    // -------------------------------------------------------------------------
    // 侧栏面板图标「Soul 人设」（0.9.0-ac）
    // -------------------------------------------------------------------------
    //
    // 槽位：sidebar.panellist —— kind:'list' / scope:'root'，"Global panel icons"。
    // 宿主 occupants：插件管理器（plugins）、自动化任务（schedules）等。
    //
    // owner props（SidebarPanelIconOwnerProps）：{ size, active } ——
    // 宿主把"要多大的方块 / 当前是否选中"传给图标，照做即可与邻居对齐。
    //
    // ⚠️ inject 与 session 槽位不同：panellist 是 scope:'root'，runInject 只传
    // [binding.key, actions]（root 无 binding ⇒ 无参）—— inject 只需注入无状态
    // 内容，宿主的 PanelRow 自己拥有点击（拿我们的 id 去 selectPanel）。
    function SoulPanelIcon(props) {
      // 宿主要求方块尺寸与选中态；未传时给默认（14px）
      const size = typeof props.size === 'number' ? props.size : 14
      return e('span', {
        className: 'soul-panel-icon',
        style: { width: size, height: size },
        'aria-hidden': true
      },
        // 面具（与 header 标签同一副「喜剧+悲剧」），stroke: currentColor
        e('svg', {
          width: '100%',
          height: '100%',
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
          e('path', { d: 'M2.2 3.0 C4.2 1.8 11.8 1.8 13.8 3.0 C14.4 6.6 12.4 11.6 8.0 13.8 C3.6 11.6 1.6 6.6 2.2 3.0 Z' }),
          e('path', { d: 'M4.0 6.0 C4.7 5.2 6.1 5.2 6.8 6.0' }),
          e('path', { d: 'M9.2 5.6 C9.9 6.4 11.3 6.4 12.0 5.6' }),
          e('path', { d: 'M4.6 9.6 C6.0 10.2 9.0 9.6 11.2 8.6' })
        )
      )
    }

    // -------------------------------------------------------------------------
    // 侧栏会话行 hover 面具按钮（0.9.0-ab）
    // -------------------------------------------------------------------------
    //
    // 槽位：sidebar.workspaces.session.row.action —— kind:'list' / scope:'root'，
    // 宿主文档："The hover buttons at the end of one Session row, in ascending
    // order, after the '...' menu trigger." ui-workspace 自己注册了
    // archive(100) / pin(200)，我们 order:300 排在后面。
    //
    // owner props（宿主 SessionRowOwnerProps）：{ sessionId, displayTitle } ——
    // 能知道这一行是哪个会话，配合 store.bindingsSessions（含每会话的
    // persona / binding）即可显示该会话当前生效的人设。
    //
    // 展示形态：面具图标按钮，hover 出 tooltip「人设：X（来源）」。
    // 只读 —— 点击不做任何事（按钮本身禁用），它只是把"这个会话现在是谁"
    // 显式摆到侧栏，不用先点开会话再看。
    function SoulSessionPersonaBadge(props) {
      const { useSoulController, sessionId } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const enabled = state.enabled === true

      // 该会话的生效人设：store.bindingsSessions 里按 id 查
      const row = (state.bindingsSessions || []).find(
        (x) => x && x.id === sessionId
      )
      const persona = row && typeof row.persona === 'string' ? row.persona : null
      // 无会话 / 人设未知 / 个性化关闭 ⇒ 不渲染（不占 hover 位）
      if (!enabled || !persona) return null

      const tooltip = t('sidebar.personaTip', { name: persona })

      return e('span', {
        className: 'soul-sidebar-persona-badge',
        // 只读标识：不做动作（点击仍会落在行上，避免误触打开会话）
        title: tooltip,
        'aria-label': tooltip
      },
        e('svg', {
          className: 'soul-sidebar-persona-badge-icon',
          width: 13,
          height: 13,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true
        },
          // 与 header 标签同一副「喜剧+悲剧」面具
          e('path', { d: 'M2.2 3.0 C4.2 1.8 11.8 1.8 13.8 3.0 C14.4 6.6 12.4 11.6 8.0 13.8 C3.6 11.6 1.6 6.6 2.2 3.0 Z' }),
          e('path', { d: 'M4.0 6.0 C4.7 5.2 6.1 5.2 6.8 6.0' }),
          e('path', { d: 'M9.2 5.6 C9.9 6.4 11.3 6.4 12.0 5.6' }),
          e('path', { d: 'M4.6 9.6 C6.0 10.2 9.0 9.6 11.2 8.6' })
        )
      )
    }

    // 输入框工具栏快捷开关：复用全局 soulController，和设置页保持同一份状态。
    function SoulQuickToggle(props) {
      const { useSoulController, controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const enabled = state.enabled === true
      const busy = state.saving === true
      // 保存失败的本地标记：失败时 store.error 会带上原因，但按钮本身此前毫无反馈
      // （enabled 没变 ⇒ 外观与文案都不变），用户视角是「点了没反应」。
      const [failed, setFailed] = React.useState(false)
      const failureText = failed ? (state.error || t('quick.toggleFailed')) : null

      const toggle = async () => {
        if (busy) return
        setFailed(false)
        const payload = await controller.saveConfig({ enabled: !enabled })
        // saveConfig 失败时返回 undefined；成功时返回载荷
        setFailed(!payload)
      }

      return e('button', {
        type: 'button',
        className: failed ? 'soul-quick-toggle soul-quick-toggle-failed' : 'soul-quick-toggle',
        'data-enabled': enabled ? 'true' : 'false',
        'data-failed': failed ? 'true' : 'false',
        'aria-pressed': enabled,
        // 失败时把原因写进 aria-label / title：否则按钮外观不变，用户无从得知保存失败
        'aria-label': failureText || (enabled ? t('quick.disable') : t('quick.enable')),
        title: failureText || (enabled ? t('quick.disable') : t('quick.enable')),
        disabled: busy,
        onClick: toggle
      },
        e('span', { className: 'soul-quick-toggle-dot', 'aria-hidden': true }),
        enabled ? t('quick.statusEnabled') : t('quick.statusDisabled'),
        // 启用时**始终**缀上「当前是哪套人设」：匹配到预设显示预设名，
        // 未匹配（手改过特质、或纯自定义配置）显示「自定义」。
        //
        // 为什么不再留空：留空等于「我现在用的到底是什么」没有答案，而
        // 「未匹配预设」这种说法听着像报错。底栏这里是输入框旁唯一的常驻状态，
        // 必须给确定的落点 —— 有名字就是那个预设，没名字就是自定义。
        // 关闭个性化时不显示（人设此时不生效，挂名字会误导）。
        // 人设名与层级标注**不在这里**（0.9.0-h 挪到会话 header）：
        // 输入框左侧横向空间有限，那串文字会被裁掉；header 那一行才有空间。
        // 这里只留「开/关」这个动作。
      )
    }

    // -------------------------------------------------------------------------
    // 设置页「工作区绑定」分组（0.8.1）
    // -------------------------------------------------------------------------

    // 目录点选服务。由 apply() 里的 ctx.inject(['uiWorkspace'], ...) 动态写入 ——
    // **不能**把它加进静态 inject 数组（`const inject = ['slots','locale']`）：
    // uiWorkspace 缺失时整个插件都不会激活，设置页连同人设卡一起消失。
    // null = 这个连接拿不到该服务，界面直接走手输路径。
    let directoryPicker = null

    // 路径截中段显示：保留结尾（`…\dsh-plugin`）。用户靠结尾区分项目、靠开头区分盘符，
    // 两者都要时优先结尾 —— 同一盘下的项目前缀往往一样长。完整路径交给 title。
    function shortenPath(raw, max) {
      const text = typeof raw === 'string' ? raw : String(raw == null ? '' : raw)
      const limit = Number.isFinite(max) ? max : 44
      if (text.length <= limit) return text
      const tail = text.slice(text.length - (limit - 1))
      // 从第一个分隔符处切，避免留下半截目录名（`…-plugin` 比 `…\dsh-plugin` 难认）
      const cut = Math.max(tail.indexOf('\\'), tail.indexOf('/'))
      return '…' + (cut >= 0 ? tail.slice(cut) : tail)
    }

    // 「工作区绑定」主体。三块结构见 docs/DESIGN-persona-scope.md §7.3：
    //   ① 当前会话目录卡（我这个项目现在是谁）② 绑定列表（增删改查）③ 未绑定回落行。
    //
    // 与变更记录同款**懒加载**：本组件只在分组展开时才被渲染（手风琴 body 的
    // `open && ...`），所以挂载即等于「用户主动打开了它」，effect 里拉一次即可。
    // 刻意不进 2 秒轮询 —— 绑定是配置不是状态，轮询只会让「手机上改了、桌面上跳」。
    function SoulBindings(props) {
      const { useSoulController, controller, personaNames, onOpenPersonas } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const {
        bindings, bindingsInvalid, bindingsDropped, bindingsWarning, bindingsError,
        bindingsMax, bindingsMaxPath, bindingsSessions, activePersona
      } = state

      // 下拉选项：内置优先的稳定顺序由 SoulSettings 算好传进来（同一份排序）。
      const names = Array.isArray(personaNames) ? personaNames : []
      const [draftDir, setDraftDir] = React.useState('')
      const [draftPersona, setDraftPersona] = React.useState('')
      const [pickerFailed, setPickerFailed] = React.useState(false)
      const [pendingUnbind, setPendingUnbind] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [errorNotice, setErrorNotice] = React.useState(null)

      React.useEffect(() => {
        if (!controller.canRefresh()) return
        void controller.loadBindings()
      }, [])

      // 解绑的二次确认 5 秒后自动复位（与删除预设同一套 armed 态，不用原生 confirm）
      React.useEffect(() => {
        if (pendingUnbind === null) return undefined
        const timer = setTimeout(() => setPendingUnbind(null), 5000)
        return () => clearTimeout(timer)
      }, [pendingUnbind])

      const showError = (text) => { setErrorNotice(text); setNotice(null) }
      const showNotice = (text) => { setNotice(text); setErrorNotice(null) }

      // 草稿人设默认取列表第一项 —— 下拉不能空着等用户点，那看着像坏了
      const effectiveDraftPersona = names.includes(draftPersona)
        ? draftPersona
        : (names.length > 0 ? names[0] : '')

      // 调起系统目录选择器。取消返回空串（什么都不做），失败抛错。
      //
      // 降级判据必须是「调用失败」而不是「预读后端种类」：宿主 UiWorkspaceService
      // 的 pickDirectory() 把底层错误（含 capability 字段）包装成了普通 Error，
      // 客户端读不到种类。见 docs/DESIGN-persona-scope.md §7.5。
      async function handlePick() {
        try {
          // 防御：服务可能在按钮渲染后被撤走（插件卸载 / scope 物化），此时按「不可用」处理
          if (!directoryPicker) throw new Error(t('bindings.pickerUnavailable'))
          const picked = await directoryPicker.pickDirectory()
          // null = 用户取消：不是错误，不该弹红字
          if (typeof picked === 'string' && picked !== '') setDraftDir(picked)
        } catch (err) {
          setPickerFailed(true)
          showError(messageOf(err))
        }
      }

      async function handleBind() {
        const dir = draftDir.trim()
        if (dir === '') {
          showError(t('bindings.needDir'))
          return
        }
        try {
          await controller.saveBinding(dir, effectiveDraftPersona)
          setDraftDir('')
          showNotice(t('bindings.bound', { dir: shortenPath(dir), name: effectiveDraftPersona }))
        } catch (err) {
          // 服务端的拒绝文案可以直接展示（它已经写清了是哪一类问题），不再包一层前缀
          showError(messageOf(err))
        }
      }

      async function handleRebind(dir, persona) {
        try {
          await controller.saveBinding(dir, persona)
          showNotice(t('bindings.bound', { dir: shortenPath(dir), name: persona }))
        } catch (err) {
          showError(messageOf(err))
        }
      }

      async function handleUnbind(dir) {
        if (pendingUnbind !== dir) {
          setPendingUnbind(dir)
          setErrorNotice(null)
          return
        }
        setPendingUnbind(null)
        try {
          const payload = await controller.removeBinding(dir)
          // removed 为假 = 这条绑定已经不在表里了（另一个窗口删的），不必谎报成功
          if (payload && payload.removed === false) showError(t('bindings.unbindMissing'))
          else showNotice(t('bindings.unbound', { dir: shortenPath(dir) }))
        } catch (err) {
          showError(messageOf(err))
        }
      }

      const table = bindings && typeof bindings === 'object' && !Array.isArray(bindings) ? bindings : {}
      const dirs = Object.keys(table)
      // 失效引用：服务端按当前预设库算好后标注，客户端只负责画出来（不自动删除 ——
      // 用户可能只是临时删了那个预设、打算改名回来）
      const invalidNames = new Map()
      for (const item of Array.isArray(bindingsInvalid) ? bindingsInvalid : []) {
        if (item && typeof item.dir === 'string') invalidNames.set(item.dir, String(item.persona))
      }
      // 层级排序：父目录排在子目录前，用 `└` 标出「这是上一条的子树」。
      // 同一个 `D:\项目A` 既绑了自身又绑了子目录时，先看父再看子才读得懂继承关系。
      const sortedDirs = dirs.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

      // 当前会话：优先挑有 cwd 的那个 —— 没有目录的会话任何绑定都不会命中，
      // 拿它当「当前」会让整张卡说的都不是用户眼前这个项目。
      const sessions = Array.isArray(bindingsSessions) ? bindingsSessions : []
      const withCwd = sessions.filter((s) => s && typeof s.cwd === 'string' && s.cwd !== '')
      const current = withCwd.length > 0 ? withCwd[0] : (sessions.length > 0 ? sessions[0] : null)
      const currentCwd = current && typeof current.cwd === 'string' && current.cwd !== '' ? current.cwd : null
      const moreCount = sessions.length - (current ? 1 : 0)
      const binding = current && current.binding ? current.binding : null
      const effectivePersona = current && current.persona ? String(current.persona) : ''
      // 「直接绑在本目录」与「继承自上级」的区别只体现在这里：没有它，用户在子目录里
      // 看到别的人设会以为是 bug。判别已在宿主做过（客户端拿原始串比较会被盘符大小写骗过）。
      const sourceText = !binding
        ? t('bindings.sourceGlobal')
        : (binding.inherited
            ? t('bindings.sourceInherited', { dir: shortenPath(binding.dir) })
            : shortenPath(binding.dir))

      return e('div', { className: 'soul-bindings' },
        // ① 当前会话目录卡 —— 先回答「我这个项目现在是谁」，再让用户改
        e('div', { className: 'soul-field' },
          e('div', { className: 'soul-field-label' }, t('bindings.currentTitle')),
          current === null
            ? e('div', { className: 'soul-status' }, t('bindings.noSession'))
            : (currentCwd === null
                ? e('div', { className: 'soul-status' }, t('bindings.noCwd'))
                : e('div', null,
                    e('div', { className: 'soul-bindings-current' },
                      e('code', {
                        className: 'soul-bindings-path',
                        title: currentCwd
                      }, shortenPath(currentCwd)),
                      e('div', { className: 'soul-bindings-meta' },
                        e('div', null, `${t('bindings.effective')}：${effectivePersona || t('quick.custom')}`),
                        e('div', null, `${t('bindings.source')}：${sourceText}`)
                      )
                    ),
                    moreCount > 0 && e('div', { className: 'soul-status' },
                      t('bindings.moreSessions', { count: String(moreCount) }))
                  ))
        ),

        // ② 新建 / 改绑入口。点选与手输填的是**同一个字段** —— 选择器只是把路径
        // 填进来，不是另一条独立的路径，所以两者不会给出不同的结果。
        e('div', { className: 'soul-field' },
          e('label', { htmlFor: 'soul-bindings-dir' }, t('bindings.manualLabel')),
          e('div', { className: 'soul-bindings-new' },
            e('input', {
              type: 'text',
              id: 'soul-bindings-dir',
              value: draftDir,
              placeholder: t('bindings.manualPlaceholder'),
              onChange: (ev) => setDraftDir(ev.target.value)
            }),
            // 失败过一次就不再给按钮：宿主的能力在启动时判定一次、之后不会变，
            // 留着它只会让用户反复点一个确定会失败的东西。
            // 服务**压根没注入**时同理（那些连接方式拿不到 uiWorkspace）：按钮不能出现，
            // 否则点下去只会在 handlePick 里对 null 取属性、抛一个用户看不懂的 TypeError。
            // 0.9.0-ah：改用宿主 ui.Button —— 原先自绘的 <button> 继承了宿主
            // 基础按钮样式（实心底 + 白字），我们又用 color:brand-primary 覆盖文字，
            // hover 时深底 + 深字 ⇒ 整个按钮全黑（用户反馈）。
            // 换成宿主组件后，底色 / 文字 / 悬停是一套，构造上必然与宿主一致。
            !pickerFailed && directoryPicker !== null && e(ui.Button, {
              onClick: () => { void handlePick() }
            }, t('bindings.choose'))
          ),
          pickerFailed && e('div', { className: 'soul-bindings-hint' }, t('bindings.pickerUnavailable')),
          e('div', { className: 'soul-bindings-new' },
            e('label', { htmlFor: 'soul-bindings-persona' }, t('bindings.persona')),
            e('select', {
              id: 'soul-bindings-persona',
              value: effectiveDraftPersona,
              onChange: (ev) => setDraftPersona(ev.target.value)
            }, names.map((name) => e('option', { key: name, value: name }, name))),
            e(ui.Button, {
              variant: 'primary',
              disabled: names.length === 0,
              onClick: () => { void handleBind() }
            }, t('bindings.bindDir'))
          ),
          bindingsMaxPath && e('div', { className: 'soul-status' },
            t('bindings.maxPath', { max: String(bindingsMaxPath) }))
        ),

        // ③ 绑定列表
        e('div', { className: 'soul-field' },
          e('div', { className: 'soul-field-label' }, t('bindings.listTitle')),
          bindingsError
            ? e('div', { className: 'soul-error' }, t('bindings.loadFailed', { reason: bindingsError }))
            : (bindings === null
                ? e('div', { className: 'soul-status' }, t('bindings.loading'))
                : (sortedDirs.length === 0
                    ? e('div', { className: 'soul-status' }, t('bindings.empty'))
                    : e('div', null,
                        e('div', { className: 'soul-status' },
                          t('bindings.count', {
                            count: String(sortedDirs.length),
                            max: Number.isFinite(bindingsMax) ? String(bindingsMax) : '—'
                          })),
                        e('ul', { className: 'soul-bindings-rows' },
                          sortedDirs.map((dir, at) => {
                            // 与前面渲染过的某条构成父子关系时画 `└`，把「一条绑定 =
                            // 一棵子树」画出来 —— 否则用户看不出为什么两个目录会用同一个人设
                            const parent = sortedDirs.slice(0, at).find((prev) => (
                              dir.startsWith(prev + '\\') || dir.startsWith(prev + '/')
                            ))
                            const isCurrent = currentCwd !== null && (
                              currentCwd === dir ||
                              currentCwd.startsWith(dir + '\\') ||
                              currentCwd.startsWith(dir + '/')
                            )
                            const invalidName = invalidNames.get(dir)
                            const value = invalidName || String(table[dir])
                            const isInvalid = invalidName !== undefined
                            return e('li', {
                              key: dir,
                              className: 'soul-bindings-row',
                              'data-current': isCurrent ? 'true' : 'false'
                            },
                              parent && e('span', { className: 'soul-bindings-tree', 'aria-hidden': true }, '└'),
                              e('code', { className: 'soul-bindings-dir', title: dir }, shortenPath(dir)),
                              isCurrent && e('span', { className: 'soul-bindings-here' }, t('bindings.here')),
                              isInvalid && e('span', { className: 'soul-bindings-bad' },
                                t('bindings.invalid', { name: invalidName })),
                              // 失效引用也画在下拉里（作为唯一选项）：让用户看到「现在写的是谁」，
                              // 而不是看见一个空下拉、以为这条记录没有值
                              e('select', {
                                className: 'soul-bindings-select',
                                value,
                                'aria-label': t('bindings.persona'),
                                onChange: (ev) => { void handleRebind(dir, ev.target.value) }
                              },
                                isInvalid && e('option', { value }, invalidName),
                                names.map((name) => e('option', { key: name, value: name }, name))
                              ),
                              e(ui.Button, {
                                // 待确认态靠文案已能区分（「确认解绑…」），
                                // 红色描边是增强：className 若不透传也不影响可用性。
                                className: pendingUnbind === dir ? 'soul-bindings-act-armed' : undefined,
                                onClick: () => { void handleUnbind(dir) }
                              }, pendingUnbind === dir ? t('bindings.unbindArmed') : t('bindings.unbind'))
                            )
                          })
                        )
                      ))
        ),

        // ④ 未绑定回落行：把隐式行为显式写成一条可改的规则
        e('div', { className: 'soul-bindings-fallback' },
          e('span', { className: 'soul-bindings-fallback-text' },
            `${t('bindings.fallback')} · ${activePersona || t('quick.custom')}`),
          e(ui.Button, {
            onClick: onOpenPersonas
          }, t('bindings.change'))
        ),

        // 「看到的不是全部」与「失败了」是两件事：前者是黄字警告，后者是红字
        Number.isFinite(bindingsDropped) && bindingsDropped > 0 && e('div', { className: 'soul-status' },
          t('bindings.dropped', { count: String(bindingsDropped) })),
        bindingsWarning && e('div', { className: 'soul-status soul-bindings-warning' },
          t('bindings.warning', { reason: bindingsWarning })),
        errorNotice && e('p', { className: 'soul-error-notice', role: 'alert' }, errorNotice),
        !errorNotice && notice && e('p', {
          className: 'soul-saved-notice',
          role: 'status',
          'aria-live': 'polite'
        }, notice)
      )
      )
    }

    function SoulSettings(props) {
      const { useSoulController, controller } = props
      // 渲染器按槽位 locale 命名空间注入 t（随语言切换更新）；缺失时回退中文
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const { enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth, historyMaxEntries, personas, activePersona, personasError, history, historyWarning, historyMax, historyError, saving, error, bindings, bindingsMax, bindingsWarning, bindingsError, bindingsInvalid, bindingsDropped, bindingsSessions } = state

      const [localEnabled, setLocalEnabled] = React.useState(enabled)
      const [localNickname, setLocalNickname] = React.useState(nickname || '')
      const [localOccupation, setLocalOccupation] = React.useState(occupation || '')
      const [localBio, setLocalBio] = React.useState(bio || '')
      const [localStyle, setLocalStyle] = React.useState(style)
      const [localHeadingLists, setLocalHeadingLists] = React.useState(headingLists)
      const [localEmoji, setLocalEmoji] = React.useState(emoji)
      const [localTables, setLocalTables] = React.useState(tables)
      const [localReplyLength, setLocalReplyLength] = React.useState(replyLength)
      const [localLanguage, setLocalLanguage] = React.useState(language || 'zh')
      const [localInstructions, setLocalInstructions] = React.useState(customInstructions)
      const [localToolConfirm, setLocalToolConfirm] = React.useState(requireToolConfirmation === true)
      const [localTrailEnabled, setLocalTrailEnabled] = React.useState(trailEnabled === true)
      const [localTrailColor, setLocalTrailColor] = React.useState(trailColor || TRAIL_COLOR_FALLBACK)
      const [localTrailSpeed, setLocalTrailSpeed] = React.useState(trailSpeed || 'slow')
      const [localTrailWidth, setLocalTrailWidth] = React.useState(trailWidth || 'thin')
      // 变更记录保留条数**不再是设置页的表单字段**（0.8.1 迁到插件详情页的变更记录
      // 区块，就地改、立刻落盘）。因此它不进 localMap / savedMap / dirty ——
      // 否则「在详情页改了容量」会让设置页的保存按钮莫名亮起，且点保存会把那份
      // 详情页刚改的值当成「用户在这里的编辑」再提交一次。
      const [personaName, setPersonaName] = React.useState('')
      // 「存为预设」的命名弹层是否打开。
      //
      // 方案 A：把「保存当前为预设」从预设列表里**移出来**，做成「保存设置」旁的同级动作，
      // 点开才问名字。原因（用户反馈「比较迷茫」）：
      //   ① 它原先被塞在预设列表最下面，而用户此时的心理模型是「我在看别人的预设」，
      //      突然出现「保存当前」的输入框，说不清「当前」指什么；
      //   ② 真正被保存的是「关于你/特质」里的字段，那些字段在**别的分组**里，
      //      用户在预设区输入名字，不知道到底存了哪些值；
      //   ③ 「保存设置」与「保存当前为预设」两个保存并列，语义没区分；
      //      且名字要先想好才能点（disabled 依赖非空），交互顺序也别扭。
      const [showSavePersona, setShowSavePersona] = React.useState(false)
      // 「更新到预设」弹层（0.9.0-s）：null = 关闭；字符串 = 正在选择目标预设名。
      //
      // 为什么单独一个入口而不复用「存为预设」：后者是**新建**（要名字），
      // 前者是**覆盖已有**（选名字）。两个动作的用户意图不同，
      // 混在一个入口里会让人分不清「我到底建了新的还是改了旧的」。
      //
      // 底层能力已经就位：savePersona(name, draft) 会存草稿，
      // 且重复门禁会**排除同名条目**（即"覆盖同名"= 更新，天然允许）。
      const [showUpdatePersona, setShowUpdatePersona] = React.useState(false)
      // 「存为预设」弹层里的「保存后立即应用」复选框（0.9.0-t）。
      //
      // 解决的问题：保存预设后表单里仍是那套未保存的编辑 ⇒ 底部同时显示
      // 「已保存预设「X」」和「有未保存的更改」两条，读起来矛盾（用户实测反馈）。
      //
      // 勾选 = 保存后把这套**应用为当前配置**（dirty 消失，★ 跟着这个预设走）；
      // 不勾选 = 保存后把表单**回退到已保存配置**（例子里是自驱型协作者），
      //          即「我把这套存起来了，但现在不切过去」。
      // 默认不勾选：存预设与改当前配置是两件事，默认不该替用户静默改配置。
      const [applyAfterSave, setApplyAfterSave] = React.useState(false)
      // 待删除的预设名（null = 没有待确认的删除）。
      //
      // 替代原生 window.confirm：原生模态框在 webview 里可能把文档焦点留在异常状态
      // （表现为「页面看得见却点不动、打不了字」，最小化再恢复才好）。宿主自己的设置页
      // 也不用原生 confirm，这里改为**内联二次确认**：第一次点「删除」把按钮切换成
      // 「确认删除？」，再点一次才真删；点别处或超时则复位。
      const [pendingDelete, setPendingDelete] = React.useState(null)
      // 卡片堆叠轮播的当前索引（人设预设一次只展示一张，左右可滑动/翻页）。
      // 索引在预设数组变化后可能越界（删除、加载失败后重取），渲染时统一夹取，
      // 不在 effect 里回写 —— 回写会多一次渲染，且删除后「看过的那张」位置语义
      // 本就有歧义（见 personaIndex 的夹取逻辑）。
      const [personaIndex, setPersonaIndex] = React.useState(0)
      // 卡背（详情面）状态：存「哪一张卡被翻到了背面」。
      //
      // 设计要点（这是 E 方案最容易做错的地方）：
      //   **卡背不是轮播的第 N+1 张，而是当前卡的另一种「面」** —— 所以索引
      //   index/total/go()/自动定位全部不用改，翻页翻的是「卡」，翻面翻的是「面」。
      //   若把卡背也算一张，total 要变 2N、位置指示与圆点全要跟着改，得不偿失。
      //
      //   状态绑定在**人设名**而不是索引：删除/刷新后同名的卡仍是同一张，
      //   绑索引会在列表变短时翻错面。
      const [flippedName, setFlippedName] = React.useState(null)
      // —— 内联结果提示（对齐宿主模型设置页的全局形态）——
      //
      // 查证：宿主设置页（dsh-client-ui-settings-models）**从不使用 toast** ——
      // 成功是顶部一行绿字（.savedNotice，role=status），失败是内联红字
      // （.error，role=alert），两者同字号（12px/18px）、就地出现、不自动消失。
      // 因此这里对称地用两个状态承载：savedNotice（绿）/ errorNotice（红），
      // 均在「下一次操作开始」时被替换，编辑时清除绿字。
      const [savedNotice, setSavedNotice] = React.useState(null)
      const showSavedNotice = (text) => setSavedNotice(text)
      const [errorNotice, setErrorNotice] = React.useState(null)
      const showError = (text) => {
        // 失败要压过之前的成功提示（用户要知道最新一次操作的结果）
        setSavedNotice(null)
        setErrorNotice(text)
      }
      //
      // 查证：宿主保存成功的提示不是 toast，而是设置页顶部的一行绿字
      // （.savedNotice：state-success-primary 绿、12px/18px、role:status +
      // aria-live:polite），且**不会自动消失** —— 只在开始编辑/删除/新增时清除。
      // 这里保持同一生命周期：下一次 dirty（开始编辑）时清除，见下方 effect。
      const [showPrompt, setShowPrompt] = React.useState(false)
      const [promptText, setPromptText] = React.useState('')
      const [promptLoading, setPromptLoading] = React.useState(false)
      const [promptError, setPromptError] = React.useState(null)
      // 当前预览的是「未保存的编辑」编译结果（true）还是已生效的提示词（false）
      const [promptIsDraft, setPromptIsDraft] = React.useState(false)
      // 未通过校验、因而未计入预览的字段名（服务端返回 invalid）
      const [promptInvalid, setPromptInvalid] = React.useState([])
      const [openSection, setOpenSection] = React.useState(() => {
        try {
          return globalThis.localStorage?.getItem('dsh-soul:open-section') || 'about'
        } catch {
          return 'about'
        }
      })

      React.useEffect(() => {
        try {
          if (openSection) globalThis.localStorage?.setItem('dsh-soul:open-section', openSection)
          else globalThis.localStorage?.removeItem('dsh-soul:open-section')
        } catch {
          // localStorage 不可用时不影响设置页使用
        }
      }, [openSection])

      // 同步状态
      // 用 store 回填本地表单 —— 但**按字段**决定，而不是一刀切。
      //
      // 此前是「dirty || saving 就整体不回填」：点「使用」应用预设后，store 先变、
      // 本地表单还是旧值 ⇒ 那一次渲染 dirty 恒为 true ⇒ 回填被挡 ⇒ 表单停在旧值。
      // 之后「保存设置」亮起（用户没改任何东西也亮），一点保存就把**旧表单值**
      // 整体 POST 上去，把刚应用的预设覆盖回旧配置 —— 正是「使用后人设变回默认」。
      //
      // 现在的判据：记录「上次与 store 同步时的本地快照」。某字段的当前本地值
      // 仍等于快照 ⇒ 用户没动过它 ⇒ 安全回填新值；不等于 ⇒ 用户正在编辑 ⇒ 保留。
      // 既有保护（轮询不覆盖正在编辑的内容）逐字段保留，语义不变。
      //
      // saving 期间仍然整体跳过：保存流程自身会带着响应回填（见 saveConfig →
      // applyConfig → 本 effect），中途再插一次写入只会造成闪烁。
      const formKeys = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth']
      const localValues = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, tables: localTables, replyLength: localReplyLength, language: localLanguage, customInstructions: localInstructions, requireToolConfirmation: localToolConfirm, trailEnabled: localTrailEnabled, trailColor: localTrailColor, trailSpeed: localTrailSpeed, trailWidth: localTrailWidth }
      const serverValues = { enabled, nickname: nickname || '', occupation: occupation || '', bio: bio || '', style, headingLists, emoji, tables, replyLength, language: language || 'zh', customInstructions, requireToolConfirmation: requireToolConfirmation === true, trailEnabled: trailEnabled === true, trailColor: trailColor || TRAIL_COLOR_FALLBACK, trailSpeed: trailSpeed || 'slow', trailWidth: trailWidth || 'thin' }
      const lastSyncRef = React.useRef(null)
      // 判断某字段是否被用户动过：与「上次同步的快照」比。没有快照（首帧）时
      // 一律视为未动过 —— 首帧本地值本来就来自 store，无从谈起「编辑过」。
      const userEdited = (key) => {
        const snap = lastSyncRef.current
        if (!snap) return false
        return !sameValue(localValues[key], snap[key])
      }
      React.useEffect(() => {
        if (saving) return
        const next = {}
        let changed = false
        for (const key of formKeys) {
          // 用户改过的字段一律保留；没动过的字段跟随 store
          const target = userEdited(key) ? localValues[key] : serverValues[key]
          next[key] = target
          if (!sameValue(target, localValues[key])) changed = true
        }
        lastSyncRef.current = next
        if (!changed) return
        setLocalEnabled(next.enabled)
        setLocalNickname(next.nickname)
        setLocalOccupation(next.occupation)
        setLocalBio(next.bio)
        setLocalStyle(next.style)
        setLocalHeadingLists(next.headingLists)
        setLocalEmoji(next.emoji)
        setLocalTables(next.tables)
        setLocalReplyLength(next.replyLength)
        setLocalLanguage(next.language)
        setLocalInstructions(next.customInstructions)
        setLocalToolConfirm(next.requireToolConfirmation)
        setLocalTrailEnabled(next.trailEnabled)
        setLocalTrailColor(next.trailColor)
        setLocalTrailSpeed(next.trailSpeed)
        setLocalTrailWidth(next.trailWidth)
        // 依赖与 serverValues 的来源一致；localValues/sameValue 每次渲染都是新的，
        // 但只在「某字段真要写」时才 setState，故不会形成死循环。
      }, [enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth])

      // toast 的消失交给宿主 Toast 组件自己（holdMs 后淡出并回调 onDone）。
      // 此前这里有个 2s 定时器 + 自绘 CSS 动画，两者时长必须手工对齐，
      // 且与全局提示条的 3s + 1s 淡出不一致 ⇒ 已删除。

      // dirty 检测：本地表单与已保存配置逐字段比较。
      //
      // 字符串一律先 trim 再比：服务端对每个字符串字段都会 trim（文本字段 trim、枚举值
      // trim、颜色 trim），所以「只改了首尾空格」落盘后与原值完全相同。此前按原始串
      // 比较会出现「用户敲了个空格 → 保存按钮亮了 → 保存成功却提示『配置无变化』」。
      // 不另造一份 TEXT_FIELDS 复刻表：那会多一处需要手工同步的常量。
      const sameValue = (a, b) => (typeof a === 'string' && typeof b === 'string'
        ? a.trim() === b.trim()
        : a === b)
      const savedMap = { enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth }
      const localMap = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, tables: localTables, replyLength: localReplyLength, language: localLanguage, customInstructions: localInstructions, requireToolConfirmation: localToolConfirm, trailEnabled: localTrailEnabled, trailColor: localTrailColor, trailSpeed: localTrailSpeed, trailWidth: localTrailWidth }
      const dirty = FORM_FIELD_KEYS.some((key) => !sameValue(savedMap[key], localMap[key]))

      // 宿主 savedNotice 语义：一旦用户开始新的编辑（dirty 变 true），
      // 上一条「已保存」就过时了 ⇒ 清除。（effect 必须放在 dirty 定义之后：
      // 依赖数组在渲染期求值，放前面会 TDZ —— 实测踩过。）
      React.useEffect(() => {
        if (dirty) setSavedNotice(null)
      }, [dirty])

      // 预览是否反映未保存的编辑：只看参与编译的字段（见 PROMPT_FIELD_KEYS）。
      // 这里用 localMap/savedMap 逐字段比，而不是复用上面的 dirty —— 改光轨颜色会让
      // dirty 为真，但那不影响提示词，此时预览仍是「已生效内容」，标成草稿反而误导。
      // 必须与 dirty 用**同一个** sameValue 判据：否则「只改了首尾空格」时 dirty 为假
      // （保存按钮禁用）而 promptDirty 为真（预览标成草稿），两处自相矛盾。
      const promptDirty = PROMPT_FIELD_KEYS.some((key) => !sameValue(savedMap[key], localMap[key]))
      // 草稿指纹：仅在影响编译的字段真的变化时才重新预览
      const promptDraftKey = PROMPT_FIELD_KEYS.map((key) => String(localMap[key])).join('\u0000')

      // 只把参与编译的字段发给预览端点：光轨等字段的校验失败不该出现在提示词预览里
      const promptDraft = () => {
        const out = {}
        for (const key of PROMPT_FIELD_KEYS) out[key] = localMap[key]
        return out
      }

      // 有未保存编辑时预览草稿（＝保存后真正会生效的内容），否则预览已生效提示词
      const loadPrompt = async () => {
        const asDraft = promptDirty
        setPromptLoading(true)
        setPromptError(null)
        try {
          const payload = asDraft
            ? await controller.previewPrompt(promptDraft())
            : await controller.fetchPrompt()
          setPromptText(payload.prompt || '')
          setPromptInvalid(Array.isArray(payload.invalid) ? payload.invalid : [])
          setPromptIsDraft(asDraft)
        } catch (err) {
          setPromptError(messageOf(err))
        } finally {
          setPromptLoading(false)
        }
      }

      // 展开/收起只切状态；编译由下方 effect 统一驱动（唯一入口，避免重复请求）
      const togglePrompt = () => setShowPrompt((open) => !open)

      // 逻辑已下沉到 controller.loadPersonas（全局轮询与设置页共用一份实现）。
      const loadPersonas = () => controller.loadPersonas()

      // 定时轮询已**上移到 apply()**（全局一份，与设置页是否挂载无关）——
      // 这里只负责告诉它「现在别刷」：有未保存编辑或正在保存时暂停，
      // 否则远端刷新会把用户正在改的值拽回去。
      //
      // 用 effect 而不是渲染期直接赋值：赋值要放在提交后（且卸载时必须复位，
      // 否则关掉设置页会永久暂停轮询 —— 那正是这次要修的 bug 的镜像）。
      React.useEffect(() => {
        controller.paused = dirty || saving
        return () => { controller.paused = false }
      }, [controller, dirty, saving])

      // 进入设置页时立即对齐一次宿主状态（补齐 /soul 命令等外部写入路径），
      // 不必等下一个 2s 轮询周期。
      React.useEffect(() => {
        if (!controller.canRefresh()) return
        void controller.loadConfig()
        void controller.loadPersonas()
      }, [controller])

      // 提示词预览的编译入口（唯一）。
      // 展开时立即编译一次；此后只要影响编译的字段或脏状态变化，停止 400ms 再编译 —
      // 边改边看保存后真正会生效的内容。
      // promptSettled 用来区分「刚展开」与「展开后字段又变了」：否则展开这一动作自身
      // 会先立即编译一次、再被防抖重复编译一次。
      // 依赖里刻意不放 loadPrompt（组件体内每次渲染都会重建函数，放进去会无限循环）；
      // 两个依赖项任一变化都会让 effect 带着最新闭包重跑，闭包不会过期。
      const promptSettled = React.useRef(false)
      React.useEffect(() => {
        if (!showPrompt) {
          promptSettled.current = false
          return
        }
        if (!promptSettled.current) {
          promptSettled.current = true
          void loadPrompt()
          return
        }
        const timer = setTimeout(() => { void loadPrompt() }, 400)
        return () => clearTimeout(timer)
      }, [showPrompt, promptDraftKey, promptDirty])

      const handleSave = async () => {
        const payload = await controller.saveConfig(localMap)
        // saveConfig 失败时内部已记录 error 并返回 undefined：给出失败提示，而非误报「无变化」
        if (!payload) {
          showError(t('toast.saveFailed'))
          return
        }
        // 成功提示走**内联绿字**（对齐宿主模型设置页的 savedNotice —— 见渲染处注释）：
        // 有实际变化时报「已保存」；无变化时报「配置无变化」。
        showSavedNotice(
          Array.isArray(payload.changed) && payload.changed.length > 0
            ? t('notice.saved')
            : t('notice.noChanges')
        )
        // 预览刷新交由下方 effect 统一驱动（保存 / 重置 / 应用预设都会改变
        // promptDraftKey 或 promptDirty，effect 自会带上最新闭包重编译）
      }

      const handleReset = async () => {
        // resetConfig 失败时内部已记录 error 并返回 undefined。
        // 此前这里无条件报「已重置」——失败也显示成功，正好把「配置损坏时唯一的自救操作
        // 没成功」这件事藏了起来。
        const payload = await controller.resetConfig()
        if (!payload) {
          showError(t('toast.resetFailed'))
          return
        }
        showSavedNotice(payload.backupPath ? t('notice.resetRecovered') : t('notice.reset'))
        // 预览刷新交由下方 effect 统一驱动（保存 / 重置 / 应用预设都会改变
        // promptDraftKey 或 promptDirty，effect 自会带上最新闭包重编译）
      }

      // 存为预设：把「关于你/特质」里的**当前设置**存成一个新预设。
      // 名字来自命名弹层；成功后关闭弹层并清空输入。
      //
      // ⚠️ 必须把**本地草稿**一起提交（0.9.0-r）：表单是「改完点保存才写回」的结构，
      // 用户改完风格与自定义指令、没点「保存设置」直接点「存为预设」时，若只传名字，
      // 服务端只能快照**已保存的旧配置** —— 存出来的预设还是上一个预设的内容
      // （用户实测确认的 bug）。
      //
      // 只传人设字段：预设不含「关于你」（昵称 / 职业 / 介绍），它们不属于预设。
      const handleSavePersona = async () => {
        const name = personaName.trim()
        if (!name) return
        try {
          const draft = {}
          for (const key of SESSION_OVERRIDE_KEYS) {
            // SESSION_OVERRIDE_KEYS 与 PERSONA_FIELDS 同集合（都含 language 与
            // customInstructions，都不含「关于你」）—— 直接复用，不另造一份清单。
            if (key in localMap) draft[key] = localMap[key]
          }
          await controller.savePersona(name, draft)

          // 保存之后必须消解「已保存预设 X」与「有未保存更改」并存的矛盾（0.9.0-t）：
          // 两条提示同时出现，读起来像"我到底存没存"。
          //
          // 勾选 ⇒ 把这套**应用为当前配置**（dirty 消失，★ 指向新预设）；
          // 不勾选 ⇒ 把表单**回退到已保存配置**（丢弃这次编辑的表单值）。
          if (applyAfterSave) {
            await controller.usePersona(name)
            // usePersona 里 applyConfig 会把 store 更新成该预设的值；
            // 表单由下面的 effect 逐字段跟随（userEdited 判据会让"用户编辑过"的字段保留，
            // 但这里我们刚把 store 改成与 draft 一致，故不会残留 dirty）。
            await loadPersonas()
            showSavedNotice(t('notice.personaSavedAndApplied', { name }))
          } else {
            // 回退表单：把 lastSyncRef 清空 ⇒ userEdited 一律视为"未编辑" ⇒
            // 下一次 effect 用 store（已保存配置）覆盖全部表单字段。
            lastSyncRef.current = null
            // 直接把本地状态写回已保存配置，保证本帧就清掉 dirty（不等 effect）。
            setLocalEnabled(enabled)
            setLocalNickname(nickname || '')
            setLocalOccupation(occupation || '')
            setLocalBio(bio || '')
            setLocalStyle(style)
            setLocalHeadingLists(headingLists || 'default')
            setLocalEmoji(emoji || 'default')
            setLocalTables(tables || 'default')
            setLocalReplyLength(replyLength || 'normal')
            setLocalLanguage(language || 'zh')
            setLocalInstructions(customInstructions || '')
            setLocalToolConfirm(requireToolConfirmation === true)
            setLocalTrailEnabled(trailEnabled)
            setLocalTrailColor(trailColor)
            setLocalTrailSpeed(trailSpeed)
            setLocalTrailWidth(trailWidth)
            await loadPersonas()
            showSavedNotice(t('notice.personaSaved', { name }))
          }

          setPersonaName('')
          setApplyAfterSave(false)
          setShowSavePersona(false)
        } catch (err) {
          showError(messageOf(err))
        }
      }

      // 更新到已有预设：把**当前草稿**覆盖写进某个已有预设（0.9.0-s）。
      //
      // 与 handleSavePersona 的唯一差别是「名字已存在」—— 底层是同一个
      // controller.savePersona(name, draft)：重复门禁会排除同名条目，
      // 所以「覆盖自己」天然被允许，不需要额外的 force 参数。
      //
      // 成功后**不动活动配置**：这是「把当前这套存回某个预设」，
      // 不是「应用某个预设」。用户改的配置仍然是当前配置。
      const handleUpdatePersona = async (name) => {
        if (!name) return
        try {
          const draft = {}
          for (const key of SESSION_OVERRIDE_KEYS) {
            if (key in localMap) draft[key] = localMap[key]
          }
          await controller.savePersona(name, draft)

          // 表单回退到**当前配置**：更新的是某个预设，不是当前配置，
          // 所以那套编辑不该继续挂在表单上（否则「已更新预设」+「有未保存的更改」
          // 并存，仍然是矛盾提示）。
          lastSyncRef.current = null
          setLocalEnabled(enabled)
          setLocalNickname(nickname || '')
          setLocalOccupation(occupation || '')
          setLocalBio(bio || '')
          setLocalStyle(style)
          setLocalHeadingLists(headingLists || 'default')
          setLocalEmoji(emoji || 'default')
          setLocalTables(tables || 'default')
          setLocalReplyLength(replyLength || 'normal')
          setLocalLanguage(language || 'zh')
          setLocalInstructions(customInstructions || '')
          setLocalToolConfirm(requireToolConfirmation === true)
          setLocalTrailEnabled(trailEnabled)
          setLocalTrailColor(trailColor)
          setLocalTrailSpeed(trailSpeed)
          setLocalTrailWidth(trailWidth)

          setShowUpdatePersona(false)
          await loadPersonas()
          showSavedNotice(t('notice.personaUpdated', { name }))
        } catch (err) {
          showError(messageOf(err))
        }
      }

      const handleUsePersona = async (name) => {
        try {
          const payload = await controller.usePersona(name)
          await loadPersonas()
          // 服务端回报了被丢弃的非法字段 ⇒ 预设只被部分应用，必须说出来而不是报「已应用」
          const invalid = Array.isArray(payload && payload.invalid) ? payload.invalid : []
          if (invalid.length > 0) {
            showError(t('toast.personaPartial', { fields: invalid.join(', ') }))
          } else {
            // 成功提示走内联绿字（对齐宿主 savedNotice）；无变化也照报
            showSavedNotice(payload && payload.unchanged
              ? t('notice.personaUnchanged')
              : t('notice.personaUsed', { name }))
          }
          // 预览刷新交由下方 effect 统一驱动（保存 / 重置 / 应用预设都会改变
        // promptDraftKey 或 promptDirty，effect 自会带上最新闭包重编译）
        } catch (err) {
          showError(messageOf(err))
        }
      }

      // 删除预设：**内联二次确认**，不用原生 window.confirm。
      //
      // 为什么换掉：原生模态框在 webview 里可能把文档焦点留在异常状态 —— 症状正是用户
      // 报的「删除后页面看得见却点不动、下拉框与输入框都无法操作」，而最小化再恢复
      // （触发 focus/visibilitychange）就变好。宿主自己的设置页也不用原生 confirm。
      //
      // 交互：第一次点「删除」→ 该按钮变成「确认删除？」且进入待确认态；再点一次才真删。
      // 期间点别处 / 切换卡片 / 超时（见下方 effect）都会复位，避免误删。
      const handleDeletePersona = async (name) => {
        if (pendingDelete !== name) {
          setPendingDelete(name)
          return
        }
        setPendingDelete(null)
        try {
          await controller.deletePersona(name)
          await loadPersonas()
          showSavedNotice(t('notice.personaDeleted', { name }))
        } catch (err) {
          showError(messageOf(err))
        }
      }

      // 二次确认的超时复位：进入待确认态后 5 秒内没有再次点击就取消。
      // 没有这道兜底，「确认删除？」会一直挂着 —— 用户过一会儿回来随手一点就真删了。
      React.useEffect(() => {
        if (pendingDelete === null) return
        const timer = setTimeout(() => setPendingDelete(null), 5000)
        return () => clearTimeout(timer)
      }, [pendingDelete])

      // —— 卡背（详情面）用到的辅助 ——
      //
      // 0.9.0-d 起这三样提到**模块级**（personaDimLabelOf / personaFullTextOf /
      // PERSONA_DIM_KEYS 已在模块级）：会话「人设」tab 的右侧详情面板要显示与设置页
      // 卡背**逐字相同**的维度与全文，各写一份必然漂移。
      const personaDimLabel = (entry, dim) => personaDimLabelOf(entry, dim, t)
      const personaFullText = (entry) => personaFullTextOf(entry, t)

      const styleOptions = STYLE_VALUES.map((value) => ({ value, label: t(`style.${value}`) }))
      const headingListsOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.headingLists.${value}`) }))
      const emojiOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.emoji.${value}`) }))
      const tablesOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.tables.${value}`) }))
      const replyLengthOptions = REPLY_LENGTH_VALUES.map((value) => ({ value, label: t(`trait.replyLength.${value}`) }))
      // 内置预设排在前面（沿用宿主返回的定义顺序，便于发现），用户预设紧随其后。
      // Array.prototype.sort 自 ES2019 起保证稳定，同类项因此维持原有插入顺序。
      const personaNames = personas
        ? Object.keys(personas).sort((a, b) => {
          const aBuiltin = personas[a] && personas[a].builtin ? 0 : 1
          const bBuiltin = personas[b] && personas[b].builtin ? 0 : 1
          return aBuiltin - bBuiltin
        })
        : null

      // 可被「更新到预设」覆盖的预设 = **自建**的那些（0.9.0-s）。
      // 内置预设不可改：五条写路径都拒绝内置名，列出来只会让用户点了吃一个 400。
      const editablePersonaNames = (personaNames || []).filter(
        (name) => !(personas && personas[name] && personas[name].builtin)
      )

      // 展开「人设预设」分组时，轮播自动定位到**当前生效**的那张，而不是永远停在第 1 张。
      //
      // 为什么需要：卡片一次只展示一张，若固定从第 1 张开始，用户点开分组后要翻好几下
      // 才能看到自己正在用的是哪个（内置项排在前面，自建/生效项往往在后面）。
      //
      // 三个边界都要处理：
      //   ① **只在「展开」这一刻定位**，不在展开期间持续定位 —— 否则 2s 轮询刷新 personas
      //      会把用户手动翻到的位置拽回去。用 ref 记住「本次展开已定位过」。
      //   ② **折叠时重置标记** —— 下次展开要重新定位（这正是需求本身）。
      //   ③ **数据未就绪时不下手** —— personas 还在加载（null）时定位会误判成第 0 张，
      //      等数据到了、effect 依赖变化会自然补上（标记此时仍为 false）。
      const autoPositionedRef = React.useRef(false)
      React.useEffect(() => {
        if (openSection !== 'personas') {
          // 折叠状态：清掉标记，让下次展开能重新定位。
          //
          // 刻意**不在这里**清翻面态：折叠期间 body 不渲染，翻面态在 UI 上不可观测，
          // 清与不清行为等价（判断力验证证实：删掉它所有用例仍通过）。可观测的点是
          // 「重新展开」那一刻，由下方 autoPositionedRef 分支的 setFlippedName(null)
          // 承担 —— 职责归属唯一，避免两处重复同一件事、日后改动只更新一处。
          autoPositionedRef.current = false
          return
        }
        if (autoPositionedRef.current) return
        if (!personaNames || personaNames.length === 0) return
        // 当前无生效人设（或名字对不上任何一项）时退回第 0 张 —— 总要给个确定的落点
        const at = activePersona ? personaNames.indexOf(activePersona) : -1
        // 自动定位同样是一次「换一张看」：清掉翻面态，避免定位到的那张
        // 恰好是上次翻过面的卡而以背面出现
        setFlippedName(null)
        setPersonaIndex(at >= 0 ? at : 0)
        autoPositionedRef.current = true
      }, [openSection, personaNames, activePersona])
      const aboutFilled = [localNickname, localOccupation, localBio].filter(Boolean).length
      const aboutSummary = aboutFilled > 0 ? `${aboutFilled}/3 ${t('accordion.filled')}` : t('accordion.empty')
      const traitsSummary = t(`style.${localStyle}`)
      // 失败时摘要也要区分（折叠状态下用户只看得到这一行）
      const personasSummary = personasError
        ? t('accordion.loadFailed')
        : (personas === null ? t('status.loading') : `${Object.keys(personas).length} ${t('accordion.personas')}`)
      // 工作区绑定摘要：折叠态只看得到这一行，所以要先说「读没读出来」，
      // 再说条数。null = 还没拉过（本分组懒加载，展开前一直是 null）⇒ 显示空态文案，
      // 不显示「0 条」—— 那会把「没加载」误报成「一条都没有」。
      //
      // 0.8.1 分组已从设置页撤下，这里暂时无人引用；保留是因为 0.9.0 的工作区
      // 平铺卡片要用同一套「摘要怎么说」的判断（加载中 / 失败 / 0 条 / N 条）。
      // 删掉它只会让那段逻辑在 0.9.0 被重写一遍，而那正是容易漏掉「加载中≠空」的地方。
      const bindingsSummary = bindingsError
        ? t('accordion.loadFailed')
        : (bindings === null || !bindings || typeof bindings !== 'object' || Array.isArray(bindings)
            ? t('bindings.empty')
            : (Object.keys(bindings).length === 0
                ? t('bindings.empty')
                : t('bindings.count', { count: String(Object.keys(bindings).length), max: Number.isFinite(bindingsMax) ? String(bindingsMax) : '—' })))
      const toolSummary = localToolConfirm ? t('accordion.on') : t('accordion.off')
      const promptSummary = promptText.length > 0
        ? t(promptIsDraft ? 'prompt.summaryDraft' : 'prompt.summaryChars', { n: String(promptText.length) })
        : (enabled ? t('prompt.summaryEnabled') : t('prompt.summaryDisabled'))
      const toggleSection = (section) => () => {
        setOpenSection(current => current === section ? null : section)
      }

      // 预设行摘要：风格 + 所有「偏离默认值」的人设维度。
      // 预设只描述 Agent 的人格，不含「关于你」（昵称 / 职业 / 介绍）—— 那是使用者
      // 的身份信息，不随预设切换。所以摘要里不再出现昵称，剩下的恰好也是比较两个
      // 预设时最需要看到的信息。
      //
      // 0.9.0 起这两个函数提到**模块级**（personaRowMetaOf / personaEffectTextOf）：
      // 会话「人设」tab 与工作区卡片也要用同一种措辞 —— 同一个预设在两处显示不同的
      // 摘要，用户会以为它们不是同一个东西。这里保留同名薄包装，避免改动大量调用点。
      const personaRowMeta = (entry) => personaRowMetaOf(entry, t)
      const personaEffectText = (entry) => personaEffectTextOf(entry, t)

      return e('div', { className: 'soul-section' },
        e('div', { className: 'soul-title-row' },
          e('h3', null, t('settings.title')),
          e('span', { className: 'soul-version' }, `v${VERSION}`)
        ),
        e('div', { className: 'soul-toggle' },
          e('input', {
            type: 'checkbox',
            id: 'soul-enabled',
            checked: localEnabled,
            onChange: (ev) => setLocalEnabled(ev.target.checked)
          }),
          e('label', { htmlFor: 'soul-enabled' }, t('toggle.enabled'))
        ),

        localEnabled && e(Fragment, null,
          e(SoulAccordion, {
            id: 'soul-about',
            title: t('group.aboutYou'),
            summary: aboutSummary,
            open: openSection === 'about',
            onToggle: toggleSection('about')
          },
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-nickname' }, t('field.nickname')),
              e('input', {
                type: 'text',
                id: 'soul-nickname',
                value: localNickname,
                onChange: (ev) => setLocalNickname(ev.target.value),
                placeholder: t('field.nicknamePlaceholder')
              })
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-occupation' }, t('field.occupation')),
              e('input', {
                type: 'text',
                id: 'soul-occupation',
                value: localOccupation,
                onChange: (ev) => setLocalOccupation(ev.target.value),
                placeholder: t('field.occupationPlaceholder')
              })
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-bio' }, t('field.bio')),
              e('textarea', {
                id: 'soul-bio',
                className: 'soul-textarea-sm',
                value: localBio,
                onChange: (ev) => setLocalBio(ev.target.value),
                placeholder: t('field.bioPlaceholder')
              })
            )
          ),

          e(SoulAccordion, {
            id: 'soul-traits',
            title: t('group.traits'),
            summary: traitsSummary,
            open: openSection === 'traits',
            onToggle: toggleSection('traits')
          },
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-style' },
                t('field.style'),
                e(SoulHint, { text: t('hint.style') })
              ),
              e('select', {
                id: 'soul-style',
                value: localStyle,
                onChange: (ev) => setLocalStyle(ev.target.value)
              },
                ...styleOptions.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-headingLists' },
                t('field.headingLists'),
                e(SoulHint, { text: t('hint.headingLists') })
              ),
              e('select', {
                id: 'soul-headingLists',
                value: localHeadingLists,
                onChange: (ev) => setLocalHeadingLists(ev.target.value)
              },
                ...headingListsOptions.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-emoji' },
                t('field.emoji'),
                e(SoulHint, { text: t('hint.emoji') })
              ),
              e('select', {
                id: 'soul-emoji',
                value: localEmoji,
                onChange: (ev) => setLocalEmoji(ev.target.value)
              },
                ...emojiOptions.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-tables' },
                t('field.tables'),
                e(SoulHint, { text: t('hint.tables') })
              ),
              e('select', {
                id: 'soul-tables',
                value: localTables,
                onChange: (ev) => setLocalTables(ev.target.value)
              },
                ...tablesOptions.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-replyLength' },
                t('field.replyLength'),
                e(SoulHint, { text: t('hint.replyLength') })
              ),
              e('select', {
                id: 'soul-replyLength',
                value: localReplyLength,
                onChange: (ev) => setLocalReplyLength(ev.target.value)
              },
                ...replyLengthOptions.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-language' },
                t('field.language'),
                e(SoulHint, { text: t('hint.language') })
              ),
              e('select', {
                id: 'soul-language',
                value: localLanguage,
                onChange: (ev) => setLocalLanguage(ev.target.value)
              },
                ...LANGUAGE_OPTIONS.map(opt => e('option', { key: opt.value, value: opt.value }, opt.label))
              )
            ),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-instructions' },
                t('field.instructions'),
                e(SoulHint, { text: t('hint.instructions') })
              ),
              e('textarea', {
                id: 'soul-instructions',
                value: localInstructions,
                onChange: (ev) => setLocalInstructions(ev.target.value),
                placeholder: t('field.instructionsPlaceholder')
              })
            )
          ),

          e(SoulAccordion, {
            id: 'soul-personas',
            title: t('group.personas'),
            summary: personasSummary,
            open: openSection === 'personas',
            onToggle: toggleSection('personas')
          },
            // 保留条数下拉不在这里 —— 0.8.1 起它跟着变更记录走，落在**插件详情页**
            // 的变更记录区块里（容量参数与被它约束的内容放在一起才说得通）。
            // 设置页这一组只负责预设本身与那句去向指引。
            e('div', { className: 'soul-field' },
              // 加载失败优先于「加载中」：否则失败时界面永远停在加载态，与「还没有预设」无从区分
              personasError
                ? e('div', { className: 'soul-error' }, t('personas.loadFailed', { reason: personasError }))
                : (personaNames === null
                ? e('div', { className: 'soul-status' }, t('status.loading'))
                : (personaNames.length === 0
                  ? e('div', { className: 'soul-status' }, t('personas.empty'))
                  : (() => {
                    // —— 卡片堆叠轮播 ——
                    // 一次只展示一张，左右各留一张做层叠露边。为什么用绝对定位 + transform：
                    // 三张卡片共存于同一堆叠容器内，若走文档流则容器高度会随张数变化而跳动。
                    const total = personaNames.length
                    // 夹取索引：预设可能被删除、或列表刷新后变短，索引会越界。
                    // 刻意不在 effect 里回写 state —— 那会多一次渲染，且「删除后该看哪张」
                    // 本就有歧义，渲染时夹取即可保证不越界。
                    const index = Math.min(Math.max(personaIndex, 0), total - 1)
                    // 翻页时**同时清掉翻面态**：翻面是「看这张卡背面」的临时阅读动作，
                    // 翻页是「换一张看」—— 用户的注意力已经重置。若记住它，切回来时
                    // 这张卡会以背面出现，看起来像「它默认就是背面」（用户实测反馈）。
                    const go = (next) => {
                      setFlippedName(null)
                      setPersonaIndex(Math.min(Math.max(next, 0), total - 1))
                    }
                    const renderCard = (name, offset) => {
                      const entry = personas[name] || {}
                      const builtin = !!entry.builtin
                      const current = offset === 0
                      // 只有当前卡能翻面（叠层两张不参与交互）
                      const flipped = current && flippedName === name
                      return e('div', {
                        key: name,
                        className: 'soul-persona-card',
                        'data-offset': String(offset),
                        'data-current': current ? 'true' : 'false',
                        'data-builtin': builtin ? 'true' : 'false',
                        'data-flipped': flipped ? 'true' : 'false',
                        style: {
                          // 叠层几何：当前张居中不动；±1 两张向左/右偏移并缩小。
                          // 竖版卡牌宽 260px，偏移要足够大才能看出「左右两张卡」，
                          // 太小会与当前卡重叠成一坨。92px 偏移 + 6% 缩小，叠层露出的
                          // 是一条完整的卡边（约 40px 可见宽度）。
                          //
                          // ⚠️ 这个 transform 归**叠层偏移**所有，绝不可把翻转的
                          // rotateY 写进来 —— 两者合成同一个 transform 字符串会让
                          // 偏移几何变脆。翻转交给中间的 .soul-persona-flipper
                          // （它有自己的 rotateY 0↔180，见 CSS），职责分离：
                          // 卡片管「叠层位置」，flipper 管「翻到哪一面」。
                          transform: `translateX(${offset * 92}px) translateY(${Math.abs(offset) * 10}px) scale(${1 - Math.abs(offset) * 0.06})`,
                          zIndex: String(10 - Math.abs(offset)),
                          // 叠层卡片压暗一点，形成前后景深（不能用 filter:brightness，
                          // 那会连带把文字变灰、看起来像禁用态）
                          opacity: offset === 0 ? '1' : '0.55'
                        },
                        // 非当前卡片不参与交互、也不让读屏念到（否则会念出重复内容）
                        'aria-hidden': current ? undefined : 'true',
                        ...(current ? {} : { onClick: () => go(index + offset) })
                      },
                        // —— 3D 翻转容器（中间层）——
                        //
                        // 为什么需要这一层：卡片的 transform 归**叠层偏移**所有
                        // （translateX/translateY/scale 内联在卡片上），翻转的
                        // rotateY(180deg) 必须落在**另一层**，否则两者要合成同一个
                        // transform 字符串，偏移几何会随之变脆。
                        // 现在职责分离：卡片管「叠层位置」，flipper 管「翻到哪一面」。
                        e('div', { className: 'soul-persona-flipper', 'aria-hidden': undefined },
                        e('div', {
                          className: 'soul-persona-face soul-persona-face-front',
                          // 翻到背面时正面要彻底退出交互与读屏（否则 Tab 会落到看不见的按钮上）
                          'aria-hidden': flipped ? 'true' : undefined,
                          ...(flipped ? { inert: '' } : {}),
                          // 整面点击翻到卡背（用户期望：任意处点击都能翻面）。
                          // ⚠️ 只对【当前卡】生效（current 条件）：叠层侧边卡的点击
                          // 必须留给卡片的 go() 翻页 —— 否则点击先冒泡到 face 的
                          // setFlippedName(侧边卡名)，再冒泡到卡片的 go() 翻页，
                          // 翻页后它成了当前卡 ⇒ flippedName === 它 ⇒ 直接以背面
                          // 姿态出现（用户实测：切下一个人设时自动翻面了）。
                          // 面上的控件用 stopPropagation 自己接管：「使用」点了就该用，
                          // 不能顺带翻面；「详情」的语义本来就是翻面，不拦（双保险）。
                          // cursor 由 CSS 给整面（含插画区），提示可点。
                          onClick: (current && !flipped) ? () => setFlippedName(name) : undefined
                        },
                          // 插画区（卡面主视觉）：**所有卡片都出图**。
                          //
                          // 内置预设：宿主按人设名返回 assets/personas/<名>.webp；
                          // 自建预设：宿主返回专用默认贴图（调色板，与官方的鲸鱼区分
                          // 「你自己配的」与「官方提供的」）。本版只做样式调整 ——
                          // 允许用户上传本地图片作插画是后续版本功能。
                          // 仍留 onError 兜底隐藏：路由不可用时退化为渐变底而非破图。
                          e('div', { className: 'soul-persona-art' },
                            e('img', {
                              className: 'soul-persona-art-img',
                              src: new URL(`/api/soul/persona-art/${encodeURIComponent(name)}`, hostBase()).href,
                              alt: '',
                              loading: 'lazy',
                              decoding: 'async',
                              draggable: 'false',
                              onError: (ev) => { ev.target.style.display = 'none' }
                            }),
                            // 渐变遮罩：让压在图上的名称/摘要有足够对比度
                            e('div', { className: 'soul-persona-art-veil', 'aria-hidden': true }),
                            builtin && e('span', { className: 'soul-persona-badge' }, t('personas.builtin')),
                            // 位置指示只出现在当前卡片上：左右露边的卡片若也显示「i / n」，
                            // 三张会同时出现同一个计数，看起来像显示错误。
                            current && e('span', { className: 'soul-persona-card-pos' }, `${index + 1} / ${total}`),
                            // 名称与摘要压在图上
                            e('div', { className: 'soul-persona-art-title' },
                              e('span', { className: 'soul-persona-name' },
                                e('span', { className: 'soul-persona-label' }, name === activePersona ? `★ ${name}` : name),
                                // 作用域标注：设置页的「使用」写的是**全局**（settings.section
                                // 拿不到 sessionId，这是宿主槽位契约决定的）。标出来是为了
                                // 避免用户以为「在这里点了使用 = 只影响这个项目」——
                                // 三级隔离下那是会话/工作区层的事。
                                e('span', { className: 'soul-persona-scope-tag' }, t('personas.scopeGlobal'))
                              ),
                              e('div', { className: 'soul-persona-meta' }, personaRowMeta(entry))
                            )
                          ),
                          e('div', { className: 'soul-persona-body' },
                            // 效果栏：卡牌的核心信息（这个预设会怎么回答）
                            e('div', { className: 'soul-persona-eff' }, personaEffectText(entry)),
                            e('div', { className: 'soul-persona-actions' },
                              // 当前生效的人设：按钮文字变「使用中」+ 描边式样式（区别于实心主色），
                              // 一眼就能看出哪张卡是当前配置。名称前的 ★ 保留，双重标识互相强化。
                              e('button', {
                                type: 'button',
                                className: name === activePersona ? 'soul-persona-action soul-persona-active' : 'soul-persona-action',
                                onClick: (ev) => {
                                  // 整面点击=翻面；点「使用」只想用预设，不能顺带翻面
                                  ev?.stopPropagation()
                                  void handleUsePersona(name)
                                }
                              }, name === activePersona ? t('personas.active') : t('personas.use')),
                              // 「删除」已移到**卡背**（管理语境，与「返回」并排）——
                              // 此前夹在「使用/详情」中间的 43px 窄条观感怪异（用户反馈），
                              // 且自建卡三钮 vs 内置卡两钮导致两类卡观感不齐。
                              // 现在两类卡正面都是「使用 + 详情」，完全一致。
                              // 「详情」只在当前卡上出现（叠层两张不给点）。
                              current && e('button', {
                                type: 'button',
                                className: 'soul-persona-action soul-persona-details',
                                title: t('personas.details'),
                                onClick: () => setFlippedName(name)
                              }, t('personas.details'))
                            )
                          )
                        ),
                        // —— 背面（详情）——
                        // 只读信息面：列全部维度 + customInstructions 全文。
                        // 不放「使用/删除」按钮：这是阅读态，且实测卡背内容已占 370/372px，
                        // 再放 36px 的按钮必然溢出（按钮留在正面即可，翻面后仍可返回）。
                        e('div', {
                          className: 'soul-persona-face soul-persona-face-back',
                          'aria-hidden': flipped ? undefined : 'true',
                          ...(flipped ? {} : { inert: '' }),
                          // 整面点击返回正面（与正面「整面点击翻到背面」对称）。
                          //
                          // ⚠️ 必须排除「拖选文字」：卡背有 339 字可滚动全文，用户很可能
                          // 拖选复制。拖选结束时会触发一次 click，若不判断就等于「一选就
                          // 翻回去」。判据用 window.getSelection() 是否落在卡背内 ——
                          // 有非折叠选区就说明这是一次选择操作，不返回。
                          // 另外点击「删除」按钮时靠它的 stopPropagation 挡住（见下），
                          // 否则删除确认会被返回动作打断。
                          onClick: () => {
                            if (!flipped) return
                            const sel = globalThis.getSelection?.()
                            if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return
                            setFlippedName(null)
                          }
                        },
                          e('div', { className: 'soul-persona-back-head' },
                            e('span', { className: 'soul-persona-back-name' }, name),
                            builtin && e('span', { className: 'soul-persona-badge' }, t('personas.builtin'))
                          ),
                          e('div', { className: 'soul-persona-dims' },
                            ...PERSONA_DIM_KEYS.map((dim) => e('div', { className: 'soul-persona-dim', key: dim },
                              e('span', null, t(`field.${dim}`)),
                              e('b', null, personaDimLabel(entry, dim))
                            ))
                          ),
                          e('div', { className: 'soul-persona-back-label' }, t('personas.customInstructions')),
                          e('div', { className: 'soul-persona-fulltext' }, personaFullText(entry)),
                          // 底部按钮行：「返回」+「删除」（仅自建卡）。
                          // 「删除」从正面移到这里（用户反馈正面三钮拥挤、夹缝观感差）：
                          // 背面是「查看 / 管理」语境，删除放这里语义顺；且底部本就是
                          // 一行按钮，并排进来零高度成本。二次确认（armed 态 + 5s 超时）
                          // 逻辑不变。
                          e('div', { className: 'soul-persona-back-actions' },
                            e('button', {
                              type: 'button',
                              className: 'soul-persona-action soul-persona-back-btn',
                              // 整面点击=返回；「返回」自己就是返回，stopPropagation 只为
                              // 语义清晰（避免同一动作触发两次 setState）
                              onClick: (ev) => {
                                ev?.stopPropagation()
                                setFlippedName(null)
                              }
                            }, t('personas.flipBack')),
                            !builtin && e('button', {
                              type: 'button',
                              className: pendingDelete === name
                                ? 'soul-persona-action soul-persona-danger soul-persona-danger-armed'
                                : 'soul-persona-action soul-persona-danger soul-persona-back-del',
                              'data-armed': pendingDelete === name ? 'true' : 'false',
                              title: t('personas.confirmDelete', { name }),
                              // 必须 stopPropagation：卡背整面点击=返回，
                              // 不挡住的话「确认删除」会被返回动作打断（翻回正面、看不到提示）
                              onClick: (ev) => {
                                ev?.stopPropagation()
                                void handleDeletePersona(name)
                              }
                            }, pendingDelete === name ? t('personas.confirmDeleteShort') : t('personas.delete'))
                          )
                        )
                        )   // ← 关闭 .soul-persona-flipper
                      )
                    }
                    const cards = []
                    for (let offset = -1; offset <= 1; offset++) {
                      const at = index + offset
                      if (at < 0 || at >= total) continue
                      cards.push(renderCard(personaNames[at], offset))
                    }
                    return e('div', { className: 'soul-persona-carousel' },
                      e('div', { className: 'soul-persona-stack' }, ...cards),
                      // 翻页 + 位置指示：一次只见一张，就必须给出「共几张 / 现在第几张」
                      // 与可点的翻页入口 —— 列表本可一眼扫完，这几处是对该损失的补偿。
                      e('div', { className: 'soul-persona-nav' },
                        e('button', {
                          type: 'button',
                          className: 'soul-persona-navbtn',
                          'data-dir': 'prev',
                          disabled: index === 0,
                          'aria-label': t('personas.prev'),
                          onClick: () => go(index - 1)
                        }, '‹'),
                        e('div', { className: 'soul-persona-dots', role: 'tablist' },
                          ...personaNames.map((n, i) => e('button', {
                            key: n,
                            type: 'button',
                            role: 'tab',
                            className: 'soul-persona-dot',
                            'data-active': i === index ? 'true' : 'false',
                            'aria-selected': i === index ? 'true' : 'false',
                            'aria-label': `${n}（${i + 1}/${total}）`,
                            onClick: () => go(i)
                          }))
                        ),
                        e('button', {
                          type: 'button',
                          className: 'soul-persona-navbtn',
                          'data-dir': 'next',
                          disabled: index === total - 1,
                          'aria-label': t('personas.next'),
                          onClick: () => go(index + 1)
                        }, '›')
                      )
                    )
                  })())
                )
            ),
            // —— 「已偏离任何预设」的出口 ——
            //
            // 每个内置预设现在都声明全部 6 个人格维度，所以**改任何特质都会丢 ★**
            // （不再匹配任何预设）。这是个诚实但**没有出路**的状态：用户刚调出来的
            // 这套配置无处安放。这里给一个明确落点：一句话说明 + 直接打开命名弹层存为新预设。
            //
            // 判据：activePersona === null（不匹配任何预设）且 personas 已就绪
            // （加载中/失败不算偏离）。全部为默认值时命中的是「默认」预设，
            // activeName 不为 null，不会走到这里。
            (activePersona === null && personaNames !== null && !personasError) && e('div', { className: 'soul-drift' },
              e('span', { className: 'soul-drift-text' }, t('personas.drift')),
              e('button', {
                type: 'button',
                className: 'soul-drift-action',
                onClick: () => { setPersonaName(''); setApplyAfterSave(false); setShowSavePersona(true) }
              }, t('personas.driftAction'))
            ),
            // —— 说明：一条轻提示 + 一个可点的去向，不再铺两行正文 ——
            //
            // 原来这里是两行灰字，每行都在复述用户已经能从界面里看到的东西：
            //   ·「风格 / 特质 / 回复长度 / 输出语言 / 自定义指令」—— 就是卡片上那几行；
            //   ·「内置预设不可删除」—— 每张内置卡都有「内置」徽标、且没有删除按钮；
            //   ·「撤销、恢复预设、清空都在那里」—— 是详情页上三个按钮的名字。
            // 名词语气+穷举，读起来像条款。现在只留**用户真正会问的那一个判断**
            //（「存这个会不会把我的昵称也换掉」），其余降级为问号里的 hover 全文。
            e('div', { className: 'soul-note soul-note-inline' },
              e('span', { className: 'soul-note-text' }, t('personas.hint')),
              e(SoulHint, { text: t('personas.hintDetail') })
            ),
            // 变更记录：一行「改动都能撤销」+ 问号里的全文。
            //
            // 这里**刻意不放「打开插件详情」按钮**：宿主 settings.section 槽位的
            // slotInject 是空串（见 dsh-cordis-client-runner 的槽位清单），设置页
            // 拿不到任何导航能力，点了也没法跳转 —— 一个点不动的按钮比没有更糟。
            e('div', { className: 'soul-note soul-note-inline' },
              e('span', { className: 'soul-note-text' }, t('history.entryHint')),
              e(SoulHint, { text: t('history.entryHintMore') })
            )
          ),

          // ——「工作区绑定」分组已从设置页撤下（0.8.0 发布前）——
          //
          // 原计划 0.8.1 交付「按目录绑人设」。但它要做的事（让目录决定人设）已经被
          // 0.9.0 的三级隔离（Global → Workspace → Session）整体接管，而这个分组是
          // 按「目录字符串」思考的 —— 工作区平铺卡片的交互形态与它完全不同，留下它
          // 只会让用户先学一套即将被替换的操作方式。
          //
          // **只摘渲染，逻辑层一行不动**：
          //   · lib/bindings.mjs 的路径规范化 / realpath / 前缀匹配是硬资产，0.9.0 直接复用；
          //   · 宿主侧的 cwd 解析、三条绑定路由、controller 方法全部保留 ——
          //     没有任何用户持有 soul-bindings.json（特性从未发布），解析恒为 null、
          //     行为与「没有绑定功能」完全一致，失败方向安全；
          //   · SoulBindings 组件与 .soul-bindings-* 样式同样保留，0.9.0 重写 UI 时替换。
          //
          // 对应的行为用例 C29–C33 已随 UI 一并删除（它们测的是点击这个分组之后的
          // 交互，分组不在渲染树里就没有可断言的对象）。逻辑层仍由 verify-bindings
          // （47 项）与 verify-e2e-prompt 的 R1–R13 守着。

          e(SoulAccordion, {
            id: 'soul-tools',
            title: t('group.tool'),
            summary: toolSummary,
            open: openSection === 'tools',
            onToggle: toggleSection('tools')
          },
            e('div', { className: 'soul-toggle' },
              e('input', {
                type: 'checkbox',
                id: 'soul-toolConfirm',
                checked: localToolConfirm,
                onChange: (ev) => setLocalToolConfirm(ev.target.checked)
              }),
              e('label', { htmlFor: 'soul-toolConfirm' }, t('field.toolConfirm')),
              e(SoulHint, { text: t('hint.toolConfirm') })
            ),

            e('div', { className: 'soul-group-title' }, t('trail.title')),
            e('div', { className: 'soul-toggle' },
              e('input', {
                type: 'checkbox',
                id: 'soul-trailEnabled',
                checked: localTrailEnabled,
                onChange: (ev) => setLocalTrailEnabled(ev.target.checked)
              }),
              e('label', { htmlFor: 'soul-trailEnabled' }, t('trail.enable')),
              e(SoulHint, { text: t('hint.trail') })
            ),

            localTrailEnabled && e(Fragment, null,
              e('div', { className: 'soul-field' },
                e('label', { htmlFor: 'soul-trailColor' }, t('trail.color')),
                e('div', { className: 'soul-trail-colors' },
                  ...TRAIL_PRESET_COLORS.map((value) => e('button', {
                    key: value,
                    type: 'button',
                    className: 'soul-trail-swatch',
                    'data-active': safeTrailColor(localTrailColor) === value ? 'true' : 'false',
                    style: { background: value },
                    'aria-label': value,
                    title: value,
                    onClick: () => setLocalTrailColor(value)
                  })),
                  e('input', {
                    type: 'color',
                    id: 'soul-trailColor',
                    className: 'soul-trail-picker',
                    value: safeTrailColor(localTrailColor),
                    onChange: (ev) => setLocalTrailColor(safeTrailColor(ev.target.value))
                  }),
                  e('input', {
                    type: 'text',
                    className: 'soul-trail-hex',
                    value: localTrailColor,
                    maxLength: 7,
                    spellCheck: false,
                    onChange: (ev) => setLocalTrailColor(ev.target.value),
                    placeholder: TRAIL_COLOR_FALLBACK
                  })
                )
              ),
              e('div', { className: 'soul-field' },
                e('label', { htmlFor: 'soul-trailSpeed' }, t('trail.speed')),
                e('select', {
                  id: 'soul-trailSpeed',
                  value: localTrailSpeed,
                  onChange: (ev) => setLocalTrailSpeed(ev.target.value)
                },
                  ...TRAIL_SPEED_VALUES.map((value) => e('option', { key: value, value }, t(`trail.speed.${value}`)))
                )
              ),
              e('div', { className: 'soul-field' },
                e('label', { htmlFor: 'soul-trailWidth' }, t('trail.width')),
                e('select', {
                  id: 'soul-trailWidth',
                  value: localTrailWidth,
                  onChange: (ev) => setLocalTrailWidth(ev.target.value)
                },
                  ...TRAIL_WIDTH_VALUES.map((value) => e('option', { key: value, value }, t(`trail.width.${value}`)))
                )
              ),
              e('div', { className: 'soul-field' },
                // 预览示例不是表单控件，没有可关联的 id —— 用 label 会是「指向空的标签」，
                // 所以改用同风格的 div（样式见 .soul-field-label）
                e('div', { className: 'soul-field-label' }, t('trail.preview')),
                e(SoulTrailPreview, {
                  color: localTrailColor,
                  speed: localTrailSpeed,
                  width: localTrailWidth,
                  t
                })
              )
            )
          )
        ),

        // —— 变更记录：设置页不再留独立指引行 ——
        // 指引并入「人设预设」展开区的说明块（与 personas.hint 合并展示）：
        // 独立一行在个性化区块里突兀，而折叠标题旁挂 hover 又说不到点上
        //（它解释的是展开后的东西）。这里不再渲染任何 history 状态，渲染成本为零。

        e(SoulAccordion, {
          id: 'soul-prompt',
          title: t(promptIsDraft ? 'prompt.titleDraft' : 'prompt.title'),
          summary: promptSummary,
          open: showPrompt,
          onToggle: togglePrompt
        },
          promptLoading
            ? e('div', { className: 'soul-status' }, t('prompt.loading'))
            : (promptError
              ? e('div', { className: 'soul-error' }, promptError)
              : e(Fragment, null,
                e('pre', { className: 'soul-prompt-pre' }, promptText || t('prompt.empty')),
                e('div', { className: 'soul-status' }, t('prompt.chars', { n: String(promptText.length) })),
                promptInvalid.length > 0 && e('div', { className: 'soul-error' },
                  t('prompt.invalid', { fields: promptInvalid.join(t('common.listSep')) }))
              ))
        ),

        error && e('div', { className: 'soul-error' }, error),

        e('div', { className: 'soul-buttons' },
          e(ui.Button, {
            variant: 'primary',
            onClick: handleSave,
            disabled: saving || !dirty
          }, saving ? t('button.saving') : t('button.save')),
          // 方案 A：「保存当前为预设」从预设列表移到这里，与「保存设置」并列为同级动作。
          // 两个保存动作放在一起，差异一眼可见（就地生效 vs 另存一份），
          // 且按钮就贴在刚编辑过的表单旁 ⇒ 用户自然理解「存的是我刚才编的」。
          e(ui.Button, {
            onClick: () => { setPersonaName(''); setShowSavePersona(true) },
            disabled: saving
          }, t('personas.saveAs')),
          // 「更新到预设」（0.9.0-s）：把当前草稿覆盖写回某个已有自建预设。
          //
          // 只列**自建**预设：内置预设不可改（写入路径一律拒绝内置名），
          // 列出来只会让用户点了吃一个 400。
          e(ui.Button, {
            onClick: () => setShowUpdatePersona(true),
            disabled: saving || editablePersonaNames.length === 0
          }, t('personas.updateTo')),
          e(ui.Button, {
            onClick: handleReset,
            disabled: saving
          }, t('button.reset'))
        ),

        // ——「存为新预设」命名弹层 ——
        // 点开才问名字（而不是原先「先填名字、按钮才可点」的别扭顺序），
        // 并**明确列出会保存什么 / 不会保存什么** —— 这直接消灭了
        // 「不知道到底存了哪些值」这个困惑。
        showSavePersona && e('div', {
          className: 'soul-modal-mask',
          role: 'presentation',
          onClick: () => { setShowSavePersona(false); setPersonaName('') }
        },
          e('div', {
            className: 'soul-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('personas.saveAs'),
            onClick: (ev) => ev.stopPropagation()
          },
            e('div', { className: 'soul-modal-title' }, t('personas.saveAs')),
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-new-persona-name' }, t('personas.saveNameLabel')),
              e('input', {
                id: 'soul-new-persona-name',
                type: 'text',
                value: personaName,
                maxLength: 30,
                placeholder: t('personas.savePlaceholder'),
                onChange: (ev) => setPersonaName(ev.target.value),
                onKeyDown: (ev) => {
                  if (ev.key === 'Enter' && personaName.trim() && !saving) void handleSavePersona()
                  if (ev.key === 'Escape') { setShowSavePersona(false); setPersonaName('') }
                }
              })
            ),
            e('div', { className: 'soul-modal-note' },
              e('div', null, t('personas.saveCovers')),
              e('div', { className: 'soul-modal-note-excl' }, t('personas.saveExcludes'))
            ),
            // 「保存后立即应用」（0.9.0-t）：显式让用户选「存完要不要切过去」。
            //
            // 不加这个开关时，保存预设后表单里仍是那套未保存编辑 ⇒ 底部同时显示
            // 「已保存预设「X」」和「有未保存的更改」，读起来矛盾。
            // 默认不勾：存预设与改当前配置是两件事，不该替用户静默改配置。
            e('label', { className: 'soul-modal-check' },
              e('input', {
                type: 'checkbox',
                checked: applyAfterSave,
                onChange: (ev) => setApplyAfterSave(ev.target.checked)
              }),
              e('span', null, t('personas.applyAfterSave')),
              e('span', { className: 'soul-modal-check-hint' }, t('personas.applyAfterSaveHint'))
            ),
            e('div', { className: 'soul-modal-actions' },
              e(ui.Button, {
                onClick: () => { setShowSavePersona(false); setPersonaName(''); setApplyAfterSave(false) }
              }, t('button.cancel')),
              e(ui.Button, {
                variant: 'primary',
                onClick: handleSavePersona,
                disabled: saving || !personaName.trim()
              }, saving ? t('button.saving') : t('personas.saveConfirm'))
            )
          )
        ),

        // ——「更新到预设」弹层（0.9.0-s）——
        // 列出可覆盖的自建预设，点一个即写入。不询问名字（名字已经定了）。
        showUpdatePersona && e('div', {
          className: 'soul-modal-mask',
          role: 'presentation',
          onClick: () => setShowUpdatePersona(false)
        },
          e('div', {
            className: 'soul-modal',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': t('personas.updateTo'),
            onClick: (ev) => ev.stopPropagation()
          },
            e('div', { className: 'soul-modal-title' }, t('personas.updateTo')),
            editablePersonaNames.length === 0
              ? e('div', { className: 'soul-modal-note' }, t('personas.updateNone'))
              : e('div', { className: 'soul-update-list' },
                ...editablePersonaNames.map((name) => e('button', {
                  key: name,
                  type: 'button',
                  className: 'soul-update-item',
                  disabled: saving,
                  onClick: () => { void handleUpdatePersona(name) }
                },
                  e('span', { className: 'soul-update-name' }, name),
                  // 标出「当前生效」的那个：覆盖它之后 ★ 不会变（字段本来就一样），
                  // 覆盖别的预设会改变那个预设的内容 —— 用户该知道这一点。
                  name === activePersona && e('span', { className: 'soul-update-badge' }, t('personas.active'))
                ))
              ),
            e('div', { className: 'soul-modal-note' },
              e('div', null, t('personas.updateCovers')),
              e('div', { className: 'soul-modal-note-excl' }, t('personas.updateExcludes'))
            ),
            e('div', { className: 'soul-modal-actions' },
              e(ui.Button, {
                onClick: () => setShowUpdatePersona(false)
              }, t('button.cancel'))
            )
          )
        ),

        dirty && !saving && e('div', { className: 'soul-status soul-dirty' }, t('status.unsaved')),

        // —— 内联结果提示（对齐宿主模型设置页的全局形态）——
        //
        // 查证（dsh-client-ui-settings-models/lib/client.js）：宿主设置页**从不使用
        // toast**（Toast 引用 = 0），成功与失败都是设置页内的**一行内联文字**：
        //   成功 → .savedNotice（state-success-primary 绿、12px/18px、role:status +
        //          aria-live:polite），位于标题/简介之后、分组列表之前；
        //   失败 → .error（state-error-primary 红、12px/18px、role:alert），
        //          就地出现在问题发生处（行内/卡片顶部），共 11 处使用。
        // 两者同字号同行高，仅红绿与 role 之差 —— 完全对称。
        //
        // 因此这里对称承载：绿字（成功）/ 红字（失败），同一位置、互斥显示
        // （失败压过成功 —— 用户要看到最新一次操作的结果）。两者都不自动消失：
        // 绿字在开始编辑（dirty）时清除，红字在下一次操作开始时被替换或清除。
        errorNotice && e('p', {
          className: 'soul-error-notice',
          role: 'alert'
        }, errorNotice),
        !errorNotice && savedNotice && e('p', {
          className: 'soul-saved-notice',
          role: 'status',
          'aria-live': 'polite'
        }, savedNotice)
      )
    }

    // -------------------------------------------------------------------------
    // 输入框光轨：组件
    // -------------------------------------------------------------------------

    // 设置页内的实时示例：与线上光轨共用同一渲染层、同一挂载点解析（resolveTrailMountPoint）
    // 与同一份 CSS，因此「示例所见」即「回复时所得」；颜色/速度/粗细随表单实时联动。
    //
    // 本组件**只在光轨开启时**被渲染（见调用处的 `localTrailEnabled &&`），所以它没有
    // 「关闭」这一态：此前它接了一个 `enabled` prop 并写了 off 分支，那是永不执行的死
    // 代码（且 `data-soul-trail="off"` 会连带影响 CSS 选择器），现在去掉。
    function SoulTrailPreview(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const hostRef = React.useRef(null)
      const anchorRef = React.useRef(null)

      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        // 与线上 SoulTrail 同一条路径：解析出的挂载点即示例内的零高度锚点 .soul-trail-anchor
        const mounted = mountTrailRing(host, resolveTrailMountPoint(host, anchorRef.current))
        // 环的内联样式以 display:none 起（见 mountTrailRing），必须显式显形一次
        mounted.setVisible(true)
        return () => mounted.unmount()
      }, [])

      return e('div', {
        ref: hostRef,
        className: 'soul-trail-preview',
        'data-soul-trail': 'on',
        'data-soul-trail-speed': props.speed || 'slow',
        'data-soul-trail-width': props.width || 'thin',
        style: { '--soul-trail-color': safeTrailColor(props.color) }
      },
        // 零高度挂载锚点（与 DSH composer 的 .overlayAnchor 同形态）：环挂在这里，见 resolveTrailMountPoint
        e('div', { ref: anchorRef, className: 'soul-trail-anchor', 'aria-hidden': 'true' }),
        e('span', { className: 'soul-trail-preview-text' }, t('trail.previewText'))
      )
    }

    // 输入框光轨运行时：注册在 conversation.input.overlay（输入框卡片内部）。
    // 组件本身不渲染可见内容——它在最近的卡片上挂一层 SVG 环，
    // 并用会话运行态控制显隐。运行状态来自 DSH 标准 prop useSession
    // （SessionSnapshot.running，等价于 Agent 状态为 running）。
    function SoulTrail(props) {
      const useSession = props.useSession
      const useStore = props.useSoulController
      const running = typeof useSession === 'function'
        ? useSession((snapshot) => snapshot.running === true)
        : false
      const state = typeof useStore === 'function' ? useStore((snapshot) => snapshot) : null
      const anchorRef = React.useRef(null)
      const mountedRef = React.useRef(null)

      React.useEffect(() => {
        const anchor = anchorRef.current
        // 组件位于卡片内的 overlay 锚点中，closest 定位可避免全局查询误命中
        const card = anchor && typeof anchor.closest === 'function'
          ? anchor.closest('[data-composer-card]')
          : null
        if (!card) return undefined

        // 环挂到卡片内那个零高度的 overlay 锚点上（锚点高度写死为 0，环退回常规流
        // 也撑不动卡片）；退回卡片本身时仍由内联 position/contain 兜底，
        // 见渲染层「隔离不变量」注释
        const mountPoint = resolveTrailMountPoint(card, anchor)
        const mounted = mountTrailRing(card, mountPoint)
        mountedRef.current = { card, mounted }
        // 先置为隐藏：效果在首帧绘制后执行，先隐藏可避免挂载瞬间闪出一帧光轨
        card.setAttribute('data-soul-trail', 'off')
        mounted.setVisible(false)
        return () => {
          const current = mountedRef.current
          mountedRef.current = null
          if (!current) return
          current.mounted.unmount()
          current.card.removeAttribute('data-soul-trail')
          current.card.removeAttribute('data-soul-trail-speed')
          current.card.removeAttribute('data-soul-trail-width')
          current.card.style.removeProperty('--soul-trail-color')
        }
      }, [])

      // 显隐与外观同步：仅「Agent 回复中 + 光轨开关开启」时显示
      React.useEffect(() => {
        const current = mountedRef.current
        if (!current) return
        const { card, mounted } = current
        const enabled = state !== null && state.trailEnabled === true
        const visible = running && enabled
        card.setAttribute('data-soul-trail', visible ? 'on' : 'off')
        card.setAttribute('data-soul-trail-speed', (state && state.trailSpeed) || 'slow')
        card.setAttribute('data-soul-trail-width', (state && state.trailWidth) || 'thin')
        card.style.setProperty('--soul-trail-color', safeTrailColor(state && state.trailColor))
        mounted.setVisible(visible)
      }, [running, state])

      return e('span', { ref: anchorRef, hidden: true, 'aria-hidden': true })
    }

    // -------------------------------------------------------------------------
    // 插件装配
    // -------------------------------------------------------------------------

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const controller = new SoulController()
      ctx.provide('soulController', controller)
      ctx.effect(() => () => {
        controller.dispose()
      }, 'dsh-soul: browser lifecycle')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-soul: dictionaries')

      // —— 全局轮询：让**不打开设置页**时底栏也能跟上宿主侧的变化 ——
      //
      // 修掉的 bug：用户用 /soul confirm 确认人设变更后，宿主已写盘（配置文件正确），
      // 但底栏「个性化已启用 · 人设名」仍显示旧值。根因是三条刷新路径
      // （setInterval / focus / visibilitychange）**全部注册在 SoulSettings 组件内**，
      // 设置页没挂载时它们都不存在 ⇒ 底栏读的 store 无人刷新。
      //
      // 底栏（conversation.input.left）是常驻组件，它的数据链路不该依赖另一个
      // 组件的生命周期。放到装配层后：注册一次、全生命周期有效，且天然只有一份
      // 定时器（不会与设置页的重复 ⇒ 请求翻倍）。
      ctx.effect(() => {
        const refresh = () => {
          // 页面不可见时不轮询：后台标签页不必发请求
          if (document.visibilityState !== 'visible') return
          // 有未保存编辑时暂停（由设置页置位）—— 否则会把用户正在改的值拽回去
          if (!controller.canRefresh()) return
          void controller.loadConfig()
          void controller.loadPersonas()
        }
        refresh()
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', refresh)
        const timer = setInterval(refresh, 2000)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', refresh)
          clearInterval(timer)
        }
      }, 'dsh-soul: global refresh polling')

      // —— 目录点选服务（0.8.1-d）——
      //
      // 用**动态** ctx.inject 拿 uiWorkspace，而不是把它写进上面的静态 inject 数组：
      // 静态数组里少一个服务，整个插件就不激活（设置页、人设卡、底栏一起消失）。
      // 目录选择器只是「能点一下就填路径」的便利，缺了它手输照常可用 ⇒ 必须可缺。
      // 服务到齐时写进模块级 directoryPicker，SoulBindings 的「选择目录…」才可见；
      // 调用失败（宿主 pickDirectory 抛错）时组件自行降级为手输，见 §7.5。
      ctx.inject(['uiWorkspace'], (scope) => {
        directoryPicker = scope.uiWorkspace
        scope.effect(() => () => {
          // 服务撤走 = 界面上不该再出现那个按钮（回调可能已被替换成新的 scope）
          if (directoryPicker === scope.uiWorkspace) directoryPicker = null
        }, 'dsh-soul: directory picker teardown')
      })

      // 暗色适配说明：原生 <select> 的弹出选项列表由浏览器按 color-scheme 渲染。
      // 宿主主题呈现器会把 html 的 color-scheme 与 body[data-ds-dark-theme] 随主题
      // 投影到 document（见 dsh-client-ui-layout ThemePresenter），因此这里用纯 CSS
      // 属性选择器跟随即可，无需 JS 监听；选项行另用主题变量显式着色兜底。

      // 导航 label / 图标替换用的翻译函数（bind 返回的函数在调用时读取当前语言）
      const navT = ctx.locale.bind(NS)

      // DSH 的设置导航图标是壳层硬编码的 id → 图标映射（见 ui-settings-general 的
      // navIcon()：account/models/agent-presets/plugins/archived-sessions，其余一律
      // 回退成设置齿轮），插件无法通过槽位声明自己的图标（settings.section 的选项
      // 只有 id / order / label）。因此改用 DOM 替换，把齿轮换成与插件图标同一套
      // 几何的「灵魂火花 + 光轨」（类似 dsh-better-sidebar 的方案）。
      const SOUL_NAV_MARKER = 'data-soul-settings-nav'
      const SOUL_ICON_MARKER = 'data-soul-icon-replaced'

      // 与 assets/icon.svg（插件图标）同源几何：同一条光轨与火花路径。
      // 客户端读不到文件系统，只能内联一份；verify-nav-icon.mjs 有断言核对二者的
      // 路径数据逐字一致，防止漂移。
      //
      // 与插件图标有两处**有意差异**，都是为了与设置导航里的兄弟栏目看齐：
      //   1) 颜色——插件图标是彩色渐变，而导航栏那一排图标全是单色线描（壳层
      //      navIcon() 生成的宿主机图标用 stroke="currentColor"）。这里同样用
      //      currentColor：既与邻居统一，又能自动跟随主题、选中态与禁用态，
      //      不必自己判断暗色模式。
      //   2) 显示窗口——icon.svg 用 `0 0 36 36`（图形含描边占 26.8 单位，留白适合
      //      列表里的大图标）。导航栏旁的宿主图标实测几乎满格——16px 下墨迹跨度
      //      14.25px（占 89%），所以沿用 36 网格会让这个小图标显得又小又轻。这里把
      //      窗口收紧到「同一个中心 (18,18)、边长 28.4」，让墨迹跨度落到 ~14px。
      //      数值是量出来的：预览探针把两种图标渲染到 canvas 逐像素统计。
      const NAV_ICON_VIEW_BOX = '3.8 3.8 28.4 28.4'
      const NAV_ICON_TRAIL_D = 'M18 6A12 12 0 1 1 6.72 22.1'
      const NAV_ICON_SPARK_D = 'M18 11.6C18.52 15.15 20.85 17.48 24.4 18C20.85 18.52 18.52 20.85 18 24.4C17.48 20.85 15.15 18.52 11.6 18C15.15 17.48 17.48 15.15 18 11.6Z'
      // 线宽按**显示后的像素**与邻居对齐：宿主图标是 16 网格 + 1.3 线宽，而我们
      // 的窗口是 28.4 单位宽、显示成 16px（缩放 16 ÷ 28.4 ≈ 0.5634），所以取
      // 1.3 ÷ 0.5634 ≈ 2.3。照搬 icon.svg 的 2.8 会让弧线比邻居粗一圈。
      const NAV_ICON_STROKE_WIDTH = '2.3'
      // 宿主按 size=16 渲染，宽高是 svg 的属性（不是 CSS）。万一将来改由 CSS 控制尺寸，
      // 我们也补一个 16——否则 svg 会退回 300×150 的默认尺寸，把导航栏撑坏。
      const NAV_ICON_FALLBACK_SIZE = '16'
      const SVG_NS = 'http://www.w3.org/2000/svg'

      /** 建一个 SVG 元素并铺上属性（避免 innerHTML，无需解析）。 */
      const svgNode = (name, attributes) => {
        const node = document.createElementNS(SVG_NS, name)
        for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value)
        return node
      }

      /**
       * 把导航按钮里宿主生成的齿轮图标改画成插件图标（单色版）。
       *
       * 只替换 <svg> 的内容与 viewBox，保留节点本身——宿主的 className
       * （…navIcon，flex:none）、width/height（size=16）与 aria-hidden 因此
       * 原样生效，不必自己复刻一套尺寸规则；只有宿主将来不给宽高时才补默认值。
       *
       * 宿主 svg 上挂着 fill="none" 与 stroke-width（medium 为 1.3），这两条会
       * 向下继承，所以每条 path 都写全自身样式：光轨只要描边，火花只要填充。
       * 颜色一律 currentColor，取到的是按钮文字色——与旁边几个图标同一个值。
       */
      const paintSoulNavIcon = (svg) => {
        svg.setAttribute('viewBox', NAV_ICON_VIEW_BOX)
        if (!svg.getAttribute('width')) svg.setAttribute('width', NAV_ICON_FALLBACK_SIZE)
        if (!svg.getAttribute('height')) svg.setAttribute('height', NAV_ICON_FALLBACK_SIZE)

        const trail = svgNode('path', {
          d: NAV_ICON_TRAIL_D,
          fill: 'none',
          stroke: 'currentColor',
          'stroke-width': NAV_ICON_STROKE_WIDTH,
          'stroke-linecap': 'round'
        })
        const spark = svgNode('path', {
          d: NAV_ICON_SPARK_D,
          fill: 'currentColor',
          stroke: 'none'
        })

        svg.replaceChildren(trail, spark)
      }

      const registerSettingsNavIcon = () => {
        let disposed = false
        // 改画前记下宿主 svg 的原始子节点：此前卸载时只清 marker 属性、不还原内容，
        // 于是禁用插件 / HMR 之后导航栏仍显示插件图标，直到壳层重建那个按钮。
        const originalIcons = new Map()

        const sync = () => {
          if (disposed) return

          const buttons = document.querySelectorAll('[role="dialog"] nav button')
          for (const button of buttons) {
            // 匹配本栏目导航按钮：label 由 locale 词典渲染，双语均需识别
            if (NAV_LABELS.has(button.textContent?.trim())) {
              button.setAttribute(SOUL_NAV_MARKER, '')

              // 检查是否已经替换过图标
              if (button.hasAttribute(SOUL_ICON_MARKER)) continue

              // 把宿主给未知 id 用的设置齿轮，改画成插件自身的图标
              const existingIcon = button.querySelector('svg')
              if (existingIcon) {
                // 标记已替换；React 重建按钮时标记随之消失，会重新画一次
                button.setAttribute(SOUL_ICON_MARKER, 'true')
                originalIcons.set(existingIcon, Array.from(existingIcon.childNodes))
                paintSoulNavIcon(existingIcon)
              }
            } else {
              button.removeAttribute(SOUL_NAV_MARKER)
            }
          }
        }

        // 延迟执行初始同步，等待设置页面渲染完成
        let timer = setTimeout(sync, 500)
        // 最长等待：防抖只该合并「一连串变化」，不该被无限推迟 —— 会话流式输出时
        // body 每帧都在变，纯 100ms 防抖会让 sync 永远排不到（图标一直不替换）。
        const MAX_WAIT_MS = 600
        let pendingSince = 0

        // 监听 DOM 变化（只监听子节点添加，不监听所有变化）
        const observer = new MutationObserver(() => {
          // 防抖：每次变化都重置计时器，停止变化 100ms 后执行
          // （修复：此前新计时器未赋回 timer，clearTimeout 永远只清除首个 500ms
          // 计时器，防抖实际失效，每次 DOM 变化都会调度一次 sync）
          const now = Date.now()
          if (!pendingSince) pendingSince = now
          clearTimeout(timer)
          const waited = now - pendingSince
          timer = setTimeout(() => {
            pendingSince = 0
            sync()
          }, waited >= MAX_WAIT_MS ? 0 : 100)
        })

        observer.observe(document.body, {
          childList: true,
          subtree: true
        })

        return () => {
          disposed = true
          clearTimeout(timer)
          observer.disconnect()
          // 先还原图标内容，再清 marker：顺序反了会留下「无标记但已被改画」的节点
          for (const [svg, nodes] of originalIcons) {
            if (svg && typeof svg.replaceChildren === 'function') svg.replaceChildren(...nodes)
          }
          originalIcons.clear()
          document.querySelectorAll(`[${SOUL_NAV_MARKER}]`).forEach((element) => {
            element.removeAttribute(SOUL_NAV_MARKER)
          })
          document.querySelectorAll(`[${SOUL_ICON_MARKER}]`).forEach((element) => {
            element.removeAttribute(SOUL_ICON_MARKER)
          })
        }
      }

      // 注册图标替换效果
      ctx.effect(() => registerSettingsNavIcon(), 'dsh-soul: settings navigation icon')

      // 注册到输入框工具栏：宿主会把 input.left 放在「操作权限」控件之后。
      // conversation.input.left 是 scope:'session' 槽位 —— 宿主为它准备的标准 props
      // 里带 sessionId（ui-session 的 BUILTIN_SOURCE: props: ["sessionId"]）。
      //
      // 有了它，输入框下方的标签才能显示**当前会话**实际生效的人设与来源；
      // 否则只能读全局 store 的 activePersona，而那与模型真正拿到的人设可能不同。
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'soul-quick-toggle',
        order: 50,
        locale: NS,
        // ⚠️ inject 回调收到的是**位置参数** [sessionId]，不是 props 对象！
        //
        // 宿主契约（FactoryInjectParams）：
        //   scope 'session'      → [sessionId: SessionId]
        //   scope 'session-maybe'→ [sessionId: SessionId | undefined]
        //   scope 'root'         → []
        //
        // 这里曾写成 inject: (props) => ({ sessionId: props?.sessionId }) ——
        // props 实际是 sessionId **字符串**，props.sessionId 是 undefined，
        // 于是 sessionId 恒为 null，标签永远拿不到当前会话，
        // 层级标注（本会话覆盖 / 全局配置 / 工作区）**整块不显示**。
        inject: (sessionId) => ({
          hooks: {
            soulController: controller.store
          },
          controller,
          sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
        })
      }, SoulQuickToggle))


      // 侧栏会话行 hover 面具按钮（0.9.0-ab）。
      //
      // conversation.session.header.actions 与 conversation.hero.options 都挂了
      // 同一人设标识 —— 侧栏是第三处：会话列表里不用点开就能看到每行是谁。
      //
      // 槽位：sidebar.workspaces.session.row.action（kind:'list' / scope:'root'）。
      //
      // ⚠️ sessionId 的来源与 session 槽位**不同**：renderer 的 runInject 对
      // inject 回调只传 [binding.key, actions] —— root 槽位没有 binding ⇒
      // inject 无参、拿不到任何东西。而这一槽位的 sessionId 是 **owner props**
      // （SessionRowOwnerProps: { sessionId, displayTitle }），由 renderer 的
      // guarded(entry, key, owner = ownerProps) 直接并入组件 props。
      // ⇒ inject 只负责注入 hooks；sessionId 由组件从 props.sessionId 读。

      // 侧栏面板图标（0.9.0-ac，0.9.0-ad 回滚重做）。
      //
      // ❌ 第一版教训：注册 id 'plugins'（复用宿主插件管理器的 cell id）——
      // 文档里 "reusing a shipped id puts you in THAT cell" 的真正含义是
      // **替换该单元**，不是"并存"。实测把插件管理器的图标顶没了（用户报：
      // "你把插件整没了"）。
      //
      // ✅ 现在：注册**自己的 id**（'soul-persona-panel'）。点击后宿主
      // selectPanel('soul-persona-panel') 会切到一个未注册的面板 ——
      // 宿主文档说这种情况 "preserves the current selection"（保持当前选择，
      // 不会白屏）。图标本身仍显示：它是 Soul 的入口标识，hover 有名字。
      //
      // 长期方案（未做）：注册独立 main 面板承载「预设库管理」，那时这个图标
      // 才有真正的落地页。需要把人设管理从会话语境拆出来 —— 独立的活。
      // ❌ 暂时隐藏（0.9.0-ag）：点击切到未注册面板会"保持当前选择"（点了没反应），
      // 体验差。等独立 main 面板（预设库管理主页）做好后再启用。
      // 组件 SoulPanelIcon 与本注册块保留在源码里（注释态），作为那时的起点。
      // ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      //   name: 'sidebar.panellist',
      //   id: 'soul-persona-panel',
      //   order: 20,
      //   locale: NS,
      //   label: () => navT('nav.label'),
      //   inject: () => ({})
      // }, SoulPanelIcon))

      ctx.slots.inject('sidebar.workspaces.session.row.action', () => ctx.slots.register({
        name: 'sidebar.workspaces.session.row.action',
        id: 'soul-persona-badge',
        order: 300,
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulSessionPersonaBadge))

      // 会话人设标签（第二处）：**新会话**那一行（输入框上方）。
      //
      // conversation.hero.options —— 宿主文档："Compact options right-aligned in the
      // New Session row after the workspace and preset controls; rendered only with a
      // Session." 正是用户画的红框位置：工作区 chip 与「创造模式」之后、右对齐。
      //
      // 与 header 那个（见下）是**同一个组件**（SoulSessionPersonaLabel）、读同一份
      // store 数据 —— 新会话时 hero 区显示这个，首轮对话后 hero 消失、header 出现，
      // 宿主本来就做了这个交接。
      ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
        name: 'conversation.hero.options',
        id: 'soul-persona-label-hero',
        order: 10,
        locale: NS,
        // scope:'session' 槽位 ⇒ inject 收**位置参数** [sessionId]（宿主契约
        // FactoryInjectParams），不是 props 对象。
        inject: (sessionId) => ({
          hooks: {
            soulController: controller.store
          },
          controller,
          sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
        })
      }, SoulSessionPersonaLabel))

      // 会话人设标签：挂到会话 header（标题旁，「创造模式」「费用明细」那一行）。
      //
      // 槽位是 kind:'list' / scope:'session'，可安全追加（宿主的 occupants：
      // agent-team(-20) / agent-preset(-10) / subagent-catalog(10) / job-list(20)）。
      // order: 30 排在它们之后 —— 标签在视觉上属于「补充信息」，
      // 不该插到「创造模式」和「费用明细」这些主动作之间。
      //
      // inject 收到的是**位置参数** [sessionId]（宿主契约 FactoryInjectParams：
      // scope 'session' → [sessionId: SessionId]），不是 props 对象。
      ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
        name: 'conversation.session.header.actions',
        id: 'soul-persona-label',
        order: 30,
        locale: NS,
        inject: (sessionId) => ({
          hooks: {
            soulController: controller.store
          },
          controller,
          sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null
        })
      }, SoulSessionPersonaLabel))

      // 输入框光轨：注册到输入框卡片内部的 overlay 槽位。
      // 组件不渲染可见内容——它按会话运行态在最近的输入框卡片上挂载/隐藏 SVG 环；
      // 同一份 soulController store 保证与设置页的开关、颜色实时一致。
      ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
        name: 'conversation.input.overlay',
        id: 'soul-trail',
        order: 50,
        inject: () => ({
          hooks: {
            soulController: controller.store
          }
        })
      }, SoulTrail))

      // 注册到设置页面（label 用 navT 实时解析；壳层在语言切换时会重新解析 label）
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'soul-settings',
        order: 50,
        label: () => navT('nav.label'),
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulSettings))

      // —— 变更记录主入口：插件详情页（0.8.1 双入口）——
      // 槽位 plugins.detail.section（list/root）：宿主在插件详情页自身内容下方
      // 为每个注册者渲染一个自定义区块；subject 形态与判据见 SoulHistorySection
      // 头注释（只服务 subject.pkg.name === 'dsh-soul' 的 bundle 详情页）。
      // 槽位不存在时 inject 静默不注册 ⇒ 由 verify-config 的源文本契约断言钉住槽位名。
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'soul-detail-history',
        order: 50,
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulHistorySection))

      // —— 会话「人设」tab（0.9.0-d）——
      //
      // 槽位 `conversation.view` 是**列表**槽位：宿主用 `slots.entries(...)` 动态枚举
      // 生成 tab 栏（与轨迹 / 上下文 / 编队同机制），所以注册后会自动出现，不需要改宿主。
      //
      // 唯一的入口价值在于它的 inject 签名是 `(sessionId) => props` —— 这是插件
      // 能拿到**当前会话 id** 的唯一正规途径（设置页的 slotInject 是空串，拿不到）。
      // 因此 sessionId 必须原样传给组件，不能只传 controller。
      //
      // order 排在宿主内置视图之后（对话 0 / 轨迹 10 / 上下文 20 / 编队 30 级），
      // 用 90 确保「人设」在最右，不打乱用户已经熟悉的顺序。
      ctx.slots.inject('conversation.view', () => ctx.slots.register({
        name: 'conversation.view',
        id: 'soul-persona',
        order: 90,
        label: () => navT('session.tabLabel'),
        locale: NS,
        inject: (sessionId) => ({
          hooks: {
            soulController: controller.store
          },
          controller,
          sessionId: typeof sessionId === 'string' ? sessionId : null
        })
      }, SoulSessionPersona))

      // —— 工作区人设（0.9.0-e）——
      //
      // 注册到插件详情页：与变更记录同一槽位，宿主为每个注册者渲染一个区块。
      // 不与设置页放在一起的原因写在 SoulWorkspaces 头注释里（低频 + 需要空间）。
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'soul-detail-workspaces',
        order: 40, // 排在变更记录（50）之前：人设是"怎么配"，记录是"改过什么"
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulWorkspaces))

      // —— 会话覆盖清理（0.9.0-f）——
      // 同一槽位、order 60：排在变更记录之后（它是这三块里最低频的运维动作）。
      ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
        name: 'plugins.detail.section',
        id: 'soul-detail-sessions',
        order: 60,
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulSessions))

      // 初始配置的拉取已并入上面的全局轮询 —— 它的 refresh() 在注册时立即执行一次
      // （含 loadConfig + loadPersonas），这里再调一次就是同一次装配发两个相同请求。
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
