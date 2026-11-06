// scripts/verify-sidebar-visibility.mjs — Issue #3 侧栏「人设总览」开关回归
//
// 为什么单独一个脚本：这个需求横跨「配置层字段」「设置页表单」「槽位动态注册」
// 三层，任何一层漏改都不会报错，只会安静地表现为「开关没用」。
// 这里做三层对账 + 真 import 校验字段行为 + 源文本契约 + 判断力对照。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { assertCount } from './lib/skip-report.mjs'
import { DEFAULT_CONFIG, sanitizeConfig, migrateConfig } from '../lib/config.mjs'

const EXPECTED_ASSERTIONS = 15
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
  assert.ok(strict >= 5, `严格判定应覆盖全部读取点，实际 ${strict} 处`)
})

// ── ② 字段全集对账：DEFAULT_CONFIG ↔ client FIELD_KEYS ──
// 这次的 bug 正是「FORM_FIELD_KEYS 加了但 savedMap 漏了」，靠人眼很难发现。
check('DEFAULT_CONFIG 每个键都在 client 的字段全集里', () => {
  // FIELD_KEYS 由 FORM_FIELD_KEYS + EXTERNALLY_MANAGED_FIELDS 展开，
  // 所以要把两个字面量数组的键合起来对账。
  const collect = (name) => {
    const m = clientCode.match(new RegExp('const ' + name + ' = \\[([^\\]]+)\\]'))
    assert.ok(m, `找不到 ${name}`)
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
  }
  const keys = new Set([...collect('FORM_FIELD_KEYS'), ...collect('EXTERNALLY_MANAGED_FIELDS')])
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    assert.ok(keys.has(key), `DEFAULT_CONFIG.${key} 不在 client 字段全集里`)
  }
})
check('FORM_FIELD_KEYS 含 showOverviewInSidebar', () => {
  assert.match(clientCode, /FORM_FIELD_KEYS = \[[^\]]*'showOverviewInSidebar'/)
})
check('设置页 savedMap / localMap / serverValues 三处都含该字段', () => {
  for (const name of ['savedMap', 'localMap', 'serverValues', 'localValues']) {
    const m = clientCode.match(new RegExp('const ' + name + ' = \\{([^}]*)\\}'))
    assert.ok(m, `找不到 ${name}`)
    assert.ok(m[1].includes('showOverviewInSidebar'), `${name} 漏了 showOverviewInSidebar（dirty 会恒 true）`)
  }
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
check('设置页有「打开人设总览」备用按钮', () => {
  assert.match(clientCode, /action\.openOverview/, '缺备用按钮文案调用')
  assert.match(clientCode, /selectPanel\(OVERVIEW_PANEL_ID\)/, '备用按钮必须真的切面板')
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
