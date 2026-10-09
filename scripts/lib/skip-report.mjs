// scripts/lib/skip-report.mjs — 「跳过」的统一语义
//
// 为什么需要它：verify-trail / verify-nav-icon 在没有可用浏览器时、verify-e2e /
// verify-live-prompt / verify-compat 在定位不到 DSH 时都会**跳过**并返回 0。它们串在
// `npm run verify` 的 `&&` 链里，于是最终输出看起来一片绿 —— 实际有几十项断言根本没跑。
// 这是最误导人的一种报告：它把「没有验证」显示成了「验证通过」。
//
// 约定：
//   1. 跳过时必须显式打印「有 N 项断言本次未执行」，而不是静默退出 0；
//   2. 传 `--strict` 时跳过按失败处理（rc=1），供「本机本该有浏览器 / 本该有 DSH」的场景；
//   3. 断言数量由各脚本自己声明（`EXPECTED_ASSERTIONS`），并在真正跑完时用
//      `assertCount` 校验 —— 脚本加了断言却忘了更新数字时，跑得起来的那一次会失败，
//      从而保证跳过提示里的数字不会悄悄变成谎话。

/** 是否处于 --strict（跳过即失败）。 */
export function strictMode() {
  return process.argv.includes('--strict')
}

/**
 * 跳过并以统一格式说明「本次没有验证什么」。
 * @param {string} tool 脚本名（用于报告）
 * @param {number} assertions 本次未执行的断言数
 * @param {string} reason 跳过原因（要能指导用户怎么补跑）
 * @param {string} [hint] 补跑方式
 */
export function skipExit(tool, assertions, reason, hint) {
  console.log('')
  console.log(`  ⚠ 跳过 ${tool}：${reason}`)
  console.log(`    → 本次有 ${assertions} 项断言**未执行**。跳过不等于通过。`)
  if (hint) console.log(`    → 补跑：${hint}`)
  if (strictMode()) {
    console.log('结果：跳过（--strict 模式下按失败处理）。')
    process.exit(1)
  }
  console.log('结果：跳过（不算通过）。加 --strict 可让跳过直接失败。')
  process.exit(0)
}

/**
 * 校验实际跑出的断言数与脚本声明的数量一致。
 * @returns {boolean} 一致为 true；不一致时已打印说明，调用方应判失败。
 */
export function assertCount(tool, actual, declared) {
  if (actual === declared) return true
  console.log('')
  console.log(`  ✗ ${tool} 的断言数与脚本声明不一致：实际 ${actual} 项，声明 ${declared} 项。`)
  console.log('    本次运行并不可信；请把脚本里的 EXPECTED_ASSERTIONS 更新为实际值后重跑')
  console.log('    （跳过提示与 --strict 的判定都依赖这个数字）。')
  return false
}
