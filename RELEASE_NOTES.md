# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置 Agent 的昵称、回复风格、语调与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能总览

### 设置页面

- 在设置页新增「个性化」栏目（`settings.section`，order 50），并提供中英文文案。
- 启用 / 禁用个性化设置开关。
- 用户昵称输入，保存后 Agent 在回复中使用该称呼。
- 回复风格下拉：`professional`（专业严谨）、`casual`（轻松自然）、`friendly`（友好亲切）、`humorous`（幽默风趣）、`academic`（学术性）。
- 语调下拉：`neutral`（中性客观）、`formal`（正式礼貌）、`informal`（非正式、口语化）、`enthusiastic`（热情积极）、`calm`（平静沉稳）。
- 命令输出语言下拉：中文 / English。宿主端无 locale 服务（`CommandInvocation` 不携带 UI 语言），`/soul` 命令输出语言跟随配置的 `language` 字段，默认 `zh`。
- 自定义指令文本域，内置 4 个示例模板（专业严谨 / 友好亲切 / 幽默风趣 / 简洁直接），点击即可填充。
- 「保存设置」「重置默认」按钮，成功后弹出居中 toast，2 秒自动消失；加载 / 保存期间禁用按钮，避免重复提交。
- 请求失败时在页面内展示错误条。
- **提示词实时预览**：设置页可展开当前编辑编译后的 system prompt，编辑停止 400ms 后自动刷新。
- **人设预设管理**：在设置页保存 / 应用 / 删除预设；斜杠命令 `/soul save|use|list|delete` 也支持相同操作。
- **模型可调用工具 `set_persona`**：当用户明确要求改变称呼、语气、风格或角色时，Agent 可直接调用该工具更新个性化设置。

### 斜杠命令

```text
/soul show                查看当前配置
/soul reset               重置为默认值
/soul enable              启用个性化设置
/soul disable             禁用个性化设置
/soul <昵称>               设置昵称
/soul save <名称>          保存当前人设为预设
/soul use <名称>           应用预设
/soul list                列出预设
/soul delete <名称>        删除预设
```

### 配置与集成

- 配置持久化到 `$DSH_HOME/soul-config.json`（未设置 `DSH_HOME` 时使用 DSH 默认用户数据目录）。
- 注册 `soulConfig` 服务，供其他插件调用：`getConfig()`、`updateConfig()`、`getSystemPrompt()`、`resetConfig()`。
- HTTP API：`GET/POST /api/soul/config`、`GET /api/soul/prompt`、`POST /api/soul/config/reset`、`POST /api/soul/prompt/preview`、`POST /api/soul/presets`（`save` / `apply` / `delete`）。
- Agent 工具：`set_persona`，参数包含 `nickname` / `style` / `tone` / `customInstructions`；需要宿主安装 `@deepseek-ai/dsh-tools`（插件已声明依赖，若宿主版本不兼容或缺失则自动跳过，不影响其他功能）。

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

- **提示词实时预览**：设置页新增「展开/收起提示词预览」，编辑字段停止 400ms 后通过 `POST /api/soul/prompt/preview` 请求宿主编译当前 draft，实时展示 system prompt 文本。
- **人设预设管理**：
  - 设置页新增「人设预设」区域，可保存当前编辑为人设预设、应用或删除已有预设。
  - 新增 `POST /api/soul/presets` 端点，支持 `save` / `apply` / `delete` 三种动作；`save` 可接受未保存的 draft，实现「先编辑再存预设」。
  - `/soul` 斜杠命令扩展：`/soul save <名称>`、`/soul use <名称>`、`/soul list`、`/soul delete <名称>`。
- **模型可调用工具 `set_persona`**：通过 `@deepseek-ai/dsh-tools` 注册工具，允许 Agent 在对话中直接调整 nickname / style / tone / customInstructions。若宿主缺少或不兼容 `dsh-tools`，插件自动跳过注册，其他功能不受影响。

#### 其他

- 新增 `@deepseek-ai/dsh-tools` 依赖（`^0.1.0-rc.6`）。
- `README.md` / `README_EN.md` 补充实时预览、预设管理、Agent 工具说明。

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
