# dsh-soul

[简体中文](./README.md) | [English](./README_EN.md)

DeepSeek Harness 个性化设置插件，用于配置 Agent 的昵称、回复风格、语调和自定义指令。

## 功能

- Web UI 个性化设置页面
- 启用或禁用个性化设置
- 设置用户昵称
- 选择回复风格和语调（合并为单一选项）：`professional`（专业严谨）、`casual`（轻松自然）、`humorous`（幽默风趣）、`roast`（吐槽达人）、`efficient`（高效干练）
- 选择输出语言（Agent 回复语言 + `/soul` 命令输出语言）：中文 / English
- 输入自定义指令和使用示例模板
- Agent 可调用工具 `set_persona`，让模型在对话中直接调整人设
- 配置持久化保存
- 配置更新后同步到所有活动 Agent

## 安装

```powershell
dsh plugin --profile web add dsh-soul
dsh --profile web web
```

插件配置由 `cordis.patch.yml` 提供：

```yaml
- insert:
    - id: soul
      name: dsh-soul
```

## 使用

启动 DSH 后，进入设置页面中的「个性化设置」栏目，修改配置并点击「保存设置」。

也可以使用斜杠命令：

```text
/soul show       查看当前配置
/soul reset      重置配置
/soul enable     启用个性化设置
/soul disable    禁用个性化设置
/soul 小明       设置昵称
```

配置保存后会同步到所有活动 Agent，当前会话下一次请求即可使用最新配置。

Agent 也可以通过工具 `set_persona` 在对话中直接调整你的人设（昵称、回复风格和语调、回复语言、自定义指令）。模型只会在明确请求改变称呼、语气、风格或语言时调用该工具。

## 配置文件

插件将配置保存到 DSH 的用户数据目录，文件名为：

```text
soul-config.json
```

配置示例：

```json
{
  "enabled": true,
  "nickname": "小明",
  "style": "professional",
  "language": "zh",
  "customInstructions": "请保持简洁，优先给出结论。"
}
```

## 实现原理

插件通过 `compilePrompt()` 将昵称、风格、语调和自定义指令编译成 system prompt，并注册到 DSH：

```js
spCtx.systemPrompt.section({
  name: 'soul:persona',
  order: 0,
  text: () => compilePrompt(configCache || DEFAULT_CONFIG)
})
```

配置更新后，插件会遍历所有活动 Agent，使用标准 `UserMessage` 调用 `agent.inject()`：

```js
agent.inject(createUserMessage({
  content: [{ type: 'text', text: prompt }],
  source: {
    kind: 'plugin',
    plugin: 'dsh-soul',
    form: 'snapshot',
    sections: [{ name: 'soul:persona', text: prompt }]
  }
}))
```

`agent.inject()` 会将最新配置放入 Agent 的待处理上下文，在下一次请求中生效；不会主动触发新请求，也不会修改历史消息。

## 许可证

MIT License
