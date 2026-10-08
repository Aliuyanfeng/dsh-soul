# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置「关于你」（昵称、职业、介绍）、回复风格和语调、特质（标题和列表 / 表情符号 / 表格）、回复长度偏好、输出语言与自定义指令，配置实时编译为 system prompt 并同步到所有活动会话。

## 功能

**设置页**
- 启用开关、「关于你」（昵称 / 职业 / 介绍）、「特质」（回复风格和语调 / 标题和列表 / 表情符号 / 表格 / 回复长度）、输出语言、自定义指令
- 人设预设分组：保存当前为预设、一键使用（★ 标记当前匹配项）、删除（二次确认）
- Agent 工具分组：`set_persona` 确认模式开关
- 输入框光轨：Agent 回复中时输入框边框的流光动效——开关、预设色板 + 取色器 + 十六进制输入、流动速度（慢 / 中 / 快）、光带粗细（细 / 中 / 粗），以及随配置实时联动的效果示例
- 关键字段带 ⓘ 提示图标；保存 / 重置按钮带 toast；失败时页面内展示错误条
- 中英双语文案（跟随界面语言）；dirty 检测（无改动禁用保存 + 未保存提示）；保存结果区分「已保存 / 无变化」
- 「查看当前生效提示词」折叠区：展示当前已保存配置编译出的 system prompt 与字符数（只读）

**斜杠命令**（输出语言跟随配置 `language`，中英文案）

```text
/soul show        查看当前配置（含确认模式与预设数量）
/soul set k=v     修改配置项（如 /soul set style=humorous language=en；特质：tables=more replyLength=concise；光轨字段：trailColor / trailSpeed / trailWidth / trailEnabled）
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

peerDependencies（DSH 在装载插件前校验，**比较对象是 DSH 运行时版本**，即 `@deepseek-ai/dsh-app-boot` 的 version）：

| 包 | 范围 | DSH 是否校验 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `>=0.1.1-rc.2 <0.3.0-0` | 是 |
| `@deepseek-ai/dsh-tools` | `>=0.1.0-rc.6 <0.3.0-0` | 是 |
| `@deepseek-ai/cordis` | `^4.0.1 \|\| ^4.0.5-alpha.1` | 否（名称不以 `@deepseek-ai/dsh-` 开头，不参与判定） |

即支持 DSH **0.1.x 与 0.2.x**（含 prerelease）。DSH 进入 0.3.x 线后需重新评估再放宽，流程见 `PUBLISHING.md`。

用 `npm run verify:compat` 可在升级 DSH 后一条命令确认声明是否仍然成立（见 `DEBUGGING.md` 第四节）。

---

## 版本历史

### v0.7.0（2026-10-08）

**新增**
- 特质新增**表格**维度（`tables`）：`default`（默认，不额外约束）、`more`（增强，呈现对比、多字段或结构化信息时优先使用表格）、`less`（减弱，避免表格、改用列表或段落）。与「标题和列表」「表情符号」同档，设置页下拉 / `/soul set` / `set_persona` 工具 / 人设预设四处入口齐备
- 新增**回复长度偏好**（`replyLength`）：`concise`（简洁，只讲要点、不展开）、`normal`（适中，不额外约束，**默认**）、`detailed`（详尽，充分展开背景、步骤与推理）
- 两个维度均进入 `PERSONA_FIELDS`，因此人设预设会一并保存与还原；`/soul show` 的特质行也一并展示

**兼容性**
- **现有用户零行为变化**：`tables=default` 与 `replyLength=normal` 在提示词文案表中**没有对应键**，`buildBehavior` 仅在命中时才 `push`，因此不会输出任何文本。实测「不含这两个字段」与「两字段取默认档」编译出的 system prompt **逐字节相同**，提示词长度与内容都不变
- 旧配置文件（无这两个字段）由 `migrateConfig` 自动补齐默认值；两字段的脏数据（非法枚举 / 非字符串）同样回退默认值，不会让插件拒绝启动

**验证**
- `verify-config` 新增 7 项（默认值 / 合法值通过 / 非法枚举拒绝 / 脏数据回退 / `PERSONA_FIELDS` 覆盖 / 提示词文案结构 / 默认档无文案），总数 24 → **31 项**
- 其中「提示词文案结构」直接读 `index.mjs` 源文本按缩进切片，断言 `tables` 与 `replyLength` 的文案块**恰好 2 个**（zh / en），且 `default` / `normal` **不得出现**在文案表中——把「默认档零行为变更」这个不变量固化成了回归项，同时该断言的判断力已用「注入假键后必须失败」双向验证

### v0.6.2（2026-10-04）

**修复**
- **会话注入在 DSH 会话格式 v4 下每轮失败**：修复 [#1](https://github.com/Aliuyanfeng/dsh-soul/issues/1)（报告者 [@Tony-tjsn](https://github.com/Tony-tjsn)，环境 dsh 0.1.7-rc.2 + dsh-soul 0.6.0）。任意会话里发任意内容都立刻失败，界面显示「本轮运行失败 / format v4 message requires a producer-owned source kind」，会话日志里 `turn/start` 之后再无任何事件——失败发生在 step 开始之前
  - 根因：DSH 0.1.7 把会话格式升到 v4，**废弃了共享的 `kind: 'plugin'` + `plugin` 字段组合**，改为要求每个生产者声明自持 kind 并显式拒绝字面量 `'plugin'`。dsh-soul 的注入消息发往**所有活动会话**、并在下一次 step 被读取，因此每一轮都命中，整轮直接失败
  - 修复：新增 `lib/injection.mjs`，注入来源统一由 `createInjectionSource()` 构造——`kind: 'plugin:dsh-soul'` + `form: 'snapshot'` + 命名区块 `soul:persona`，且**不再携带 `plugin` 字段**（v4 迁移会主动丢弃它，保留只会在日志里留下一份易混淆的重复归属）
  - kind 取 `plugin:dsh-soul` 而非裸名：与 DSH 自带 v3→v4 迁移对第三方插件生成的 `plugin:${plugin}` 保持同一形态，使升级前后的历史事件与新增事件归属同一生产者，而不是在同一会话里出现两个身份
  - 回归验证：`verify-compat.mjs` 新增「注入来源契约」检查——用生产代码同一个构造函数取来源，交给**实际安装的** `@deepseek-ai/dsh-session-format-v3-to-v4` 准入校验器判定，并用本机 `dsh-llm` 的 `createUserMessage` 真实构造注入消息（而不是只测形状字面量）；判定前先确认该校验器确实会拒绝已废弃形态，否则本次判定没有判断力
  - issue 中「补 `engines.dsh` 字段」的建议未采纳：DSH 的装载前判定只读 `peerDependencies`（`@deepseek-ai/dsh-app-boot` 的 `evaluatePluginCompatibility()`，`engines` 字段完全不参与），兼容范围写在 peer 上才生效，见下方「与 DSH 0.2.x 的兼容性声明」
- **输入框卡片高度无界增长（composer 尺寸正反馈）**：修复 [#2](https://github.com/Aliuyanfeng/dsh-soul/issues/2)。开启光轨后，长对话中 `[data-composer-card]` 的高度会单调增长（报告者实测 87 720px → 312 712px → 503 361px），聊天区出现巨大空白、Agent 回复被顶出视口；关闭开关即恢复
  - 根因：环是「写在宿主内部、尺寸随宿主变化」的绝对定位元素。一旦类规则里的 `position:absolute` 未生效（被第三方皮肤 / 主题更具体的选择器覆盖，或样式表未加载），环就退回常规流、成为卡片 flex 列的一个子项，而它的高度由 `viewBox` 宽高比反推 ≈ 卡片自身高度，于是闭合成环：卡片变高 → `ResizeObserver` → 按新尺寸改写 SVG → 元素再变高 → 卡片再变高
  - 复现（离线隔离环境，DSH 真实 InputBar CSS + DSH 真实卡片 DOM）：**仅移除该几何规则，60 次尺寸同步就把 134px 的卡片撑到 9 202px**（`syncNoop 0/60`）；样式齐全时同一实验 60/60 次同步均为空操作——这解释了为何问题只在特定环境出现
  - 修复分三层，任一层单独即足以阻断：
    1. **挂载点改为卡片内那个 `position:absolute;height:0` 的 overlay 锚点**——锚点高度写死为 0，环即使在极端情况下退回常规流也撑不动卡片（实测：用 `!important` 把几何强制改回 `position:static` + `contain:none` 后，卡片仍 60/60 次同步不变）
    2. **关键几何全部内联**（`position` / `left` / `top` / `width` / `height` / `contain` / `overflow`）：内联样式只可能被 `!important` 击败，而单类选择器会被任何更具体的选择器击败
    3. **`contain:strict` + 墨迹收进自身盒内**（外盒每边外扩 2px，`stroke` 中心线仍压在宿主边框盒上）：尺寸、布局、绘制与外部彻底隔离，不再需要 `overflow:visible`
  - 附带加固
    - 尺寸同步改用边框盒（`offsetWidth` / `offsetHeight`，原为 `clientWidth` / `clientHeight`），环与卡片**边框盒**逐像素对齐（实测描边中心线与卡片边框盒四边偏差均为 0.0px）
    - 显隐改由**内联 `display`** 控制（原仅依赖样式表），样式表被覆盖时不会把环留在页面上
    - 新增两道熔断：卡片尺寸超过 20 000px、或首帧自检发现 `position` 被第三方样式表改掉，均停用光轨并 `console.warn` 留下线索——不再继续撑大布局，也不再画出巨大错位的图形
  - 设置页实时示例同样受益：环挂到示例内的零高度锚点（`.soul-trail-anchor`，与 DSH composer 的 `.overlayAnchor` 同形态），并与示例**边框盒**对齐（此前画在 `padding` 内侧 16px 处，与边框不重合）
  - 挂载点解析统一：`resolveTrailMountPoint` 新增「anchor 本身就是卡片直接子元素」这一落点，示例与线上从此共用同一条解析路径；此前示例靠直接传参挂到锚点、线上走解析函数，两条路径并存，且该函数对示例结构返回的是宿主本身

**新增**
- `scripts/verify-trail.mjs`：输入框光轨的**离线回归**（`npm run verify:trail`）。把 `client/index.mjs` 里那段纯 DOM 渲染层原样抽出、注入静态页，在无头浏览器里跑一组确定性模型——正常条件必须空操作且与宿主边框盒逐像素对齐；几何被 `!important` 打回常规流后必须不撑大卡片（熔断 + 零高锚点各测一次）；把环挂到卡片本身时必须复现出正反馈（作为「本实验有判断力」的对照，实测 272px → 8 912px，×32.76）；尺寸熔断；三种挂载点解析落点。抽取按标记切片并**断言补丁生效**，代码结构一变就报错退出，不会悄悄退化成永不失败的检查。需要 Chrome / Edge（可用 `CHROME_PATH` 或 `--chrome` 指定），起不来时优雅跳过（退出码 0）；另支持 `--emit` / `--dump` 两段式，便于在无法由脚本启动浏览器的受限环境里跑
- `npm run verify` 现在串联三套校验（配置层 / DSH 兼容性 / 光轨回归）；单独运行用 `npm run verify:trail`

### v0.6.1（2026-10-04）

**修复**
- **与 DSH 0.2.x 的兼容性声明**：`peerDependencies` 由 `^0.1.x` 放宽为覆盖 0.1 / 0.2 两条线，修复在 DSH 0.2.0-rc.2 及以上被拒绝装载的问题（插件管理器报「dsh-soul@0.6.0 与 DSH 0.2.0-rc.2 不兼容（要求 @deepseek-ai/dsh-llm ^0.1.1-rc.2, @deepseek-ai/dsh-tools ^0.1.0-rc.6）」）
  - 根因：DSH 以 `semver.satisfies(运行时版本, peer范围, { includePrerelease: true })` 判定，被比较的一方是 **DSH 运行时版本**而非插件实际 import 到的包版本；`^0.1.1-rc.2` 的隐含上界是 `<0.2.0-0`，因此挡住了整条 0.2.x 线
  - 新范围：`@deepseek-ai/dsh-llm` `>=0.1.1-rc.2 <0.3.0-0`、`@deepseek-ai/dsh-tools` `>=0.1.0-rc.6 <0.3.0-0`——覆盖 0.1.x 与 0.2.x 全部 prerelease
  - `@deepseek-ai/cordis` 由 `^4.0.1` 放宽为 `^4.0.1 || ^4.0.5-alpha.1`（DSH 不校验该 peer，改动只为声明准确）
  - **插件代码无需改动**：`createUserMessage`（dsh-llm）、`defineTool` 与 `TOOL_RUNTIME_SCHEDULER`（dsh-tools）、`SessionSnapshot.running`、以及 `conversation.input.left` / `conversation.input.overlay` / `settings.section` 三个槽位在新版 DSH 中均已逐项核实存在

**新增**
- `scripts/verify-compat.mjs`：DSH 兼容性自检脚本。自动定位本机 DSH 运行时，复现 DSH 的判定规则（能取到宿主时直接调用其导出的 `evaluatePluginCompatibility`），并额外抽查运行时符号与客户端 `inject` 包是否仍在；不兼容时以退出码 1 失败。支持 `--dsh <目录>` 与 `--runtime <版本>`，无法定位运行时则跳过
- `npm run verify` 串联配置层与兼容性两套校验；单独运行用 `npm run verify:compat`（v0.6.2 起又并入了光轨回归）

### v0.6.0（2026-09-20）

**新增**
- 输入框光轨：Agent 回复中时，输入框（composer）边框显示沿边循环流动的光轨
  - 触发条件：当前会话 `running === true`（DSH `SessionSnapshot.running`）且 `trailEnabled === true`
  - 实现：注册到 `conversation.input.overlay` 槽位，在输入框卡片（`[data-composer-card]`）上挂一层 SVG 圆角矩形；`pathLength` 归一化 + `stroke-dashoffset` 线性动画，按弧长匀速推进（旋转 `conic-gradient` 角速度恒定但周长线速度不均，故不采用）
  - 渐隐拖尾：8 层等长 dash 依次错位叠加、透明度递减——头部最亮、向后渐隐；各层共用同一时长，整体仍严格匀速
  - 与边框重合：`stroke` 中心线落在卡片边框盒边缘，且光轨开启时把宿主自身细边框置为透明（覆盖 `--dsw-elevation-stroke-color`），边界上只保留一条线
  - 可配置：颜色（预设色板 / 取色器 / 十六进制，默认 `#679EFE`）、流动速度（`slow` / `normal` / `fast`，默认 `slow`，对应 4.8s / 3.6s / 2.4s）、光带粗细（`thin` / `normal` / `thick`，默认 `thin`，对应 1.5 / 2.5 / 4 px）
  - 设置页「Agent 工具」分组内置实时效果示例，随颜色 / 速度 / 粗细联动
  - 尺寸同步：`ResizeObserver` 跟随输入框高度变化，不随内容增高变形；`prefers-reduced-motion` 下停用动画
  - 无障碍：光轨为纯装饰层，`pointer-events: none` + `aria-hidden`，不参与交互与读屏
- 新增配置项 `trailEnabled` / `trailColor` / `trailSpeed` / `trailWidth`；`/soul show` 展示光轨状态，`/soul set` 支持写入（布尔字段接受 true / false / on / off / 1 / 0 / yes / no）

**变更**
- 设置页折叠面板：标题行改为始终带底色（`--dsw-alias-interactive-bg-active`，悬停时加深一档），并与内容区之间保留 1px 分隔线；展开时标题行下沿改直角，形成清晰的水平交界。原因是浅色主题下 `bg-layer-1/2/3` 全为纯白，标题与内容同为一片白、展开后分不清哪块是标题
- `commitConfig` 返回值新增 `promptChanged`：`changed` 仍为全部实际变更（用于「已保存 / 无变化」判断与前端 dirty），`promptChanged` 为其中影响 Agent 行为的子集；光轨等纯外观字段只更新配置，不再刷新系统提示词、不再向活动会话注入快照
- 设置页保存失败（如颜色格式非法被服务端拒绝）改为提示「保存失败」，不再误报「配置无变化」
- 颜色归一化为大写（`#RRGGBB`），与默认值 `#679EFE` 及调色板取值一致，保证变更比对稳定

**测试**
- `scripts/verify-config.mjs` 新增光轨字段用例（默认值、大写归一化、非法颜色 / 枚举拒绝、迁移脏数据回退）

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