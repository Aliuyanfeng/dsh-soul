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
 * 说明：0.7.1 起本插件**不再向会话注入任何内容** —— 个性化配置只走 system prompt
 * section（宿主每个 step 重新求值 provider，文本变化时自行提交新的 system 快照，
 * 见 index.mjs 的 refreshPrompt 与 DEBUGGING.md「配置生效链路」）。因此原先这里对
 * 会话格式 v4 的「注入来源契约」校验（issue #1）已随注入代码一并退役。
 *
 * 用法：
 *   node scripts/verify-compat.mjs                   # 自动定位 DSH
 *   node scripts/verify-compat.mjs --dsh <目录>      # 指定 DSH 安装目录（含 @deepseek-ai 或 @deepseek-ai/dsh）
 *   node scripts/verify-compat.mjs --runtime <版本>  # 直接指定运行时版本，跳过定位
 *
 * 退出码：0 = 兼容，或无法定位运行时（跳过）；1 = 存在不兼容的 peer。
 */
import { createRequire } from 'node:module'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

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
    console.log('跳过：未能定位 DSH 运行时。')
    console.log('可用 --dsh <目录> 指定 DSH 安装目录，或用 --runtime <版本> 直接给出运行时版本。')
    process.exit(0)
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
  // 只审计插件真正用到的宿主符号：0.7.1 起不再 import dsh-llm（注入已移除），
  // 只剩 tools 注册处这一个动态 import。
  const audits = [
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

  console.log('')
  if (failures.length === 0) {
    console.log('结果：兼容。')
    if (symbolMissing > 0) console.log(`注意：仍有 ${symbolMissing} 个运行时符号缺失，需同步适配代码。`)
    process.exit(0)
  }
  console.log('结果：不兼容')
  for (const [name, range] of failures) console.log(`  peer 范围未覆盖 ${runtimeVersion}：${name} ${range}`)
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
