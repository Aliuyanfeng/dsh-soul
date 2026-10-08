// scripts/verify-nav-icon.mjs — 设置导航图标离线回归（npm run verify:nav-icon）
//
// 背景：设置面板导航项的图标由壳层 ui-settings-general 的 navIcon(id) 硬编码决定
// ——只认 account / models / agent-presets / plugins / archived-sessions，其余 id
// **一律回退成设置齿轮**，且 settings.section 的选项只有 id / order / label，插件
// 无法声明自己的图标。dsh-soul 因此在客户端做 DOM 替换，把齿轮改画成与插件图标
// （assets/icon.svg）同一套几何的「灵魂火花 + 光轨」。
//
// 与插件图标**有意不同**的两点，也正是本回归要守住的地方：
//   1) 单色：插件图标是彩色渐变，导航栏里的一排图标却全是 currentColor 线描。
//      导航图标跟随邻居用 currentColor（不得出现 defs / 渐变 / 写死色值）。
//   2) 线宽：宿主机图标是 16 网格 + 1.3 线宽；我们的窗口是 28.4 单位显示成 16px，
//      因此取 2.3（显示后 ≈ 1.3px）。照搬 icon.svg 的 2.8 会比邻居粗一圈。
//
// 另外这个替换还有两处容易悄悄坏掉：
//   1) 宿主 <svg> 上挂着 `fill="none"` 与 `stroke-width`（medium 为 1.3），这两条会
//      向下继承；我们的 path 若不写全自身样式，图形会被宿主的属性吃掉（火花被
//      fill:none 清空、或光轨线宽缩成 1.3）。
//   2) 客户端读不到文件系统，几何只能内联一份 ⇒ 与 assets/icon.svg 有漂移风险。
//
// 做法：不需要跑 DSH。把 client/index.mjs 里那段纯 DOM 绘图代码原样抽出，注入一个
// 静态页，在一个**复刻的导航按钮**（含宿主生成的齿轮 svg）上执行，然后逐项断言：
//
//   N0 替换前按钮里确实是宿主画的齿轮（证明实验对象正确）
//   N1 复用宿主 <svg> 节点本身（同节点），class / width / height / aria-hidden 不变
//   N2 显示窗口与 icon.svg 同心、不放大，且图形占比（含描边）与宿主图标同量级
//      （0.85–0.98：宿主图标实测 0.89，太松显得轻、太大顶格子）
//   N3 内容是两条 path（光轨 + 火花），且**没有** defs / 渐变
//   N4 两条 d 与 assets/icon.svg **逐字一致**（单一数据源），linecap 亦一致
//   N5 单色：两条 path 的颜色都是 currentColor，且**计算值等于按钮的文字色**
//      ——这是「与兄弟栏目同色」的直接证据；火花纯填充、光轨只描边
//   N6 继承被覆盖：光轨 computed stroke-width = 2.3px（不是宿主的 1.3px），
//      换算到 16px 显示后 ≈ 1.3px，与邻居等粗
//   N7 布局未被撑坏：仍是 16×16，且包围盒非空；宿主哪天不再给宽高时补默认尺寸
//      （不然 <svg> 会退回 300×150 的默认尺寸）
//
// 判断力自检：同一份审计函数对 6 个**故意破坏**的变体（viewBox 退回 16 网格 /
// 光轨不写线宽 / 火花不关描边 / 路径换成别的图形 / 光轨改回渐变引用 / 火花写死品牌色）
// 必须各报出问题。少了这一步，写出的很可能是永不失败的检查。
//
// 用法：
//   node scripts/verify-nav-icon.mjs [--chrome <可执行文件>] [--keep]
//   node scripts/verify-nav-icon.mjs --emit <页面.html>     # 只产出页面（分步验证）
//   node scripts/verify-nav-icon.mjs --dump <dumpdom.html>  # 解析已有 dump-dom 输出
//   环境变量 CHROME_PATH 亦可指定浏览器；找不到浏览器时优雅跳过（退出码 0）。
//
// 抽取是「按标记切片 + 断言片段自洽」：client/index.mjs 一旦改结构导致切片失效，
// 本脚本直接报错退出，而不是悄悄退化成永不失败的检查。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const CLIENT_FILE = path.join(ROOT, 'client', 'index.mjs')
const ICON_FILE = path.join(ROOT, 'assets', 'icon.svg')

const SLICE_START = 'const NAV_ICON_VIEW_BOX'
const SLICE_END = 'const registerSettingsNavIcon = () => {'

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
    candidates.push('google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge')
  }
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 忽略不可访问的候选路径 */
    }
  }
  return null
}

/** 从 client/index.mjs 抽出绘图段（含常量、svgNode / paintSoulNavIcon）。 */
function extractPainter() {
  const source = fs.readFileSync(CLIENT_FILE, 'utf8')
  const start = source.indexOf(SLICE_START)
  const end = source.indexOf(SLICE_END)
  if (start < 0 || end < 0 || end <= start) {
    throw new Error(`抽取失败：client/index.mjs 中找不到切片标记（${SLICE_START} / ${SLICE_END}）`)
  }
  const slice = source.slice(start, end)
  for (const marker of ['paintSoulNavIcon', 'svgNode', 'replaceChildren', 'NAV_ICON_SPARK_D', 'NAV_ICON_STROKE_WIDTH', 'currentColor']) {
    if (!slice.includes(marker)) throw new Error(`抽取的绘图段缺少标记：${marker}（抽取范围可能已失效）`)
  }
  return slice
}

/** 解析 assets/icon.svg，得到导航图标必须与之保持一致的那几个量。 */
function parseIconFile() {
  const svg = fs.readFileSync(ICON_FILE, 'utf8')
  const viewBox = (svg.match(/viewBox="([^"]+)"/) || [])[1]
  if (!viewBox) throw new Error('assets/icon.svg 缺少 viewBox')

  const paths = []
  const pathRe = /<path\s+d="([^"]+)"([^>]*)\/>/g
  let pathMatch
  while ((pathMatch = pathRe.exec(svg))) {
    const [, d, attrs] = pathMatch
    paths.push({
      d,
      stroke: (attrs.match(/stroke="([^"]+)"/) || [])[1] || null,
      strokeWidth: (attrs.match(/stroke-width="([^"]+)"/) || [])[1] || null,
      linecap: (attrs.match(/stroke-linecap="([^"]+)"/) || [])[1] || null,
      fill: (attrs.match(/fill="([^"]+)"/) || [])[1] || null
    })
  }
  // 插件图标是彩色渐变版（光轨描边、火花填充），据此认出这两条 path；
  // 导航图标沿用它们的 d，但颜色与线宽走的是另一套（见文件头）。
  const trail = paths.find((item) => item.stroke && item.stroke.startsWith('url('))
  const spark = paths.find((item) => item.fill && item.fill.startsWith('url('))
  if (!trail || !spark) throw new Error('assets/icon.svg 缺少光轨（描边）或火花（填充）路径')

  return {
    viewBox,
    trail: { d: trail.d, linecap: trail.linecap },
    spark: { d: spark.d }
  }
}

function buildPage(painter, expected) {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>verify-nav-icon</title>
<style>
  body { margin: 0; padding: 12px; font: 14px/22px system-ui, sans-serif; color: #1a1a1a; background: #fff; }
  /* 复刻宿主 SettingsRoot 的导航单元格：图标 flex:none，label 占满剩余宽度 */
  .navCell { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border: 0; background: transparent; font: inherit; cursor: pointer; }
  .navIcon { flex: none; }
  .navLabel { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #samples { display: flex; gap: 24px; margin-top: 12px; }
</style>
</head>
<body>
<button type="button" class="navCell" id="cell">
  <svg width="16" height="16" class="navIcon" viewBox="0 0 16 16" fill="none"
       xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1.3">
    <path d="M8 1.6A6.4 6.4 0 1 0 8 14.4A6.4 6.4 0 1 0 8 1.6Z" stroke="currentColor" stroke-miterlimit="10"/>
  </svg>
  <span class="navLabel">个性化 / Personalization</span>
</button>
<div id="samples"></div>
<pre id="nav-icon-result" hidden></pre>
<script>
// —— 自 client/index.mjs 原样抽取的绘图段（常量 + svgNode / paintSoulNavIcon）
${painter}

const EXPECTED = ${JSON.stringify(expected)}
const issues = []
const record = (name, ok, detail) => issues.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) })

// icon.svg 所在的坐标系：导航图标与它共用同一套几何，但**显示窗口可以不同**
// （图形在 36 网格里只占 26.8 单位，直接拿来当 16px 导航图标会显得又小又轻）。
// 所以这里校验的是「同心 + 窗口不放大 + 视觉重量合理」，不是 viewBox 字面相等。
const ICON_BOX = EXPECTED.viewBox.split(/[\\s,]+/).map(Number)
const ICON_CENTER = { x: ICON_BOX[0] + ICON_BOX[2] / 2, y: ICON_BOX[1] + ICON_BOX[3] / 2 }

// 宿主机图标（ui-settings-general 的 navIcon 产物）：16 网格 + 1.3 线宽。
// 导航图标要在这两点上与邻居看齐——单色、同粗。
const HOST_GRID = 16
const HOST_STROKE_WIDTH = 1.3

// 审计一份绘制结果：返回问题清单（空数组 = 合格）
function auditIcon(svg, tag) {
  const out = []
  const push = (item) => out.push(tag + ': ' + item)

  const raw = svg.getAttribute('viewBox') || ''
  const box = raw.split(/[\\s,]+/).map(Number)
  if (box.length !== 4 || box.some((value) => !isFinite(value))) return out.concat(tag + ': viewBox 不可解析：' + raw)
  const cx = box[0] + box[2] / 2
  const cy = box[1] + box[3] / 2
  if (Math.abs(cx - ICON_CENTER.x) > 0.01 || Math.abs(cy - ICON_CENTER.y) > 0.01) {
    push('显示窗口未与 icon.svg 同心：中心 (' + cx + ',' + cy + ')，期望 (' + ICON_CENTER.x + ',' + ICON_CENTER.y + ')')
  }
  if (box[2] > ICON_BOX[2] + 0.01 || box[3] > ICON_BOX[3] + 0.01) {
    push('显示窗口比 icon.svg 的坐标系还大：' + box[2] + '×' + box[3])
  }

  const kids = Array.prototype.slice.call(svg.children)
  if (kids.length !== 2) return out.concat('子元素数量=' + kids.length + '（应为光轨 + 火花两条 path）')
  const trail = kids[0]
  const spark = kids[1]
  if (trail.tagName.toLowerCase() !== 'path' || spark.tagName.toLowerCase() !== 'path') {
    push('子元素不是两条 <path>：' + trail.tagName + ' / ' + spark.tagName)
    return out
  }

  // 单色：插件图标那套 defs / 渐变不该出现在导航图标里
  if (svg.querySelector('defs, linearGradient, radialGradient, stop')) {
    push('含 defs / 渐变，导航图标应为单色 currentColor')
  }

  if (trail.getAttribute('d') !== EXPECTED.trail.d) push('光轨路径与 icon.svg 不一致')
  if (spark.getAttribute('d') !== EXPECTED.spark.d) push('火花路径与 icon.svg 不一致')

  if (trail.getAttribute('fill') !== 'none') push('光轨 fill=' + trail.getAttribute('fill'))
  if (trail.getAttribute('stroke') !== 'currentColor') {
    push('光轨 stroke=' + trail.getAttribute('stroke') + '（应为 currentColor，跟随邻居）')
  }
  if (trail.getAttribute('stroke-width') !== String(NAV_ICON_STROKE_WIDTH)) {
    push('光轨 stroke-width 属性=' + trail.getAttribute('stroke-width'))
  }
  if (trail.getAttribute('stroke-linecap') !== EXPECTED.trail.linecap) {
    push('光轨 linecap=' + trail.getAttribute('stroke-linecap'))
  }
  if (spark.getAttribute('stroke') !== 'none') push('火花 stroke 属性=' + spark.getAttribute('stroke'))
  if (spark.getAttribute('fill') !== 'currentColor') {
    push('火花 fill=' + spark.getAttribute('fill') + '（应为 currentColor，跟随邻居）')
  }

  // 宿主 svg 上的 fill="none" / stroke-width="1.3" 会向下继承：读计算值确认已被覆盖
  const trailStyle = getComputedStyle(trail)
  const wantStroke = Number(NAV_ICON_STROKE_WIDTH)
  if (Math.abs(parseFloat(trailStyle.strokeWidth) - wantStroke) > 0.01) {
    push('光轨计算线宽=' + trailStyle.strokeWidth + '（继承未被覆盖）')
  }
  if (String(trailStyle.fill).indexOf('none') !== 0) push('光轨计算 fill=' + trailStyle.fill)

  // 「与兄弟栏目同色」的直接证据：currentColor 解析出来必须等于按钮的文字色
  const textColor = getComputedStyle(svg.closest('button') || svg).color
  if (String(trailStyle.stroke) !== String(textColor)) {
    push('光轨颜色 ' + trailStyle.stroke + ' ≠ 按钮文字色 ' + textColor)
  }
  if (String(getComputedStyle(spark).fill) !== String(textColor)) {
    push('火花颜色 ' + getComputedStyle(spark).fill + ' ≠ 按钮文字色 ' + textColor)
  }

  // 「与兄弟栏目同粗」：计算线宽是用户单位，乘上「16px ÷ 窗口边长」才是屏幕像素
  const displayStroke = parseFloat(trailStyle.strokeWidth) * (HOST_GRID / box[2])
  if (Math.abs(displayStroke - HOST_STROKE_WIDTH) > 0.15) {
    push('显示线宽=' + displayStroke.toFixed(2) + 'px（邻居 ' + HOST_STROKE_WIDTH + 'px）')
  }

  return out
}

const cell = document.getElementById('cell')
const icon = cell.querySelector('svg')

// N0：替换前是宿主画的齿轮（一个 path、stroke 为 currentColor）
record('替换前：宿主齿轮就位', icon && icon.children.length === 1 && icon.children[0].getAttribute('stroke') === 'currentColor')

const before = icon
paintSoulNavIcon(icon)

record('替换后：仍是同一个 <svg> 节点', icon === before && cell.querySelector('svg') === before)
record('替换后：宿主属性保留（class / 尺寸 / aria）',
  icon.getAttribute('class') === 'navIcon' &&
  icon.getAttribute('width') === '16' && icon.getAttribute('height') === '16' &&
  icon.getAttribute('aria-hidden') === 'true')
record('替换后：宿主继承属性仍在（fill=none / stroke-width=1.3，用于验证覆盖）',
  icon.getAttribute('fill') === 'none' && icon.getAttribute('stroke-width') === '1.3')

const main = auditIcon(icon, '主版本')
record('主版本：几何与样式全部合格（0 问题）', main.length === 0, main.join(' | '))

const box = icon.getBBox()
record('主版本：绘制包围盒非空', box.width > 0 && box.height > 0, box.width.toFixed(2) + '×' + box.height.toFixed(2))

// 宿主哪天不再给 width/height（改由 CSS 控制尺寸）时，必须补上，否则 svg 会退回
// 300×150 的默认尺寸把导航栏撑坏
const bare = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
bare.setAttribute('fill', 'none')
bare.setAttribute('stroke-width', '1.3')
document.getElementById('samples').appendChild(bare)
paintSoulNavIcon(bare)
record('宿主未给宽高时补默认尺寸', bare.getAttribute('width') === '16' && bare.getAttribute('height') === '16',
  bare.getAttribute('width') + '×' + bare.getAttribute('height'))

// 视觉重量：图形（含描边）在显示窗口里占多大。宿主图标实测几乎满格——16px 下墨迹
// 跨度 14.25px（占 89%），这个区间就是照它定的：太松会显得又小又轻，太紧会顶到格子边。
const vb = (icon.getAttribute('viewBox') || '').split(/[\\s,]+/).map(Number)
const weight = (Math.max(box.width, box.height) + Number(NAV_ICON_STROKE_WIDTH)) / vb[2]
record('主版本：图形占比与宿主图标同量级（0.85–0.98）', weight >= 0.85 && weight <= 0.98, weight.toFixed(3))

const rect = icon.getBoundingClientRect()
record('主版本：仍是 16×16（布局未被撑坏）',
  Math.abs(rect.width - 16) < 0.5 && Math.abs(rect.height - 16) < 0.5,
  rect.width.toFixed(2) + '×' + rect.height.toFixed(2))

// 颜色确实跟随容器文字色（而不是写死了某个灰）：换个文字色再画一遍，两处都应跟着变
const themed = document.createElement('button')
themed.setAttribute('type', 'button')
themed.className = 'navCell'
themed.style.color = 'rgb(230, 60, 90)'
const themedIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
themedIcon.setAttribute('viewBox', '0 0 16 16')
themedIcon.setAttribute('fill', 'none')
themedIcon.setAttribute('stroke-width', '1.3')
themed.appendChild(themedIcon)
document.getElementById('samples').appendChild(themed)
paintSoulNavIcon(themedIcon)
record('颜色跟随容器文字色（没写死色值）',
  String(getComputedStyle(themedIcon.children[0]).stroke) === 'rgb(230, 60, 90)' &&
  String(getComputedStyle(themedIcon.children[1]).fill) === 'rgb(230, 60, 90)',
  getComputedStyle(themedIcon.children[0]).stroke + ' / ' + getComputedStyle(themedIcon.children[1]).fill)

// —— 判断力自检：只改坏一个条件，审计必须报出问题
const samples = document.getElementById('samples')
function variant(name, mutate) {
  const clone = icon.cloneNode(true)
  samples.appendChild(clone)
  mutate(clone)
  return { name, found: auditIcon(clone, name) }
}

const variants = [
  variant('变体：viewBox 退回宿主 16 网格', (node) => node.setAttribute('viewBox', '0 0 16 16')),
  variant('变体：光轨不写线宽（继承 1.3）', (node) => node.children[0].removeAttribute('stroke-width')),
  variant('变体：火花不关描边', (node) => node.children[1].removeAttribute('stroke')),
  variant('变体：路径换成别的图形', (node) => node.children[0].setAttribute('d', 'M2 2L30 30')),
  variant('变体：光轨改回渐变引用', (node) => node.children[0].setAttribute('stroke', 'url(#soulTrail)')),
  variant('变体：火花写死品牌色', (node) => node.children[1].setAttribute('fill', '#679EFE'))
]
for (const item of variants) {
  record(item.name + ' → 必须被判不合格', item.found.length > 0, item.found.join(' | ') || '（未报错，判断力不足）')
}

const failed = issues.filter((item) => !item.ok)
document.getElementById('nav-icon-result').textContent = JSON.stringify({
  total: issues.length,
  failed: failed.length,
  items: issues
})
</script>
</body>
</html>
`
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

function parseDump(dumpHtml) {
  const match = dumpHtml.match(/<pre id="nav-icon-result"[^>]*>([\s\S]*?)<\/pre>/)
  if (!match) {
    throw new Error('dump-dom 输出里找不到结果节点（页面脚本可能抛错，看看浏览器控制台）')
  }
  const raw = decodeEntities(match[1]).trim()
  if (!raw) throw new Error('结果节点是空的（页面脚本可能中途抛错）')
  return JSON.parse(raw)
}

function report(result) {
  for (const item of result.items) {
    if (!item.ok) console.log(`  ✗ ${item.name}${item.detail ? ' — ' + item.detail : ''}`)
  }
  if (result.failed === 0) {
    console.log(`\n全部通过：${result.total} 项检查`)
    return 0
  }
  console.log(`\n结果：${result.total - result.failed} / ${result.total} 项通过，${result.failed} 项失败`)
  return 1
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const painter = extractPainter()
  const expected = parseIconFile()

  if (opts.dump) {
    return report(parseDump(fs.readFileSync(opts.dump, 'utf8')))
  }

  const page = buildPage(painter, expected)

  if (opts.emit) {
    fs.writeFileSync(opts.emit, page)
    console.log(`已产出页面：${opts.emit}`)
    console.log('下一步：用无头浏览器 --dump-dom 打开它，再执行 --dump <输出文件>')
    return 0
  }

  const browser = findBrowser(opts.chrome)
  if (!browser) {
    console.log('未找到可用的 Chrome / Edge，跳过导航图标回归。')
    console.log('可指定浏览器：node scripts/verify-nav-icon.mjs --chrome <可执行文件>')
    return 0
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-soul-nav-icon-'))
  const pagePath = path.join(tmpDir, 'page.html')
  fs.writeFileSync(pagePath, page)

  const result = spawnSync(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    `--user-data-dir=${path.join(tmpDir, 'profile')}`,
    '--virtual-time-budget=5000',
    '--dump-dom',
    pathToFileURL(pagePath).href
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120000 })

  try {
    if (result.error || result.status !== 0 || !result.stdout) {
      const reason = result.error ? result.error.code || result.error.message : `退出码 ${result.status}`
      console.log(`无头浏览器未能运行（${reason}）。`)
      console.log('可改用两段式：--emit 产出页面 → 手动跑浏览器 --dump-dom → --dump 解析')
      return 0
    }
    return report(parseDump(result.stdout))
  } finally {
    if (!opts.keep) fs.rmSync(tmpDir, { recursive: true, force: true })
    else console.log(`保留临时目录：${tmpDir}`)
  }
}

process.exit(main())
