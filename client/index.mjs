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
    const VERSION = '0.8.0'
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

      async savePersona(name) {
        return await this.postJSON('/api/soul/personas/save', { name })
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
      '.soul-quick-toggle{position:relative;isolation:isolate;display:inline-flex;align-items:center;gap:6px;min-height:28px;overflow:hidden;padding:4px 10px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}',
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
      '.soul-quick-toggle-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:9em;opacity:.85}',
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
      '.soul-persona-badge{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-secondary);flex:none;padding:0 6px;font-size:11px;line-height:16px;white-space:nowrap}',
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
      'personas.hint': '预设只保存 Agent 的人设（风格 / 特质 / 回复长度 / 输出语言 / 自定义指令），不含「关于你」；内置预设随插件提供，不可删除',
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
      // 改为「人设预设」折叠标题旁的问号提示（SoulHint），文案缩成一句，hover 展示。
      'history.entryHint': '变更记录已移至插件详情页：撤销、恢复预设、清空都在那里。',
      // —— 变更记录保留条数（0.8.0 打磨）——
      'history.maxEntries': '保留条数',
      'history.maxEntriesHint': '变更记录最多保留多少条。超出后自动丢弃最旧的记录；条数越多，可撤销的范围越大。',
      'history.maxEntriesDefault': '{count} 条（默认）',
      'history.maxEntriesOption': '{count} 条',
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
      'hint.replyLength': 'Controls how long answers are. "Balanced" adds no constraint and lets the agent decide.',
      'field.language': 'Output language',
      'hint.language': 'Sets the language the agent replies in; also affects the /soul command output.',
      'field.instructions': 'Custom instructions',
      'hint.instructions': 'Extra persona or habit requirements. Avoid repeating wording similar to the style & tone option above to prevent conflicts.',
      'field.instructionsPlaceholder': 'Custom instructions — other behaviors, style or tone preferences',
      'group.personas': 'Personas',
      'personas.save': 'Save current as persona',
      'personas.saveAs': 'Save as persona…',
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
      'personas.hint': 'A persona saves the agent personality only (style / traits / reply length / reply language / custom instructions), never your own identity fields; built-ins ship with the plugin and cannot be deleted',
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
      'history.entryHint': 'Change history has moved to the plugin details page: undo, restore preset, and clear all live there.',
      // —— Change history retention (0.8.0 polish) ——
      'history.maxEntries': 'Entries kept',
      'history.maxEntriesHint': 'How many change-history entries to keep. Older entries are dropped once the limit is reached; a larger number means a longer undo window.',
      'history.maxEntriesDefault': '{count} entries (default)',
      'history.maxEntriesOption': '{count} entries',
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

    // 表单字段与 store 字段的一一对应（dirty 检测与保存载荷共用）
    const FIELD_KEYS = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth', 'historyMaxEntries']

    // 变更记录保留条数的可选值。**只放整数档位，不做自由输入**：
    // 这是个一次设定、此后不再碰的容量参数，自由输入只会带来
    // 「输 30 被夹到 50」这种需要额外解释的状态。默认档（200）单独标注出来，
    // 用户想回到出厂设置时一眼能找到。
    const HISTORY_MAX_ENTRIES_OPTIONS = [50, 100, 200, 500]
    const HISTORY_MAX_ENTRIES_DEFAULT = 200

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
      historyMaxEntries: 'history.maxEntries'
    }

    // 与 lib/history.mjs 的 HISTORY_SOURCES 对齐；认不出的来源原样显示。
    const HISTORY_SOURCES = ['web', 'command', 'tool', 'service', 'persona', 'rollback', 'restorePersona']

    // 一次最多铺开多少条。记录上限是 200 条，全渲染会让这一组比整个设置页还长；
    // 超出的折成一行「还有 N 条」，想看完的人再点一次。
    const HISTORY_RENDER_LIMIT = 20

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
      const { history, historyWarning, historyMax, historyError } = state

      // 结果提示：与设置页同款双轨 —— 成功绿字（role=status）、失败红字（role=alert），
      // 失败压过成功。独立于 pendingUndo/pendingClear（那两个有 5s 超时）。
      const [notice, setNotice] = React.useState(null)
      const [errorNotice, setErrorNotice] = React.useState(null)

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

    // 输入框工具栏快捷开关：复用全局 soulController，和设置页保持同一份状态。
    function SoulQuickToggle(props) {
      const { useSoulController, controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const enabled = state.enabled === true
      const busy = state.saving === true
      // B：底栏开关上缀当前人设名，与输入框上方的标签互相印证
      const activePersona = state.activePersona

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
        enabled && e('span', { className: 'soul-quick-toggle-name' },
          `· ${activePersona || t('quick.custom')}`)
      )
    }

        function SoulSettings(props) {
      const { useSoulController, controller } = props
      // 渲染器按槽位 locale 命名空间注入 t（随语言切换更新）；缺失时回退中文
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const { enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth, historyMaxEntries, personas, activePersona, personasError, history, historyWarning, historyMax, historyError, saving, error } = state

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
      // 变更记录保留条数：本地表单值用**数字**（不是字符串），因为它参与 dirty 比较，
      // 而 sameValue 对数字走 === —— 存字符串会让「200」与 200 永远不等、保存按钮长亮。
      const [localHistoryMax, setLocalHistoryMax] = React.useState(
        Number.isFinite(historyMaxEntries) ? historyMaxEntries : HISTORY_MAX_ENTRIES_DEFAULT
      )
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
      const formKeys = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language', 'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth', 'historyMaxEntries']
      const localValues = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, tables: localTables, replyLength: localReplyLength, language: localLanguage, customInstructions: localInstructions, requireToolConfirmation: localToolConfirm, trailEnabled: localTrailEnabled, trailColor: localTrailColor, trailSpeed: localTrailSpeed, trailWidth: localTrailWidth, historyMaxEntries: localHistoryMax }
      const serverValues = { enabled, nickname: nickname || '', occupation: occupation || '', bio: bio || '', style, headingLists, emoji, tables, replyLength, language: language || 'zh', customInstructions, requireToolConfirmation: requireToolConfirmation === true, trailEnabled: trailEnabled === true, trailColor: trailColor || TRAIL_COLOR_FALLBACK, trailSpeed: trailSpeed || 'slow', trailWidth: trailWidth || 'thin', historyMaxEntries: Number.isFinite(historyMaxEntries) ? historyMaxEntries : HISTORY_MAX_ENTRIES_DEFAULT }
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
        setLocalHistoryMax(next.historyMaxEntries)
        // 依赖与 serverValues 的来源一致；localValues/sameValue 每次渲染都是新的，
        // 但只在「某字段真要写」时才 setState，故不会形成死循环。
      }, [enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth, historyMaxEntries])

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
      const savedMap = { enabled, nickname, occupation, bio, style, headingLists, emoji, tables, replyLength, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth, historyMaxEntries: Number.isFinite(historyMaxEntries) ? historyMaxEntries : HISTORY_MAX_ENTRIES_DEFAULT }
      const localMap = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, tables: localTables, replyLength: localReplyLength, language: localLanguage, customInstructions: localInstructions, requireToolConfirmation: localToolConfirm, trailEnabled: localTrailEnabled, trailColor: localTrailColor, trailSpeed: localTrailSpeed, trailWidth: localTrailWidth, historyMaxEntries: localHistoryMax }
      const dirty = FIELD_KEYS.some((key) => !sameValue(savedMap[key], localMap[key]))

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
      const handleSavePersona = async () => {
        const name = personaName.trim()
        if (!name) return
        try {
          await controller.savePersona(name)
          setPersonaName('')
          setShowSavePersona(false)
          await loadPersonas()
          showSavedNotice(t('notice.personaSaved', { name }))
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
      // 列出「一个人设完整的六个维度」。顺序与设置页表单一致（风格 → 标题列表 →
      // 表情 → 表格 → 回复长度 → 语言），这样卡背读起来与设置页对得上。
      const PERSONA_DIM_KEYS = ['style', 'headingLists', 'emoji', 'tables', 'replyLength', 'language']

      // 单个维度的「值」文案。刻意**不把与默认相同的项留空**：设置页里 trait 的默认值
      // 就是 'default'，而卡背要回答的是「这个人设改了什么」—— 统一标成「默认」比留空
      // 更清楚（留空会让人以为渲染坏了）。
      // 语言维度复用 LANGUAGE_OPTIONS 的标签（'中文' / 'English' 两种语言下同名，
      // 本来就是语言自称，无需翻译）。
      const personaDimLabel = (entry, dim) => {
        const row = entry || {}
        const value = row[dim]
        if (dim === 'language') {
          const opt = LANGUAGE_OPTIONS.find((o) => o.value === value)
          return opt ? opt.label : t('personas.dimDefault')
        }
        if (dim === 'style') {
          return STYLE_VALUES.includes(value) ? t(`style.${value}`) : t('personas.dimDefault')
        }
        return TRAIT_VALUES.includes(value) ? t(`trait.${dim}.${value}`) : t('personas.dimDefault')
      }

      // 卡背的全文：这一次**不截断**（正面效果栏才截断）。
      // 预设没写自定义指令时给一句说明，而不是留空 —— 留空会让人以为渲染坏了。
      const personaFullText = (entry) => {
        const raw = typeof (entry || {}).customInstructions === 'string'
          ? entry.customInstructions.trim()
          : ''
        return raw === '' ? t('personas.noCustomInstructions') : raw
      }

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
      const personaRowMeta = (entry) => {
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

      // 卡牌效果栏文本：优先用预设的 customInstructions（它是人格差异的主要载体），
      // 没有则退回维度摘要。为什么取 customInstructions 而不是摘要：摘要只说
      // 「专业严谨 · 默认」这类档位，而卡牌需要一句话说清「这个预设会怎么回答」。
      //
      // 截断到第一句或 60 字：卡面空间有限，CSS 侧还有 3 行 line-clamp 兜底。
      const personaEffectText = (entry) => {
        const raw = typeof (entry || {}).customInstructions === 'string' ? entry.customInstructions.trim() : ''
        if (raw === '') return personaRowMeta(entry)
        // 按中文句号/分号/换行切第一句；无标点时整段交给 CSS 截断
        const firstSentence = raw.split(/[。；;\n]/)[0] || raw
        const text = firstSentence.length > 60 ? `${firstSentence.slice(0, 60)}…` : firstSentence
        return text
      }

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
            // 保留条数是**容量设置**，不是预设操作，但它只在详情页里被用到 ——
            // 放在这一组（紧挨「变更记录入口」指引）比另开一组更符合「去哪儿找它」的直觉。
            e('div', { className: 'soul-field' },
              e('label', { htmlFor: 'soul-historyMaxEntries' },
                t('history.maxEntries'),
                e(SoulHint, { text: t('history.maxEntriesHint') })
              ),
              e('select', {
                id: 'soul-historyMaxEntries',
                value: String(localHistoryMax),
                onChange: (ev) => setLocalHistoryMax(Number(ev.target.value))
              },
                ...HISTORY_MAX_ENTRIES_OPTIONS.map((count) => e('option', {
                  key: count,
                  value: String(count)
                }, count === HISTORY_MAX_ENTRIES_DEFAULT
                  ? t('history.maxEntriesDefault', { count: String(count) })
                  : t('history.maxEntriesOption', { count: String(count) })))
              )
            ),
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
                                e('span', { className: 'soul-persona-label' }, name === activePersona ? `★ ${name}` : name)
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
                onClick: () => { setPersonaName(''); setShowSavePersona(true) }
              }, t('personas.driftAction'))
            ),
            // 说明合并成一块（用户要求）：预设的收录范围、以及变更记录搬去了哪儿。
            // 两条都是「读者需要知道、但不需要操作」的信息，拆成两处反而像两个待办。
            // 用能直接读到的正文而非 hover 提示 —— 它们解释的正是展开后看到的东西。
            e('div', { className: 'soul-note' },
              e('div', null, t('personas.hint')),
              e('div', null, t('history.entryHint'))
            )
          ),

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
            e('div', { className: 'soul-modal-actions' },
              e(ui.Button, {
                onClick: () => { setShowSavePersona(false); setPersonaName('') }
              }, t('button.cancel')),
              e(ui.Button, {
                variant: 'primary',
                onClick: handleSavePersona,
                disabled: saving || !personaName.trim()
              }, saving ? t('button.saving') : t('personas.saveConfirm'))
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
      ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'soul-quick-toggle',
        order: 50,
        locale: NS,
        inject: () => ({
          hooks: {
            soulController: controller.store
          },
          controller
        })
      }, SoulQuickToggle))


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

      // 初始配置的拉取已并入上面的全局轮询 —— 它的 refresh() 在注册时立即执行一次
      // （含 loadConfig + loadPersonas），这里再调一次就是同一次装配发两个相同请求。
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
