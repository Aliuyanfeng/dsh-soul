# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置 Agent 的昵称、回复风格、语调与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能总览

### 设置页面

- 在设置页新增「个性化」栏目（`settings.section`，order 50），并提供中英文文案。
- 启用 / 禁用个性化设置开关。
- 用户昵称输入，保存后 Agent 在回复中使用该称呼。
- 回复风格下拉：`professional`（专业严谨）、`casual`（轻松自然）、`friendly`（友好亲切）、`humorous`（幽默风趣）、`academic`（学术性）。
- 语调下拉：`neutral`（中性客观）、`formal`（正式礼貌）、`informal`（非正式、口语化）、`enthusiastic`（热情积极）、`calm`（平静沉稳）。
- 自定义指令文本域，内置 4 个示例模板（专业严谨 / 友好亲切 / 幽默风趣 / 简洁直接），点击即可填充。
- 「保存设置」「重置默认」按钮，成功后弹出居中 toast，2 秒自动消失；加载 / 保存期间禁用按钮，避免重复提交。
- 请求失败时在页面内展示错误条。

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

> 本仓库的 git 历史始于 2026-08-31，晚于 npm 上 0.1.0 / 0.1.1 的发布时间（2026-08-29），因此仓库内没有 0.1.0 的代码记录。以下版本间的变更通过对比 npm 上 `dsh-soul@0.1.0` 与 `dsh-soul@0.1.1` 两个 tarball 得出。

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
