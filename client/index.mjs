// client/index.mjs — dsh-soul Web UI 插件
//
// 在设置页面添加「个性化」栏目：
//   - 启用/禁用个性化设置
//   - 「关于你」（昵称/职业/介绍）、回复风格和语调、特质、输出语言、自定义指令
//   - 人设预设：保存当前为预设、一键使用（★ 标记当前匹配项）、删除
//   - Agent 工具：set_persona 确认模式开关
//   - 输入框光轨：Agent 回复中时输入框边框的流光动效（颜色 / 速度 / 粗细 + 实时示例）
//   - dirty 检测（无改动禁用保存）、统一 toast 提示
//   - 查看当前生效提示词（只读）与字符数
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
    const VERSION = '0.6.0'
    const INITIAL = {
      enabled: true,
      nickname: '',
      occupation: '',
      bio: '',
      style: 'professional',
      headingLists: 'default',
      emoji: 'default',
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
      loading: false,
      saving: false,
      error: null,
      // 最近一次保存实际变化的字段名数组（来自写路径的 changed）
      lastChanged: null
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
          state = next
          notify()
        },
        set: (next) => { state = next; notify() },
      }
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
    // 与边框重合：stroke 中心线落在容器边框盒边缘（rect 即 0,0,w,h），
    // 并靠 overflow:visible 让外半圈可见；光轨开启时隐藏宿主自身细边框，
    // 保证边界上只有一条线。

    const TRAIL_DASH = 12
    const TRAIL_LAYERS = 8
    const TRAIL_LAYER_STEP = 2.2
    const TRAIL_RADIUS = 22
    const TRAIL_COLOR_FALLBACK = '#679EFE'
    const TRAIL_PRESET_COLORS = ['#679EFE', '#22C55E', '#EF4444', '#A855F7', '#06B6D4', '#F59E0B']
    const TRAIL_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/
    const TRAIL_SPEED_VALUES = ['slow', 'normal', 'fast']
    const TRAIL_WIDTH_VALUES = ['thin', 'normal', 'thick']

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

    // 让环与容器像素尺寸一致（viewBox 用像素），圆角半径与宿主输入框卡片一致
    function sizeTrailSvg(svg, width, height) {
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return
      if (svg.dataset.trailWidth === String(width) && svg.dataset.trailHeight === String(height)) return
      svg.dataset.trailWidth = String(width)
      svg.dataset.trailHeight = String(height)
      svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
      for (const rect of svg.querySelectorAll('.soul-trail-layer')) {
        rect.setAttribute('x', '0')
        rect.setAttribute('y', '0')
        rect.setAttribute('width', String(width))
        rect.setAttribute('height', String(height))
        rect.setAttribute('rx', String(TRAIL_RADIUS))
      }
    }

    // 把环挂到宿主元素上并跟随其尺寸变化（输入框随内容增高时环不变形）；返回卸载函数
    function mountTrailRing(host) {
      const svg = buildTrailSvg()
      host.appendChild(svg)
      const sync = () => sizeTrailSvg(svg, host.clientWidth, host.clientHeight)
      sync()
      let observer = null
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(sync)
        observer.observe(host)
      } else if (typeof globalThis.addEventListener === 'function') {
        globalThis.addEventListener('resize', sync)
      }
      return () => {
        if (observer) observer.disconnect()
        else if (typeof globalThis.removeEventListener === 'function') globalThis.removeEventListener('resize', sync)
        svg.remove()
      }
    }

    var SoulController = class {
      constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher
        this.store = createSnapshotStore(INITIAL)
        this.disposed = false
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
        s.language = config.language || 'zh'
        s.customInstructions = config.customInstructions
        s.requireToolConfirmation = config.requireToolConfirmation === true
        s.trailEnabled = config.trailEnabled !== false
        s.trailColor = config.trailColor || TRAIL_COLOR_FALLBACK
        s.trailSpeed = config.trailSpeed || 'slow'
        s.trailWidth = config.trailWidth || 'thin'
      }

      async loadConfig() {
        if (this.disposed) return
        this.store.update(s => { s.loading = true; s.error = null })

        try {
          const payload = await this.postJSON('/api/soul/config', null, { method: 'GET' })
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            s.loading = false
          })
        } catch (error) {
          if (this.disposed) return
          this.store.update(s => {
            s.loading = false
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
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
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
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
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

      async savePersona(name) {
        return await this.postJSON('/api/soul/personas/save', { name })
      }

      async usePersona(name) {
        const payload = await this.postJSON('/api/soul/personas/use', { name })
        if (!this.disposed) {
          this.store.update(s => {
            this.applyConfig(s, payload.config)
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
          })
        }
        return payload
      }

      async deletePersona(name) {
        return await this.postJSON('/api/soul/personas/delete', { name })
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

      async dispose() {
        this.disposed = true
      }
    }

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      '.soul-section{margin:24px 0;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.soul-section h3{margin:0 0 16px 0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.soul-title-row{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0}',
      '.soul-version{flex:0 0 auto;color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:400;line-height:1.4;white-space:nowrap}',
      '.soul-field{margin-bottom:16px;width:100%}',
      '.soul-field label{display:block;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.soul-field select,.soul-field textarea,.soul-field input[type=text]{width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}',
      '.soul-field select option{color:var(--dsw-alias-label-primary)}',
      '.soul-section{color-scheme:light}',
      'body[data-ds-dark-theme] .soul-section{color-scheme:dark}',
      '.soul-field select{color-scheme:light}',
      'body[data-ds-dark-theme] .soul-field select{color-scheme:dark}',
      '.soul-field textarea{min-height:100px;resize:vertical}',
      '.soul-field textarea.soul-textarea-sm{min-height:60px}',
      '.soul-group-title{margin:20px 0 12px 0;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.soul-accordion{margin:12px 0;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;overflow:visible;background:var(--dsw-alias-bg-layer-1)}',
      '.soul-accordion-open{position:relative;z-index:20}',
      // 展开时标题行下沿改直角：与下方内容区形成一条清晰的水平交界，
      // 避免"标题与内容同为一片底色、分不清哪块是标题"
      '.soul-accordion-open .soul-accordion-trigger{border-radius:5px 5px 0 0}',
      '.soul-accordion-trigger{display:flex;align-items:center;width:100%;min-height:44px;gap:10px;padding:10px 12px;border:0;border-radius:5px;background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,0.12));color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;transition:background-color .15s ease}',
      '.soul-accordion-trigger:hover{background:var(--dsw-alias-interactive-bg-hover-accent,rgba(127,127,127,0.2))}',
      '.soul-accordion-title{flex:0 0 auto;font-size:13px;font-weight:600}',
      '.soul-accordion-summary{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:12px;font-weight:400}',
      '.soul-accordion-icon{flex:0 0 18px;color:var(--dsw-alias-label-secondary);font-size:18px;line-height:1;text-align:center}',
      '.soul-accordion-body{padding:12px;border-top:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1)}',
      '.soul-field select:focus,.soul-field textarea:focus,.soul-field input[type=text]:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 25%, transparent)}',
      '.soul-toggle{display:flex;align-items:center;gap:8px;margin-bottom:16px}',
      '.soul-toggle label{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.soul-buttons{display:flex;gap:8px;margin-top:16px}',
      '.soul-quick-toggle{position:relative;isolation:isolate;display:inline-flex;align-items:center;gap:6px;min-height:28px;overflow:hidden;padding:4px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:1;cursor:pointer;white-space:nowrap}',
      '.soul-quick-toggle:hover{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}',
      '.soul-quick-toggle[data-enabled="true"]{color:var(--dsw-alias-brand-primary)}',
      '.soul-quick-toggle[data-enabled="true"]:hover{border-color:#ef4444;color:#ef4444;box-shadow:0 0 0 2px rgba(239,68,68,.18)}',
      '.soul-quick-toggle[data-enabled="false"]:hover{border-color:#22c55e;color:#22c55e;box-shadow:0 0 0 2px rgba(34,197,94,.18)}',
      '.soul-quick-toggle[data-enabled="true"]:hover::before{background:rgba(239,68,68,.24);animation:soul-toggle-red-sweep .55s ease-out both}',
      '.soul-quick-toggle[data-enabled="false"]:hover::before{background:rgba(34,197,94,.24);animation:soul-toggle-green-sweep .55s ease-out both}',
      '.soul-quick-toggle::before{content:"";position:absolute;inset:0;z-index:-1;pointer-events:none;transform:translateX(100%)}',
      '.soul-quick-toggle > *{position:relative;z-index:1}',
      '.soul-quick-toggle-dot{width:7px;height:7px;flex:0 0 7px;border-radius:50%;background:var(--dsw-alias-label-tertiary)}',
      '.soul-quick-toggle[data-enabled="true"] .soul-quick-toggle-dot{background:var(--dsw-static-green-500,#22c55e);animation:soul-status-pulse 1.8s ease-in-out infinite}',
      '.soul-quick-toggle:disabled{cursor:wait;opacity:.6}',
      '@keyframes soul-toggle-red-sweep{from{transform:translateX(100%)}to{transform:translateX(-100%)}}',
      '@keyframes soul-toggle-green-sweep{from{transform:translateX(100%)}to{transform:translateX(-100%)}}',
      '@keyframes soul-status-pulse{0%,100%{box-shadow:0 0 0 0 color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 35%,transparent);opacity:.75}50%{box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-static-green-500,#22c55e) 0%,transparent);opacity:1}}',
      '@media (prefers-reduced-motion:reduce){.soul-quick-toggle[data-enabled="true"] .soul-quick-toggle-dot{animation:none}.soul-quick-toggle[data-enabled="true"]:hover::before,.soul-quick-toggle[data-enabled="false"]:hover::before{animation:none;transform:none}}',
      '.soul-error{margin-top:8px;padding:8px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-label-error);border-radius:6px;color:var(--dsw-alias-label-error);font-size:12px;width:100%;box-sizing:border-box}',
      '.soul-hint{position:relative;display:inline-flex;align-items:center;margin-left:6px;color:var(--dsw-alias-label-secondary);cursor:help;vertical-align:middle}',
      '.soul-hint:hover{color:var(--dsw-alias-label-primary)}',
      '.soul-hint-tip{position:absolute;bottom:calc(100% + 8px);left:0;padding:8px 10px;background:#ffffff;border:1px solid rgba(0,0,0,0.1);border-radius:6px;font-size:12px;font-weight:400;line-height:1.5;color:rgba(0,0,0,0.85);white-space:normal;width:max-content;max-width:260px;text-align:left;opacity:0;visibility:hidden;transition:opacity .15s ease;pointer-events:none;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15)}',
      '.soul-hint:hover .soul-hint-tip{opacity:1;visibility:visible}',
      '.soul-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.soul-dirty{color:#d46b08}',
      '.soul-persona-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px dashed var(--dsw-alias-border-l2);font-size:12px}',
      '.soul-persona-name{color:var(--dsw-alias-label-primary);font-weight:500;white-space:nowrap}',
      '.soul-persona-meta{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.soul-persona-actions{display:flex;gap:10px;white-space:nowrap}',
      '.soul-persona-save{display:flex;gap:8px}',
      '.soul-persona-save input[type=text]{flex:1}',
      '.soul-prompt-link{background:none;border:none;padding:0;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline}',
      '.soul-prompt-link:hover{color:var(--dsw-alias-label-primary)}',
      '.soul-persona-danger{color:var(--dsw-alias-label-error)}',
      '.soul-prompt-pre{margin:8px 0 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-family:Consolas,Menlo,monospace;text-align:left;width:100%;box-sizing:border-box}',
      '.soul-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,0.15);pointer-events:none;text-align:center;min-width:auto;white-space:nowrap}',
      '.soul-toast-success{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a}',
      '.soul-toast-error{background:#fff1f0;border:1px solid #ffa39e;color:#f5222d}',
      '@keyframes fadeInOut{0%{opacity:0;transform:translate(-50%,-50%) scale(0.9)}15%{opacity:1;transform:translate(-50%,-50%) scale(1)}85%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(0.9)}}',
      // —— 输入框光轨 ——
      // 环挂在卡片上：stroke 中心线即卡片边缘，外半圈靠 overflow:visible 显示
      '.soul-trail-svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}',
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
      '[data-soul-trail="off"] .soul-trail-svg{display:none}',
      // 光轨开启时隐藏宿主输入框自身的细边框（保留 1px 占位，避免布局跳动），
      // 使边界上只存在光轨一条线
      '[data-composer-card][data-soul-trail="on"]{--dsw-elevation-stroke-color:transparent}',
      // 设置页：颜色控件与实时示例
      '.soul-trail-colors{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.soul-trail-swatch{width:26px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;cursor:pointer}',
      '.soul-trail-swatch[data-active="true"]{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.soul-trail-picker{width:34px;height:26px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:none;cursor:pointer}',
      '.soul-field .soul-trail-colors input.soul-trail-hex{width:104px;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.4;font-family:Consolas,Menlo,monospace;box-sizing:border-box}',
      '.soul-trail-preview{position:relative;margin-top:6px;padding:16px;border:1px solid var(--dsw-alias-border-l2);border-radius:22px;background:var(--dsw-alias-bg-layer-1)}',
      '.soul-trail-preview[data-soul-trail="on"]{border-color:transparent}',
      '.soul-trail-preview-text{font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '@media (prefers-reduced-motion:reduce){.soul-trail-layer{animation:none}}'
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
      'accordion.personas': '个预设',
      'accordion.on': '已开启',
      'accordion.off': '未开启',
      'toggle.enabled': '启用个性化设置',
      'quick.enable': '开启个性化',
      'quick.disable': '关闭个性化',
      'quick.statusEnabled': '个性化已启用',
      'quick.statusDisabled': '个性化已关闭',
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
      'field.language': '输出语言',
      'hint.language': '设置 Agent 回复你使用的语言，同时影响 /soul 命令的输出语言。',
      'field.instructions': '自定义指令',
      'hint.instructions': '补充角色、习惯等个性化要求。建议不要重复设置回复风格和语调类似的话术，以免与上方选项冲突。',
      'field.instructionsPlaceholder': '输入自定义指令，可以是其他行为、回复风格和语调等偏好设置',
      'group.personas': '人设预设',
      'personas.save': '保存当前为预设',
      'personas.savePlaceholder': '预设名称（1-30 字符）',
      'personas.use': '使用',
      'personas.delete': '删除',
      'personas.confirmDelete': '确定删除预设「{name}」？',
      'personas.empty': '暂无人设预设，保存当前配置后可一键切换',
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
      'group.tool': 'Agent 工具',
      'field.toolConfirm': '人设变更需确认',
      'hint.toolConfirm': '开启后，Agent 通过 set_persona 工具做出的修改不会立即生效，需在会话中使用 /soul confirm 确认或 /soul reject 拒绝。',
      'button.save': '保存设置',
      'button.saving': '保存中...',
      'button.reset': '重置默认',
      'status.loading': '加载中...',
      'status.unsaved': '有未保存的更改',
      'toast.saved': '✅ 设置已保存',
      'toast.noChanges': '✅ 配置无变化',
      'toast.reset': '✅ 已重置为默认值',
      'toast.personaSaved': '✅ 预设已保存',
      'toast.personaUsed': '✅ 预设已应用',
      'toast.personaUnchanged': 'ℹ 预设与当前配置一致',
      'toast.personaDeleted': '✅ 预设已删除',
      'prompt.view': '查看当前生效提示词',
      'prompt.hide': '收起提示词',
      'prompt.title': '当前生效提示词',
      'prompt.summaryEnabled': '已启用',
      'prompt.summaryDisabled': '已禁用',
      'prompt.summaryChars': '{n} 字符',
      'prompt.loading': '提示词加载中...',
      'prompt.empty': '（个性化已禁用，提示词为空）',
      'prompt.chars': '当前字符数：{n}',
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
      'accordion.personas': 'personas',
      'accordion.on': 'enabled',
      'accordion.off': 'disabled',
      'toggle.enabled': 'Enable personalization',
      'quick.enable': 'Enable personalization',
      'quick.disable': 'Disable personalization',
      'quick.statusEnabled': 'Personalization enabled',
      'quick.statusDisabled': 'Personalization disabled',
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
      'field.language': 'Output language',
      'hint.language': 'Sets the language the agent replies in; also affects the /soul command output.',
      'field.instructions': 'Custom instructions',
      'hint.instructions': 'Extra persona or habit requirements. Avoid repeating wording similar to the style & tone option above to prevent conflicts.',
      'field.instructionsPlaceholder': 'Custom instructions — other behaviors, style or tone preferences',
      'group.personas': 'Personas',
      'personas.save': 'Save current as persona',
      'personas.savePlaceholder': 'Persona name (1-30 chars)',
      'personas.use': 'Use',
      'personas.delete': 'Delete',
      'personas.confirmDelete': 'Delete persona "{name}"?',
      'personas.empty': 'No personas yet — save the current config to switch with one click',
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
      'group.tool': 'Agent tools',
      'field.toolConfirm': 'Require confirmation for persona changes',
      'hint.toolConfirm': 'When enabled, changes made by the agent through the set_persona tool do not apply immediately — confirm with /soul confirm or reject with /soul reject in the conversation.',
      'button.save': 'Save Settings',
      'button.saving': 'Saving...',
      'button.reset': 'Reset to Default',
      'status.loading': 'Loading...',
      'status.unsaved': 'You have unsaved changes',
      'toast.saved': '✅ Settings saved',
      'toast.noChanges': '✅ No changes to save',
      'toast.reset': '✅ Reset to defaults',
      'toast.personaSaved': '✅ Persona saved',
      'toast.personaUsed': '✅ Persona applied',
      'toast.personaUnchanged': 'ℹ Persona matches current config',
      'toast.personaDeleted': '✅ Persona deleted',
      'prompt.view': 'View the active system prompt',
      'prompt.hide': 'Hide the prompt',
      'prompt.title': 'Active system prompt',
      'prompt.summaryEnabled': 'Enabled',
      'prompt.summaryDisabled': 'Disabled',
      'prompt.summaryChars': '{n} chars',
      'prompt.loading': 'Loading prompt...',
      'prompt.empty': '(personalization disabled — the prompt is empty)',
      'prompt.chars': 'Current character count: {n}',
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
    // 输出语言选项（两种 UI 语言下均自解释，不进词典）
    const LANGUAGE_OPTIONS = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' }
    ]

    // 表单字段与 store 字段的一一对应（dirty 检测与保存载荷共用）
    const FIELD_KEYS = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'language', 'customInstructions', 'requireToolConfirmation', 'trailEnabled', 'trailColor', 'trailSpeed', 'trailWidth']

    // 提示词小图标：hover 展示说明文字
    function SoulHint(props) {
      return e('span', { className: 'soul-hint', 'aria-label': props.text },
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

    // 输入框工具栏快捷开关：复用全局 soulController，和设置页保持同一份状态。
    function SoulQuickToggle(props) {
      const { useSoulController, controller } = props
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const enabled = state.enabled === true
      const busy = state.saving === true

      const toggle = async () => {
        if (busy) return
        await controller.saveConfig({ enabled: !enabled })
      }

      return e('button', {
        type: 'button',
        className: 'soul-quick-toggle',
        'data-enabled': enabled ? 'true' : 'false',
        'aria-pressed': enabled,
        'aria-label': enabled ? t('quick.disable') : t('quick.enable'),
        title: enabled ? t('quick.disable') : t('quick.enable'),
        disabled: busy,
        onClick: toggle
      },
        e('span', { className: 'soul-quick-toggle-dot', 'aria-hidden': true }),
        enabled ? t('quick.statusEnabled') : t('quick.statusDisabled')
      )
    }

    function SoulSettings(props) {
      const { useSoulController, controller } = props
      // 渲染器按槽位 locale 命名空间注入 t（随语言切换更新）；缺失时回退中文
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const { enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth, personas, activePersona, loading, saving, error } = state

      const [localEnabled, setLocalEnabled] = React.useState(enabled)
      const [localNickname, setLocalNickname] = React.useState(nickname || '')
      const [localOccupation, setLocalOccupation] = React.useState(occupation || '')
      const [localBio, setLocalBio] = React.useState(bio || '')
      const [localStyle, setLocalStyle] = React.useState(style)
      const [localHeadingLists, setLocalHeadingLists] = React.useState(headingLists)
      const [localEmoji, setLocalEmoji] = React.useState(emoji)
      const [localLanguage, setLocalLanguage] = React.useState(language || 'zh')
      const [localInstructions, setLocalInstructions] = React.useState(customInstructions)
      const [localToolConfirm, setLocalToolConfirm] = React.useState(requireToolConfirmation === true)
      const [localTrailEnabled, setLocalTrailEnabled] = React.useState(trailEnabled === true)
      const [localTrailColor, setLocalTrailColor] = React.useState(trailColor || TRAIL_COLOR_FALLBACK)
      const [localTrailSpeed, setLocalTrailSpeed] = React.useState(trailSpeed || 'slow')
      const [localTrailWidth, setLocalTrailWidth] = React.useState(trailWidth || 'thin')
      const [personaName, setPersonaName] = React.useState('')
      const [toast, setToast] = React.useState(null)
      const [showPrompt, setShowPrompt] = React.useState(false)
      const [promptText, setPromptText] = React.useState('')
      const [promptLoading, setPromptLoading] = React.useState(false)
      const [promptError, setPromptError] = React.useState(null)
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
      React.useEffect(() => {
        setLocalEnabled(enabled)
        setLocalNickname(nickname || '')
        setLocalOccupation(occupation || '')
        setLocalBio(bio || '')
        setLocalStyle(style)
        setLocalHeadingLists(headingLists)
        setLocalEmoji(emoji)
        setLocalLanguage(language || 'zh')
        setLocalInstructions(customInstructions)
        setLocalToolConfirm(requireToolConfirmation === true)
        setLocalTrailEnabled(trailEnabled === true)
        setLocalTrailColor(trailColor || TRAIL_COLOR_FALLBACK)
        setLocalTrailSpeed(trailSpeed || 'slow')
        setLocalTrailWidth(trailWidth || 'thin')
      }, [enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth])

      // toast 自动消失
      React.useEffect(() => {
        if (toast) {
          const timer = setTimeout(() => setToast(null), 2000)
          return () => clearTimeout(timer)
        }
      }, [toast])

      // dirty 检测：本地表单与已保存配置逐字段比较
      const savedMap = { enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions, requireToolConfirmation, trailEnabled, trailColor, trailSpeed, trailWidth }
      const localMap = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, language: localLanguage, customInstructions: localInstructions, requireToolConfirmation: localToolConfirm, trailEnabled: localTrailEnabled, trailColor: localTrailColor, trailSpeed: localTrailSpeed, trailWidth: localTrailWidth }
      const dirty = FIELD_KEYS.some((key) => savedMap[key] !== localMap[key])

      const loadPrompt = async () => {
        setPromptLoading(true)
        setPromptError(null)
        try {
          const payload = await controller.fetchPrompt()
          setPromptText(payload.prompt || '')
        } catch (err) {
          setPromptError(messageOf(err))
        } finally {
          setPromptLoading(false)
        }
      }

      const togglePrompt = async () => {
        const next = !showPrompt
        setShowPrompt(next)
        if (next) await loadPrompt()
      }

      const loadPersonas = async () => {
        try {
          const payload = await controller.fetchPersonas()
          controller.store.update((s) => {
            s.personas = payload.personas
            s.activePersona = payload.activeName
          })
        } catch {
          // 预设列表加载失败不打断主配置界面
        }
      }

      // 设置页打开后重新读取宿主配置，补齐 /soul 命令等外部写入路径。
      // 表单 dirty 或正在保存时暂停，避免远端刷新覆盖用户未保存的输入。
      React.useEffect(() => {
        const refresh = () => {
          if (dirty || saving) return
          void controller.loadConfig()
          void loadPersonas()
        }
        const onVisibilityChange = () => {
          if (document.visibilityState === 'visible') refresh()
        }
        refresh()
        window.addEventListener('focus', refresh)
        document.addEventListener('visibilitychange', onVisibilityChange)
        const timer = setInterval(refresh, 2000)
        return () => {
          window.removeEventListener('focus', refresh)
          document.removeEventListener('visibilitychange', onVisibilityChange)
          clearInterval(timer)
        }
      }, [controller, dirty, saving])

      const handleSave = async () => {
        const payload = await controller.saveConfig(localMap)
        // saveConfig 失败时内部已记录 error 并返回 undefined：给出失败提示，而非误报「无变化」
        if (!payload) {
          setToast({ text: t('toast.saveFailed'), kind: 'error' })
          return
        }
        setToast({
          text: Array.isArray(payload.changed) && payload.changed.length > 0 ? t('toast.saved') : t('toast.noChanges'),
          kind: 'success'
        })
        if (showPrompt) await loadPrompt()
      }

      const handleReset = async () => {
        await controller.resetConfig()
        setToast({ text: t('toast.reset'), kind: 'success' })
        if (showPrompt) await loadPrompt()
      }

      const handleSavePersona = async () => {
        const name = personaName.trim()
        if (!name) return
        try {
          await controller.savePersona(name)
          setPersonaName('')
          await loadPersonas()
          setToast({ text: t('toast.personaSaved'), kind: 'success' })
        } catch (err) {
          setToast({ text: messageOf(err), kind: 'error' })
        }
      }

      const handleUsePersona = async (name) => {
        try {
          const payload = await controller.usePersona(name)
          await loadPersonas()
          setToast({ text: payload && payload.unchanged ? t('toast.personaUnchanged') : t('toast.personaUsed'), kind: 'success' })
          if (showPrompt) await loadPrompt()
        } catch (err) {
          setToast({ text: messageOf(err), kind: 'error' })
        }
      }

      const handleDeletePersona = async (name) => {
        if (typeof globalThis.confirm === 'function' && !globalThis.confirm(t('personas.confirmDelete', { name }))) return
        try {
          await controller.deletePersona(name)
          await loadPersonas()
          setToast({ text: t('toast.personaDeleted'), kind: 'success' })
        } catch (err) {
          setToast({ text: messageOf(err), kind: 'error' })
        }
      }

      const styleOptions = STYLE_VALUES.map((value) => ({ value, label: t(`style.${value}`) }))
      const headingListsOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.headingLists.${value}`) }))
      const emojiOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.emoji.${value}`) }))
      const personaNames = personas ? Object.keys(personas).sort() : null
      const aboutFilled = [localNickname, localOccupation, localBio].filter(Boolean).length
      const aboutSummary = aboutFilled > 0 ? `${aboutFilled}/3 ${t('accordion.filled')}` : t('accordion.empty')
      const traitsSummary = t(`style.${localStyle}`)
      const personasSummary = personas === null ? t('status.loading') : `${Object.keys(personas).length} ${t('accordion.personas')}`
      const toolSummary = localToolConfirm ? t('accordion.on') : t('accordion.off')
      const promptSummary = promptText.length > 0
        ? t('prompt.summaryChars', { n: String(promptText.length) })
        : (enabled ? t('prompt.summaryEnabled') : t('prompt.summaryDisabled'))
      const toggleSection = (section) => () => {
        setOpenSection(current => current === section ? null : section)
      }

      const personaRowMeta = (entry) => {
        const parts = []
        if (entry && STYLE_VALUES.includes(entry.style)) parts.push(t(`style.${entry.style}`))
        else if (entry && entry.style) parts.push(entry.style)
        if (entry && entry.nickname) parts.push(entry.nickname)
        return parts.join(' · ')
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
            e('div', { className: 'soul-field' },
              personaNames === null
                ? e('div', { className: 'soul-status' }, t('status.loading'))
                : (personaNames.length === 0
                  ? e('div', { className: 'soul-status' }, t('personas.empty'))
                  : e(Fragment, null,
                    ...personaNames.map((name) => {
                      const entry = personas[name] || {}
                      return e('div', { className: 'soul-persona-row', key: name },
                        e('span', { className: 'soul-persona-name' }, name === activePersona ? `★ ${name}` : name),
                        e('span', { className: 'soul-persona-meta' }, personaRowMeta(entry)),
                        e('span', { className: 'soul-persona-actions' },
                          e('button', { type: 'button', className: 'soul-prompt-link', onClick: () => handleUsePersona(name) }, t('personas.use')),
                          e('button', { type: 'button', className: 'soul-prompt-link soul-persona-danger', onClick: () => handleDeletePersona(name) }, t('personas.delete'))
                        )
                      )
                    })
                  ))
            ),
            e('div', { className: 'soul-field soul-persona-save' },
              e('input', {
                type: 'text',
                value: personaName,
                maxLength: 30,
                onChange: (ev) => setPersonaName(ev.target.value),
                placeholder: t('personas.savePlaceholder')
              }),
              e(ui.Button, {
                onClick: handleSavePersona,
                disabled: saving || !personaName.trim()
              }, t('personas.save'))
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
                e('label', null, t('trail.preview')),
                e(SoulTrailPreview, {
                  enabled: localTrailEnabled,
                  color: localTrailColor,
                  speed: localTrailSpeed,
                  width: localTrailWidth,
                  t
                })
              )
            )
          )
        ),

        e(SoulAccordion, {
          id: 'soul-prompt',
          title: t('prompt.title'),
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
                e('div', { className: 'soul-status' }, t('prompt.chars', { n: String(promptText.length) }))
              ))
        ),

        error && e('div', { className: 'soul-error' }, error),

        e('div', { className: 'soul-buttons' },
          e(ui.Button, {
            variant: 'primary',
            onClick: handleSave,
            disabled: saving || !dirty
          }, saving ? t('button.saving') : t('button.save')),
          e(ui.Button, {
            onClick: handleReset,
            disabled: saving
          }, t('button.reset'))
        ),

        dirty && !saving && e('div', { className: 'soul-status soul-dirty' }, t('status.unsaved')),

        toast && e('div', {
          className: `soul-toast ${toast.kind === 'error' ? 'soul-toast-error' : 'soul-toast-success'}`,
          style: {
            animation: 'fadeInOut 2s ease-in-out'
          }
        }, toast.text)
      )
    }

    // -------------------------------------------------------------------------
    // 输入框光轨：组件
    // -------------------------------------------------------------------------

    // 设置页内的实时示例：与线上光轨共用同一渲染层与 CSS，
    // 因此「示例所见」即「回复时所得」；颜色/速度/粗细随表单实时联动。
    function SoulTrailPreview(props) {
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const hostRef = React.useRef(null)

      React.useEffect(() => {
        const host = hostRef.current
        if (!host) return undefined
        return mountTrailRing(host)
      }, [])

      return e('div', {
        ref: hostRef,
        className: 'soul-trail-preview',
        'data-soul-trail': props.enabled ? 'on' : 'off',
        'data-soul-trail-speed': props.speed || 'slow',
        'data-soul-trail-width': props.width || 'thin',
        style: { '--soul-trail-color': safeTrailColor(props.color) }
      },
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
        const host = anchor && typeof anchor.closest === 'function'
          ? anchor.closest('[data-composer-card]')
          : null
        if (!host) return undefined

        mountedRef.current = { host, unmount: mountTrailRing(host) }
        // 先置为隐藏：效果在首帧绘制后执行，先写 off 可避免挂载瞬间闪出一帧光轨
        host.setAttribute('data-soul-trail', 'off')
        return () => {
          const mounted = mountedRef.current
          mountedRef.current = null
          if (!mounted) return
          mounted.unmount()
          mounted.host.removeAttribute('data-soul-trail')
          mounted.host.removeAttribute('data-soul-trail-speed')
          mounted.host.removeAttribute('data-soul-trail-width')
          mounted.host.style.removeProperty('--soul-trail-color')
        }
      }, [])

      // 显隐与外观同步：仅「Agent 回复中 + 光轨开关开启」时显示
      React.useEffect(() => {
        const mounted = mountedRef.current
        if (!mounted) return
        const { host } = mounted
        const enabled = state !== null && state.trailEnabled === true
        host.setAttribute('data-soul-trail', running && enabled ? 'on' : 'off')
        host.setAttribute('data-soul-trail-speed', (state && state.trailSpeed) || 'slow')
        host.setAttribute('data-soul-trail-width', (state && state.trailWidth) || 'thin')
        host.style.setProperty('--soul-trail-color', safeTrailColor(state && state.trailColor))
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

      // 暗色适配说明：原生 <select> 的弹出选项列表由浏览器按 color-scheme 渲染。
      // 宿主主题呈现器会把 html 的 color-scheme 与 body[data-ds-dark-theme] 随主题
      // 投影到 document（见 dsh-client-ui-layout ThemePresenter），因此这里用纯 CSS
      // 属性选择器跟随即可，无需 JS 监听；选项行另用主题变量显式着色兜底。

      // 导航 label / 图标替换用的翻译函数（bind 返回的函数在调用时读取当前语言）
      const navT = ctx.locale.bind(NS)

      // DSH 0.1.x 不支持 settings.section 的 icon 字段
      // 使用 DOM 操作动态替换图标（类似 dsh-better-sidebar 的方案）
      const SOUL_NAV_MARKER = 'data-soul-settings-nav'
      const SOUL_ICON_MARKER = 'data-soul-icon-replaced'

      const registerSettingsNavIcon = () => {
        let disposed = false

        const sync = () => {
          if (disposed) return

          const buttons = document.querySelectorAll('[role="dialog"] nav button')
          for (const button of buttons) {
            // 匹配本栏目导航按钮：label 由 locale 词典渲染，双语均需识别
            if (NAV_LABELS.has(button.textContent?.trim())) {
              button.setAttribute(SOUL_NAV_MARKER, '')

              // 检查是否已经替换过图标
              if (button.hasAttribute(SOUL_ICON_MARKER)) continue

              // 查找并替换图标
              const existingIcon = button.querySelector('svg')
              if (existingIcon) {
                // 标记已替换
                button.setAttribute(SOUL_ICON_MARKER, 'true')

                // 创建星形图标（跟随主题色）
                const starSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
                starSvg.setAttribute('viewBox', '0 0 24 24')
                starSvg.setAttribute('fill', 'none')
                starSvg.setAttribute('stroke', 'currentColor')
                starSvg.setAttribute('stroke-width', '2')
                starSvg.setAttribute('stroke-linecap', 'round')
                starSvg.setAttribute('stroke-linejoin', 'round')
                starSvg.style.width = '16px'
                starSvg.style.height = '16px'

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
                path.setAttribute('d', 'M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z')
                starSvg.appendChild(path)

                existingIcon.replaceWith(starSvg)
              }
            } else {
              button.removeAttribute(SOUL_NAV_MARKER)
            }
          }
        }

        // 延迟执行初始同步，等待设置页面渲染完成
        let timer = setTimeout(sync, 500)

        // 监听 DOM 变化（只监听子节点添加，不监听所有变化）
        const observer = new MutationObserver(() => {
          // 防抖：每次变化都重置计时器，停止变化 100ms 后执行
          // （修复：此前新计时器未赋回 timer，clearTimeout 永远只清除首个 500ms
          // 计时器，防抖实际失效，每次 DOM 变化都会调度一次 sync）
          clearTimeout(timer)
          timer = setTimeout(sync, 100)
        })

        observer.observe(document.body, {
          childList: true,
          subtree: true
        })

        return () => {
          disposed = true
          clearTimeout(timer)
          observer.disconnect()
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

      // 加载初始配置
      controller.loadConfig()
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
