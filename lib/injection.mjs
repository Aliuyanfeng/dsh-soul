// lib/injection.mjs — 会话注入消息的 source 构造（纯函数，零依赖）
//
// 背景（issue #1）：DSH 0.1.7 把会话格式升到 v4 后，**废弃了共享的
// `kind: 'plugin'` + `plugin` 字段组合**，要求每个生产者声明自己的 kind，
// 并显式拒绝字面量 'plugin'：
//
//   @deepseek-ai/dsh-session-format-v3-to-v4 的来源准入
//     if (typeof value.kind !== 'string' || value.kind.length === 0 || value.kind === 'plugin')
//       throw new SessionFormatError('format v4 message requires a producer-owned source kind')
//
// dsh-llm 的消息类型亦注明：kind 是可合并扩展的联合类型，
// 「没有共享的 catch-all plugin kind」。
//
// 未声明自持 kind 时，注入（面向所有活动会话、并在下一次 step 被读取）会把
// **每一轮**都打成失败：`format v4 message requires a producer-owned source kind`。
//
// 因此这里统一构造合规来源，并由 scripts/verify-compat.mjs 对着**实际安装的
// DSH 校验器**做回归验证——避免只改代码、不验契约。

// 生产者自持 kind。
// 取 `plugin:dsh-soul` 而非裸名，是为了与 DSH 自带 v3→v4 迁移对第三方插件生成的
// `plugin:${plugin}`（producerKind 的回落分支）保持一致：升级前后的历史事件与
// 新增事件归属同一个生产者，而不是在同一个会话里出现两个身份。
const INJECTION_PRODUCER_KIND = 'plugin:dsh-soul'

// 快照区块名，与 systemPrompt section 的 name 对应
const INJECTION_SECTION_NAME = 'soul:persona'

/**
 * 构造注入消息的 source：自持 kind + snapshot 形态 + 命名区块。
 *
 * 不要再补 `plugin` 字段：v4 的迁移会主动丢弃它（rewritePluginSource 过滤掉
 * `plugin` 键），保留只会在日志里留下一份易混淆的重复归属。
 *
 * @param snapshotText - 注入给模型的快照文本（同时用作快照区块内容）。
 * @returns 符合会话格式 v4 的来源记录。
 */
export function createInjectionSource(snapshotText) {
  return {
    kind: INJECTION_PRODUCER_KIND,
    form: 'snapshot',
    sections: [{ name: INJECTION_SECTION_NAME, text: snapshotText }]
  }
}
