# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置 Agent 的昵称、回复风格和语调、自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能总览

### 设置页面

- 在设置页新增「个性化」栏目（`settings.section`，order 50），并提供中英文文案。
- 启用 / 禁用个性化设置开关。
- 用户昵称输入，保存后 Agent 在回复中使用该称呼。
- 回复风格和语调下拉（合并为单一选项）：`professional`（专业严谨）、`casual`（轻松自然）、`humorous`（幽默风趣）、`roast`（吐槽达人）、`efficient`（高效干练）。标签旁提供 ⓘ 提示图标，hover 展示说明。
- 命令输出语言下拉：中文 / English。宿主端无 locale 服务（`CommandInvocation` 不携带 UI 语言），`/soul` 命令输出语言跟随配置的 `language` 字段，默认 `zh`。
- 自定义指令文本域。
- 「保存设置」「重置默认」按钮，成功后弹出居中 toast，2 秒自动消失；加载 / 保存期间禁用按钮，避免重复提交。
- 请求失败时在页面内展示错误条。
- **模型可调用工具 `set_persona`**：当用户明确要求改变称呼、语气、风格或角色时，Agent 可直接调用该工具更新个性化设置。

### 斜杠命令

```text
/soul show       查看当前配置
/soul reset      重置为默认值
/soul enable     启用个性化设置
/soul disable    禁用个性化设置
/soul <昵称>      设置昵称
```

### 配置与集成

- 配置持久化到 `$DSH_HOME/soul-config.json`（未设置 `DSH_HOME` 时使用 DSH 默认用户数据目录）。
- 注册 `soulConfig` 服务，供其他插件调用：`getConfig()`、`updateConfig()`、`getSystemPrompt()`、`resetConfig()`。
- HTTP API：`GET/POST /api/soul/config`、`GET /api/soul/prompt`、`POST /api/soul/config/reset`。
- Agent 工具：`set_persona`，参数包含 `nickname` / `style`（回复风格和语调）/ `customInstructions`；需要宿主安装 `@deepseek-ai/dsh-tools`（插件已声明依赖，若宿主版本不兼容或缺失则自动跳过，不影响其他功能）。

## 已知限制

- 安装或升级后需要完全重启 DSH，并刷新浏览器页面，设置栏目才会出现。
- 保存配置后需要发送一条新消息才会生效：`agent.inject()` 面向下一次 Agent step，不会打断正在执行的模型请求，也不修改历史消息。
- `agents` 服务不可用时跳过注入，此时需要重启会话才能应用配置。
- 仅支持 `web` 平台客户端。

## 兼容性

- `@deepseek-ai/cordis` `^4.0.1`
- `@deepseek-ai/dsh-llm` `^0.1.1-rc.2`

---

## 版本历史

### v0.2.0（未发布）

#### 新增

- **模型可调用工具 `set_persona`**：通过 `@deepseek-ai/dsh-tools` 注册工具，允许 Agent 在对话中直接调整 nickname / style（回复风格和语调）/ customInstructions。若宿主缺少或不兼容 `dsh-tools`，插件自动跳过注册，其他功能不受影响。

#### 变更

- **回复风格和语调合并为单一选项**：原「回复风格」+「语调」两个下拉合并为一个「回复风格和语调」，选项精简为 `professional`（专业严谨）、`casual`（轻松自然）、`humorous`（幽默风趣）、`roast`（吐槽达人）、`efficient`（高效干练）。
  - 配置文件不再写入 `tone` 字段；旧配置自动迁移（`professional+formal` → `professional`，`casual+neutral` → `casual`，`humorous+informal` → `humorous`，其余组合按旧 style就近映射）。
  - `set_persona` 工具的 `style` 参数随之更新为上述五个取值，`tone` 参数移除。
  - `/soul show` 输出中「风格」「语调」两行合并为「风格语调」一行，并显示本地化标签。
- **输出语言进入系统提示词**：`language` 字段此前仅影响 `/soul` 命令输出文案，模型感知不到。现编译进 system prompt（Behavior 层），切换语言后 Agent 的回复语言随之生效；`set_persona` 工具新增 `language` 参数（`zh` / `en`）。设置页该字段更名为「输出语言 / Output language」。
- **特质微调**：新增 `headingLists`（标题和列表）与 `emoji`（表情符号）两个配置项，在回复风格和语调的基础上叠加额外特质，均支持 `default`（默认）/ `more`（增强）/ `less`（减弱）三档：
  - 标题和列表：增强=采用清晰格式和列表结构，减弱=使用更多段落文本。
  - 表情符号：增强=使用较多表情符号，减弱=尽量减少使用表情符号。
  - 编译进 system prompt（Behavior 层），`default` 不产生额外指令。
  - `set_persona` 工具新增对应参数（带合法值校验），`/soul show` 输出新增「特质」一行。
  - 设置页新增两个下拉（均带 ⓘ 提示图标），配置加载时对脏值自动回退为默认。
- **选项提示图标**：「回复风格和语调」标签旁新增 ⓘ 小图标，hover 展示说明：「设置 Agent 回复你的风格和语调。这不会影响 Agent 的功能。」

#### 移除

- **提示词预览功能**：下线设置页「展开提示词预览」与宿主端 `POST /api/soul/prompt/preview` 端点。
- **人设预设功能**：下线设置页「人设预设」区域、宿主端 `POST /api/soul/presets` 端点与 `/soul save|use|list|delete` 子命令；旧配置文件中的 `presets` 字段在加载时自动清理。
- **示例指令模板**：下线设置页「💡 示例指令（点击使用）」区域与配置中的 `examples` 字段（加载时自动清理）。

#### 其他

- 新增 `@deepseek-ai/dsh-tools` 依赖（`^0.1.0-rc.6`）。
- `README.md` / `README_EN.md` 同步更新功能说明与配置示例。

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
