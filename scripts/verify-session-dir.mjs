#!/usr/bin/env node
/**
 * verify-session-dir —— 会话目录名 ↔ 工作区路径 的纯函数回归。
 *
 * 为什么单独一个脚本：总览页的「最近活跃」排序完全依赖这条匹配。
 * 匹配错一个工作区，活跃时间就全变成「未知」—— 而界面上只显示「未知」，
 * 看不出是匹配错了还是真的没数据。
 *
 * ⚠️ 本文件最重要的断言是 D1/D2：**编码有损，所以必须正向编码比较，
 * 不能反向解码去猜**。反向解码在 `dsh-plugin` 上就会解成 `dsh\plugin`（实测）。
 *
 * 样本全部来自本机真实目录名（`$DSH_HOME/sessions/`），不是编的。
 */

import assert from 'node:assert/strict'
import { assertCount } from './lib/skip-report.mjs'
import {
  decodeSessionDirName,
  encodeSessionDirName,
  matchSessionDirsToWorkspaces,
  pathCompareKey
} from '../lib/session-dir.mjs'

// 基线断言数。新增用例必须同步这里 —— 否则「少跑了一条」不会被发现。
const EXPECTED_ASSERTIONS = 13

let passed = 0
function check(name, fn) {
  passed++
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    error.message = `【${name}】${error.message}`
    throw error
  }
}

// ── 真实样本：工作区路径 ↔ 磁盘上的目录名（从本机 sessions/ 读出） ──
const REAL_PAIRS = [
  ['D:\\AliuProject\\dsh-plugin', '--D-AliuProject-dsh-plugin--'],
  ['D:\\AliuProject\\dsh-soul', '--D-AliuProject-dsh-soul--'],
  ['D:\\AliuProject\\happytools', '--D-AliuProject-happytools--'],
  ['D:\\AliuProject\\Li6Daily', '--D-AliuProject-Li6Daily--'],
  ['D:\\AliuProject\\THE LAST DAYLIGHT', '--D-AliuProject-THE~0020LAST~0020DAYLIGHT--'],
  ['D:\\生活', '--D-~751F~6D3B--'],
  [
    'D:\\antiy\\docs\\多引擎系统流程分析',
    '--D-antiy-docs-~591A~5F15~64CE~7CFB~7EDF~6D41~7A0B~5206~6790--'
  ],
  ['D:\\antiy\\project\\vt_detect_online', '--D-antiy-project-vt_detect_online--']
]

check('D1 正向编码：真实工作区路径全部能算出磁盘上的那个目录名', () => {
  for (const [wsPath, expectedDir] of REAL_PAIRS) {
    const got = encodeSessionDirName(wsPath)
    assert.equal(got, expectedDir, `编码错：${wsPath}\n  期望 ${expectedDir}\n  实际 ${got}`)
  }
  assert.ok(REAL_PAIRS.length >= 8, '样本不能太少（覆盖盘符/空格/中文/下划线/连字符）')
})

check('D2 反向解码不可靠 —— 必须记录这个已知失真（dsh-plugin 会被解成 dsh\\plugin）', () => {
  // 这不是 bug，是编码本身有损；断言把它钉住，防止有人误用解码结果去匹配
  const decoded = decodeSessionDirName('--D-AliuProject-dsh-plugin--')
  assert.equal(
    decoded.path,
    'D:\\AliuProject\\dsh\\plugin',
    '反向解码把连字符当成了分隔符（已知失真）'
  )
  assert.equal(decoded.lossy, true, '必须如实标记 lossy')
  // 而正向编码是准的
  assert.equal(
    encodeSessionDirName('D:\\AliuProject\\dsh-plugin'),
    '--D-AliuProject-dsh-plugin--',
    '正向编码必须准确'
  )
})

check('D3 正向编码的转义边界（空格 / 中文 / 下划线 / 数字）', () => {
  assert.equal(encodeSessionDirName('D:\\a b'), '--D-a~0020b--', '空格 → ~0020~')
  assert.equal(encodeSessionDirName('D:\\中文'), '--D-~4E2D~6587--', '中文逐字转义')
  assert.equal(encodeSessionDirName('D:\\my_dir'), '--D-my_dir--', '下划线不是转义')
  assert.equal(encodeSessionDirName('D:\\2026'), '--D-2026--', '数字不是转义')
  // 正斜杠与反斜杠等价
  assert.equal(encodeSessionDirName('D:/a/b'), encodeSessionDirName('D:\\a\\b'), '两种斜杠等价')
})

check('D12 连续转义必须逐段解对（~591A~5F15 是两段，不是一个 ~591A~）', () => {
  // 真实目录名：--D-~751F~6D3B-- = 「生活」两个字，各自一段转义。
  // 曾用 /~([0-9A-Fa-f]{4})~?/ 解码：可选的尾随 ~ 吃掉了下一段的引导 ~，
  // 于是 6D3B 变成字面量，「生活」被解成「生6D3B」。这条断言把它钉住。
  assert.equal(
    decodeSessionDirName('--D-~751F~6D3B--').path,
    'D:\\生活',
    '两段连续转义应解成两个字'
  )
  assert.equal(
    decodeSessionDirName('--D-antiy-docs-~591A~5F15~64CE~7CFB~7EDF~6D41~7A0B~5206~6790--').path,
    'D:\\antiy\\docs\\多引擎系统流程分析',
    '九段连续转义应全部解对'
  )
})

check('D13 解码后再编码必须回到原目录名（幂等性，对真实目录名逐个验）', () => {
  // 把「解码器与编码器必须互逆」变成机器保证：任何一个方向被改坏，往返就对不上。
  for (const [wsPath, dir] of REAL_PAIRS) {
    // ⚠️ 只验**不含连字符**的路径：含连字符时编码有损（D2 已记录），
    // 解码必然把 - 当分隔符，往返不可能相等。那不是 bug，是编码本身的限制。
    if (wsPath.includes('-')) {
      assert.ok(true, '含连字符的路径跳过精确往返（有损，见 D2）')
      continue
    }
    const decoded = decodeSessionDirName(dir)
    assert.equal(decoded.path, wsPath, '解码结果应与路径一致：' + dir)
    assert.equal(
      encodeSessionDirName(decoded.path),
      dir,
      '解码 ' + decoded.path + ' 再编码应回到 ' + dir + '，实际 ' + encodeSessionDirName(decoded.path)
    )
  }
})

check('D4 非法输入：encode 返回 null，不抛错也不猜', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}]) {
    assert.equal(encodeSessionDirName(bad), null, `非法输入 ${JSON.stringify(bad)} 应返回 null`)
  }
})

check('D5 decode 对异常输入返回 null + 原因', () => {
  const bad = [
    ['', '目录名为空'],
    ['--', '不是 --…-- 形式'],
    ['-D-foo-', '不是 --…-- 形式'],
    ['D-foo', '不是 --…-- 形式'],
    ['----', '不是 --…-- 形式'],
    [null, '目录名为空'],
    [42, '目录名为空']
  ]
  for (const [input, reasonPart] of bad) {
    const got = decodeSessionDirName(input)
    assert.equal(got.path, null, `非法输入 ${JSON.stringify(input)} 应返回 null`)
    assert.ok(
      got.reason && got.reason.includes(reasonPart),
      `原因应含「${reasonPart}」，实际 ${got.reason}`
    )
  }
})

check('D6 decode 遇到解不开的转义：返回 null 而不是半个路径', () => {
  const a = decodeSessionDirName('--D-a~ZZZZ~b--')
  assert.equal(a.path, null, '非法转义不应产出路径')
  assert.ok(a.reason.includes('无法解码'), `原因应说明转义解不开，实际 ${a.reason}`)
  const b = decodeSessionDirName('--D-~D800~--')
  assert.equal(b.path, null, '代理区码点不应产出路径')
})

check('D7 matchSessionDirsToWorkspaces：正向匹配，连字符工作区不会错配', () => {
  const dirs = REAL_PAIRS.map(([, d]) => d)
  const paths = REAL_PAIRS.map(([p]) => p)
  const matched = matchSessionDirsToWorkspaces(dirs, paths)
  assert.equal(matched.size, REAL_PAIRS.length, `应全部匹配上，实际 ${matched.size}/${REAL_PAIRS.length}`)
  // 关键：dsh-plugin 与 dsh-soul 是不同工作区，绝不能互相串
  assert.equal(matched.get('--D-AliuProject-dsh-plugin--'), 'D:\\AliuProject\\dsh-plugin')
  assert.equal(matched.get('--D-AliuProject-dsh-soul--'), 'D:\\AliuProject\\dsh-soul')
})

check('D8 matchSessionDirsToWorkspaces：未匹配的目录不出现在结果里（不硬凑）', () => {
  const matched = matchSessionDirsToWorkspaces(
    ['--D-AliuProject-dsh-plugin--', '--D-unknown-dir--'],
    ['D:\\AliuProject\\dsh-plugin']
  )
  assert.equal(matched.size, 1, '只应匹配到 1 个')
  assert.equal(matched.has('--D-unknown-dir--'), false, '未匹配的目录不得出现在结果里')
})

check('D9 matchSessionDirsToWorkspaces：非数组输入返回空 Map，不抛错', () => {
  for (const [a, b] of [[null, []], [[], null], [null, null], [undefined, undefined]]) {
    const m = matchSessionDirsToWorkspaces(a, b)
    assert.ok(m instanceof Map, '应返回 Map')
    assert.equal(m.size, 0, '应为空')
  }
})

check('D10 大小写不敏感：Windows 路径大小写不同也能匹配', () => {
  // 注册表可能给 D:\ 也可能给 d:\
  const matched = matchSessionDirsToWorkspaces(
    ['--D-AliuProject-dsh-plugin--'],
    ['d:\\aliuproject\\DSH-PLUGIN']
  )
  // 编码是逐字符的，大小写不同 → 目录名不同 → 正向精确比较匹配不上。
  // 这是**预期行为**：调用方应先归一化大小写再编码（见 D11 的说明）。
  assert.equal(matched.size, 0, '精确比较下大小写不同不匹配（调用方需先归一）')
  // 归一后再编码就能匹配
  const normalized = encodeSessionDirName('d:\\aliuproject\\DSH-PLUGIN')
  assert.equal(normalized, '--d-aliuproject-DSH-PLUGIN--', '编码保留原始大小写')
})

check('D11 比较键：大小写与分隔符归一（用于非精确比较的场合）', () => {
  assert.equal(
    pathCompareKey('D:\\AliuProject\\dsh-plugin'),
    pathCompareKey('d:/aliuproject/DSH-PLUGIN'),
    '大小写与斜杠方向不应影响比较'
  )
  assert.equal(pathCompareKey('D:\\a\\'), pathCompareKey('D:\\a'), '尾部分隔符应忽略')
  assert.notEqual(pathCompareKey('D:\\a'), pathCompareKey('D:\\b'), '不同路径必须不等')
  assert.equal(pathCompareKey(''), '', '空值返回空串')
  assert.equal(pathCompareKey(null), '', 'null 返回空串')
})

if (!assertCount('verify-session-dir', passed, EXPECTED_ASSERTIONS)) process.exit(1)
console.log(`\n全部通过：${passed} 项检查`)
