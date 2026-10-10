// scripts/verify-trail.mjs — 输入框光轨离线回归（npm run verify:trail）
//
// 为什么需要它：issue #2 的故障（composer 卡片高度无界增长）只在**特定环境**出现——
// 插件往宿主 DOM 写的绝对定位元素被第三方皮肤/主题用更具体的选择器或 `!important`
// 打回常规流，于是尺寸随宿主变化、又反过来撑大宿主，闭合成正反馈环。这种故障
// 在常规环境里复现不出来（样式齐全时同步 60 次全是空操作），所以必须专门构造
// 最坏条件来回归。
//
// 做法：不需要跑 DSH。把 `client/index.mjs` 里那段**纯 DOM 渲染层**原样抽出，
// 注入一个静态页，在无头浏览器里跑一组确定性模型：
//
//   M1 现状（真实代码 + 几何被 !important 破坏）      → 高度必须不变（熔断 + 零高锚点）
//   M2 对照：只屏蔽熔断，其余同 M1                    → 高度必须不变（证明零高锚点单独即够）
//   M3 对照：屏蔽熔断**且**把环挂到卡片本身            → 高度必须显著增长（证明本实验有判断力）
//   M4 正常条件                                       → 空操作，且与宿主边框盒逐像素对齐
//   M5 尺寸熔断（宿主超过 TRAIL_MAX_SIDE）             → 必须停用
//   M6 挂载点解析（示例结构 / composer 结构 / 无锚点）  → 三种落点各自正确
//
// 无头浏览器里 rAF / ResizeObserver 只产生一帧（实测 raf=1 ro=1），所以这里用
// 「重复调用同步函数 + 每次比对 offsetHeight」的确定性驱动，不依赖任何动画帧。
//
// 用法：
//   node scripts/verify-trail.mjs [--chrome <可执行文件>] [--keep]
//   node scripts/verify-trail.mjs --emit <页面.html>     # 只产出页面（分步验证）
//   node scripts/verify-trail.mjs --dump <dumpdom.html>  # 解析已有 dump-dom 输出
//   环境变量 CHROME_PATH 亦可指定浏览器；找不到浏览器时优雅跳过（退出码 0）。
//
// 抽取是「按标记切片 + 断言补丁生效」：一旦 client/index.mjs 的结构变化导致切片
// 或补丁失效，本脚本会直接报错退出（而不是悄悄退化成永不失败的检查）。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertCount, skipExit } from './lib/skip-report.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CLIENT_FILE = path.join(ROOT, 'client', 'index.mjs')
const TRIALS = 60

// 本脚本要跑多少项断言。跳过的提示与 --strict 的判定都依赖它，
// 由 report() 在真正跑完时校验（改了模型列表忘改这里 → 跑得起来的那次会失败）。
const EXPECTED_ASSERTIONS = 11

function parseArgs(argv) {
  const opts = { chrome: null, keep: false, emit: null, dump: null }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--chrome') opts.chrome = argv[++i]
    else if (arg === '--keep') opts.keep = true
    else if (arg === '--emit') opts.emit = argv[++i]
    else if (arg === '--dump') opts.dump = argv[++i]
  }
  return opts
}

function findBrowser(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH)
  if (process.platform === 'win32') {
    candidates.push(
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
      path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
    )
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    )
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 忽略不可读路径 */
    }
  }
  return null
}

function slice(src, startMark, endMark) {
  const i = src.indexOf(startMark)
  if (i < 0) throw new Error(`client/index.mjs 中找不到起点标记：${JSON.stringify(startMark)}`)
  const j = src.indexOf(endMark, i)
  if (j < 0) throw new Error(`client/index.mjs 中找不到终点标记：${JSON.stringify(endMark)}`)
  return src.slice(i, j)
}

// 把内部同步函数暴露到返回值上（纯追加，不改变原有行为）
const SYNC_NEEDLE = '      return {\n        svg,\n        setVisible,'
function exposeSync(code) {
  if (!code.includes(SYNC_NEEDLE)) throw new Error('渲染层返回值结构已变化，请更新本脚本的抽取补丁')
  return code.replace(SYNC_NEEDLE, '      return {\n        svg,\n        setVisible,\n        sync,')
}

// 屏蔽熔断（在 disable 首行插入 return），用于构造「只剩隔离层」的对照模型
const DISABLE_NEEDLE = '      const disable = (reason) => {'
function muteCircuitBreaker(code) {
  if (!code.includes(DISABLE_NEEDLE)) throw new Error('熔断实现已变化，请更新本脚本的抽取补丁')
  return code.replace(DISABLE_NEEDLE, `${DISABLE_NEEDLE}\n        return`)
}

function buildPage(consts, renderer) {
  // 常量块必须与渲染层拼在一起：渲染层里引用 TRAIL_DASH / TRAIL_PAD / TRAIL_MAX_SIDE 等
  const base = `${consts}\n${exposeSync(renderer)}`
  const noBreaker = `${consts}\n${muteCircuitBreaker(exposeSync(renderer))}`
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<style>
/* 破坏性样式表：模拟第三方皮肤/主题用 !important 把环打回常规流。
   author !important 胜过内联普通声明——这正是 issue #2 的真实触发条件。
   用 media 开关，正常条件与最坏条件在同一页面里对照。 */
</style>
<style id="brk" media="not all">.soul-trail-svg{position:static !important;contain:none !important}</style>
</head>
<body style="margin:0">
<pre id="RESULT"></pre>
<script>
var VARIANT_BASE = ${JSON.stringify(base)}
var VARIANT_NO_BREAKER = ${JSON.stringify(noBreaker)}

function loadVariant(code) {
  // new Function 体在全局作用域执行：document / globalThis / ResizeObserver 均可见
  return (new Function(code + '\\n;return { resolveTrailMountPoint: resolveTrailMountPoint, mountTrailRing: mountTrailRing, TRAIL_PAD: TRAIL_PAD, TRAIL_MAX_SIDE: TRAIL_MAX_SIDE };'))()
}

var results = []
function record(name, pass, detail) { results.push({ name: name, pass: !!pass, detail: detail || '' }) }

// 整段模型都包在 try 里：一旦页面脚本抛错，把栈写进结果，而不是留一个空结果让人猜
var V_BASE = null
var V_NO_BREAKER = null
try {
V_BASE = loadVariant(VARIANT_BASE)
V_NO_BREAKER = loadVariant(VARIANT_NO_BREAKER)

// 与 DSH composer 同构的卡片：overlayAnchor 是第一个子元素，高度写死为 0
function makeCard(label, options) {
  options = options || {}
  var card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  card.style.cssText = 'position:relative;display:flex;flex-direction:column;gap:12px;padding-top:8px;border:0;width:600px' +
    (options.height ? ';height:' + options.height + 'px' : '')
  var anchor = document.createElement('div')
  anchor.className = 'uV2eYG_overlayAnchor'
  anchor.style.cssText = 'height:0;position:absolute;inset:0 0 auto'
  var editor = document.createElement('div')
  editor.style.cssText = 'height:120px;background:#eee;font:12px monospace'
  editor.textContent = label
  card.appendChild(anchor)
  card.appendChild(editor)
  document.body.appendChild(card)
  return { card: card, anchor: anchor }
}

// 示例结构（设置页 SoulTrailPreview）：anchor 直接是 host 的子元素
function makePreview(label) {
  var host = document.createElement('div')
  host.className = 'soul-trail-preview'
  host.style.cssText = 'position:relative;margin-top:6px;padding:16px;border:1px solid #bbb;border-radius:22px;width:520px'
  var anchor = document.createElement('div')
  anchor.className = 'soul-trail-anchor'
  var text = document.createElement('span')
  text.textContent = label
  host.appendChild(anchor)
  host.appendChild(text)
  document.body.appendChild(host)
  return { host: host, anchor: anchor }
}

function round2(n) { return Math.round(n * 100) / 100 }
function alignDelta(svg, host) {
  var a = svg.getBoundingClientRect(), b = host.getBoundingClientRect()
  return { left: round2(a.left - b.left), top: round2(a.top - b.top), w: round2(a.width - b.width), h: round2(a.height - b.height) }
}

// ---- M6：挂载点解析（不依赖破坏性样式） ----
var preview = makePreview('设置页示例')
var previewResolved = V_BASE.resolveTrailMountPoint(preview.host, preview.anchor)
record('M6a 示例结构（anchor 是 host 直接子元素）解析为锚点本身',
  previewResolved === preview.anchor,
  'resolve -> ' + (previewResolved === preview.anchor ? '.soul-trail-anchor' : (previewResolved === preview.host ? '宿主本身（错）' : '其他节点')))

var composer = makeCard('composer 结构')
var pluginRoot = document.createElement('div')
composer.anchor.appendChild(pluginRoot)
var composerResolved = V_BASE.resolveTrailMountPoint(composer.card, pluginRoot)
record('M6b composer 结构（overlay 槽位）解析为 .overlayAnchor',
  composerResolved === composer.anchor,
  'resolve -> ' + (composerResolved === composer.anchor ? '.uV2eYG_overlayAnchor' : (composerResolved === composer.card ? '卡片本身（错）' : '其他节点')))

record('M6c 无锚点信息时退回卡片本身',
  V_BASE.resolveTrailMountPoint(composer.card, null) === composer.card, 'resolve(card, null) -> 卡片本身')
record('M6d 锚点不在卡片内时退回卡片本身',
  V_BASE.resolveTrailMountPoint(composer.card, document.body) === composer.card, 'resolve(card, body) -> 卡片本身')

// ---- M4：正常条件（几何完好） ----
var normal = makeCard('M4 正常条件')
var mountedNormal = V_BASE.mountTrailRing(normal.card, V_BASE.resolveTrailMountPoint(normal.card, normal.anchor))
mountedNormal.setVisible(true)
var heightNormal0 = normal.card.offsetHeight
var changed = 0
for (var i = 0; i < ${TRIALS}; i++) if (mountedNormal.sync()) changed++
var delta = alignDelta(mountedNormal.svg, normal.card)
var pad = V_BASE.TRAIL_PAD
record('M4 正常条件：60 次同步全为空操作且高度不变',
  changed === 0 && normal.card.offsetHeight === heightNormal0,
  'sizeChanged=' + changed + '/' + ${TRIALS} + '，高度 ' + heightNormal0 + ' -> ' + normal.card.offsetHeight)
record('M4 正常条件：环外盒 = 宿主边框盒每边外扩 TRAIL_PAD(' + pad + 'px)',
  delta.left === -pad && delta.top === -pad && delta.w === pad * 2 && delta.h === pad * 2,
  'dLeft=' + delta.left + ' dTop=' + delta.top + ' dW=' + delta.w + ' dH=' + delta.h)

// ---- 开启破坏性样式：几何被 !important 打回常规流 ----
document.getElementById('brk').media = 'all'

// M1：现状（真实代码）
var m1 = makeCard('M1 现状 + 破坏几何')
var mounted1 = V_BASE.mountTrailRing(m1.card, V_BASE.resolveTrailMountPoint(m1.card, m1.anchor))
mounted1.setVisible(true)
var h1 = m1.card.offsetHeight
for (var k = 0; k < ${TRIALS}; k++) mounted1.sync()
record('M1 现状：几何被第三方样式表打回常规流后，60 次同步不撑大卡片',
  m1.card.offsetHeight === h1,
  '高度 ' + h1 + ' -> ' + m1.card.offsetHeight + '，环 display=' + (mounted1.svg.style.display || '(空)'))
record('M1 现状：熔断已接管（环被隐藏）',
  mounted1.svg.style.display === 'none',
  'display=' + (mounted1.svg.style.display || '(空)'))

// M2：只屏蔽熔断 —— 零高锚点这一层是否单独够用
var m2 = makeCard('M2 去熔断 + 破坏几何 + 挂锚点')
var mounted2 = V_NO_BREAKER.mountTrailRing(m2.card, V_NO_BREAKER.resolveTrailMountPoint(m2.card, m2.anchor))
mounted2.setVisible(true)
var h2 = m2.card.offsetHeight
for (var k2 = 0; k2 < ${TRIALS}; k2++) mounted2.sync()
var grew2 = m2.card.offsetHeight / h2
record('M2 对照（屏蔽熔断）：零高锚点单独即足以阻断正反馈',
  grew2 < 1.01,
  '高度 ' + h2 + ' -> ' + m2.card.offsetHeight + '（×' + round2(grew2) + '）')

// M3：屏蔽熔断 + 把环挂到卡片本身 —— 证明本实验有判断力
var m3 = makeCard('M3 去熔断 + 破坏几何 + 挂卡片本身')
var mounted3 = V_NO_BREAKER.mountTrailRing(m3.card, m3.card)
mounted3.setVisible(true)
var h3 = m3.card.offsetHeight
for (var k3 = 0; k3 < ${TRIALS}; k3++) mounted3.sync()
var grew3 = m3.card.offsetHeight / h3
record('M3 对照（屏蔽熔断 + 挂卡片）：同样的破坏条件下必须出现正反馈',
  grew3 > 5,
  '高度 ' + h3 + ' -> ' + m3.card.offsetHeight + '（×' + round2(grew3) + '）—— 这就是 issue #2 的成因')

// ---- M5：尺寸熔断（几何完好，仅宿主超限） ----
document.getElementById('brk').media = 'not all'
var m5 = makeCard('M5 尺寸熔断', { height: V_BASE.TRAIL_MAX_SIDE + 5000 })
var mounted5 = V_BASE.mountTrailRing(m5.card, V_BASE.resolveTrailMountPoint(m5.card, m5.anchor))
mounted5.setVisible(true)
mounted5.sync()
record('M5 宿主尺寸超过 TRAIL_MAX_SIDE(' + V_BASE.TRAIL_MAX_SIDE + 'px) 时停用',
  mounted5.svg.style.display === 'none',
  '卡片高度 ' + m5.card.offsetHeight + '，环 display=' + (mounted5.svg.style.display || '(空)'))

} catch (err) {
  record('页面脚本异常（其后的检查未执行）', false, String((err && err.stack) || err).slice(0, 800))
}
document.getElementById('RESULT').textContent = JSON.stringify(results)
</script>
</body></html>`
}

function extract() {
  const src = fs.readFileSync(CLIENT_FILE, 'utf8')
  // 终点必须锚在**代码**上，不能锚在注释文案上：此前用的是「\n\n    // 颜色容错」，
  // 于是仅改写那句注释（零行为变化）就会让本脚本假失败 —— 变异实验实测过。
  const consts = slice(src, '    const TRAIL_DASH = 12', '\n    function safeTrailColor(')
  const renderer = slice(src, '    function createSvgNode(', '\n    var SoulController = class')
  for (const needle of ['TRAIL_PAD', 'TRAIL_MAX_SIDE']) {
    if (!consts.includes(needle)) throw new Error(`常量块缺少 ${needle}，请更新本脚本的切片标记`)
  }
  for (const needle of ['function resolveTrailMountPoint', 'function mountTrailRing', 'function sizeTrailSvg']) {
    if (!renderer.includes(needle)) throw new Error(`渲染层缺少 ${needle}，请更新本脚本的切片标记`)
  }
  return buildPage(consts, renderer)
}

function readDump(file) {
  const raw = fs.readFileSync(file, 'utf8')
  const match = raw.match(/<pre id="RESULT"[^>]*>([\s\S]*?)<\/pre>/)
  if (!match) throw new Error('未在 dump 输出中找到结果节点（页面脚本可能抛错，或文件不是本脚本产出的页面）')
  const text = match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  let checks
  try {
    checks = JSON.parse(text)
  } catch {
    throw new Error(`结果不是合法 JSON：${text.slice(0, 300)}`)
  }
  return checks
}

function report(checks) {
  let failed = 0
  for (const check of checks) {
    if (!check.pass) failed++
    console.log(`  ${check.pass ? '✓' : '✗'} ${check.name}`)
    if (check.detail) console.log(`      ${check.detail}`)
  }
  console.log('')
  if (!assertCount('verify-trail', checks.length, EXPECTED_ASSERTIONS)) process.exit(1)
  if (failed === 0) {
    console.log(`结果：通过（${checks.length} 项）。`)
    process.exit(0)
  }
  console.log(`结果：失败（${failed}/${checks.length} 项）。`)
  console.log('说明：M1/M2 失败代表隔离层失效；M3 失败代表本实验失去判断力（对照没复现出正反馈），需检查脚本与客户端代码是否仍同源。')
  process.exit(1)
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const page = extract()

  if (opts.emit) {
    fs.writeFileSync(opts.emit, page, 'utf8')
    console.log(`已生成回归页面：${opts.emit}`)
    console.log('用无头浏览器 dump-dom 取出页面后，以 `--dump <文件>` 交回本脚本判定。')
    process.exit(0)
  }

  console.log('输入框光轨离线回归（无头浏览器 + 插件真实渲染层）')
  console.log(`  取样数：每次同步 ${TRIALS} 轮`)

  if (opts.dump) {
    console.log(`  来源：${opts.dump}（--dump，未启动浏览器）`)
    console.log('')
    report(readDump(opts.dump))
    return
  }

  const browser = findBrowser(opts.chrome)
  if (!browser) {
    skipExit(
      'verify-trail（输入框光轨回归）',
      EXPECTED_ASSERTIONS,
      '未找到 Chrome / Edge',
      '--chrome <路径> 或 CHROME_PATH 指定浏览器；或两段式：--emit <页面> → 手动 dump-dom → --dump <文件>'
    )
  }
  console.log(`  浏览器：${browser}`)
  console.log('')

  const htmlPath = path.join(os.tmpdir(), `dsh-soul-verify-trail-${process.pid}.html`)
  fs.writeFileSync(htmlPath, page, 'utf8')
  // 独立 user-data-dir：避免与用户正在运行的 Chrome/Edge 抢同一个 profile
  const profileDir = path.join(os.tmpdir(), `dsh-soul-verify-trail-profile-${process.pid}`)

  let stdout = ''
  let skip = null
  try {
    const run = spawnSync(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
      '--no-first-run', '--no-default-browser-check', '--disable-extensions',
      `--user-data-dir=${profileDir}`,
      '--window-size=900,1400', '--virtual-time-budget=8000',
      '--allow-file-access-from-files', '--dump-dom',
      `file:///${htmlPath.replace(/\\/g, '/')}`
    ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    // 受限环境（沙箱 / 安全软件 / 已有实例抢占 profile）可能根本起不来浏览器：
    // 这种情况跳过而不是判失败——本脚本是回归增强，不是发布门禁
    if (run.error) skip = `无法启动浏览器（${run.error.code || run.error.message}）`
    else if (run.status !== 0 && !run.stdout) skip = `浏览器退出码 ${run.status}`
    else stdout = run.stdout || ''
  } finally {
    if (opts.keep) {
      console.log(`  （保留页面：${htmlPath}）`)
      console.log(`  （保留 profile：${profileDir}）`)
    } else {
      fs.rmSync(htmlPath, { force: true })
      try {
        fs.rmSync(profileDir, { recursive: true, force: true })
      } catch {
        /* 浏览器子进程可能仍持有句柄，忽略 */
      }
    }
  }

  if (skip) {
    skipExit(
      'verify-trail（输入框光轨回归）',
      EXPECTED_ASSERTIONS,
      skip,
      '两段式：--emit <页面> 产出页面 → 手动 dump-dom → --dump <文件> 交回本脚本判定'
    )
  }

  const match = stdout.match(/<pre id="RESULT"[^>]*>([\s\S]*?)<\/pre>/)
  if (!match) throw new Error('未从浏览器输出中取到结果（页面脚本可能抛错）')
  const text = match[1]
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  let checks
  try {
    checks = JSON.parse(text)
  } catch {
    throw new Error(`结果不是合法 JSON：${text.slice(0, 300)}`)
  }
  report(checks)
}

const invokedDirectly = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error('回归脚本异常：', error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
