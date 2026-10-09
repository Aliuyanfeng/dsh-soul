# dsh-soul Release Notes

`dsh-soul` 为 DeepSeek Harness（DSH）提供「个性化设置」能力：通过 Web 设置页或斜杠命令配置「关于你」（昵称、职业、介绍）、回复风格和语调、特质（标题和列表 / 表情符号 / 表格）、回复长度偏好、输出语言与自定义指令，配置实时编译为 system prompt，**下一次请求即生效**（section 每次装配重算 + 活动会话主动注入，双通道兜底）。

## 功能

**设置页**
- 启用开关、「关于你」（昵称 / 职业 / 介绍）、「特质」（回复风格和语调 / 标题和列表 / 表情符号 / 表格 / 回复长度）、输出语言、自定义指令
- 人设预设分组：7 个内置人设（随插件提供、不可删除）+ 保存当前为预设、一键使用（★ 标记当前匹配项）、删除（二次确认）；每行摘要显示风格与「偏离默认值」的维度，便于横向比较
- Agent 工具分组：`set_persona` 确认模式开关
- 输入框光轨：Agent 回复中时输入框边框的流光动效——开关、预设色板 + 取色器 + 十六进制输入、流动速度（慢 / 中 / 快）、光带粗细（细 / 中 / 粗），以及随配置实时联动的效果示例
- 关键字段带 ⓘ 提示图标；保存 / 重置按钮带 toast；失败时页面内展示错误条
- 中英双语文案（跟随界面语言）；dirty 检测（无改动禁用保存 + 未保存提示）；保存结果区分「已保存 / 无变化」
- 提示词预览折叠区（只读）：无未保存编辑时展示「当前生效提示词」；一旦表单有改动，就改为在保存前编译草稿、展示「保存后将生效的提示词」——边改边看（停止输入 400ms 后自动重编译），并在保存 / 重置 / 应用预设后自动刷新；未通过校验的字段会如实列出、且不计入预览，避免「预览悄悄用了旧值」

**斜杠命令**（输出语言跟随配置 `language`，中英文案）

```text
/soul show        查看当前配置（含确认模式与预设数量）
/soul set k=v     修改配置项（如 /soul set style=humorous language=en；特质：tables=more replyLength=concise；光轨字段：trailColor / trailSpeed / trailWidth / trailEnabled）
/soul save <名>   保存当前配置为人设预设（内置名不可占用）
/soul use <名>    应用人设预设（内置预设同样可用）
/soul list        查看人设预设（✔ 标记当前匹配项；内置项带 [内置] 标记）
/soul del <名>    删除人设预设（delete / rm 别名；内置预设不可删）
/soul confirm     应用待确认的人设变更（确认模式）
/soul reject      拒绝待确认的人设变更
/soul reset       重置默认值（保留人设预设库）
/soul enable      启用
/soul disable     禁用
/soul <昵称>      设置昵称（保留原始大小写）
```

**配置与集成**
- 持久化：`$DSH_HOME/soul-config.json`（用户预设存于同文件 `personas` 字段；内置人设只在代码 `lib/personas.mjs` 里，不落盘，因此升级时自动更新、也无法被删除或篡改）
- 服务：`soulConfig`（`getConfig` / `updateConfig` / `getSystemPrompt` / `resetConfig`）
- HTTP API：`/api/soul/config`（GET/POST）、`/api/soul/prompt`（已生效提示词）、`/api/soul/prompt/preview`（POST 草稿，不落盘、不影响生效提示词）、`/api/soul/config/reset`、`/api/soul/status`（GET，诊断两条送达通道与配置状态）、`/api/soul/personas`（GET）、`/api/soul/personas/save|use|delete`（POST）
- 输入校验：字段白名单、类型、长度上限与枚举校验，HTTP 保存 / `/soul` 命令 / `set_persona` 工具 / `soulConfig` 服务共用；非法或超限字段整单拒绝
- Agent 工具：`set_persona`（需宿主安装 `@deepseek-ai/dsh-tools`；缺失或不兼容时自动跳过，其余功能不受影响；确认模式下返回 `pending` 提议）
- 插件图标：`package.json` 的 `icon` 指向 `assets/icon.svg`（36×36 viewBox，随 npm 包发布）
- 设置导航图标：设置面板左侧「个性化」那一项显示与插件图标同一套几何的图标（DSH 的导航图标按 section id 硬编码、插件声明不了，故由客户端做 DOM 替换，见下）

## 已知限制

- 安装 / 升级后需完全重启 DSH 并刷新浏览器，设置栏目才会出现
- 保存配置后在**下一次请求**生效：配置变化同时走 system prompt section（每一步装配时重新求值）与活动会话注入（保存后主动推送快照），不会打断进行中的请求，也不会改写历史消息
- 有效配置变化会在会话里留下一条 `[dsh-soul 个性化配置已更新]` 消息（user 角色）——它是「即时生效」的可见载体；纯外观配置（输入框光轨）只落盘，不产生该消息
- 两条通道**缺一不可**：底座是宿主「每步重新装配 + 不对函数式 section 文本做缓存」，`npm run verify:host` 用宿主的真实实现直接验证它；而本版实测证明**只有底座不够**（会话进行中改配置不生效），因此注入是必需的第二条通道，不要单独删除（见 `DEBUGGING.md` 3.5）
- 「改了配置不生效」有三处可查：`/soul show` 末尾的「送达」行、`GET /api/soul/status`、设置页的提示条（`configError` = 配置读不出来；`deliveryWarning` = 配置送不到活动会话）
- 配置文件**损坏**时普通保存会被拒绝（以免以默认值为底覆盖你的内容），设置页的**重置**是逃生口：它把损坏文件另存为 `soul-config.json.corrupt` 后再写入默认值
- `npm run verify` 里可能包含**跳过**（无浏览器 / 定位不到 DSH）：跳过会显式打印未执行的断言数，但退出码仍为 0；需要「跳过即失败」时用 `npm run verify:strict`
- 仅支持 `web` 平台客户端

## 兼容性

peerDependencies（DSH 在装载插件前校验，**比较对象是 DSH 运行时版本**，即 `@deepseek-ai/dsh-app-boot` 的 version）：

| 包 | 范围 | DSH 是否校验 |
| --- | --- | --- |
| `@deepseek-ai/dsh-llm` | `>=0.1.1-rc.2 <0.3.0-0` | 是 |
| `@deepseek-ai/dsh-tools` | `>=0.1.0-rc.6 <0.3.0-0` | 是 |
| `@deepseek-ai/cordis` | `^4.0.1 \|\| ^4.0.5-alpha.1` | 否（名称不以 `@deepseek-ai/dsh-` 开头，不参与判定） |

即支持 DSH **0.1.x 与 0.2.x**（含 prerelease）。DSH 进入 0.3.x 线后需重新评估再放宽，流程见 `PUBLISHING.md`。

用 `npm run verify:compat` 可在升级 DSH 后一条命令确认声明是否仍然成立（见 `DEBUGGING.md` 第四节）；`npm run verify:host` / `npm run verify:e2e` 另可确认「改配置 → 下一轮生效」这条链路在升级后依然成立。

---

## 版本历史

### v0.7.1（2026-10-09）

**新增**

- 内置人设新增**「自驱型协作者」**（第 7 个）：`professional` 风格 + 更多标题和列表 + 更多表情符号，行为准则是「先自己动手再开口」
  - 五条行为规则：**先自己动手**（能读的先读、能查的先查、能验证的先验证掉，确实卡住才提问，并把已排查范围与还缺什么一并说明）；**给出明确判断**（比较方案时指明推荐哪条及理由，不以「都可以，看需求」收尾）；**以可核实的依据为准**（事实 / 接口 / 参数 / 版本先查证再断言，查不到就说不确定，不用听起来合理的说法填空）；**实质优先于形式**（不复述用户已说清的需求、不用开场垫话，礼貌体现在措辞而非铺垫）；**区分两类动作**（读文件 / 检索 / 整理这类内部动作大胆做，发消息 / 提交 / 发布 / 删除这类对外动作先确认）
  - 与既有内置一致：不声明 `nickname` / `occupation` / `bio`（「关于你」是使用者本人的资料，预设不该动）与 `language`（内置是给任何语言用户共用的通用人格，写死会让英文用户应用一次就被切回中文），因此应用它不会动你的昵称职业
  - 名字与被参照的原始预设不同：原名含个人昵称，不适合作内置名，故按行为核心重新命名。原有的自建预设不受影响，两者可并存（★ 各自独立判定）

**变更**

- **人设预设从此只管 Agent 的人格，不再包含「关于你」**：「关于你」（昵称 / 职业 / 介绍）是使用者本人的身份信息，预设是 Agent 的回复风格存档 —— 两者是两码事，切换预设应该只换说话方式，不该动你的资料。此前**自建**预设是「保存那一刻的完整配置快照」，应用时会把这三个字段一并写回（内置预设一直省略它们），同一件事因此有两套语义
  - 改法是把边界下沉到字段白名单：三个身份字段移出 `PERSONA_FIELDS`，另立 `PROFILE_FIELDS` 标明它们的位置，于是**保存快照**（`personaSnapshotOf`）、**应用取键**（`pickPersonaValues`）、**★ 匹配判据**（`declaredPersonaKeys`）、**磁盘归一化**（`normalizePersonas`）四条路径同时排除它们 ⇒ 内置与自建**行为一致**，「切换预设换掉了我的昵称」从结构上不再可能发生
  - 输出语言（`language`）**留在预设范围内**：它决定 Agent 用什么语言作答，属于人格的一部分；自建预设会保存并在应用时还原它。内置预设作为通用人格仍然刻意不声明它
  - **已有自建预设无需处理**：早期版本存下的完整快照会在**读取时**自动剥离三个身份字段（无损 —— 这些值同时存在于活动配置里，预设只是保存那一刻的拷贝），清理结果随下一次写入落盘。可见变化有二：预设行摘要不再显示昵称（它已不属于预设），★ 判定也不再受昵称影响

**修复**

- **关闭宿主提示词插值**（`interpolate: false`）：在「自定义指令」里写出任意一对完整的 `{{…}}`（`{{cwd}}`、`{{ item.name }}`、甚至 `{{}}`）都会让 system prompt 装配抛错——而该抛错位于 `agent.step()` 开头且没有 try/catch，结果不是「忽略那段文字」，而是**该会话的每一轮都失败**（实测 8 例中 6 例抛错，连 `{{cwd}}` 这种规范写法也抛，因为它同样没注册）。插件不使用任何宿主提示词变量，关闭插值的代价为 0；顺带让「预览所见」与「实际生效的文本」逐字符一致
- **配置写入原子化**：先写同目录 `.tmp` 再 `rename` 覆盖，写盘中途中断不再留下截断的 JSON。原有写队列解决的是并发丢更新，与原子性互补、两者都保留
- **配置损坏不再被静默覆盖**：读取区分「文件不存在」（回退默认，属正常首启路径）与「文件损坏」（保留原文件、另存 `.corrupt` 备份、**拒绝在此基础上写入**）。此前 `catch {}` 会静默回退成默认值，并在下一次保存时以默认值为底写回磁盘 ⇒ 自定义指令与人设库**永久丢失且全程没有任何提示**。读取失败时刻意不写缓存，用户修好文件后**不必重启 DSH** 即自动恢复；设置页会直接显示原因与备份位置
- 新增 `lib/store.mjs` 收口全部配置读写（校验/迁移留在 `lib/config.mjs`，`index.mjs` 只管缓存与状态，且不再直接 import `node:fs/promises`）
- **撤回本版草稿中的「移除会话注入」**（同版本内回退，未发布）：删除 `injectPromptToAllAgents` 与 `lib/injection.mjs` 的理由是「宿主每一步都重新装配提示词、对函数式 section 文本不做缓存、文本变化时自行提交新的 system 快照 ⇒ 注入冗余」。实测该推理**不足以支撑删除** —— 只保留 section 通道时，**会话进行中修改人设不会在下一轮生效**。现已恢复注入、`lib/injection.mjs` 与 `@deepseek-ai/dsh-llm` 依赖：配置变化继续走**双通道**（section 每次装配重算 + 保存后主动推送活动会话），两者互为兜底
- **配置损坏时不再是死路**：此前损坏状态下「保存 / 重置 / 斜杠命令 / 工具 / 服务」五条写路径**全部被拒**，用户除手删文件外没有出路。现在「重置」被定义为**刻意丢弃**——先把损坏文件移开（备份为 `.corrupt`）再写入默认值，并且**重置本身也走同一个写入路径**（不另写一份「读—改—写」）。这与上一条「损坏配置绝不被**静默**覆盖」不冲突：静默覆盖仍被禁止，而重置是用户显式发起的动作
- **重置失败不再被报成成功**：客户端此前无条件弹「已重置为默认值」，即使请求失败（配置损坏时那条必然失败的重置正落在这里）。现在失败给失败提示，成功且丢弃过损坏文件时告知「已备份」

**优化**

- 修正 `registerSection` 中一处与事实不符的注释：原先称「重新注册会触发 `system-prompt/change`，让 DSH 丢弃已缓存的快照」——该事件当前**没有任何消费者**（只在 `dsh-system-prompt` 内部 emit）
- **「改了配置不生效」从此有据可查**（此前是全静默：`agents` 服务不可用时直接 `return`，注入异常被 `catch {}` 吞掉，日志全被注释）：
  - `injectPromptToAllAgents` 如实统计送达结果（活动会话数 / 成功数 / 失败数 / 原因），并经 `ctx.logger` 告警（同一原因只告一次，恢复正常后允许再次告警）
  - 新增 `GET /api/soul/status`：报告两条通道的状态、配置路径与版本号
  - `/soul show` 末尾新增「送达」一行（是否有活动会话、注入是否成功）
  - 设置页新增 `deliveryWarning` 提示：与 `configError`（配置读不出来）分开上报——两者症状相同、处理方式不同
  - `soulConfig` 服务的 `updateConfig` 现在也走「变更即送达」，与服务之外的另外三条写路径保持一致
- **`npm run verify` 不再「假绿」**：`verify-trail` / `verify-nav-icon` 在无浏览器时、`verify-e2e` / `verify:host` / `verify:compat` 在定位不到 DSH 时会**跳过并返回 0**，此前混在 `&&` 链里看起来一片绿，实际有几十项断言根本没跑。现在跳过会显式说明「有 N 项断言未执行」，并新增 `npm run verify:strict`（跳过即失败）。各脚本还会在跑完时校验实际断言数与声明值一致，避免数字变成谎话
- **`verify:host` 不再由当前工作目录决定验证哪一份宿主**：锚点原先以 `process.cwd()` 开头，而模块解析会从锚点向上找 `node_modules` ⇒ 换个目录跑就可能命中另一份 DSH 安装（本机同时存在 0.2.1-alpha.1 与用户主目录 pnpm store 里的 0.1.0-rc.8，后者不支持 `interpolate`）。现在优先「装了本插件的 profile」，并在解析到多份副本时逐一打印、说明本次验证的是哪一份；`--dsh` 指向非 DSH 目录时直接报错，不再悄悄退回自动定位

**校验**

- `verify-config` 59 → **80 项**（新增：重置逃生口单一实现、注入失败必须留痕、诊断端点形状、两类问题分开上报、版本号不新增常量、三张双语文案表逐键对齐、`verify` 与 `verify:strict` 两条链同序且逐项带 `--strict`；本版追加「预设范围只含人设」「残留的『关于你』不参与匹配与取值」「`normalizePersonas` 剥离历史快照」「保存与应用只遍历同一份白名单」「客户端预设行摘要不读『关于你』」五项）；`verify-store` 14 → **18 项**（新增 `moveAsideConfigFile` 的四条行为断言）
- 新增两个回归并入 `npm run verify`，把「改配置 → 下一轮生效」的两条通道分别钉住（上述撤回正是由它们暴露的）：
  - `verify:host`（20 项 + 3 项判断力对照）：用宿主的**真实实现**验证底座 —— 真实 `SystemPrompt` + 真实 Cordis Context 跑「改值→再装配即读到新值、改回又读到旧值」，原样切片 `SystemPromptProjection` 跑「文本变了才提交、没变不提交、清空则归一化」，外加 `preStep` / `assemble` 的源文本契约。**注意它只证明底座成立，不等于端到端一定生效**（这正是本版撤回的原因）
  - `verify:e2e`（**34 项** + 2 项判断力对照）：用**真实 `index.mjs`** + 假宿主在纯 Node 里跑通 `POST /api/soul/config` → 原子落盘 → 两条通道各拿到新文本（E4 / E8 断言 section provider 立即读到新值；E13 / E16 断言活动会话确实收到注入快照、且来源符合会话格式 v4 准入），另起一个**配置损坏场景**验证逃生口（E18–E24：如实上报、拒绝保存且不改动原文件、重置可用并回报备份、重置后免重启恢复、诊断端点可用）；另有 **E25–E30** 钉住「人设预设与『关于你』的边界」——应用**任何**预设（内置 E25 / 自建 E27）都不得改动昵称 / 职业 / 介绍，同时它声明过的人格维度必须真的写回、含输出语言（E26 是防止 E25「因为没改所以通过」的防空过护栏，E28 证明语言在预设范围内）；E29 / E30 另起一份**带着 v0.7.1 之前那套完整快照的旧配置**，验证历史残留既在读取时被迁移剥离（内存与落盘各断言一次）、也不会在应用时写回。插件挂载前会在临时目录生成 `@deepseek-ai/dsh-llm` 的形状兼容桩，因此不依赖本机是否装过 DSH
  - 另有「纯外观字段既不刷新也不注入」（E10 / E10b）与「草稿预览是只读旁路」（E17）；两者都配**判断力对照**（改坏关键条件必须失败）。E25–E30 同样配了判断力对照：把身份字段加回 `PERSONA_FIELDS`（等价于回到「完整快照」）⇒ E27 必须失败；让 `normalizePersonas` 不再过滤 ⇒ E29 必须失败；把语言移出 `PERSONA_FIELDS` ⇒ E28 必须失败；而 E25 只在内置数据被改坏时才失败（精确，不误伤）
- 新增 `scripts/lib/skip-report.mjs`：统一「跳过」语义（`skipExit` / `assertCount`）
- 发布包 14 → **19 个文件**（新增 `lib/store.mjs`、两个校验脚本与 `scripts/lib/skip-report.mjs`；`--strict` 链不增加文件）

### v0.7.0（2026-10-08）

**新增**
- 特质新增**表格**维度（`tables`）：`default`（默认，不额外约束）、`more`（增强，呈现对比、多字段或结构化信息时优先使用表格）、`less`（减弱，避免表格、改用列表或段落）。与「标题和列表」「表情符号」同档，设置页下拉 / `/soul set` / `set_persona` 工具 / 人设预设四处入口齐备
- 新增**回复长度偏好**（`replyLength`）：`concise`（简洁，只讲要点、不展开）、`normal`（适中，不额外约束，**默认**）、`detailed`（详尽，充分展开背景、步骤与推理）
- 两个维度均进入 `PERSONA_FIELDS`，因此人设预设会一并保存与还原；`/soul show` 的特质行也一并展示
- **插件图标**：新增 `assets/icon.svg` 并在 `package.json` 声明 `icon` 字段，插件管理列表与侧栏入口不再显示默认插图
  - 图形沿用插件自身的视觉语汇：一枚「灵魂火花」（四芒星，上浅下深渐变）加一段绕行约 250° 的光轨（尾端渐隐），与输入框光轨同色系（`#679EFE`）
  - 36×36 viewBox，与 DSH 自带插画同尺寸；两处渐变让图形在浅色 / 深色主题下都保留体积感，不会塌成一块
  - 宿主一侧由 `dsh-app-boot` 的 `readPluginMeta` / `iconOf` 消费，规则比想象中严格：只接受**相对路径**（绝对路径、Windows 盘符、任何带 scheme 的 URL 一律报错），realpath 解析后必须仍在声明它的目录内，扩展名限 SVG / PNG / JPEG / WebP，体积不超过 256 KiB，最终**内联为 `data:` URL** 交给客户端。正因如此图标里的渐变 / 引用必须自足，不能依赖外部资源
  - 图标解析失败只丢图标，用 `package.json` 的 `name` / `description` 兜底，不会导致插件装载失败——所以「图标没生效」是一类不会报错的静默失败
  - `assets/` 已加入 `files` 白名单（发布包 11 → 12 个文件）；漏加会表现为「仓库里有、装完没有」
- **设置导航图标**：设置面板左侧「个性化」那一项不再显示 DSH 给未知 section 兜底的齿轮，改用与插件图标同一套几何的图形
  - 为什么不是原生能力：设置导航的图标由壳层 `ui-settings-general` 的 `navIcon(id)` 硬编码——只认 `account` / `models` / `agent-presets` / `plugins` / `archived-sessions` 五个 id，**其余一律回退成设置齿轮**；而 `settings.section` 槽位的选项只有 `id` / `order` / `label`，插件无从声明自己的图标。所以只能走 DOM 替换（旧版用同一机制画了一颗描边五角星）
  - 替换时**只改宿主 `<svg>` 的内容与 viewBox，不换节点**：宿主的 `className`（`…navIcon{flex:none}`）、`width` / `height`（`size=16`）与 `aria-hidden` 因此原样生效，不必自己复刻一套尺寸规则；React 重建按钮后标记消失，MutationObserver 会重新画一次
  - **图形与插件图标同源，颜色则跟随邻居**：两种图标共用同一条光轨与火花路径（与 `assets/icon.svg` 逐字同源），但插件图标是彩色渐变，而设置导航那一排图标全是 `currentColor` 单色线描。导航图标因此也只取 `currentColor`——与兄弟栏目统一，且自动跟随主题、选中态与禁用态，不必自己判断暗色模式
  - 线宽同样按**显示后的像素**对齐：宿主图标是 16 网格 + 1.3 线宽，我们的窗口是 28.4 单位显示成 16px（缩放 0.5634），故取 2.3（显示后 ≈ 1.3px）。照搬 `icon.svg` 的 2.8 会比邻居粗一圈
  - 显示窗口从 `0 0 36 36` 收紧为 `3.8 3.8 28.4 28.4`（同中心 (18,18)）：宿主图标在 16px 下墨迹跨度 14.25px（占 89%），沿用 36 网格会让这个小图标显得又小又轻。窗口值是**量出来的**——把两种图标按同一尺寸渲染到 canvas 逐像素统计，不是估的
  - 宿主 `<svg>` 上挂着 `fill="none"` 与 `stroke-width="1.3"`，二者会向下继承，因此光轨与火花各自写全 `fill` / `stroke` / `stroke-width`——否则火花会被 `fill:none` 清空、光轨线宽被缩到 1.3
  - 另加一道兜底：宿主若哪天不再给 `width` / `height`（改由 CSS 控制尺寸），我们补 16——否则 `<svg>` 会退回 300×150 的默认尺寸，把导航栏撑坏
- **内置人设预设**：新增 `lib/personas.mjs`，随插件提供 6 个人设——苏格拉底式提问者、极简主义者、资深架构师、教学型讲解者、严格代码审阅者、头脑风暴伙伴
  - **只声明要覆盖的字段**：预设是「部分覆盖」语义，应用时只写它声明过的键。内置预设一律省略 `nickname` / `occupation` / `bio`（那是「关于你」的用户资料，预设去写它们等于把用户的昵称职业清空）与 `language`（输出语言属于用户偏好，写死会让另一种语言的用户被强行切回）
  - 人格差异主要靠 `customInstructions` 承载：枚举字段只能表达「更啰嗦 / 更简洁」这类粗粒度倾向，所以 6 个人设都带一段行为规则文本，写法上只描述**行为**（先问什么、先给什么、按什么顺序展开），不与风格档位的文案重复
  - **内置预设不落盘**：只存在于代码里，磁盘 `soul-config.json` 的 `personas` 字段仅存用户自建预设。好处是升级时内置内容自动更新（不会被用户的旧副本覆盖）、无法被删除或篡改、配置文件保持干净。写路径（保存 / 删除，HTTP 路由与 `/soul` 命令共 4 处）对内置名一律拒绝，读取路径（列表 / 使用 / ★ 判定）统一走 `mergePersonas` 合并视图
  - 名称冲突规则是**内置优先**：磁盘上若残留同名条目（手改文件或历史数据）会被内置内容遮蔽，不变量是「内置名永远指向内置内容」
  - 匹配语义随之修正为「只比较预设声明过的字段」：原实现按 `PERSONA_FIELDS` 全字段相等判定 ★，对省略字段的内置预设会**永远匹配不上**。判定逻辑下沉为纯模块的 `personaMatches`，宿主与回归共用同一份实现，避免两套逻辑漂移
  - 已知取舍：内置人设名是中文，英文界面下仍显示中文名。不做双语名是为了保持「一个预设一个名字」的简单语义（双语名会让同名判定与去重复杂化）
- **预设行摘要扩展**：原来只显示「风格 · 昵称」，现在额外列出所有**偏离默认值**的维度（回复长度 / 标题和列表 / 表情符号 / 表格 / 输出语言），例如「高效干练 · 简洁 · 少列表 · 少表情 · 少用表格」。只显示差异项是刻意的——把 10 个字段全列出来，每行都是一长串「默认 / 适中」，反而看不出两个预设差在哪
- 内置预设行以「内置」标记占据删除按钮的位置（后端同样拒绝删除），行宽不会因此跳动；列表排序为内置在前、用户自建在后
- **提示词预览支持未保存的编辑**：折叠区原来只能看已保存配置编译出的提示词，现在表单一有改动就改为在保存前编译**草稿**——标题随之变成「保存后将生效的提示词」，边改边看（停止输入 400ms 后自动重编译）
  - 新增 `POST /api/soul/prompt/preview`：以已保存配置为底，用请求体中**通过 `sanitizeConfig` 校验**的字段覆盖后编译；不落盘、不注入，是纯只读旁路。与保存路径共用同一套校验，非法字段既不参与预览也不落盘，并通过 `invalid` 回报给客户端——避免「预览悄悄沿用旧值」这类看不出原因的偏差（v0.1.x 的旧实现是直接展开未校验的请求体，本次一并修正）
  - 预览刷新收敛为**单一入口**（effect 驱动），保存 / 重置 / 应用预设后自动跟进——原先三个处理器各调一次，既重复请求又用**过期闭包**：保存后 `dirty` 已变 false，闭包仍是 true，会把刚保存的状态标成「未保存」
  - 新增 `PROMPT_FIELD_KEYS`（真正参与 `compilePrompt` 的字段子集）：改光轨颜色等纯外观字段不会触发重新预览，也不会把预览误标成草稿

**兼容性**
- **现有用户零行为变化**：`tables=default` 与 `replyLength=normal` 在提示词文案表中**没有对应键**，`buildBehavior` 仅在命中时才 `push`，因此不会输出任何文本。实测「不含这两个字段」与「两字段取默认档」编译出的 system prompt **逐字节相同**，提示词长度与内容都不变
- 旧配置文件（无这两个字段）由 `migrateConfig` 自动补齐默认值；两字段的脏数据（非法枚举 / 非字符串）同样回退默认值，不会让插件拒绝启动

**验证**
- `verify-config` 新增 7 项（默认值 / 合法值通过 / 非法枚举拒绝 / 脏数据回退 / `PERSONA_FIELDS` 覆盖 / 提示词文案结构 / 默认档无文案），总数 24 → **31 项**
- 其中「提示词文案结构」直接读 `index.mjs` 源文本按缩进切片，断言 `tables` 与 `replyLength` 的文案块**恰好 2 个**（zh / en），且 `default` / `normal` **不得出现**在文案表中——把「默认档零行为变更」这个不变量固化成了回归项，同时该断言的判断力已用「注入假键后必须失败」双向验证
- 图标部分另加 7 项清单契约（路径形态 / 目录逃逸 / 扩展名白名单 / 体积上限 / `files` 白名单覆盖 / SVG 命名空间与方形 viewBox / 无脚本·位图·外部引用 / 渐变引用可解析），总数 31 → **38 项**。其中「路径形态」「目录逃逸」「体积上限」「扩展名」四条是按宿主 `iconOf` 的实际判据对齐的，不是自拟标准
- 上述图标断言的判断力用 13 组对照验证：只改坏一个条件（指向不存在的文件、指向包外、绝对路径、目录不在白名单、删掉 `icon` 字段、去掉 `xmlns`、去掉 `viewBox`、viewBox 非正方形、内嵌 `<script>`、内嵌 `<image>`、引用外部资源、渐变引用未定义的 id）时**必须失败**，未改动时必须通过——13/13 符合预期
- 另用宿主自己的 `readPluginMeta('dsh-soul', <profile 目录>)` 做端到端实证：本机桌面 profile 以符号链接直连源码，因此读到的就是本仓库的清单，返回 `{ title, description, icon }` 且 `icon` 为 `data:image/svg+xml;base64,…`（解码 1270 字节，与源文件逐字节相同）；作为对照，web profile 里那份 0.6.2 旧副本（无 `icon` 字段）同一调用只返回 `{ title, description }`——说明上面那次成功确实来自本次新增的字段
- 新增 `scripts/verify-nav-icon.mjs`（`npm run verify:nav-icon`，已并入 `npm run verify`）：在复刻的导航按钮（含宿主生成的齿轮 `<svg>`）上跑**真实绘制代码**，共 **16 项**断言——替换前是宿主齿轮、替换后仍是同一个节点、宿主属性与继承属性未被破坏、显示窗口与 `icon.svg` 同心且不放大、图形占比与宿主同量级（实测 0.926）、宿主未给宽高时补默认尺寸、内容是两条 `path` 且**没有** defs / 渐变、两条 `d` 与 `icon.svg` 逐字一致、颜色（含计算值）等于按钮文字色（换个文字色会跟着变，证明没写死色值）、光轨**计算**线宽为 2.3px 而非继承的 1.3px、换算到 16px 显示后与邻居等粗、火花为纯填充、包围盒非空、仍是 16×16
- 上述断言的判断力用 6 个变体自检（viewBox 退回宿主 16 网格 / 光轨不写线宽 / 火花不关描边 / 路径换成别的图形 / 光轨改回渐变引用 / 火花写死品牌色）——每个都必须被对应那条断言判出，未改坏时必须通过。其中「光轨不写线宽」实测报出 `计算线宽=1.3px（继承未被覆盖）`，正是最容易被忽略的那个陷阱；「火花写死品牌色」报出 `火花颜色 rgb(103,158,254) ≠ 按钮文字色 rgb(26,26,26)`
- **内置人设与契约一致性**部分再增 16 项，`verify-config` 总数 38 → **54 项**：内置人设只声明 `PERSONA_FIELDS` 内的键、不含用户自有信息与输出语言、枚举与文本长度合法、都能通过 `sanitizeConfig`；`mergePersonas` 的内置优先与 `builtin` 标记；`resolvePersona` / `isBuiltinPersona` 的判定与优先级；**「应用内置预设后必须命中它自己」的 ★ 闭环**（这条是「预设能用」的最小闭环：应用 → 表单回读 → 列表应显示 ★）；部分覆盖语义的四种情形（未应用时不匹配、已声明字段变化即失配、未声明字段变化仍匹配、无声明字段的条目不匹配）；以及五项前后端契约——客户端摘要默认值表与宿主 `DEFAULT_CONFIG` **逐项一致**（漂移会让摘要显示相反的结果）、摘要覆盖的字段集合固定、12 个新增文案键在 zh / en 各一份、内置行不渲染删除按钮、服务端内置名拒绝点**恰好 4 处**且匹配逻辑只有一份实现
- 上述 16 项的判断力用 13 组破坏对照逐一验证（预设混入 `nickname` / 预设声明 `language` / 枚举取值非法 / merge 不再让内置优先 / 匹配从 `every` 退化为 `some` / 少一处内置名拒绝点 / ★ 判定改走别的函数 / 恢复本地重复实现 / 摘要默认值表漂移 / 摘要字段集合被改 / 内置标记不渲染 / 删除按钮失去 `builtin` 约束 / 缺一个文案键）——每组都必须被对应断言判出，未破坏时必须通过，实测 **13/13**。做法是把每个变体制成一次性破坏（同一次 bash 调用内「改坏 → 独立 node 进程跑 → 立即恢复」，借新进程天然绕开 ESM 缓存），跑完核对工作区回到干净状态
- 草稿预览部分再加 5 项，`verify-config` 总数 54 → **59 项**：草稿端点复用保存路径的校验与编译且不落盘不注入、客户端「参与编译的字段」与宿主 `compilePrompt` 实际读取的字段集合**相等**（这条是防漂移的关键——以后给编译器加字段却忘了同步客户端会立刻失败）、草稿分支的判定来源、预览刷新入口唯一、新增文案键中英各一份
- 上述 5 项的判断力用 6 组破坏对照验证，6/6 符合预期。其中一条第一次**没写严**：只断言了表达式里出现 `asDraft`，把它写死成常量也能「看起来正确」，补强到钉住判定来源后才判得出来
- 另用 mini-React 垫片**离线挂载真实的 `SoulSettings` 组件**（不是复刻片段）+ 桩 fetch 验证行为：无编辑时请求 `GET /api/soul/prompt`、标题为「当前生效提示词」；一有编辑就请求 `POST /api/soul/prompt/preview`、标题为「保存后将生效的提示词」且摘要含「未保存」——13 项断言全过，并截图确认渲染无误

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