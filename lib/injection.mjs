// lib/injection.mjs — 会话注入消息的 source 构造（纯函数，零依赖）
//
// ═══════════════════════════════════════════════════════════════════════
// 为什么「配置送达」还需要注入，而不是只靠 systemPrompt.section
// ═══════════════════════════════════════════════════════════════════════
//
// 实测结论：**只靠 section 时，「会话进行中改配置」不生效**（0.7.1 曾删掉注入，
// 被用户实测打回，随后恢复）。
//
// 宿主源码验证（DSH 0.2.x，`dsh-agent-loop/lib/index.js`）：
//
//   ① `preStep()` 每个 step 都装配一次 —— 所以 section.text 确实是**每步求值**的：
//        const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(...))
//
//   ② 但 section 的产物经 `renderPrompt(assembly)` 变成 **system message**：
//        const renderedPrompt = renderPrompt(assembly)
//      system message 一旦进入会话历史就**固定**了 —— 后面每步算出的新文本
//      不会改写已经发出的那一条。这是「改了配置不生效」最可能的成因。
//
//   ③ `context` 走的是另一条路：
//        const sections = renderContextSections(
//          this.loopCtx.systemPrompt.refreshContext(assembly, assembleContextFor(...)))
//        const context = this.runtimeContext.project(joinContextSections(sections), sections)
//      它在**每次模型请求前**刷新（官方描述：refresh ... for request admission），
//      产物是独立的运行时投影，不依赖 system message 重新提交。
//
// ─── 那为什么不改用 systemPrompt.context ───
//
// 它确实更强，也有出厂先例（`dsh-sandbox-policy` 用 `context({ name: "sandbox:policy" })`，
// 第三方可用）。当前不换，理由：
//   1. 注入已在工作（verify-e2e-prompt 的 E13/E16 钉住两条通道都健在）。换通道的
//      失败方向是「人格消失」或「模型看到两份冲突的人格文本」，比现状更糟；
//   2. `context` 的语义是「运行时事实」，而人格是系统提示性质的内容。若被
//      `suppressRuntimeContext()` 抑制，人格就没了（可注册 `required: true` 兜底，
//      但那又会引入新的行为差异）；
//   3. 尚未端到端验证 —— 复现「会话进行中」需要跑完整 agent loop。
//
// ─── 将来若「不生效」再次复现，首选方案是双通道分工而非简单替换 ───
//
//   section → 人格全文（稳定内容，语义正确，参与 system prompt）
//   context → 只放「配置版本戳 / 本轮变更字段摘要」，并注册 required: true
//
// 这样人格主体不重复；「刚改了什么」由 context 每请求投影，不依赖历史里的
// system message。查证入口：dsh-system-prompt 的 `resolveContext` / `renderContextSections`
// / `refreshContext`，以及 dsh-agent-loop 的 `preStep` 与 `executeStep`。
//
// ═══════════════════════════════════════════════════════════════════════
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
