# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置「关于你」（昵称、职业、介绍）、回复风格和语调、特质、输出语言与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能

**设置页**
- 启用开关、「关于你」（昵称 / 职业 / 介绍）、「特质」（回复风格和语调 / 标题和列表 / 表情符号）、输出语言、自定义指令
- 关键字段带 ⓘ 提示图标；保存 / 重置按钮带 toast；失败时页面内展示错误条

**斜杠命令**（输出语言跟随配置 `language`，中英文案）

```text
/soul show       查看当前配置
/soul reset      重置默认值
/soul enable     启用
/soul disable    禁用
/soul <昵称>      设置昵称（保留原始大小写）
```

**配置与集成**
- 持久化：`$DSH_HOME/soul-config.json`
- 服务：`soulConfig`（`getConfig` / `updateConfig` / `getSystemPrompt` / `resetConfig`）
- HTTP API：`/api/soul/config`（GET/POST）、`/api/soul/prompt`、`/api/soul/config/reset`
- Agent 工具：`set_persona`（需宿主安装 `@deepseek-ai/dsh-tools`；缺失或不兼容时自动跳过，其余功能不受影响）

## 已知限制

- 安装 / 升级后需完全重启 DSH 并刷新浏览器，设置栏目才会出现
- 保存配置后需发送一条新消息才生效：`agent.inject()` 面向下一次 Agent step，不打断进行中的请求，也不改写历史消息
- `agents` 服务不可用时跳过注入，需重启会话才能应用配置
- 仅支持 `web` 平台客户端

## 兼容性

- `@deepseek-ai/cordis` `^4.0.1`
- `@deepseek-ai/dsh-llm` `^0.1.1-rc.2`
- `@deepseek-ai/dsh-tools` `^0.1.0-rc.6`

---

## 版本历史

### v0.3.2（2026-09-01）

**变更**
- `package.json` 新增 `keywords` 字段（`dsh` / `dsh-plugin` / `deepseek` / `deepseek-harness` / `personalization` / `persona` / `system-prompt` / `customization` / `ai-agent` / `ai-assistant`），便于 npm 与 awesome-dsh-plugin 检索

### v0.3.1（2026-09-01）

**变更**
- `@deepseek-ai/dsh-tools` 由 `dependencies` 调整为 `peerDependencies`，对齐 awesome-dsh-plugin 收录要求；运行时仍按宿主版本动态 import + 守卫加载，缺失或不兼容时跳过 `set_persona` 工具注册，其余功能不受影响

**文档**
- README / README_EN 新增「截图」章节（设置页 + `/soul` 命令，共 4 张），托管于 `screenshots/`

### v0.3.0（2026-09-01）

> v0.2.0 曾规划但未发布，版本号直接跳至此。

**新增**
- `set_persona` 工具：Agent 在对话中直接调整 `nickname` / `occupation` / `bio` / `style` / `headingLists` / `emoji` / `language` / `customInstructions`
- 「关于你」：`occupation`、`bio` 编译进提示词，Agent 结合你的背景作答
- 特质微调：`headingLists`、`emoji` 各三档（默认 / 增强 / 减弱），与回复风格和语调叠加
- 输出语言进提示词：切换语言后 Agent 回复语言随之生效
- `/soul` 命令输出跟随配置 `language`，中英文案
- 设置页分组改版（关于你 / 特质小标题）与字段 ⓘ 提示图标

**变更**
- 回复风格和语调合并为单一选项：`professional` / `casual` / `humorous` / `roast` / `efficient`；旧 `style`+`tone` 配置自动迁移
- 发布流程改为 GitHub Release 触发（tag 由 GitHub 在发布时自动创建），新增同版本幂等守卫

**修复**
- 用户背景被模型误认为自身身份：「关于你」拆分为独立 `[用户背景]` 块，提示这是用户本人的信息
- 注入快照说明补全（含特质与输出语言）
- `/soul` 设置昵称保留原始大小写
- 提示图标 tooltip：白底 + 右展开 + 高层级，避免被左侧导航遮挡

**移除**
- 提示词预览功能、人设预设功能、示例指令模板；废弃字段 `tone` / `presets` / `examples` 加载时自动清理

### v0.1.1（2026-08-29）

**修复**
- 关闭个性化后旧人设残留：移除「空提示词直接 return」分支，改为注入显式关闭指令

### v0.1.0（2026-08-29）

首个发布版本，已包含「功能」中的全部能力。仓库 git 历史晚于该版本发布日，无代码记录。