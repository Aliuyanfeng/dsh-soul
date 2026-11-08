// scripts/verify-sidebar-visibility.mjs — Issue #3 侧栏「人设总览」开关回归
//
// 为什么单独一个脚本：这个需求横跨「配置层字段」「设置页表单」「槽位动态注册」
// 三层，任何一层漏改都不会报错，只会安静地表现为「开关没用」。
// 这里做三层对账 + 真 import 校验字段行为 + 源文本契约 + 判断力对照。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertCount } from './lib/skip-report.mjs'
import { DEFAULT_CONFIG, sanitizeConfig, migrateConfig } from '../lib/config.mjs'

const EXPECTED_ASSERTIONS = 16
let passed = 0
const check = (name, fn) => {
  passed++
  try { fn(); console.log('  ✓ ' + name) }
  catch (err) { err.message = `【${name}】${err.message}`; throw err }
}

const client = readFileSync(new URL('../client/index.mjs', import.meta.url), 'utf8')
const host = readFileSync(new URL('../index.mjs', import.meta.url), 'utf8')
const stripComments = (s) => s.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
const clientCode = stripComments(client)

// ── ① 配置层 ──
check('DEFAULT_CONFIG 含 showOverviewInSidebar，默认 false（不强制占侧栏）', () => {
  assert.equal(DEFAULT_CONFIG.showOverviewInSidebar, false)
})
check('sanitizeConfig 接受布尔值', () => {
  assert.deepEqual(sanitizeConfig({ showOverviewInSidebar: false }).patch, { showOverviewInSidebar: false })
  assert.deepEqual(sanitizeConfig({ showOverviewInSidebar: true }).patch, { showOverviewInSidebar: true })
})
check('sanitizeConfig 拒绝非布尔并报错', () => {
  const r = sanitizeConfig({ showOverviewInSidebar: 'false' })
  assert.ok(r.errors.showOverviewInSidebar)
  assert.equal('showOverviewInSidebar' in r.patch, false)
})
check('migrateConfig 对脏数据/缺失回退默认 false', () => {
  assert.equal(migrateConfig({ showOverviewInSidebar: 'garbage' }).showOverviewInSidebar, false)
  assert.equal(migrateConfig({}).showOverviewInSidebar, false)
})
check('★ 全部读取点必须用严格 === true（默认 false 时 !== false 会把缺失误判为开）', () => {
  assert.equal(/showOverviewInSidebar !== false/.test(clientCode), false,
    '残留宽松判定：配置缺失时会被当成"开启"')
  const strict = (clientCode.match(/showOverviewInSidebar === true/g) || []).length
  // 三处读取点：applyConfig 归一化、设置页开关、侧栏 sync。0.12 分段保存后设置页
  // 不再持有草稿副本（它直接读 store、拨完即存），原先「回填草稿」那两处判定消失了。
  // 用等号而不是 >=：新增读取点会撞到这条，逼着写的人确认自己用的也是严格判定。
  assert.equal(strict, 3, `严格判定的读取点应为 3 处（store 归一化 / 设置页开关 / 侧栏同步），实际 ${strict} 处`)
})

// ── ② 字段全集对账：DEFAULT_CONFIG ↔ client FIELD_KEYS ──
// 这次的 bug 正是「FORM_FIELD_KEYS 加了但 savedMap 漏了」，靠人眼很难发现。
check('DEFAULT_CONFIG 每个键都在 client 的字段全集里', () => {
  // 0.12 分段保存后 FIELD_KEYS 是多段组合（表单段本身又是「关于你 + 特质」两段），
  // 所以按**展开语义**递归解析，而不是抓单个数组字面量。
  const collect = (name, seen = new Set()) => {
    if (seen.has(name)) return []
    seen.add(name)
    const m = clientCode.match(new RegExp('const ' + name + ' = (\\[[^\\]]*\\])'))
    assert.ok(m, `找不到 ${name}`)
    return [...m[1].matchAll(/'([^']+)'/g)].flatMap((x) => [x[1]])
      .concat([...m[1].matchAll(/\.\.\.(\w+)/g)].flatMap((x) => collect(x[1], seen)))
  }
  const keys = new Set(collect('FIELD_KEYS'))
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(keys.has(key), `DEFAULT_CONFIG.${key} 不在 client 字段全集里`)
  }
})
check('IMMEDIATE_FIELD_KEYS 含 showOverviewInSidebar（点击即生效，不走草稿）', () => {
  assert.match(clientCode, /IMMEDIATE_FIELD_KEYS = \[[^\]]*'showOverviewInSidebar'/)
})
check('该字段只有一条写入路径：即时落盘，且不在草稿映射里', () => {
  // 分段保存后「一个字段两处写」是会真实发生的：分区载荷提交 + 即时落盘都能覆盖它，
  // 谁后到谁赢。所以即时字段必须**缺席**于草稿侧的四个映射。
  for (const name of ['savedMap', 'localMap', 'serverValues', 'localValues']) {
    const m = clientCode.match(new RegExp('const ' + name + ' = \\{([^}]*)\\}'))
    assert.ok(m, `找不到 ${name}`)
    assert.equal(m[1].includes('showOverviewInSidebar'), false,
      `${name} 不该含 showOverviewInSidebar —— 它是即时字段，进草稿表就有两个写入方`)
  }
  assert.match(clientCode, /saveImmediate\('showOverviewInSidebar'/, '侧栏开关必须即时落盘')
})
check('applyConfig 把服务端值归一化进 store', () => {
  assert.match(clientCode, /s\.showOverviewInSidebar = config\.showOverviewInSidebar === true/)
})

// ── ③ 侧栏动态注册（核心） ──
check('main 面板必须常驻（否则关闭后备用按钮打不开）', () => {
  // panel 注册仍在 inject 回调里，且不包在按配置判断的分支中
  const seg = clientCode.slice(clientCode.indexOf("inject('sidebar.panellist'"), clientCode.indexOf("inject('sidebar.panellist'") + 2600)
  assert.match(seg, /const panel = ctx\.slots\.register\(/)
  assert.match(seg, /name: 'main'/)
})
check('图标行必须按配置 register / 注销', () => {
  assert.match(clientCode, /controller\.store\.subscribe\(sync\)/, '必须订阅配置变化')
  assert.match(clientCode, /showOverviewInSidebar === true/, '必须读开关值（严格判定）')
  assert.match(clientCode, /disposeRow = registerRow\(\)/, '开启时要注册')
  // ★ 限定在 sync() 函数体内、且必须在 !on 分支里真的调用注销。
  // 只查任意 `disposeRow()` 会被 unmount cleanup 里那次骗过（实测漏检）。
  const syncStart = clientCode.indexOf('const sync = () => {')
  const syncEnd = clientCode.indexOf('const off = controller.store.subscribe(sync)', syncStart)
  assert.ok(syncStart > 0 && syncEnd > syncStart, '找不到 sync 函数体')
  const syncBody = clientCode.slice(syncStart, syncEnd)
  assert.match(syncBody, /!on && disposeRow !== null/, '必须有「关闭」分支')
  assert.match(syncBody, /disposeRow\(\)/, '关闭分支里必须真的调用注销')
  assert.match(syncBody, /disposeRow = null/, '注销后必须清空，否则不会再注册')
})
check('注销的是图标行、不是 main 面板', () => {
  const seg = clientCode.slice(clientCode.indexOf('let disposeRow = null'), clientCode.indexOf('const off = controller.store.subscribe(sync)'))
  assert.match(seg, /name: 'sidebar\.panellist'/, 'registerRow 里注册的是图标行')
  assert.equal(seg.includes("name: 'main'"), false, '不该在动态分支里注册 main')
})
check('「打开人设总览」入口在插件详情页（用户要求从设置页挪过来）', () => {
  // 用户：「打开人设总览 这个按钮 不要放在设置页了 放在插件详情页吧」。
  // 详情页入口与工作区人设 / 变更记录 / 会话清理同类：低频、需要空间。
  assert.match(clientCode, /action\.openOverview/, '缺「打开人设总览」文案调用')
  assert.match(clientCode, /selectPanel\(OVERVIEW_PANEL_ID\)/, '入口必须真的切面板')

  // 必须注册到插件详情页槽位，且 id 独立
  assert.match(clientCode, /id: 'soul-detail-overview'/, '必须注册为独立详情区块')
  assert.match(clientCode, /name: 'plugins\.detail\.section'[\s\S]{0,160}soul-detail-overview|soul-detail-overview[\s\S]{0,160}plugins\.detail\.section/, '必须走 plugins.detail.section 槽位')

  // 详情页槽位对所有插件详情页都渲染 —— 必须按 subject.pkg.name 过滤，
  // 否则会跑到别的插件详情页里。
  //
  // 判据自 0.11.0 起收进共享的 isOwnPluginDetailPage：同一个判据在四个详情页区块的
  // 「渲染守卫」和「effect 自查」两处都要用，散着写四份迟早漂移。所以分两步钉：
  // ① 入口确实调了判据；② 判据本身按 pkg.name 判定（防止被判据改名架空）。
  assert.match(clientCode, /function SoulOverviewEntry[\s\S]{0,600}isOwnPluginDetailPage\(subject\)/, '必须过滤 subject，只服务本插件详情页')
  assert.match(clientCode, /function isOwnPluginDetailPage[\s\S]{0,200}pkg\.name === 'dsh-soul'/, '共享判据必须按 pkg.name 判定')
})

check('设置页不再放「打开人设总览」按钮（已迁到详情页）', () => {
  // 设置页里不该再出现这个按钮：它的 onClick 调 selectPanel(OVERVIEW_PANEL_ID)。
  // 详情页组件里必然有一处，所以这里断言「恰好一处」——多了就是设置页那份还在。
  const hits = (clientCode.match(/selectPanel\(OVERVIEW_PANEL_ID\)/g) || []).length
  assert.equal(hits, 1, `selectPanel(OVERVIEW_PANEL_ID) 应只在详情页组件里出现一次，实际 ${hits}`)
})
check('中英词典都有该字段的 label + hint + 按钮文案', () => {
  // 词典定义形态是 `      'key': '文案',`（行首缩进 + 冒号）。
  // 不能只数 'key' 的出现次数：AUDIT_FIELDS 表和 t('key') 调用也会命中。
  for (const key of ['field.showOverviewInSidebar', 'hint.showOverviewInSidebar', 'action.openOverview']) {
    const def = new RegExp("^\\s*'" + key.replace('.', '\\.') + "':\\s*'", 'gm')
    const hits = (client.match(def) || []).length
    assert.equal(hits, 2, `${key} 应在 zh/en 词典各定义一次，实际 ${hits}`)
  }
})
check('host 侧 NON_PROMPT_FIELDS 自动覆盖新字段（不参与提示词）', () => {
  assert.match(host, /const NON_PROMPT_FIELDS = new Set\(\s*Object\.keys\(DEFAULT_CONFIG\)/)
  assert.equal(/PROMPT_INPUT_FIELDS\s*=\s*\[[^\]]*showOverviewInSidebar/.test(host), false)
})

console.log('\n全部通过：' + passed + ' 项检查')
if (!assertCount('verify-sidebar-visibility', passed, EXPECTED_ASSERTIONS)) process.exit(1)
