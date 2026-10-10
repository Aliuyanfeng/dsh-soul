// scripts/verify-store.mjs — 配置持久化层行为自检（真实文件系统）
//
// 与 verify-config.mjs 分工：那边做纯函数与源文本契约，这里在**真实磁盘上**
// 跑 lib/store.mjs，验证「读写出错时到底发生了什么」。两类失败必须被区分：
//
//   - 文件不存在  → 首次运行，回退默认值是正常的，允许写入；
//   - 文件损坏    → 回退默认值只是「让插件还能用」，**绝不允许把这份默认值写回磁盘**，
//                   否则用户的自定义指令与预设库会被静默清空。
//
// 零依赖，直接 `node scripts/verify-store.mjs` 运行。

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  configWriteRefusal,
  corruptBackupPath,
  describeConfigFailure,
  moveAsideConfigFile,
  readConfigFile,
  writeConfigFile
} from '../lib/store.mjs'
import { assertCount, skipNote } from './lib/skip-report.mjs'

const root = mkdtempSync(join(tmpdir(), 'dsh-soul-store-'))
let seq = 0
function freshPath(label = 'config') {
  seq += 1
  return join(root, `${label}-${seq}.json`)
}

// 本机是否提供 inode。`writeConfigFile` 用「临时文件 + rename」落盘，而 rename 会替换
// 目录项 ⇒ 覆盖前后 inode 不同；这是区分它和「原地截断重写」最直接的判据。少数平台上
// `statSync().ino` 恒为 0（不提供该信息），此时那一条断言无条件执行 —— 走 skipNote
// 如实报告，并在 --strict 下算失败（而不是静默不跑）。
const inodeSupported = detectInodeSupport()
function detectInodeSupport() {
  try {
    const probe = join(root, 'inode-probe.json')
    writeFileSync(probe, '{}', 'utf8')
    return statSync(probe).ino !== 0
  } catch {
    return false
  }
}

// 基线运行应跑出的检查数；不提供 inode 时那条判据不执行，声明值随之减一。
const EXPECTED_ASSERTIONS = inodeSupported ? 18 : 17

let strictOk = true

let passed = 0
async function check(name, fn) {
  // fn 返回 false 表示「这一项本次未执行，且已在内部用 skipNote 说明过」⇒ 不计入 passed。
  let counted
  try {
    counted = await fn()
  } catch (error) {
    // 同 verify-client：失败时点名用例，否则只有一个孤零零的 AssertionError。
    // `stack` 与 `message` 都要改 —— 未捕获错误打印的是 stack，首行在构造时已写死。
    error.message = `【${name}】${error.message}`
    error.stack = `【${name}】${error.stack}`
    throw error
  }
  if (counted === false) return
  passed++
  console.log(`  ✓ ${name}`)
}

process.on('exit', () => {
  try {
    rmSync(root, { recursive: true, force: true })
  } catch {
    // 临时目录清理失败不影响结论
  }
})

// 一份「被截断的 JSON」——模拟写到一半进程被杀留下的残骸
const BROKEN = '{\n  "enabled": true,\n  "customInstructions": "讲重点"'
const BROKEN_RECOVERABLE = JSON.stringify({ enabled: false, nickname: '小明', personas: { 老张: { style: 'roast' } } })

console.log('readConfigFile')

await check('文件不存在 → 走「不存在」路径，不算失败，允许写入', async () => {
  const p = freshPath()
  const r = await readConfigFile(p)
  assert.equal(r.exists, false, 'exists 应为 false')
  assert.equal(r.value, null)
  assert.equal(r.failure, null, '文件不存在不是错误（否则首次运行就无法保存）')
  assert.equal(configWriteRefusal(r.failure, p), null, '首次运行必须允许写入')
  assert.equal(describeConfigFailure(r.failure), null)
})

await check('合法 JSON → 原样解析，不产生失败记录', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN_RECOVERABLE, 'utf8')
  const r = await readConfigFile(p)
  assert.equal(r.exists, true)
  assert.deepEqual(r.value, { enabled: false, nickname: '小明', personas: { 老张: { style: 'roast' } } })
  assert.equal(r.failure, null)
  assert.equal(configWriteRefusal(r.failure, p), null, '正常文件必须允许写入')
})

await check('损坏 JSON → 报告 invalid-json，并另存 .corrupt 备份（逐字节一致）', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN, 'utf8')
  const r = await readConfigFile(p)
  assert.equal(r.exists, true, '损坏的文件依然「存在」，不能与不存在混为一谈')
  assert.equal(r.value, null)
  assert.equal(r.failure.code, 'invalid-json')
  assert.equal(r.failure.backupPath, corruptBackupPath(p), '应备份到 <文件>.corrupt')
  assert.equal(
    readFileSync(r.failure.backupPath, 'utf8'),
    BROKEN,
    '备份必须与损坏文件逐字节一致，否则用户找不回内容'
  )
})

await check('损坏 JSON 的失败说明里同时包含原因与备份位置', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN, 'utf8')
  const { failure } = await readConfigFile(p)
  const text = describeConfigFailure(failure)
  assert.ok(text.includes('JSON'), `说明里应点明 JSON 解析失败：${text}`)
  assert.ok(text.includes(corruptBackupPath(p)), `说明里应给出备份路径：${text}`)
})

await check('读取报错（非 ENOENT）→ 报告 unreadable，而不是伪装成「文件不存在」', async () => {
  // 目录当文件读：各平台都会报错（Windows EISDIR / EPERM，POSIX EISDIR）。
  // 这条路径的意义是：任何读盘异常都不能被吞成「空配置」，否则后续保存会覆盖。
  const dir = join(root, 'a-directory.json')
  mkdirSync(dir)
  const r = await readConfigFile(dir)
  assert.equal(r.exists, true)
  assert.equal(r.value, null)
  assert.equal(r.failure.code, 'unreadable')
  assert.ok(configWriteRefusal(r.failure, dir), '读不出来时同样必须拒绝写入')
})

await check('备份失败（.corrupt 位置被占）不影响读取结果，只是没有备份路径', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN, 'utf8')
  mkdirSync(corruptBackupPath(p)) // 让 copyFile 失败
  const r = await readConfigFile(p)
  assert.equal(r.failure.code, 'invalid-json', '备份是尽力而为，失败不能改变「配置损坏」这个事实')
  assert.equal(r.failure.backupPath, null)
  assert.ok(describeConfigFailure(r.failure).length > 0, '没有备份也要给出可读说明')
})

console.log('\nconfigWriteRefusal')

await check('拒绝写入的判定只由「有没有 failure」决定（判定力边界）', async () => {
  const target = join(root, 'config.json')
  assert.equal(configWriteRefusal(null, target), null, '无失败必须允许写入')
  assert.equal(configWriteRefusal(undefined, target), null)
  const msg = configWriteRefusal({ message: '配置文件不是合法的 JSON', backupPath: null }, target)
  assert.ok(msg && msg.includes('配置文件不是合法的 JSON'), '必须原样带上失败原因')
  assert.ok(msg.includes(target), '必须告知用户在哪个文件上恢复')
  const withBackup = configWriteRefusal({ message: 'M', backupPath: `${target}.corrupt` }, target)
  assert.ok(withBackup.includes(`${target}.corrupt`), '有备份时必须告知备份位置')
})

console.log('\nR3：损坏的配置不会被静默覆盖')

await check('损坏配置 + 尝试保存 → 写入被拒，原文件逐字节未变', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN, 'utf8')
  const before = readFileSync(p)

  // 复刻 index.mjs 的接线：读 → 判断能否写 → 不能写就不写。
  // 这里刻意把「保存」也真的执行一遍（而不是只断言 refusal 非空），
  // 否则测不出「拒绝之后文件有没有被动过」。
  const { failure } = await readConfigFile(p)
  const refusal = configWriteRefusal(failure, p)
  assert.ok(refusal, '损坏时必须拒绝写入')
  if (!refusal) {
    await writeConfigFile(p, { enabled: true, nickname: '（默认值）' })
  }

  assert.ok(before.equals(readFileSync(p)), '被拒的保存不得改动原文件一个字节')
  assert.ok(before.equals(readFileSync(corruptBackupPath(p))), '备份也应保持为损坏前的原文')
})

await check('用户修好文件后读取恢复正常（失败状态不粘住）', async () => {
  const p = freshPath()
  writeFileSync(p, BROKEN, 'utf8')
  const broken = await readConfigFile(p)
  assert.equal(broken.failure.code, 'invalid-json')

  writeFileSync(p, BROKEN_RECOVERABLE, 'utf8') // 用户手动修复
  const fixed = await readConfigFile(p)
  assert.equal(fixed.failure, null, '修好之后必须回到正常路径（不能一直拒绝写入）')
  assert.deepEqual(fixed.value.nickname, '小明')
  assert.equal(configWriteRefusal(fixed.failure, p), null)
})

console.log('\nwriteConfigFile')

await check('原子写：内容完整（格式化 JSON），且不残留临时文件', async () => {
  const p = freshPath()
  await writeConfigFile(p, { enabled: true, nickname: '小明' })
  assert.equal(existsSync(`${p}.tmp`), false, '写入完成后不应残留 .tmp（否则说明没走 rename）')
  assert.equal(readFileSync(p, 'utf8'), JSON.stringify({ enabled: true, nickname: '小明' }, null, 2))
})

await check('原子写：以 rename 替换（覆盖前后 inode 不同）', async () => {
  const p = freshPath()
  await writeConfigFile(p, { a: 1 })
  const first = statSync(p).ino
  await writeConfigFile(p, { a: 2 })
  const second = statSync(p).ino
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { a: 2 }, '覆盖后的内容必须是新的')
  if (!inodeSupported) {
    strictOk = skipNote(
      'verify-store（rename 替换的 inode 判据）',
      1,
      '本平台不提供 inode（statSync().ino 恒为 0）',
      '在提供 inode 的文件系统上重跑'
    ) && strictOk
    return false
  }
  assert.notEqual(first, second, '覆盖应通过 rename 换掉目录项，而不是原地截断重写')
})

await check('上次中断残留的 .tmp 会被下一次写入清理', async () => {
  const p = freshPath()
  writeFileSync(`${p}.tmp`, '{"half":', 'utf8') // 模拟上次写到一半被杀
  await writeConfigFile(p, { b: 2 })
  assert.equal(existsSync(`${p}.tmp`), false)
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { b: 2 })
  assert.equal(readFileSync(p, 'utf8').includes('half'), false, '不得把残留内容带进新文件')
})

await check('目标目录不存在时会自动创建（多级）', async () => {
  const p = join(root, 'nested', 'deep', 'config.json')
  await writeConfigFile(p, { c: 3 })
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { c: 3 })
})

await check('正常闭环：不存在 → 写入 → 再读回，全程无失败记录', async () => {
  const p = freshPath()
  const missing = await readConfigFile(p)
  assert.equal(missing.exists, false)
  assert.equal(configWriteRefusal(missing.failure, p), null)

  await writeConfigFile(p, { enabled: false, occupation: '工程师' })
  const back = await readConfigFile(p)
  assert.equal(back.failure, null)
  assert.deepEqual(back.value, { enabled: false, occupation: '工程师' })
})

// ---------- moveAsideConfigFile：损坏配置的逃生口（重置）----------

await check('移开损坏配置：原路径不再存在，备份逐字节一致，读取回到「首次运行」分支', async () => {
  const p = freshPath('moveaside')
  const damaged = '{"enabled": true, "nickname": "小'   // 截断的 JSON
  writeFileSync(p, damaged, 'utf8')

  // 先确认它就是「损坏」状态（否则后面的断言没有意义）
  const broken = await readConfigFile(p)
  assert.equal(broken.failure?.code, 'invalid-json')

  const target = await moveAsideConfigFile(p)
  assert.equal(target, corruptBackupPath(p), '备份路径应为 <file>.corrupt')
  assert.equal(existsSync(p), false, '原文件必须被移走——只复制不移开的话，重置仍会被判定为损坏而拒绝')
  assert.equal(readFileSync(target, 'utf8'), damaged, '备份必须逐字节一致')

  const after = await readConfigFile(p)
  assert.equal(after.exists, false, '移开后应回到「文件不存在」分支')
  assert.equal(after.failure, null, '移开后不得再报告失败')
  assert.equal(configWriteRefusal(after.failure, p), null, '移开后必须允许写入，否则重置依然被拒')
})

await check('移开后可以正常写入新配置（重置真正落盘）', async () => {
  const p = freshPath('moveaside-write')
  writeFileSync(p, 'not json at all', 'utf8')
  const target = await moveAsideConfigFile(p)
  assert.ok(target)

  await writeConfigFile(p, { enabled: true })
  const back = await readConfigFile(p)
  assert.equal(back.failure, null)
  assert.deepEqual(back.value, { enabled: true })
})

await check('文件不存在时移开返回 null，且不制造任何残留', async () => {
  const p = freshPath('moveaside-missing')
  assert.equal(await moveAsideConfigFile(p), null)
  assert.equal(existsSync(p), false)
  assert.equal(existsSync(corruptBackupPath(p)), false, '不该凭空造出备份文件')
})

await check('已有旧备份时会被本次内容覆盖（避免保留一份更早的损坏副本）', async () => {
  const p = freshPath('moveaside-overwrite')
  writeFileSync(corruptBackupPath(p), 'older backup', 'utf8')
  writeFileSync(p, 'newer damaged', 'utf8')

  const target = await moveAsideConfigFile(p)
  assert.equal(readFileSync(target, 'utf8'), 'newer damaged', '备份应反映最近一次被丢弃的内容')
  assert.equal(existsSync(p), false)
})

if (!assertCount('verify-store', passed, EXPECTED_ASSERTIONS)) process.exit(1)
if (!strictOk) {
  console.log('结果：有断言未执行（--strict 模式下按失败处理）。')
  process.exit(1)
}

console.log(`\n全部通过：${passed} 项检查`)
