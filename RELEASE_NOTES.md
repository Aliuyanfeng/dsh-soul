# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置「关于你」（昵称、职业、介绍）、回复风格和语调、特质、输出语言与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能

**设置页**
- 启用开关、「关于你」（昵称 / 职业 / 介绍）、「特质」（回复风格和语调 / 标题和列表 / 表情符号）、输出语言、自定义指令
- 人设预设分组：保存当前为预设、一键使用（★ 标记当前匹配项）、删除（二次确认）
- Agent 工具分组：`set_persona` 确认模式开关
- 关键字段带 ⓘ 提示图标；保存 / 重置按钮带 toast；失败时页面内展示错误条
- 中英双语文案（跟随界面语言）；dirty 检测（无改动禁用保存 + 未保存提示）；保存结果区分「已保存 / 无变化」
- 「查看当前生效提示词」折叠区：展示当前已保存配置编译出的 system prompt 与字符数（只读）

**斜杠命令**（输出语言跟随配置 `language`，中英文案）

```text
/soul show        查看当前配置（含确认模式与预设数量）
/soul set k=v     修改配置项（如 /soul set style=humorous language=en）
/soul save <名>   保存当前配置为人设预设
/soul use <名>    应用人设预设
/soul list        查看人设预设（✔ 标记当前匹配项）
/soul del <名>    删除人设预设（delete / rm 别名）
/soul confirm     应用待确认的人设变更（确认模式）
/soul reject      拒绝待确认的人设变更
/soul reset       重置默认值（保留人设预设库）
/soul enable      启用
/soul disable     禁用
/soul <昵称>      设置昵称（保留原始大小写）
```

**配置与集成**
- 持久化：`$DSH_HOME/soul-config.json`（人设预设存于同文件 `personas` 字段）
- 服务：`soulConfig`（`getConfig` / `updateConfig` / `getSystemPrompt` / `resetConfig`）
- HTTP API：`/api/soul/config`（GET/POST）、`/api/soul/prompt`、`/api/soul/config/reset`、`/api/soul/personas`（GET）、`/api/soul/personas/save|use|delete`（POST）
- 输入校验：字段白名单、类型、长度上限与枚举校验，HTTP 保存 / `/soul` 命令 / `set_persona` 工具 / `soulConfig` 服务共用；非法或超限字段整单拒绝
- Agent 工具：`set_persona`（需宿主安装 `@deepseek-ai/dsh-tools`；缺失或不兼容时自动跳过，其余功能不受影响；确认模式下返回 `pending` 提议）

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

### v0.5.0（2026-09-02）

**修复**
- 暗色主题下「特质」等 `<select>` 原生下拉弹层白底白字（除选中项外选项不可读）：利用宿主主题呈现器投影的 `body[data-ds-dark-theme]` 暗色标志，以纯 CSS 属性选择器把 `color-scheme` 应用到设置栏目容器与 `select`（原生弹层、滚动条随主题切换，无需 JS 监听）；选项文字用主题变量 `--dsw-alias-label-primary` 着色（不再给 option 设 `background-color`，避免在 Chromium 上让弹层画布脱离 `color-scheme` 控制）
- 顺带修正在客户端 CSS 中误用的几个 DSW 主题变量名：`--dsw-alias-bg-l1`（实际应为 `--dsw-alias-bg-layer-1`，导致设置栏、select/textarea/input 关闭态、提示词面板背景在暗色下退化为 UA 默认色）、以及 `.soul-error` / `.soul-persona-danger` / `:focus` 中的若干杜撰 token（`bg-danger` / `border-danger` / `label-danger` / `border-focus` / `border-focus-alpha`），改为已核实的 `--dsw-alias-bg-layer-1` / `--dsw-alias-label-error` / `--dsw-alias-brand-primary`（外环用 `color-mix` 叠 25% 透明）

**新增**
- 人设预设：多套命名人设一键切换，覆盖昵称/职业/介绍/回复风格/特质/输出语言/自定义指令 8 个字段（`enabled` 全局开关不进入预设）
  - 斜杠命令：`/soul save <名称>`、`/soul use <名称>`、`/soul list`（✔ 标记当前匹配项）、`/soul del <名称>`（`delete` / `rm` 别名）
  - HTTP API：`GET /api/soul/personas`、`POST /api/soul/personas/save|use|delete`（名称 1-30 字符，拒绝保留键防原型污染）
  - 持久化于 `soul-config.json` 的 `personas` 字段；预设库增删改不触发会话注入；`/soul reset` 与「重置默认」保留预设库
- `/soul set`：键值方式修改配置项（如 `/soul set style=humorous language=en`、`/soul set enabled=true`；不含 `=` 的 token 追加到上一个值，支持含空格的文本值）
- `set_persona` 确认模式：新增配置项 `requireToolConfirmation`——开启后 Agent 的人设修改返回待确认提议（工具输出新增 `pending` 字段）而不落盘，用户以 `/soul confirm` 应用、`/soul reject` 拒绝；`/soul show` 显示确认模式状态、预设数量与待确认提示
- `readJsonBody` 请求体读取统一助手（413 / 400 语义）复用于全部 POST 端点；`verify-config.mjs` 新增人设预设与确认模式用例

### v0.4.0（2026-09-02）

**新增**
- 变更检测：写队列统一 diff 出 `changed` 字段列表，配置无实际变化时跳过系统提示词刷新与 `agent.inject()`——反复保存不再向会话堆积注入快照消息；`POST /api/soul/config` 响应新增 `changed` 字段
- 设置页「查看当前生效提示词」：只读展示当前已保存配置编译出的 system prompt 与字符数，保存后自动刷新（v0.2.0 移除的预览能力以只读形式回归）
- 设置页 dirty 检测：表单与已存配置逐字段比对，无改动时禁用「保存」按钮并显示未保存提示；保存 toast 区分「已保存 / 配置无变化」
- 设置页文案中英双语：全部 UI 文案改由宿主 locale 词典渲染（随界面语言切换），导航 label 同步本地化，图标替换按双语 label 匹配
- 提示词随输出语言本地化：`compilePrompt` 与会话注入消息、`set_persona` 返回文案按 `config.language` 使用中英两套文案表（`PROMPT_TEXT`），英文配置下 system prompt 为纯英文描述

**变更**
- 清理三层架构死代码：移除从未被引用的 `IdentityLayer.roles` / `BehaviorLayer.rules` / `StyleLayer.templates`，提示词构建重构为 `PROMPT_TEXT` + `buildUserProfile` / `buildBehavior` / `compilePrompt`；中文配置下编译结果与旧版逐字一致
- `commitConfig` 返回 `{ config, changed }`；`soulConfig.updateConfig` / `resetConfig` 服务返回值保持为配置对象

### v0.3.3（2026-09-02）

**修复**
- 配置写入输入校验：新增 `lib/config.mjs` 配置层纯函数模块，`sanitizeConfig` 提供字段白名单 + 类型断言 + 长度上限 + 枚举校验，HTTP 保存、`/soul` 命令、`set_persona` 工具与 `soulConfig` 服务共用——未知字段不再落盘；长度上限为昵称/职业 50、介绍 500、自定义指令 2000 字符，超限整单拒绝且不静默截断，防止超长文本撑爆 system prompt、缩小提示词注入面
- `POST /api/soul/config`：JSON 解析失败由 500 改为 400（附字段级 `errors` 明细）；新增 64 KB 请求体大小上限，超限返回 413
- 并发写竞态：所有配置写入路径统一进入进程内写队列串行「读—改—写」，HTTP 保存、`/soul` 命令、`set_persona` 并发执行时不再互相覆盖丢更新；`/soul enable|disable` 不再直接改写内存缓存对象，写盘失败时缓存与磁盘保持一致
- Web UI：修复设置导航图标替换的防抖失效（MutationObserver 回调未把新计时器赋回 `timer`，导致每次 DOM 变化都调度一次 sync）

**变更**
- `set_persona`：非法枚举值由静默忽略改为显式返回错误（模型可自行纠正）；文本字段统一 trim 首尾空白
- `soulConfig.updateConfig` / `resetConfig` 服务同样走校验与写队列
- 新增 `scripts/verify-config.mjs`（`npm run verify`）覆盖配置迁移与输入校验逻辑；`package.json` `files` 补充 `lib` / `scripts`

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