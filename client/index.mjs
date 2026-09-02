// client/index.mjs — dsh-soul Web UI 插件
//
// 在设置页面添加「个性化」栏目：
//   - 启用/禁用个性化设置
//   - 「关于你」（昵称/职业/介绍）、回复风格和语调、特质、输出语言、自定义指令
//   - dirty 检测（无改动禁用保存）、保存结果提示（已保存 / 无变化）
//   - 查看当前生效提示词（只读）与字符数
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
      loading: false,
      saving: false,
      error: null,
      // 最近一次保存实际变化的字段名数组（来自 POST /api/soul/config 的 changed）
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
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
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
            s.lastChanged = Array.isArray(payload.changed) ? payload.changed : []
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

      // 读取当前生效（已保存）的提示词：{ ok, prompt, enabled }
      async fetchPrompt() {
        const url = new URL('/api/soul/prompt', hostBase())
        const response = await this.fetcher(url)
        const payload = await response.json().catch(() => ({}))
        if (!response.ok || payload.ok !== true) {
          throw new Error(payload.error || `HTTP ${response.status}`)
        }
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
      '.soul-dirty{color:#d46b08}',
      '.soul-prompt-toggle{margin-top:8px}',
      '.soul-prompt-link{background:none;border:none;padding:0;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;text-decoration:underline}',
      '.soul-prompt-link:hover{color:var(--dsw-alias-label-primary)}',
      '.soul-prompt-pre{margin:8px 0 0 0;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-l1);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto;font-family:Consolas,Menlo,monospace;text-align:left;width:100%;box-sizing:border-box}',
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
    // 文案词典（键集中英完全对齐；渲染器按槽位 locale 注入 t）
    // -------------------------------------------------------------------------

    const zh = {
      'nav.label': '个性化',
      'settings.title': '个性化设置',
      'toggle.enabled': '启用个性化设置',
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
      'button.save': '保存设置',
      'button.saving': '保存中...',
      'button.reset': '重置默认',
      'status.loading': '加载中...',
      'status.unsaved': '有未保存的更改',
      'toast.saved': '✅ 设置已保存',
      'toast.noChanges': '✅ 配置无变化',
      'toast.reset': '✅ 已重置为默认值',
      'prompt.view': '查看当前生效提示词',
      'prompt.hide': '收起提示词',
      'prompt.loading': '提示词加载中...',
      'prompt.empty': '（个性化已禁用，提示词为空）',
      'prompt.chars': '当前字符数：{n}'
    }

    const en = {
      'nav.label': 'Personalization',
      'settings.title': 'Personalization Settings',
      'toggle.enabled': 'Enable personalization',
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
      'button.save': 'Save Settings',
      'button.saving': 'Saving...',
      'button.reset': 'Reset to Default',
      'status.loading': 'Loading...',
      'status.unsaved': 'You have unsaved changes',
      'toast.saved': '✅ Settings saved',
      'toast.noChanges': '✅ No changes to save',
      'toast.reset': '✅ Reset to defaults',
      'prompt.view': 'View the active system prompt',
      'prompt.hide': 'Hide the prompt',
      'prompt.loading': 'Loading prompt...',
      'prompt.empty': '(personalization disabled — the prompt is empty)',
      'prompt.chars': 'Current character count: {n}'
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
    const FIELD_KEYS = ['enabled', 'nickname', 'occupation', 'bio', 'style', 'headingLists', 'emoji', 'language', 'customInstructions']

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
      // 渲染器按槽位 locale 命名空间注入 t（随语言切换更新）；缺失时回退中文
      const t = typeof props.t === 'function' ? props.t : FALLBACK_T
      const state = useSoulController((state) => state)
      const { enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions, loading, saving, error, lastChanged } = state

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
      const [showPrompt, setShowPrompt] = React.useState(false)
      const [promptText, setPromptText] = React.useState('')
      const [promptLoading, setPromptLoading] = React.useState(false)
      const [promptError, setPromptError] = React.useState(null)

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

      // dirty 检测：本地表单与已保存配置逐字段比较
      const savedMap = { enabled, nickname, occupation, bio, style, headingLists, emoji, language, customInstructions }
      const localMap = { enabled: localEnabled, nickname: localNickname, occupation: localOccupation, bio: localBio, style: localStyle, headingLists: localHeadingLists, emoji: localEmoji, language: localLanguage, customInstructions: localInstructions }
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

      const handleSave = async () => {
        await controller.saveConfig(localMap)
        setShowSuccess(true)
        if (showPrompt) await loadPrompt()
      }

      const handleReset = async () => {
        await controller.resetConfig()
        setShowResetSuccess(true)
        if (showPrompt) await loadPrompt()
      }

      const styleOptions = STYLE_VALUES.map((value) => ({ value, label: t(`style.${value}`) }))
      const headingListsOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.headingLists.${value}`) }))
      const emojiOptions = TRAIT_VALUES.map((value) => ({ value, label: t(`trait.emoji.${value}`) }))
      const savedToastText = Array.isArray(lastChanged) && lastChanged.length > 0 ? t('toast.saved') : t('toast.noChanges')

      return e('div', { className: 'soul-section' },
        e('h3', null, t('settings.title')),
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
          e('div', { className: 'soul-group-title' }, t('group.aboutYou')),
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
          ),

          e('div', { className: 'soul-group-title' }, t('group.traits')),
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
              ...styleOptions.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
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
              ...headingListsOptions.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
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
              ...emojiOptions.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
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
              ...LANGUAGE_OPTIONS.map(opt =>
                e('option', { key: opt.value, value: opt.value }, opt.label)
              )
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

        e('div', { className: 'soul-prompt-toggle' },
          e('button', {
            type: 'button',
            className: 'soul-prompt-link',
            onClick: togglePrompt
          }, showPrompt ? t('prompt.hide') : t('prompt.view'))
        ),
        showPrompt && e('div', { className: 'soul-prompt-panel' },
          promptLoading
            ? e('div', { className: 'soul-status' }, t('prompt.loading'))
            : (promptError
              ? e('div', { className: 'soul-error' }, promptError)
              : e(Fragment, null,
                e('pre', { className: 'soul-prompt-pre' }, promptText || t('prompt.empty')),
                e('div', { className: 'soul-status' }, t('prompt.chars', { n: String(promptText.length) }))
              ))
        ),

        loading && e('div', { className: 'soul-status' }, t('status.loading')),

        showSuccess && e('div', {
          className: 'soul-toast soul-toast-success',
          style: {
            animation: 'fadeInOut 2s ease-in-out'
          }
        }, savedToastText),

        showResetSuccess && e('div', {
          className: 'soul-toast soul-toast-success',
          style: {
            animation: 'fadeInOut 2s ease-in-out'
          }
        }, t('toast.reset'))
      )
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
