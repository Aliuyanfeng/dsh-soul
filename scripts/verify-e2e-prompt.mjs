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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertCount } from './lib/skip-report.mjs'
// 内置人设的期望值直接取代码里的同一份数据（它的数据契约另有 verify-config 钉住），
// 免得 e2e 里再抄一份「极简主义者 = efficient / less」这类会悄悄漂移的常量。
// 「关于你」的字段名单同理取自配置层唯一来源（PROFILE_FIELDS）。
import { BUILTIN_PERSONAS } from '../lib/personas.mjs'
import { PROFILE_FIELDS } from '../lib/config.mjs'

// 基线运行应跑出的断言数：E 场景 24 项 + F 损坏场景 8 项 + 2 项判断力对照。
// 跑完时校验，防止「脚本加/删用例」与文档口径悄悄脱节。
const EXPECTED_ASSERTIONS = 34

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
function makeCtx() {
  const state = {
    sections: [],       // 每次 systemPrompt.section() 的注册
    disposals: 0,
    routes: new Map(),  // path -> handler
    services: [],       // ctx.get / ctx.inject 索要过的服务名
    providers: [],      // 已注册的服务（ctx.provide）
    injected: []        // 每个活动 agent 收到的注入消息
  }

  // 活动 agent 桩：宿主通过 agents.list() 暴露，注入走 agent.inject()
  const agents = {
    list() {
      return [{ id: 'fake-agent', inject(message) { state.injected.push(message) } }]
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
    register({ path, handler }) {
      state.routes.set(path, handler)
    }
  }

  const host = {
    systemPrompt,
    webServer,
    agents,
    logger: { info() {}, warn() {}, error() {} }
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
async function callRoute(ctx, path, body, method = 'POST') {
  const handler = ctx.state.routes.get(path)
  if (!handler) throw new Error(`未注册路由 ${path}`)
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    method,
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

/** 当前生效的 section 文本：始终读**最后一次**注册的 provider（模拟宿主每步求值）。 */
function currentPrompt(ctx) {
  const last = ctx.state.sections[ctx.state.sections.length - 1]
  if (!last) return '<未注册>'
  return last.text()
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
    writeFileSync(
      join(dshHome, 'soul-config.json'),
      JSON.stringify({ personas: { [LEGACY_NAME]: LEGACY_PERSONA } }, null, 2)
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
    // 后者会随 section 注册处的写法调整而失效（曾经就这样报废过一次对照）。
    const marker = 'compilePrompt(configCache || DEFAULT_CONFIG)'
    if (!source.includes(marker)) {
      record('E 判断力对照：可在副本中改坏 provider 的配置源', false, '找不到 marker')
    } else {
      writeFileSync(target, source.replace(marker, 'compilePrompt(DEFAULT_CONFIG)'))
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
