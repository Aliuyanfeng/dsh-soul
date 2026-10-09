#!/usr/bin/env node
/**
 * scripts/verify-live-prompt.mjs — 宿主实现层等价性回归（0.7.1 移除会话注入的护栏）
 *
 * 为什么需要它：0.7.1 移除了「把最新配置注入所有活动会话」，改为**完全依赖**
 * section 的 `text` provider 在每次装配时重新求值。这条依赖属于**宿主行为**：
 * 一旦宿主改成缓存 section 文本，「改配置 → 下一轮生效」会**静默失效**
 * （不报错，只是配置不再生效 —— 最难排查的一类问题）。
 * 本脚本用**已安装 DSH 的真实实现**把这条依赖钉住，DSH 升级后跑一次即可确认。
 *
 * 三层证据：
 *   A 真实服务 —— 真实 `SystemPrompt` + 真实 Cordis Context：`assemble()` 每次
 *      调用都重新求值函数式 `text`（无缓存、不需要重新注册）；
 *   B 真实投影 —— 原样切片 `dsh-agent-loop` 的 `SystemPromptProjection`：
 *      文本变化才提交新的 system 快照，相等则不提交（不堆消息）；
 *   C 源文本契约 —— `preStep` 每个 step 都调 `assemble`、`assemble` 对函数式
 *      text 不舍缓存。
 * 每层都配**判断力对照**：把关键条件改坏，对应用例必须失败 —— 否则断言没有判断力。
 *
 * 用法：
 *   node scripts/verify-live-prompt.mjs                # 自动定位 DSH
 *   node scripts/verify-live-prompt.mjs --dsh <目录>   # 指定 DSH 安装目录
 * 退出码：0 = 通过（或定位不到 DSH，跳过）；1 = 存在失败项。
 */
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '..')

const argv = process.argv.slice(2)
const argValue = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

// ==================== 定位 DSH ====================

function anchors() {
  const list = [process.cwd(), PKG_DIR, join(PKG_DIR, 'node_modules')]
  const explicit = argValue('--dsh') || process.env.DSH_INSTALL_DIR
  if (explicit) list.unshift(resolve(explicit))
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const profiles = join(dshHome, 'profiles')
  if (existsSync(profiles)) {
    try {
      for (const p of readdirSync(profiles)) list.push(join(profiles, p))
    } catch { /* 忽略 */ }
  }
  return list
}

function resolveFrom(anchor, spec) {
  try {
    return createRequire(join(anchor, 'noop.js')).resolve(spec)
  } catch {
    return null
  }
}

/** 返回宿主子包的解析锚点列表：DSH 自身与其嵌套的 @deepseek-ai 依赖目录。 */
function hostAnchors() {
  const dshPkg = anchors().map((a) => resolveFrom(a, '@deepseek-ai/dsh/package.json')).find(Boolean)
  const list = [...anchors()]
  if (dshPkg) {
    const dshDir = dirname(dshPkg)
    list.unshift(join(dshDir, 'node_modules', '@deepseek-ai', 'dsh'), join(dshDir, 'node_modules'), dshDir)
  }
  return list
}

// ==================== 极简断言台 ====================

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

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)

// ==================== A：真实 SystemPrompt 服务 ====================

/**
 * 用真实宿主的 `SystemPrompt` 跑一遍「section 文本随配置变化」。
 * @param opts.staticText - 判断力对照：把 text 退化为静态字符串（应当让可变性用例失败）
 * @returns 用例结果数组（不直接断言，便于基线 / 对照两种跑法复用）
 */
async function partA(SystemPrompt, renderPrompt, Context, opts = {}) {
  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  const root = new Context()
  const service = new SystemPrompt(root, {
    includeHarnessIdentity: true,
    includeRuntimeContext: true,
    personaPrefix: '',
    personaSuffix: '',
    toolOrder: undefined
  })

  let backing = 'AAA'
  // interpolate: false —— 与 dsh-soul 的注册完全一致（R1）
  const text = opts.staticText ? 'AAA' : () => backing
  service.section({ name: 'soul:persona', order: 0, interpolate: false, text })

  const read = async () => {
    const assembly = await service.assemble({})
    return assembly.sections.find((s) => s.name === 'soul:persona')
  }

  const first = await read()
  push('A1 注册一次即可装配出 section', first?.text === 'AAA', `实际 ${JSON.stringify(first?.text)}`)

  backing = 'BBB'
  const second = await read()
  push(
    'A2 改配置后**再次装配**即读到新文本（无需重新注册 section）',
    second?.text === 'BBB',
    `实际 ${JSON.stringify(second?.text)}`
  )

  backing = 'AAA'
  const third = await read()
  push(
    'A3 改回后读到旧文本，且与上一次装配**不同**（双向可变 ⇒ 宿主未缓存）',
    third?.text === 'AAA' && second?.text !== third?.text,
    `second=${JSON.stringify(second?.text)} third=${JSON.stringify(third?.text)}`
  )

  push('A4 interpolate: false 被原样传递到装配结果', third?.interpolate === false, `实际 ${JSON.stringify(third?.interpolate)}`)

  // R1 的等价断言：关掉插值后 {{...}} 按字面保留，renderPrompt 不抛错
  backing = '模板 {{cwd}} 与 {{ item.name }} 都是字面量'
  const literal = await read()
  let renderOk = true
  let renderErr = ''
  let rendered = ''
  try {
    rendered = renderPrompt(await service.assemble({}))
  } catch (err) {
    renderOk = false
    renderErr = String((err && err.message) || err)
  }
  push('A5 关插值后 {{...}} 按字面渲染，renderPrompt 不抛错', renderOk, renderErr)
  push('A6 新配置确实进入渲染结果', rendered.includes('{{cwd}}'), JSON.stringify(rendered.slice(0, 120)))

  return results
}

// ==================== B：切片 SystemPromptProjection ====================

/** 从宿主源码里原样取出 textOf + SystemPromptProjection。取不到返回 null（跳过，不算失败）。 */
function sliceProjection(source) {
  const textOf = source.match(/function textOf\(message\) \{[\s\S]*?\n\}/)
  const klass = source.match(/var SystemPromptProjection = class \{[\s\S]*?\n\};/)
  if (!textOf || !klass) return null
  return `${textOf[0]}\n${klass[0]}\nreturn SystemPromptProjection`
}

function makeSession(entries) {
  const events = new Map(
    entries.map(([seq, text]) => [
      seq,
      { type: 'system/message', data: { message: { content: text === '' ? [] : [{ type: 'text', text }] } } }
    ])
  )
  return { surface: { nodes: entries.map(([seq]) => seq) }, eventAt: (seq) => events.get(seq) }
}

function partB(build, opts = {}) {
  const results = []
  const push = (name, ok, detail) => results.push({ name, ok, detail })

  // createSystemMessage 与断言无关：只用来承载渲染后的文本
  const compile = (src) =>
    new Function('createSystemMessage', src)((text) => ({
      content: text === '' ? [] : [{ type: 'text', text }]
    }))

  let projection
  try {
    projection = compile(build())
  } catch (err) {
    push('B0 切片可用', false, String((err && err.message) || err))
    return results
  }

  const fresh = new projection(makeSession([]))
  const firstCommits = fresh.project('AAA', { inHistory: true, startsSeries: false })
  push('B1 首次装配提交一条 system 消息（即使文本非空）', firstCommits.length === 1, `实际 ${firstCommits.length}`)

  const session = makeSession([[1, 'AAA']])
  const proj = new projection(session)
  const changed = proj.project('BBB', { inHistory: true, startsSeries: false })
  push('B2 文本变化 → 提交新的 system 快照', changed.length === 1, `实际 ${changed.length}`)
  push(
    'B3 新增快照走 surfaceOp=append（不覆盖历史）',
    changed[0]?.intent?.surfaceOp === 'append',
    JSON.stringify(changed[0]?.intent)
  )

  const same = proj.project('AAA', { inHistory: true, startsSeries: false })
  push(
    'B4 文本未变化 → 不提交（宿主按文本精确比较，不会堆消息）',
    same.length === 0,
    `实际 ${same.length}`
  )

  const cleared = new projection(makeSession([[1, 'AAA'], [2, 'BBB']])).project('', {
    inHistory: true,
    startsSeries: false
  })
  push('B5 提示词清空（配置停用）→ 归一化：清掉后续节点并清空 head', cleared.length === 2, `实际 ${cleared.length}`)

  const notHistory = new projection(makeSession([[1, 'AAA']])).project('AAA', {
    inHistory: false,
    startsSeries: false
  })
  push(
    'B6 不在历史中但文本相同 → 仍不提交（避免无谓重写 head）',
    notHistory.length === 0,
    `实际 ${notHistory.length}`
  )

  return results
}

// ==================== 主流程 ====================

async function main() {
  console.log('dsh-soul — 宿主实现层等价性回归（改配置 → 下一轮生效）')
  console.log('')

  const ha = hostAnchors()
  const spEntry = ha.map((a) => resolveFrom(a, '@deepseek-ai/dsh-system-prompt')).find(Boolean)
  const cordisEntry = ha.map((a) => resolveFrom(a, '@deepseek-ai/cordis')).find(Boolean)
  // 包的 exports "." 即 lib/index.js，直接用解析到的主入口当源码读
  const loopEntry = ha.map((a) => resolveFrom(a, '@deepseek-ai/dsh-agent-loop')).find(Boolean)

  if (!spEntry || !cordisEntry) {
    console.log('跳过：未定位到 DSH 的 @deepseek-ai/dsh-system-prompt / cordis。')
    console.log('可用 --dsh <目录> 指定 DSH 安装目录（含 node_modules/@deepseek-ai/dsh）。')
    process.exit(0)
  }

  console.log(`宿主模块：${spEntry}`)
  console.log('')

  const sp = await import(pathToFileURL(spEntry).href)
  const cordis = await import(pathToFileURL(cordisEntry).href)
  const Context = cordis.Context || cordis.default

  console.log('A 真实 SystemPrompt + 真实 Cordis Context')
  const baseA = await partA(sp.SystemPrompt, sp.renderPrompt, Context)
  for (const r of baseA) record(r.name, r.ok, r.detail)

  // 判断力对照：把函数式 text 退化为静态字符串，可变性用例必须失败
  const sabA = await partA(sp.SystemPrompt, sp.renderPrompt, Context, { staticText: true })
  const sticky = sabA.filter((r) => !r.ok).map((r) => r.name)
  record(
    'A 判断力对照：text 退化为静态字符串后，A2 / A3 必须失败',
    sticky.some((n) => n.startsWith('A2')) && sticky.some((n) => n.startsWith('A3')),
    `实际失败项 ${JSON.stringify(sticky)}`
  )
  record(
    'A 判断力对照：A1 / A4 属结构性事实，不应随之失败',
    sabA.filter((r) => r.name.startsWith('A1') || r.name.startsWith('A4')).every((r) => r.ok),
    '对照跑不该让结构断言失败'
  )

  console.log('')
  console.log('B 切片 SystemPromptProjection（dsh-agent-loop）')
  let baseB = null
  if (!loopEntry) {
    console.log('  – 未定位到 @deepseek-ai/dsh-agent-loop，跳过 B 层')
  } else {
    const loopSource = readFileSync(loopEntry, 'utf8')
    const src = sliceProjection(loopSource)
    if (!src) {
      console.log('  – 未能在宿主源码中定位 SystemPromptProjection（宿主实现已变），跳过 B 层')
    } else {
      baseB = partB(() => src)
      for (const r of baseB) record(r.name, r.ok, r.detail)

      // 判断力对照：删掉「文本相等就不提交」这一句，B4 必须失败
      const broken = src.replace(/if \(latest\.text === rendered\) return \[\];\n/, '')
      const sabB = partB(() => broken)
      const sameness = sabB.find((r) => r.name.startsWith('B4'))
      record(
        'B 判断力对照：删掉「文本相等则不提交」后，B4 必须失败',
        sameness !== undefined && sameness.ok === false,
        `实际 ${JSON.stringify(sameness)}`
      )
      record(
        'B 判断力对照：其余投影用例不受影响（改坏的是比较而非提交路径）',
        sabB.filter((r) => !r.name.startsWith('B4')).every((r) => r.ok),
        '对照跑不应波及无关用例'
      )
    }
  }

  console.log('')
  console.log('C 源文本契约（宿主每条 step 都重新装配）')
  const spSource = readFileSync(spEntry, 'utf8')
  record(
    'C1 assemble 对函数式 text 直接调用、无缓存',
    /typeof section\.text === "function" \? section\.text\(context\) : section\.text/.test(spSource),
    '宿主可能已改为缓存 section 文本 —— 若如此，移除注入后「改配置下一轮生效」将静默失效'
  )
  if (loopEntry) {
    const loopSource = readFileSync(loopEntry, 'utf8')
    const preStep = loopSource.match(/async preStep\(target, position\) \{[\s\S]*?\n\t\}/)
    record('C2 能在宿主源码中定位 preStep', Boolean(preStep))
    record(
      'C3 preStep 每个 step 都调用 systemPrompt.assemble',
      Boolean(preStep) && /systemPrompt\.assemble\(/.test(preStep[0]),
      'preStep 不再装配系统提示词 ⇒ section 不会每步重新求值'
    )
    record(
      'C4 preStep 在组装后调用 renderPrompt / project 链路（文本变化会被提交）',
      Boolean(preStep) && /renderContextSections|renderPrompt/.test(loopSource.slice(loopSource.indexOf(preStep[0]) + preStep[0].length)),
      'preStep 之后未见渲染/投影链路'
    )
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
