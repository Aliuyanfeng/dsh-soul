#!/usr/bin/env node
/**
 * scripts/verify-e2e-prompt.mjs — 插件侧端到端回归：保存配置 → section 立即读到新文本
 *
 * 用**真实的 index.mjs**（不是抽取片段）+ 假 ctx 在纯 Node 里跑通整条链路：
 *
 *   POST /api/soul/config → 写队列 → 原子落盘 → configCache → section 的 text provider
 *
 * 它补上 verify-live-prompt.mjs 的另一半：那边证明「宿主每个 step 都会重新求值
 * provider」，这边证明「插件保存后 provider 确实返回新文本」。两端合起来才是
 * 「改配置 → 下一轮生效」的完整证据链（0.7.1 移除会话注入后完全依赖这条链）。
 *
 * 0.7.1 起 index.mjs **没有任何静态外部依赖**（只剩 tools 注册处一个动态 import），
 * 因此可以这样直接挂载 —— 本脚本同时把这一点当契约断言（import 失败即失败）。
 *
 * 用法：node scripts/verify-e2e-prompt.mjs
 * 退出码：0 = 通过；1 = 存在失败项。
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

/** 记录一切被访问的服务名，用于断言插件「从不索要 agents 服务」（O1）。 */
function makeCtx() {
  const state = {
    sections: [],       // 每次 systemPrompt.section() 的注册
    disposals: 0,
    routes: new Map(),  // path -> handler
    services: [],       // ctx.get / ctx.inject 索要过的服务名
    providers: []       // 已注册的服务（ctx.provide）
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
async function callRoute(ctx, path, body) {
  const handler = ctx.state.routes.get(path)
  if (!handler) throw new Error(`未注册路由 ${path}`)
  const payload = Buffer.from(JSON.stringify(body ?? {}))
  const req = {
    method: 'POST',
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

    // 纯外观字段不得触发提示词刷新
    const sectionCountBefore = ctx.state.sections.length
    await callRoute(ctx, '/api/soul/config', { trailColor: '#123456' })
    push(
      'E10 纯外观字段（光轨颜色）保存后不重新注册 section（promptChanged 门控）',
      ctx.state.sections.length === sectionCountBefore,
      `${sectionCountBefore} → ${ctx.state.sections.length}`
    )

    // 校验失败不得改动生效提示词
    const bad = await callRoute(ctx, '/api/soul/config', { style: '不存在的风格' })
    push('E11 非法枚举被拒绝（400）', bad.status === 400, JSON.stringify(bad.body))
    push('E12 被拒绝的保存不影响生效提示词', currentPrompt(ctx) === after2, '生效文本发生了变化')

    // O1 的核心契约：插件不再需要 agents 服务（也就无从注入会话）
    const askedAgents = ctx.state.services.filter((s) => s.endsWith(':agents'))
    push('E13 全程未索要 agents 服务（注入通道已彻底移除）', askedAgents.length === 0, JSON.stringify(askedAgents))

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
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(dshHome, { recursive: true, force: true })
  }

  return results
}

// ==================== 主流程 ====================

async function main() {
  console.log('dsh-soul — 端到端回归：保存配置 → section 立即生效')
  console.log('')

  console.log('E 真实 index.mjs + 假宿主')
  const base = await scenario(join(PKG_DIR, 'index.mjs'))
  for (const r of base) record(r.name, r.ok, r.detail)

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
    const marker = 'const prompt = compilePrompt(configCache || DEFAULT_CONFIG)'
    if (!source.includes(marker)) {
      record('E 判断力对照：可在副本中改坏 provider 的配置源', false, '找不到 marker')
    } else {
      const broken = source.replace(marker, 'const prompt = compilePrompt(DEFAULT_CONFIG)')
      const { writeFileSync } = await import('node:fs')
      writeFileSync(target, broken)
      sabotage = await scenario(target)
      const killed = sabotage.filter((r) => !r.ok).map((r) => r.name)
      record(
        'E 判断力对照：provider 读不到新配置时，E4 / E8 必须失败',
        killed.some((n) => n.startsWith('E4')) && killed.some((n) => n.startsWith('E8')),
        `实际失败项 ${JSON.stringify(killed)}`
      )
      record(
        'E 判断力对照：E1 / E13 等结构断言不受影响',
        sabotage.filter((r) => r.name.startsWith('E1 ') || r.name.startsWith('E13')).every((r) => r.ok),
        '对照跑不应波及结构断言'
      )
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true })
  }

  console.log('')
  if (failures.length === 0) {
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
