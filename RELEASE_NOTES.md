# dsh-soul Release Notes

## v0.1.1

首个发布版本。为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置 Agent 的昵称、回复风格、语调与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

> 说明：本仓库目前只有一次提交（`01a2cfb initial dsh-soul`），该提交已包含以下全部实现。因此下文「新增 / 改进」的划分是**基于当前代码状态归纳的**，仓库内没有 diff 记录可用于区分「相对上一版新增」和「相对上一版改进」。

### 安装 / 升级

```powershell
dsh plugin --profile web add dsh-soul
dsh plugin --profile web update dsh-soul
```

### 功能

**设置页面**

- 在设置页新增「个性化」栏目（`settings.section`，order 50），并提供中英文文案。
- 启用 / 禁用个性化设置开关。
- 用户昵称输入，保存后 Agent 在回复中使用该称呼。
- 回复风格下拉：`professional`（专业严谨）、`casual`（轻松自然）、`friendly`（友好亲切）、`humorous`（幽默风趣）、`academic`（学术性）。
- 语调下拉：`neutral`（中性客观）、`formal`（正式礼貌）、`informal`（非正式、口语化）、`enthusiastic`（热情积极）、`calm`（平静沉稳）。
- 自定义指令文本域，内置 4 个示例模板（专业严谨 / 友好亲切 / 幽默风趣 / 简洁直接），点击即可填充。
- 「保存设置」「重置默认」按钮，成功后弹出居中 toast，2 秒自动消失；加载 / 保存期间禁用按钮，避免重复提交。
- 请求失败时在页面内展示错误条。

**斜杠命令**

```text
/soul show       查看当前配置
/soul reset      重置为默认值
/soul enable     启用个性化设置
/soul disable    禁用个性化设置
/soul <昵称>      设置昵称
```

### 已知限制

- 安装或升级后需要完全重启 DSH，并刷新浏览器页面，设置栏目才会出现。
- 保存配置后需要发送一条新消息才会生效：`agent.inject()` 面向下一次 Agent step，不会打断正在执行的模型请求，也不修改历史消息。
- `agents` 服务不可用时跳过注入，此时需要重启会话才能应用配置。
- 通过 `/soul <昵称>` 设置昵称时参数会被统一转为小写，中文与英文大小写混排的昵称建议使用设置页面填写。
- 仅支持 `web` 平台客户端。

### 兼容性

- `@deepseek-ai/cordis` `^4.0.1`
- `@deepseek-ai/dsh-llm` `^0.1.1-rc.2`

---
