#!/usr/bin/env node
/**
 * 校验本插件的 peerDependencies 是否与当前 DSH 运行时兼容。
 *
 * DSH 装载插件前会做同一件事（见 @deepseek-ai/dsh-app-boot 的 evaluatePluginCompatibility）：
 *
 *   1. 只校验 peerDependencies 里名字等于 `@deepseek-ai/dsh` 或以 `@deepseek-ai/dsh-` 开头的条目；
 *      其余（例如 `@deepseek-ai/cordis`）不参与判定。
 *   2. 被比较的一方是 **DSH 运行时版本**（取自 `@deepseek-ai/dsh-app-boot/package.json` 的 version），
 *      而不是插件真正 import 到的那个包的版本。
 *   3. 用 `semver.satisfies(runtimeVersion, range, { includePrerelease: true })` 判定。
 *      `includePrerelease` 带来两个后果：
 *        - `^0.1.1-rc.2` 的隐含上界是 `<0.2.0-0`，因此**挡不住** 0.2.x 线；
 *        - range 必须显式覆盖对方的 [major,minor,patch]，否则同线上的 prerelease 也不匹配。
 *
 * 不通过时 DSH 会拒绝装载，并在插件管理器里给出
 * 「{插件} 与 DSH {版本} 不兼容（要求 {peer}）」。因此 DSH 升级后应重跑本脚本。
 *
 * 除 peer 范围外，本脚本还验证**注入来源契约**：DSH 0.1.7（会话格式 v4）起拒绝共享的
 * `kind: 'plugin'`，要求生产者自持 kind——未适配时 agent.inject() 会让每一轮失败
 * （issue #1）。判定直接用已安装 DSH 的准入校验器，并先证明它对废弃形态确有判断力。
 *
 * 用法：
 *   node scripts/verify-compat.mjs                   # 自动定位 DSH
 *   node scripts/verify-compat.mjs --dsh <目录>      # 指定 DSH 安装目录（含 @deepseek-ai 或 @deepseek-ai/dsh）
 *   node scripts/verify-compat.mjs --runtime <版本>  # 直接指定运行时版本，跳过定位
 *
 * 退出码：0 = 兼容，或无法定位运行时（跳过）；1 = 存在不兼容的 peer 或来源契约不满足。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { createInjectionSource } from '../lib/injection.mjs'
import { skipExit } from './lib/skip-report.mjs'

// 定位到 DSH 时本脚本会跑出的检查数（peer 范围判定 + 运行时符号抽查 + 注入来源契约）。
// 各环境解析到的子包数量可能略有出入，因此这里只用于「跳过时如实说明少跑了多少」，
// 不做严格相等校验。
const NOMINAL_ASSERTIONS = 10

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = resolve(HERE, '..')
const MANIFEST = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8'))
const APP_BOOT = '@deepseek-ai/dsh-app-boot'

// ==================== 最小 semver 实现（仅在借不到宿主 semver 时使用）====================

function parseVersion(input) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(input).trim())
  if (!m) return null
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] }
}

function comparePre(a, b) {
  if (a.length === 0 || b.length === 0) return a.length === b.length ? 0 : a.length === 0 ? 1 : -1
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    } else if (xn !== yn) {
      return xn ? -1 : 1
    } else if (x !== y) {
      return x < y ? -1 : 1
    }
  }
  return 0
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return NaN
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1
  return comparePre(pa.pre, pb.pre)
}

/** 计算 ^ 与 ~ 的隐式上界，规则与 node-semver 一致（目标带 prerelease 时上界加 `-0`）。 */
function upperBound(op, t) {
  let cap
  if (op === '^') {
    if (t.nums[0] !== 0) cap = [t.nums[0] + 1, 0, 0]
    else if (t.nums[1] !== 0) cap = [0, t.nums[1] + 1, 0]
    else cap = [0, 0, t.nums[2] + 1]
  } else {
    if (t.nums[0] !== 0) cap = [t.nums[0], t.nums[1] + 1, 0]
    else cap = [0, t.nums[1] + 1, 0]
  }
  return `${cap[0]}.${cap[1]}.${cap[2]}${t.pre.length > 0 ? '-0' : ''}`
}

function testComparator(version, comparator) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(comparator.trim())
  if (!m) return false
  const op = m[1] || '='
  const raw = m[2]
  if (!parseVersion(raw) || !parseVersion(version)) return false
  const c = compareVersions(version, raw)
  switch (op) {
    case '>=': return c >= 0
    case '<=': return c <= 0
    case '>': return c > 0
    case '<': return c < 0
    case '=': return c === 0
    case '^':
    case '~': return c >= 0 && compareVersions(version, upperBound(op, parseVersion(raw))) < 0
    default: return false
  }
}

/** 等价于 semver.satisfies(v, r, { includePrerelease: true })，仅覆盖本项目用到的语法。 */
export function satisfiesFallback(version, range) {
  return String(range)
    .split('||')
    .some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => testComparator(version, c)))
}

// ==================== 定位 DSH 运行时 ====================

const argv = process.argv.slice(2)
const argValue = (flag) => {
  const i = argv.indexOf(flag)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined
}

function anchors() {
  const list = [process.cwd(), PKG_DIR, join(PKG_DIR, 'node_modules')]
  const explicit = argValue('--dsh') || process.env.DSH_INSTALL_DIR || process.env.DSH_APP_BOOT_DIR
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

async function loadModule(anchorsList, spec) {
  for (const anchor of anchorsList) {
    try {
      const req = createRequire(join(anchor, 'noop.js'))
      const resolved = req.resolve(spec)
      const mod = await import(pathToFileURL(resolved).href)
      return { mod, resolved }
    } catch { /* 换下一个 */ }
  }
  return null
}

function locateAppBoot() {
  const explicit = argValue('--dsh') || process.env.DSH_INSTALL_DIR || process.env.DSH_APP_BOOT_DIR
  if (explicit) {
    const base = resolve(explicit)
    for (const p of [join(base, 'node_modules', APP_BOOT), join(base, APP_BOOT), base]) {
      const pj = join(p, 'package.json')
      if (!existsSync(pj)) continue
      try {
        if (JSON.parse(readFileSync(pj, 'utf8')).name === APP_BOOT) return p
      } catch { /* 继续 */ }
    }
  }
  for (const anchor of anchors()) {
    try {
      const req = createRequire(join(anchor, 'noop.js'))
      return dirname(req.resolve(`${APP_BOOT}/package.json`))
    } catch { /* 换下一个 */ }
  }
  return null
}

const isCheckedPeer = (name) => name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')

// ==================== 主流程 ====================

async function main() {
  console.log(`dsh-soul v${MANIFEST.version} — DSH 兼容性自检`)
  console.log('')

  const peers = MANIFEST.peerDependencies || {}
  console.log('peerDependencies')
  for (const [name, range] of Object.entries(peers)) {
    console.log(`  ${isCheckedPeer(name) ? '· 校验' : '· 忽略'}  ${name.padEnd(30)} ${range}`)
  }
  console.log('')

  const appBootDir = locateAppBoot()
  const searchAnchors = []
  if (appBootDir) searchAnchors.push(appBootDir, join(appBootDir, '..'), join(appBootDir, '..', '..'), join(appBootDir, '..', '..', '..'))
  searchAnchors.push(...anchors())

  let runtimeVersion = argValue('--runtime') || null
  let evalFn = null
  if (appBootDir) {
    const boot = await loadModule([appBootDir], APP_BOOT)
    if (boot) {
      const mod = boot.mod
      // 仅在未显式指定 --runtime 时采用宿主自报的版本（否则会把用户指定的版本覆盖掉）
      if (runtimeVersion === null && typeof mod.getDshRuntimeVersion === 'function') {
        try { runtimeVersion = mod.getDshRuntimeVersion() } catch { /* 回退到文件读取 */ }
      }
      if (typeof mod.evaluatePluginCompatibility === 'function') evalFn = mod.evaluatePluginCompatibility
    }
    if (!runtimeVersion) {
      try {
        runtimeVersion = JSON.parse(readFileSync(join(appBootDir, 'package.json'), 'utf8')).version
      } catch { /* 保持 null */ }
    }
  }

  if (!runtimeVersion) {
    skipExit(
      'verify-compat（兼容性判定）',
      NOMINAL_ASSERTIONS,
      '未能定位 DSH 运行时',
      '--dsh <目录> 指定 DSH 安装目录，或用 --runtime <版本> 直接给出运行时版本'
    )
  }

  console.log(`DSH 运行时版本：${runtimeVersion}`)
  console.log(`定位来源：${appBootDir || '（--runtime 指定）'}`)
  console.log('')

  // semver 优先借宿主的；借不到用内置最小实现
  let satisfies = null
  const sem = await loadModule(searchAnchors, 'semver')
  if (sem) {
    const m = sem.mod.satisfies ? sem.mod : sem.mod.default
    if (typeof m?.satisfies === 'function') satisfies = (v, r) => m.satisfies(v, r, { includePrerelease: true })
  }
  const mode = evalFn ? 'DSH 原生 evaluatePluginCompatibility' : satisfies ? '宿主 semver' : '内置最小实现'

  console.log('判定')
  const failures = []
  for (const [name, range] of Object.entries(peers)) {
    if (!isCheckedPeer(name)) {
      console.log(`  – 忽略   ${name.padEnd(30)} ${range}   （DSH 不校验此类 peer）`)
      continue
    }
    let ok
    if (evalFn) {
      const issue = evalFn({ name: MANIFEST.name, version: MANIFEST.version, peerDependencies: { [name]: range } }, {}, runtimeVersion)
      ok = issue === undefined
    } else {
      ok = satisfies ? satisfies(runtimeVersion, range) : satisfiesFallback(runtimeVersion, range)
    }
    console.log(`  ${ok ? '✓ 通过' : '✗ 不通过'} ${name.padEnd(30)} ${range}`)
    if (!ok) failures.push([name, range])
  }
  console.log(`  （判定方式：${mode}）`)

  console.log('')
  console.log('运行时符号抽查（DSH 不做这层校验，仅作预警）')
  let symbolMissing = 0
  const audits = [
    ['@deepseek-ai/dsh-llm', ['createUserMessage']],
    ['@deepseek-ai/dsh-tools', ['defineTool', 'TOOL_RUNTIME_SCHEDULER']]
  ]
  for (const [spec, symbols] of audits) {
    const hit = await loadModule(searchAnchors, spec)
    if (!hit) { console.log(`  – ${spec}：未解析到，跳过`); continue }
    const missing = symbols.filter((s) => !(s in hit.mod))
    if (missing.length) symbolMissing += missing.length
    console.log(`  ${missing.length ? '✗' : '✓'} ${spec}：${missing.length ? '缺少 ' + missing.join(', ') : '符号齐备'}`)
  }
  for (const spec of MANIFEST.dsh?.client?.inject || []) {
    const hit = await loadModule(searchAnchors, spec)
    console.log(`  ${hit ? '✓' : '–'} ${spec}：${hit ? '已解析' : '未解析到，跳过'}`)
  }

  // ---- 注入来源契约 ----
  // 用生产代码同一个构造函数取来源，再交给已安装 DSH 的准入校验器判定；
  // 判定前先确认校验器确实会拒绝已废弃形态，否则本次判定没有判断力。
  console.log('')
  console.log('注入来源契约（会话格式 v4）')
  const source = createInjectionSource('dsh-soul self-check snapshot')

  let contractFailures = 0
  const shapeIssues = []
  if (typeof source.kind !== 'string' || source.kind.length === 0) shapeIssues.push('kind 必须为非空字符串')
  else if (source.kind === 'plugin') shapeIssues.push("kind 不得为已废弃的 'plugin'")
  if ('plugin' in source) shapeIssues.push('source 不应再携带 plugin 字段（v4 迁移会丢弃它）')
  if (source.form !== 'snapshot') shapeIssues.push("form 必须为 'snapshot'")
  if (!Array.isArray(source.sections) || source.sections.length === 0) shapeIssues.push('snapshot 必须携带非空 sections')
  for (const [index, section] of (Array.isArray(source.sections) ? source.sections : []).entries()) {
    if (typeof section?.name !== 'string' || section.name === '' || typeof section?.text !== 'string') {
      shapeIssues.push(`sections[${index}] 需要非空 name 与字符串 text`)
    }
  }
  for (const issue of shapeIssues) console.log(`  ✗ 形状：${issue}`)
  contractFailures += shapeIssues.length
  if (shapeIssues.length === 0) {
    console.log(`  ✓ 形状：kind=${source.kind} / form=${source.form} / sections=${source.sections.length}`)
  }

  const FORMAT_PKG = '@deepseek-ai/dsh-session-format-v3-to-v4'
  const formatHit = await loadModule(searchAnchors, FORMAT_PKG)
  const admit = formatHit && typeof formatHit.mod.assertV4RowAdmission === 'function'
    ? formatHit.mod.assertV4RowAdmission
    : null

  // 先用本机 dsh-llm 真实构造注入消息（而不是只测形状字面量），让判定贴近生产路径
  const llmHit = await loadModule(searchAnchors, '@deepseek-ai/dsh-llm')
  let realMessage = null
  if (llmHit && typeof llmHit.mod.createUserMessage === 'function') {
    try {
      realMessage = llmHit.mod.createUserMessage({
        content: [{ type: 'text', text: 'dsh-soul self-check' }],
        source
      })
      console.log('  ✓ 构造：已用本机 dsh-llm 的 createUserMessage 生成真实注入消息')
    } catch (err) {
      contractFailures += 1
      console.log(`  ✗ 构造：createUserMessage 拒绝了当前 source：${String((err && err.message) || err)}`)
    }
  } else {
    console.log('  – 构造：本机未解析到 @deepseek-ai/dsh-llm，改用形状字面量判定')
  }

  if (admit === null) {
    console.log(`  – ${FORMAT_PKG}：准入校验器不可用，跳过运行时判定（仅检查形状）`)
  } else {
    // 有真实消息就用它，否则退回形状字面量
    const currentRow = realMessage === null
      ? { type: 'user/message', data: { source } }
      : { type: 'user/message', data: realMessage }
    const retired = { kind: 'plugin', plugin: 'dsh-soul', form: 'snapshot', sections: source.sections }
    let guardLive = false
    try {
      admit({ type: 'user/message', data: { source: retired } }, new Set(['user/message']))
    } catch {
      guardLive = true
    }
    if (!guardLive) {
      console.log('  – 校验器未拒绝已废弃形态，本次判定不可信，跳过运行时判定')
    } else {
      console.log("  ✓ 校验器有效：已废弃的 kind:'plugin' 确实被拒绝（issue #1 的复现条件）")
      try {
        admit(currentRow, new Set(['user/message']))
        console.log(`  ✓ 通过   ${source.kind}：当前注入来源可被本运行时接纳`)
      } catch (err) {
        contractFailures += 1
        console.log(`  ✗ 不通过 ${source.kind}：${String((err && err.message) || err)}`)
      }
    }
  }

  console.log('')
  if (failures.length === 0 && contractFailures === 0) {
    console.log('结果：兼容。')
    if (symbolMissing > 0) console.log(`注意：仍有 ${symbolMissing} 个运行时符号缺失，需同步适配代码。`)
    process.exit(0)
  }
  console.log('结果：不兼容')
  for (const [name, range] of failures) console.log(`  peer 范围未覆盖 ${runtimeVersion}：${name} ${range}`)
  if (contractFailures > 0) console.log(`  注入来源契约不满足：${contractFailures} 项（见上方 ✗ 行）`)
  console.log('')
  console.log('处理方式：')
  console.log('  1. 修正代码或 peer 声明使其满足上面的约束，然后升版本重新发布；')
  console.log('  2. 或让用户升级插件到已适配该 DSH 版本的版本。')
  if (symbolMissing > 0) console.log(`  另：抽查到 ${symbolMissing} 个运行时符号缺失，说明不只是声明过期，代码也需适配。`)
  process.exit(1)
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href

if (invokedDirectly) {
  main().catch((error) => {
    console.error('自检脚本异常：', error)
    process.exit(1)
  })
}
