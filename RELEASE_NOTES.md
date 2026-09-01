# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置「关于你」（昵称、职业、介绍）、回复风格和语调、特质、输出语言与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能总览

### 设置页面

- 在设置页新增「个性化」栏目（`settings.section`，order 50），并提供中英文文案。
- 启用 / 禁用个性化设置开关。
- **「关于你」**小节：用户昵称、用户职业、用户介绍，保存后 Agent 在回复中使用称呼并结合你的背景。
- **「特质」**小节，包含三个下拉（均带 ⓘ 提示图标）：
  - 回复风格和语调（合并为单一选项）：`professional`（专业严谨）、`casual`（轻松自然）、`humorous`（幽默风趣）、`roast`（吐槽达人）、`efficient`（高效干练）。
  - 标题和列表：`default`（默认）/ `more`（增强，采用清晰格式和列表结构）/ `less`（减弱，使用更多段落文本）。
  - 表情符号：`default`（默认）/ `more`（增强，使用较多表情符号）/ `less`（减弱，尽量减少使用表情符号）。
- 输出语言下拉（带 ⓘ 提示图标）：中文 / English，同时决定 Agent 回复语言与 `/soul` 命令输出语言。
- 自定义指令文本域（带 ⓘ 提示图标，提示不要重复设置风格语调类似话术）。
- 「保存设置」「重置默认」按钮，成功后弹出居中 toast，2 秒自动消失；加载 / 保存期间禁用按钮，避免重复提交。
- 请求失败时在页面内展示错误条。

### 斜杠命令

```text
/soul show       查看当前配置
/soul reset      重置为默认值
/soul enable     启用个性化设置
/soul disable    禁用个性化设置
/soul <昵称>      设置昵称（保留原始大小写）
```

命令输出语言跟随配置的 `language` 字段，提供中英文文案。

### 配置与集成

- 配置持久化到 `$DSH_HOME/soul-config.json`（未设置 `DSH_HOME` 时使用 DSH 默认用户数据目录）。
- 注册 `soulConfig` 服务，供其他插件调用：`getConfig()`、`updateConfig()`、`getSystemPrompt()`、`resetConfig()`。
- HTTP API：`GET/POST /api/soul/config`、`GET /api/soul/prompt`、`POST /api/soul/config/reset`。
- Agent 工具：`set_persona`，参数包含 `nickname` / `occupation` / `bio` / `style`（回复风格和语调）/ `headingLists` / `emoji` / `language` / `customInstructions`（均带合法值校验）；需要宿主安装 `@deepseek-ai/dsh-tools`（插件已声明依赖，若宿主版本不兼容或缺失则自动跳过，不影响其他功能）。
- 配置自动迁移与清理：旧版 `style`+`tone` 自动合并为新 `style`；已废弃的 `tone` / `presets` / `examples` 字段在加载时自动清理。

## 已知限制

- 安装或升级后需要完全重启 DSH，并刷新浏览器页面，设置栏目才会出现。
- 保存配置后需要发送一条新消息才会生效：`agent.inject()` 面向下一次 Agent step，不会打断正在执行的模型请求，也不修改历史消息。
- `agents` 服务不可用时跳过注入，此时需要重启会话才能应用配置。
- 仅支持 `web` 平台客户端。

## 兼容性

- `@deepseek-ai/cordis` `^4.0.1`
- `@deepseek-ai/dsh-llm` `^0.1.1-rc.2`
- `@deepseek-ai/dsh-tools` `^0.1.0-rc.6`（`set_persona` 工具需要；缺失或不兼容时插件其余功能照常可用）

---

## 版本历史

### v0.3.0（2026-09-01）

> v0.2.0 曾在仓库内规划但从未发布到 npm，版本号直接跳至 v0.3.0。本节记录 0.1.1 之后发布的全部变更。

#### 新增

- **模型可调用工具 `set_persona`**：通过 `@deepseek-ai/dsh-tools` 注册工具，允许 Agent 在对话中直接调整 `nickname` / `occupation` / `bio` / `style`（回复风格和语调）/ `headingLists` / `emoji` / `language` / `customInstructions`。若宿主缺少或不兼容 `dsh-tools`（要求 `^0.1.0-rc.6`），插件自动跳过注册，其他功能不受影响。
- **「关于你」**：新增 `occupation`（用户职业）与 `bio`（用户介绍）配置项，与昵称一起编译进 system prompt，Agent 结合你的背景作答；`/soul show` 输出新增「职业」「介绍」两行。
- **特质微调**：新增 `headingLists`（标题和列表）与 `emoji`（表情符号）两个配置项，在回复风格和语调的基础上叠加，均支持 `default`（默认）/ `more`（增强）/ `less`（减弱）三档：
  - 标题和列表：增强=采用清晰格式和列表结构，减弱=使用更多段落文本。
  - 表情符号：增强=使用较多表情符号，减弱=尽量减少使用表情符号。
  - 编译进 system prompt（Behavior 层），`default` 不产生额外指令。
- **输出语言进入系统提示词**：`language` 字段此前仅影响 `/soul` 命令输出文案，模型感知不到。现编译进 system prompt（Behavior 层），切换语言后 Agent 的回复语言随之生效。
- **`/soul` 命令输出国际化**：宿主端无 locale 服务（`CommandInvocation` 不携带 UI 语言），命令输出语言跟随配置的 `language` 字段，提供中英文案。
- **设置页改版**：
  - 「关于你」「特质」分组小标题，风格语调并入特质小节。
  - 关键字段标签旁新增 ⓘ 提示图标（白色 tooltip）：回复风格和语调、标题和列表、表情符号、输出语言、自定义指令。

#### 变更

- **回复风格和语调合并为单一选项**：原「回复风格」+「语调」两个下拉合并为一个，选项精简为 `professional`（专业严谨）、`casual`（轻松自然）、`humorous`（幽默风趣）、`roast`（吐槽达人，新增）、`efficient`（高效干练，新增）。
  - 配置文件不再写入 `tone` 字段；旧配置自动迁移（`professional+formal` → `professional`，`casual+neutral` → `casual`，`humorous+informal` → `humorous`，其余组合按旧 style 就近映射）。
  - `/soul show` 输出中「风格」「语调」两行合并为「风格语调」一行，并显示本地化标签。
- **发布流程改为 GitHub Release 触发**：`publish.yml` 由「推送 tag 触发」改为「网页发布 Release 触发」（tag 由 GitHub 在发布时自动创建），并增加幂等守卫（npm 已存在同版本时跳过而非 403 报错）。

#### 修复

- **用户背景被模型误认为自身身份**：「关于你」（昵称/职业/介绍）此前编译在 `[角色设定]` 标签下，且执行规则要求"严格遵守以上设定"，模型会把用户的职业和技术背景当成 Agent 自己的身份（如自称"作为一名网络安全工程师"）。现拆分为独立的 `[用户背景]` 块，开头声明"描述的是用户本人，不是你的身份"，执行规则同步改为"用用户背景理解用户、贴合用户需求作答，而不是把它当作你自己的身份"。
- **注入快照说明不全**：`[dsh-soul 个性化配置已更新]` 注入文本补充说明快照包含特质与输出语言，避免模型沿用旧的语言/特质行为。
- **`/soul` 设置昵称保留原始大小写**：此前 `rawInput` 被 `toLowerCase()` 后直接写入昵称，输入含大写字母的昵称会变成全小写；现关键字匹配仅用于命令分发，昵称写入保留原始大小写。
- **提示图标 tooltip 样式**：固定白色背景（不随深色主题变暗）；改为从图标处向右展开并提升层级，不再被设置页左侧导航遮挡。

#### 移除

- **提示词预览功能**：下线设置页「展开提示词预览」与宿主端 `POST /api/soul/prompt/preview` 端点。
- **人设预设功能**：下线设置页「人设预设」区域、宿主端 `POST /api/soul/presets` 端点与 `/soul save|use|list|delete` 子命令。
- **示例指令模板**：下线设置页「💡 示例指令（点击使用）」区域。
- 已废弃的 `tone` / `presets` / `examples` 配置字段在加载时自动清理。

#### 其他

- 新增 `@deepseek-ai/dsh-tools` 依赖（`^0.1.0-rc.6`）。
- `README.md` / `README_EN.md` / `PUBLISHING.md` 同步更新。

### v0.1.1（2026-08-29）

#### 修复

- **关闭个性化设置后旧人设残留**。0.1.0 中 `injectPromptToAllAgents()` 在编译出的提示词为空时直接 `return`，不向 Agent 注入任何内容，导致此前注入的昵称、角色、风格、语调继续生效。0.1.1 移除该提前返回，改为注入显式指令：

  ```text
  [dsh-soul 个性化配置已关闭]
  从现在开始不要使用 dsh-soul 之前注入的昵称、角色、回复风格或语调配置。
  请恢复使用 Agent 的默认行为。
  ```

- 注入快照的 `sections[].text` 同步为 `prompt || disabledText`，关闭个性化时也能正确覆盖旧快照。

#### 其他

- `client/index.mjs` 无改动。
- `package.json` 仅版本号变更。
- `README.md` 重写「配置文件」小节：由列出 `$DSH_HOME/soul-config.json` 及默认路径 `~/.dsh/soul-config.json`，改为统一描述为「DSH 用户数据目录下的 `soul-config.json`」。

### v0.1.0（2026-08-29）

首个发布版本，已包含「功能总览」中的全部能力：设置页「个性化」栏目、斜杠命令 `/soul`、三层架构提示词编译（Identity / Behavior / Style）、配置持久化与 HTTP API。

> 本仓库无 0.1.0 的代码记录，上述内容依据 npm 上 `dsh-soul@0.1.0` 的包内容确认。
