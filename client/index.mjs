// client/index.mjs — dsh-soul Web UI 插件
//
// 在设置页面添加「个性化」栏目：
//   - 启用/禁用个性化设置
//   - 选择回复风格和语调
//   - 输入自定义指令
//
// 纯 JS + React jsx-runtime 手写（不依赖 JSX 构建），开箱即用。
// 注意：dsh web 使用 React 17+ 的 jsx-runtime，children 必须放在 props.children
// 里；不能把 children 当第三个参数传（第三个参数是 key）。

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
    const INITIAL = {
      enabled: true,
      nickname: '',
      // 关于你：用户职业 / 用户介绍
      occupation: '',
      bio: '',
      // 回复风格和语调（合并为单一选项）
      style: 'professional',
      // 特质：标题和列表 / 表情符号
      headingLists: 'default',
      emoji: 'default',
      language: 'zh',
      customInstructions: '',
      loading: false,
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

    var SoulController = class {
      constructor(fetcher = (input, init) => fetch(input, init)) {
        this.fetcher = fetcher
        this.store = createSnapshotStore(INITIAL)
        this.disposed = false
      }

      async loadConfig() {
        if (this.disposed) return
        this.store.update(s => { s.loading = true; s.error = null })
        
        try {
          const url = new URL('/api/soul/config', hostBase())
          const response = await this.fetcher(url)
          const payload = await response.json().catch(() => ({}))
          
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          
          this.store.update(s => {
            s.enabled = payload.config.enabled
            s.nickname = payload.config.nickname || ''
            s.occupation = payload.config.occupation || ''
            s.bio = payload.config.bio || ''
            s.style = payload.config.style
            s.headingLists = payload.config.headingLists || 'default'
            s.emoji = payload.config.emoji || 'default'
            s.language = payload.config.language || 'zh'
            s.customInstructions = payload.config.customInstructions
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
          const url = new URL('/api/soul/config', hostBase())
          const response = await this.fetcher(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(config)
          })
          const payload = await response.json().catch(() => ({}))
          
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          
          this.store.update(s => {
            s.enabled = payload.config.enabled
            s.nickname = payload.config.nickname || ''
            s.occupation = payload.config.occupation || ''
            s.bio = payload.config.bio || ''
            s.style = payload.config.style
            s.headingLists = payload.config.headingLists || 'default'
            s.emoji = payload.config.emoji || 'default'
            s.language = payload.config.language || 'zh'
            s.customInstructions = payload.config.customInstructions
            s.saving = false
          })
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
          const url = new URL('/api/soul/config/reset', hostBase())
          const response = await this.fetcher(url, { method: 'POST' })
          const payload = await response.json().catch(() => ({}))
          
          if (!response.ok || payload.ok !== true) {
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          
          this.store.update(s => {
            s.enabled = payload.config.enabled
            s.nickname = payload.config.nickname || ''
            s.occupation = payload.config.occupation || ''
            s.bio = payload.config.bio || ''
            s.style = payload.config.style
            s.headingLists = payload.config.headingLists || 'default'
            s.emoji = payload.config.emoji || 'default'
            s.language = payload.config.language || 'zh'
            s.customInstructions = payload.config.customInstructions
            s.saving = false
          })
        } catch (error) {
          if (this.disposed) return
          this.store.update(s => {
            s.saving = false
            s.error = messageOf(error)
          })
        }
      }

      async dispose() {
        this.disposed = true
      }
    }

    // -------------------------------------------------------------------------
    // 样式（data-plugin-css 注入，避免与宿主样式冲突）
    // -------------------------------------------------------------------------

    const css = [
      '.soul-section{margin:24px 0;padding:20px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-l1)}',
      '.soul-section h3{margin:0 0 16px 0;font-size:16px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.soul-field{margin-bottom:16px;width:100%}',
      '.soul-field label{display:block;margin-bottom:6px;font-size:13px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.soul-field select,.soul-field textarea,.soul-field input[type=text]{width:100%;padding:8px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.5;box-sizing:border-box}',
      '.soul-field textarea{min-height:100px;resize:vertical}',
      '.soul-field textarea.soul-textarea-sm{min-height:60px}',
      '.soul-group-title{margin:20px 0 12px 0;padding-bottom:8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.soul-field select:focus,.soul-field textarea:focus,.soul-field input[type=text]:focus{outline:none;border-color:var(--dsw-alias-border-focus);box-shadow:0 0 0 2px var(--dsw-alias-border-focus-alpha)}',
      '.soul-toggle{display:flex;align-items:center;gap:8px;margin-bottom:16px}',
      '.soul-toggle label{margin:0;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.soul-buttons{display:flex;gap:8px;margin-top:16px}',
      '.soul-error{margin-top:8px;padding:8px 12px;background:var(--dsw-alias-bg-danger);border:1px solid var(--dsw-alias-border-danger);border-radius:6px;color:var(--dsw-alias-label-danger);font-size:12px;width:100%;box-sizing:border-box}',
      '.soul-hint{position:relative;display:inline-flex;align-items:center;margin-left:6px;color:var(--dsw-alias-label-secondary);cursor:help;vertical-align:middle}',
      '.soul-hint:hover{color:var(--dsw-alias-label-primary)}',
      '.soul-hint-tip{position:absolute;bottom:calc(100% + 8px);left:0;padding:8px 10px;background:#ffffff;border:1px solid rgba(0,0,0,0.1);border-radius:6px;font-size:12px;font-weight:400;line-height:1.5;color:rgba(0,0,0,0.85);white-space:normal;width:max-content;max-width:260px;text-align:left;opacity:0;visibility:hidden;transition:opacity .15s ease;pointer-events:none;z-index:9999;box-shadow:0 4px 12px rgba(0,0,0,0.15)}',
      '.soul-hint:hover .soul-hint-tip{opacity:1;visibility:visible}',
      '.soul-status{margin-top:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.soul-toast{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);padding:8px 16px;border-radius:6px;font-size:13px;font-weight:500;z-index:10000;box-shadow:0 2px 8px rgba(0,0,0,0.15);pointer-events:none;text-align:center;min-width:auto;white-space:nowrap}',
      '.soul-toast-success{background:#f6ffed;border:1px solid #b7eb8f;color:#52c41a}',
      '@keyframes fadeInOut{0%{opacity:0;transform:translate(-50%,-50%) scale(0.9)}15%{opacity:1;transform:translate(-50%,-50%) scale(1)}85%{opacity:1;transform:translate(-50%,-50%) scale(1)}100%{opacity:0;transform:translate(-50%,-50%) scale(0.9)}}'
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
    // 组件
    // -------------------------------------------------------------------------

    // 回复风格和语调（合并为单一选项）
    const STYLE_TONE_OPTIONS = [
      { value: 'professional', label: '专业严谨' },
      { value: 'casual', label: '轻松自然' },
      { value: 'humorous', label: '幽默风趣' },
      { value: 'roast', label: '吐槽达人' },
      { value: 'efficient', label: '高效干练' }
    ]

    // 特质：标题和列表
    const HEADING_LISTS_OPTIONS = [
      { value: 'default', label: '默认' },
      { value: 'more', label: '增强（采用清晰格式和列表结构）' },
      { value: 'less', label: '减弱（使用更多段落文本）' }
    ]

    // 特质：表情符号
    const EMOJI_OPTIONS = [
      { value: 'default', label: '默认' },
      { value: 'more', label: '增强（使用较多表情符号）' },
      { value: 'less', label: '减弱（尽量减少使用表情符号）' }
    ]

    // 选项用原生语言显示，两种 UI 语言下均自解释
    const LANGUAGE_OPTIONS = [
      { value: 'zh', label: '中文' },
      { value: 'en', label: 'English' }
    ]

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

    function SoulSettings(props) {
      const { useSoulController, controller } = props
      const state = useSoulController((state) => state)
      const { enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions, loading, saving, error } = state
      
      const [localEnabled, setLocalEnabled] = React.useState(enabled)
      const [localNickname, setLocalNickname] = React.useState(nickname || '')
      const [localOccupation, setLocalOccupation] = React.useState(occupation || '')
      const [localBio, setLocalBio] = React.useState(bio || '')
      const [localStyle, setLocalStyle] = React.useState(style)
      const [localHeadingLists, setLocalHeadingLists] = React.useState(headingLists)
      const [localEmoji, setLocalEmoji] = React.useState(emoji)
      const [localLanguage, setLocalLanguage] = React.useState(language || 'zh')
      const [localInstructions, setLocalInstructions] = React.useState(customInstructions)
      const [showSuccess, setShowSuccess] = React.useState(false)
      const [showResetSuccess, setShowResetSuccess] = React.useState(false)
      
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
      }, [enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions])
      
      // 保存成功后显示提示，2秒后自动消失
      React.useEffect(() => {
        if (showSuccess) {
          const timer = setTimeout(() => setShowSuccess(false), 2000)
          return () => clearTimeout(timer)
        }
      }, [showSuccess])
      
      // 重置成功后显示提示，2秒后自动消失
      React.useEffect(() => {
        if (showResetSuccess) {
          const timer = setTimeout(() => setShowResetSuccess(false), 2000)
          return () => clearTimeout(timer)
        }
      }, [showResetSuccess])
      
      const handleSave = async () => {
        const controller = props.controller
        await controller.saveConfig({
          enabled: localEnabled,
          nickname: localNickname,
          occupation: localOccupation,
          bio: localBio,
          style: localStyle,
          headingLists: localHeadingLists,
          emoji: localEmoji,
          language: localLanguage,
          customInstructions: localInstructions
        })
        setShowSuccess(true)
      }
      
      const handleReset = async () => {
        const controller = props.controller
        await controller.resetConfig()
        setShowResetSuccess(true)
      }
      
      return e('div', { className: 'soul-section' },
        e('h3', null, '个性化设置'),
        e('div', { className: 'soul-toggle' },
          e('input', {
            type: 'checkbox',
            id: 'soul-enabled',
            checked: localEnabled,
            onChange: (ev) => setLocalEnabled(ev.target.checked)
          }),
          e('label', { htmlFor: 'soul-enabled' }, '启用个性化设置')
        ),
        
        localEnabled && e(Fragment, null,
          e('div', { className: 'soul-group-title' }, '关于你'),
          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-nickname' }, '用户昵称'),
            e('input', {
              type: 'text',
              id: 'soul-nickname',
              value: localNickname,
              onChange: (ev) => setLocalNickname(ev.target.value),
              placeholder: '输入你的昵称，回复时会称呼你'
            })
          ),
          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-occupation' }, '用户职业'),
            e('input', {
              type: 'text',
              id: 'soul-occupation',
              value: localOccupation,
              onChange: (ev) => setLocalOccupation(ev.target.value),
              placeholder: '例如：软件工程师、学生、产品经理'
            })
          ),
          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-bio' }, '用户介绍'),
            e('textarea', {
              id: 'soul-bio',
              className: 'soul-textarea-sm',
              value: localBio,
              onChange: (ev) => setLocalBio(ev.target.value),
              placeholder: '简单介绍自己，让回复更贴合你的背景'
            })
          ),

          e('div', { className: 'soul-group-title' }, '特质'),
          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-style' },
              '回复风格和语调',
              e(SoulHint, { text: '设置 Agent 回复你的风格和语调。这不会影响 Agent 的功能。' })
            ),
            e('select', {
              id: 'soul-style',
              value: localStyle,
              onChange: (ev) => setLocalStyle(ev.target.value)
            },
              ...STYLE_TONE_OPTIONS.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
            )
          ),

          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-headingLists' },
              '标题和列表',
              e(SoulHint, { text: '在回复风格和语调的基础上选择额外的自定义特质项。控制回答中标题和列表的使用程度。' })
            ),
            e('select', {
              id: 'soul-headingLists',
              value: localHeadingLists,
              onChange: (ev) => setLocalHeadingLists(ev.target.value)
            },
              ...HEADING_LISTS_OPTIONS.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
            )
          ),

          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-emoji' },
              '表情符号',
              e(SoulHint, { text: '在回复风格和语调的基础上选择额外的自定义特质项。控制表情符号的使用程度。' })
            ),
            e('select', {
              id: 'soul-emoji',
              value: localEmoji,
              onChange: (ev) => setLocalEmoji(ev.target.value)
            },
              ...EMOJI_OPTIONS.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
            )
          ),

          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-language' },
              '输出语言',
              e(SoulHint, { text: '设置 Agent 回复你使用的语言，同时影响 /soul 命令的输出语言。' })
            ),
            e('select', {
              id: 'soul-language',
              value: localLanguage,
              onChange: (ev) => setLocalLanguage(ev.target.value)
            },
              ...LANGUAGE_OPTIONS.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
            )
          ),

          e('div', { className: 'soul-field' },
            e('label', { htmlFor: 'soul-instructions' },
              '自定义指令',
              e(SoulHint, { text: '补充角色、习惯等个性化要求。建议不要重复设置回复风格和语调类似的话术，以免与上方选项冲突。' })
            ),
            e('textarea', {
              id: 'soul-instructions',
              value: localInstructions,
              onChange: (ev) => setLocalInstructions(ev.target.value),
              placeholder: '输入自定义指令，例如：你是一个求知的人，采用专业的语气...'
            })
          )
        ),
        
        error && e('div', { className: 'soul-error' }, error),
        
        e('div', { className: 'soul-buttons' },
          e(ui.Button, {
            variant: 'primary',
            onClick: handleSave,
            disabled: saving
          }, saving ? '保存中...' : '保存设置'),
          e(ui.Button, {
            onClick: handleReset,
            disabled: saving
          }, '重置默认')
        ),
        
        loading && e('div', { className: 'soul-status' }, '加载中...'),
        
        showSuccess && e('div', { 
          className: 'soul-toast soul-toast-success',
          style: {
            animation: 'fadeInOut 2s ease-in-out'
          }
        }, '✅ 设置已保存'),
        
        showResetSuccess && e('div', { 
          className: 'soul-toast soul-toast-success',
          style: {
            animation: 'fadeInOut 2s ease-in-out'
          }
        }, '✅ 已重置为默认值')
      )
    }

    // -------------------------------------------------------------------------
    // 文案
    // -------------------------------------------------------------------------

    const zh = {
      'settings.title': '个性化设置',
      'settings.description': '自定义Agent回复的风格和语调',
      'button.save': '保存设置',
      'button.reset': '重置默认',
      'option.style': '回复风格和语调',
      'option.instructions': '自定义指令',
      'option.enabled': '启用个性化设置',
      'status.loading': '加载中...',
      'status.saving': '保存中...'
    }
    
    const en = {
      'settings.title': 'Personalization Settings',
      'settings.description': 'Customize agent response style and tone',
      'button.save': 'Save Settings',
      'button.reset': 'Reset to Default',
      'option.style': 'Response Style & Tone',
      'option.instructions': 'Custom Instructions',
      'option.enabled': 'Enable Personalization',
      'status.loading': 'Loading...',
      'status.saving': 'Saving...'
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
            if (button.textContent?.trim() === '个性化') {
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
        const timer = setTimeout(sync, 500)
        
        // 监听 DOM 变化（只监听子节点添加，不监听所有变化）
        const observer = new MutationObserver(() => {
          // 防抖：只在停止变化后执行
          clearTimeout(timer)
          setTimeout(sync, 100)
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
      
      // 注册到设置页面
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'soul-settings',
        order: 50,
        label: () => '个性化',
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