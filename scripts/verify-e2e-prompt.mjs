#!/usr/bin/env node
/**
 * scripts/verify-e2e-prompt.mjs — 插件侧端到端回归：保存配置 → 两条通道都拿到新文本
 *
 * 用**真实的 index.mjs**（不是抽取片段）+ 假 ctx 在纯 Node 里跑通整条链路：
 *
 *   POST /api/soul/config → 写队列 → 原子落盘 → configCache → section 的 text provider
 *                                                    ↘ refreshPromptAndInject → 活动会话注入
 *
 * 「改配置 → 下一轮生效」由两条通道共同保证（0.7.1 的实测结论）：
 *   1. system prompt section：宿主每个 step 都重新求值 provider（E4 / E8 证明）；
 *   2. 活动会话注入：保存后主动把最新快照推给所有活动 agent（E13 / E16 证明）。
 * 0.7.1 曾尝试只保留通道 1 并删除注入，实测出现「会话进行中改配置不生效」，
 * 因此注入已恢复。本脚本把两条通道都钉住 —— 少了任何一条都会有用例失败。
 *
 * 另有一组用例钉住「人设预设与『关于你』的边界」：预设是 **Agent 的人格存档**，
 * 「关于你」（昵称 / 职业 / 介绍）是**使用者的身份信息**，两者是两码事 ——
 * 所以应用**任何**预设（内置 E25 或自建 E27）都不得改动这三个字段，同时它声明过的
 * 人格维度（含输出语言 E28）必须真的写回。E29 / E30 另起一份带着「v0.7.1 之前那套
 * 完整快照」的旧配置，验证历史残留既被迁移剥离、也不会在应用时写回。
 * 语义来源见 lib/personas.mjs 的四条约定。
 *
 * index.mjs 有静态外部依赖 `@deepseek-ai/dsh-llm`（注入用的 `createUserMessage`），
 * 而插件包内不含该依赖，因此挂载前先在临时目录复制一份并生成形状兼容的桩。
 *
 * 用法：node scripts/verify-e2e-prompt.mjs
 * 退出码：0 = 通过；1 = 存在失败项。
 */
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCount, skipNote } from './lib/skip-report.mjs'
// 内置人设的期望值直接取代码里的同一份数据（它的数据契约另有 verify-config 钉住），
// 免得 e2e 里再抄一份「极简主义者 = efficient / less」这类会悄悄漂移的常量。
// 「关于你」的字段名单同理取自配置层唯一来源（PROFILE_FIELDS）。
import { BUILTIN_PERSONAS } from '../lib/personas.mjs'
import { PROFILE_FIELDS } from '../lib/config.mjs'

// 基线运行应跑出的断言数：E 场景 28 项 + F 损坏场景 8 项 + G 变更记录 16 项
// + H 撤销拒绝路径 3 项 + W 工作区绑定 15 项 + 2 项判断力对照。跑完时校验，
// 防止「脚本加/删用例」与文档口径悄悄脱节。
const EXPECTED_ASSERTIONS = 100

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '..')

let passed = 0
const failures = []
function record(name, ok, detail) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(name)
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

// ==================== 假宿主 ====================

/** 记录一切被访问的服务名与每次会话注入，供 E13 / E16 断言两条通道都健在。 */
function makeCtx(agentSpecs) {
  const state = {
    sections: [],        // 每次 systemPrompt.section() 的注册
    disposals: 0,
    routes: new Map(),   // path -> handler
    routeKeys: [],       // "kind path" 注册序列（重复注册在 register 里直接抛）
    services: [],        // ctx.get / ctx.inject 索要过的服务名
    providers: [],       // 已注册的服务（ctx.provide）
    injected: [],        // 每个活动 agent 收到的注入消息（汇总，E13 用）
    agents: [],          // 活动 agent 桩（工作区绑定场景按 id 取）
    injections: new Map() // agent id -> 该会话收到的注入消息
  }

  // 活动 agent 桩：宿主通过 agents.list() 暴露，注入走 agent.inject()。
  //
  // 默认单个**不带 cwd** 的会话（E/F/G/H 场景只需要「有会话可注入」）。工作区绑定场景
  // 传 specs 造多 cwd 的多会话：`cwd` 是字符串时挂上 session.header.cwd，省略则**根本不
  // 挂 session** —— 那正是宿主在诊断装配下的形态，cwdOfAgent 必须容忍它而不是抛错。
  const specs = Array.isArray(agentSpecs) && agentSpecs.length > 0 ? agentSpecs : [{ id: 'fake-agent' }]
  const list = specs.map((spec) => {
    const bucket = []
    state.injections.set(spec.id, bucket)
    const stub = {
      id: spec.id,
      inject(message) {
        bucket.push(message)
        state.injected.push(message)
      }
    }
    if (typeof spec.cwd === 'string') stub.session = { header: { cwd: spec.cwd } }
    return stub
  })
  state.agents = list

  const agents = {
    list() {
      return list
    }
  }

  const systemPrompt = {
    section(options) {
      state.sections.push(options)
      let live = true
      return () => {
        if (live) state.disposals += 1
        live = false
      }
    }
  }

  const webServer = {
    // ★ 必须与宿主 dsh-host-webserver 的 register() **同等严格**：宿主对重复的
    // (kind, path) 直接 `throw new Error('webserver: duplicate exact route "' + path + '"')`，
    // 而抛点在 ctx.inject 回调里 ⇒ 一次重复注册会让整个插件装配失败。
    //
    // 桩若用 Map.set 静默覆盖，这条最致命的错误就永远测不出来：后注册的 handler
    // 顶掉前一个，测试里表现成「GET 也会按 POST 处理」之类的怪现象，甚至完全正常。
    // 这里如实抛错，让重复注册在断言里显形。
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (state.routeKeys.includes(key)) {
        throw new Error(`webserver: duplicate ${route.kind} route "${route.path}"`)
      }
      state.routeKeys.push(key)
      state.routes.set(route.path, route.handler)
    }
  }

  const host = {
    systemPrompt,
    webServer,
    agents,
    logger: { info() {}, warn() {}, error() {} }
  }

  // —— 三级作用域需要的两个宿主服务（0.9.0）——
  //
  // `workspaceRegistry`：宿主侧工作区权威来源。这里按真实形状提供 list()，
  // 每个条目的 sessionIds 是 getter（宿主实现里会过滤候选），桩用普通属性即可 ——
  // 被测代码只读一次并拍平成索引。
  //
  // `sessionPersistence`：会话清单的**唯一可信来源**（扫磁盘）。回收判定必须用它，
  // 绝不能用 agents.list() —— 后者是 live registry。
  //
  // 两者都可被用例替换（state.workspaces / state.storedSessions），用来验证失败路径。
  state.workspaces = []
  state.storedSessions = []
  state.workspaceRegistryCalls = 0
  state.persistenceCalls = 0

  host.workspaceRegistry = {
    list() {
      state.workspaceRegistryCalls += 1
      return state.workspaces
    }
  }
  state.persistenceBroken = false
  host.sessionPersistence = {
    async list() {
      state.persistenceCalls += 1
      // 用例可置 persistenceBroken 来模拟"服务不可用"（回收必须据此拒绝判定）
      if (state.persistenceBroken) throw new Error('persistence offline')
      return state.storedSessions.map((id) => ({ id, header: {} }))
    }
  }

  // Cordis 的语义：`ctx.inject(['x'], cb)` 交给回调的 ctx 上直接挂着 `x`
  const ctx = {
    state,
    systemPrompt,
    webServer,
    logger: host.logger,
    get(name) {
      state.services.push(`get:${name}`)
      return host[name]
    },
    inject(names, callback) {
      const list = Array.isArray(names) ? names : [names]
      for (const n of list) state.services.push(`inject:${n}`)
      // 只提供 systemPrompt 与 webServer：commands / tools 等回调不执行
      const available = list.filter((n) => n === 'systemPrompt' || n === 'webServer')
      if (available.length !== list.length || list.length === 0) return
      callback(ctx)
    },
    provide(name, value) {
      state.providers.push(name)
      host[name] = value
    },
    effect(callback) {
      return callback()
    },
    on() {},
    emit() {}
  }

  return ctx
}

/** 直接调用捕获到的 HTTP 处理器，避免起真实服务器。 */
async function callRoute(ctx, path, body, method = 'POST', url = null) {
  const handler = ctx.state.routes.get(path)
  if (!handler) throw new Error(`未注册路由 ${path}`)
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    method,
    // url 单独可传：?limit= 这类查询串住在 url 上，与路由 path 无关
    url: url === null ? path : url,
    async *[Symbol.asyncIterator]() {
      yield payload
    }
  }
  const captured = { status: 0, body: null }
  const res = {
    writeHead(status) {
      captured.status = status
    },
    end(text) {
      try {
        captured.body = JSON.parse(String(text))
      } catch {
        captured.body = String(text)
      }
    }
  }
  await handler(req, res)
  return captured
}

/** 装配上下文的桩：宿主在 diagnostics 装配时不传 agent，`agentWithCwd(null)` 就是那种形态。 */
function agentWithCwd(cwd) {
  if (typeof cwd !== 'string') return undefined
  return { session: { header: { cwd } } }
}

/**
 * 当前生效的 section 文本：始终读**最后一次**注册的 provider（模拟宿主每步求值）。
 *
 * 必须传装配上下文：0.8.1-b 之后 text provider 会按 `assembly.agent` 的 cwd 解析绑定，
 * 零参调用得到的是「没有会话信息」这条分支（也就是全局配置），那是另一个被测语义 ——
 * 想测「某个会话会拿到什么」就必须把那个会话传进来。
 */
function currentPrompt(ctx, cwd) {
  const last = ctx.state.sections[ctx.state.sections.length - 1]
  if (!last) return '<未注册>'
  return last.text({ agent: agentWithCwd(cwd) })
}

// ==================== 场景 ====================

async function scenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  try {
    // 预置一份「v0.7.1 之前保存的」自建预设：那时快照是完整配置，带着「关于你」。
    // 必须在插件挂载前落盘 —— loadConfig 会缓存首次读取的结果，而这正是被测的迁移入口。
    const LEGACY_PERSONA = {
      nickname: '老昵称',
      occupation: '老职业',
      bio: '老简介',
      style: 'roast',
      headingLists: 'less',
      updatedAt: '2025-01-01T00:00:00.000Z'
    }
    const LEGACY_NAME = '历史预设'
    // 同批预置两个「取值非法」的预设（必须在挂载前落盘：loadConfig 会缓存首次读取）。
    // 'friendly' 是 v0.1.x 的合法 style 名，LEGACY_STYLE_MAP 只迁移**活动配置**、
    // 不迁移预设库内的值 —— 所以这是真实升级路径会遇到的数据，不是人为构造。
    const PARTIAL_NAME = '部分非法预设'
    const ALL_INVALID_NAME = '全部非法预设'
    writeFileSync(
      join(dshHome, 'soul-config.json'),
      JSON.stringify({
        personas: {
          [LEGACY_NAME]: LEGACY_PERSONA,
          [PARTIAL_NAME]: { style: 'friendly', emoji: 'default', customInstructions: 'P1-部分非法' },
          [ALL_INVALID_NAME]: { style: 'bogus', emoji: 'lots' }
        }
      }, null, 2)
    )

    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`)
    const ctx = makeCtx()
    await mod.apply(ctx)

    push('E1 apply 完成并注册了一份 soul:persona section', ctx.state.sections.length === 1, `实际 ${ctx.state.sections.length}`)
    push(
      'E2 section 带 interpolate: false（R1 契约）',
      ctx.state.sections[0]?.interpolate === false,
      JSON.stringify(ctx.state.sections[0]?.interpolate)
    )

    const before = currentPrompt(ctx)

    const saved1 = await callRoute(ctx, '/api/soul/config', { customInstructions: 'E2E-甲' })
    const after1 = currentPrompt(ctx)
    push('E3 保存返回 200 ok', saved1.status === 200 && saved1.body?.ok === true, JSON.stringify(saved1.body))
    push('E4 保存后 provider 立即读到新文本', after1.includes('E2E-甲'), JSON.stringify(after1.slice(0, 80)))
    push('E5 保存前确实不含该文本（变化来自保存而非初始值）', !before.includes('E2E-甲'), JSON.stringify(before.slice(0, 80)))
    push('E6 配置真的落盘（原子写路径生效）', existsSync(join(dshHome, 'soul-config.json')))

    const saved2 = await callRoute(ctx, '/api/soul/config', { customInstructions: 'E2E-乙' })
    const after2 = currentPrompt(ctx)
    push('E7 二次保存同样 200', saved2.status === 200)
    push('E8 同一进程内再次改配置 → provider 读到新值（无需重启、无需重新注册）', after2.includes('E2E-乙'), JSON.stringify(after2.slice(0, 80)))
    push('E9 旧值已被替换（不是叠加）', !after2.includes('E2E-甲'), JSON.stringify(after2.slice(0, 80)))

    // 纯外观字段不得触发提示词刷新，也不得注入会话
    const sectionCountBefore = ctx.state.sections.length
    const injectedBefore = ctx.state.injected.length
    await callRoute(ctx, '/api/soul/config', { trailColor: '#123456' })
    push(
      'E10 纯外观字段（光轨颜色）保存后不重新注册 section（promptChanged 门控）',
      ctx.state.sections.length === sectionCountBefore,
      `${sectionCountBefore} → ${ctx.state.sections.length}`
    )
    push(
      'E10b 纯外观字段保存后不向会话注入（promptChanged 门控）',
      ctx.state.injected.length === injectedBefore,
      `${injectedBefore} → ${ctx.state.injected.length}`
    )

    // 非提示词字段必须是「推导出来的集合」而不是手写清单。
    // 手工白名单已经漏过两次（requireToolConfirmation、historyMaxEntries），
    // 后果是改一次容量参数就向所有活动会话多注入一条「配置已更新」。
    // 这里逐个走真实 HTTP 写路径，断言 section 与注入都不增加。
    for (const [key, value] of [
      ['historyMaxEntries', 500],
      ['requireToolConfirmation', true],
      ['trailEnabled', false],
      ['trailSpeed', 'fast'],
      ['trailWidth', 'thick']
    ]) {
      const sBefore = ctx.state.sections.length
      const iBefore = ctx.state.injected.length
      const saved = await callRoute(ctx, '/api/soul/config', { [key]: value })
      push(
        `E10c 非提示词字段 ${key} 保存后不刷新提示词、不注入会话`,
        saved.status === 200 &&
          (saved.body?.changed || []).includes(key) &&
          ctx.state.sections.length === sBefore &&
          ctx.state.injected.length === iBefore,
        `status=${saved.status} changed=${JSON.stringify(saved.body?.changed)} section ${sBefore}→${ctx.state.sections.length} 注入 ${iBefore}→${ctx.state.injected.length}`
      )
    }

    // 校验失败不得改动生效提示词
    const bad = await callRoute(ctx, '/api/soul/config', { style: '不存在的风格' })
    push('E11 非法枚举被拒绝（400）', bad.status === 400, JSON.stringify(bad.body))
    push('E12 被拒绝的保存不影响生效提示词', currentPrompt(ctx) === after2, '生效文本发生了变化')

    // 通道 2：配置变化必须主动推给活动会话（0.7.1 恢复注入后的核心契约）
    const lastInjected = ctx.state.injected[ctx.state.injected.length - 1]
    push(
      'E13 保存配置后向活动 agent 注入了最新快照（含刚保存的文本）',
      ctx.state.injected.length > 0 && JSON.stringify(lastInjected).includes('E2E-乙'),
      `注入 ${ctx.state.injected.length} 次`
    )
    push(
      'E16 注入 source 带生产者自持 kind（会话格式 v4 准入，issue #1）',
      ctx.state.injected.length > 0 &&
        ctx.state.injected.every(
          (m) =>
            typeof m?.source?.kind === 'string' &&
            m.source.kind.length > 0 &&
            m.source.kind !== 'plugin' &&
            m.source.kind.startsWith('plugin:')
        ),
      JSON.stringify(ctx.state.injected[0]?.source?.kind)
    )

    // 草稿预览是只读旁路
    const preview = await callRoute(ctx, '/api/soul/prompt/preview', { customInstructions: '草稿-丙' })
    push(
      'E14 草稿预览按草稿编译并回报非法字段',
      preview.status === 200 &&
        preview.body?.ok === true &&
        typeof preview.body?.prompt === 'string' &&
        preview.body.prompt.includes('草稿-丙') &&
        Array.isArray(preview.body?.invalid),
      JSON.stringify(preview.body).slice(0, 120)
    )
    push(
      'E15 草稿预览不改变生效提示词',
      currentPrompt(ctx) === after2 && !currentPrompt(ctx).includes('草稿-丙'),
      JSON.stringify(currentPrompt(ctx).slice(0, 80))
    )
    push(
      'E17 草稿预览不注入会话、不重新注册 section（只读旁路）',
      ctx.state.injected.length === injectedBefore && ctx.state.sections.length === sectionCountBefore,
      `注入 ${ctx.state.injected.length}（基准 ${injectedBefore}）/ section 注册 ${ctx.state.sections.length}（基准 ${sectionCountBefore}）`
    )

    // ── 人设预设与「关于你」的边界 ──────────────────────────────────────────────
    // 预设是 Agent 的人格存档，「关于你」是使用者的身份信息 —— 切换预设只换说话方式，
    // 不该动你的资料。用真实 index.mjs 验证这条对**任何**预设都成立：内置（E25）与
    // 自建（E27）都不动昵称 / 职业 / 介绍；同时它声明过的人格维度必须真的写回 ——
    // 含输出语言（E28）。E26 是 E25 的防空过护栏：若 apply 整个失败、配置没变，
    // E25 会「因为没改所以通过」。
    const MY_PERSONAL = { nickname: 'E2E昵称', occupation: 'E2E职业', bio: 'E2E简介', language: 'en' }
    await callRoute(ctx, '/api/soul/config', MY_PERSONAL)

    const minimal = BUILTIN_PERSONAS['极简主义者']
    const useBuiltin = await callRoute(ctx, '/api/soul/personas/use', { name: '极简主义者' })
    const afterBuiltin = useBuiltin.body?.config || {}
    push(
      'E25 应用内置预设不改动「关于你」（只覆盖它声明过的字段）',
      PROFILE_FIELDS.every((key) => afterBuiltin[key] === MY_PERSONAL[key]),
      JSON.stringify({
        nickname: afterBuiltin.nickname,
        occupation: afterBuiltin.occupation,
        bio: afterBuiltin.bio
      })
    )
    push(
      'E26 内置预设声明过的维度确实写回了活动配置（E25 不是空过）',
      afterBuiltin.style === minimal.style &&
        afterBuiltin.headingLists === minimal.headingLists &&
        afterBuiltin.emoji === minimal.emoji,
      JSON.stringify({ style: afterBuiltin.style, headingLists: afterBuiltin.headingLists, emoji: afterBuiltin.emoji })
    )

    // 自建预设：先保存，再把「关于你」与一个已声明维度一起改掉，然后应用 ——
    // 只有后者该被回滚。
    //
    // ⚠️ 保存前必须让当前配置**与任何内置预设都不同**（0.9.0-q 的重复门禁）：
    // 上一步刚应用了「极简主义者」，此刻配置内容 = 那个内置预设 ⇒ 保存会被判成
    // 重复而拒绝，自建预设根本建不出来，后续 E27/E28 全部失效。
    // 改几个内置声明过的字段即可 —— 那才是「不同的预设」。
    await callRoute(ctx, '/api/soul/config', {
      style: 'efficient', headingLists: 'less', emoji: 'less', tables: 'less',
      replyLength: 'concise', customInstructions: 'E2E 自定义文案（与任何内置预设都不同）'
    })
    await callRoute(ctx, '/api/soul/personas/save', { name: 'E2E自建' })
    await callRoute(ctx, '/api/soul/config', { nickname: '改过的昵称', style: 'humorous', language: 'zh' })
    const useMine = await callRoute(ctx, '/api/soul/personas/use', { name: 'E2E自建' })
    const afterMine = useMine.body?.config || {}
    push(
      'E27 应用自建预设同样不动「关于你」（与内置一致，不再是完整配置快照）',
      afterMine.nickname === '改过的昵称' &&
        afterMine.occupation === MY_PERSONAL.occupation &&
        afterMine.bio === MY_PERSONAL.bio,
      JSON.stringify({ nickname: afterMine.nickname, occupation: afterMine.occupation, bio: afterMine.bio })
    )
    push(
      'E28 自建预设会还原它声明过的人格维度，含输出语言（语言属于预设范围）',
      afterMine.style === minimal.style && afterMine.language === MY_PERSONAL.language,
      JSON.stringify({ style: afterMine.style, language: afterMine.language })
    )

    // 历史数据：v0.7.1 之前的自建预设是「完整配置快照」，磁盘上残留着「关于你」——
    // 这份预设是在插件挂载前就写进 soul-config.json 的（见本函数开头的预置）。
    const readBack = await callRoute(ctx, '/api/soul/config', null, 'GET')
    const legacy = readBack.body?.config?.personas?.[LEGACY_NAME] || {}
    const legacyDroppedFromDisk = !readFileSync(join(dshHome, 'soul-config.json'), 'utf8').includes('老昵称')
    push(
      'E29 历史预设里残留的「关于你」在读取时被剥离，并随下一次写入落盘',
      PROFILE_FIELDS.every((key) => !(key in legacy)) &&
        legacy.style === LEGACY_PERSONA.style &&
        legacy.headingLists === LEGACY_PERSONA.headingLists &&
        legacy.updatedAt === LEGACY_PERSONA.updatedAt &&
        legacyDroppedFromDisk,
      `${JSON.stringify(legacy)} 落盘已清理=${legacyDroppedFromDisk}`
    )

    const useLegacy = await callRoute(ctx, '/api/soul/personas/use', { name: LEGACY_NAME })
    const afterLegacy = useLegacy.body?.config || {}
    push(
      'E30 应用历史预设同样不动「关于你」（迁移 + 应用白名单双重防线）',
      afterLegacy.nickname === '改过的昵称' && afterLegacy.style === LEGACY_PERSONA.style,
      JSON.stringify({ nickname: afterLegacy.nickname, style: afterLegacy.style })
    )

    // ── 预设含非法取值时不得静默部分应用 ────────────────────────────────────────
    // normalizePersonas 只按字段名过滤、**不校验取值**，所以磁盘上的历史值（v0.1.x 的
    // 合法 style 'friendly'）或手改的异常值会走到应用路径被 sanitizeConfig 拒绝。
    // 此前两条应用路径都只取 patch、把 errors 丢掉 ⇒ 预设被「部分应用」却返回
    // ok:true，用户以为整套生效（实测 style 与 emoji 被静默丢弃）。
    // 现在：合法部分照常应用，被丢弃的字段必须出现在 invalid 里回报。
    const usePartial = await callRoute(ctx, '/api/soul/personas/use', { name: PARTIAL_NAME })
    push(
      'E31 应用含非法取值的预设时，被丢弃的字段必须在 invalid 里回报（不再静默部分应用）',
      usePartial.status === 200 &&
        Array.isArray(usePartial.body?.invalid) &&
        usePartial.body.invalid.includes('style') &&
        // 合法部分确实应用了：不能因为报错就整体不回写
        usePartial.body?.config?.customInstructions === 'P1-部分非法',
      JSON.stringify({ status: usePartial.status, invalid: usePartial.body?.invalid, changed: usePartial.body?.changed })
    )
    const useAllBad = await callRoute(ctx, '/api/soul/personas/use', { name: ALL_INVALID_NAME })
    push(
      'E32 预设无任何合法字段时按失败处理（400），不得返回 ok:true 假装应用成功',
      useAllBad.status === 400 && useAllBad.body?.ok === false,
      JSON.stringify({ status: useAllBad.status, body: useAllBad.body })
    )
    const useClean = await callRoute(ctx, '/api/soul/personas/use', { name: LEGACY_NAME })
    push(
      'E33 正常预设不受影响：invalid 为空数组（防空过 —— 若判定写反，E31 会通过而这条必炸）',
      useClean.status === 200 && Array.isArray(useClean.body?.invalid) && useClean.body.invalid.length === 0,
      JSON.stringify({ status: useClean.status, invalid: useClean.body?.invalid })
    )

    // 只读端点也必须判方法：宿主只做路径匹配，method 判定是 handler 的责任。
    // /api/soul/prompt 此前是唯一漏判的端点 —— 实测 POST 也能拿到 200。
    const promptWrongMethod = await callRoute(ctx, '/api/soul/prompt', null, 'POST')
    push(
      'E34 只读端点拒绝非 GET（POST /api/soul/prompt 必须 405，而非 200）',
      promptWrongMethod.status === 405,
      `status=${promptWrongMethod.status}`
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
  }

  return results
}

// ==================== 配置损坏场景（F1 逃生口 / F2 可观测性）====================

/**
 * 预置一份**截断的** soul-config.json，再启动插件 —— 复现用户真实踩到的路径：
 * 文件被手改坏后重启，「人设像是被重置了」，而且保存 / 命令 / 工具 / 服务四条写路径
 * 全部被拒（这是刻意的：避免以默认值为底把用户配置覆盖掉），此时**重置是唯一出路**。
 *
 * 单独一个场景而不是塞进 scenario()：损坏状态下前面那些「保存后立即生效」的用例
 * 必然全灭（它们本来就要被拒绝），混在一起会互相污染。
 */
async function corruptConfigScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-corrupt-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })
  const configFile = join(dshHome, 'soul-config.json')
  const damaged = '{"enabled": true, "nickname": "小明"'
  const backupFile = `${configFile}.corrupt`
  const parseable = () => {
    try {
      JSON.parse(readFileSync(configFile, 'utf8'))
      return true
    } catch {
      return false
    }
  }

  try {
    writeFileSync(configFile, damaged, 'utf8')

    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`)
    const ctx = makeCtx()
    await mod.apply(ctx)

    const read1 = await callRoute(ctx, '/api/soul/config', null, 'GET')
    push(
      'E18 损坏的配置被如实上报（configError），而不是静默回退默认值',
      read1.status === 200 && typeof read1.body?.configError === 'string' && read1.body.configError.length > 0,
      JSON.stringify(read1.body?.configError)
    )

    const refused = await callRoute(ctx, '/api/soul/config', { nickname: '不该写进去' })
    push(
      'E19 损坏状态下普通保存被拒绝（防止以默认值为底覆盖用户配置）',
      refused.status === 500 && /拒绝/.test(String(refused.body?.error)),
      JSON.stringify(refused.body).slice(0, 140)
    )
    push('E19b 被拒绝的保存没有改动磁盘上的原文件一个字节', readFileSync(configFile, 'utf8') === damaged)

    const reset = await callRoute(ctx, '/api/soul/config/reset')
    push(
      'E20 重置仍可用（逃生口），并回报备份路径',
      reset.status === 200 && typeof reset.body?.backupPath === 'string' && reset.body.backupPath.length > 0,
      JSON.stringify(reset.body).slice(0, 160)
    )
    push(
      'E21 损坏内容被备份到 .corrupt（逐字节一致），原文件已重新可解析',
      existsSync(backupFile) && readFileSync(backupFile, 'utf8') === damaged && parseable(),
      `备份存在=${existsSync(backupFile)} 可解析=${parseable()}`
    )

    const read2 = await callRoute(ctx, '/api/soul/config', null, 'GET')
    push(
      'E22 重置后不再上报 configError（修好/重置后不必重启 DSH）',
      read2.status === 200 && read2.body?.configError === null,
      JSON.stringify(read2.body?.configError)
    )

    const save2 = await callRoute(ctx, '/api/soul/config', { nickname: '重置后' })
    push(
      'E23 重置后保存恢复正常',
      save2.status === 200 && save2.body?.config?.nickname === '重置后',
      JSON.stringify(save2.body).slice(0, 140)
    )

    const status = await callRoute(ctx, '/api/soul/status', null, 'GET')
    push(
      'E24 诊断端点报告两条通道与版本号',
      status.status === 200 &&
        status.body?.channels?.section?.registered === true &&
        typeof status.body?.channels?.injection?.delivered === 'number' &&
        typeof status.body?.version === 'string' && status.body.version.length > 0,
      JSON.stringify(status.body).slice(0, 220)
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
  }

  return results
}

// ==================== 变更记录与回滚场景（0.8.0）====================

/**
 * 真实挂载 + 真实文件系统跑一遍变更记录：每次提交留痕、撤销、恢复被删预设、清空。
 *
 * 为什么非要在这一层测：路由里的 400 / 405 / 409 是**判定逻辑**，源码文本断言只能证明
 * 「写了这行代码」，证明不了「这条分支真的会触发」。而撤销的核心风险恰恰是分支走错 ——
 * 比如把 diverged 也当成可撤销，用户就会拿到一份从未存在过的混合配置。
 */
async function historyScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-history-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })
  const configFile = join(dshHome, 'soul-config.json')
  const historyFile = join(dshHome, 'soul-config.history.jsonl')
  const mount = async () => {
    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    const ctx = makeCtx()
    await mod.apply(ctx)
    return ctx
  }
  const listHistory = async (ctx, limit = null) => {
    const raw = await callRoute(ctx, '/api/soul/history', null, 'GET', limit === null ? null : `/api/soul/history?limit=${limit}`)
    return raw
  }

  try {
    const ctx = await mount()

    // ── 留痕：每一次提交都要留下一条，且记清来源 ────────────────────────────────
    await callRoute(ctx, '/api/soul/config', { customInstructions: 'G-甲' })
    await callRoute(ctx, '/api/soul/config', { customInstructions: 'G-乙' })
    await callRoute(ctx, '/api/soul/personas/save', { name: 'G自建' })
    const deleted = await callRoute(ctx, '/api/soul/personas/delete', { name: 'G自建' })
    push('G1 删除预设返回 200', deleted.status === 200 && deleted.body?.ok === true, JSON.stringify(deleted.body).slice(0, 120))

    push('G2 变更记录文件真的落在配置的兄弟路径上', existsSync(historyFile), historyFile)

    const all = await listHistory(ctx)
    const entries = all.body?.entries || []
    push(
      'G3 列表返回 200 且最新在前（时间线顺序由物理顺序决定，不靠时间戳排序）',
      all.status === 200 &&
        all.body?.ok === true &&
        entries.length >= 4 &&
        entries[0].personas.removed.length === 1 &&
        entries[0].personas.removed[0].name === 'G自建',
      JSON.stringify({ 条数: entries.length, 最新来源: entries[0]?.source, 最新动作: entries[0]?.action })
    )
    push(
      'G4 每条记录都带来源与动作（事后从配置差异里推不出「是谁改的」）',
      entries.every((item) => typeof item.source === 'string' && typeof item.action === 'string') &&
        entries.some((item) => item.source === 'web' && item.action === 'deletePreset'),
      JSON.stringify(entries.map((item) => `${item.source}/${item.action}`))
    )
    push(
      'G5 记录带链式指纹（配置哈希），否则撤销无法判断「当前状态是否还是当初那条链」',
      entries.every((item) => /^[0-9a-f]{64}$/.test(item.configHash)),
      JSON.stringify(entries[0]?.configHash)
    )

    const limited = await listHistory(ctx, 1)
    push(
      'G6 ?limit= 只削本次返回的条数，max 仍是容量上限（两种含义不能混）',
      limited.body?.entries?.length === 1 && limited.body.entries[0].id === entries[0].id && limited.body.max === 200,
      JSON.stringify({ 返回: limited.body?.entries?.length, max: limited.body?.max })
    )

    // ── 方法校验：写路由不能接受 GET ───────────────────────────────────────────
    const listWrongMethod = await callRoute(ctx, '/api/soul/history', null, 'POST')
    const rollbackWrongMethod = await callRoute(ctx, '/api/soul/history/rollback', null, 'GET')
    push(
      'G7 四条路由的 method 判定真的生效（POST 列表 / GET 撤销都必须 405，而不是执行写入）',
      listWrongMethod.status === 405 && rollbackWrongMethod.status === 405,
      `列表 POST=${listWrongMethod.status} 撤销 GET=${rollbackWrongMethod.status}`
    )

    // ── 撤销：回到目标条目**发生之前** ──────────────────────────────────────────
    const oldest = entries[entries.length - 1]
    const rolled = await callRoute(ctx, '/api/soul/history/rollback', { id: oldest.id })
    push(
      'G8 撤销到最早一条：配置回到那次改动之前（customInstructions 复原为默认空串）',
      rolled.status === 200 && rolled.body?.config?.customInstructions === '',
      JSON.stringify({ status: rolled.status, customInstructions: rolled.body?.config?.customInstructions })
    )
    push(
      'G9 撤销如实回报撤销了哪些条目（reversed 含目标条目自身）',
      Array.isArray(rolled.body?.reversed) && rolled.body.reversed.includes(oldest.id),
      JSON.stringify(rolled.body?.reversed)
    )
    const afterRollback = await listHistory(ctx)
    const newest = (afterRollback.body?.entries || [])[0]
    push(
      'G10 撤销动作自己也会留一条记录（时间线成链，撤销可被再撤销）',
      newest?.source === 'rollback' && newest?.action === 'rollback' && newest?.id !== oldest.id,
      JSON.stringify({ source: newest?.source, action: newest?.action })
    )

    const missing = await callRoute(ctx, '/api/soul/history/rollback', { id: 'zzzzzzzz-abcdef' })
    push(
      'G11 找不到的 id 回 400（而不是静默成功让用户以为撤销生效了）',
      missing.status === 400 && missing.body?.ok === false,
      JSON.stringify({ status: missing.status, error: missing.body?.error })
    )

    // ── 恢复预设：绝不静默覆盖同名 ─────────────────────────────────────────────
    const restore = await callRoute(ctx, '/api/soul/history/restore-persona', { id: entries[0].id })
    const personasAfter = await callRoute(ctx, '/api/soul/personas', null, 'GET')
    push(
      'G12 从「删除预设」的记录里恢复预设，条目内容逐字段还原',
      restore.status === 200 &&
        Array.isArray(restore.body?.restored) &&
        restore.body.restored.includes('G自建') &&
        Object.prototype.hasOwnProperty.call(personasAfter.body?.personas, 'G自建'),
      JSON.stringify({ status: restore.status, restored: restore.body?.restored, skipped: restore.body?.skipped })
    )

    const restoreAgain = await callRoute(ctx, '/api/soul/history/restore-persona', { id: entries[0].id })
    push(
      'G13 同名预设已存在时拒绝恢复（400）—— 删掉后又新建同名条目，恢复不能把它悄悄覆盖掉',
      restoreAgain.status === 400 &&
        (restoreAgain.body?.error || '').includes('G自建'),
      JSON.stringify({ status: restoreAgain.status, error: restoreAgain.body?.error })
    )

    const noRemoved = await callRoute(ctx, '/api/soul/history/restore-persona', { id: oldest.id })
    push(
      'G14 对「没有删除预设」的记录恢复预设回 400（不返回空成功）',
      noRemoved.status === 400,
      JSON.stringify({ status: noRemoved.status, error: noRemoved.body?.error })
    )

    // ── 记录文件是不可信输入：手改出来的怪条目不能崩，也不能静默吞掉 ────────────
    // 追加一条**手工伪造**的记录：里面有个只有空白的预设名。它骗得过
    // normalizePersonaEvents（只看「非空且不超长」），但过不了 sanitizePersonaName ——
    // 这正是「读侧再校验一遍」存在的理由。要求：既不崩，也要如实报进 skipped。
    {
      const forged = {
        v: 1,
        id: 'forged0001-abcdef',
        at: new Date().toISOString(),
        source: 'web',
        action: 'deletePreset',
        configHash: 'a'.repeat(64),
        before: { nickname: '' },
        after: { nickname: 'x' },
        personas: { added: [], updated: [], removed: [{ name: '   ', entry: { style: 'roasted' } }, { name: 'G伪造', entry: { style: 'casual' } }] }
      }
      appendFileSync(historyFile, `${JSON.stringify(forged)}\n`, 'utf8')

      const forgedResult = await callRoute(ctx, '/api/soul/history/restore-persona', { id: 'forged0001-abcdef' })
      push(
        'G16 手改出来的记录：空白名报进 skipped，合法名照常恢复（读侧二次校验，既不崩也不吞）',
        forgedResult.status === 200 &&
          forgedResult.body?.restored?.includes('G伪造') &&
          (forgedResult.body?.skipped || []).some((item) => item.reason === 'invalid-name'),
        JSON.stringify({ status: forgedResult.status, restored: forgedResult.body?.restored, skipped: forgedResult.body?.skipped })
      )
    }

    // ── 清空：隐私出口 ────────────────────────────────────────────────────────
    const cleared = await callRoute(ctx, '/api/soul/history/clear')
    const afterClear = await listHistory(ctx)
    push(
      'G15 清空回报删掉的条数，并且真的清干净（记录里有昵称 / 介绍原文，这是隐私出口）',
      cleared.status === 200 && cleared.body?.removed > 0 && afterClear.body?.entries?.length === 0,
      JSON.stringify({ removed: cleared.body?.removed, 剩余: afterClear.body?.entries?.length })
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
  }

  return results
}

/**
 * 手改配置后撤销必须被拒（409 diverged）。
 *
 * 单独一个场景的原因：diverged 的前提是「进程外的改动」，只能靠**重新挂载**来复现 ——
 * 进程内所有写路径都走同一漏斗、都会留痕，链永远不会断。这也正是它的现实来源：
 * 用户手改了 soul-config.json 之后重启 DSH。
 */
async function historyDivergedScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-diverged-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome
  const configFile = join(dshHome, 'soul-config.json')

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })
  const mount = async () => {
    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    const ctx = makeCtx()
    await mod.apply(ctx)
    return ctx
  }

  try {
    const first = await mount()
    await callRoute(first, '/api/soul/config', { customInstructions: '原始值' })
    const record = (await callRoute(first, '/api/soul/history', null, 'GET')).body?.entries?.[0]
    push('H1 预置一条可撤销的记录', typeof record?.id === 'string', JSON.stringify(record?.id))

    // 进程外改坏链条：直接改磁盘上的配置（模拟用户手工编辑 / 别的工具写入）
    const onDisk = JSON.parse(readFileSync(configFile, 'utf8'))
    writeFileSync(configFile, JSON.stringify({ ...onDisk, customInstructions: '手工改的' }, null, 2), 'utf8')

    const second = await mount()
    const diverged = await callRoute(second, '/api/soul/history/rollback', { id: record.id })
    push(
      'H2 配置被进程外改动后撤销回 409，而不是算出一份从未存在过的混合配置',
      diverged.status === 409 && diverged.body?.ok === false,
      JSON.stringify({ status: diverged.status, error: diverged.body?.error })
    )
    push(
      'H3 被拒的撤销没有改动配置（拒绝就是拒绝，不留半截写入）',
      JSON.parse(readFileSync(configFile, 'utf8')).customInstructions === '手工改的',
      readFileSync(configFile, 'utf8').slice(0, 80)
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
  }

  return results
}

// ==================== 工作区绑定场景（0.8.1-b）====================

/**
 * 同一进程里多个不同 cwd 的会话：目录绑定必须**各自解析**，且两条通道口径一致。
 *
 * 为什么非要端到端测：绑定层的纯函数（前缀匹配、最长前缀、边界判定）已由
 * verify-bindings 单独钉住，但「解析结果真的到达了会话」是另一回事 —— 中间还隔着
 * configForCwd 的合成语义、text provider 的**同步**约束、以及注入通道的逐 agent 编译。
 * 这三处任何一处接错，症状都是「绑定看起来生效了、其实全都在用全局配置」，或者更糟：
 * A 项目的人设进了 B 项目的会话。纯函数层的断言对这两件事一无所知。
 *
 * 绑定表必须在挂载**之前**落盘：loadBindings() 只在 apply() 启动时读一次
 * （读盘不能放在装配路径上 —— text provider 必须是同步的）。
 */
async function workspaceBindingScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-workspace-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  // 目录键用**真实存在**的目录。loadBindings() 会对每条键算一次 realpath 身份键；
  // 路径不存在时它刻意回落到规范化形态而不报错，但那样身份键恒等于展示键，
  // 「两个键集合」这条设计就一点都没被覆盖到。
  const dirA = mkdtempSync(join(tmpdir(), 'dsh-soul-ws-A-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-soul-ws-B-'))
  const subDir = join(dirA, '子模块')
  // 前缀边界：与 dirA 同级、名字以 dirA 结尾的兄弟目录（`D:\项目A` vs `D:\项目AB`）
  const siblingDir = `${dirA}回响`
  const bindingsFile = join(dshHome, 'soul-bindings.json')

  // 判别字符串取自两个内置人设自己的指令文本 —— 它们彼此完全不同，可当指纹用。
  const ARCH = '以系统设计视角回答'
  const MINIMAL = '只给结论和必要依据'
  const ROAST = '吐槽达人'

  const injectedText = (id) =>
    (ctxRef.state.injections.get(id) || []).map((m) => m?.content?.[0]?.text || '').join('\n')

  let ctxRef = null

  try {
    mkdirSync(subDir, { recursive: true })
    writeFileSync(
      bindingsFile,
      JSON.stringify(
        {
          version: 1,
          bindings: {
            [dirA]: '资深架构师',
            [subDir]: '极简主义者',
            [dirB]: 'W-不存在的人设'
          }
        },
        null,
        2
      )
    )

    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}`)
    const ctx = makeCtx([
      { id: 'agent-global' }, // 会话头没有 cwd
      { id: 'agent-a', cwd: dirA },
      { id: 'agent-b', cwd: dirB },
      { id: 'agent-sub', cwd: subDir },
      { id: 'agent-sibling', cwd: siblingDir }
    ])
    ctxRef = ctx
    await mod.apply(ctx)

    // 全局基线：先写入「关于你」与被绑定覆盖的维度。
    // style=roast 是刻意选的 —— 它让「覆盖真的替换了字段」与「只是又追加了一段文本」
    // 产生可观测差别（后者会同时出现吐槽文案与架构师文案，而两者互斥）。
    await callRoute(ctx, '/api/soul/config', { nickname: 'W-昵称', occupation: 'W-职业', style: 'roast' })

    // 诊断装配形态：宿主在 diagnostics 下可能**整个装配上下文都不传**
    // （runtime-types.d.ts 的注释写明 agent `absent on diagnostics`）。
    const lastSection = ctx.state.sections[ctx.state.sections.length - 1]
    const textNoAssembly = lastSection.text()

    const globalText = currentPrompt(ctx)
    const textA = currentPrompt(ctx, dirA)
    const textSub = currentPrompt(ctx, subDir)
    const textB = currentPrompt(ctx, dirB)
    const textSibling = currentPrompt(ctx, siblingDir)

    push(
      'W1 没有 cwd 的会话（含整个装配上下文缺席）回落全局配置，不抛错也不命中绑定',
      globalText.includes(ROAST) &&
        !globalText.includes(ARCH) &&
        textNoAssembly === globalText,
      JSON.stringify({ 全局含吐槽: globalText.includes(ROAST), 无上下文一致: textNoAssembly === globalText })
    )
    push(
      'W2 同一进程内不同 cwd 的会话拿到不同的 section 文本（配置不再全局唯一）',
      textA.includes(ARCH) && textSub.includes(MINIMAL) && textA !== textSub,
      JSON.stringify({ a: textA.includes(ARCH), sub: textSub.includes(MINIMAL) })
    )
    push(
      'W3 最长前缀优先：子目录自己的绑定压过父目录的绑定（不是两条叠加）',
      textSub.includes(MINIMAL) && !textSub.includes(ARCH),
      JSON.stringify(textSub.slice(0, 70))
    )
    push(
      'W4 前缀匹配落在**路径边界**上：以 dirA 为前缀的兄弟目录不得命中 dirA',
      textSibling === globalText && !textSibling.includes(ARCH),
      JSON.stringify({ 兄弟目录: siblingDir, 命中: textSibling.includes(ARCH) })
    )
    push(
      'W5 绑定指向已不存在的人设时不生效、回落全局（不自动删除，也不假装命中）',
      textB === globalText && textB.includes(ROAST),
      JSON.stringify({ 等于全局: textB === globalText })
    )
    push(
      'W6 目录绑定走预设的「部分覆盖」语义：不动「关于你」，且是替换而非追加',
      textA.includes('W-昵称') && textA.includes(ARCH) && !textA.includes(ROAST) && !textA.includes(MINIMAL),
      JSON.stringify({ 昵称在: textA.includes('W-昵称'), 吐槽被替换: !textA.includes(ROAST) })
    )

    // ── 注入通道：同样的逐会话解析，但走的是另一条路 ──────────────────────────
    const injectedA = injectedText('agent-a')
    const injectedSub = injectedText('agent-sub')
    const injectedB = injectedText('agent-b')
    const injectedGlobal = injectedText('agent-global')
    push(
      'W7 注入通道也逐会话编译：绑定目录的会话收到该人设，未绑定的收到全局配置',
      injectedA.includes(ARCH) &&
        injectedSub.includes(MINIMAL) &&
        !injectedB.includes(ARCH) &&
        injectedGlobal.includes(ROAST),
      JSON.stringify({
        a: injectedA.includes(ARCH),
        sub: injectedSub.includes(MINIMAL),
        b: injectedB.includes(ARCH)
      })
    )
    push(
      'W8 两条通道对同一会话给出**逐字节相同**的文本（section 与注入不会各说各话）',
      injectedA.endsWith(textA) && injectedGlobal.endsWith(globalText),
      JSON.stringify({ a: injectedA.endsWith(textA), 全局: injectedGlobal.endsWith(globalText) })
    )

    const status = await callRoute(ctx, '/api/soul/status', null, 'GET')
    push(
      'W9 诊断端点如实计数：五个会话各自送达，没有把「算不出来」算成失败',
      status.body?.channels?.injection?.agents === 5 &&
        status.body?.channels?.injection?.delivered === 5 &&
        status.body?.channels?.injection?.failed === 0,
      JSON.stringify(status.body?.channels?.injection)
    )

    // 全局总开关不属于 PERSONA_FIELDS，任何绑定都覆盖不了它。
    await callRoute(ctx, '/api/soul/config', { enabled: false })
    const offA = currentPrompt(ctx, dirA)
    const offGlobal = currentPrompt(ctx)
    push(
      'W10 全局总开关仍然说话：enabled=false 时绑定的目录也不会拿到人设',
      offA === '' && offGlobal === '',
      JSON.stringify({ 绑定目录: offA.slice(0, 30), 全局: offGlobal.slice(0, 30) })
    )
    await callRoute(ctx, '/api/soul/config', { enabled: true })
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }

  return results
}

// ==================== 绑定身份键与降级场景（0.8.1-b）====================

/**
 * 绑定表的「两个键集合」与读取失败时的降级，各自需要**不同的磁盘前置状态**：
 * 身份键（realpath）要真有 Junction 才与展示键不同，降级要真有损坏/异常版本的文件。
 * 而绑定表在 apply() 里只读一次，所以每一种前置状态都得重新挂载一次。
 *
 * 为什么不能只靠 lib/bindings.mjs 的纯函数断言：那里实时注入 realpathFn，证明的是
 * 「匹配函数怎么想」；这里证明的是「整条装配链真的把 Junction 认成了同一个目录」——
 * 中间还隔着 normalizeDirPath 的大小写折算、compareTable 的键优先级、以及
 * resolvePersonaForCwd 的失效回落。任何一处接错，两个路径会变成两条互不相干的绑定。
 */
async function bindingIdentityScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-identity-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })
  const bindingsFile = join(dshHome, 'soul-bindings.json')

  // 每组前置状态都真的在磁盘上造出来，用**真实存在的目录**：loadBindings() 会对每条键
  // 算一次 realpath，路径不存在时它刻意回落到规范化形态 —— 那样身份键恒等于展示键，
  // 「两个键集合」这条设计一点都没被覆盖到。
  const rootReal = mkdtempSync(join(tmpdir(), 'dsh-soul-id-real-'))
  const rootLink = mkdtempSync(join(tmpdir(), 'dsh-soul-id-link-'))
  const realDir = join(rootReal, '真实目录')
  const linkDir = join(rootLink, '入口目录')
  mkdirSync(realDir, { recursive: true })

  // 前置条件：Junction 必须真的指向另一个路径。造不出来（权限 / 平台限制）时本条
  // 就失去了判别力 —— 那必须**如实报出来**，而不是让断言「因为两边本来就是同一个
  // 目录」而空过。Windows 上 junction 不需要管理员权限，POSIX 上传 'junction' 会
  // 退化成普通 symlink，两者都能解析。
  let linkReady = false
  try {
    symlinkSync(realDir, linkDir, 'junction')
    linkReady = realpathSync(linkDir) === realpathSync(realDir)
  } catch {
    linkReady = false
  }

  const ARCH = '以系统设计视角回答'
  const MINIMAL = '只给结论和必要依据'

  const mount = async (agents) => {
    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    const ctx = makeCtx(agents)
    await mod.apply(ctx)
    return ctx
  }

  try {
    if (!linkReady) {
      // 这是**环境前置**，不是产品断言：受限沙箱 / 系统限制下造不出 junction，
      // W11–W13 那条断言根本没机会执行。按 skipNote 如实申报「未执行」，
      // 而不是塞一条永远红的失败项 —— 那会让整链常年红灯，真失败的项反而被淹没。
      if (!skipNote('verify-e2e-prompt', 1, '无法创建 junction / symlink，W11–W13（链接身份键）未执行', '在可建链接的环境（或非沙箱终端）重跑')) {
        push('W11 前置条件：Junction 可用（造不出来则 W11–W13 无判别力）', false, '无法创建 junction / symlink')
      }
    } else {
      // ── 展示键优先：身份键不得改写另一条已存在的绑定 ────────────────────────
      // 两个键各自绑不同人设：入口目录那条（展示键）与真实目录那条。realpath 会把
      // 入口目录解析成真实目录 —— 若身份键直接覆盖，真实目录的会话就会**静默拿到
      // 入口目录的人设**，而用户从设置页完全看不出来。
      writeFileSync(bindingsFile, JSON.stringify({
        version: 1,
        bindings: { [linkDir]: '极简主义者', [realDir]: '资深架构师' }
      }, null, 2))
      const ctx = await mount([{ id: 'via-link', cwd: linkDir }, { id: 'via-real', cwd: realDir }])
      const atLink = currentPrompt(ctx, linkDir)
      const atReal = currentPrompt(ctx, realDir)
      push(
        'W11 会话 cwd 是 Junction 入口时按用户写的那个键命中（展示键优先于身份键）',
        atLink.includes(MINIMAL) && !atLink.includes(ARCH),
        JSON.stringify(atLink.slice(0, 60))
      )
      push(
        'W12 真实路径的会话仍拿到真实路径那条绑定 —— 身份键不得改写已存在的展示键',
        atReal.includes(ARCH) && !atReal.includes(MINIMAL),
        JSON.stringify(atReal.slice(0, 60))
      )

      // ── 身份键的用途：绑定只写在入口、会话从真实路径进来 ─────────────────────
      // 这是设计里点名的典型失配：cwd 由 Node 的 process.cwd() 给出（规范路径），
      // 而绑定目录是用户在选择器里点出来的（很可能是 Junction 路径）。
      writeFileSync(bindingsFile, JSON.stringify({
        version: 1,
        bindings: { [linkDir]: '极简主义者' }
      }, null, 2))
      const ctx2 = await mount([{ id: 'real-only', cwd: realDir }])
      const atReal2 = currentPrompt(ctx2, realDir)
      push(
        'W13 绑定只写在 Junction 入口时，从真实路径进来的会话同样命中（身份键存在的理由）',
        atReal2.includes(MINIMAL),
        JSON.stringify(atReal2.slice(0, 60))
      )
    }

    // ── 降级：绑定文件损坏 / 版本不认识 ───────────────────────────────────────
    // 绑定是环境事实、不是用户唯一的数据副本，所以读取失败时**以空表继续**而不是
    // 拒绝启动（与配置损坏时的策略刻意不同）。用户此时看到的是「绑定都没了」，
    // 但他至少能打开设置页把它们重新绑上 —— 而不是整个插件不激活。
    writeFileSync(bindingsFile, '{"version": 1, "bindings": {"D:\\\\半截', 'utf8')
    const ctx3 = await mount([{ id: 'corrupt', cwd: realDir }])
    const atCorrupt = currentPrompt(ctx3, realDir)
    push(
      'W14 绑定文件损坏时插件照常启动、所有会话回落全局（不抛错），且损坏文件被移开备份',
      ctx3.state.sections.length === 1 && atCorrupt.length > 0 && !atCorrupt.includes(MINIMAL) &&
        existsSync(`${bindingsFile}.corrupt`),
      JSON.stringify({ section: ctx3.state.sections.length, 备份: existsSync(`${bindingsFile}.corrupt`) })
    )

    writeFileSync(bindingsFile, JSON.stringify({
      version: 99,
      bindings: { [realDir]: '极简主义者' }
    }, null, 2))
    const ctx4 = await mount([{ id: 'future', cwd: realDir }])
    const atFuture = currentPrompt(ctx4, realDir)
    push(
      'W15 绑定文件的版本号不认识时整表忽略、回落全局（不按当前语义猜着解析）',
      atFuture.length > 0 && !atFuture.includes(MINIMAL),
      JSON.stringify(atFuture.slice(0, 60))
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(rootReal, { recursive: true, force: true })
    rmSync(rootLink, { recursive: true, force: true })
  }

  return results
}

// ==================== 绑定路由场景（0.8.1-c）====================

/**
 * 绑定写路由：方法分派、准入拒绝、**写入即生效**。
 *
 * 为什么必须端到端：绑定层的纯函数已由 verify-bindings 钉住、路由的源文本契约
 * 由 verify-config 钉住，但「写完真的改变了会话里拿到的人设」是第三件事 —— 中间
 * 隔着独立写队列、缓存重载、以及**必须由路由自己触发的刷新**。绑定不改
 * soul-config.json，commitConfig 的 promptChanged 门控看不见它（设计 §6.4）。
 * 接错的症状是「设置页显示绑定成功，会话里却还是全局人设，要重启才生效」，
 * 而纯函数层与源文本契约对这件事一无所知。
 *
 * 另一个只有端到端能覆盖的点：GET 与 POST 共用**一次** register（宿主
 * dsh-host-webserver 对重复的 (kind, path) 直接抛错，装配会整个失败）。假宿主
 * 的 register 已与宿主同等严格，故本场景一挂载就会暴露任何重复注册。
 */

// ==================== 三级作用域：真挂载跑通 Global → Workspace → Session ====================
//
// 为什么必须真挂载：0.9.0 的合并逻辑此前只有源文本契约（看源码里有没有写对），
// 那种断言证明不了运行时真的按三层解析 —— 把 configForScope 整段短路成返回 base，
// 源文本仍然"看起来对"。
//
// 场景（真实 index.mjs + 含 workspaceRegistry / sessionPersistence 桩的假 ctx）：
//   S1  工作区覆盖命中 → 拿到该工作区的人设
//   S2  S3  索引未命中 → 回退目录绑定，且不串到别的工作区
//   S4  都没有 → 回落全局
//   S5  S6  会话覆盖优先级最高，且是字段级的（不清掉工作区层的其它字段）
//   S7  全局 enabled=false 时任何层都不得注入
//   S8–S10  persistence 不可用时回收不判定、不删文件、不写孤儿标记
async function scopeScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-scope-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  const dirA = mkdtempSync(join(tmpdir(), 'dsh-soul-scope-a-'))
  const dirB = mkdtempSync(join(tmpdir(), 'dsh-soul-scope-b-'))
  const configFile = join(dshHome, 'soul-config.json')

  const drain = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }

  // 装配某个会话的提示词：直接调 section 的 text provider（宿主就是这么调的）。
  const promptFor = (ctx, sessionId) => {
    const section = ctx.state.sections[ctx.state.sections.length - 1]
    if (!section || typeof section.text !== 'function') return null
    const agent = ctx.state.agents.find((a) => a.id === sessionId)
    return section.text({ agent })
  }

  try {
    writeFileSync(configFile, JSON.stringify({
      enabled: true,
      style: 'professional',
      language: 'zh',
      customInstructions: '',
      personas: {
        严格审查: { style: 'roast', customInstructions: '安全优先' },
        极简: { style: 'efficient' }
      },
      workspaces: {
        version: 1,
        scopes: {
          ws_strict: { style: 'roast', customInstructions: '安全优先', __persona: '严格审查' },
          ws_min: { style: 'efficient', __persona: '极简' }
        }
      }
    }, null, 2), 'utf8')

    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    const ctx = makeCtx([
      { id: 'sess-ws', cwd: dirA },
      { id: 'sess-cwd', cwd: dirB },
      { id: 'sess-none' }
    ])
    ctx.state.workspaces = [
      { id: 'ws_strict', title: '项目A', path: dirA, sessionIds: ['sess-ws'] },
      { id: 'ws_min', title: '项目B', path: dirB, sessionIds: [] }
    ]
    ctx.state.storedSessions = ['sess-ws', 'sess-cwd', 'sess-none']

    // 目录绑定：dirB 绑「极简」（验证"索引未命中时回退目录"）
    writeFileSync(join(dshHome, 'soul-bindings.json'), JSON.stringify({
      version: 1,
      bindings: { [dirB]: '极简' }
    }, null, 2), 'utf8')

    await mod.apply(ctx)
    // 首轮索引重建是**延后一拍**的（setTimeout 0），必须排空微任务与宏任务
    await drain()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await drain()

    const pWs = promptFor(ctx, 'sess-ws')
    push(
      'S1 会话属于某工作区时，拿到该工作区的人设（工作区层生效）',
      typeof pWs === 'string' && pWs.includes('安全优先'),
      JSON.stringify({ head: String(pWs).slice(0, 80) })
    )

    const pCwd = promptFor(ctx, 'sess-cwd')
    push(
      'S2 会话不属于任何工作区时，回退按目录绑定解析（cwd 回退层生效）',
      // 判据用**编译后的文案**而不是预设名：提示词里不会出现「极简」这个名字，
      // 它只呈现 style 对应的措辞（efficient → 高效干练）。
      typeof pCwd === 'string' && pCwd.includes('高效干练'),
      JSON.stringify({ head: String(pCwd).slice(0, 80) })
    )
    push(
      'S3 cwd 回退不得串到别的工作区的人设',
      typeof pCwd === 'string' && !pCwd.includes('安全优先'),
      JSON.stringify({ leaked: typeof pCwd === 'string' && pCwd.includes('安全优先') })
    )

    const pNone = promptFor(ctx, 'sess-none')
    push(
      'S4 既无工作区也无目录绑定时，回落全局配置',
      typeof pNone === 'string' && pNone !== '',
      JSON.stringify({ head: String(pNone).slice(0, 80) })
    )

    const saveRes = await callRoute(ctx, '/api/soul/session-scope', {
      sessionId: 'sess-ws',
      overrides: { style: 'humorous' }
    }, 'POST')
    await drain()
    const pSession = promptFor(ctx, 'sess-ws')
    push(
      'S5 会话覆盖盖住工作区层（优先级 Session > Workspace）',
      // ⚠️ 判据必须是 humorous 的**完整措辞**（幽默风趣…），不能用「幽默」这个子串：
      // roast（吐槽达人）的文案里含「犀利幽默」，而工作区层正是 roast ——
      // 用子串判断时，会话层即使完全不生效也会命中（判断力对照实测漏网）。
      saveRes.status === 200 && saveRes.body?.ok === true &&
        typeof pSession === 'string' && pSession.includes('幽默风趣、适当使用比喻和玩笑'),
      JSON.stringify({ status: saveRes.status, head: String(pSession).slice(0, 80) })
    )
    push(
      'S6 会话覆盖是字段级的：工作区层的其它字段不被清掉',
      typeof pSession === 'string' && pSession.includes('安全优先'),
      JSON.stringify({ keeps: typeof pSession === 'string' && pSession.includes('安全优先') })
    )

    // enabled：全局关掉后，任何层都不能把它打开
    writeFileSync(configFile, JSON.stringify({
      enabled: false,
      style: 'professional',
      language: 'zh',
      workspaces: { version: 1, scopes: { ws_strict: { style: 'roast', enabled: true } } }
    }, null, 2), 'utf8')
    const offCtx = makeCtx([{ id: 'sess-ws', cwd: dirA }])
    offCtx.state.workspaces = [{ id: 'ws_strict', title: '项目A', path: dirA, sessionIds: ['sess-ws'] }]
    offCtx.state.storedSessions = ['sess-ws']
    const offMod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    await offMod.apply(offCtx)
    await drain()
    await new Promise((resolve) => setTimeout(resolve, 20))
    await drain()
    const pOff = promptFor(offCtx, 'sess-ws')
    push(
      'S7 全局 enabled=false 时一切作用域都不得注入人设（总开关盖住所有层）',
      pOff === '',
      JSON.stringify({ prompt: String(pOff).slice(0, 60) })
    )

    // —— 回收：persistence 不可用时不得做任何判定 ——
    const sessDir = join(dshHome, 'soul-sessions')
    mkdirSync(sessDir, { recursive: true })
    const sidecarId = 'session-orphan-candidate'
    const digest = createHash('sha256').update(sidecarId, 'utf8').digest('hex').slice(0, 32)
    const sidecarPath = join(sessDir, `${digest}.json`)
    writeFileSync(sidecarPath, JSON.stringify({
      schemaVersion: 1,
      sessionId: sidecarId,
      overrides: { style: 'casual' },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }, null, 2), 'utf8')

    const gcCtx = makeCtx([{ id: 'sess-ws', cwd: dirA }])
    gcCtx.state.workspaces = []
    gcCtx.state.storedSessions = []
    // 模拟 persistence 不可用（桩读 state.persistenceBroken 后抛错）
    gcCtx.state.persistenceBroken = true
    const gcMod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    await gcMod.apply(gcCtx)
    await drain()
    const gcRes = await callRoute(gcCtx, '/api/soul/session-scope/gc', {}, 'POST')
    push(
      'S8 persistence 不可用时，回收报告 scanComplete=false（不做任何判定）',
      gcRes.status === 200 && gcRes.body?.ok === true && gcRes.body?.scanComplete === false,
      JSON.stringify({ status: gcRes.status, scanComplete: gcRes.body?.scanComplete })
    )
    const stillThere = existsSync(sidecarPath)
    push(
      'S9 persistence 不可用时，绝不删除 sidecar（缺证据时保留）',
      stillThere,
      JSON.stringify({ exists: stillThere })
    )
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf8'))
    push(
      'S10 扫描不完整时不得写入孤儿标记（否则一次临时故障会刷满时间戳）',
      doc.orphan === undefined,
      JSON.stringify({ orphan: doc.orphan })
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }

  return results
}
async function bindingRoutesScenario(entry) {
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-soul-e2e-broutes-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = dshHome

  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  const dirProject = mkdtempSync(join(tmpdir(), 'dsh-soul-br-proj-'))
  const dirOther = mkdtempSync(join(tmpdir(), 'dsh-soul-br-other-'))
  const dirThird = mkdtempSync(join(tmpdir(), 'dsh-soul-br-third-'))
  const subDir = join(dirProject, '子模块')
  const bindingsFile = join(dshHome, 'soul-bindings.json')

  const ARCH = '以系统设计视角回答'
  const MINIMAL = '只给结论和必要依据'

  // 刷新是「不 await 的浮动 Promise」（globalUpdatePrompt 里有一次 await loadConfig）。
  // 注入本体在 refreshPromptAndInject 里是同步跑完的，但 section 重注册要过一次
  // 微任务，所以断言前统一排空一次。
  const drain = async (rounds = 8) => {
    for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve))
  }
  const injectedText = (ctx, id) =>
    (ctx.state.injections.get(id) || []).map((m) => m?.content?.[0]?.text || '').join('\n')
  const readBindings = () => JSON.parse(readFileSync(bindingsFile, 'utf8')).bindings

  try {
    mkdirSync(subDir, { recursive: true })
    // 先落一条绑定：拒绝路径要证明「配置没被写坏」，比较基准得真实存在。
    writeFileSync(bindingsFile, JSON.stringify({ version: 1, bindings: { [dirOther]: '极简主义者' } }, null, 2))
    const beforeText = readFileSync(bindingsFile, 'utf8')

    const mod = await import(pathToFileURL(entry).href + `?t=${Date.now()}-${Math.random()}`)
    const ctx = makeCtx([
      { id: 'br-proj', cwd: dirProject },
      { id: 'br-sub', cwd: subDir },
      { id: 'br-other', cwd: dirOther },
      { id: 'br-nocwd' }
    ])
    await mod.apply(ctx)

    // ── 读 ──────────────────────────────────────────────────────────────
    const list = await callRoute(ctx, '/api/soul/bindings', null, 'GET')
    push(
      'R1 GET 返回绑定表与活动会话（sessions 由宿主遍历 agents.list() 得出 —— 设置页槽位拿不到 sessionId）',
      list.status === 200 &&
        list.body?.ok === true &&
        Array.isArray(list.body?.sessions) &&
        list.body.sessions.length === 4 &&
        typeof list.body?.max === 'number' &&
        list.body?.bindings?.[dirOther] === '极简主义者',
      JSON.stringify({ status: list.status, sessions: list.body?.sessions?.length, max: list.body?.max })
    )

    // ── 方法分派：同一路径注册一次，handler 内按 method 走 ──────────────────
    const putList = await callRoute(ctx, '/api/soul/bindings', {}, 'PUT')
    const getDelete = await callRoute(ctx, '/api/soul/bindings/delete', null, 'GET')
    push(
      'R2 两条路由都显式校验方法（PUT 列表 / GET 解绑都回 405，而不是被执行或落到 GET 分支）',
      putList.status === 405 && getDelete.status === 405,
      `列表 PUT=${putList.status} 解绑 GET=${getDelete.status}`
    )

    // ── 准入拒绝：三类理由原样回传，且磁盘一个字节都没动 ────────────────────
    const relative = await callRoute(ctx, '/api/soul/bindings', { dir: '相对/路径', persona: '极简主义者' })
    const unknown = await callRoute(ctx, '/api/soul/bindings', { dir: dirProject, persona: '不存在的人设' })
    push(
      'R3 非绝对路径被拒绝（400），理由可直接展示，且绑定文件未被改动',
      relative.status === 400 &&
        relative.body?.ok === false &&
        (relative.body?.error || '').includes('绝对路径') &&
        readFileSync(bindingsFile, 'utf8') === beforeText,
      JSON.stringify({ status: relative.status, error: relative.body?.error })
    )
    push(
      'R4 写入不存在的人设被拒绝（400）—— 允许写入等于让用户对着一个 typo 等永远不来的生效',
      unknown.status === 400 && (unknown.body?.error || '').includes('不存在的人设'),
      JSON.stringify({ status: unknown.status, error: unknown.body?.error })
    )

    // ── 写入即生效 ──────────────────────────────────────────────────────
    const sectionsBefore = ctx.state.sections.length
    const created = await callRoute(ctx, '/api/soul/bindings', { dir: dirProject, persona: '资深架构师' })
    await drain()
    push(
      'R5 合法绑定写入成功，规范化后的键真的落盘',
      created.status === 200 && readBindings()[dirProject] === '资深架构师',
      JSON.stringify({ status: created.status, 落盘: readBindings() })
    )
    push(
      'R6 写入后 section 被重新注册（绑定不改 soul-config.json，promptChanged 门控看不见它）',
      ctx.state.sections.length > sectionsBefore,
      `${sectionsBefore} → ${ctx.state.sections.length}`
    )
    // ★ 本场景的核心：不重新挂载，活动会话立刻拿到新解析结果。
    //   br-sub 一条绑定都没写，它拿到 ARCH 是因为**父目录绑定被继承** ——
    //   若注入通道没有逐 agent 编译（而是共用一份全局文本），br-sub 拿不到。
    const afterProj = injectedText(ctx, 'br-proj')
    const afterSub = injectedText(ctx, 'br-sub')
    const afterOther = injectedText(ctx, 'br-other')
    push(
      'R7 绑定写完立即对活动会话生效：本目录与子目录都拿到新的人设，子目录靠继承',
      afterProj.includes(ARCH) && afterSub.includes(ARCH) && !afterOther.includes(ARCH),
      JSON.stringify({
        本目录: afterProj.includes(ARCH),
        子目录: afterSub.includes(ARCH),
        其它目录被误伤: afterOther.includes(ARCH)
      })
    )

    // ── 改绑同一目录：覆盖而不是新增 ─────────────────────────────────────
    const rebound = await callRoute(ctx, '/api/soul/bindings', { dir: dirProject, persona: '极简主义者' })
    const tableAfterRebind = readBindings()
    push(
      'R8 同一目录改绑是覆盖：条数不变，人设换新（否则改绑会把表越写越长）',
      rebound.status === 200 &&
        Object.keys(tableAfterRebind).length === 2 &&
        tableAfterRebind[dirProject] === '极简主义者',
      JSON.stringify(tableAfterRebind)
    )

    // ── 解绑：按比较键命中，删空不刷新 ───────────────────────────────────
    // 用「另一种写法」解绑：Windows 上折大小写 + 尾分隔符（两者都指向同一目录）。
    // 拿原串直接 delete 的话这一步会「点了没反应」—— 用户看着列表里那一行，
    // 点下去什么都没发生。
    const altSpelling = process.platform === 'win32' ? `${dirProject}\\`.toUpperCase() : `${dirProject}/`
    const removedOne = await callRoute(ctx, '/api/soul/bindings/delete', { dir: altSpelling })
    push(
      'R9 用另一种写法（大小写 / 尾分隔符）解绑仍能命中，并按比较键删掉原键',
      removedOne.status === 200 &&
        removedOne.body?.removed === true &&
        !Object.prototype.hasOwnProperty.call(readBindings(), dirProject),
      JSON.stringify({ removed: removedOne.body?.removed, 剩余: Object.keys(readBindings()) })
    )

    await drain()
    const injectedBeforeEmpty = ctx.state.injected.length
    const sectionsBeforeEmpty = ctx.state.sections.length
    const removedNone = await callRoute(ctx, '/api/soul/bindings/delete', { dir: dirThird })
    await drain()
    push(
      'R10 解绑一个本来就没绑的目录：如实回 removed=false，且**不触发刷新**（空解绑会向所有会话注入一条假更新）',
      removedNone.status === 200 &&
        removedNone.body?.removed === false &&
        ctx.state.injected.length === injectedBeforeEmpty &&
        ctx.state.sections.length === sectionsBeforeEmpty,
      JSON.stringify({
        注入: `${injectedBeforeEmpty} → ${ctx.state.injected.length}`,
        section: `${sectionsBeforeEmpty} → ${ctx.state.sections.length}`
      })
    )

    // ── 失效引用：如实标注，但不自动删除 ─────────────────────────────────
    await callRoute(ctx, '/api/soul/personas/save', { name: 'R自建' })
    await callRoute(ctx, '/api/soul/bindings', { dir: dirThird, persona: 'R自建' })
    await callRoute(ctx, '/api/soul/personas/delete', { name: 'R自建' })
    const afterDelete = await callRoute(ctx, '/api/soul/bindings', null, 'GET')
    const invalid = afterDelete.body?.invalid || []
    push(
      'R11 绑定指向的人设被删掉后如实列进 invalid，且条目仍在表里（不自动删除 —— 用户可能只是改个名字）',
      invalid.length === 1 &&
        invalid[0].dir === dirThird &&
        invalid[0].persona === 'R自建' &&
        Object.prototype.hasOwnProperty.call(afterDelete.body?.bindings || {}, dirThird),
      JSON.stringify({ invalid, 表: afterDelete.body?.bindings })
    )

    // ── inherited 判别：必须在宿主做 ─────────────────────────────────────
    // 绑定 dirProject，会话 cwd 是它自己 vs 它的子目录：前者「就是本目录」、
    // 后者「继承自上级」。客户端拿原始串比较在 Windows 上会被盘符大小写骗过。
    await callRoute(ctx, '/api/soul/bindings', { dir: dirProject, persona: '资深架构师' })
    const view = await callRoute(ctx, '/api/soul/bindings', null, 'GET')
    const byId = Object.fromEntries((view.body?.sessions || []).map((s) => [s.id, s]))
    push(
      'R12 sessions 如实区分「就是本目录」与「继承自上级」，没有 cwd 的会话显式回报 cwd:null',
      byId['br-proj']?.binding?.inherited === false &&
        byId['br-sub']?.binding?.inherited === true &&
        byId['br-other']?.binding?.persona === '极简主义者' &&
        byId['br-other']?.binding?.inherited === false &&
        byId['br-nocwd']?.cwd === null &&
        byId['br-nocwd']?.binding === null,
      JSON.stringify({
        proj: byId['br-proj']?.binding,
        sub: byId['br-sub']?.binding,
        other: byId['br-other']?.binding,
        nocwd: byId['br-nocwd']?.cwd
      })
    )

    // ★ 生效人设（sessions[].persona）必须与**绑定结果**一致，而不是全局配置那一个。
    //
    // 这是设置页要回答的那个问题：「我这个项目现在到底是谁」。只回报 binding 名是不够的 ——
    // 绑定可能指向一个已删除的人设（那时生效的其实是全局配置），两者必须分别可见。
    // 同理，若这里错用了全局配置算生效人设，带绑定的会话会显示成全局的那个名字，
    // 而会话里注入的却是绑定的人设 —— 界面与事实相反，正是最难查的一类 bug。
    const globalPersona = (await callRoute(ctx, '/api/soul/status', null, 'GET')).body?.persona
    push(
      'R13 sessions 的生效人设跟随绑定解析结果（不是全局那一个），且与状态端点对全局的描述不矛盾',
      byId['br-proj']?.persona === '资深架构师' &&
        byId['br-other']?.persona === '极简主义者' &&
        byId['br-sub']?.persona === '资深架构师' &&
        globalPersona !== '资深架构师',
      JSON.stringify({
        proj: byId['br-proj']?.persona,
        sub: byId['br-sub']?.persona,
        other: byId['br-other']?.persona,
        全局: globalPersona
      })
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
    rmSync(dirProject, { recursive: true, force: true })
    rmSync(dirOther, { recursive: true, force: true })
    rmSync(dirThird, { recursive: true, force: true })
  }

  return results
}

// ==================== 挂载沙箱 ====================
/**
 * 把插件复制到临时目录，并生成静态依赖 `@deepseek-ai/dsh-llm` 的形状兼容桩。
 *
 * 真实宿主由 DSH 自身提供该包（peer），插件包内不含 —— 离线挂载要么指向已装
 * DSH 的 node_modules，要么造桩。造桩更稳：不依赖本机是否装了 DSH，也不会
 * 因宿主版本变化而改变被测行为（注入构造的形状由 E16 单独钉住）。
 *
 * @param pkgDir - 插件包目录（含 index.mjs 与 lib/）
 * @param label - 临时目录后缀，便于排查
 * @returns { dir, entry } —— dir 需由调用方清理
 */
function prepareSandbox(pkgDir, label) {
  const dir = mkdtempSync(join(tmpdir(), `dsh-soul-e2e-${label}-`))
  cpSync(join(pkgDir, 'index.mjs'), join(dir, 'index.mjs'))
  cpSync(join(pkgDir, 'lib'), join(dir, 'lib'), { recursive: true })
  // package.json 也要带上：诊断端点用 createRequire 从包根读版本号（唯一来源）
  cpSync(join(pkgDir, 'package.json'), join(dir, 'package.json'))

  const llmDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-llm')
  mkdirSync(llmDir, { recursive: true })
  writeFileSync(
    join(llmDir, 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-llm', version: '0.0.0', type: 'module', main: 'index.js' }, null, 2)
  )
  writeFileSync(
    join(llmDir, 'index.js'),
    [
      '// 形状兼容桩：真实宿主由 DSH 提供该包，这里只满足插件对 createUserMessage 的使用',
      'export function createUserMessage(input) {',
      '  return { role: "user", content: input && input.content, source: input && input.source }',
      '}'
    ].join('\n')
  )

  return { dir, entry: join(dir, 'index.mjs') }
}

// ==================== 主流程 ====================

async function main() {
  console.log('dsh-soul — 端到端回归：保存配置 → section 与活动会话都拿到新文本')
  console.log('')

  console.log('E 真实 index.mjs + 假宿主')
  const baseSandbox = prepareSandbox(PKG_DIR, 'base')
  let base = []
  try {
    base = await scenario(baseSandbox.entry)
  } finally {
    rmSync(baseSandbox.dir, { recursive: true, force: true })
  }
  for (const r of base) record(r.name, r.ok, r.detail)

  // 配置损坏场景（F1 逃生口 / F2 可观测性）：另起一份沙箱，预置截断的配置文件
  console.log('')
  console.log('F 配置损坏：重置逃生口 + 诊断端点')
  const corruptSandbox = prepareSandbox(PKG_DIR, 'corrupt')
  try {
    for (const r of await corruptConfigScenario(corruptSandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(corruptSandbox.dir, { recursive: true, force: true })
  }

  // 变更记录与撤销（0.8.0）：另起沙箱，因为它的前置状态是「已经攒下一串记录」，
  // 与上面那条从空配置起步的场景互相污染。
  console.log('')
  console.log('G 变更记录：提交即留痕、撤销、恢复预设、清空')
  const historySandbox = prepareSandbox(PKG_DIR, 'history')
  try {
    for (const r of await historyScenario(historySandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(historySandbox.dir, { recursive: true, force: true })
  }

  // 手改配置后撤销必须被拒（409）：需要一次「进程外的改动」，只能靠重新挂载复现
  console.log('')
  console.log('H 撤销的拒绝路径：配置被进程外改动')
  const divergedSandbox = prepareSandbox(PKG_DIR, 'diverged')
  try {
    for (const r of await historyDivergedScenario(divergedSandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(divergedSandbox.dir, { recursive: true, force: true })
  }

  // 工作区绑定（0.8.1-b）：另起沙箱，因为它的前置状态是「绑定表已经在磁盘上」，
  // 而绑定表只在 apply() 读取一次。混进前面那些场景会互相污染。
  console.log('')
  console.log('W 工作区绑定：不同 cwd 的会话各自解析人设')
  const workspaceSandbox = prepareSandbox(PKG_DIR, 'workspace')
  try {
    for (const r of await workspaceBindingScenario(workspaceSandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(workspaceSandbox.dir, { recursive: true, force: true })
  }

  // 身份键（Junction）与读取失败的降级：每种前置状态都要重新挂载一次，
  // 因为绑定表只在 apply() 里读一次。
  console.log('')
  console.log('W2 绑定身份键与降级：Junction 入口 / 真实路径 / 损坏 / 版本不认识')
  const identitySandbox = prepareSandbox(PKG_DIR, 'identity')
  try {
    for (const r of await bindingIdentityScenario(identitySandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(identitySandbox.dir, { recursive: true, force: true })
  }

  // 绑定写路由（0.8.1-c）：另起沙箱，因为它的前置状态是「绑定表里已经有一条」，
  // 且它要观察**写入后活动会话立刻被刷新** —— 与前面那些只读装配的场景互相污染。
  console.log('')
  console.log('R 工作区绑定路由：方法分派、准入拒绝、写入即生效、解绑')
  const bindingRoutesSandbox = prepareSandbox(PKG_DIR, 'broutes')
  try {
    for (const r of await bindingRoutesScenario(bindingRoutesSandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(bindingRoutesSandbox.dir, { recursive: true, force: true })
  }

  // 三级作用域（0.9.0）：另起沙箱 —— 它的前置是「配置里有 workspaces 且会话归入某个工作区」，
  // 与前面那些只验证 cwd 绑定的场景互不干扰。
  console.log('')
  console.log('S 三级作用域：Global → Workspace → Session（真挂载）')
  const scopeSandbox = prepareSandbox(PKG_DIR, 'scope')
  try {
    for (const r of await scopeScenario(scopeSandbox.entry)) record(r.name, r.ok, r.detail)
  } finally {
    rmSync(scopeSandbox.dir, { recursive: true, force: true })
  }

  // 判断力对照：把 provider 读的配置源换成 DEFAULT_CONFIG（模拟「配置改了但读不到」），
  // E4 / E8 必须失败 —— 否则这些断言证明不了「新配置真的到了 provider」。
  const sandbox = mkdtempSync(join(tmpdir(), 'dsh-soul-sabotage-'))
  let sabotage = []
  try {
    const patched = join(sandbox, 'pkg')
    cpSync(PKG_DIR, patched, {
      recursive: true,
      filter: (src) => !src.includes('node_modules') && !src.includes('.git')
    })
    const target = join(patched, 'index.mjs')
    const source = readFileSync(target, 'utf8')
    // marker 取「provider 读的那个配置源」这一表达式本身，而不是它所在的整行语句 ——
    // 后者会随 section 注册处的写法调整而失效（曾经就这样报废过一次对照；
    // 0.8.1-b 把 text 回调改成按 cwd 解析后又失效了一次，这次仍只钉表达式）。
    const marker = 'configCache || DEFAULT_CONFIG'
    if (!source.includes(marker) || source.split(marker).length !== 2) {
      record('E 判断力对照：可在副本中改坏 provider 的配置源', false, '找不到 marker 或 marker 不唯一')
    } else {
      writeFileSync(target, source.replace(marker, 'DEFAULT_CONFIG'))
      const sabotageSandbox = prepareSandbox(patched, 'sabotage')
      try {
        sabotage = await scenario(sabotageSandbox.entry)
      } finally {
        rmSync(sabotageSandbox.dir, { recursive: true, force: true })
      }
      const killed = sabotage.filter((r) => !r.ok).map((r) => r.name)
      record(
        'E 判断力对照：provider 读不到新配置时，E4 / E8 必须失败',
        killed.some((n) => n.startsWith('E4')) && killed.some((n) => n.startsWith('E8')),
        `实际失败项 ${JSON.stringify(killed)}`
      )
      record(
        'E 判断力对照：E1 / E16 等结构断言不受影响',
        sabotage.filter((r) => r.name.startsWith('E1 ') || r.name.startsWith('E16')).every((r) => r.ok),
        '对照跑不应波及结构断言'
      )
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length === 0) {
    if (!assertCount('verify-e2e-prompt', passed, EXPECTED_ASSERTIONS)) process.exit(1)
    console.log(`全部通过：${passed} 项检查`)
    process.exit(0)
  }
  console.log(`失败 ${failures.length} 项：`)
  for (const name of failures) console.log(`  - ${name}`)
  process.exit(1)
}

main().catch((error) => {
  console.error('自检脚本异常：', error)
  process.exit(1)
})
