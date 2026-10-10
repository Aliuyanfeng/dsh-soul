// lib/store.mjs — dsh-soul 配置持久化（文件 IO，无 cordis 依赖）
//
// 职责：
//   - 读取配置文件，并把「文件不存在」与「文件存在但读不出来 / 不是合法 JSON」区分开
//   - 配置文件的原子写入（临时文件 + rename）
//   - 损坏文件的备份
//
// 本模块只负责如实报告结果，不替调用方决定如何回退；可被 scripts/verify-store.mjs
// 独立加载并针对真实文件系统测试。

import { readFile, writeFile, mkdir, rename, copyFile } from 'node:fs/promises'
import { dirname } from 'node:path'

// 损坏配置的备份路径（与配置文件同目录）
export function corruptBackupPath(filePath) {
  return `${filePath}.corrupt`
}

// 把损坏的配置文件另存为 <file>.corrupt，供用户找回内容。
// 备份失败返回 null 而不抛错 —— 备份是尽力而为，不能因为备份失败就让读取路径也失败。
async function backupCorruptFile(filePath) {
  const target = corruptBackupPath(filePath)
  try {
    await copyFile(filePath, target)
    return target
  } catch {
    return null
  }
}

// 把不可用的配置文件**移开**（而非复制），备份到 <file>.corrupt，返回备份路径。
//
// 与 backupCorruptFile 的差别只有一个，但这个差别很关键：移开之后原路径不再存在，
// 读取随即回到「首次运行」的正常分支。这是「重置」这类**刻意丢弃**动作需要的语义——
// 只复制而保留原文件的话，下一次读取仍会判定为损坏，于是重置依然被拒绝，
// 用户除手删文件外没有任何出路（这正是本函数存在的原因）。
//
// 目标已存在时会被 rename 覆盖（Node 在 Windows 用 MOVEFILE_REPLACE_EXISTING）。
// 文件本就不存在 / 移不动时返回 null —— 调用方据此判断是否真的腾出了位置。
export async function moveAsideConfigFile(filePath) {
  const target = corruptBackupPath(filePath)
  try {
    await rename(filePath, target)
    return target
  } catch {
    return null
  }
}

// 读取并解析配置文件，返回 { value, exists, failure }：
//
//   | 情况                     | value | exists | failure                          |
//   | ------------------------ | ----- | ------ | -------------------------------- |
//   | 文件不存在（首次运行）   | null  | false  | null（不算错误）                 |
//   | 读到且是合法 JSON        | 解析值| true   | null                             |
//   | 存在但读不出来（权限等） | null  | true   | { code:'unreadable' }            |
//   | 存在但不是合法 JSON      | null  | true   | { code:'invalid-json', backupPath} |
//
// failure 是「磁盘上的配置不可用」的如实报告 —— 调用方据此决定是否回退默认值，
// 以及是否拒绝后续写入。这里刻意不吞掉失败：静默回退会让调用方以为读到了一份
// 空配置，进而在下一次写入时把用户原有的配置整体覆盖掉。
export async function readConfigFile(filePath) {
  let text
  try {
    text = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { value: null, exists: false, failure: null }
    }
    return {
      value: null,
      exists: true,
      failure: {
        code: 'unreadable',
        message: `配置文件读取失败（${(err && err.code) || 'unknown'}）：${(err && err.message) || err}`,
        backupPath: null
      }
    }
  }

  try {
    return { value: JSON.parse(text), exists: true, failure: null }
  } catch (err) {
    return {
      value: null,
      exists: true,
      failure: {
        code: 'invalid-json',
        message: `配置文件不是合法的 JSON（${(err && err.message) || err}）`,
        backupPath: await backupCorruptFile(filePath)
      }
    }
  }
}

// 把读取失败翻译成用户可读的说明（含损坏文件的备份位置）
export function describeConfigFailure(failure) {
  if (!failure) return null
  const backup = failure.backupPath ? `（原文件已备份到 ${failure.backupPath}）` : ''
  return `${failure.message}${backup}`
}

// 在这份失败之上能否写入：返回 null 表示可以写，返回字符串表示应拒绝并原样展示该原因。
//
// 判定下沉在这里（而不是散在调用方），是为了让「损坏的配置绝不会被静默覆盖」这条
// 规则只有一处实现 —— 写路径有 HTTP 保存 / 斜杠命令 / 工具 / 服务四条。
export function configWriteRefusal(failure, filePath) {
  if (!failure) return null
  return `${describeConfigFailure(failure)}。为避免覆盖，本次保存已拒绝；请修复或删除 ${filePath} 后重试。`
}

// 原子写入配置：先写同目录的临时文件，再 rename 覆盖。
//
// 同目录 rename 是原子替换（Windows 的 MoveFileEx 亦带 REPLACE_EXISTING），
// 因此文件要么是旧的完整内容、要么是新的完整内容。直接 writeFile 在写到一半
// 进程被杀时会留下**截断的 JSON**，整份配置随即不可解析。
//
// 临时文件名固定（不带随机后缀）：写入统一经由 index.mjs 的写队列串行执行，
// 不存在并发同名临时文件；固定名还能让中断残留的 .tmp 在下次写入时被覆盖。
export async function writeConfigFile(filePath, config) {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf8')
  await rename(tmpPath, filePath)
}
